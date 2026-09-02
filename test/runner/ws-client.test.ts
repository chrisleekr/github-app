import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";

import { expectToReject } from "../utils/assertions";

void mock.module("../../src/logger", () => ({
  logger: {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  },
}));

class StaleWorkflowAttemptError extends Error {}
void mock.module("../../src/workflows/runs-store", () => ({ StaleWorkflowAttemptError }));

const { WORKFLOW_RUNNER_MESSAGE_MAX_BYTES } =
  await import("../../src/shared/workflow-runner-messages");
const { WorkflowRunnerClient } = await import("../../src/runner/ws-client");

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly sent: string[] = [];

  constructor(
    public readonly url: string,
    public readonly options?: { headers?: Record<string, string> },
  ) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  fireOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({} as Event);
  }

  fireMessage(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }

  fireClose(code = 1006, reason = "abnormal closure"): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: false } as unknown as CloseEvent);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

const runId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";

function makeClient(): InstanceType<typeof WorkflowRunnerClient> {
  return new WorkflowRunnerClient({
    url: `ws://controller/ws/workflow-runner/${runId}/${attemptId}`,
    token: "test-token",
    runId,
    attemptId,
  });
}

function readyMessage(clientFenceMs = 25, heartbeatIntervalMs = 10, includeJob = true): unknown {
  return {
    type: "workflow-runner:registered",
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    payload: {
      state: "ready",
      heartbeatIntervalMs,
      clientFenceMs,
      dbLeaseMs: clientFenceMs * 2,
      ...(includeJob
        ? {
            job: {
              context: {
                owner: "acme",
                repo: "widgets",
                entityNumber: 16,
                isPR: true,
                deliveryId: "delivery-16",
              },
              installationToken: "installation-token",
              installationTokenExpiresAt: "2026-08-23T04:00:00Z",
              attemptDeadlineAt: "2026-08-23T04:10:00Z",
              workflowRun: { runId, workflowName: "implement" },
            },
          }
        : {}),
    },
  };
}

function sentMessage(
  socket: FakeWebSocket,
  type: string,
): { type: string; id: string; payload: Record<string, unknown> } {
  const message = socket.sent
    .map((raw) => JSON.parse(raw) as { type: string; id: string; payload: Record<string, unknown> })
    .find((candidate) => candidate.type === type);
  if (message === undefined) throw new Error(`Expected ${type} message`);
  return message;
}

describe("WorkflowRunnerClient attempt fence", () => {
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    jest.useRealTimers();
    (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
  });

  it("keeps the acknowledged fence armed while reconnecting", async () => {
    jest.useFakeTimers();
    const client = makeClient();
    client.connect();
    const socket = FakeWebSocket.instances[0];
    if (socket === undefined) throw new Error("Expected workflow runner socket");
    socket.fireOpen();
    expect(sentMessage(socket, "workflow-runner:register").payload["capabilities"]).toBeUndefined();
    expect(sentMessage(socket, "workflow-runner:register").payload["needsJob"]).toBe(true);
    socket.fireMessage(readyMessage());
    await client.waitForJob();

    socket.fireClose();
    jest.advanceTimersByTime(24);
    expect(client.signal.aborted).toBe(false);
    jest.advanceTimersByTime(1);
    expect(client.signal.aborted).toBe(true);

    client.close();
  });

  it("fails closed when the initial registration omits the job payload", async () => {
    const client = makeClient();
    client.connect();
    const socket = FakeWebSocket.instances[0];
    if (socket === undefined) throw new Error("Expected workflow runner socket");
    socket.fireOpen();

    socket.fireMessage(readyMessage(2_500, 500, false));

    expect(await client.waitForJob()).toBeNull();
    expect(client.signal.aborted).toBe(true);
  });

  it("replays stable command and result messages after reconnecting before the fence", async () => {
    jest.useFakeTimers();
    const client = makeClient();
    client.connect();
    const first = FakeWebSocket.instances[0];
    if (first === undefined) throw new Error("Expected first workflow runner socket");
    first.fireOpen();
    first.fireMessage(readyMessage(2_500, 500));
    await client.waitForJob();

    const commandPromise = client.command({
      type: "set-state",
      patch: { phase: "implementing" },
      humanMessage: "Implementing.",
    });
    const originalCommand = sentMessage(first, "workflow-runner:command");
    first.fireClose();
    jest.advanceTimersByTime(1_000);

    const second = FakeWebSocket.instances[1];
    if (second === undefined) throw new Error("Expected reconnected workflow runner socket");
    second.fireOpen();
    expect(sentMessage(second, "workflow-runner:register").payload["needsJob"]).toBe(false);
    second.fireMessage(readyMessage(2_500, 500, false));
    const replayedCommand = sentMessage(second, "workflow-runner:command");
    expect(replayedCommand).toEqual(originalCommand);
    jest.advanceTimersByTime(1_600);
    expect(client.signal.aborted).toBe(false);
    second.fireMessage({
      type: "workflow-runner:heartbeat-ack",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: { renewed: true },
    });
    second.fireMessage({
      type: "workflow-runner:command-result",
      id: originalCommand.id,
      timestamp: Date.now(),
      payload: { ok: true, result: { trackingCommentId: 42 } },
    });
    expect(await commandPromise).toEqual({ trackingCommentId: 42 });

    const resultPromise = client.sendResultUntilAck({
      runId,
      attemptId,
      result: { status: "succeeded", state: { phase: "done" } },
      durationMs: 1_000,
    });
    const originalResult = sentMessage(second, "workflow-runner:result");
    second.fireClose();
    jest.advanceTimersByTime(1_000);

    const third = FakeWebSocket.instances[2];
    if (third === undefined) throw new Error("Expected second reconnected workflow runner socket");
    third.fireOpen();
    expect(sentMessage(third, "workflow-runner:register").payload["needsJob"]).toBe(false);
    third.fireMessage(readyMessage(2_500, 500, false));
    const replayedResult = sentMessage(third, "workflow-runner:result");
    expect(replayedResult).toEqual(originalResult);
    third.fireMessage({
      type: "workflow-runner:result-ack",
      id: attemptId,
      timestamp: Date.now(),
      payload: {},
    });
    await resultPromise;
    expect(client.signal.aborted).toBe(false);

    client.close();
  });

  it("rejects exact provider and repository credentials before transport", async () => {
    const client = makeClient();
    const secret = "opaque-provider-credential";
    client.addSensitiveValue(secret);
    client.connect();
    const socket = FakeWebSocket.instances[0];
    if (socket === undefined) throw new Error("Expected workflow runner socket");
    socket.fireOpen();
    socket.fireMessage(readyMessage(2_500, 500));
    await client.waitForJob();

    await expectToReject(
      client.command({
        type: "set-state",
        patch: { report: `before ${secret} after` },
        humanMessage: `safe ${secret} text`,
      }),
      "credential policy",
    );

    const resultPromise = client.sendResultUntilAck({
      runId,
      attemptId,
      result: {
        status: "succeeded",
        state: { report: secret },
        humanMessage: `done ${secret}`,
      },
      durationMs: 1,
    });
    const result = sentMessage(socket, "workflow-runner:result");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.payload).toMatchObject({
      result: {
        status: "failed",
        reason: "workflow runner output was rejected by credential policy",
      },
    });
    socket.fireMessage({
      type: "workflow-runner:result-ack",
      id: attemptId,
      timestamp: Date.now(),
      payload: {},
    });
    await resultPromise;
    client.close();
  });

  it("rejects credential-bearing property names before transport", async () => {
    const client = makeClient();
    const secret = "opaque-provider-credential";
    client.addSensitiveValue(secret);
    client.connect();
    const socket = FakeWebSocket.instances[0];
    if (socket === undefined) throw new Error("Expected workflow runner socket");
    socket.fireOpen();
    socket.fireMessage(readyMessage(2_500, 500));
    await client.waitForJob();

    await expectToReject(
      client.command({
        type: "set-state",
        patch: { nested: { [`credential-${secret}`]: "value" } },
        humanMessage: "Updating state.",
      }),
      "Workflow runner command was rejected by credential policy",
    );
    expect(
      socket.sent.some(
        (raw) => (JSON.parse(raw) as { type?: unknown }).type === "workflow-runner:command",
      ),
    ).toBe(false);

    const resultPromise = client.sendResultUntilAck({
      runId,
      attemptId,
      result: {
        status: "succeeded",
        state: { nested: { [`credential-${secret}`]: "value" } },
      },
      durationMs: 1,
    });
    const result = sentMessage(socket, "workflow-runner:result");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.payload).toMatchObject({
      result: {
        status: "failed",
        reason: "workflow runner output was rejected by credential policy",
      },
    });
    socket.fireMessage({
      type: "workflow-runner:result-ack",
      id: attemptId,
      timestamp: Date.now(),
      payload: {},
    });
    await resultPromise;
    client.close();
  });

  it("bounds command and terminal result payloads before transport", async () => {
    const client = makeClient();
    client.connect();
    const socket = FakeWebSocket.instances[0];
    if (socket === undefined) throw new Error("Expected workflow runner socket");
    socket.fireOpen();
    socket.fireMessage(readyMessage(2_500, 500));
    await client.waitForJob();
    const oversized = "x".repeat(WORKFLOW_RUNNER_MESSAGE_MAX_BYTES + 1);

    await expectToReject(
      client.command({
        type: "set-state",
        patch: { report: oversized },
        humanMessage: "Updating state.",
      }),
      "Workflow runner command was rejected by credential policy",
    );
    expect(
      socket.sent.some(
        (raw) => (JSON.parse(raw) as { type?: unknown }).type === "workflow-runner:command",
      ),
    ).toBe(false);

    const resultPromise = client.sendResultUntilAck({
      runId,
      attemptId,
      result: { status: "succeeded", state: { report: oversized } },
      durationMs: 1,
    });
    const result = sentMessage(socket, "workflow-runner:result");
    expect(Buffer.byteLength(JSON.stringify(result.payload), "utf8")).toBeLessThanOrEqual(
      WORKFLOW_RUNNER_MESSAGE_MAX_BYTES,
    );
    expect(result.payload).toMatchObject({
      result: {
        status: "failed",
        reason: "workflow runner output was rejected by credential policy",
      },
    });
    socket.fireMessage({
      type: "workflow-runner:result-ack",
      id: attemptId,
      timestamp: Date.now(),
      payload: {},
    });
    await resultPromise;
    client.close();
  });

  it("treats a policy close before registration as permanent", async () => {
    jest.useFakeTimers();
    const client = makeClient();
    client.connect();
    const socket = FakeWebSocket.instances[0];
    if (socket === undefined) throw new Error("Expected workflow runner socket");
    socket.fireOpen();

    socket.fireClose(1008, "stale workflow runner attempt");

    expect(await client.waitForJob()).toBeNull();
    expect(client.signal.aborted).toBe(true);
    jest.advanceTimersByTime(30_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("rejects pending callers and stops activity on a permanent abort", async () => {
    jest.useFakeTimers();
    const client = makeClient();
    client.connect();
    const socket = FakeWebSocket.instances[0];
    if (socket === undefined) throw new Error("Expected workflow runner socket");
    socket.fireOpen();
    socket.fireMessage(readyMessage(2_500, 500));
    await client.waitForJob();

    const commandPromise = client.command({
      type: "set-state",
      patch: { phase: "implementing" },
      humanMessage: "Implementing.",
    });
    const resultPromise = client.sendResultUntilAck({
      runId,
      attemptId,
      result: { status: "succeeded", state: { phase: "done" } },
      durationMs: 1_000,
    });
    const sentBeforeAbort = socket.sent.length;

    client.cancel(new Error("workflow attempt fenced"));

    await expectToReject(commandPromise, "workflow attempt fenced");
    await expectToReject(resultPromise, "workflow attempt fenced");
    await expectToReject(
      client.command({ type: "set-state", patch: {}, humanMessage: "Too late." }),
      "workflow attempt fenced",
    );
    jest.advanceTimersByTime(30_000);
    expect(socket.sent).toHaveLength(sentBeforeAbort);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
