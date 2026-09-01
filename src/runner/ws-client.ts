import { logger } from "../logger";
import {
  WORKFLOW_RUNNER_PROTOCOL_VERSION,
  type WorkflowRunnerCommand,
  WorkflowRunnerCommandSchema,
  type WorkflowRunnerPayload,
  type WorkflowRunnerResultPayload,
  WorkflowRunnerResultPayloadSchema,
  type WorkflowRunnerServerMessage,
  workflowRunnerServerMessageSchema,
} from "../shared/workflow-runner-messages";
import { createMessageEnvelope } from "../shared/ws-messages";
import { StaleWorkflowAttemptError } from "../workflows/runs-store";
import {
  configuredCredentialValues,
  containsExactCredentialPropertyName,
  containsExactCredentialValue,
  redactExactValues,
} from "./output-sanitizer";

const APP_VERSION: string = ((): string => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- package metadata is synchronous
    return (require("../../package.json") as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();

interface PendingCommand {
  readonly message: {
    readonly type: "workflow-runner:command";
    readonly id: string;
    readonly timestamp: number;
    readonly payload: {
      readonly runId: string;
      readonly attemptId: string;
      readonly command: WorkflowRunnerCommand;
    };
  };
  readonly resolve: (value: { trackingCommentId?: number; childRunId?: string }) => void;
  readonly reject: (reason: Error) => void;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

interface PendingResult {
  readonly message: {
    readonly type: "workflow-runner:result";
    readonly id: string;
    readonly timestamp: number;
    readonly payload: WorkflowRunnerResultPayload;
  };
  readonly resolve: () => void;
  readonly reject: (reason: Error) => void;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

export interface WorkflowRunnerClientOptions {
  readonly url: string;
  readonly token: string;
  readonly runId: string;
  readonly attemptId: string;
}

export class WorkflowRunnerClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private registered = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectMs = 1_000;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private fenceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryMs = 1_000;
  private clientFenceMs = 30_000;
  private jobSettled = false;
  private readonly pendingCommands = new Map<string, PendingCommand>();
  private pendingResult: PendingResult | null = null;
  private readonly abortController = new AbortController();
  private readonly sensitiveValues = new Set(configuredCredentialValues());
  private readonly jobPromise: Promise<WorkflowRunnerPayload | null>;
  private resolveJob: (job: WorkflowRunnerPayload | null) => void = () => undefined;

  constructor(private readonly options: WorkflowRunnerClientOptions) {
    this.addSensitiveValue(options.token);
    this.jobPromise = new Promise((resolve) => {
      this.resolveJob = resolve;
    });
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get attemptId(): string {
    return this.options.attemptId;
  }

  addSensitiveValue(value: string): void {
    if (value.length >= 8) this.sensitiveValues.add(value);
  }

  connect(): void {
    if (this.closed) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.options.url, {
        headers: { Authorization: `Bearer ${this.options.token}` },
      });
    } catch (err) {
      logger.warn({ err }, "Workflow runner connection creation failed");
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;
    socket.onopen = (): void => {
      if (this.ws !== socket) return;
      this.registered = false;
      this.reconnectMs = 1_000;
      this.send({
        type: "workflow-runner:register",
        ...createMessageEnvelope(),
        payload: {
          runId: this.options.runId,
          attemptId: this.options.attemptId,
          protocolVersion: WORKFLOW_RUNNER_PROTOCOL_VERSION,
          appVersion: APP_VERSION,
          needsJob: !this.jobSettled,
        },
      });
    };
    socket.onmessage = (event: MessageEvent): void => {
      if (this.ws !== socket) return;
      this.handleRawMessage(typeof event.data === "string" ? event.data : String(event.data));
    };
    socket.onerror = (): void => {
      logger.warn({ attemptId: this.options.attemptId }, "Workflow runner WebSocket error");
    };
    socket.onclose = (event: CloseEvent): void => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.registered = false;
      this.stopHeartbeatSender();
      if (event.code === 1008) {
        this.abort(new Error(`Workflow runner connection rejected: ${event.reason}`));
      } else if (!this.closed) {
        this.scheduleReconnect();
      }
    };
  }

  waitForJob(): Promise<WorkflowRunnerPayload | null> {
    return this.jobPromise;
  }

  command(
    command: WorkflowRunnerCommand,
  ): Promise<{ trackingCommentId?: number; childRunId?: string }> {
    const unavailable = this.unavailableReason();
    if (unavailable !== null) return Promise.reject(unavailable);
    const sensitiveValues = [...this.sensitiveValues];
    if (
      containsExactCredentialPropertyName(command, sensitiveValues) ||
      containsExactCredentialValue(command, sensitiveValues)
    ) {
      return Promise.reject(new Error("Workflow runner command was rejected by credential policy"));
    }
    const parsed = WorkflowRunnerCommandSchema.safeParse(
      redactExactValues(command, sensitiveValues),
    );
    if (!parsed.success) {
      return Promise.reject(new Error("Workflow runner command was rejected by credential policy"));
    }
    const commandId = crypto.randomUUID();
    const message = {
      type: "workflow-runner:command" as const,
      ...createMessageEnvelope(commandId),
      payload: {
        runId: this.options.runId,
        attemptId: this.options.attemptId,
        command: parsed.data,
      },
    };
    return new Promise((resolve, reject) => {
      const pending: PendingCommand = { message, resolve, reject, retryTimer: null };
      this.pendingCommands.set(commandId, pending);
      this.sendIfReady(message);
    });
  }

  sendResultUntilAck(payload: WorkflowRunnerResultPayload): Promise<void> {
    const unavailable = this.unavailableReason();
    if (unavailable !== null) return Promise.reject(unavailable);
    if (this.pendingResult !== null) {
      throw new Error("Workflow runner already has a pending terminal result");
    }
    const sensitiveValues = [...this.sensitiveValues];
    const parsed =
      containsExactCredentialPropertyName(payload, sensitiveValues) ||
      containsExactCredentialValue(payload, sensitiveValues)
        ? { success: false as const }
        : WorkflowRunnerResultPayloadSchema.safeParse(redactExactValues(payload, sensitiveValues));
    const sanitizedPayload: WorkflowRunnerResultPayload = parsed.success
      ? parsed.data
      : {
          runId: payload.runId,
          attemptId: payload.attemptId,
          durationMs: payload.durationMs,
          result: {
            status: "failed",
            reason: "workflow runner output was rejected by credential policy",
            humanMessage: "Workflow output was rejected by the credential safety boundary.",
          },
        };
    const message = {
      type: "workflow-runner:result" as const,
      ...createMessageEnvelope(payload.attemptId),
      payload: sanitizedPayload,
    };
    return new Promise((resolve, reject) => {
      this.pendingResult = { message, resolve, reject, retryTimer: null };
      this.sendIfReady(message);
      this.armResultRetry();
    });
  }

  close(): void {
    if (this.closed) return;
    const reason = new Error("Workflow runner client closed");
    this.closed = true;
    this.stopActivity();
    this.settleJob(null);
    this.rejectPending(reason);
    const socket = this.ws;
    this.ws = null;
    socket?.close(1000, "workflow runner complete");
  }

  cancel(reason: Error): void {
    this.abort(reason);
  }

  private handleRawMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.abort(new Error("Workflow runner received invalid JSON"));
      return;
    }
    const result = workflowRunnerServerMessageSchema.safeParse(parsed);
    if (!result.success) {
      this.abort(new Error("Workflow runner received a schema-invalid message"));
      return;
    }
    this.handleMessage(result.data);
  }

  private handleMessage(message: WorkflowRunnerServerMessage): void {
    switch (message.type) {
      case "workflow-runner:registered":
        this.handleRegistered(message);
        break;
      case "workflow-runner:heartbeat-ack":
        if (!message.payload.renewed) {
          this.abort(new StaleWorkflowAttemptError(this.options));
        } else {
          this.armFence();
        }
        break;
      case "workflow-runner:command-result":
        this.handleCommandResult(message);
        break;
      case "workflow-runner:result-ack":
        this.completeResult();
        break;
      case "workflow-runner:cancel":
        this.abort(new Error(message.payload.reason));
        break;
      case "workflow-runner:error":
        logger.warn(
          { code: message.payload.code, message: message.payload.message },
          "Workflow runner controller error",
        );
        break;
    }
  }

  private handleRegistered(
    message: Extract<WorkflowRunnerServerMessage, { type: "workflow-runner:registered" }>,
  ): void {
    if (message.payload.state === "completed") {
      for (const [commandId, pending] of this.pendingCommands) {
        if (pending.message.payload.command.type !== "hand-off-child") continue;
        if (pending.retryTimer !== null) clearTimeout(pending.retryTimer);
        this.pendingCommands.delete(commandId);
        pending.resolve({ childRunId: commandId });
      }
      if (!this.jobSettled) {
        this.jobSettled = true;
        this.resolveJob(null);
      }
      this.completeResult();
      return;
    }

    this.registered = true;
    this.retryMs = Math.max(1_000, Math.min(message.payload.heartbeatIntervalMs, 10_000));
    this.clientFenceMs = message.payload.clientFenceMs;
    this.startHeartbeat(message.payload.heartbeatIntervalMs, message.payload.clientFenceMs);
    if (!this.jobSettled) {
      if (message.payload.job === undefined) {
        this.abort(new Error("Workflow runner controller omitted the initial job payload"));
        return;
      }
      this.jobSettled = true;
      this.resolveJob(message.payload.job);
    }
    for (const pending of this.pendingCommands.values()) this.send(pending.message);
    if (this.pendingResult !== null) this.send(this.pendingResult.message);
  }

  private handleCommandResult(
    message: Extract<WorkflowRunnerServerMessage, { type: "workflow-runner:command-result" }>,
  ): void {
    const pending = this.pendingCommands.get(message.id);
    if (pending === undefined) return;
    if (message.payload.ok) {
      if (pending.retryTimer !== null) clearTimeout(pending.retryTimer);
      this.pendingCommands.delete(message.id);
      const response: { trackingCommentId?: number; childRunId?: string } = {};
      if (message.payload.result.trackingCommentId !== undefined) {
        response.trackingCommentId = message.payload.result.trackingCommentId;
      }
      if (message.payload.result.childRunId !== undefined) {
        response.childRunId = message.payload.result.childRunId;
      }
      pending.resolve(response);
      return;
    }
    if (message.payload.code === "INTERNAL_ERROR") {
      pending.retryTimer ??= setTimeout(() => {
        pending.retryTimer = null;
        this.sendIfReady(pending.message);
      }, this.retryMs);
      return;
    }
    this.pendingCommands.delete(message.id);
    const error =
      message.payload.code === "STALE_ATTEMPT"
        ? new StaleWorkflowAttemptError(this.options)
        : new Error(message.payload.message);
    pending.reject(error);
    if (message.payload.code === "STALE_ATTEMPT") this.abort(error);
  }

  private completeResult(): void {
    const pending = this.pendingResult;
    if (pending === null) return;
    if (pending.retryTimer !== null) clearTimeout(pending.retryTimer);
    this.pendingResult = null;
    pending.resolve();
  }

  private armResultRetry(): void {
    const pending = this.pendingResult;
    if (pending?.retryTimer !== null) return;
    pending.retryTimer = setTimeout(() => {
      pending.retryTimer = null;
      if (this.pendingResult !== pending) return;
      this.sendIfReady(pending.message);
      this.armResultRetry();
    }, this.retryMs);
  }

  private startHeartbeat(intervalMs: number, fenceMs: number): void {
    this.stopHeartbeatSender();
    this.armFence(fenceMs);
    this.heartbeatTimer = setInterval(() => {
      this.sendIfReady({
        type: "workflow-runner:heartbeat",
        ...createMessageEnvelope(),
        payload: { runId: this.options.runId, attemptId: this.options.attemptId },
      });
    }, intervalMs);
  }

  private armFence(fenceMs?: number): void {
    if (this.fenceTimer !== null) clearTimeout(this.fenceTimer);
    const delay = fenceMs ?? this.clientFenceMs;
    this.fenceTimer = setTimeout(() => {
      this.abort(new Error("Workflow runner lease acknowledgement watchdog expired"));
    }, delay);
  }

  private stopHeartbeatSender(): void {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearFence(): void {
    if (this.fenceTimer !== null) clearTimeout(this.fenceTimer);
    this.fenceTimer = null;
  }

  private stopActivity(): void {
    this.stopHeartbeatSender();
    this.clearFence();
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private sendIfReady(message: unknown): void {
    if (this.registered) this.send(message);
  }

  private send(message: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return;
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private abort(reason: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.abortController.abort(reason);
    this.stopActivity();
    this.settleJob(null);
    this.rejectPending(reason);
    const socket = this.ws;
    this.ws = null;
    socket?.close(1000, "workflow runner aborted");
  }

  private settleJob(job: WorkflowRunnerPayload | null): void {
    if (this.jobSettled) return;
    this.jobSettled = true;
    this.resolveJob(job);
  }

  private rejectPending(reason: Error): void {
    for (const pending of this.pendingCommands.values()) {
      if (pending.retryTimer !== null) clearTimeout(pending.retryTimer);
      pending.reject(reason);
    }
    this.pendingCommands.clear();
    const result = this.pendingResult;
    if (result !== null) {
      if (result.retryTimer !== null) clearTimeout(result.retryTimer);
      this.pendingResult = null;
      result.reject(reason);
    }
  }

  private unavailableReason(): Error | null {
    if (!this.closed) return null;
    const reason: unknown = this.abortController.signal.reason;
    return reason instanceof Error ? reason : new Error("Workflow runner client is closed");
  }
}
