import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { PendingWorkflowRunnerResult } from "../../src/orchestrator/workflow-runner-store";
import { expectToReject, waitFor } from "../utils/assertions";

const resultStates = new Map<string, "pending" | "processed" | "missing">();
const attemptsByRun = new Map<string, string>();
const statusesByRun = new Map<string, "running" | "succeeded">();
const targetNumbersByRun = new Map<string, number>();
const targetTypesByRun = new Map<string, "issue" | "pr">();
const parentIdsByRun = new Map<string, string>();
const ensureWorkflowCascadeForOffer = mock(() => Promise.resolve());
const setState = mock(() => Promise.resolve());
const persistRepoKnowledge = mock(() => Promise.resolve());
const addReaction = mock(() => Promise.resolve());
const findById = mock((runId: string) =>
  Promise.resolve({
    ...workflowRow(runId),
    attempt_id: attemptsByRun.get(runId) ?? null,
    status: statusesByRun.get(runId) ?? "succeeded",
  }),
);
const getWorkflowRunnerResultProcessingState = mock((pending: PendingWorkflowRunnerResult) =>
  Promise.resolve(resultStates.get(pending.attemptId) ?? "missing"),
);
const markWorkflowRunnerResultProcessed = mock((attemptId: string) => {
  resultStates.set(attemptId, "processed");
  return Promise.resolve(true);
});
const cleanupCurrentWorkflowRunnerResources = mock(() => Promise.resolve());
const loggerInfo = mock(() => undefined);
const loggerWarn = mock(() => undefined);
const revokeInstallationToken = mock(() => Promise.resolve(true));
const mintInstallationToken = mock(() => Promise.resolve({ octokit: {} }));
const getRepoInstallation = mock(() => Promise.resolve({ data: { id: 123 } }));

void mock.module("../../src/config", () => ({
  config: {
    appId: "test-app",
    privateKey: "test-key",
    reviewLearningsEnabled: true,
  },
}));
void mock.module("../../src/db", () => ({
  requireDb: (): Record<string, never> => ({}),
}));
void mock.module("../../src/logger", () => ({
  logger: {
    info: loggerInfo,
    warn: loggerWarn,
    error: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));
void mock.module("octokit", () => ({
  Octokit: function MockOctokit(this: unknown): unknown {
    return this;
  },
  App: function MockApp(this: unknown): unknown {
    return { octokit: { rest: { apps: { getRepoInstallation } } } };
  },
}));
void mock.module("../../src/utils/log-redaction", () => ({
  redactErrorMessageOrFallback: (value: string | undefined, fallback: string): string =>
    value ?? fallback,
}));
void mock.module("../../src/utils/reactions", () => ({ addReaction }));
void mock.module("../../src/workflows/completion-reconciler", () => ({
  ensureWorkflowCascadeForOffer,
}));
void mock.module("../../src/workflows/runs-store", () => ({ findById }));
void mock.module("../../src/workflows/tracking-mirror", () => ({ setState }));
void mock.module("../../src/orchestrator/installation-token", () => ({
  mintInstallationToken,
  revokeInstallationToken,
}));
void mock.module("../../src/orchestrator/repo-knowledge-persistence", () => ({
  persistRepoKnowledge,
}));
void mock.module("../../src/orchestrator/workflow-runner-resources", () => ({
  cleanupCurrentWorkflowRunnerResources,
}));
void mock.module("../../src/orchestrator/workflow-runner-store", () => ({
  findPendingWorkflowRunnerResults: mock(() => Promise.resolve([])),
  getWorkflowRunnerResultProcessingState,
  markWorkflowRunnerResultProcessed,
}));

const { cleanupWorkflowRunnerAttempt, processWorkflowRunnerResult } =
  await import("../../src/orchestrator/workflow-runner-result");

function workflowRow(runId: string): Record<string, unknown> {
  return {
    id: runId,
    attempt_id: null,
    workflow_name: "review",
    target_owner: "acme",
    target_repo: "widgets",
    trigger_comment_id: 42,
    trigger_event_type: "issue_comment",
    target_type: targetTypesByRun.get(runId) ?? "pr",
    target_number: targetNumbersByRun.get(runId) ?? 7,
    parent_run_id: parentIdsByRun.get(runId) ?? null,
    status: statusesByRun.get(runId) ?? "succeeded",
  };
}

function pending(
  runId = crypto.randomUUID(),
  attemptId = crypto.randomUUID(),
): PendingWorkflowRunnerResult {
  const result: PendingWorkflowRunnerResult = {
    runId,
    attemptId,
    executionDeliveryId: crypto.randomUUID(),
    payload: {
      runId,
      attemptId,
      result: {
        status: "succeeded",
        state: { phase: "complete" },
        appliedReviewLearningIds: ["learning-1"],
        daemonActions: {
          learnings: [{ category: "setup", content: "Run isolated tests." }],
          deletions: [],
        },
      },
      durationMs: 123,
    },
  };
  resultStates.set(attemptId, "pending");
  attemptsByRun.set(runId, attemptId);
  return result;
}

function handedOffPending(
  runId = crypto.randomUUID(),
  attemptId = crypto.randomUUID(),
): PendingWorkflowRunnerResult {
  const result: PendingWorkflowRunnerResult = {
    runId,
    attemptId,
    executionDeliveryId: crypto.randomUUID(),
    payload: {
      runId,
      attemptId,
      result: {
        status: "handed-off",
        state: { phase: "child-running" },
        humanMessage: "ship started, first step `triage` queued.",
        childRunId: crypto.randomUUID(),
      },
      durationMs: 123,
    },
  };
  resultStates.set(attemptId, "pending");
  attemptsByRun.set(runId, attemptId);
  statusesByRun.set(runId, "running");
  return result;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForCalls(fn: { mock: { calls: unknown[][] } }, count: number): Promise<void> {
  await waitFor(() => fn.mock.calls.length >= count);
  expect(fn.mock.calls.length).toBe(count);
}

describe("workflow runner result projection", () => {
  beforeEach(() => {
    resultStates.clear();
    attemptsByRun.clear();
    statusesByRun.clear();
    targetNumbersByRun.clear();
    targetTypesByRun.clear();
    parentIdsByRun.clear();
    ensureWorkflowCascadeForOffer.mockReset();
    ensureWorkflowCascadeForOffer.mockImplementation(() => Promise.resolve());
    setState.mockReset();
    setState.mockResolvedValue(undefined);
    persistRepoKnowledge.mockReset();
    persistRepoKnowledge.mockImplementation(() => Promise.resolve());
    addReaction.mockClear();
    findById.mockReset();
    findById.mockImplementation((id: string) =>
      Promise.resolve({
        ...workflowRow(id),
        attempt_id: attemptsByRun.get(id) ?? null,
        status: statusesByRun.get(id) ?? "succeeded",
      }),
    );
    getWorkflowRunnerResultProcessingState.mockClear();
    markWorkflowRunnerResultProcessed.mockClear();
    cleanupCurrentWorkflowRunnerResources.mockClear();
    loggerInfo.mockClear();
    loggerWarn.mockClear();
    mintInstallationToken.mockClear();
    getRepoInstallation.mockClear();
    revokeInstallationToken.mockClear();
  });

  it("serializes concurrent duplicates and makes processed replay a no-op", async () => {
    const result = pending();
    const gate = deferred();
    ensureWorkflowCascadeForOffer.mockImplementation(() => gate.promise);

    const first = processWorkflowRunnerResult(result, {} as never);
    const duplicate = processWorkflowRunnerResult(result, {} as never);
    await waitForCalls(ensureWorkflowCascadeForOffer, 1);
    expect(getWorkflowRunnerResultProcessingState).toHaveBeenCalledTimes(1);

    gate.resolve();
    await Promise.all([first, duplicate]);
    expect(ensureWorkflowCascadeForOffer).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenCalledTimes(1);
    expect(persistRepoKnowledge).toHaveBeenCalledTimes(1);
    expect(addReaction).toHaveBeenCalledTimes(1);
    expect(markWorkflowRunnerResultProcessed).toHaveBeenCalledTimes(1);
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "workflow.run.succeeded",
        runId: result.runId,
        duration_ms: 123,
      }),
      "Workflow run succeeded",
    );

    await processWorkflowRunnerResult(result, {} as never);
    expect(ensureWorkflowCascadeForOffer).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenCalledTimes(1);
    expect(markWorkflowRunnerResultProcessed).toHaveBeenCalledTimes(1);
    expect(loggerInfo).toHaveBeenCalledTimes(1);
    expect(revokeInstallationToken).not.toHaveBeenCalled();
  });

  it("revokes an internally minted projection token after success", async () => {
    const result = pending();

    await processWorkflowRunnerResult(result);

    expect(mintInstallationToken).toHaveBeenCalledTimes(1);
    expect(revokeInstallationToken).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      attemptId: result.attemptId,
      owner: "result-projection",
    });
  });

  it("revokes an internally minted projection token after a retryable failure", async () => {
    const result = pending();
    ensureWorkflowCascadeForOffer.mockRejectedValueOnce(new Error("temporary GitHub failure"));

    await expectToReject(processWorkflowRunnerResult(result), "temporary GitHub failure");

    expect(revokeInstallationToken).toHaveBeenCalledTimes(1);
    expect(resultStates.get(result.attemptId)).toBe("pending");
  });

  it("leaves a failed projection pending for retry", async () => {
    const result = pending();
    ensureWorkflowCascadeForOffer.mockRejectedValueOnce(new Error("temporary GitHub failure"));

    await expectToReject(
      processWorkflowRunnerResult(result, {} as never),
      "temporary GitHub failure",
    );
    expect(resultStates.get(result.attemptId)).toBe("pending");
    expect(markWorkflowRunnerResultProcessed).not.toHaveBeenCalled();

    await processWorkflowRunnerResult(result, {} as never);
    expect(resultStates.get(result.attemptId)).toBe("processed");
    expect(ensureWorkflowCascadeForOffer).toHaveBeenCalledTimes(2);
    expect(markWorkflowRunnerResultProcessed).toHaveBeenCalledTimes(1);
  });

  it("receipts the durable result when best-effort knowledge persistence fails", async () => {
    const result = pending();
    persistRepoKnowledge.mockRejectedValueOnce(new Error("database unavailable"));

    await processWorkflowRunnerResult(result, {} as never);

    expect(resultStates.get(result.attemptId)).toBe("processed");
    expect(ensureWorkflowCascadeForOffer).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenCalledTimes(1);
    expect(markWorkflowRunnerResultProcessed).toHaveBeenCalledTimes(1);
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: result.runId, attemptId: result.attemptId }),
      "Failed to persist workflow runner repo knowledge",
    );
  });

  it("dead-letters a GitHub-rejected detail after a fixed fallback succeeds", async () => {
    const result = pending();
    setState
      .mockRejectedValueOnce(Object.assign(new Error("Validation Failed"), { status: 422 }))
      .mockResolvedValueOnce(undefined);

    await processWorkflowRunnerResult(result, {} as never);

    expect(setState).toHaveBeenCalledTimes(2);
    expect(setState.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        humanMessage:
          "review reached a terminal state, but GitHub rejected its detailed status. Inspect controller logs and durable workflow state.",
      }),
    );
    expect(markWorkflowRunnerResultProcessed).toHaveBeenCalledWith(result.attemptId);
  });

  it("projects incomplete text, a confused reaction, and the incomplete lifecycle event", async () => {
    const result = pending();
    result.payload.result = {
      status: "incomplete",
      reason: "required checks remain",
      state: { outstanding: ["fix CI"] },
      humanMessage: "Required checks remain.",
    };

    await processWorkflowRunnerResult(result, {} as never);

    expect(setState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ humanMessage: "Required checks remain." }),
    );
    expect(addReaction).toHaveBeenCalledWith(expect.objectContaining({ content: "confused" }));
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "workflow.run.incomplete",
        runId: result.runId,
        reason: "required checks remain",
      }),
      "Workflow run incomplete",
    );
    expect(markWorkflowRunnerResultProcessed).toHaveBeenCalledWith(result.attemptId);
  });

  it("keeps a rejected detail pending when the fixed fallback also fails", async () => {
    const result = pending();
    setState
      .mockRejectedValueOnce(Object.assign(new Error("Validation Failed"), { status: 422 }))
      .mockRejectedValueOnce(new Error("fallback unavailable"));

    await expectToReject(processWorkflowRunnerResult(result, {} as never), "fallback unavailable");
    expect(markWorkflowRunnerResultProcessed).not.toHaveBeenCalled();
  });

  it("does not globally serialize different targets", async () => {
    const first = pending();
    const second = pending();
    targetNumbersByRun.set(second.runId, 8);
    const firstGate = deferred();
    const secondGate = deferred();
    ensureWorkflowCascadeForOffer.mockImplementation(() =>
      ensureWorkflowCascadeForOffer.mock.calls.length === 1
        ? firstGate.promise
        : secondGate.promise,
    );

    const firstProcess = processWorkflowRunnerResult(first, {} as never);
    const secondProcess = processWorkflowRunnerResult(second, {} as never);
    await waitForCalls(ensureWorkflowCascadeForOffer, 2);

    firstGate.resolve();
    secondGate.resolve();
    await Promise.all([firstProcess, secondProcess]);
    expect(markWorkflowRunnerResultProcessed).toHaveBeenCalledTimes(2);
  });

  it("does not overwrite a terminal parent with a late hand-off projection", async () => {
    const parent = handedOffPending();
    const child = pending();
    targetTypesByRun.set(parent.runId, "issue");
    targetTypesByRun.set(child.runId, "pr");
    targetNumbersByRun.set(child.runId, 99);
    parentIdsByRun.set(child.runId, parent.runId);
    const childProjection = deferred();
    setState.mockImplementationOnce(() => childProjection.promise);
    ensureWorkflowCascadeForOffer.mockImplementation((attemptId: string) => {
      if (attemptId === child.attemptId) statusesByRun.set(parent.runId, "succeeded");
      return Promise.resolve();
    });

    const processChild = processWorkflowRunnerResult(child, {} as never);
    await waitForCalls(setState, 1);
    const processParent = processWorkflowRunnerResult(parent, {} as never);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ensureWorkflowCascadeForOffer).toHaveBeenCalledTimes(1);
    expect(setState).toHaveBeenCalledTimes(1);

    childProjection.resolve();
    await Promise.all([processChild, processParent]);

    expect(ensureWorkflowCascadeForOffer).toHaveBeenCalledTimes(2);
    expect(setState).toHaveBeenCalledTimes(1);
    expect(markWorkflowRunnerResultProcessed).toHaveBeenCalledTimes(2);
  });

  it("delegates cleanup through the serialized resource boundary", async () => {
    const attempt = { runId: crypto.randomUUID(), attemptId: crypto.randomUUID() };

    await cleanupWorkflowRunnerAttempt(attempt);
    expect(cleanupCurrentWorkflowRunnerResources).toHaveBeenCalledWith(attempt);
  });
});
