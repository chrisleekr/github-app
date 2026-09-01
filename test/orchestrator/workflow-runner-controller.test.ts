import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { WorkflowRunnerClientMessage } from "../../src/shared/workflow-runner-messages";
import { waitFor } from "../utils/assertions";

class TestStaleWorkflowAttemptError extends Error {}
class TestWorkflowRunnerCommandConflictError extends Error {}
class TestWorkflowRunnerOutputRejectedError extends Error {}

const runId = crypto.randomUUID();
const attemptId = crypto.randomUUID();
const executionDeliveryId = crypto.randomUUID();
const runnerId = `workflow-runner:${attemptId}`;
const attempt = {
  runId,
  attemptId,
  executionDeliveryId,
  runnerId,
  workflowName: "review" as const,
  attemptDeadlineAt: new Date("2026-08-23T04:10:00Z"),
};

const getWorkflowRunnerRegistrationState = mock(() =>
  Promise.resolve({
    state: "ready" as const,
    attempt,
    payloadIssuedAt: null,
    tokenExpiresAt: null,
  }),
);
const renewWorkflowAttempts = mock(() =>
  Promise.resolve({ renewedAttemptIds: [attemptId], lostAttemptIds: [] }),
);
const prepareWorkflowRunnerPayload = mock(() =>
  Promise.resolve({
    context: {},
    installationToken: "installation-token",
    installationTokenExpiresAt: "2026-08-23T04:00:00Z",
    attemptDeadlineAt: "2026-08-23T04:10:00Z",
    workflowRun: { runId, workflowName: "review" as const },
  }),
);
const prepareWorkflowRunnerControllerOctokit = mock(() => Promise.resolve({}));
const recordWorkflowRunnerPayloadIssued = mock(() => Promise.resolve(true));
const octokitRequest = mock(() => Promise.resolve());
const revokeInstallationToken = mock((octokit: { request: typeof octokitRequest }) => {
  void octokit.request("DELETE /installation/token");
  return Promise.resolve(true);
});
const revokeInstallationTokenValue = mock(() => {
  void octokitRequest("DELETE /installation/token");
  return Promise.resolve(true);
});
const storeWorkflowRunnerResult = mock(() => Promise.resolve("stored" as const));
const processWorkflowRunnerResult = mock(() => Promise.resolve());
const cleanupWorkflowRunnerAttempt = mock(() => Promise.resolve());
const loggerError = mock(() => undefined);
const assertCurrentWorkflowAttempt = mock(() => Promise.resolve());
const setState = mock(() => Promise.resolve({ tracking_comment_id: null as number | null }));
const commitAttemptHandOffChild = mock(() => Promise.resolve({ id: crypto.randomUUID() }));
const findById = mock(() => Promise.resolve(null as Record<string, unknown> | null));
const recordWorkflowExecution = mock(() => Promise.resolve());
const publishWorkflowRunById = mock(() => Promise.resolve());
const getByName = mock(() => ({ steps: [] as string[] }));
const transactionQuery = mock(() => Promise.resolve([{ delivery_id: executionDeliveryId }]));
const begin = mock(
  (callback: (tx: typeof transactionQuery) => Promise<void>): Promise<void> =>
    callback(transactionQuery),
);
const findWorkflowRunnerCommandReceipt = mock(() =>
  Promise.resolve(
    null as null | {
      commandKind: "set-state" | "hand-off-child";
      request: unknown;
      response: { trackingCommentId?: number; childRunId?: string };
    },
  ),
);
const insertWorkflowRunnerCommandReceipt = mock(() => Promise.resolve());
const sanitizeWorkflowRunnerCommand = mock((command: unknown) => Promise.resolve(command));
const sanitizeWorkflowRunnerResult = mock((payload: unknown) => Promise.resolve(payload));

void mock.module("../../src/config", () => ({
  config: {
    botAppLogin: "test-bot",
    heartbeatIntervalMs: 1_000,
    heartbeatTimeoutMs: 3_000,
  },
}));
void mock.module("../../src/db", () => ({
  requireDb: (): { begin: typeof begin } => ({ begin }),
}));
void mock.module("../../src/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: loggerError,
    debug: mock(() => undefined),
  },
}));
void mock.module("octokit", () => ({
  Octokit: function MockOctokit(this: unknown): unknown {
    return { request: octokitRequest };
  },
}));
void mock.module("../../src/orchestrator/workflow-runner-output", () => ({
  sanitizeWorkflowRunnerCommand,
  sanitizeWorkflowRunnerResult,
  WorkflowRunnerOutputRejectedError: TestWorkflowRunnerOutputRejectedError,
}));
void mock.module("../../src/workflows/execution-row", () => ({
  recordWorkflowExecution,
}));
void mock.module("../../src/workflows/registry", () => ({
  getByName,
}));
void mock.module("../../src/workflows/runs-store", () => ({
  assertCurrentWorkflowAttempt,
  commitAttemptHandOffChild,
  findById,
  renewWorkflowAttempts,
  StaleWorkflowAttemptError: TestStaleWorkflowAttemptError,
}));
void mock.module("../../src/workflows/tracking-mirror", () => ({
  setState,
}));
void mock.module("../../src/workflows/dispatch-outbox", () => ({
  publishWorkflowRunById,
  publishPendingWorkflowRuns: mock(() => Promise.resolve(0)),
}));
void mock.module("../../src/orchestrator/workflow-runner-payload", () => ({
  prepareWorkflowRunnerControllerOctokit,
  prepareWorkflowRunnerPayload,
}));
void mock.module("../../src/orchestrator/installation-token", () => ({
  revokeInstallationToken,
  revokeInstallationTokenValue,
}));
void mock.module("../../src/orchestrator/workflow-runner-result", () => ({
  cleanupWorkflowRunnerAttempt,
  processWorkflowRunnerResult,
}));
void mock.module("../../src/orchestrator/workflow-runner-store", () => ({
  assertMatchingWorkflowRunnerCommand: mock(() => undefined),
  findWorkflowRunnerCommandReceipt,
  getWorkflowRunnerRegistrationState,
  insertWorkflowRunnerCommandReceipt,
  recordWorkflowRunnerPayloadIssued,
  storeWorkflowRunnerResult,
  WorkflowRunnerCommandConflictError: TestWorkflowRunnerCommandConflictError,
}));

const {
  getWorkflowRunnerConnection,
  handleWorkflowRunnerClose,
  handleWorkflowRunnerMessage,
  handleWorkflowRunnerOpen,
  resetWorkflowRunnerControllerForTests,
} = await import("../../src/orchestrator/workflow-runner-controller");

interface CloseCall {
  readonly code: number;
  readonly reason: string;
}

class FakeSocket {
  readonly data = {
    authenticated: true,
    remoteAddr: "127.0.0.1",
    daemonId: undefined,
    sessionId: undefined,
    kind: "workflow-runner" as const,
    runnerRunId: runId,
    runnerAttemptId: attemptId,
    runnerRegistered: false,
  };
  readonly messages: unknown[] = [];
  readonly closes: CloseCall[] = [];
  onSend?: (message: unknown) => void;
  sendTextResult = 1;

  sendText(value: string): number {
    const message = JSON.parse(value) as unknown;
    this.messages.push(message);
    this.onSend?.(message);
    return this.sendTextResult;
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }
}

function mockReadyWithPayloadReceipt(): void {
  getWorkflowRunnerRegistrationState.mockResolvedValueOnce({
    state: "ready",
    attempt,
    payloadIssuedAt: new Date("2026-08-23T03:00:00Z"),
    tokenExpiresAt: new Date("2026-08-23T04:00:00Z"),
  });
}

function registerMessage(needsJob = true): WorkflowRunnerClientMessage {
  return {
    type: "workflow-runner:register",
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    payload: {
      runId,
      attemptId,
      protocolVersion: "1.1.0",
      appVersion: "test",
      needsJob,
    },
  };
}

function resultMessage(): WorkflowRunnerClientMessage {
  return {
    type: "workflow-runner:result",
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    payload: {
      runId,
      attemptId,
      result: { status: "succeeded", state: { phase: "complete" } },
      durationMs: 50,
    },
  };
}

function heartbeatMessage(): Extract<
  WorkflowRunnerClientMessage,
  { type: "workflow-runner:heartbeat" }
> {
  return {
    type: "workflow-runner:heartbeat",
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    payload: { runId, attemptId },
  };
}

function setStateMessage(
  id = crypto.randomUUID(),
): Extract<WorkflowRunnerClientMessage, { type: "workflow-runner:command" }> {
  return {
    type: "workflow-runner:command",
    id,
    timestamp: Date.now(),
    payload: {
      runId,
      attemptId,
      command: {
        type: "set-state",
        patch: { phase: "working" },
        humanMessage: "Still working.",
      },
    },
  };
}

function handOffMessage(
  id = crypto.randomUUID(),
): Extract<WorkflowRunnerClientMessage, { type: "workflow-runner:command" }> {
  return {
    type: "workflow-runner:command",
    id,
    timestamp: Date.now(),
    payload: {
      runId,
      attemptId,
      command: {
        type: "hand-off-child",
        workflowName: "triage",
        target: { type: "pr", owner: "owner", repo: "repo", number: 42 },
        parentStepIndex: 0,
        state: { phase: "triage" },
        humanMessage: "Handing off to triage.",
      },
    },
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  await waitFor(predicate);
  expect(predicate()).toBe(true);
}

async function register(socket: FakeSocket, needsJob = true): Promise<void> {
  handleWorkflowRunnerOpen(socket as never);
  handleWorkflowRunnerMessage(socket as never, registerMessage(needsJob));
  await waitUntil(() =>
    socket.messages.some(
      (message) =>
        (message as { type?: string; payload?: { state?: string } }).type ===
          "workflow-runner:registered" &&
        (message as { payload?: { state?: string } }).payload?.state === "ready",
    ),
  );
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function storedAfter(gate: ReturnType<typeof deferred>): Promise<"stored"> {
  await gate.promise;
  return "stored";
}

function hasMessage(socket: FakeSocket, type: string): boolean {
  return socket.messages.some((message) => (message as { type?: string }).type === type);
}

async function expectRejectedResultPolicyClose(error: Error): Promise<void> {
  resetWorkflowRunnerControllerForTests();
  const socket = new FakeSocket();
  await register(socket);
  storeWorkflowRunnerResult.mockRejectedValueOnce(error);

  handleWorkflowRunnerMessage(socket as never, resultMessage());
  await waitUntil(() => socket.closes.length > 0);
  expect(socket.closes.at(-1)).toEqual({
    code: 1008,
    reason: "workflow runner result rejected",
  });
}

describe("workflow runner controller", () => {
  beforeEach(() => {
    resetWorkflowRunnerControllerForTests();
    getWorkflowRunnerRegistrationState.mockReset();
    getWorkflowRunnerRegistrationState.mockImplementation(() =>
      Promise.resolve({
        state: "ready" as const,
        attempt,
        payloadIssuedAt: null,
        tokenExpiresAt: null,
      }),
    );
    renewWorkflowAttempts.mockReset();
    renewWorkflowAttempts.mockImplementation(() =>
      Promise.resolve({ renewedAttemptIds: [attemptId], lostAttemptIds: [] }),
    );
    prepareWorkflowRunnerPayload.mockClear();
    prepareWorkflowRunnerControllerOctokit.mockClear();
    recordWorkflowRunnerPayloadIssued.mockReset();
    recordWorkflowRunnerPayloadIssued.mockResolvedValue(true);
    octokitRequest.mockClear();
    revokeInstallationToken.mockClear();
    revokeInstallationTokenValue.mockClear();
    storeWorkflowRunnerResult.mockReset();
    storeWorkflowRunnerResult.mockImplementation(() => Promise.resolve("stored" as const));
    processWorkflowRunnerResult.mockReset();
    processWorkflowRunnerResult.mockImplementation(() => Promise.resolve());
    cleanupWorkflowRunnerAttempt.mockClear();
    loggerError.mockClear();
    assertCurrentWorkflowAttempt.mockReset();
    assertCurrentWorkflowAttempt.mockResolvedValue();
    setState.mockReset();
    setState.mockResolvedValue({ tracking_comment_id: null });
    findWorkflowRunnerCommandReceipt.mockReset();
    findWorkflowRunnerCommandReceipt.mockResolvedValue(null);
    insertWorkflowRunnerCommandReceipt.mockReset();
    insertWorkflowRunnerCommandReceipt.mockResolvedValue();
    commitAttemptHandOffChild.mockReset();
    commitAttemptHandOffChild.mockImplementation((_attempt, _state, input) =>
      Promise.resolve({ id: (input as { childRunId: string }).childRunId }),
    );
    findById.mockReset();
    findById.mockResolvedValue(null);
    recordWorkflowExecution.mockReset();
    recordWorkflowExecution.mockResolvedValue();
    publishWorkflowRunById.mockReset();
    publishWorkflowRunById.mockResolvedValue();
    getByName.mockReset();
    getByName.mockReturnValue({ steps: [] });
    transactionQuery.mockReset();
    transactionQuery.mockResolvedValue([{ delivery_id: executionDeliveryId }]);
    begin.mockClear();
    sanitizeWorkflowRunnerCommand.mockReset();
    sanitizeWorkflowRunnerCommand.mockImplementation((command) => Promise.resolve(command));
    sanitizeWorkflowRunnerResult.mockReset();
    sanitizeWorkflowRunnerResult.mockImplementation((payload) => Promise.resolve(payload));
  });

  it("sends ready for the current registration and policy-closes a stale registration", async () => {
    const current = new FakeSocket();
    await register(current);
    expect(getWorkflowRunnerConnection(attemptId)).toBe(current as never);

    resetWorkflowRunnerControllerForTests();
    getWorkflowRunnerRegistrationState.mockResolvedValueOnce({ state: "invalid" });
    prepareWorkflowRunnerPayload.mockClear();
    const stale = new FakeSocket();
    handleWorkflowRunnerOpen(stale as never);
    handleWorkflowRunnerMessage(stale as never, registerMessage());
    await waitUntil(() => stale.closes.length === 1);
    expect(stale.closes).toEqual([{ code: 1008, reason: "stale workflow runner attempt" }]);
    expect(prepareWorkflowRunnerPayload).not.toHaveBeenCalled();
  });

  it("supersedes the old socket on reconnect", async () => {
    const oldSocket = new FakeSocket();
    const newSocket = new FakeSocket();
    await register(oldSocket);
    getWorkflowRunnerRegistrationState.mockResolvedValueOnce({
      state: "ready",
      attempt,
      payloadIssuedAt: new Date("2026-08-23T03:00:00Z"),
      tokenExpiresAt: new Date("2026-08-23T04:00:00Z"),
    });
    await register(newSocket, false);

    expect(oldSocket.closes).toContainEqual({
      code: 4002,
      reason: "superseded by runner reconnect",
    });
    expect(getWorkflowRunnerConnection(attemptId)).toBe(newSocket as never);
    const ready = newSocket.messages.find(
      (message) => (message as { type?: string }).type === "workflow-runner:registered",
    ) as { payload: Record<string, unknown> };
    expect(ready.payload["job"]).toBeUndefined();
    expect(prepareWorkflowRunnerPayload).toHaveBeenCalledTimes(1);
    expect(prepareWorkflowRunnerControllerOctokit).toHaveBeenCalledTimes(1);
  });

  it("does not reissue a runner payload after its durable receipt exists", async () => {
    mockReadyWithPayloadReceipt();
    const socket = new FakeSocket();
    handleWorkflowRunnerOpen(socket as never);

    handleWorkflowRunnerMessage(socket as never, registerMessage(true));
    await waitUntil(() => socket.closes.length === 1);

    expect(socket.closes[0]).toEqual({
      code: 1008,
      reason: "workflow runner payload was already issued",
    });
    expect(prepareWorkflowRunnerPayload).not.toHaveBeenCalled();
    expect(recordWorkflowRunnerPayloadIssued).not.toHaveBeenCalled();
  });

  it("revokes a prepared token when the durable delivery receipt loses the race", async () => {
    recordWorkflowRunnerPayloadIssued.mockResolvedValueOnce(false);
    const socket = new FakeSocket();
    handleWorkflowRunnerOpen(socket as never);

    handleWorkflowRunnerMessage(socket as never, registerMessage(true));
    await waitUntil(() => socket.closes.length === 1);

    expect(socket.closes[0]).toEqual({
      code: 1008,
      reason: "workflow runner payload delivery was rejected",
    });
    expect(octokitRequest).toHaveBeenCalledWith("DELETE /installation/token");
    expect(socket.messages).toHaveLength(0);
  });

  it("revokes and never reissues a prepared token when the post-payload renewal loses the lease", async () => {
    renewWorkflowAttempts
      .mockResolvedValueOnce({ renewedAttemptIds: [attemptId], lostAttemptIds: [] })
      .mockResolvedValueOnce({ renewedAttemptIds: [], lostAttemptIds: [attemptId] });
    const socket = new FakeSocket();
    handleWorkflowRunnerOpen(socket as never);

    handleWorkflowRunnerMessage(socket as never, registerMessage(true));
    await waitUntil(() => socket.closes.length === 1);

    expect(socket.closes[0]).toEqual({
      code: 1008,
      reason: "workflow runner lease expired during payload preparation",
    });
    expect(octokitRequest).toHaveBeenCalledWith("DELETE /installation/token");
    expect(getWorkflowRunnerConnection(attemptId)).toBeUndefined();
    expect(socket.data.runnerRegistered).toBe(false);

    mockReadyWithPayloadReceipt();
    const retry = new FakeSocket();
    handleWorkflowRunnerOpen(retry as never);
    handleWorkflowRunnerMessage(retry as never, registerMessage(true));
    await waitUntil(() => retry.closes.length === 1);
    expect(prepareWorkflowRunnerPayload).toHaveBeenCalledTimes(1);
  });

  it("revokes a prepared token when post-payload renewal throws", async () => {
    renewWorkflowAttempts
      .mockResolvedValueOnce({ renewedAttemptIds: [attemptId], lostAttemptIds: [] })
      .mockRejectedValueOnce(new Error("database unavailable"));
    const socket = new FakeSocket();
    handleWorkflowRunnerOpen(socket as never);

    handleWorkflowRunnerMessage(socket as never, registerMessage(true));
    await waitUntil(() => socket.closes.length === 1);

    expect(socket.closes[0]).toEqual({
      code: 1011,
      reason: "workflow runner registration failed",
    });
    expect(revokeInstallationTokenValue).toHaveBeenCalledTimes(1);
    expect(octokitRequest).toHaveBeenCalledWith("DELETE /installation/token");
    expect(getWorkflowRunnerConnection(attemptId)).toBeUndefined();
  });

  it("revokes and never reissues a prepared token when the registered frame cannot be sent", async () => {
    const socket = new FakeSocket();
    socket.sendTextResult = 0;
    handleWorkflowRunnerOpen(socket as never);

    handleWorkflowRunnerMessage(socket as never, registerMessage(true));
    await waitUntil(() => octokitRequest.mock.calls.length === 1);

    expect(socket.closes).toContainEqual({
      code: 1011,
      reason: "workflow runner control frame delivery failed",
    });
    expect(octokitRequest).toHaveBeenCalledWith("DELETE /installation/token");
    expect(getWorkflowRunnerConnection(attemptId)).toBeUndefined();
    expect(socket.data.runnerRegistered).toBe(false);

    mockReadyWithPayloadReceipt();
    const retry = new FakeSocket();
    handleWorkflowRunnerOpen(retry as never);
    handleWorkflowRunnerMessage(retry as never, registerMessage(true));
    await waitUntil(() => retry.closes.length === 1);
    expect(prepareWorkflowRunnerPayload).toHaveBeenCalledTimes(1);
  });

  it("renews an exact heartbeat and policy-closes a lost lease", async () => {
    const socket = new FakeSocket();
    await register(socket);
    renewWorkflowAttempts.mockClear();

    handleWorkflowRunnerMessage(socket as never, heartbeatMessage());
    await waitUntil(() => hasMessage(socket, "workflow-runner:heartbeat-ack"));
    expect(renewWorkflowAttempts).toHaveBeenCalledWith(runnerId, [attemptId], 6_000);

    renewWorkflowAttempts.mockResolvedValueOnce({
      renewedAttemptIds: [],
      lostAttemptIds: [attemptId],
    });
    handleWorkflowRunnerMessage(socket as never, heartbeatMessage());
    await waitUntil(() => socket.closes.length > 0);
    expect(socket.closes.at(-1)).toEqual({
      code: 1008,
      reason: "workflow runner attempt fenced",
    });
  });

  it("fences, applies, and receipts a state command before replying, then replays it", async () => {
    const socket = new FakeSocket();
    await register(socket);
    const events: string[] = [];
    assertCurrentWorkflowAttempt.mockImplementationOnce(() => {
      events.push("fence");
      return Promise.resolve();
    });
    setState.mockImplementationOnce(() => {
      events.push("effect");
      return Promise.resolve({ tracking_comment_id: 42 });
    });
    insertWorkflowRunnerCommandReceipt.mockImplementationOnce(() => {
      events.push("receipt");
      return Promise.resolve();
    });
    socket.onSend = (message): void => {
      if ((message as { type?: string }).type === "workflow-runner:command-result") {
        events.push("reply");
      }
    };
    const message = setStateMessage();

    handleWorkflowRunnerMessage(socket as never, message);
    await waitUntil(() => events.includes("reply"));
    expect(events).toEqual(["fence", "effect", "receipt", "reply"]);
    expect(setState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId,
        patch: { phase: "working" },
        humanMessage: "Still working.",
        attempt: { runId, attemptId },
      }),
    );

    findWorkflowRunnerCommandReceipt.mockResolvedValueOnce({
      commandKind: "set-state",
      request: message.payload.command,
      response: { trackingCommentId: 42 },
    });
    handleWorkflowRunnerMessage(socket as never, message);
    await waitUntil(
      () =>
        socket.messages.filter(
          (entry) => (entry as { type?: string }).type === "workflow-runner:command-result",
        ).length === 2,
    );
    expect(setState).toHaveBeenCalledTimes(1);
    expect(insertWorkflowRunnerCommandReceipt).toHaveBeenCalledTimes(1);
  });

  it("commits and processes a hand-off before replying without projecting early state", async () => {
    const shipAttempt = { ...attempt, workflowName: "ship" as const };
    getWorkflowRunnerRegistrationState.mockResolvedValueOnce({
      state: "ready" as const,
      attempt: shipAttempt,
      payloadIssuedAt: null,
      tokenExpiresAt: null,
    });
    const socket = new FakeSocket();
    await register(socket);

    const message = handOffMessage();
    const resultPayload = {
      runId,
      attemptId,
      result: {
        status: "handed-off" as const,
        state: { phase: "triage", handedOffTo: message.id },
        humanMessage: "Handing off to triage.",
        childRunId: message.id,
      },
      durationMs: 0,
    };
    const events: string[] = [];
    assertCurrentWorkflowAttempt.mockImplementationOnce(() => {
      events.push("fence");
      return Promise.resolve();
    });
    getByName.mockReturnValue({ steps: ["triage"] });
    findById.mockResolvedValue({
      workflow_name: "ship",
      attempt_id: attemptId,
      target_type: "pr",
      target_owner: "owner",
      target_repo: "repo",
      target_number: 42,
    });
    commitAttemptHandOffChild.mockImplementationOnce(() => {
      events.push("commit-child");
      return Promise.resolve({ id: message.id });
    });
    recordWorkflowExecution.mockImplementationOnce(() => {
      events.push("commit-execution");
      return Promise.resolve();
    });
    transactionQuery.mockImplementationOnce(() => {
      events.push("commit-parent-result");
      return Promise.resolve([{ delivery_id: executionDeliveryId }]);
    });
    insertWorkflowRunnerCommandReceipt.mockImplementationOnce(() => {
      events.push("commit-receipt");
      return Promise.resolve();
    });
    publishWorkflowRunById.mockImplementationOnce(() => {
      events.push("publish-child");
      return Promise.resolve();
    });
    getWorkflowRunnerRegistrationState.mockResolvedValueOnce({
      state: "result-pending" as const,
      executionDeliveryId,
      payload: resultPayload,
    });
    processWorkflowRunnerResult.mockImplementationOnce(() => {
      events.push("process-parent-result");
      return Promise.resolve();
    });
    socket.onSend = (sent): void => {
      if ((sent as { type?: string }).type === "workflow-runner:command-result") {
        events.push("reply");
      }
    };

    handleWorkflowRunnerMessage(socket as never, message);
    await waitUntil(() => events.includes("reply"));

    expect(events).toEqual([
      "fence",
      "commit-child",
      "commit-execution",
      "commit-parent-result",
      "commit-receipt",
      "publish-child",
      "process-parent-result",
      "reply",
    ]);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(setState).not.toHaveBeenCalled();
    expect(processWorkflowRunnerResult).toHaveBeenCalledWith({
      runId,
      attemptId,
      executionDeliveryId,
      payload: resultPayload,
    });
  });

  it("waits for an in-flight command before revoking a reconnect-only token", async () => {
    mockReadyWithPayloadReceipt();
    prepareWorkflowRunnerControllerOctokit.mockResolvedValueOnce({
      request: octokitRequest,
    } as never);
    const socket = new FakeSocket();
    await register(socket, false);
    const command = deferred();
    setState.mockImplementationOnce(async () => {
      await command.promise;
      return { tracking_comment_id: null };
    });

    handleWorkflowRunnerMessage(socket as never, setStateMessage());
    await waitUntil(() => setState.mock.calls.length === 1);
    handleWorkflowRunnerClose(socket as never);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(revokeInstallationToken).not.toHaveBeenCalled();

    command.resolve();
    await waitUntil(() => revokeInstallationToken.mock.calls.length === 1);
    expect(octokitRequest).toHaveBeenCalledWith("DELETE /installation/token");
  });

  it("does not let an old in-flight result evict a reconnected session", async () => {
    const oldSocket = new FakeSocket();
    await register(oldSocket);
    const stored = deferred();
    storeWorkflowRunnerResult.mockImplementationOnce(() => storedAfter(stored));

    handleWorkflowRunnerMessage(oldSocket as never, resultMessage());
    await waitUntil(() => storeWorkflowRunnerResult.mock.calls.length === 1);

    const newSocket = new FakeSocket();
    await register(newSocket);
    expect(getWorkflowRunnerConnection(attemptId)).toBe(newSocket as never);

    stored.resolve();
    await waitUntil(() => hasMessage(oldSocket, "workflow-runner:result-ack"));
    expect(getWorkflowRunnerConnection(attemptId)).toBe(newSocket as never);
  });

  it("policy-closes stale and conflicting results with a fixed reason", async () => {
    await expectRejectedResultPolicyClose(new TestStaleWorkflowAttemptError("stale detail"));
    await expectRejectedResultPolicyClose(
      new TestWorkflowRunnerCommandConflictError("conflicting detail"),
    );
  });

  it("keeps unexpected projection failures retryable", async () => {
    const socket = new FakeSocket();
    await register(socket);
    processWorkflowRunnerResult.mockRejectedValueOnce(new Error("temporary API failure"));

    handleWorkflowRunnerMessage(socket as never, resultMessage());
    await waitUntil(() => loggerError.mock.calls.length === 1);
    expect(socket.closes.some((call) => call.code === 1008)).toBe(false);
    expect(
      socket.messages.some(
        (message) => (message as { type?: string }).type === "workflow-runner:result-ack",
      ),
    ).toBe(false);
    expect(getWorkflowRunnerConnection(attemptId)).toBe(socket as never);
  });

  it("stores and processes a result before acknowledging it", async () => {
    const events: string[] = [];
    const socket = new FakeSocket();
    socket.onSend = (message): void => {
      if ((message as { type?: string }).type === "workflow-runner:result-ack") events.push("ack");
    };
    storeWorkflowRunnerResult.mockImplementationOnce(() => {
      events.push("store");
      return Promise.resolve("stored");
    });
    processWorkflowRunnerResult.mockImplementationOnce(() => {
      events.push("process");
      return Promise.resolve();
    });
    await register(socket);

    handleWorkflowRunnerMessage(socket as never, resultMessage());
    await waitUntil(() => events.includes("ack"));
    expect(events).toEqual(["store", "process", "ack"]);
    expect(processWorkflowRunnerResult.mock.calls[0]).toHaveLength(1);
  });

  it("serializes a result behind an earlier command for the same attempt", async () => {
    const socket = new FakeSocket();
    await register(socket);
    const command = deferred();
    setState.mockImplementationOnce(async () => {
      await command.promise;
      return { tracking_comment_id: null };
    });

    handleWorkflowRunnerMessage(socket as never, setStateMessage());
    await waitUntil(() => setState.mock.calls.length === 1);
    handleWorkflowRunnerMessage(socket as never, resultMessage());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(storeWorkflowRunnerResult).not.toHaveBeenCalled();

    command.resolve();
    await waitUntil(() => hasMessage(socket, "workflow-runner:result-ack"));
    expect(storeWorkflowRunnerResult).toHaveBeenCalledTimes(1);
  });

  it("acknowledges the first stored result without rescanning replay bytes", async () => {
    const socket = new FakeSocket();
    await register(socket);
    const storedPayload = resultMessage().payload;
    getWorkflowRunnerRegistrationState.mockResolvedValueOnce({
      state: "result-pending",
      executionDeliveryId,
      payload: storedPayload,
    });
    const replay = resultMessage();
    replay.payload.result = { status: "failed", reason: "different replay bytes" };

    handleWorkflowRunnerMessage(socket as never, replay);
    await waitUntil(() => hasMessage(socket, "workflow-runner:result-ack"));

    expect(sanitizeWorkflowRunnerResult).not.toHaveBeenCalled();
    expect(storeWorkflowRunnerResult).not.toHaveBeenCalled();
    expect(processWorkflowRunnerResult).toHaveBeenCalledWith({
      runId,
      attemptId,
      executionDeliveryId,
      payload: storedPayload,
    });
  });

  it("maps command sanitation rejection before any receipt or effect", async () => {
    const socket = new FakeSocket();
    await register(socket);
    const message = setStateMessage();
    sanitizeWorkflowRunnerCommand.mockRejectedValueOnce(
      new TestWorkflowRunnerOutputRejectedError("credential-bearing command"),
    );

    handleWorkflowRunnerMessage(socket as never, message);
    await waitUntil(() =>
      socket.messages.some(
        (entry) =>
          (entry as { type?: string; payload?: { code?: string } }).type ===
            "workflow-runner:command-result" &&
          (entry as { payload?: { code?: string } }).payload?.code === "INVALID_COMMAND",
      ),
    );

    expect(sanitizeWorkflowRunnerCommand).toHaveBeenCalledWith(message.payload.command);
    expect(findWorkflowRunnerCommandReceipt).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalled();
    expect(commitAttemptHandOffChild).not.toHaveBeenCalled();
    expect(insertWorkflowRunnerCommandReceipt).not.toHaveBeenCalled();
  });

  it("stores the sanitized result rather than the raw wire payload", async () => {
    const socket = new FakeSocket();
    await register(socket);
    const raw = resultMessage();
    const safe = {
      ...raw.payload,
      result: {
        status: "failed" as const,
        reason: "workflow runner output was rejected by credential policy",
        humanMessage: "Workflow output was rejected by the credential safety boundary.",
      },
    };
    sanitizeWorkflowRunnerResult.mockResolvedValueOnce(safe);

    handleWorkflowRunnerMessage(socket as never, raw);
    await waitUntil(() => hasMessage(socket, "workflow-runner:result-ack"));

    expect(sanitizeWorkflowRunnerResult).toHaveBeenCalledTimes(1);
    expect(sanitizeWorkflowRunnerResult).toHaveBeenCalledWith(raw.payload);
    expect(storeWorkflowRunnerResult).toHaveBeenCalledWith(safe);
    expect(processWorkflowRunnerResult).toHaveBeenCalledWith({
      runId,
      attemptId,
      executionDeliveryId,
      payload: safe,
    });
  });
});
