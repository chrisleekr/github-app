import type { ServerWebSocket } from "bun";
import { App, Octokit } from "octokit";

import { config } from "../config";
import { clearInFlightByJobId } from "../db/queries/scheduled-actions-store";
import { logger } from "../logger";
import { loadRepoPolicy, toAgentPolicy } from "../repo-config/effective";
import { observableOctokit } from "../utils/octokit-observability";
import { mintInstallationToken } from "./installation-token";
import { DAEMON_HEARTBEAT_LOG_EVENTS, DISPATCHER_LOG_EVENTS } from "./log-fields";
import type {
  loadReviewLearnings as LoadReviewLearningsFn,
  ReviewLearning,
  searchReviewLearningsByEmbedding as SearchReviewLearningsByEmbeddingFn,
} from "./review-learnings";

interface ReviewLearningsModule {
  loadReviewLearnings: typeof LoadReviewLearningsFn;
  searchReviewLearningsByEmbedding: typeof SearchReviewLearningsByEmbeddingFn;
}

// Read orchestrator app version at module load so we can detect daemon drift
// in handleRegister and request an update via daemon:update-required.
const ORCHESTRATOR_APP_VERSION: string = ((): string => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Bun supports require for JSON; dynamic import would be async
    const pkg = require("../../package.json") as { version: string };
    return pkg.version;
  } catch {
    return "0.0.0";
  }
})();

/** Parse a semver-ish version string into a [major, minor, patch] tuple. */
function parseVersion(v: string): [number, number, number] {
  const parts = v.split(".").map((p) => parseInt(p, 10));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** Return true if `daemon` is strictly older than `orchestrator`. */
function isDaemonOutdated(daemon: string, orchestrator: string): boolean {
  const [dMaj, dMin, dPatch] = parseVersion(daemon);
  const [oMaj, oMin, oPatch] = parseVersion(orchestrator);
  if (dMaj !== oMaj) return dMaj < oMaj;
  if (dMin !== oMin) return dMin < oMin;
  return dPatch < oPatch;
}
import type { DaemonInfo, HeartbeatState } from "../shared/daemon-types";
import {
  type AgentPolicy,
  createMessageEnvelope,
  type DaemonMessage,
  PROTOCOL_VERSION,
  type ScopedJobContext,
  WS_CLOSE_CODES,
  WS_ERROR_CODES,
} from "../shared/ws-messages";
import type { ModelUsageEntry } from "../types";
import { decrementActiveCount, incrementActiveCount } from "./concurrency";
import {
  decrementDaemonActiveJobs,
  deregisterDaemon,
  incrementDaemonActiveJobs,
  refreshDaemonTtl,
  registerDaemon,
} from "./daemon-registry";
import {
  failDisconnectedDaemon,
  getExecutionState,
  getOrphanedExecutions,
  markExecutionCompleted,
  markExecutionFailed,
  markExecutionRunning,
} from "./history";
import {
  getPendingOffer,
  handleJobAccept,
  handleJobReject,
  removePendingOffer,
} from "./job-dispatcher";
import { isScopedJob, QueuedJobSchema, type ScopedQueuedJob } from "./job-queue";
import { persistRepoKnowledge } from "./repo-knowledge-persistence";
import { notifyDisconnectedDaemonWorkflows } from "./workflow-expiry-notifier";
import { sendError, type WsConnectionData } from "./ws-connection";

// In-memory state (per orchestrator process)

const connections = new Map<string, ServerWebSocket<WsConnectionData>>();
const daemonInfoMap = new Map<string, DaemonInfo>();
const heartbeatTimers = new Map<string, HeartbeatState>();
const disconnectCleanups = new Set<Promise<void>>();
const disconnectCleanupsByDaemon = new Map<string, Promise<void>>();
const registrationTransitionsByDaemon = new Map<string, Promise<void>>();
const protocolUpdateTransitions = new Map<
  ServerWebSocket<WsConnectionData>,
  {
    readonly daemonId: string;
    readonly phase: "awaiting-ack" | "draining";
    readonly timer: Timer;
  }
>();
const PROTOCOL_UPDATE_ACK_TIMEOUT_MS = 5_000;
const PROTOCOL_UPDATE_DRAIN_GRACE_MS = 2_000;

/** Daemon IDs that sent daemon:draining, excluded from dispatch. */
const drainingDaemons = new Set<string>();

/** Cached Octokit App singleton for minting installation tokens. */
let cachedApp: InstanceType<typeof App> | null = null;
function getOrCreateApp(): InstanceType<typeof App> {
  if (cachedApp !== null) return cachedApp;
  if (config.appId === undefined || config.privateKey === undefined) {
    throw new Error("getOrCreateApp requires GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY");
  }
  cachedApp = new App({
    appId: config.appId,
    privateKey: config.privateKey,
    // Rate-limit observability on app.octokit + installation octokits (#170).
    Octokit: observableOctokit(),
  });
  return cachedApp;
}

// Exports for other orchestrator modules

export function getConnections(): Map<string, ServerWebSocket<WsConnectionData>> {
  return connections;
}

export function getDaemonInfo(daemonId: string): DaemonInfo | undefined {
  return daemonInfoMap.get(daemonId);
}

export function isDaemonDraining(daemonId: string): boolean {
  return drainingDaemons.has(daemonId);
}

// WebSocket event handlers (called from ws-server.ts)

export function handleWsOpen(_ws: ServerWebSocket<WsConnectionData>): void {
  // No-op until daemon:register is received
}

/** FM-1 cleanup on WebSocket close. */
export function handleWsClose(
  ws: ServerWebSocket<WsConnectionData>,
  _code: number,
  _reason: string,
): void {
  const protocolUpdate = protocolUpdateTransitions.get(ws);
  if (protocolUpdate !== undefined) {
    clearTimeout(protocolUpdate.timer);
    protocolUpdateTransitions.delete(ws);
  }

  const daemonId = ws.data.daemonId;
  if (daemonId === undefined) return;
  ws.data.daemonId = undefined;

  // A superseded socket must not tear down the newer connection that now owns
  // this per-boot daemon ID.
  if (connections.get(daemonId) !== ws) return;

  const hb = heartbeatTimers.get(daemonId);
  if (hb !== undefined) {
    clearInterval(hb.intervalTimer);
    if (hb.pongTimer !== null) clearTimeout(hb.pongTimer);
    heartbeatTimers.delete(daemonId);
  }

  connections.delete(daemonId);
  daemonInfoMap.delete(daemonId);
  drainingDaemons.delete(daemonId);

  void startDisconnectCleanup(daemonId);
}

function startDisconnectCleanup(daemonId: string): Promise<void> {
  const pending = disconnectCleanupsByDaemon.get(daemonId);
  if (pending !== undefined) return pending;

  const cleanup = cleanupAfterDisconnect(daemonId);
  disconnectCleanups.add(cleanup);
  disconnectCleanupsByDaemon.set(daemonId, cleanup);
  void cleanup.finally(() => {
    disconnectCleanups.delete(cleanup);
    if (disconnectCleanupsByDaemon.get(daemonId) === cleanup) {
      disconnectCleanupsByDaemon.delete(daemonId);
    }
  });
  return cleanup;
}

/**
 * Post the stranded-workflow notices for a disconnect, tracked for shutdown but
 * NOT for re-registration.
 *
 * `notifyDisconnectedDaemonWorkflows` walks parent chains and posts a GitHub
 * comment per stranded run. `handleRegister` awaits the fencing cleanup, so
 * leaving this in it would hold a flapping daemon out of the pool for as long as
 * GitHub is slow or rate-limited, with no bound on an Octokit hang. It is safe
 * to detach: each notice takes a `failure_notified_at` receipt, so
 * `reconcilePendingWorkflowFailureNotifications` retries anything lost here.
 */
function startDisconnectNotifications(daemonId: string, workflowRunIds: readonly string[]): void {
  if (workflowRunIds.length === 0) return;
  const notify = notifyDisconnectedDaemonWorkflows(workflowRunIds).catch((err: unknown) => {
    logger.error({ err, daemonId }, "Failed to post disconnected-daemon workflow notices");
  });
  disconnectCleanups.add(notify);
  void notify.finally(() => disconnectCleanups.delete(notify));
}

/**
 * Async cleanup after daemon disconnect (FM-1).
 * Deregisters daemon and marks orphaned executions as failed.
 *
 * Only the DB-side work is awaited here, because `handleRegister` fences
 * re-registration on this promise. GitHub notification is detached; see
 * `startDisconnectNotifications`.
 */
async function cleanupAfterDisconnect(daemonId: string): Promise<void> {
  try {
    const failed = await failDisconnectedDaemon(daemonId);
    startDisconnectNotifications(daemonId, failed.workflowRunIds);
    if (failed.executionDeliveryIds.length > 0 || failed.workflowRunIds.length > 0) {
      logger.warn(
        {
          daemonId,
          orphanCount: failed.executionDeliveryIds.length,
          workflowRunCount: failed.workflowRunIds.length,
        },
        "Cleaned up orphaned executions after daemon disconnect",
      );
    }
  } catch (err) {
    logger.error({ err, daemonId }, "Failed durable daemon disconnect cleanup");
  }

  try {
    await deregisterDaemon(daemonId);
  } catch (err) {
    logger.error({ err, daemonId }, "Failed best-effort daemon registry cleanup");
  }
}

/**
 * Wait until every registration and close callback has finished its durable work.
 *
 * Dormant on this branch: `src/app.ts` still shuts down via `stopQueueWorker()
 * -> stopWebSocketServer() -> closeValkey() -> closeDb()`. The isolated-runner
 * slice calls this and `beginDaemonConnectionShutdown` from `ws-server.ts`, so
 * until both land together a restart during active daemon connections can race
 * cleanup writes against `closeDb()`.
 */
export async function drainDisconnectCleanups(): Promise<void> {
  while (registrationTransitionsByDaemon.size > 0 || disconnectCleanups.size > 0) {
    // eslint-disable-next-line no-await-in-loop -- connection transitions can enqueue cleanup while settling
    await Promise.allSettled([...registrationTransitionsByDaemon.values(), ...disconnectCleanups]);
  }
}

/**
 * Start exact-incarnation cleanup before the WebSocket server drain timer.
 *
 * Dormant on this branch; see `drainDisconnectCleanups`.
 */
export function beginDaemonConnectionShutdown(): void {
  for (const ws of [...connections.values()]) {
    handleWsClose(ws, 1001, "orchestrator shutting down");
    ws.close(1001, "orchestrator shutting down");
  }
}

/** Route validated daemon messages to type-specific handlers. */
export function handleDaemonMessage(
  ws: ServerWebSocket<WsConnectionData>,
  msg: DaemonMessage,
): void {
  switch (msg.type) {
    case "daemon:register":
      queueRegistration(ws, msg);
      break;
    case "heartbeat:pong":
      handleHeartbeatPong(ws, msg);
      break;
    case "daemon:draining":
      handleDraining(ws, msg);
      break;
    case "daemon:update-acknowledged":
      handleUpdateAcknowledged(ws, msg);
      break;
    case "job:accept":
    case "job:reject":
    case "job:status":
    case "job:result":
      handleJobMessage(ws, msg);
      break;
    case "scoped-job:completion":
      void handleScopedJobCompletion(ws, msg);
      break;
  }
}

// daemon:register handler (FM-8 reconnection logic)

function queueRegistration(
  ws: ServerWebSocket<WsConnectionData>,
  msg: Extract<DaemonMessage, { type: "daemon:register" }>,
): void {
  const { daemonId } = msg.payload;
  const previous = registrationTransitionsByDaemon.get(daemonId);
  const transition = (previous?.catch(() => undefined) ?? Promise.resolve()).then(() =>
    handleRegister(ws, msg),
  );
  registrationTransitionsByDaemon.set(daemonId, transition);
  void transition
    .catch((err: unknown) => {
      logger.error({ err, daemonId }, "Unhandled daemon registration failure");
    })
    .finally(() => {
      if (registrationTransitionsByDaemon.get(daemonId) === transition) {
        registrationTransitionsByDaemon.delete(daemonId);
      }
    });
}

async function handleRegister(
  ws: ServerWebSocket<WsConnectionData>,
  msg: Extract<DaemonMessage, { type: "daemon:register" }>,
): Promise<void> {
  const { daemonId } = msg.payload;

  // A socket that entered the update transition cannot re-register under a
  // different schema while its update acknowledgement is pending.
  if (protocolUpdateTransitions.has(ws)) return;

  // Reject mixed schemas before this socket can mutate daemon state. Older
  // daemons can acknowledge update-required and drain before we close them.
  const ourMajor = PROTOCOL_VERSION.split(".", 1)[0] ?? "";
  const theirMajor = msg.payload.protocolVersion.split(".", 1)[0] ?? "";
  if (theirMajor !== ourMajor) {
    const ourMajorNumber = Number(ourMajor);
    const theirMajorNumber = Number(theirMajor);
    if (
      /^\d+$/.test(ourMajor) &&
      /^\d+$/.test(theirMajor) &&
      Number.isInteger(ourMajorNumber) &&
      Number.isInteger(theirMajorNumber) &&
      theirMajorNumber < ourMajorNumber
    ) {
      logger.warn(
        {
          daemonId,
          daemonProtocolVersion: msg.payload.protocolVersion,
          orchestratorProtocolVersion: PROTOCOL_VERSION,
        },
        "Daemon protocol is outdated, sending daemon:update-required",
      );
      const timer = setTimeout(() => {
        protocolUpdateTransitions.delete(ws);
        ws.close(
          WS_CLOSE_CODES.INCOMPATIBLE_PROTOCOL.code,
          WS_CLOSE_CODES.INCOMPATIBLE_PROTOCOL.reason,
        );
      }, PROTOCOL_UPDATE_ACK_TIMEOUT_MS);
      timer.unref();
      protocolUpdateTransitions.set(ws, { daemonId, phase: "awaiting-ack", timer });
      ws.sendText(
        JSON.stringify({
          type: "daemon:update-required",
          ...createMessageEnvelope(msg.id),
          payload: {
            targetVersion: ORCHESTRATOR_APP_VERSION,
            reason: `Orchestrator protocol is ${PROTOCOL_VERSION}; daemon protocol is ${msg.payload.protocolVersion}`,
            urgent: true,
          },
        }),
      );
    } else {
      ws.close(
        WS_CLOSE_CODES.INCOMPATIBLE_PROTOCOL.code,
        WS_CLOSE_CODES.INCOMPATIBLE_PROTOCOL.reason,
      );
    }
    return;
  }

  // A transport reconnect reuses the same per-boot daemon ID. Finish fencing
  // the closed socket before restoring that identity in PostgreSQL or Valkey.
  const pendingCleanup = disconnectCleanupsByDaemon.get(daemonId);
  if (pendingCleanup !== undefined) await pendingCleanup;

  // FM-8: Check for existing connection with same daemon ID
  const existing = connections.get(daemonId);
  if (existing !== undefined) {
    logger.info({ daemonId }, "Daemon reconnected, closing old connection (FM-8)");
    // Clear daemonId BEFORE close so handleWsClose's cleanup is a no-op,
    // preventing a race where deregisterDaemon runs after registerDaemon.
    existing.data.daemonId = undefined;
    existing.close(WS_CLOSE_CODES.SUPERSEDED.code, WS_CLOSE_CODES.SUPERSEDED.reason);

    // Clean up old connection state
    const oldHb = heartbeatTimers.get(daemonId);
    if (oldHb !== undefined) {
      clearInterval(oldHb.intervalTimer);
      if (oldHb.pongTimer !== null) clearTimeout(oldHb.pongTimer);
      heartbeatTimers.delete(daemonId);
    }
    connections.delete(daemonId);
    drainingDaemons.delete(daemonId);

    // Clean orphaned executions from previous session
    const orphans = await getOrphanedExecutions(daemonId);
    for (const orphan of orphans) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await markExecutionFailed(
          orphan.deliveryId,
          "daemon reconnected, previous session orphaned",
        );
      } catch (err) {
        logger.error({ err, deliveryId: orphan.deliveryId }, "Failed to mark orphaned execution");
      }
    }
  }

  // Register in Valkey + Postgres
  try {
    const info = await registerDaemon(msg);
    if (ws.readyState !== 1) {
      await startDisconnectCleanup(daemonId);
      return;
    }
    daemonInfoMap.set(daemonId, info);
  } catch (err) {
    logger.error({ err, daemonId }, "Failed to register daemon");
    sendError(ws, msg.id, WS_ERROR_CODES.INTERNAL_ERROR, "Registration failed");
    return;
  }

  ws.data.daemonId = daemonId;
  connections.set(daemonId, ws);

  ws.sendText(
    JSON.stringify({
      type: "daemon:registered",
      ...createMessageEnvelope(),
      payload: {
        heartbeatIntervalMs: config.heartbeatIntervalMs,
        offerTimeoutMs: config.offerTimeoutMs,
        maxRetries: config.jobMaxRetries,
      },
    }),
  );

  // Start heartbeat loop (FM-2)
  startHeartbeatLoop(ws, daemonId);

  logger.info(
    {
      daemonId,
      platform: msg.payload.platform,
      protocolVersion: msg.payload.protocolVersion,
      appVersion: msg.payload.appVersion,
      orchestratorVersion: ORCHESTRATOR_APP_VERSION,
    },
    "Daemon registered",
  );

  // App-version drift: outdated daemons receive daemon:update-required so they
  // can apply the configured update strategy (exit / pull / notify). Newer
  // daemons are tolerated (e.g. mid-rollout) but logged for visibility.
  const daemonAppVersion = msg.payload.appVersion;
  if (daemonAppVersion !== ORCHESTRATOR_APP_VERSION) {
    if (isDaemonOutdated(daemonAppVersion, ORCHESTRATOR_APP_VERSION)) {
      logger.warn(
        { daemonId, daemonAppVersion, orchestratorVersion: ORCHESTRATOR_APP_VERSION },
        "Daemon appVersion is older than orchestrator, sending daemon:update-required",
      );
      ws.sendText(
        JSON.stringify({
          type: "daemon:update-required",
          ...createMessageEnvelope(),
          payload: {
            targetVersion: ORCHESTRATOR_APP_VERSION,
            reason: `Orchestrator is on ${ORCHESTRATOR_APP_VERSION}; daemon is on ${daemonAppVersion}`,
            urgent: false,
          },
        }),
      );
    } else {
      logger.info(
        { daemonId, daemonAppVersion, orchestratorVersion: ORCHESTRATOR_APP_VERSION },
        "Daemon appVersion is ahead of orchestrator, tolerating during rollout",
      );
    }
  }
}

// Heartbeat loop (FM-2)

function startHeartbeatLoop(ws: ServerWebSocket<WsConnectionData>, daemonId: string): void {
  const state: HeartbeatState = {
    intervalTimer: setInterval(() => {
      sendHeartbeatPing(ws, daemonId);
    }, config.heartbeatIntervalMs),
    pongTimer: null,
    awaitingPong: false,
    missedPongs: 0,
  };

  heartbeatTimers.set(daemonId, state);
}

function sendHeartbeatPing(ws: ServerWebSocket<WsConnectionData>, daemonId: string): void {
  const state = heartbeatTimers.get(daemonId);
  if (state === undefined) return;

  if (state.awaitingPong) {
    // Already waiting for a pong: this means we missed one
    state.missedPongs++;
    logger.warn(
      {
        event: DAEMON_HEARTBEAT_LOG_EVENTS.pong_missed,
        daemonId,
        missedPongs: state.missedPongs,
      },
      "Heartbeat pong not received",
    );
  }

  state.awaitingPong = true;

  ws.sendText(
    JSON.stringify({
      type: "heartbeat:ping",
      ...createMessageEnvelope(),
      payload: {},
    }),
  );

  // Start pong timeout
  if (state.pongTimer !== null) clearTimeout(state.pongTimer);
  state.pongTimer = setTimeout(() => {
    logger.warn(
      { event: DAEMON_HEARTBEAT_LOG_EVENTS.timeout, daemonId },
      "Heartbeat timeout, closing connection (FM-2)",
    );
    ws.close(WS_CLOSE_CODES.HEARTBEAT_TIMEOUT.code, WS_CLOSE_CODES.HEARTBEAT_TIMEOUT.reason);
  }, config.heartbeatTimeoutMs);
}

function handleHeartbeatPong(
  ws: ServerWebSocket<WsConnectionData>,
  msg: Extract<DaemonMessage, { type: "heartbeat:pong" }>,
): void {
  const daemonId = ws.data.daemonId;
  if (daemonId === undefined) return;

  const state = heartbeatTimers.get(daemonId);
  if (state === undefined) return;

  if (state.pongTimer !== null) {
    clearTimeout(state.pongTimer);
    state.pongTimer = null;
  }
  state.awaitingPong = false;
  state.missedPongs = 0;

  const info = daemonInfoMap.get(daemonId);
  if (info !== undefined) {
    info.capabilities.resources = msg.payload.resources;
    info.activeJobs = msg.payload.activeJobs;
    info.lastSeenAt = Date.now();
    void refreshDaemonTtl(daemonId, info.capabilities).catch((err: unknown) => {
      logger.error(
        { event: DAEMON_HEARTBEAT_LOG_EVENTS.ttl_refresh_failed, err, daemonId },
        "Failed to refresh daemon TTL",
      );
    });
  }
}

// daemon:draining handler

function handleDraining(
  ws: ServerWebSocket<WsConnectionData>,
  msg: Extract<DaemonMessage, { type: "daemon:draining" }>,
): void {
  const daemonId = ws.data.daemonId;
  if (daemonId === undefined) return;

  drainingDaemons.add(daemonId);
  const info = daemonInfoMap.get(daemonId);
  if (info !== undefined) {
    info.status = "draining";
  }

  logger.info(
    { daemonId, activeJobs: msg.payload.activeJobs, reason: msg.payload.reason },
    "Daemon draining, removed from dispatch eligibility",
  );
}

// daemon:update-acknowledged handler

function handleUpdateAcknowledged(
  ws: ServerWebSocket<WsConnectionData>,
  msg: Extract<DaemonMessage, { type: "daemon:update-acknowledged" }>,
): void {
  const protocolUpdate = protocolUpdateTransitions.get(ws);
  if (protocolUpdate !== undefined) {
    if (protocolUpdate.phase === "draining") return;
    clearTimeout(protocolUpdate.timer);
    const timer = setTimeout(() => {
      protocolUpdateTransitions.delete(ws);
      ws.close(
        WS_CLOSE_CODES.INCOMPATIBLE_PROTOCOL.code,
        WS_CLOSE_CODES.INCOMPATIBLE_PROTOCOL.reason,
      );
    }, config.daemonDrainTimeoutMs + PROTOCOL_UPDATE_DRAIN_GRACE_MS);
    timer.unref();
    protocolUpdateTransitions.set(ws, {
      daemonId: protocolUpdate.daemonId,
      phase: "draining",
      timer,
    });
    logger.info(
      {
        daemonId: protocolUpdate.daemonId,
        strategy: msg.payload.strategy,
        delayMs: msg.payload.delayMs,
      },
      "Outdated daemon acknowledged protocol update",
    );
    return;
  }

  const daemonId = ws.data.daemonId;
  if (daemonId === undefined) return;

  const info = daemonInfoMap.get(daemonId);
  if (info !== undefined) {
    info.status = "updating";
  }

  logger.info(
    { daemonId, strategy: msg.payload.strategy, delayMs: msg.payload.delayMs },
    "Daemon acknowledged update",
  );
}

/**
 * Best-effort release of the scheduled-action single-flight lock on a
 * terminal path. `clearInFlightByJobId` updates WHERE in_flight_job_id =
 * deliveryId, so it is a no-op for any deliveryId that is not a
 * scheduled-action in-flight job, safe to call unconditionally. Without
 * this the lock would persist until the stale window, skipping every cron
 * slot of a sub-stale-window action whose run died on a non-completion
 * path (cancelled, orphaned, or failed before dispatch).
 */
async function releaseScheduledActionLock(deliveryId: string): Promise<void> {
  try {
    await clearInFlightByJobId(deliveryId);
  } catch (err) {
    logger.warn({ err, deliveryId }, "failed to release scheduled-action lock on terminal path");
  }
}

// Job message handling (T032-T033)

/**
 * Server-side bridge for `scoped-job:completion` (T033b). The daemon
 * executor reports the structured outcome here; the orchestrator releases
 * the pending offer + capacity slot and emits a telemetry log line. The
 * user-facing Octokit reply is posted by the daemon executor itself
 * (using the installation token it already holds), so this handler
 * does not need to format another comment: doing so would double-post.
 *
 * Validation: payload arrives via the Zod discriminated union from
 * `serverMessageSchema` / `daemonMessageSchema` parse, so unknown
 * `jobKind` values are rejected at the WS boundary before reaching this
 * function.
 */
async function handleScopedJobCompletion(
  ws: ServerWebSocket<WsConnectionData>,
  msg: Extract<DaemonMessage, { type: "scoped-job:completion" }>,
): Promise<void> {
  const daemonId = ws.data.daemonId;
  const offerId = msg.payload.offerId;
  const { jobKind, status, deliveryId } = msg.payload;

  // Reject completions from sockets that have not finished registration,
  // a pre-register socket (or a misbehaving daemon) must not be able to
  // mutate another daemon's offer state or capacity counters.
  if (daemonId === undefined) {
    sendError(ws, msg.id, WS_ERROR_CODES.INTERNAL_ERROR, "Daemon not registered");
    return;
  }

  // Ownership + late-result guard. The in-memory offer is removed by
  // handleAccept right after dispatch to handleScopedAccept, so by the
  // time a real scoped-job:completion arrives `getPendingOffer(offerId)`
  // is almost always undefined and an offer-based check is ineffective.
  // Mirror handleResult: validate against durable execution state so a
  // replayed/forged completion cannot decrement capacity counters or
  // finalize an execution it does not own.
  const state = await getExecutionState(deliveryId);
  if (state?.daemonId !== daemonId || state.status === "completed" || state.status === "failed") {
    logger.warn(
      {
        event: "ws.scoped_completion.unauthorized",
        daemonId,
        offerId,
        deliveryId,
        assignedDaemon: state?.daemonId ?? null,
        currentStatus: state?.status ?? null,
      },
      "scoped-job:completion failed ownership/finality validation, ignoring",
    );
    return;
  }

  // Best-effort cleanup of the in-memory offer entry (may already be gone).
  const offer = getPendingOffer(offerId);
  if (offer !== undefined) {
    removePendingOffer(offerId);
  }

  // Capacity slot ownership: handleAccept incremented when the daemon
  // claimed the offer; the scoped completion path replaces handleResult
  // for these jobs, so the matching decrements MUST happen here for both
  // succeeded and halted/failed branches. Otherwise every scoped run leaks
  // one slot until the daemon disconnects. Decrements come AFTER the
  // durable guard so a forged completion cannot tamper with capacity.
  decrementActiveCount();
  await decrementDaemonActiveJobs(daemonId);

  // Release the scheduled-action single-flight lock now the run is terminal
  // (success or failure). Best-effort: a lock-release DB failure must not
  // throw past this point and skip `finalizeScopedExecution` below.
  if (jobKind === "scheduled-action") {
    await releaseScheduledActionLock(deliveryId);
  }

  // Per-kind event keys match the FR-018 canonical names documented in
  // `docs/OBSERVABILITY.md` (e.g. `ship.scoped.rebase.daemon.completed`).
  const kindKey = jobKind.replace(/^scoped-/, "").replaceAll("-", "_");

  if (status === "succeeded") {
    logger.info(
      {
        event: `ship.scoped.${kindKey}.daemon.completed`,
        daemonId,
        offerId,
        deliveryId,
        jobKind,
      },
      "scoped-job daemon reported success",
    );
    await finalizeScopedExecution(deliveryId, "succeeded");
    return;
  }

  // halted / failed paths: surface the reason as a structured log line so
  // operators can see why an executor halted without tailing the daemon
  // pod's stderr. Tracking-comment / thread-reply was already posted by
  // the daemon executor with the installation token.
  logger.warn(
    {
      event: `ship.scoped.${kindKey}.daemon.failed`,
      daemonId,
      offerId,
      deliveryId,
      jobKind,
      status,
      reason: msg.payload.reason ?? null,
    },
    "scoped-job daemon reported non-success",
  );
  await finalizeScopedExecution(deliveryId, status);
}

/**
 * Finalize the executions row for a scoped completion.
 *
 * `succeeded` and `halted` both leave the row out of the failed state,
 * `halted` is the contractual outcome for scaffolding-only executors and
 * for "no work needed" cases (e.g., rebase already up-to-date). Only
 * `failed` writes the failure reason so operator dashboards can branch
 * on the outcome.
 */
async function finalizeScopedExecution(
  deliveryId: string,
  status: "succeeded" | "halted" | "failed",
): Promise<void> {
  if (status === "failed") {
    try {
      await markExecutionFailed(deliveryId, "scoped-job daemon failed");
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), deliveryId },
        "markExecutionFailed for scoped completion failed (non-fatal)",
      );
    }
    return;
  }
  // succeeded / halted, handleScopedAccept already called
  // markExecutionRunning, so the row is in 'running'. Without a terminal
  // write here, succeeded/halted scoped executions stay 'running' forever,
  // which breaks the FM-4 stale-execution recovery and any operator query
  // that filters on terminal status. `markExecutionCompleted` only flips
  // rows where status='running', so it is safe even if a competing path
  // already finalized.
  try {
    await markExecutionCompleted(deliveryId, {});
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), deliveryId, status },
      "markExecutionCompleted for scoped completion failed (non-fatal)",
    );
  }
}

function handleJobMessage(ws: ServerWebSocket<WsConnectionData>, msg: DaemonMessage): void {
  const daemonId = ws.data.daemonId;
  if (daemonId === undefined) {
    sendError(ws, msg.id, WS_ERROR_CODES.INTERNAL_ERROR, "Daemon not registered");
    return;
  }

  switch (msg.type) {
    case "job:accept":
      void handleAccept(daemonId, msg);
      break;
    case "job:reject":
      void handleReject(msg);
      break;
    case "job:status":
      handleStatus(daemonId, msg);
      break;
    case "job:result":
      void handleResult(daemonId, msg);
      break;
    default:
      break;
  }
}

/**
 * Drop `instructions` from the Gate-2 policy for every workflow but `review`.
 *
 * The pipeline renders `instructions` as trusted repo policy that OVERRIDES
 * the agent's default heuristics. That surface was designed for `review`
 * alone. The schema scopes the field to `workflows.review` today,
 * so this is a no-op guard, but keeping the restriction here means a future
 * hoist to `defaults` cannot silently hand `implement` (which writes code and
 * pushes commits) an override block with no pipeline change to review.
 *
 * Enforced at the accept site, not in the daemon: the daemon stays dumb about
 * which knobs each workflow may see. Exported so the guard can be tested
 * directly: the schema makes the bad input unreachable through YAML today,
 * which is exactly why the guard needs its own test.
 */
export function stripInstructionsUnlessReview(
  policy: AgentPolicy | undefined,
  workflowName: string | undefined,
): AgentPolicy | undefined {
  if (policy?.instructions === undefined || workflowName === "review") return policy;
  const { instructions: _dropped, ...rest } = policy;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

async function handleAccept(
  daemonId: string,
  msg: Extract<DaemonMessage, { type: "job:accept" }>,
): Promise<void> {
  const offerId = msg.id;
  const offer = getPendingOffer(offerId);
  if (offer === undefined) {
    logger.warn({ offerId, daemonId }, "Accept for unknown/expired offer");
    return;
  }

  // C2: Immediately claim the offer and clear its timeout to prevent a race
  // where the timeout fires during async work below and re-queues the job.
  removePendingOffer(offerId);

  // dispatcher.offer.accepted: emitted here, the instant the accept arrives, so
  // offer_latency_ms is the daemon's WebSocket round-trip and excludes the
  // orchestrator-side context lookup + token mint that follow. Sits above the
  // legacy/scoped split, so one emit covers both job kinds. `kind` is omitted:
  // the authoritative job.kind is on the offer.sent line, correlated by offerId,
  // so re-deriving a lossy scoped/non-scoped value under the same key would only
  // collide vocabularies for an operator grouping by kind.
  logger.info(
    {
      event: DISPATCHER_LOG_EVENTS.offer_accepted,
      deliveryId: offer.deliveryId,
      daemonId,
      offerId,
      offer_latency_ms: Date.now() - offer.offeredAt,
    },
    "Job offer accepted by daemon",
  );

  // Capacity slot is owned here: take one when the daemon claims, release
  // in handleResult or in the error paths below. Every accept path must
  // therefore decrement on failure to keep the counter balanced.
  incrementActiveCount();
  await incrementDaemonActiveJobs(daemonId);
  await markExecutionRunning(offer.deliveryId);

  // Scoped jobs route via a different daemon executor (`runScopedJob`) and
  // do not need the legacy `executions.context_json` lookup or the
  // `BotContext`-shaped allowed-tool resolution. Mint the installation
  // token directly from `offer.scoped.installationId` and forward the
  // scoped payload verbatim. The `scoped-job:completion` handler decrements
  // capacity on completion.
  if (offer.scoped !== undefined) {
    await handleScopedAccept(daemonId, offerId, offer);
    return;
  }

  const { getDb } = await import("../db");
  const db = getDb();
  if (db === null) {
    logger.error({ offerId, daemonId }, "Database not available for context lookup");
    await markExecutionFailed(offer.deliveryId, "Database unavailable");
    await decrementDaemonActiveJobs(daemonId);
    decrementActiveCount();
    return;
  }

  const rows: { context_json: Record<string, unknown> | null }[] = await db`
    SELECT context_json FROM executions WHERE delivery_id = ${offer.deliveryId}
  `;
  const contextJson = rows[0]?.context_json ?? null;
  logger.debug(
    {
      offerId,
      daemonId,
      deliveryId: offer.deliveryId,
      rowCount: rows.length,
      hasContextJson: contextJson !== null,
      contextKeys: contextJson !== null ? Object.keys(contextJson) : [],
    },
    "Accept: executions row lookup",
  );
  if (contextJson === null) {
    logger.error(
      {
        offerId,
        daemonId,
        deliveryId: offer.deliveryId,
        rowCount: rows.length,
        hint:
          rows.length === 0
            ? "no executions row for this deliveryId, producer did not call createExecution"
            : "executions row exists but context_json is NULL, row was written without context",
      },
      "No execution context found",
    );
    await markExecutionFailed(offer.deliveryId, "Execution context not found");
    await decrementDaemonActiveJobs(daemonId);
    decrementActiveCount();
    return;
  }
  const owner = typeof contextJson["owner"] === "string" ? contextJson["owner"] : "";
  const repo = typeof contextJson["repo"] === "string" ? contextJson["repo"] : "";

  try {
    // PAT mode short-circuit: skip the per-request App lookup + installation
    // octokit construction entirely. Both App calls hit the GitHub API and
    // count against rate limits even though their result is discarded when
    // GITHUB_PERSONAL_ACCESS_TOKEN is set.
    // We keep an Octokit handle around in either mode so subsequent steps
    // (per-repo config fetch, 1.5.F) can reuse it without re-minting.
    let token: string;
    let acceptOctokit: Octokit;
    // App mode only: the installation id used to mint the token. Forwarded into
    // job:payload so the daemon's child logger can emit it (#177). Stays
    // undefined in PAT mode (no per-installation bucket to triage).
    let installationId: number | undefined;
    if (config.githubPersonalAccessToken !== undefined) {
      token = config.githubPersonalAccessToken;
      acceptOctokit = new Octokit({ auth: token });
    } else {
      const app = getOrCreateApp();
      const { data: installation } = await app.octokit.rest.apps.getRepoInstallation({
        owner,
        repo,
      });
      installationId = installation.id;
      ({ octokit: acceptOctokit, token } = await mintInstallationToken({
        app,
        installationId: installation.id,
        via: "handleAccept",
        log: logger,
      }));
    }

    // Gate 2: resolve `.github-app.yaml` into the agent knobs shipped with
    // the job. `loadRepoPolicy` is the only entry point used here on purpose,
    // it clamps `max_turns` / `timeout` against the server ceilings, so a
    // repo cannot raise them by editing YAML. Never throws: a missing,
    // unreachable, or invalid file yields DEFAULT_REPO_POLICY.
    const repoPolicy = await loadRepoPolicy({ octokit: acceptOctokit, owner, repo, log: logger });
    const executionPolicy = repoPolicy.defaults;

    // Repo value first, then the pre-Gate-2 env chain verbatim. Keeping the
    // env tail byte-identical is what makes a repo with no config file behave
    // exactly as before. `AGENT_MAX_TURNS` doubles as the CEILING the resolver
    // already clamped `workflowPolicy.maxTurns` against, so a repo can only
    // lower the cap here, never raise it.
    const maxTurns = executionPolicy.maxTurns ?? config.agentMaxTurns ?? config.defaultMaxTurns;
    const policy = stripInstructionsUnlessReview(
      toAgentPolicy(executionPolicy, repoPolicy.warning),
      undefined,
    );
    // `maxTurns` is checked separately: `toAgentPolicy` never projects it (it
    // rides the top-level payload field), so a repo whose only knob is
    // `max_turns` resolves to `policy === undefined` and would otherwise log
    // nothing at all, leaving "did this run honour the repo's knobs?"
    // unanswerable.
    if (policy !== undefined || executionPolicy.maxTurns !== undefined) {
      logger.info(
        {
          event: "repo_config.policy_applied",
          owner,
          repo,
          deliveryId: offer.deliveryId,
          workflow: "none",
          model: policy?.model,
          maxTurns,
          timeoutMs: policy?.timeoutMs,
          extraAllowedToolCount: policy?.extraAllowedTools?.length ?? 0,
          pathFilterCount: policy?.pathFilters?.length ?? 0,
          // Text stays out of the log line: it can be 10KB of repo prose.
          hasInstructions: policy?.instructions !== undefined,
          warned: policy?.warning !== undefined,
        },
        "Per-repo agent policy applied",
      );
    }
    const { resolveAllowedTools } = await import("../core/prompt-builder");

    // Reconstruct a minimal BotContext-shaped object for resolveAllowedTools.
    // Only isPR and labels are read by the function.
    const ctxForTools = {
      isPR: contextJson["isPR"] === true,
      labels: Array.isArray(contextJson["labels"]) ? (contextJson["labels"] as string[]) : [],
    };

    // Look up daemon capabilities so repo_memory + daemon-specific tools are allowed
    const daemonInfo = getDaemonInfo(daemonId);

    // Load persistent repo knowledge for this owner/repo
    const { getRepoEnvVars, getRepoMemory } = await import("./repo-knowledge");
    const envVars = await getRepoEnvVars(owner, repo);
    const memory = await getRepoMemory(owner, repo);

    // Load review learnings (full owner+repo+global set). Daemon-side
    // review/resolve handlers filter by changed files before injecting into
    // the prompt. Fail-open: if the DB query throws for this single field,
    // dispatch without learnings rather than failing the whole job.
    // Master kill-switch via REVIEW_LEARNINGS_ENABLED env (default true).
    // Per-repo policy (1.5.F) from .github-app.yaml's `review_learnings`
    // block layers on top: if a repo opts out via `enabled: false`, we skip
    // the load entirely. `scope` and `max_age_days` are applied at query
    // time. Cache reuse: the existing scheduler ETag cache (per process)
    // means subsequent dispatches against the same repo are body-free.
    const reviewLearnings: ReviewLearning[] = config.reviewLearningsEnabled
      ? await loadReviewLearningsForJob(acceptOctokit, owner, repo, contextJson)
      : [];

    handleJobAccept({
      offerId,
      daemonId,
      deliveryId: offer.deliveryId,
      installationToken: token,
      ...(installationId !== undefined ? { installationId } : {}),
      contextJson,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      allowedTools: resolveAllowedTools(
        ctxForTools as Parameters<typeof resolveAllowedTools>[0],
        daemonInfo?.capabilities,
      ),
      envVars,
      memory,
      ...(reviewLearnings.length > 0
        ? {
            reviewLearnings: reviewLearnings.map((l) => ({
              id: l.id,
              scope: l.scope,
              fileGlob: l.fileGlob,
              directive: l.directive,
              rationale: l.rationale,
              sourcePr: l.sourcePr,
              sourceThread: l.sourceThread,
              sourceAuthor: l.sourceAuthor,
              createdAt: l.createdAt.toISOString(),
            })),
          }
        : {}),
      ...(policy !== undefined ? { policy } : {}),
    });
  } catch (err) {
    logger.error({ err, offerId, daemonId }, "Failed to mint installation token for job");
    await markExecutionFailed(offer.deliveryId, "Failed to mint installation token");
    await decrementDaemonActiveJobs(daemonId);
    decrementActiveCount();
  }
}

/**
 * Mint a token for a scoped offer and forward the scoped context into
 * `job:payload`. Skips the legacy `executions.context_json` shape and the
 * `BotContext`-shaped allowed-tool resolution: scoped executors run their
 * own deterministic / single-purpose pipelines on the daemon side.
 *
 * Capacity decrement on success happens in `handleScopedJobCompletion`;
 * failure paths here decrement before returning.
 */
async function handleScopedAccept(
  daemonId: string,
  offerId: string,
  offer: PendingOfferLike,
): Promise<void> {
  // `offer.scoped` is typed `unknown` in the shared module; revalidate
  // with the discriminated union before casting (mirrors job-dispatcher's
  // reconstructJobFromOffer guard).
  const reparsed = QueuedJobSchema.safeParse(offer.scoped);
  if (!reparsed.success || !isScopedJob(reparsed.data)) {
    logger.error(
      {
        offerId,
        daemonId,
        deliveryId: offer.deliveryId,
        issues: reparsed.success ? "shape-not-scoped" : reparsed.error.issues,
      },
      "Scoped accept: offer.scoped failed re-validation",
    );
    await markExecutionFailed(offer.deliveryId, "Scoped offer payload malformed");
    await releaseScheduledActionLock(offer.deliveryId);
    await decrementDaemonActiveJobs(daemonId);
    decrementActiveCount();
    return;
  }
  const scopedJob: ScopedQueuedJob = reparsed.data;

  try {
    // Same PAT short-circuit as in handleJobOfferAccept, `getInstallationOctokit`
    // hits the GitHub API to mint a token, which is wasted work in PAT mode.
    let token: string;
    if (config.githubPersonalAccessToken !== undefined) {
      token = config.githubPersonalAccessToken;
    } else {
      const app = getOrCreateApp();
      ({ token } = await mintInstallationToken({
        app,
        installationId: scopedJob.installationId,
        via: "handleScopedAccept",
        log: logger,
      }));
    }

    handleJobAccept({
      offerId,
      daemonId,
      deliveryId: offer.deliveryId,
      installationToken: token,
      // Scoped daemon executors do not read `context`/`allowedTools`/`envVars`/
      // `memory`; pass minimal/empty shapes to satisfy the schema.
      contextJson: {},
      allowedTools: [],
      envVars: {},
      memory: [],
      scoped: scopedJobToContext(scopedJob),
    });
  } catch (err) {
    logger.error(
      { err, offerId, daemonId, jobKind: scopedJob.kind },
      "Scoped accept: failed to mint installation token",
    );
    await markExecutionFailed(offer.deliveryId, "Failed to mint installation token (scoped)");
    await releaseScheduledActionLock(offer.deliveryId);
    await decrementDaemonActiveJobs(daemonId);
    decrementActiveCount();
  }
}

/** Narrow type, only the fields handleScopedAccept needs from PendingOffer.
 * `scoped` is optional on the source but is checked non-undefined at the
 * call site, so the helper can require it. */
interface PendingOfferLike {
  readonly deliveryId: string;
  readonly scoped?: unknown;
}

/**
 * Convert a `ScopedQueuedJob` (queue-side shape) into the `ScopedJobContext`
 * shape consumed by `runScopedJob` (daemon-side schema). The two schemas
 * carry the same fields but the queue uses `kind` while the daemon context
 * uses `jobKind`; this keeps the wire format faithful to
 * `contracts/ws-messages.md`.
 */
function scopedJobToContext(job: ScopedQueuedJob): ScopedJobContext {
  switch (job.kind) {
    case "scoped-rebase":
      return {
        jobKind: "scoped-rebase",
        deliveryId: job.deliveryId,
        installationId: job.installationId,
        owner: job.repoOwner,
        repo: job.repoName,
        prNumber: job.prNumber,
        triggerCommentId: job.triggerCommentId,
        enqueuedAt: job.enqueuedAt,
      };
    case "scoped-fix-thread":
      return {
        jobKind: "scoped-fix-thread",
        deliveryId: job.deliveryId,
        installationId: job.installationId,
        owner: job.repoOwner,
        repo: job.repoName,
        prNumber: job.prNumber,
        threadRef: job.threadRef,
        triggerCommentId: job.triggerCommentId,
        enqueuedAt: job.enqueuedAt,
      };
    case "scoped-open-pr":
      return {
        jobKind: "scoped-open-pr",
        deliveryId: job.deliveryId,
        installationId: job.installationId,
        owner: job.repoOwner,
        repo: job.repoName,
        issueNumber: job.issueNumber,
        triggerCommentId: job.triggerCommentId,
        enqueuedAt: job.enqueuedAt,
        verdictSummary: job.verdictSummary,
      };
    case "scheduled-action":
      return {
        jobKind: "scheduled-action",
        deliveryId: job.deliveryId,
        installationId: job.installationId,
        owner: job.repoOwner,
        repo: job.repoName,
        actionName: job.actionName,
        cronSlotIso: job.cronSlotIso,
        promptText: job.promptText,
        ...(job.model !== undefined ? { model: job.model } : {}),
        ...(job.maxTurns !== undefined ? { maxTurns: job.maxTurns } : {}),
        ...(job.timeoutMs !== undefined ? { timeoutMs: job.timeoutMs } : {}),
        ...(job.allowedTools !== undefined ? { allowedTools: job.allowedTools } : {}),
        autoMerge: job.autoMerge,
        enqueuedAt: job.enqueuedAt,
      };
  }
}

async function handleReject(msg: Extract<DaemonMessage, { type: "job:reject" }>): Promise<void> {
  await handleJobReject(msg.id, msg.payload.reason);
}

function handleStatus(daemonId: string, msg: Extract<DaemonMessage, { type: "job:status" }>): void {
  logger.info(
    { daemonId, offerId: msg.id, status: msg.payload.status, message: msg.payload.message },
    "Job status update from daemon",
  );
}

/**
 * Resolve the deliveryId for a job result using a 3-tier strategy:
 * 1. Pending offer map (primary)
 * 2. Daemon-provided payload field (fallback)
 * 3. Database query for the daemon's running execution (last resort)
 */
async function resolveDeliveryId(
  offerId: string,
  daemonId: string,
  payloadDeliveryId: string | undefined,
): Promise<string | undefined> {
  const offer = getPendingOffer(offerId);
  const deliveryId = offer?.deliveryId ?? payloadDeliveryId;
  if (deliveryId !== undefined) return deliveryId;

  logger.debug({ offerId, daemonId }, "Result for offer not in pending map, querying DB");
  const { getDb } = await import("../db");
  const db = getDb();
  if (db === null) return undefined;

  const rows: { delivery_id: string }[] = await db`
    SELECT delivery_id FROM executions
    WHERE daemon_id = ${daemonId} AND status IN ('offered', 'running')
    ORDER BY started_at DESC NULLS LAST LIMIT 1
  `;
  const row = rows[0];
  if (row === undefined) return undefined;

  logger.info(
    { offerId, daemonId, deliveryId: row.delivery_id },
    "Resolved deliveryId from DB fallback",
  );
  return row.delivery_id;
}

/**
 * Resolve the review-learnings universe to ship in this job's payload.
 * Wraps three layers (per-repo `.github-app.yaml` opt-out from 1.5.F,
 * RAG-vs-deterministic split from 1.5.H, fail-open dispatch) into one
 * helper so `handleAccept` stays under the max-depth lint cap.
 *
 * Returns `[]` on any failure: the dispatch proceeds without learnings
 * rather than dropping the whole job.
 */
async function loadReviewLearningsForJob(
  octokit: Octokit,
  owner: string,
  repo: string,
  contextJson: Record<string, unknown>,
): Promise<ReviewLearning[]> {
  try {
    const [configFetcherModule, configSchemaModule] = await Promise.all([
      import("../repo-config/fetcher"),
      import("../repo-config/schema"),
    ]);
    const repoConfig = await configFetcherModule.fetchRepoConfig({
      octokit,
      owner,
      repo,
      path: config.repoConfigFile,
      log: logger,
    });
    const rlConfig =
      repoConfig.kind === "ok"
        ? repoConfig.config.review_learnings
        : configSchemaModule.DEFAULT_REVIEW_LEARNINGS_CONFIG;
    if (!rlConfig.enabled) return [];

    const reviewLearningsModule = await import("./review-learnings");
    const loadFilter = { scope: rlConfig.scope, maxAgeDays: rlConfig.max_age_days };

    // RAG mode (1.5.H): only meaningful for PR-shaped jobs since we use the
    // changed-file paths as the embedding query. Falls back to the
    // deterministic load on any failure inside searchReviewLearningsByEmbedding.
    const isPRJob = contextJson["isPR"] === true;
    const entityNumber = contextJson["entityNumber"];
    if (config.reviewLearningsRagEnabled && isPRJob && typeof entityNumber === "number") {
      return await loadReviewLearningsRag(
        octokit,
        owner,
        repo,
        entityNumber,
        loadFilter,
        reviewLearningsModule,
      );
    }
    return await reviewLearningsModule.loadReviewLearnings(owner, repo, loadFilter);
  } catch (err) {
    logger.warn({ err, owner, repo }, "Failed to load review learnings; dispatching without");
    return [];
  }
}

/**
 * RAG branch (1.5.H): fetch the PR's changed-file list, embed each path,
 * and run the pgvector top-K search. Falls back to the deterministic load
 * if the file-list fetch fails.
 */
async function loadReviewLearningsRag(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  loadFilter: { scope: "local" | "global"; maxAgeDays: number | null },
  reviewLearningsModule: ReviewLearningsModule,
): Promise<ReviewLearning[]> {
  try {
    const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });
    const fileNames = files.map((f) => f.filename);
    return await reviewLearningsModule.searchReviewLearningsByEmbedding(owner, repo, fileNames, {
      filter: loadFilter,
    });
  } catch (err) {
    logger.warn(
      { err, owner, repo, prNumber },
      "RAG file-list fetch failed; falling back to non-RAG load",
    );
    return reviewLearningsModule.loadReviewLearnings(owner, repo, loadFilter);
  }
}

/** Persist execution outcome to the database. */
async function finalizeExecution(
  deliveryId: string,
  payload: {
    success: boolean;
    costUsd?: number | undefined;
    durationMs?: number | undefined;
    numTurns?: number | undefined;
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    cacheReadInputTokens?: number | undefined;
    cacheCreationInputTokens?: number | undefined;
    modelUsage?: readonly ModelUsageEntry[] | undefined;
    errorMessage?: string | undefined;
  },
): Promise<void> {
  if (payload.success) {
    const result: {
      costUsd?: number;
      durationMs?: number;
      numTurns?: number;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      modelUsage?: readonly ModelUsageEntry[];
    } = {};
    if (payload.costUsd !== undefined) result.costUsd = payload.costUsd;
    if (payload.durationMs !== undefined) result.durationMs = payload.durationMs;
    if (payload.numTurns !== undefined) result.numTurns = payload.numTurns;
    if (payload.inputTokens !== undefined) result.inputTokens = payload.inputTokens;
    if (payload.outputTokens !== undefined) result.outputTokens = payload.outputTokens;
    if (payload.cacheReadInputTokens !== undefined) {
      result.cacheReadInputTokens = payload.cacheReadInputTokens;
    }
    if (payload.cacheCreationInputTokens !== undefined) {
      result.cacheCreationInputTokens = payload.cacheCreationInputTokens;
    }
    if (payload.modelUsage !== undefined) result.modelUsage = payload.modelUsage;
    await markExecutionCompleted(deliveryId, result);
  } else {
    await markExecutionFailed(deliveryId, payload.errorMessage ?? "Execution failed on daemon");
    // A scoped run cancelled or failed via job:result terminates here, not
    // through handleScopedJobCompletion: release the lock so later cron
    // slots are not skipped while the dead run holds it.
    await releaseScheduledActionLock(deliveryId);
  }
}

/**
 * Handle job:result, FM-6 late result guard + finalize execution.
 */
async function handleResult(
  daemonId: string,
  msg: Extract<DaemonMessage, { type: "job:result" }>,
): Promise<void> {
  const offerId = msg.id;
  const actualDeliveryId = await resolveDeliveryId(offerId, daemonId, msg.payload.deliveryId);

  // Decrement active jobs (daemon-side Valkey counter + webhook concurrency counter)
  await decrementDaemonActiveJobs(daemonId);
  decrementActiveCount();

  removePendingOffer(offerId);

  if (actualDeliveryId === undefined) return;

  // FM-6: Late result guard, check if execution is already finalized
  const state = await getExecutionState(actualDeliveryId);
  if (state !== null) {
    if (state.status === "completed" || state.status === "failed") {
      logger.info(
        { deliveryId: actualDeliveryId, daemonId, currentStatus: state.status },
        "Late result received for already-finalized execution (FM-6), discarding",
      );
      return;
    }

    if (state.daemonId !== null && state.daemonId !== daemonId) {
      logger.info(
        { deliveryId: actualDeliveryId, daemonId, assignedDaemonId: state.daemonId },
        "Result from non-assigned daemon (FM-6), discarding",
      );
      return;
    }
  }

  // Finalize execution
  await finalizeExecution(actualDeliveryId, msg.payload);

  // Persist learnings and process deletions from daemon execution. Covers
  // both repo_memory (general learnings) and review_learnings (review-policy
  // directives) since both ride the same .daemon-actions.json round-trip.
  const learnings = msg.payload.learnings;
  const deletions = msg.payload.deletions;
  const reviewLearningSaves = msg.payload.reviewLearningSaves;
  const reviewLearningDeletes = msg.payload.reviewLearningDeletes;
  const appliedReviewLearningIds = msg.payload.appliedReviewLearningIds;

  if (
    (learnings !== undefined && learnings.length > 0) ||
    (deletions !== undefined && deletions.length > 0) ||
    (reviewLearningSaves !== undefined && reviewLearningSaves.length > 0) ||
    (reviewLearningDeletes !== undefined && reviewLearningDeletes.length > 0) ||
    (appliedReviewLearningIds !== undefined && appliedReviewLearningIds.length > 0)
  ) {
    try {
      await persistRepoKnowledge({
        deliveryId: actualDeliveryId,
        daemonActions: {
          learnings: learnings ?? [],
          deletions: deletions ?? [],
          ...(reviewLearningSaves !== undefined ? { reviewLearningSaves } : {}),
          ...(reviewLearningDeletes !== undefined ? { reviewLearningDeletes } : {}),
        },
        ...(appliedReviewLearningIds !== undefined ? { appliedReviewLearningIds } : {}),
      });
    } catch (err) {
      logger.error({ err, deliveryId: actualDeliveryId }, "Failed to persist repo knowledge");
    }
  }

  logger.info(
    {
      deliveryId: actualDeliveryId,
      daemonId,
      success: msg.payload.success,
      durationMs: msg.payload.durationMs,
      costUsd: msg.payload.costUsd,
    },
    "Job result received and recorded",
  );
}
