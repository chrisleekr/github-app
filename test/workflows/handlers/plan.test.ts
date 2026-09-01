/**
 * Unit tests for the SDK-driven plan handler.
 *
 * The handler clones the repo and runs Claude Agent SDK; the agent writes
 * PLAN.md. The unit tests stub `checkoutRepo`, `executeAgent`, and
 * `node:fs/promises.readFile` to drive the post-agent branches without
 * standing up real infra.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";
import type pino from "pino";

import { config } from "../../../src/config";
import type { WorkflowRunContext } from "../../../src/workflows/registry";
import { StaleWorkflowAttemptError } from "../../../src/workflows/runs-store";
import { expectToReject } from "../../utils/assertions";

let agentResult: {
  success: boolean;
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
  errorMessage?: string;
};
let planMd: string;

void mock.module("../../../src/core/checkout", () => ({
  checkoutRepo: mock(async () =>
    Promise.resolve({
      workDir: "/tmp/fake-workdir",
      cleanup: mock(async () => Promise.resolve()),
    }),
  ),
}));

/** The subset of `ExecuteAgentParams` these tests read back. */
interface ExecuteAgentArgs {
  allowedTools: string[];
  promptParts?: { append: string; userMessage: string };
  model?: string;
  maxTurns?: number;
  signal?: AbortSignal;
}

// Hoisted so tests can inspect the params the handler forwards (e.g. whether
// `promptParts` is threaded through under PROMPT_CACHE_LAYOUT=cacheable).
const executeAgentMock = mock(async (_params: ExecuteAgentArgs) => Promise.resolve(agentResult));
void mock.module("../../../src/core/executor", () => ({
  executeAgent: executeAgentMock,
}));

// Spread the real fs/promises so other test files' uses of writeFile, mkdir,
// etc. still work even though Bun's mock.module replacement is process-global.
const realFsPromises = await import("node:fs/promises");
void mock.module("node:fs/promises", () => ({
  ...realFsPromises,
  readFile: mock(async (path: string) => {
    if (path.endsWith("PLAN.md")) return Promise.resolve(planMd);
    return realFsPromises.readFile(path, "utf8");
  }),
}));

const { handler: planHandler } = await import("../../../src/workflows/handlers/plan");

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

function buildCtx(): WorkflowRunContext {
  const octokit = {
    rest: {
      issues: {
        get: mock(async () =>
          Promise.resolve({
            data: { title: "Sample issue", body: "Sample body", user: { login: "alice" } },
          }),
        ),
      },
      repos: {
        get: mock(async () => Promise.resolve({ data: { default_branch: "main" } })),
      },
    },
    auth: mock(async () => Promise.resolve({ token: "ghs_fake" })),
  } as unknown as Octokit;

  return {
    runId: "run-1",
    workflowName: "plan",
    target: { type: "issue", owner: "acme", repo: "repo", number: 1 },
    logger: silentLog(),
    octokit,
    deliveryId: "d1",
    daemonId: "daemon-test",
    setState: mock(async () => Promise.resolve()),
  };
}

beforeEach(() => {
  executeAgentMock.mockClear();
  agentResult = { success: true, costUsd: 0.05, numTurns: 8, durationMs: 20_000 };
  planMd = "# Plan: Sample issue\n\n## Tasks\n- [ ] T1 do the thing (files: src/foo.ts)";
});

const ORIGINAL_PROMPT_CACHE_LAYOUT = config.promptCacheLayout;

afterEach(() => {
  mock.restore();
  config.promptCacheLayout = ORIGINAL_PROMPT_CACHE_LAYOUT;
});

describe("plan handler (SDK-driven)", () => {
  it("stops before agent execution when the starting-comment attempt fence is stale", async () => {
    const ctx = buildCtx();
    ctx.setState = mock(() =>
      Promise.reject(
        new StaleWorkflowAttemptError({ runId: ctx.runId, attemptId: crypto.randomUUID() }),
      ),
    );

    await expectToReject(planHandler(ctx), "workflow attempt is no longer current");
    expect(executeAgentMock).not.toHaveBeenCalled();
  });

  it("returns succeeded with the PLAN.md body as state", async () => {
    const result = await planHandler(buildCtx());

    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      const state = result.state as { plan: string; turns: number };
      expect(state.plan).toContain("## Tasks");
      expect(state.turns).toBe(8);
      expect(result.humanMessage).toContain("Plan ready");
    }
  });

  it("fails when the agent itself errors", async () => {
    agentResult = { success: false, durationMs: 5_000 };

    const result = await planHandler(buildCtx());

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("agent execution failed");
    }
  });

  it("propagates the executor's errorMessage into `reason`, not into the public comment", async () => {
    agentResult = {
      success: false,
      durationMs: 5_000,
      errorMessage:
        "Claude Code returned an error result: You've hit your limit · resets 6pm (UTC)",
    };

    const result = await planHandler(buildCtx());

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      // Load-bearing: orchestrator.ts:483 matches /hit your limit/i to defer and retry.
      expect(result.reason).toContain("hit your limit");
      expect(result.humanMessage).toContain("see server logs");
      expect(result.humanMessage).not.toContain("hit your limit");
    }
  });

  it("fails when PLAN.md is missing", async () => {
    planMd = "";

    const result = await planHandler(buildCtx());

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("PLAN.md");
    }
  });

  it("does not forward promptParts under the legacy layout", async () => {
    config.promptCacheLayout = "legacy";
    await planHandler(buildCtx());

    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    const params = executeAgentMock.mock.calls[0]?.[0] as { promptParts?: unknown };
    expect(params.promptParts).toBeUndefined();
  });

  it("forwards split promptParts to the executor under the cacheable layout", async () => {
    config.promptCacheLayout = "cacheable";
    await planHandler(buildCtx());

    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    const params = executeAgentMock.mock.calls[0]?.[0] as {
      promptParts?: { append: string; userMessage: string };
    };
    expect(params.promptParts).toBeDefined();
    expect(params.promptParts?.append.length).toBeGreaterThan(0);
    expect(params.promptParts?.userMessage.length).toBeGreaterThan(0);
  });
});

// ─── Per-repo agent policy, `.github-app.yaml` Gate 2 ───────────────────────

/** The tool list the handler owns; per-repo extras may only widen it. */
const PLAN_BASE_TOOLS = ["Read", "Grep", "Glob", "Write", "Bash"];

/** `WorkflowRunContext` fields are readonly, mirrors implement.test.ts. */
function withPolicy(ctx: WorkflowRunContext, policy: Record<string, unknown>): WorkflowRunContext {
  (ctx as unknown as Record<string, unknown>)["policy"] = policy;
  return ctx;
}

function withMaxTurns(ctx: WorkflowRunContext, maxTurns: number): WorkflowRunContext {
  (ctx as unknown as Record<string, unknown>)["maxTurns"] = maxTurns;
  return ctx;
}

function withSignal(ctx: WorkflowRunContext, signal: AbortSignal): WorkflowRunContext {
  (ctx as unknown as Record<string, unknown>)["signal"] = signal;
  return ctx;
}

/** Resolves when `signal` aborts; capped so a dead deadline fails rather than hangs. */
async function waitForAbort(signal: AbortSignal, capMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const cap = setTimeout(resolve, capMs);
    const onAbort = (): void => {
      clearTimeout(cap);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function firstExecuteAgentArgs(): Record<string, unknown> {
  const params = executeAgentMock.mock.calls[0]?.[0];
  expect(params).toBeDefined();
  return params as unknown as Record<string, unknown>;
}

describe("plan handler: per-repo policy forwarding", () => {
  it("forwards the policy model to executeAgent (C1)", async () => {
    await planHandler(withPolicy(buildCtx(), { model: "claude-repo-pinned" }));

    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    expect(firstExecuteAgentArgs()["model"]).toBe("claude-repo-pinned");
  });

  it("forwards the run-context maxTurns to executeAgent (C2)", async () => {
    await planHandler(withMaxTurns(buildCtx(), 7));

    expect(firstExecuteAgentArgs()["maxTurns"]).toBe(7);
  });

  it("forwards the daemon attempt signal to executeAgent", async () => {
    const signal = new AbortController().signal;

    await planHandler(withSignal(buildCtx(), signal));

    expect(firstExecuteAgentArgs()["signal"]).toBe(signal);
  });

  it("stops after an outer fence when a repository deadline is also configured", async () => {
    const outer = new AbortController();
    const ctx = withSignal(withPolicy(buildCtx(), { timeoutMs: 60_000 }), outer.signal);
    executeAgentMock.mockImplementationOnce(() => {
      outer.abort(new Error("workflow lease fenced"));
      return Promise.resolve(agentResult);
    });

    const result = await planHandler(ctx);

    expect(result.status).toBe("failed");
    expect(firstExecuteAgentArgs()["signal"]).not.toBe(outer.signal);
    expect((firstExecuteAgentArgs()["signal"] as AbortSignal).aborted).toBe(true);
    expect(ctx.setState).toHaveBeenCalledTimes(1);
  });

  it("forwards a per-repo deadline as a named Error, not a bare TimeoutError (C3)", async () => {
    // A bare TimeoutError DOMException would fail executeAgent's identity check.
    const seen: { hasSignal?: boolean; abortedAtEntry?: boolean; reason?: unknown } = {};
    executeAgentMock.mockImplementationOnce(async (params: ExecuteAgentArgs) => {
      const { signal } = params;
      seen.hasSignal = signal !== undefined;
      seen.abortedAtEntry = signal?.aborted;
      if (signal !== undefined) {
        await waitForAbort(signal, 3_000);
        seen.reason = signal.reason;
      }
      return agentResult;
    });

    await planHandler(withPolicy(buildCtx(), { timeoutMs: 25 }));

    expect(seen.hasSignal).toBe(true);
    expect(seen.abortedAtEntry).toBe(false);
    expect(seen.reason).toBeInstanceOf(Error);
    const reason = seen.reason as Error;
    expect(reason.name).not.toBe("TimeoutError");
    expect(reason.message).toContain(config.repoConfigFile);
    expect(reason.message).toMatch(/timeout/i);
  });

  it("unions extraAllowedTools onto the handler's base list (C4)", async () => {
    // "Read" duplicates a base tool: extras are deduped, never a replacement.
    await planHandler(withPolicy(buildCtx(), { extraAllowedTools: ["WebFetch", "Read"] }));

    const tools = firstExecuteAgentArgs()["allowedTools"] as string[];
    for (const tool of PLAN_BASE_TOOLS) expect(tools).toContain(tool);
    expect(tools).toContain("WebFetch");
    expect(new Set(tools).size).toBe(tools.length);
    expect(tools).toHaveLength(PLAN_BASE_TOOLS.length + 1);
  });

  it("disposes the deadline timer when the run finishes early (no leaked timer)", async () => {
    // C3 waits for the deadline, so its timer is spent; only a normal finish
    // catches a missing `disposePolicy?.()`.
    await planHandler(withPolicy(buildCtx(), { timeoutMs: 25 }));

    const signal = firstExecuteAgentArgs()["signal"] as AbortSignal;
    expect(signal.aborted).toBe(false);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 200);
    });

    expect(signal.aborted).toBe(false);
  });

  it("passes no model, maxTurns, or signal key when the run context carries none of them (C9)", async () => {
    await planHandler(buildCtx());

    const params = firstExecuteAgentArgs();
    // `exactOptionalPropertyTypes`: absent, not `undefined`-valued.
    expect(Object.hasOwn(params, "model")).toBe(false);
    expect(Object.hasOwn(params, "maxTurns")).toBe(false);
    expect(Object.hasOwn(params, "signal")).toBe(false);
    expect(params["allowedTools"]).toEqual(PLAN_BASE_TOOLS);
  });
});
