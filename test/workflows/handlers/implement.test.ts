/**
 * Unit tests for the `implement` handler: focused on the post-pipeline
 * "did the agent open a PR?" verifier.
 *
 * Background: in `GITHUB_PERSONAL_ACCESS_TOKEN` mode the bot authors PRs as
 * a real user (`pr.user.type === "User"`). The pre-fix verifier filtered on
 * `type === "Bot"`, which made every PAT-mode implement run report
 * `"implement completed but no PR was found"` even though the PR was opened
 * correctly. These tests pin both modes so the regression can't return.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";
import type pino from "pino";

import type { WorkflowRunContext } from "../../../src/workflows/registry";
import { expectToReject } from "../../utils/assertions";

const mockConfig: { githubPersonalAccessToken: string | undefined } = {
  githubPersonalAccessToken: undefined,
};

void mock.module("../../../src/config", () => ({ config: mockConfig }));

let pipelineResult: {
  success: boolean;
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
  capturedFiles?: Record<string, string>;
  daemonActions?: {
    learnings: { category: "setup"; content: string }[];
    deletions: string[];
  };
};

const mockRunPipeline = mock(() => Promise.resolve(pipelineResult));

void mock.module("../../../src/core/pipeline", () => ({
  runPipeline: mockRunPipeline,
}));

class StaleWorkflowAttemptError extends Error {}

void mock.module("../../../src/workflows/runs-store", () => ({
  StaleWorkflowAttemptError,
}));

// Stub the discussion-digest module so this test (which mocks `config` down
// to a single field) does not transitively load the real module's `logger`
// import against an incomplete config. The digest path is covered by
// test/workflows/discussion-digest.test.ts.
void mock.module("../../../src/workflows/discussion-digest", () => ({
  fetchAndBuildDigest: mock(() => Promise.resolve({ ok: false, reason: "no-comments" })),
  renderDigestSection: mock(() => ""),
}));

const { handler: implementHandler } = await import("../../../src/workflows/handlers/implement");

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

interface PrStub {
  number: number;
  type: "Bot" | "User";
  login: string;
  createdAtOffsetMs?: number;
  branch?: string;
}

function buildCtx(
  prs: PrStub[],
  options?: { authenticatedLogin?: string },
): WorkflowRunContext & { setStateMock: ReturnType<typeof mock> } {
  // Anchor created_at slightly in the past so fixtures never produce future
  // timestamps. The handler's filter is `created >= since - 5s`; since the
  // mocked pipeline resolves synchronously, `since` is captured a few ms
  // after `now`, so a 1s past offset still satisfies the window.
  const now = Date.now();
  const prData = prs.map((p) => ({
    number: p.number,
    html_url: `https://github.com/acme/widgets/pull/${String(p.number)}`,
    head: { ref: p.branch ?? `feat/issue-1-${String(p.number)}` },
    user: { type: p.type, login: p.login },
    created_at: new Date(now - (p.createdAtOffsetMs ?? 1000)).toISOString(),
  }));

  const octokit = {
    rest: {
      issues: {
        get: mock(() =>
          Promise.resolve({
            data: { title: "Implement the thing", user: { login: "humanA" } },
          }),
        ),
      },
      repos: {
        get: mock(() => Promise.resolve({ data: { default_branch: "main" } })),
      },
      pulls: {
        list: mock(() => Promise.resolve({ data: prData })),
      },
      users: {
        getAuthenticated: mock(() =>
          Promise.resolve({
            data: { login: options?.authenticatedLogin ?? "chrisleekr" },
          }),
        ),
      },
    },
  } as unknown as Octokit;

  const setStateMock = mock(() => Promise.resolve({ trackingCommentId: 12345 }));

  return {
    runId: "run-1",
    workflowName: "implement",
    target: { type: "issue", owner: "acme", repo: "widgets", number: 1 },
    logger: silentLog(),
    octokit,
    deliveryId: "delivery-1",
    daemonId: "daemon-1",
    priorPlanState: { plan: "## Plan\n\nDo the thing." },
    setState: setStateMock,
    setStateMock,
  } as unknown as WorkflowRunContext & { setStateMock: ReturnType<typeof mock> };
}

describe("implement handler: findRecentOpenedPr", () => {
  beforeEach(() => {
    pipelineResult = {
      success: true,
      costUsd: 0.5,
      numTurns: 8,
      durationMs: 12_000,
      capturedFiles: { "IMPLEMENT.md": "## Summary\n\nImplemented." },
    };
    mockConfig.githubPersonalAccessToken = undefined;
  });

  afterEach(() => {
    mockConfig.githubPersonalAccessToken = undefined;
  });

  it("stops before pipeline execution when the starting-comment attempt fence is stale", async () => {
    const ctx = buildCtx([]);
    ctx.setStateMock.mockImplementation(() =>
      Promise.reject(new StaleWorkflowAttemptError("workflow attempt is no longer current")),
    );

    await expectToReject(implementHandler(ctx), "workflow attempt is no longer current");
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it("App mode: accepts a PR authored by the App bot", async () => {
    const ctx = buildCtx([{ number: 107, type: "Bot", login: "chrisleekr-bot[bot]" }]);
    const result = await implementHandler(ctx);
    expect(result.status).toBe("succeeded");
    expect(
      ctx.octokit.rest.users.getAuthenticated as unknown as ReturnType<typeof mock>,
    ).not.toHaveBeenCalled();
    if (result.status === "succeeded") {
      expect(result.state["pr_number"]).toBe(107);
    }
  });

  it("passes repo memory into the pipeline and forwards terminal daemon actions", async () => {
    const ctx = buildCtx([{ number: 107, type: "Bot", login: "chrisleekr-bot[bot]" }]);
    const repoMemory = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        category: "setup" as const,
        content: "Run isolated tests.",
        pinned: false,
      },
    ];
    (ctx as { repoMemory?: typeof repoMemory }).repoMemory = repoMemory;
    pipelineResult.daemonActions = {
      learnings: [{ category: "setup", content: "Use Bun." }],
      deletions: [],
    };

    const result = await implementHandler(ctx);

    expect((mockRunPipeline.mock.calls.at(-1)?.[0] as BotContext).repoMemory).toEqual(repoMemory);
    expect("daemonActions" in result ? result.daemonActions : undefined).toEqual(
      pipelineResult.daemonActions,
    );
  });

  it("App mode: rejects a PR authored by a User account", async () => {
    pipelineResult.daemonActions = {
      learnings: [{ category: "setup", content: "Use the App-authored PR." }],
      deletions: [],
    };
    const ctx = buildCtx([{ number: 107, type: "User", login: "chrisleekr" }]);
    const result = await implementHandler(ctx);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toBe("implement completed but no PR was found");
    }
    expect("daemonActions" in result ? result.daemonActions : undefined).toEqual(
      pipelineResult.daemonActions,
    );
  });

  it("PAT mode: accepts a PR authored by the PAT owner (regression: User type)", async () => {
    mockConfig.githubPersonalAccessToken = "ghp_test_token";
    const ctx = buildCtx([{ number: 107, type: "User", login: "chrisleekr" }], {
      authenticatedLogin: "chrisleekr",
    });
    const result = await implementHandler(ctx);
    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      expect(result.state["pr_number"]).toBe(107);
    }
  });

  it("PAT mode: rejects a PR authored by an unrelated bot", async () => {
    mockConfig.githubPersonalAccessToken = "ghp_test_token";
    const ctx = buildCtx([{ number: 107, type: "Bot", login: "renovate[bot]" }], {
      authenticatedLogin: "chrisleekr",
    });
    const result = await implementHandler(ctx);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toBe("implement completed but no PR was found");
    }
  });

  it("PAT mode: fails closed when /user lookup fails (no fallback)", async () => {
    mockConfig.githubPersonalAccessToken = "ghp_test_token";
    const ctx = buildCtx([{ number: 107, type: "User", login: "chrisleekr" }]);
    (
      ctx.octokit.rest.users.getAuthenticated as unknown as ReturnType<typeof mock>
    ).mockImplementationOnce(() => Promise.reject(new Error("503 Service Unavailable")));
    const result = await implementHandler(ctx);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("503 Service Unavailable");
    }
  });

  it("PAT mode: /user failure does NOT misclaim an unrelated bot PR", async () => {
    // Regression for the false-positive scenario flagged by Copilot:
    // before this fix, /user failure fell back to the Bot-type filter,
    // which would happily match a Dependabot/Renovate PR opened in the
    // same time window as the implement run.
    mockConfig.githubPersonalAccessToken = "ghp_test_token";
    const ctx = buildCtx([
      { number: 999, type: "Bot", login: "dependabot[bot]" },
      { number: 107, type: "User", login: "chrisleekr" },
    ]);
    (
      ctx.octokit.rest.users.getAuthenticated as unknown as ReturnType<typeof mock>
    ).mockImplementationOnce(() => Promise.reject(new Error("502 Bad Gateway")));
    const result = await implementHandler(ctx);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      // Must NOT silently claim PR #999 (Dependabot's bot PR).
      expect(result.reason).not.toContain("999");
      expect(result.reason).toContain("502 Bad Gateway");
    }
  });
});

// ─── Per-repo agent policy, `.github-app.yaml` Gate 2 ───────────────────────

describe("implement handler: per-repo policy forwarding", () => {
  beforeEach(() => {
    mockRunPipeline.mockClear();
    pipelineResult = { success: true, capturedFiles: { "IMPLEMENT.md": "## Summary\n\nDone." } };
  });

  it("forwards the run-context policy into the pipeline overrides", async () => {
    const policy = {
      model: "claude-repo-pinned-model",
      timeoutMs: 900_000,
      extraAllowedTools: ["WebFetch"],
    };
    const ctx = buildCtx([]);
    (ctx as unknown as Record<string, unknown>)["policy"] = policy;

    await implementHandler(ctx);

    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    const overrides = mockRunPipeline.mock.calls[0]?.[1] as
      | { policy?: Record<string, unknown> }
      | undefined;
    expect(overrides?.policy).toEqual(policy);
  });

  it("forwards the run-context maxTurns into the pipeline overrides", async () => {
    // The turn cap rides the top-level payload field, not `policy`, so it
    // needs its own hop. Without it `workflows.implement.max_turns` is inert.
    const ctx = buildCtx([]);
    (ctx as unknown as Record<string, unknown>)["maxTurns"] = 12;

    await implementHandler(ctx);

    const overrides = mockRunPipeline.mock.calls[0]?.[1] as { maxTurns?: number } | undefined;
    expect(overrides?.maxTurns).toBe(12);
  });

  it("forwards the daemon attempt signal into the pipeline overrides", async () => {
    const ctx = buildCtx([]);
    const signal = new AbortController().signal;
    (ctx as unknown as Record<string, unknown>)["signal"] = signal;

    await implementHandler(ctx);

    const overrides = mockRunPipeline.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
    expect(overrides?.signal).toBe(signal);
  });

  it("passes no policy or maxTurns key when the run context carries neither (C8)", async () => {
    await implementHandler(buildCtx([]));

    const overrides = mockRunPipeline.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(overrides).toBeDefined();
    // `exactOptionalPropertyTypes`: absent, not `undefined`-valued.
    expect(Object.hasOwn(overrides ?? {}, "policy")).toBe(false);
    expect(Object.hasOwn(overrides ?? {}, "maxTurns")).toBe(false);
    // Existing overrides must survive the addition.
    expect(overrides?.["captureFiles"]).toEqual(["IMPLEMENT.md"]);
  });
});
