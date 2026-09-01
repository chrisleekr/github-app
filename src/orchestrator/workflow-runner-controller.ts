import type { ServerWebSocket } from "bun";
import { Octokit } from "octokit";

import { config } from "../config";
import { requireDb } from "../db";
import { logger } from "../logger";
import {
  WORKFLOW_RUNNER_PROTOCOL_VERSION,
  type WorkflowRunnerClientMessage,
  type WorkflowRunnerCommand,
  type WorkflowRunnerPayload,
  type WorkflowRunnerResultPayload,
} from "../shared/workflow-runner-messages";
import { createMessageEnvelope } from "../shared/ws-messages";
import { redactErrorMessageOrFallback } from "../utils/log-redaction";
import { publishWorkflowRunById } from "../workflows/dispatch-outbox";
import { recordWorkflowExecution } from "../workflows/execution-row";
import { getByName } from "../workflows/registry";
import {
  assertCurrentWorkflowAttempt,
  commitAttemptHandOffChild,
  findById,
  renewWorkflowAttempts,
  StaleWorkflowAttemptError,
  type WorkflowAttempt,
} from "../workflows/runs-store";
import { setState } from "../workflows/tracking-mirror";
import { revokeInstallationToken, revokeInstallationTokenValue } from "./installation-token";
import {
  sanitizeWorkflowRunnerCommand,
  sanitizeWorkflowRunnerResult,
  WorkflowRunnerOutputRejectedError,
} from "./workflow-runner-output";
import {
  prepareWorkflowRunnerControllerOctokit,
  prepareWorkflowRunnerPayload,
} from "./workflow-runner-payload";
import {
  cleanupWorkflowRunnerAttempt,
  processWorkflowRunnerResult,
} from "./workflow-runner-result";
import {
  assertMatchingWorkflowRunnerCommand,
  findWorkflowRunnerCommandReceipt,
  getWorkflowRunnerRegistrationState,
  insertWorkflowRunnerCommandReceipt,
  recordWorkflowRunnerPayloadIssued,
  storeWorkflowRunnerResult,
  type WorkflowRunnerAttempt,
  WorkflowRunnerCommandConflictError,
  type WorkflowRunnerCommandReceipt,
} from "./workflow-runner-store";
import type { WsConnectionData } from "./ws-connection";

const RUNNER_CLIENT_FENCE_MS = Math.max(config.heartbeatTimeoutMs, 3 * config.heartbeatIntervalMs);
const RUNNER_DB_LEASE_MS = 2 * RUNNER_CLIENT_FENCE_MS;
const RUNNER_REGISTRATION_LEASE_MS = Math.max(300_000, RUNNER_DB_LEASE_MS);

interface RunnerSession {
  readonly ws: ServerWebSocket<WsConnectionData>;
  readonly attempt: WorkflowRunnerAttempt;
  readonly octokit: Octokit;
  readonly revokeOctokitOnRelease: boolean;
}

const sessions = new Map<string, RunnerSession>();
const attemptChains = new Map<string, Promise<void>>();

async function revokeUndeliveredRunnerToken(job: WorkflowRunnerPayload): Promise<void> {
  await revokeInstallationTokenValue(job.installationToken, logger, {
    owner: "undelivered-runner-payload",
  });
}

async function revokeRunnerSessionToken(session: RunnerSession): Promise<void> {
  if (!session.revokeOctokitOnRelease) return;
  await revokeInstallationToken(session.octokit, logger, {
    attemptId: session.attempt.attemptId,
    owner: "controller-session",
  });
}

async function releaseRunnerSessionToken(session: RunnerSession): Promise<void> {
  await (attemptChains.get(session.attempt.attemptId) ?? Promise.resolve()).catch(() => undefined);
  await revokeRunnerSessionToken(session);
}

function send(ws: ServerWebSocket<WsConnectionData>, message: unknown): boolean {
  const sent = ws.sendText(JSON.stringify(message));
  if (sent !== 0) return true;
  ws.close(1011, "workflow runner control frame delivery failed");
  return false;
}

function identityMatches(
  ws: ServerWebSocket<WsConnectionData>,
  payload: { readonly runId: string; readonly attemptId: string },
): boolean {
  return ws.data.runnerRunId === payload.runId && ws.data.runnerAttemptId === payload.attemptId;
}

function closePolicy(ws: ServerWebSocket<WsConnectionData>, reason: string): void {
  ws.close(1008, reason);
}

export function handleWorkflowRunnerOpen(ws: ServerWebSocket<WsConnectionData>): void {
  ws.data.runnerRegistered = false;
}

export function handleWorkflowRunnerClose(ws: ServerWebSocket<WsConnectionData>): void {
  const attemptId = ws.data.runnerAttemptId;
  if (attemptId === undefined) return;
  const session = sessions.get(attemptId);
  if (session?.ws !== ws) return;
  sessions.delete(attemptId);
  void releaseRunnerSessionToken(session);
}

export function handleWorkflowRunnerMessage(
  ws: ServerWebSocket<WsConnectionData>,
  message: WorkflowRunnerClientMessage,
): void {
  if (!identityMatches(ws, message.payload)) {
    closePolicy(ws, "workflow runner identity mismatch");
    return;
  }
  if (message.type !== "workflow-runner:register" && ws.data.runnerRegistered !== true) {
    closePolicy(ws, "workflow runner is not registered");
    return;
  }

  switch (message.type) {
    case "workflow-runner:register":
      void registerRunner(ws, message).catch((err: unknown) => {
        logger.error({ err, attemptId: message.payload.attemptId }, "Runner registration failed");
        ws.close(1011, "workflow runner registration failed");
      });
      break;
    case "workflow-runner:heartbeat":
      void handleHeartbeat(ws, message).catch((err: unknown) => {
        logger.error({ err, attemptId: message.payload.attemptId }, "Runner heartbeat failed");
        ws.close(1011, "workflow runner heartbeat failed");
      });
      break;
    case "workflow-runner:command":
      queueCommand(ws, message);
      break;
    case "workflow-runner:result":
      queueResult(ws, message);
      break;
  }
}

async function registerRunner(
  ws: ServerWebSocket<WsConnectionData>,
  message: Extract<WorkflowRunnerClientMessage, { type: "workflow-runner:register" }>,
): Promise<void> {
  if (ws.data.runnerRegistered === true) {
    closePolicy(ws, "duplicate workflow runner registration");
    return;
  }
  if (message.payload.protocolVersion !== WORKFLOW_RUNNER_PROTOCOL_VERSION) {
    closePolicy(ws, "incompatible workflow runner protocol");
    return;
  }

  const attempt = { runId: message.payload.runId, attemptId: message.payload.attemptId };
  const state = await getWorkflowRunnerRegistrationState(attempt);
  if (state.state === "invalid") {
    closePolicy(ws, "stale workflow runner attempt");
    return;
  }
  if (state.state === "completed") {
    send(ws, {
      type: "workflow-runner:registered",
      ...createMessageEnvelope(message.id),
      payload: { state: "completed" },
    });
    return;
  }
  if (state.state === "result-pending") {
    await processWorkflowRunnerResult({
      runId: attempt.runId,
      attemptId: attempt.attemptId,
      executionDeliveryId: state.executionDeliveryId,
      payload: state.payload,
    });
    send(ws, {
      type: "workflow-runner:registered",
      ...createMessageEnvelope(message.id),
      payload: { state: "completed" },
    });
    return;
  }

  const renewal = await renewWorkflowAttempts(
    state.attempt.runnerId,
    [state.attempt.attemptId],
    RUNNER_REGISTRATION_LEASE_MS,
  );
  if (!renewal.renewedAttemptIds.includes(state.attempt.attemptId)) {
    closePolicy(ws, "workflow runner lease expired");
    return;
  }
  let job: WorkflowRunnerPayload | undefined;
  let octokit: Octokit | undefined;
  let revokeOctokitOnRelease = false;
  let payloadTransferred = false;
  let sessionInstalled = false;
  try {
    if (message.payload.needsJob) {
      if (state.payloadIssuedAt !== null) {
        closePolicy(ws, "workflow runner payload was already issued");
        return;
      }
      job = await prepareWorkflowRunnerPayload(state.attempt);
      const recorded = await recordWorkflowRunnerPayloadIssued(
        attempt,
        new Date(job.installationTokenExpiresAt),
      );
      if (!recorded) {
        closePolicy(ws, "workflow runner payload delivery was rejected");
        return;
      }
      octokit = new Octokit({ auth: job.installationToken });
    } else {
      if (state.payloadIssuedAt === null || state.tokenExpiresAt === null) {
        closePolicy(ws, "workflow runner reconnected before receiving its payload");
        return;
      }
      octokit = await prepareWorkflowRunnerControllerOctokit(state.attempt);
      revokeOctokitOnRelease = true;
    }
    const renewedAfterPreparation = await renewWorkflowAttempts(
      state.attempt.runnerId,
      [state.attempt.attemptId],
      RUNNER_DB_LEASE_MS,
    );
    if (!renewedAfterPreparation.renewedAttemptIds.includes(state.attempt.attemptId)) {
      closePolicy(ws, "workflow runner lease expired during payload preparation");
      return;
    }

    const old = sessions.get(state.attempt.attemptId);
    if (old !== undefined && old.ws !== ws) {
      sessions.delete(state.attempt.attemptId);
      old.ws.close(4002, "superseded by runner reconnect");
      void releaseRunnerSessionToken(old);
    }
    const session: RunnerSession = {
      ws,
      attempt: state.attempt,
      octokit,
      revokeOctokitOnRelease,
    };
    sessions.set(state.attempt.attemptId, session);
    sessionInstalled = true;
    ws.data.runnerRegistered = true;
    if (
      !send(ws, {
        type: "workflow-runner:registered",
        ...createMessageEnvelope(message.id),
        payload: {
          state: "ready",
          heartbeatIntervalMs: config.heartbeatIntervalMs,
          clientFenceMs: RUNNER_CLIENT_FENCE_MS,
          dbLeaseMs: RUNNER_DB_LEASE_MS,
          ...(job === undefined ? {} : { job }),
        },
      })
    ) {
      if (sessions.get(state.attempt.attemptId) === session) {
        sessions.delete(state.attempt.attemptId);
      }
      sessionInstalled = false;
      ws.data.runnerRegistered = false;
      return;
    }
    payloadTransferred = job !== undefined;
  } finally {
    if (job !== undefined && !payloadTransferred) await revokeUndeliveredRunnerToken(job);
    if (octokit !== undefined && revokeOctokitOnRelease && !sessionInstalled) {
      await revokeInstallationToken(octokit, logger, {
        attemptId: state.attempt.attemptId,
        owner: "controller-registration",
      });
    }
  }
}

async function handleHeartbeat(
  ws: ServerWebSocket<WsConnectionData>,
  message: Extract<WorkflowRunnerClientMessage, { type: "workflow-runner:heartbeat" }>,
): Promise<void> {
  const attemptId = message.payload.attemptId;
  const session = sessions.get(attemptId);
  if (session?.ws !== ws) {
    closePolicy(ws, "workflow runner session superseded");
    return;
  }
  const renewal = await renewWorkflowAttempts(
    session.attempt.runnerId,
    [attemptId],
    RUNNER_DB_LEASE_MS,
  );
  const renewed = renewal.renewedAttemptIds.includes(attemptId);
  send(ws, {
    type: "workflow-runner:heartbeat-ack",
    ...createMessageEnvelope(message.id),
    payload: { renewed },
  });
  if (!renewed) closePolicy(ws, "workflow runner attempt fenced");
}

function queueCommand(
  ws: ServerWebSocket<WsConnectionData>,
  message: Extract<WorkflowRunnerClientMessage, { type: "workflow-runner:command" }>,
): void {
  const attemptId = message.payload.attemptId;
  const prior = attemptChains.get(attemptId) ?? Promise.resolve();
  const current = prior
    .catch(() => undefined)
    .then(() => handleCommand(ws, message))
    .catch((err: unknown) => {
      const stale = err instanceof StaleWorkflowAttemptError;
      const conflict = err instanceof WorkflowRunnerCommandConflictError;
      const rejected = err instanceof WorkflowRunnerOutputRejectedError;
      const code = stale
        ? "STALE_ATTEMPT"
        : conflict || rejected
          ? "INVALID_COMMAND"
          : "INTERNAL_ERROR";
      logger.error({ err, attemptId, commandId: message.id }, "Workflow runner command failed");
      send(ws, {
        type: "workflow-runner:command-result",
        ...createMessageEnvelope(message.id),
        payload: {
          ok: false,
          code,
          message: stale
            ? "workflow attempt is no longer current"
            : conflict || rejected
              ? "workflow command was rejected"
              : "workflow command failed",
        },
      });
      if (stale) closePolicy(ws, "workflow runner attempt fenced");
    });
  attemptChains.set(attemptId, current);
  void current.finally(() => {
    if (attemptChains.get(attemptId) === current) attemptChains.delete(attemptId);
  });
}

function queueResult(
  ws: ServerWebSocket<WsConnectionData>,
  message: Extract<WorkflowRunnerClientMessage, { type: "workflow-runner:result" }>,
): void {
  const attemptId = message.payload.attemptId;
  const prior = attemptChains.get(attemptId) ?? Promise.resolve();
  const current = prior
    .catch(() => undefined)
    .then(() => handleResult(ws, message))
    .catch((err: unknown) => {
      logger.error({ err, attemptId }, "Runner result failed");
      if (
        err instanceof StaleWorkflowAttemptError ||
        err instanceof WorkflowRunnerCommandConflictError
      ) {
        closePolicy(ws, "workflow runner result rejected");
      }
    });
  attemptChains.set(attemptId, current);
  void current.finally(() => {
    if (attemptChains.get(attemptId) === current) attemptChains.delete(attemptId);
  });
}

async function handleCommand(
  ws: ServerWebSocket<WsConnectionData>,
  message: Extract<WorkflowRunnerClientMessage, { type: "workflow-runner:command" }>,
): Promise<void> {
  const session = sessions.get(message.payload.attemptId);
  if (session?.ws !== ws) throw new StaleWorkflowAttemptError(message.payload);
  const attempt = { runId: message.payload.runId, attemptId: message.payload.attemptId };
  const command = await sanitizeWorkflowRunnerCommand(message.payload.command);
  const existing = await findWorkflowRunnerCommandReceipt(attempt, message.id);
  if (existing !== null) {
    assertMatchingWorkflowRunnerCommand(existing, message.id, command);
    if (command.type === "hand-off-child") {
      await settleCommittedHandOff(session);
    }
    sendCommandSuccess(ws, message.id, existing.response);
    return;
  }

  const response =
    command.type === "set-state"
      ? await applySetStateCommand(session, message.id, command)
      : await applyHandOffCommand(session, message.id, command);
  sendCommandSuccess(ws, message.id, response);
}

function sendCommandSuccess(
  ws: ServerWebSocket<WsConnectionData>,
  commandId: string,
  response: WorkflowRunnerCommandReceipt["response"],
): void {
  send(ws, {
    type: "workflow-runner:command-result",
    ...createMessageEnvelope(commandId),
    payload: { ok: true, result: response },
  });
}

async function applySetStateCommand(
  session: RunnerSession,
  commandId: string,
  command: Extract<WorkflowRunnerCommand, { type: "set-state" }>,
): Promise<WorkflowRunnerCommandReceipt["response"]> {
  const attempt = { runId: session.attempt.runId, attemptId: session.attempt.attemptId };
  await assertCurrentWorkflowAttempt(attempt);
  const row = await setState(
    { octokit: session.octokit, logger },
    {
      runId: attempt.runId,
      patch: command.patch,
      humanMessage: command.humanMessage,
      attempt,
    },
  );
  const response =
    row.tracking_comment_id === null ? {} : { trackingCommentId: row.tracking_comment_id };
  await insertWorkflowRunnerCommandReceipt(attempt, commandId, command, response, requireDb());
  return response;
}

async function assertValidHandOff(
  attempt: WorkflowAttempt,
  command: Extract<WorkflowRunnerCommand, { type: "hand-off-child" }>,
): Promise<void> {
  const row = await findById(attempt.runId);
  const expectedStep = getByName("ship").steps[command.parentStepIndex];
  if (
    row?.workflow_name !== "ship" ||
    row.attempt_id !== attempt.attemptId ||
    expectedStep !== command.workflowName ||
    row.target_type !== command.target.type ||
    row.target_owner !== command.target.owner ||
    row.target_repo !== command.target.repo ||
    row.target_number !== command.target.number
  ) {
    throw new WorkflowRunnerCommandConflictError(command.parentStepIndex.toString());
  }
}

async function applyHandOffCommand(
  session: RunnerSession,
  commandId: string,
  command: Extract<WorkflowRunnerCommand, { type: "hand-off-child" }>,
): Promise<WorkflowRunnerCommandReceipt["response"]> {
  const attempt = { runId: session.attempt.runId, attemptId: session.attempt.attemptId };
  await assertCurrentWorkflowAttempt(attempt);
  await assertValidHandOff(attempt, command);

  const response = { childRunId: commandId };
  const resultPayload = {
    runId: attempt.runId,
    attemptId: attempt.attemptId,
    result: {
      status: "handed-off" as const,
      state: { ...command.state, handedOffTo: commandId },
      humanMessage: command.humanMessage,
      childRunId: commandId,
    },
    durationMs: 0,
  };
  try {
    await requireDb().begin(async (tx) => {
      const replay = await findWorkflowRunnerCommandReceipt(attempt, commandId, tx);
      if (replay !== null) {
        assertMatchingWorkflowRunnerCommand(replay, commandId, command);
        return;
      }
      const child = await commitAttemptHandOffChild(
        attempt,
        command.state,
        {
          workflowName: command.workflowName,
          target: command.target,
          parentStepIndex: command.parentStepIndex,
          traceDeliveryId: session.attempt.executionDeliveryId,
          childRunId: commandId,
        },
        tx,
      );
      await recordWorkflowExecution({
        deliveryId: child.id,
        target: command.target,
        senderLogin: config.botAppLogin,
        workflowName: command.workflowName,
        runId: child.id,
        logger,
        sql: tx,
      });
      const executionRows: { delivery_id: string }[] = await tx`
        UPDATE executions
           SET status = 'completed',
               completed_at = now(),
               duration_ms = 0,
               workflow_result_payload = ${resultPayload}::jsonb,
               result_processed_at = NULL
         WHERE delivery_id = ${session.attempt.executionDeliveryId}
           AND daemon_id = ${session.attempt.runnerId}
           AND offer_id = ${attempt.attemptId}
           AND status = 'running'
        RETURNING delivery_id
      `;
      if (executionRows[0] === undefined) throw new StaleWorkflowAttemptError(attempt);
      await insertWorkflowRunnerCommandReceipt(attempt, commandId, command, response, tx);
    });
  } catch (err) {
    const receipt = await findWorkflowRunnerCommandReceipt(attempt, commandId).catch(() => null);
    if (receipt === null) throw err;
    assertMatchingWorkflowRunnerCommand(receipt, commandId, command);
  }
  await publishWorkflowRunById(commandId).catch((err: unknown) => {
    logger.warn({ err, childRunId: commandId }, "Committed workflow child awaits outbox retry");
  });
  await settleCommittedHandOff(session);
  return response;
}

async function settleCommittedHandOff(session: RunnerSession): Promise<void> {
  const state = await getWorkflowRunnerRegistrationState({
    runId: session.attempt.runId,
    attemptId: session.attempt.attemptId,
  });
  if (state.state === "completed") return;
  if (state.state !== "result-pending") {
    throw new Error("Committed hand-off has no durable terminal result");
  }
  await processWorkflowRunnerResult({
    runId: session.attempt.runId,
    attemptId: session.attempt.attemptId,
    executionDeliveryId: state.executionDeliveryId,
    payload: state.payload,
  });
}

function normalizeRunnerFailure(payload: WorkflowRunnerResultPayload): WorkflowRunnerResultPayload {
  const result = payload.result;
  if (result.status === "succeeded" || result.status === "handed-off") return payload;
  return {
    ...payload,
    result: {
      ...result,
      reason: redactErrorMessageOrFallback(result.reason, "workflow failed"),
      ...(result.humanMessage === undefined
        ? {}
        : {
            humanMessage: redactErrorMessageOrFallback(
              result.humanMessage,
              "workflow failed, see server logs",
            ),
          }),
    },
  };
}

async function handleResult(
  ws: ServerWebSocket<WsConnectionData>,
  message: Extract<WorkflowRunnerClientMessage, { type: "workflow-runner:result" }>,
): Promise<void> {
  const session = sessions.get(message.payload.attemptId);
  if (session?.ws !== ws) throw new StaleWorkflowAttemptError(message.payload);
  const attempt = { runId: message.payload.runId, attemptId: message.payload.attemptId };
  const registration = await getWorkflowRunnerRegistrationState(attempt);
  if (registration.state === "invalid") throw new StaleWorkflowAttemptError(attempt);

  if (registration.state === "result-pending") {
    await processWorkflowRunnerResult({
      runId: attempt.runId,
      attemptId: attempt.attemptId,
      executionDeliveryId: registration.executionDeliveryId,
      payload: registration.payload,
    });
  } else if (registration.state === "ready") {
    const payload = normalizeRunnerFailure(await sanitizeWorkflowRunnerResult(message.payload));
    await storeWorkflowRunnerResult(payload);
    await processWorkflowRunnerResult({
      runId: payload.runId,
      attemptId: payload.attemptId,
      executionDeliveryId: session.attempt.executionDeliveryId,
      payload,
    });
  }
  send(ws, {
    type: "workflow-runner:result-ack",
    ...createMessageEnvelope(attempt.attemptId),
    payload: {},
  });
  if (sessions.get(attempt.attemptId)?.ws === ws) {
    sessions.delete(attempt.attemptId);
    await revokeRunnerSessionToken(session);
  }
  void cleanupWorkflowRunnerAttempt(attempt).catch((err: unknown) => {
    logger.warn({ err, attemptId: attempt.attemptId }, "Runner cleanup will be reconciled");
  });
}

export function getWorkflowRunnerConnection(
  attemptId: string,
): ServerWebSocket<WsConnectionData> | undefined {
  return sessions.get(attemptId)?.ws;
}

export function resetWorkflowRunnerControllerForTests(): void {
  sessions.clear();
  attemptChains.clear();
}
