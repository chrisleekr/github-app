/**
 * Tests for src/core/pipeline.ts, focused on the "Gate 2" per-repo agent
 * policy (GitLab issue #2): the resolved `.github-app.yaml` knobs must reach
 * `executeAgent`.
 *
 * Collaborators are mocked so the assertions are about argument threading,
 * not about GitHub / git / the Agent SDK. `prompt-builder` is deliberately
 * NOT mocked: C5 (path filters) and C6 (review instructions) are only
 * observable in the rendered prompt, and the builder is a pure function.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

import type { ExecuteAgentParams } from "../../src/core/executor";
import type { ExecutionResult, FetchedData } from "../../src/types";
import { makeBotContext, makeFetchedData, makeSilentLogger } from "../factories";

// ─── Collaborator mocks (must precede the SUT import) ────────────────────────

const executeAgentCalls: ExecuteAgentParams[] = [];
/** When true, the stubbed agent blocks until its `signal` aborts (C3). */
let agentWaitsForAbort = false;

const mockExecuteAgent = mock(async (params: ExecuteAgentParams): Promise<ExecutionResult> => {
  executeAgentCalls.push(params);
  if (agentWaitsForAbort && params.signal !== undefined) {
    const signal = params.signal;
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => {
        resolve();
      });
    });
  }
  return { success: true, durationMs: 1, costUsd: 0, numTurns: 1 };
});

void mock.module("../../src/core/executor", () => ({
  executeAgent: mockExecuteAgent,
}));

let fetchedData: FetchedData = makeFetchedData();
void mock.module("../../src/core/fetcher", () => ({
  fetchGitHubData: mock(() => Promise.resolve(fetchedData)),
}));

// One real directory per file: the pipeline mkdir's `${workDir}-artifacts`
// and rm's it in its finally block, so a fake path would throw.
const workDir = mkdtempSync(join(tmpdir(), "pipeline-policy-"));
const mockCheckoutCleanup = mock(() => Promise.resolve());
void mock.module("../../src/core/checkout", () => ({
  checkoutRepo: mock(() => Promise.resolve({ workDir, cleanup: mockCheckoutCleanup })),
}));

void mock.module("../../src/core/github-token", () => ({
  resolveGithubToken: mock(() => Promise.resolve("ghs_test_token")),
}));

const mockCreateTrackingComment = mock((..._args: unknown[]) => Promise.resolve(4242));
const mockFinalizeTrackingComment = mock((..._args: unknown[]) => Promise.resolve());
void mock.module("../../src/core/tracking-comment", () => ({
  createTrackingComment: mockCreateTrackingComment,
  finalizeTrackingComment: mockFinalizeTrackingComment,
  updateTrackingComment: mock(() => Promise.resolve()),
}));

void mock.module("../../src/mcp/registry", () => ({
  resolveMcpServers: mock(() => ({})),
}));

const { runPipeline } = await import("../../src/core/pipeline");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function lastAgentCall(): ExecuteAgentParams {
  const call = executeAgentCalls.at(-1);
  if (call === undefined) throw new Error("executeAgent was never invoked");
  return call;
}

/**
 * Depth-bounded search for `needle` among an argument list. Shape-agnostic on
 * purpose: the warning may ride on the context or on a dedicated parameter,
 * and the acceptance criterion is that it reaches the tracking-comment write,
 * not which slot carries it.
 */
function argsContainText(args: readonly unknown[], needle: string): boolean {
  const seen = new WeakSet();
  const walk = (value: unknown, depth: number): boolean => {
    if (depth > 4) return false;
    if (typeof value === "string") return value.includes(needle);
    if (typeof value !== "object" || value === null) return false;
    if (seen.has(value)) return false;
    seen.add(value);
    return Object.values(value).some((v) => walk(v, depth + 1));
  };
  return args.some((a) => walk(a, 0));
}

const PR_FILES: FetchedData["changedFiles"] = [
  { filename: "src/a.ts", status: "modified", additions: 5, deletions: 2 },
  { filename: "src/__snapshots__/big.snap", status: "modified", additions: 900, deletions: 900 },
];

beforeEach(() => {
  executeAgentCalls.length = 0;
  agentWaitsForAbort = false;
  mockCreateTrackingComment.mockClear();
  mockFinalizeTrackingComment.mockClear();
  mockCheckoutCleanup.mockClear();
  fetchedData = makeFetchedData();
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ─── C1: model override ──────────────────────────────────────────────────────

describe("runPipeline: policy.model (C1)", () => {
  it("invokes the agent with the per-repo model instead of config.model", async () => {
    const ctx = makeBotContext({ isPR: false, skipTrackingComments: true });

    await runPipeline(ctx, {
      allowedTools: ["Read"],
      policy: { model: "claude-repo-pinned-model" },
    });

    expect(lastAgentCall().model).toBe("claude-repo-pinned-model");
  });

  it("leaves model unset when the policy carries none (C8)", async () => {
    const ctx = makeBotContext({ isPR: false, skipTrackingComments: true });

    await runPipeline(ctx, { allowedTools: ["Read"] });

    expect(lastAgentCall().model).toBeUndefined();
  });
});

// ─── C2: per-repo turn cap ───────────────────────────────────────────────────

describe("runPipeline: maxTurns (C2, final link)", () => {
  it("invokes the agent with the resolved turn cap", async () => {
    const ctx = makeBotContext({ isPR: false, skipTrackingComments: true });

    await runPipeline(ctx, { allowedTools: ["Read"], maxTurns: 7 });

    expect(lastAgentCall().maxTurns).toBe(7);
  });

  it("leaves maxTurns unset when the caller passes none, so executeAgent falls back", async () => {
    const ctx = makeBotContext({ isPR: false, skipTrackingComments: true });

    await runPipeline(ctx, { allowedTools: ["Read"] });

    expect(lastAgentCall().maxTurns).toBeUndefined();
  });
});

// ─── C3: per-repo timeout ────────────────────────────────────────────────────

describe("runPipeline: policy.timeoutMs (C3)", () => {
  it("aborts the signal handed to the agent once the per-repo timeout elapses", async () => {
    agentWaitsForAbort = true;
    const ctx = makeBotContext({ isPR: false, skipTrackingComments: true });

    await runPipeline(ctx, {
      allowedTools: ["Read"],
      policy: { timeoutMs: 25 },
    });

    const signal = lastAgentCall().signal;
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(true);
  });

  it("aborts with a named error attributing the deadline to the per-repo knob", async () => {
    // A bare `AbortSignal.timeout` aborts with a TimeoutError DOMException,
    // which executeAgent's identity check does not recognise, so the run
    // surfaced as a generic failure with no mention of the repo's `timeout:`.
    agentWaitsForAbort = true;
    const ctx = makeBotContext({ isPR: false, skipTrackingComments: true });

    await runPipeline(ctx, {
      allowedTools: ["Read"],
      policy: { timeoutMs: 25 },
    });

    const reason: unknown = lastAgentCall().signal?.reason;
    expect(reason).toBeInstanceOf(Error);
    expect((reason as Error).message).toContain("per-repo");
    expect((reason as Error).message).toContain("25ms");
  });

  it("still honours a caller-supplied abort when a per-repo timeout composes over it", async () => {
    // AGENT_TIMEOUT_MS stays the outer bound inside executeAgent; at this
    // layer the equivalent contract is that composing the per-repo timer must
    // not swallow the caller's (daemon cancel) signal.
    agentWaitsForAbort = true;
    const outer = new AbortController();
    const ctx = makeBotContext({ isPR: false, skipTrackingComments: true });

    const run = runPipeline(ctx, {
      allowedTools: ["Read"],
      signal: outer.signal,
      policy: { timeoutMs: 60_000 },
    });
    await Bun.sleep(20);
    outer.abort(new Error("cancelled by daemon"));
    await run;

    expect(lastAgentCall().signal?.aborted).toBe(true);
  });

  it("suppresses post-agent effects when an agent resolves after the caller fence", async () => {
    agentWaitsForAbort = true;
    const outer = new AbortController();
    const ctx = makeBotContext({ isPR: false, skipTrackingComments: false });
    const actionsPath = join(workDir, ".daemon-actions.json");
    writeFileSync(
      actionsPath,
      JSON.stringify([{ type: "save", category: "pattern", content: "must not escape" }]),
    );

    try {
      const run = runPipeline(ctx, {
        allowedTools: ["Read"],
        signal: outer.signal,
        policy: { timeoutMs: 60_000 },
      });
      await Bun.sleep(20);
      outer.abort(new Error("workflow lease fenced"));
      const result = await run;

      expect(result.success).toBe(false);
      expect(result.daemonActions).toBeUndefined();
      expect(mockFinalizeTrackingComment).not.toHaveBeenCalled();
      expect(mockCheckoutCleanup).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(actionsPath, { force: true });
    }
  });
});

// ─── C4: extra allowed tools ─────────────────────────────────────────────────

describe("runPipeline: policy.extraAllowedTools (C4)", () => {
  it("appends the extra tools without dropping any handler-required tool", async () => {
    const ctx = makeBotContext({ isPR: true, skipTrackingComments: true });
    fetchedData = makeFetchedData({ changedFiles: PR_FILES, baseBranch: "main" });

    await runPipeline(ctx, {
      allowedTools: ["Bash", "Read", "Edit"],
      policy: { extraAllowedTools: ["WebFetch", "Bash(gh pr view:*)"] },
    });

    const tools = lastAgentCall().allowedTools;
    expect(tools).toContain("WebFetch");
    expect(tools).toContain("Bash(gh pr view:*)");
    for (const required of ["Bash", "Read", "Edit"]) {
      expect(tools).toContain(required);
    }
    // The PR-context github-state additions must survive too.
    expect(tools).toContain("mcp__github_state__get_pr_diff");
  });

  it("leaves the tool list untouched when the policy carries no extras (C8)", async () => {
    const ctx = makeBotContext({ isPR: false, skipTrackingComments: true });

    await runPipeline(ctx, { allowedTools: ["Bash", "Read"] });

    expect(lastAgentCall().allowedTools).toEqual(["Bash", "Read"]);
  });
});

// ─── C5: review path filters ─────────────────────────────────────────────────

describe("runPipeline: policy.pathFilters (C5)", () => {
  /** Every `repo_config.path_filters_applied` event recorded on a logger. */
  function filterLogEvents(log: ReturnType<typeof makeSilentLogger>): unknown[] {
    return log.info.mock.calls.filter((call) => {
      const first = (call as unknown[])[0];
      return (
        typeof first === "object" &&
        first !== null &&
        (first as { event?: string }).event === "repo_config.path_filters_applied"
      );
    });
  }

  it("leaves the data untouched and logs nothing when no changed file matches", async () => {
    const log = makeSilentLogger();
    const ctx = makeBotContext({ isPR: true, skipTrackingComments: true, log });
    fetchedData = makeFetchedData({ changedFiles: PR_FILES, baseBranch: "main" });

    await runPipeline(ctx, {
      allowedTools: ["Read"],
      policy: { pathFilters: ["docs/**/*.md"] },
    });

    const { prompt } = lastAgentCall();
    expect(prompt).toContain("src/a.ts");
    expect(prompt).toContain("big.snap");
    expect(filterLogEvents(log)).toHaveLength(0);
  });

  it("filters nothing and does not throw when every glob is rejected by isSafeGlob", async () => {
    // 33 `*` segments exceeds the wildcard budget `isSafeGlob` enforces; see
    // test/utils/review-learnings-filter.test.ts for the documented case.
    const log = makeSilentLogger();
    const ctx = makeBotContext({ isPR: true, skipTrackingComments: true, log });
    fetchedData = makeFetchedData({ changedFiles: PR_FILES, baseBranch: "main" });

    await runPipeline(ctx, {
      allowedTools: ["Read"],
      policy: { pathFilters: ["*".repeat(33)] },
    });

    const { prompt } = lastAgentCall();
    expect(prompt).toContain("src/a.ts");
    expect(prompt).toContain("big.snap");
    expect(filterLogEvents(log)).toHaveLength(0);
  });

  it("tells the agent to skip the excluded globs in the diff it is told to read", async () => {
    // Dropping the files from `changedFiles` only hides the list; the agent has
    // Bash and is instructed to run `git diff`, so the globs must also reach
    // the prompt as an explicit skip instruction.
    const ctx = makeBotContext({ isPR: true, skipTrackingComments: true });
    fetchedData = makeFetchedData({ changedFiles: PR_FILES, baseBranch: "main" });

    await runPipeline(ctx, {
      allowedTools: ["Read"],
      policy: { pathFilters: ["**/__snapshots__/**"] },
    });

    const { prompt } = lastAgentCall();
    expect(prompt).toContain("**/__snapshots__/**");
    expect(prompt).toContain("git diff");
  });

  it("excludes matching changed files from the prompt the reviewer sees", async () => {
    const ctx = makeBotContext({ isPR: true, skipTrackingComments: true });
    fetchedData = makeFetchedData({ changedFiles: PR_FILES, baseBranch: "main" });

    await runPipeline(ctx, {
      allowedTools: ["Read"],
      policy: { pathFilters: ["**/__snapshots__/**"] },
    });

    const { prompt } = lastAgentCall();
    expect(prompt).toContain("src/a.ts");
    expect(prompt).not.toContain("big.snap");
  });

  /** Every `repo_config.path_filters_rejected` event recorded on a logger. */
  function rejectLogEvents(log: ReturnType<typeof makeSilentLogger>): unknown[] {
    return log.warn.mock.calls.filter((call) => {
      const first = (call as unknown[])[0];
      return (
        typeof first === "object" &&
        first !== null &&
        (first as { event?: string }).event === "repo_config.path_filters_rejected"
      );
    });
  }

  it("keeps applying the safe globs when a sibling glob is rejected, and warns once", async () => {
    // A rejected glob must not poison the survivors, and it must not reach the
    // prompt's skip instruction either: the file list and the instruction have
    // to agree on which globs applied.
    const unsafe = "*".repeat(33);
    const log = makeSilentLogger();
    const ctx = makeBotContext({ isPR: true, skipTrackingComments: true, log });
    fetchedData = makeFetchedData({ changedFiles: PR_FILES, baseBranch: "main" });

    await runPipeline(ctx, {
      allowedTools: ["Read"],
      policy: { pathFilters: [unsafe, "**/__snapshots__/**"] },
    });

    const { prompt } = lastAgentCall();
    expect(prompt).toContain("src/a.ts");
    expect(prompt).not.toContain("big.snap");
    expect(prompt).toContain("**/__snapshots__/**");
    expect(prompt).not.toContain(unsafe);

    expect(rejectLogEvents(log)).toHaveLength(1);
    const rejected = (rejectLogEvents(log)[0] as unknown[])[0] as { rejectedCount: number };
    expect(rejected.rejectedCount).toBe(1);
  });

  it("still runs the agent when the globs exclude every changed file", async () => {
    // `**` is a legal owner choice; the run must degrade to a zero-file review
    // rather than short-circuit, and the log has to say the list is empty.
    const log = makeSilentLogger();
    const ctx = makeBotContext({ isPR: true, skipTrackingComments: true, log });
    fetchedData = makeFetchedData({ changedFiles: PR_FILES, baseBranch: "main" });

    await runPipeline(ctx, { allowedTools: ["Read"], policy: { pathFilters: ["**"] } });

    expect(executeAgentCalls).toHaveLength(1);
    const applied = filterLogEvents(log);
    expect(applied).toHaveLength(1);
    const fields = (applied[0] as unknown[])[0] as { keptCount: number; excludedCount: number };
    expect(fields.keptCount).toBe(0);
    expect(fields.excludedCount).toBe(PR_FILES.length);
  });

  it("keeps every changed file when no path filters are set (C8)", async () => {
    const ctx = makeBotContext({ isPR: true, skipTrackingComments: true });
    fetchedData = makeFetchedData({ changedFiles: PR_FILES, baseBranch: "main" });

    await runPipeline(ctx, { allowedTools: ["Read"] });

    const { prompt } = lastAgentCall();
    expect(prompt).toContain("src/a.ts");
    expect(prompt).toContain("big.snap");
  });
});

// ─── C6: review instructions ─────────────────────────────────────────────────

describe("runPipeline: policy.instructions (C6)", () => {
  it("renders the per-repo review instructions into the prompt", async () => {
    const ctx = makeBotContext({ isPR: true, skipTrackingComments: true });
    fetchedData = makeFetchedData({ changedFiles: PR_FILES, baseBranch: "main" });

    await runPipeline(ctx, {
      allowedTools: ["Read"],
      policy: { instructions: "REPO_REVIEW_POLICY_MARKER: always check migrations" },
    });

    expect(lastAgentCall().prompt).toContain("REPO_REVIEW_POLICY_MARKER");
  });
});

// ─── C7: fail-open warning, direct-pipeline rail ─────────────────────────────

describe("runPipeline: policy.warning (C7, direct-pipeline rail)", () => {
  it("surfaces the invalid-config warning through the tracking comment write", async () => {
    const warning =
      "`.github-app.yaml` failed validation and was ignored; built-in defaults were used.";
    const ctx = makeBotContext({ isPR: false });

    await runPipeline(ctx, {
      allowedTools: ["Read"],
      policy: { warning },
    });

    expect(mockCreateTrackingComment).toHaveBeenCalled();
    const args = mockCreateTrackingComment.mock.calls[0] ?? [];
    expect(argsContainText(args, "failed validation")).toBe(true);
  });

  it("still executes the agent with default behaviour despite the warning (C7 fail-open)", async () => {
    const ctx = makeBotContext({ isPR: false });

    await runPipeline(ctx, {
      allowedTools: ["Read"],
      policy: { warning: "`.github-app.yaml` failed validation and was ignored" },
    });

    expect(executeAgentCalls).toHaveLength(1);
    expect(lastAgentCall().model).toBeUndefined();
    expect(lastAgentCall().allowedTools).toEqual(["Read"]);
  });

  it("hands the warning to finalize so the agent's body rewrite cannot drop it", async () => {
    const warning =
      "`.github-app.yaml` failed validation and was ignored; built-in defaults were used.";
    const ctx = makeBotContext({ isPR: false });

    await runPipeline(ctx, { allowedTools: ["Read"], policy: { warning } });

    expect(mockFinalizeTrackingComment).toHaveBeenCalled();
    const opts = mockFinalizeTrackingComment.mock.calls[0]?.[2] as
      | { configWarning?: string }
      | undefined;
    expect(opts?.configWarning).toBe(warning);
  });

  it("writes no warning into the tracking comment when the policy is clean (C8)", async () => {
    const ctx = makeBotContext({ isPR: false });

    await runPipeline(ctx, { allowedTools: ["Read"] });

    const args = mockCreateTrackingComment.mock.calls[0] ?? [];
    expect(argsContainText(args, "failed validation")).toBe(false);
  });
});
