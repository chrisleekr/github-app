import { describe, expect, it } from "bun:test";

import {
  WORKFLOW_RUNNER_MESSAGE_MAX_BYTES,
  WorkflowRunnerCommandSchema,
  WorkflowRunnerPayloadSchema,
  WorkflowRunnerResultPayloadSchema,
} from "../../src/shared/workflow-runner-messages";
import {
  HandlerResultSchema,
  WORKFLOW_RUNNER_HUMAN_MESSAGE_MAX_CHARS,
} from "../../src/shared/workflow-types";

function repoMemoryEntries(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, () => ({
    id: crypto.randomUUID(),
    category: "setup",
    content: "Run the focused tests.",
    pinned: false,
  }));
}

function repoLearningActions(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, () => ({
    category: "setup",
    content: "bounded",
  }));
}

function reviewLearnings(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, () => ({
    id: crypto.randomUUID(),
    scope: "local",
    fileGlob: null,
    directive: "Bound this list.",
    rationale: null,
    sourcePr: null,
    sourceThread: null,
    sourceAuthor: null,
  }));
}

describe("WorkflowRunnerPayloadSchema", () => {
  it("retains handler inputs and strips legacy shared-daemon inputs", () => {
    const payload = WorkflowRunnerPayloadSchema.parse({
      context: { owner: "acme", repo: "widgets", entityNumber: 16 },
      installationToken: "target-repository-token",
      installationTokenExpiresAt: "2026-08-23T04:00:00Z",
      attemptDeadlineAt: "2026-08-23T04:10:00Z",
      repoMemory: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          category: "architecture",
          content: "Uses a controller and isolated runners.",
          pinned: true,
        },
      ],
      installationId: 123,
      allowedTools: ["Read"],
      envVars: { REPO_SECRET: "must-not-cross-boundary" },
      memory: [{ id: "memory-1", category: "env", content: "secret", pinned: false }],
      maxTurns: 20,
      reviewLearnings: [
        {
          id: "learning-1",
          scope: "local",
          fileGlob: null,
          directive: "Keep the boundary narrow.",
          rationale: null,
          sourcePr: null,
          sourceThread: null,
          sourceAuthor: null,
        },
      ],
      policy: { model: "provider-model", timeoutMs: 60_000 },
      workflowRun: { runId: crypto.randomUUID(), workflowName: "implement" },
      priorPlanState: { plan: "Implement the approved change." },
    });

    expect(payload).toEqual({
      context: { owner: "acme", repo: "widgets", entityNumber: 16 },
      installationToken: "target-repository-token",
      installationTokenExpiresAt: "2026-08-23T04:00:00Z",
      attemptDeadlineAt: "2026-08-23T04:10:00Z",
      repoMemory: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          category: "architecture",
          content: "Uses a controller and isolated runners.",
          pinned: true,
        },
      ],
      maxTurns: 20,
      reviewLearnings: [
        {
          id: "learning-1",
          scope: "local",
          fileGlob: null,
          directive: "Keep the boundary narrow.",
          rationale: null,
          sourcePr: null,
          sourceThread: null,
          sourceAuthor: null,
        },
      ],
      policy: { model: "provider-model", timeoutMs: 60_000 },
      workflowRun: expect.objectContaining({ workflowName: "implement" }),
      priorPlanState: { plan: "Implement the approved change." },
    });
    expect("installationId" in payload).toBe(false);
    expect("allowedTools" in payload).toBe(false);
    expect("envVars" in payload).toBe(false);
    expect("memory" in payload).toBe(false);
  });

  it("caps repo memory at 50 entries", () => {
    expect(() =>
      WorkflowRunnerPayloadSchema.parse({
        context: {},
        installationToken: "token",
        installationTokenExpiresAt: "2026-08-23T04:00:00Z",
        attemptDeadlineAt: "2026-08-23T04:10:00Z",
        repoMemory: repoMemoryEntries(51),
        workflowRun: { runId: crypto.randomUUID(), workflowName: "implement" },
      }),
    ).toThrow();
  });

  it("bounds review learnings and strips unapproved historical state", () => {
    const runId = crypto.randomUUID();
    const base = {
      context: {},
      installationToken: "token",
      installationTokenExpiresAt: "2026-08-23T04:00:00Z",
      attemptDeadlineAt: "2026-08-23T04:10:00Z",
      workflowRun: { runId, workflowName: "ship" },
    };
    const parsed = WorkflowRunnerPayloadSchema.parse({
      ...base,
      priorPlanState: { plan: "Approved plan.", hidden: "drop-me" },
      shipStepRuns: {
        triage: {
          id: crypto.randomUUID(),
          status: "succeeded",
          state: { recommendedNext: "plan", hidden: "drop-me" },
          createdAt: "2026-08-23T04:00:00Z",
        },
      },
    });
    expect(parsed.priorPlanState).toEqual({ plan: "Approved plan." });
    expect(parsed.shipStepRuns?.triage?.state).toEqual({ recommendedNext: "plan" });

    expect(() =>
      WorkflowRunnerPayloadSchema.parse({
        ...base,
        reviewLearnings: reviewLearnings(51),
      }),
    ).toThrow();
  });
});

describe("HandlerResultSchema daemon actions", () => {
  const actions = {
    learnings: [{ category: "gotchas" as const, content: "Do not skip isolated tests." }],
    deletions: ["22222222-2222-4222-8222-222222222222"],
    reviewLearningSaves: [
      {
        directive: "Keep result settlement retryable.",
        rationale: "Persistence can fail transiently.",
      },
    ],
    reviewLearningDeletes: ["33333333-3333-4333-8333-333333333333"],
  };

  it("retains bounded daemon actions on terminal results", () => {
    const parsed = HandlerResultSchema.parse({
      status: "failed",
      reason: "pipeline failed",
      daemonActions: actions,
    });
    expect("daemonActions" in parsed ? parsed.daemonActions : undefined).toEqual(actions);
  });

  it("rejects actions on hand-off and arrays above 50", () => {
    expect(() =>
      HandlerResultSchema.parse({
        status: "handed-off",
        childRunId: crypto.randomUUID(),
        daemonActions: actions,
      }),
    ).toThrow();
    expect(() =>
      HandlerResultSchema.parse({
        status: "succeeded",
        state: {},
        daemonActions: {
          learnings: repoLearningActions(51),
          deletions: [],
        },
      }),
    ).toThrow();
  });
});

describe("workflow runner outbound bounds", () => {
  it("rejects controller-reserved state keys on every runner-owned state path", () => {
    for (const key of ["_configNotice", "_lastHumanMessage"]) {
      expect(() =>
        WorkflowRunnerCommandSchema.parse({
          type: "set-state",
          patch: { [key]: "spoofed" },
          humanMessage: "progress",
        }),
      ).toThrow("controller-reserved");
      expect(() =>
        WorkflowRunnerCommandSchema.parse({
          type: "hand-off-child",
          workflowName: "review",
          target: { type: "pr", owner: "acme", repo: "widgets", number: 1 },
          parentStepIndex: 3,
          state: { [key]: "spoofed" },
          humanMessage: "handoff",
        }),
      ).toThrow("controller-reserved");
      expect(() =>
        WorkflowRunnerResultPayloadSchema.parse({
          runId: crypto.randomUUID(),
          attemptId: crypto.randomUUID(),
          durationMs: 1,
          result: { status: "succeeded", state: { [key]: "spoofed" } },
        }),
      ).toThrow("controller-reserved");
    }
  });

  it("rejects human messages that cannot fit safely in a GitHub projection", () => {
    expect(() =>
      HandlerResultSchema.parse({
        status: "succeeded",
        state: {},
        humanMessage: "x".repeat(WORKFLOW_RUNNER_HUMAN_MESSAGE_MAX_CHARS + 1),
      }),
    ).toThrow();
  });

  it("rejects command and result JSON above the WebSocket budget", () => {
    const oversized = "x".repeat(WORKFLOW_RUNNER_MESSAGE_MAX_BYTES);
    expect(() =>
      WorkflowRunnerCommandSchema.parse({
        type: "set-state",
        patch: { oversized },
        humanMessage: "progress",
      }),
    ).toThrow("byte budget");
    expect(() =>
      WorkflowRunnerResultPayloadSchema.parse({
        runId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        durationMs: 1,
        result: { status: "succeeded", state: { oversized } },
      }),
    ).toThrow("byte budget");
  });
});
