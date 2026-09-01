/**
 * Unit tests for the `resolve` handler: focused on the post-pipeline CI
 * re-check gate added for issue #93.
 *
 * The handler delegates the heavy lifting to `runPipeline` (clone + multi-
 * turn agent). These tests stub the pipeline and the GitHub REST surface to
 * exercise the wiring around it: prologue check fetch, post-pipeline
 * re-fetch, RESOLVE.md `## Outstanding` parsing, and the `succeeded` vs.
 * `incomplete` branch decision.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";
import type pino from "pino";

import type { BotContext } from "../../../src/types";
import type { WorkflowRunContext } from "../../../src/workflows/registry";

interface PipelineResultStub {
  success: boolean;
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
  errorMessage?: string;
  capturedFiles?: Record<string, string>;
  daemonActions?: {
    learnings: { category: "gotchas"; content: string }[];
    deletions: string[];
  };
}

let pipelineResult: PipelineResultStub;

const mockRunPipeline = mock(async () => Promise.resolve(pipelineResult));

void mock.module("../../../src/core/pipeline", () => ({
  runPipeline: mockRunPipeline,
}));

const { handler: resolveHandler } = await import("../../../src/workflows/handlers/resolve");

function silentLog(): pino.Logger {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    child: mock(function (this: unknown) {
      return this;
    }),
  } as unknown as pino.Logger;
}

interface CheckRunStub {
  status: string | null;
  conclusion: string | null;
  name: string;
}

interface BuildCtxOptions {
  state?: "open" | "closed";
  /** Pre-pipeline checks (handler prologue snapshot). */
  preChecks?: CheckRunStub[];
  /** Post-pipeline checks (handler re-fetch after `runPipeline`). */
  postChecks?: CheckRunStub[];
  /**
   * SHA returned by the second `pulls.get` call (post-pipeline). Defaults to
   * a different value from the first `pulls.get` call so the test doubles
   * see a "the agent pushed commits" scenario.
   */
  postHeadSha?: string;
  reviewComments?: { in_reply_to_id?: number; user?: { login?: string; type?: string } }[];
  targetType?: "pr" | "issue";
}

function buildCtx(opts: BuildCtxOptions = {}): WorkflowRunContext & {
  setStateMock: ReturnType<typeof mock>;
  paginateMock: ReturnType<typeof mock>;
} {
  const preChecks = opts.preChecks ?? [];
  const postChecks = opts.postChecks ?? [];
  const reviewComments = opts.reviewComments ?? [];
  const postHeadSha = opts.postHeadSha ?? "abc1234";

  const prData = (sha: string) => ({
    state: opts.state ?? "open",
    title: "Sample PR",
    head: {
      ref: "feature/foo",
      sha,
      label: "acme:feature/foo",
      repo: { full_name: "acme/widgets" },
    },
    base: {
      ref: "main",
      repo: { full_name: "acme/widgets", default_branch: "main" },
    },
  });

  // Two calls to pulls.get: one in the prologue, one after runPipeline.
  let pullsGetCallCount = 0;
  const pullsGet = mock(async () => {
    pullsGetCallCount += 1;
    if (pullsGetCallCount === 1) return Promise.resolve({ data: prData("oldsha000") });
    return Promise.resolve({ data: prData(postHeadSha) });
  });

  // paginate handles both `checks.listForRef` (with `ref` arg) and
  // `pulls.listReviewComments`. We dispatch on the second arg's keys so the
  // same mock can serve both call sites.
  const paginate = mock((endpoint: unknown, args: Record<string, unknown>) => {
    if ("ref" in args) {
      // checks.listForRef, return pre-snapshot the first time, post-snapshot
      // the second time. Distinguish by `ref`: prologue uses "oldsha000",
      // post-pipeline uses postHeadSha.
      if (args["ref"] === postHeadSha && postHeadSha !== "oldsha000") {
        return Promise.resolve(postChecks);
      }
      return Promise.resolve(preChecks);
    }
    if ("pull_number" in args) return Promise.resolve(reviewComments);
    return Promise.resolve([]);
  });

  const octokit = {
    paginate,
    rest: {
      pulls: {
        get: pullsGet,
        listReviewComments: mock(),
      },
      checks: {
        listForRef: mock(),
      },
      repos: {
        compareCommitsWithBasehead: mock(async () =>
          Promise.resolve({ data: { behind_by: 0, ahead_by: 1 } }),
        ),
      },
    },
  } as unknown as Octokit;

  const setStateMock = mock(async () => Promise.resolve({ trackingCommentId: 12345 }));

  return {
    runId: "run-1",
    workflowName: "resolve",
    target: {
      type: opts.targetType ?? "pr",
      owner: "acme",
      repo: "widgets",
      number: 99,
    },
    logger: silentLog(),
    octokit,
    deliveryId: "delivery-1",
    daemonId: "daemon-1",
    setState: setStateMock,
    setStateMock,
    paginateMock: paginate,
  } as unknown as WorkflowRunContext & {
    setStateMock: ReturnType<typeof mock>;
    paginateMock: ReturnType<typeof mock>;
  };
}

describe("resolve handler", () => {
  beforeEach(() => {
    pipelineResult = {
      success: true,
      costUsd: 0.5,
      numTurns: 10,
      durationMs: 30_000,
      capturedFiles: { "RESOLVE.md": "## Summary\n\nDone." },
    };
  });

  afterEach(() => {
    pipelineResult = { success: false };
  });

  it("rejects an issue target", async () => {
    const ctx = buildCtx({ targetType: "issue" });
    const result = await resolveHandler(ctx);
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.reason).toContain("PR target");
  });

  it("rejects a closed PR", async () => {
    const ctx = buildCtx({ state: "closed" });
    const result = await resolveHandler(ctx);
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.reason).toContain("open PR");
  });

  it("returns succeeded when post-pipeline CI is green and RESOLVE.md has no Outstanding", async () => {
    const ctx = buildCtx({
      preChecks: [{ status: "completed", conclusion: "failure", name: "test" }],
      postChecks: [
        { status: "completed", conclusion: "success", name: "test" },
        { status: "completed", conclusion: "skipped", name: "optional" },
      ],
    });
    const result = await resolveHandler(ctx);
    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      const state = result.state as Record<string, unknown>;
      expect(state["ci_verified"]).toBe(true);
      const post = state["post_pipeline"] as Record<string, unknown>;
      expect(post["all_green"]).toBe(true);
      expect(post["failing_checks"]).toEqual([]);
    }
    expect(ctx.setStateMock).toHaveBeenCalledTimes(1);
  });

  it("returns incomplete when post-pipeline CI still has failing checks", async () => {
    pipelineResult = {
      success: true,
      costUsd: 1.0,
      numTurns: 20,
      capturedFiles: {
        "RESOLVE.md":
          "## Summary\n\nGave up.\n\n## Outstanding\n\n- typecheck still red, could not isolate root cause",
      },
      daemonActions: {
        learnings: [{ category: "gotchas", content: "CI needs a local service." }],
        deletions: [],
      },
    };
    const ctx = buildCtx({
      preChecks: [{ status: "completed", conclusion: "failure", name: "typecheck" }],
      postChecks: [{ status: "completed", conclusion: "failure", name: "typecheck" }],
    });
    const result = await resolveHandler(ctx);
    expect(result.status).toBe("incomplete");
    if (result.status === "incomplete") {
      expect(result.reason).toContain("CI still red");
      expect(result.reason).toContain("typecheck");
      expect(result.humanMessage).toContain("Resolve incomplete");
      expect(result.humanMessage).toContain("typecheck still red");
      const state = result.state as Record<string, unknown>;
      expect(state["ci_verified"]).toBe(false);
      const post = state["post_pipeline"] as Record<string, unknown>;
      expect(post["all_green"]).toBe(false);
      expect(post["failing_checks"]).toEqual(["typecheck"]);
      expect(post["outstanding_present"]).toBe(true);
      expect(result.daemonActions).toEqual(pipelineResult.daemonActions);
    }
  });

  it("returns incomplete when CI is green but ## Outstanding is non-empty", async () => {
    pipelineResult = {
      success: true,
      costUsd: 0.7,
      numTurns: 14,
      capturedFiles: {
        "RESOLVE.md":
          "## Summary\n\nMostly done.\n\n## Outstanding\n\n- maintainer must verify edge case in src/foo.ts",
      },
    };
    const ctx = buildCtx({
      preChecks: [],
      postChecks: [{ status: "completed", conclusion: "success", name: "test" }],
    });
    const result = await resolveHandler(ctx);
    expect(result.status).toBe("incomplete");
    if (result.status === "incomplete") {
      expect(result.reason).toContain("Outstanding");
      expect(result.humanMessage).toContain("maintainer must verify edge case");
    }
  });

  it("returns succeeded when RESOLVE.md is missing entirely (and CI green)", async () => {
    pipelineResult = {
      success: true,
      costUsd: 0.1,
      numTurns: 3,
      capturedFiles: {},
    };
    const ctx = buildCtx({
      preChecks: [],
      postChecks: [{ status: "completed", conclusion: "success", name: "test" }],
    });
    const result = await resolveHandler(ctx);
    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      const state = result.state as Record<string, unknown>;
      expect(state["ci_verified"]).toBe(true);
    }
  });

  it("partial CI green still returns incomplete", async () => {
    const ctx = buildCtx({
      preChecks: [],
      postChecks: [
        { status: "completed", conclusion: "success", name: "lint" },
        { status: "completed", conclusion: "failure", name: "test" },
      ],
    });
    const result = await resolveHandler(ctx);
    expect(result.status).toBe("incomplete");
  });

  it("all-skipped/neutral checks are treated as green", async () => {
    const ctx = buildCtx({
      preChecks: [],
      postChecks: [
        { status: "completed", conclusion: "skipped", name: "deploy" },
        { status: "completed", conclusion: "neutral", name: "info" },
      ],
    });
    const result = await resolveHandler(ctx);
    expect(result.status).toBe("succeeded");
  });

  it("returns failed when runPipeline reports failure (regression guard)", async () => {
    pipelineResult = {
      success: false,
      errorMessage: "agent crashed",
      daemonActions: {
        learnings: [{ category: "gotchas", content: "The agent needs a service." }],
        deletions: [],
      },
    };
    const ctx = buildCtx({
      preChecks: [{ status: "completed", conclusion: "failure", name: "test" }],
    });
    const repoMemory = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        category: "gotchas" as const,
        content: "Start the local service.",
        pinned: false,
      },
    ];
    (ctx as { repoMemory?: typeof repoMemory }).repoMemory = repoMemory;
    const result = await resolveHandler(ctx);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("agent crashed");
      expect(result.humanMessage).toContain("see server logs");
    }
    expect((mockRunPipeline.mock.calls.at(-1)?.[0] as BotContext).repoMemory).toEqual(repoMemory);
    expect("daemonActions" in result ? result.daemonActions : undefined).toEqual(
      pipelineResult.daemonActions,
    );
  });
});

// ─── Per-repo agent policy, `.github-app.yaml` Gate 2 ───────────────────────

describe("resolve handler: per-repo policy forwarding", () => {
  beforeEach(() => {
    mockRunPipeline.mockClear();
    pipelineResult = {
      success: true,
      capturedFiles: { "RESOLVE.md": "## Summary\n\nDone." },
    };
  });

  it("forwards the run-context policy into the pipeline overrides", async () => {
    const policy = {
      model: "claude-repo-pinned-model",
      timeoutMs: 900_000,
      extraAllowedTools: ["WebFetch"],
      pathFilters: ["**/__snapshots__/**"],
      instructions: "reject migrations without a rollback",
    };
    const ctx = buildCtx();
    (ctx as unknown as Record<string, unknown>)["policy"] = policy;

    await resolveHandler(ctx);

    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    const overrides = mockRunPipeline.mock.calls[0]?.[1] as
      | { policy?: Record<string, unknown> }
      | undefined;
    expect(overrides?.policy).toEqual(policy);
  });

  it("forwards the run-context maxTurns into the pipeline overrides", async () => {
    // The turn cap rides the top-level payload field, not `policy`, so it
    // needs its own hop. Without it `workflows.resolve.max_turns` is inert.
    const ctx = buildCtx();
    (ctx as unknown as Record<string, unknown>)["maxTurns"] = 12;

    await resolveHandler(ctx);

    const overrides = mockRunPipeline.mock.calls[0]?.[1] as { maxTurns?: number } | undefined;
    expect(overrides?.maxTurns).toBe(12);
  });

  it("forwards the daemon attempt signal into the pipeline overrides", async () => {
    const ctx = buildCtx();
    const signal = new AbortController().signal;
    (ctx as unknown as Record<string, unknown>)["signal"] = signal;

    await resolveHandler(ctx);

    const overrides = mockRunPipeline.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
    expect(overrides?.signal).toBe(signal);
  });

  it("passes no policy or maxTurns key when the run context carries neither (C8)", async () => {
    await resolveHandler(buildCtx());

    const overrides = mockRunPipeline.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(overrides).toBeDefined();
    // `exactOptionalPropertyTypes`: absent, not `undefined`-valued.
    expect(Object.hasOwn(overrides ?? {}, "policy")).toBe(false);
    expect(Object.hasOwn(overrides ?? {}, "maxTurns")).toBe(false);
    // Existing overrides must survive the addition.
    expect(overrides?.["captureFiles"]).toEqual(["RESOLVE.md"]);
    expect(overrides?.["enableReviewLearnings"]).toBe(true);
  });
});

// ─── review comments are NOT filtered by author (work item #1) ────────────

describe("resolve acts on bot-authored review comments", () => {
  beforeEach(() => {
    mockRunPipeline.mockClear();
    pipelineResult = {
      success: true,
      capturedFiles: { "RESOLVE.md": "## Summary\n\nDone." },
    };
  });

  // `enableResolveReviewThread` is set iff at least one top-level review comment
  // survives, so it is the observable signal for what `resolve` saw.
  function sawOpenThreads(): boolean {
    const overrides = mockRunPipeline.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    return overrides?.["enableResolveReviewThread"] === true;
  }

  it("acts on our own review findings, which is ship's review -> resolve handoff", async () => {
    // ship runs review immediately before resolve on the same PR. Filtering our
    // own findings out here would make resolve a CI-only fixer and silently drop
    // the review it just ran.
    await resolveHandler(
      buildCtx({ reviewComments: [{ user: { login: "chrisleekr-bot[bot]", type: "Bot" } }] }),
    );
    expect(sawOpenThreads()).toBe(true);
  });

  it("acts on a third-party review bot's findings", async () => {
    // CodeRabbit / Copilot / Sonar are all `type: "Bot"`. A type-based author
    // filter would discard exactly the reviewer feedback resolve exists for.
    await resolveHandler(
      buildCtx({ reviewComments: [{ user: { login: "coderabbitai[bot]", type: "Bot" } }] }),
    );
    expect(sawOpenThreads()).toBe(true);
  });

  it("acts on a human's review comment", async () => {
    await resolveHandler(
      buildCtx({ reviewComments: [{ user: { login: "someone", type: "User" } }] }),
    );
    expect(sawOpenThreads()).toBe(true);
  });
});
