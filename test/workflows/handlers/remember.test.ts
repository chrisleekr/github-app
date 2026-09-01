/**
 * Wiring-only tests for the `remember` handler's Gate-2 hop.
 *
 * The handler's agent behaviour (directive extraction, dedup, save) is the
 * agent's job and is not unit-testable here. What IS testable, and what has
 * no other guard, is the two-line forward of `ctx.policy` / `ctx.maxTurns`
 * into `runPipeline`: delete the spread and nothing else fails.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";
import type pino from "pino";

import type { BotContext } from "../../../src/types";
import type { WorkflowRunContext } from "../../../src/workflows/registry";

const mockRunPipeline = mock(() => Promise.resolve({ success: true }));

void mock.module("../../../src/core/pipeline", () => ({
  runPipeline: mockRunPipeline,
}));

// The digest path has its own suite; stub it so this file does not pull the
// real module's config/logger graph.
void mock.module("../../../src/workflows/discussion-digest", () => ({
  fetchAndBuildDigest: mock(() => Promise.resolve({ ok: false, reason: "no-comments" })),
  renderDigestSection: mock(() => ""),
}));

const { handler: rememberHandler } = await import("../../../src/workflows/handlers/remember");

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
        get: mock(() => Promise.resolve({ data: { title: "Some issue", body: "body" } })),
      },
      repos: {
        get: mock(() => Promise.resolve({ data: { default_branch: "main" } })),
      },
    },
  } as unknown as Octokit;

  return {
    runId: "run-1",
    workflowName: "remember",
    target: { type: "issue", owner: "acme", repo: "widgets", number: 7 },
    logger: silentLog(),
    octokit,
    deliveryId: "delivery-1",
    daemonId: "daemon-1",
    setState: mock(() => Promise.resolve({ trackingCommentId: 12345 })),
  } as unknown as WorkflowRunContext;
}

describe("remember handler: per-repo policy forwarding", () => {
  beforeEach(() => {
    mockRunPipeline.mockClear();
  });

  it("forwards the run-context policy and maxTurns into the pipeline overrides", async () => {
    const policy = { model: "claude-repo-pinned-model", timeoutMs: 900_000 };
    const ctx = buildCtx();
    (ctx as unknown as Record<string, unknown>)["policy"] = policy;
    (ctx as unknown as Record<string, unknown>)["maxTurns"] = 12;

    const result = await rememberHandler(ctx);

    expect(result.status).toBe("succeeded");
    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    const overrides = mockRunPipeline.mock.calls[0]?.[1] as
      | { policy?: Record<string, unknown>; maxTurns?: number }
      | undefined;
    expect(overrides?.policy).toEqual(policy);
    expect(overrides?.maxTurns).toBe(12);
  });

  it("forwards the daemon attempt signal into the pipeline overrides", async () => {
    const ctx = buildCtx();
    const signal = new AbortController().signal;
    (ctx as unknown as Record<string, unknown>)["signal"] = signal;

    await rememberHandler(ctx);

    const overrides = mockRunPipeline.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
    expect(overrides?.signal).toBe(signal);
  });

  it("passes repo memory into the pipeline and forwards terminal daemon actions", async () => {
    const ctx = buildCtx();
    const repoMemory = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        category: "conventions" as const,
        content: "Keep policies concise.",
        pinned: false,
      },
    ];
    (ctx as { repoMemory?: typeof repoMemory }).repoMemory = repoMemory;
    const daemonActions = {
      learnings: [{ category: "conventions" as const, content: "Document policies." }],
      deletions: [],
    };
    mockRunPipeline.mockResolvedValueOnce({ success: true, daemonActions });

    const result = await rememberHandler(ctx);

    expect((mockRunPipeline.mock.calls[0]?.[0] as BotContext).repoMemory).toEqual(repoMemory);
    expect("daemonActions" in result ? result.daemonActions : undefined).toEqual(daemonActions);
  });

  it("passes no policy or maxTurns key when the run context carries neither (C8)", async () => {
    await rememberHandler(buildCtx());

    const overrides = mockRunPipeline.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(overrides).toBeDefined();
    // `exactOptionalPropertyTypes`: absent, not `undefined`-valued.
    expect(Object.hasOwn(overrides ?? {}, "policy")).toBe(false);
    expect(Object.hasOwn(overrides ?? {}, "maxTurns")).toBe(false);
    // Existing overrides must survive the addition.
    expect(overrides?.["enableReviewLearnings"]).toBe(true);
  });
});
