/**
 * Unit tests for the proactive `review` handler.
 *
 * The handler delegates the heavy lifting to `runPipeline` (clone +
 * multi-turn agent). The unit tests stub `runPipeline` to assert the
 * handler's pre/post wiring: PR-target validation, open-PR check,
 * REVIEW.md capture, state shape, and the human-readable headline.
 *
 * The agent's actual behaviour (reading files, posting findings via
 * `gh api`) is covered by the integration smoke test, not here: that
 * needs a real PR and is out of scope for unit tests.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";
import type pino from "pino";

import type { BotContext } from "../../../src/types";
import type { WorkflowRunContext } from "../../../src/workflows/registry";

let pipelineResult: {
  success: boolean;
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
  capturedFiles?: Record<string, string>;
  daemonActions?: {
    learnings: { category: "conventions"; content: string }[];
    deletions: string[];
  };
};

const mockRunPipeline = mock(async () => Promise.resolve(pipelineResult));

void mock.module("../../../src/core/pipeline", () => ({
  runPipeline: mockRunPipeline,
}));

const { handler: reviewHandler } = await import("../../../src/workflows/handlers/review");

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

interface PrOverrides {
  state?: "open" | "closed";
  title?: string;
  body?: string | null;
  changedFiles?: number;
  additions?: number;
  deletions?: number;
  /** Default 0, branch is up-to-date. */
  behindBy?: number;
  /** Default false, head is on the same repo as base. */
  isFork?: boolean;
}

function buildCtx(
  prOverrides?: PrOverrides,
  targetType: "pr" | "issue" = "pr",
): WorkflowRunContext & { setStateMock: ReturnType<typeof mock> } {
  const isFork = prOverrides?.isFork ?? false;
  const headRepoFullName = isFork ? "fork/widgets" : "acme/widgets";

  const prData = {
    state: prOverrides?.state ?? "open",
    title: prOverrides?.title ?? "Sample PR",
    body: prOverrides?.body ?? "PR description",
    changed_files: prOverrides?.changedFiles ?? 3,
    additions: prOverrides?.additions ?? 42,
    deletions: prOverrides?.deletions ?? 7,
    head: {
      ref: "feature/foo",
      sha: "abc1234",
      label: "acme:feature/foo",
      repo: { full_name: headRepoFullName },
    },
    base: {
      ref: "main",
      repo: { full_name: "acme/widgets", default_branch: "main" },
    },
  };

  const octokit = {
    rest: {
      pulls: {
        get: mock(async () => Promise.resolve({ data: prData })),
      },
      repos: {
        compareCommitsWithBasehead: mock(async () =>
          Promise.resolve({
            data: {
              behind_by: prOverrides?.behindBy ?? 0,
              ahead_by: 5,
            },
          }),
        ),
      },
    },
  } as unknown as Octokit;

  const setStateMock = mock(async () => Promise.resolve({ trackingCommentId: 12345 }));

  return {
    runId: "run-1",
    workflowName: "review",
    target: { type: targetType, owner: "acme", repo: "widgets", number: 99 },
    logger: silentLog(),
    octokit,
    deliveryId: "delivery-1",
    daemonId: "daemon-1",
    setState: setStateMock,
    setStateMock,
  } as unknown as WorkflowRunContext & { setStateMock: ReturnType<typeof mock> };
}

describe("review handler", () => {
  beforeEach(() => {
    pipelineResult = {
      success: true,
      costUsd: 0.42,
      numTurns: 12,
      durationMs: 60000,
      capturedFiles: {
        "REVIEW.md":
          "## Summary\n\nReviewed 3 files. One inline finding posted.\n\n## What was checked\n\n- src/foo.ts\n- src/bar.ts\n- src/baz.ts\n\n## Findings\n\n- [major] src/foo.ts:42, example finding for the test fixture",
      },
    };
  });

  afterEach(() => {
    pipelineResult = { success: false };
  });

  it("rejects an issue target", async () => {
    const ctx = buildCtx(undefined, "issue");
    const result = await reviewHandler(ctx);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("PR target");
    }
  });

  it("rejects a closed PR", async () => {
    const ctx = buildCtx({ state: "closed" });
    const result = await reviewHandler(ctx);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("closed");
      expect(result.reason).toContain("open PR");
    }
  });

  it("succeeds and captures REVIEW.md when pipeline succeeds", async () => {
    const ctx = buildCtx({ changedFiles: 5, additions: 100, deletions: 20 });
    const result = await reviewHandler(ctx);
    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      const state = result.state as Record<string, unknown>;
      expect(state["pr_number"]).toBe(99);
      expect(state["changed_files"]).toBe(5);
      expect(state["additions"]).toBe(100);
      expect(state["deletions"]).toBe(20);
      expect(state["report"]).toContain("Reviewed 3 files");
      expect(state["findings"]).toEqual({
        blocker: 0,
        major: 1,
        minor: 0,
        nit: 0,
        total: 1,
      });
      expect(state["costUsd"]).toBe(0.42);
      expect(state["turns"]).toBe(12);
      const branch = state["branch_state"] as Record<string, unknown>;
      expect(branch["commits_behind_base"]).toBe(0);
      expect(branch["is_fork"]).toBe(false);
    }
    expect(ctx.setStateMock).toHaveBeenCalledTimes(1);
    const seedArgs = ctx.setStateMock.mock.calls[0] as [unknown, string];
    expect(seedArgs[1]).toContain("Code review starting");
    expect(seedArgs[1]).toContain("5 files");
    if (result.status === "succeeded") {
      expect(result.humanMessage).toContain("Code review complete");
      expect(result.humanMessage).toContain("5 files");
      expect(result.humanMessage).toContain("+100/-20");
      expect(result.humanMessage).toContain("Reviewed 3 files");
    }
  });

  it("records commits_behind_base when the branch is stale", async () => {
    const ctx = buildCtx({ behindBy: 7 });
    const result = await reviewHandler(ctx);
    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      const state = result.state as { branch_state: Record<string, unknown> };
      expect(state.branch_state["commits_behind_base"]).toBe(7);
      expect(state.branch_state["is_fork"]).toBe(false);
    }
  });

  it("flags fork PRs in branch_state so the agent knows it can't push", async () => {
    const ctx = buildCtx({ behindBy: 3, isFork: true });
    const result = await reviewHandler(ctx);
    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      const state = result.state as { branch_state: Record<string, unknown> };
      expect(state.branch_state["commits_behind_base"]).toBe(3);
      expect(state.branch_state["is_fork"]).toBe(true);
    }
  });

  it("falls back to a placeholder when REVIEW.md is missing", async () => {
    pipelineResult = {
      success: true,
      costUsd: 0,
      numTurns: 1,
      durationMs: 1000,
      capturedFiles: {},
    };
    const ctx = buildCtx();
    const result = await reviewHandler(ctx);
    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      expect(result.humanMessage).toContain("no REVIEW.md report");
    }
    expect(ctx.setStateMock).toHaveBeenCalledTimes(1);
  });

  it("fails when the pipeline reports failure", async () => {
    pipelineResult = {
      success: false,
      daemonActions: {
        learnings: [{ category: "conventions", content: "Keep review findings focused." }],
        deletions: [],
      },
    };
    const ctx = buildCtx();
    const repoMemory = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        category: "conventions" as const,
        content: "Review full files.",
        pinned: true,
      },
    ];
    (ctx as { repoMemory?: typeof repoMemory }).repoMemory = repoMemory;
    const result = await reviewHandler(ctx);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("pipeline");
    }
    expect((mockRunPipeline.mock.calls.at(-1)?.[0] as BotContext).repoMemory).toEqual(repoMemory);
    expect("daemonActions" in result ? result.daemonActions : undefined).toEqual(
      pipelineResult.daemonActions,
    );
  });
});

describe("countFindings", () => {
  it("counts severity tags case-insensitively and excludes nits from total", async () => {
    const { countFindings } = await import("../../../src/workflows/handlers/review");
    const report = `## Summary

Found 4 issues.

[blocker] Null deref on line 12.
[major] Missing test for X.
[Major] Race condition in Y.
[minor] Inefficient sort.
[NIT] Variable name could be clearer.`;
    expect(countFindings(report)).toEqual({
      blocker: 1,
      major: 2,
      minor: 1,
      nit: 1,
      total: 4,
    });
  });

  it("returns all-zeros for an empty or no-findings report", async () => {
    const { countFindings } = await import("../../../src/workflows/handlers/review");
    expect(countFindings("")).toEqual({ blocker: 0, major: 0, minor: 0, nit: 0, total: 0 });
    expect(countFindings("## Summary\n\nNo findings, all clean.")).toEqual({
      blocker: 0,
      major: 0,
      minor: 0,
      nit: 0,
      total: 0,
    });
  });
});

// ─── Per-repo agent policy, `.github-app.yaml` Gate 2 ───────────────────────

describe("review handler: per-repo policy forwarding", () => {
  beforeEach(() => {
    mockRunPipeline.mockClear();
    pipelineResult = { success: true, capturedFiles: { "REVIEW.md": "## Summary\n\nOK" } };
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

    await reviewHandler(ctx);

    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    const overrides = mockRunPipeline.mock.calls[0]?.[1] as
      | { policy?: Record<string, unknown> }
      | undefined;
    expect(overrides?.policy).toEqual(policy);
  });

  it("forwards the run-context maxTurns into the pipeline overrides", async () => {
    // The turn cap rides the top-level payload field, not `policy`, so it
    // needs its own hop. Without it `workflows.<name>.max_turns` is inert and
    // executeAgent silently falls back to AGENT_MAX_TURNS.
    const ctx = buildCtx();
    (ctx as unknown as Record<string, unknown>)["maxTurns"] = 12;

    await reviewHandler(ctx);

    const overrides = mockRunPipeline.mock.calls[0]?.[1] as { maxTurns?: number } | undefined;
    expect(overrides?.maxTurns).toBe(12);
  });

  it("forwards the daemon attempt signal into the pipeline overrides", async () => {
    const ctx = buildCtx();
    const signal = new AbortController().signal;
    (ctx as unknown as Record<string, unknown>)["signal"] = signal;

    await reviewHandler(ctx);

    const overrides = mockRunPipeline.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
    expect(overrides?.signal).toBe(signal);
  });

  it("passes no maxTurns key when the run context carries none", async () => {
    await reviewHandler(buildCtx());

    const overrides = mockRunPipeline.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(Object.hasOwn(overrides ?? {}, "maxTurns")).toBe(false);
  });

  it("passes no policy key when the run context carries none (C8)", async () => {
    await reviewHandler(buildCtx());

    const overrides = mockRunPipeline.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(overrides).toBeDefined();
    // `exactOptionalPropertyTypes`: absent, not `undefined`-valued.
    expect(Object.hasOwn(overrides ?? {}, "policy")).toBe(false);
    // Existing overrides must survive the addition.
    expect(overrides?.["captureFiles"]).toEqual(["REVIEW.md"]);
    expect(overrides?.["enableReviewLearnings"]).toBe(true);
  });
});
