import { beforeEach, describe, expect, it, mock } from "bun:test";

import { expectToReject } from "../utils/assertions";

const handler = mock((_context: unknown) =>
  Promise.resolve({
    status: "succeeded" as const,
    state: { complete: true },
    daemonActions: {
      learnings: [{ category: "setup" as const, content: "Run bun test per file." }],
      deletions: [],
    },
  }),
);

void mock.module("octokit", () => ({
  Octokit: function MockOctokit(this: unknown): unknown {
    return this;
  },
}));
void mock.module("../../src/logger", () => ({
  logger: {
    child: mock(() => ({
      info: mock(() => undefined),
      warn: mock(() => undefined),
      error: mock(() => undefined),
      debug: mock(() => undefined),
    })),
  },
}));
void mock.module("../../src/workflows/registry", () => ({
  getByName: mock(() => ({ handler })),
}));

const { executeWorkflowRunnerJob } = await import("../../src/runner/workflow-executor");

describe("workflow runner executor", () => {
  beforeEach(() => {
    handler.mockReset();
    handler.mockResolvedValue({
      status: "succeeded",
      state: { complete: true },
      daemonActions: {
        learnings: [{ category: "setup", content: "Run bun test per file." }],
        deletions: [],
      },
    });
  });

  it("passes bounded repo memory to the handler and retains daemon actions", async () => {
    const repoMemory = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        category: "architecture" as const,
        content: "The orchestrator owns durable state.",
        pinned: true,
      },
    ];
    const result = await executeWorkflowRunnerJob(
      {
        context: {
          owner: "acme",
          repo: "widgets",
          entityNumber: 16,
          isPR: false,
          deliveryId: "delivery-16",
        },
        installationToken: "ghs_scoped",
        installationTokenExpiresAt: "2026-08-23T04:00:00Z",
        attemptDeadlineAt: "2026-08-23T04:10:00Z",
        repoMemory,
        workflowRun: {
          runId: "22222222-2222-4222-8222-222222222222",
          workflowName: "implement",
        },
      },
      {
        attemptId: "33333333-3333-4333-8333-333333333333",
        command: mock(() => Promise.resolve({})),
      } as never,
      new AbortController().signal,
    );

    const context = handler.mock.calls[0]?.[0] as { repoMemory?: unknown } | undefined;
    expect(context?.repoMemory).toEqual(repoMemory);
    expect("daemonActions" in result ? result.daemonActions : undefined).toEqual({
      learnings: [{ category: "setup", content: "Run bun test per file." }],
      deletions: [],
    });
  });

  it("maps bounded payload fields and controller commands into the handler context", async () => {
    const command = mock((input: { type: string }) =>
      Promise.resolve(input.type === "hand-off-child" ? { childRunId: crypto.randomUUID() } : {}),
    );
    const signal = new AbortController().signal;
    handler.mockImplementationOnce(async (context: unknown) => {
      const runContext = context as {
        setState: (state: unknown, message: string) => Promise<unknown>;
        handOffChild: (input: Record<string, unknown>) => Promise<{ childRunId: string }>;
      };
      await runContext.setState({ phase: "working" }, "Working.");
      await runContext.handOffChild({
        workflowName: "review",
        target: { type: "pr", owner: "acme", repo: "widgets", number: 42 },
        parentStepIndex: 3,
        state: {},
        humanMessage: "Review queued.",
      });
      return { status: "succeeded" as const, state: {} };
    });

    await executeWorkflowRunnerJob(
      {
        context: {
          owner: "acme",
          repo: "widgets",
          entityNumber: 16,
          isPR: false,
          deliveryId: "delivery-16",
        },
        installationToken: "ghs_scoped",
        installationTokenExpiresAt: "2026-08-23T04:00:00Z",
        attemptDeadlineAt: "2026-08-23T04:10:00Z",
        maxTurns: 50,
        policy: { model: "claude-test" },
        priorPlanState: { plan: "Approved plan" },
        reviewLearnings: [
          {
            id: crypto.randomUUID(),
            scope: "local",
            fileGlob: null,
            directive: "Keep the controller authoritative.",
            rationale: null,
            sourcePr: null,
            sourceThread: null,
            sourceAuthor: null,
            createdAt: "2026-08-23T00:00:00Z",
          },
        ],
        shipStepRuns: {},
        workflowRun: {
          runId: crypto.randomUUID(),
          workflowName: "implement",
        },
      },
      { attemptId: crypto.randomUUID(), command } as never,
      signal,
    );

    const context = handler.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(context["maxTurns"]).toBe(50);
    expect(context["policy"]).toEqual({ model: "claude-test" });
    expect(context["priorPlanState"]).toEqual({ plan: "Approved plan" });
    expect(context["reviewLearnings"]).toHaveLength(1);
    expect(context["shipStepRuns"]).toEqual({});
    expect(context["signal"]).toBe(signal);
    expect(command.mock.calls.map((call) => call[0]?.type)).toEqual([
      "set-state",
      "hand-off-child",
    ]);
  });

  it("does not enter a handler after the attempt is fenced", async () => {
    const controller = new AbortController();
    controller.abort(new Error("attempt fenced"));
    await expectToReject(
      executeWorkflowRunnerJob(
        {
          context: {
            owner: "acme",
            repo: "widgets",
            entityNumber: 16,
            isPR: false,
            deliveryId: "delivery-16",
          },
          installationToken: "ghs_scoped",
          installationTokenExpiresAt: "2026-08-23T04:00:00Z",
          attemptDeadlineAt: "2026-08-23T04:10:00Z",
          workflowRun: { runId: crypto.randomUUID(), workflowName: "implement" },
        },
        { attemptId: crypto.randomUUID(), command: mock(() => Promise.resolve({})) } as never,
        controller.signal,
      ),
      "attempt fenced",
    );
    expect(handler).not.toHaveBeenCalled();
  });
});
