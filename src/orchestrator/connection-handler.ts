import type { ServerWebSocket } from "bun";
import { App, Octokit } from "octokit";

import { config } from "../config";
import { resolveGithubToken } from "../core/github-token";
import { clearInFlightByJobId } from "../db/queries/scheduled-actions-store";
import { logger } from "../logger";
import { observableOctokit } from "../utils/octokit-observability";
import { addReaction } from "../utils/reactions";
import { findById, findInflightByOwner, type WorkflowRunRow } from "../workflows/runs-store";
import { setState } from "../workflows/tracking-mirror";
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
  createMessageEnvelope,
  type DaemonMessage,
  type ScopedJobContext,
  WS_CLOSE_CODES,
  WS_ERROR_CODES,
} from "../shared/ws-messages";
import { decrementActiveCount, incrementActiveCount } from "./concurrency";
import {
  decrementDaemonActiveJobs,
  deregisterDaemon,
  incrementDaemonActiveJobs,
  refreshDaemonTtl,
  registerDaemon,
} from "./daemon-registry";
import {
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
import { sendError, type WsConnectionData } from "./ws-server";

// In-memory state (per orchestrator process)

const connections = new Map<string, ServerWebSocket<WsConnectionData>>();
const daemonInfoMap = new Map<string, DaemonInfo>();
const heartbeatTimers = new Map<string, HeartbeatState>();

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
  const daemonId = ws.data.daemonId;
  if (daemonId === undefined) return;

  const hb = heartbeatTimers.get(daemonId);
  if (hb !== undefined) {
    clearInterval(hb.intervalTimer);
    if (hb.pongTimer !== null) clearTimeout(hb.pongTimer);
    heartbeatTimers.delete(daemonId);
  }

  connections.delete(daemonId);
  daemonInfoMap.delete(daemonId);
  drainingDaemons.delete(daemonId);

  // Async cleanup: deregister from Valkey/Postgres, handle orphaned executions
  void cleanupAfterDisconnect(daemonId);
}

/**
 * Async cleanup after daemon disconnect (FM-1).
 * Deregisters daemon and marks orphaned executions as failed.
 */
async function cleanupAfterDisconnect(daemonId: string): Promise<void> {
  try {
    await deregisterDaemon(daemonId);

    // Scan for orphaned executions
    const orphans = await getOrphanedExecutions(daemonId);
    for (const orphan of orphans) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await markExecutionFailed(orphan.deliveryId, "daemon disconnected during execution");
        // eslint-disable-next-line no-await-in-loop
        await releaseScheduledActionLock(orphan.deliveryId);
      } catch (err) {
        logger.error(
          { err, deliveryId: orphan.deliveryId },
          "Failed to mark orphaned execution as failed",
        );
      }
    }

    if (orphans.length > 0) {
      logger.warn(
        { daemonId, orphanCount: orphans.length },
        "Cleaned up orphaned executions after daemon disconnect",
      );
    }

    // User-facing notification: any in-flight workflow_runs owned by this
    // daemon will be flipped to 'failed' by the liveness reaper. We update
    // the user's tracking comment + react on the trigger comment now so the
    // user sees the failure immediately instead of staring at a stale
    // "starting…" comment.
    await notifyOrphanedWorkflowRuns(daemonId);
  } catch (err) {
    logger.error({ err, daemonId }, "Failed to cleanup after daemon disconnect");
  }
}

/**
 * Update the user-facing tracking comment + add a `confused` reaction on the
 * originating comment for every in-flight workflow_run owned by the dying
 * daemon. Walks the parent chain so a child step's failure shows up on the
 * top-level run's surface (the surface the user is actually watching) rather
 * than on a per-child comment they may not have noticed.
 *
 * Best-effort throughout: a missing GitHub App config or a comment-update
 * failure must never bubble up and prevent the rest of cleanup from running.
 */
async function notifyOrphanedWorkflowRuns(daemonId: string): Promise<void> {
  let inflight: WorkflowRunRow[];
  try {
    inflight = await findInflightByOwner("daemon", daemonId);
  } catch (err) {
    logger.error({ err, daemonId }, "Failed to query in-flight workflow_runs for orphan cleanup");
    return;
  }

  if (inflight.length === 0) return;

  // Dedupe by ancestor so a single ship cascade (ship → plan → implement)
  // only updates one comment + one reaction even if multiple of its rows
  // were owned by this daemon at the moment of disconnect.
  const ancestorIds = new Set<string>();
  for (const row of inflight) {
    // eslint-disable-next-line no-await-in-loop
    const ancestor = await findTopAncestor(row);
    if (ancestor === null) continue;
    if (ancestorIds.has(ancestor.id)) continue;
    ancestorIds.add(ancestor.id);

    try {
      // eslint-disable-next-line no-await-in-loop
      await postOrphanNotification(ancestor);
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          ancestorRunId: ancestor.id,
          daemonId,
        },
        "Orphan notification (comment/reaction) failed",
      );
    }
  }
}

/**
 * Walk parent_run_id up to the topmost row. Returns the input row if it has
 * no parent, or null if the parent chain is broken (orphaned mid-walk) or
 * exceeds the safety cap. Returning the cap-iteration row would be a silent
 * bug: it still has a non-null parent_run_id, so we'd update the wrong
 * (mid-chain) tracking comment.
 */
async function findTopAncestor(row: WorkflowRunRow): Promise<WorkflowRunRow | null> {
  let current: WorkflowRunRow | null = row;
  // Bound at 8 levels of nesting, defensive cap for a chain that should
  // realistically never exceed depth 2 (ship → step). A null parent ends
  // the walk naturally.
  for (let i = 0; i < 8; i++) {
    if (current === null) return null;
    if (current.parent_run_id === null) return current;
    // eslint-disable-next-line no-await-in-loop
    current = await findById(current.parent_run_id);
  }
  logger.warn(
    { startRunId: row.id, lastSeenRunId: current?.id ?? null },
    "findTopAncestor: parent chain exceeded 8 levels, skipping orphan notification to avoid touching the wrong comment",
  );
  return null;
}

async function postOrphanNotification(ancestor: WorkflowRunRow): Promise<void> {
  if (config.appId === undefined || config.privateKey === undefined) {
    logger.debug(
      { ancestorRunId: ancestor.id },
      "Skipping orphan notification, GitHub App credentials not configured",
    );
    return;
  }

  // PAT mode short-circuit: when GITHUB_PERSONAL_ACCESS_TOKEN is set, the
  // contract is that the PAT replaces the installation token for ALL GitHub
  // API calls, orphan-notification comments and reactions included, so the
  // operator-visible identity stays consistent with other bot replies.
  let octokit: Awaited<ReturnType<App["getInstallationOctokit"]>> | Octokit;
  if (config.githubPersonalAccessToken !== undefined) {
    octokit = new Octokit({ auth: config.githubPersonalAccessToken });
  } else {
    const app = getOrCreateApp();
    const { data: installation } = await app.octokit.rest.apps.getRepoInstallation({
      owner: ancestor.target_owner,
      repo: ancestor.target_repo,
    });
    octokit = await app.getInstallationOctokit(installation.id);
  }

  const humanMessage = [
    `❌ **Daemon disconnected during execution**, likely an OOM kill on the workflow pod.`,
    ``,
    `The in-flight step has been marked failed. Its workflow_run row will be flipped`,
    `to \`failed\` by the liveness reaper. To resume, re-trigger the workflow:`,
    ``,
    `- For \`ship\`: re-apply the \`bot:ship\` label, or comment again. Resume picks up`,
    `  from the failed step and reuses prior succeeded steps.`,
    `- For standalone workflows: re-comment with the same trigger.`,
  ].join("\n");

  // Re-uses tracking-mirror.setState so the cascade refresh and `_lastHumanMessage`
  // bookkeeping stay consistent, and so the parent's composite body picks up the
  // failure narrative on the next render.
  const installationOctokit = octokit as unknown as Octokit;
  await setState(
    { octokit: installationOctokit, logger },
    {
      runId: ancestor.id,
      patch: { phase: "orphaned" },
      humanMessage,
    },
  );

  if (ancestor.trigger_comment_id !== null && ancestor.trigger_event_type !== null) {
    await addReaction({
      octokit: installationOctokit,
      logger,
      owner: ancestor.target_owner,
      repo: ancestor.target_repo,
      commentId: ancestor.trigger_comment_id,
      eventType: ancestor.trigger_event_type,
      content: "confused",
    });
  }
}

/** Route validated daemon messages to type-specific handlers. */
export function handleDaemonMessage(
  ws: ServerWebSocket<WsConnectionData>,
  msg: DaemonMessage,
): void {
  switch (msg.type) {
    case "daemon:register":
      void handleRegister(ws, msg);
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
    case "scoped-job-completion":
      void handleScopedJobCompletion(ws, msg);
      break;
  }
}

// daemon:register handler (FM-8 reconnection logic)

async function handleRegister(
  ws: ServerWebSocket<WsConnectionData>,
  msg: Extract<DaemonMessage, { type: "daemon:register" }>,
): Promise<void> {
  const { daemonId } = msg.payload;

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

  // Version compatibility check (T042, Phase 7, basic check here)
  // Major protocol version mismatch -> reject
  const ourMajor = "1";
  const theirMajor = msg.payload.protocolVersion.split(".")[0];
  if (theirMajor !== ourMajor) {
    ws.close(
      WS_CLOSE_CODES.INCOMPATIBLE_PROTOCOL.code,
      WS_CLOSE_CODES.INCOMPATIBLE_PROTOCOL.reason,
    );
    return;
  }

  // Register in Valkey + Postgres
  try {
    const info = await registerDaemon(msg);
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
 * Server-side bridge for `scoped-job-completion` (T033b). The daemon
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
  msg: Extract<DaemonMessage, { type: "scoped-job-completion" }>,
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
  // time a real scoped-job-completion arrives `getPendingOffer(offerId)`
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
      "scoped-job-completion failed ownership/finality validation, ignoring",
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
  // scoped payload verbatim. The `scoped-job-completion` handler decrements
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
      acceptOctokit = await app.getInstallationOctokit(installation.id);
      token = await resolveGithubToken(acceptOctokit);
    }

    // No turn cap by default: workflows must run end-to-end without losing
    // progress to a mid-run cap. `AGENT_MAX_TURNS` and `DEFAULT_MAXTURNS`
    // remain as opt-in escape hatches for ops; when both are unset we pass
    // `undefined` to the SDK and the agent decides when it's done.
    const maxTurns = config.agentMaxTurns ?? config.defaultMaxTurns;
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
      ...(offer.workflowRun !== undefined ? { workflowRun: offer.workflowRun } : {}),
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
      const octokit = await app.getInstallationOctokit(scopedJob.installationId);
      token = await resolveGithubToken(octokit);
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
      import("../scheduler/config-fetcher"),
      import("../scheduler/config-schema"),
    ]);
    const repoConfig = await configFetcherModule.fetchRepoConfig({
      octokit,
      owner,
      repo,
      path: config.schedulerConfigFile,
      log: logger,
    });
    const rlConfig =
      repoConfig?.config.review_learnings ?? configSchemaModule.DEFAULT_REVIEW_LEARNINGS_CONFIG;
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

/**
 * Persist learnings and deletions from a daemon execution to repo_memory
 * and (for review/resolve workflows) review_learnings. Extracted to reduce
 * nesting depth in handleResult.
 */
async function persistRepoKnowledge(
  deliveryId: string,
  learnings: { category: string; content: string }[] | undefined,
  deletions: string[] | undefined,
  reviewLearningSaves:
    | {
        directive: string;
        rationale?: string | undefined;
        fileGlob?: string | undefined;
        scope?: "local" | "global" | undefined;
        sourcePr?: number | undefined;
        sourceThread?: string | undefined;
        sourceAuthor?: string | undefined;
      }[]
    | undefined,
  reviewLearningDeletes: string[] | undefined,
  appliedReviewLearningIds: string[] | undefined,
): Promise<void> {
  try {
    const { saveRepoLearnings, deleteRepoMemories } = await import("./repo-knowledge");
    const { requireDb } = await import("../db");
    const knowledgeDb = requireDb();
    const execRows: { repo_owner: string; repo_name: string }[] = await knowledgeDb`
      SELECT repo_owner, repo_name FROM executions WHERE delivery_id = ${deliveryId}
    `;
    const exec = execRows[0];
    if (exec === undefined) return;

    if (learnings !== undefined && learnings.length > 0) {
      const saved = await saveRepoLearnings(exec.repo_owner, exec.repo_name, learnings);
      if (saved > 0) {
        logger.info({ deliveryId, saved }, "Persisted repo learnings from execution");
      }
    }
    if (deletions !== undefined && deletions.length > 0) {
      const deleted = await deleteRepoMemories(deletions);
      if (deleted > 0) {
        logger.info({ deliveryId, deleted }, "Deleted outdated repo memories per daemon request");
      }
    }
    // Kill-switch: when disabled, drop any review-learning actions an agent
    // managed to emit (e.g. because the operator flipped the flag mid-run
    // or a daemon was started before the flag flipped). Log so the drop is
    // visible in audits.
    if (
      config.reviewLearningsEnabled &&
      reviewLearningSaves !== undefined &&
      reviewLearningSaves.length > 0
    ) {
      const { saveReviewLearnings } = await import("./review-learnings");
      const saved = await saveReviewLearnings(exec.repo_owner, exec.repo_name, reviewLearningSaves);
      if (saved > 0) {
        logger.info({ deliveryId, saved }, "Persisted review learnings from execution");
      }
    } else if (reviewLearningSaves !== undefined && reviewLearningSaves.length > 0) {
      logger.warn(
        { deliveryId, dropped: reviewLearningSaves.length },
        "Dropped review-learning saves: REVIEW_LEARNINGS_ENABLED=false",
      );
    }
    if (
      config.reviewLearningsEnabled &&
      reviewLearningDeletes !== undefined &&
      reviewLearningDeletes.length > 0
    ) {
      const { deleteReviewLearnings } = await import("./review-learnings");
      // Owner/repo-scoped delete: an id that doesn't belong to this job's
      // (owner, repo) is silently no-opped (1.5.D). The caller-supplied
      // exec.repo_owner / exec.repo_name come from the executions row we
      // already SELECTed above.
      const deleted = await deleteReviewLearnings(
        exec.repo_owner,
        exec.repo_name,
        reviewLearningDeletes,
      );
      if (deleted > 0) {
        logger.info(
          { deliveryId, deleted },
          "Deleted outdated review learnings per daemon request",
        );
      }
    } else if (reviewLearningDeletes !== undefined && reviewLearningDeletes.length > 0) {
      // Symmetric audit log: when the kill-switch is off and the daemon sent
      // deletes anyway (e.g. flag flipped mid-run), record the drop just like
      // we do for save actions above.
      logger.warn(
        { deliveryId, dropped: reviewLearningDeletes.length },
        "Dropped review-learning deletes: REVIEW_LEARNINGS_ENABLED=false",
      );
    }
    // 1.5.E: bump use_count for the IDs the daemon actually applied to a
    // prompt this run. Behind the same kill-switch.
    if (
      config.reviewLearningsEnabled &&
      appliedReviewLearningIds !== undefined &&
      appliedReviewLearningIds.length > 0
    ) {
      const { bumpReviewLearningUsage } = await import("./review-learnings");
      await bumpReviewLearningUsage(appliedReviewLearningIds);
      logger.info(
        { deliveryId, applied: appliedReviewLearningIds.length },
        "Bumped use_count for applied review learnings",
      );
    }
  } catch (err) {
    logger.error({ err, deliveryId }, "Failed to persist repo knowledge");
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
    errorMessage?: string | undefined;
  },
): Promise<void> {
  if (payload.success) {
    const result: { costUsd?: number; durationMs?: number; numTurns?: number } = {};
    if (payload.costUsd !== undefined) result.costUsd = payload.costUsd;
    if (payload.durationMs !== undefined) result.durationMs = payload.durationMs;
    if (payload.numTurns !== undefined) result.numTurns = payload.numTurns;
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
    await persistRepoKnowledge(
      actualDeliveryId,
      learnings,
      deletions,
      reviewLearningSaves,
      reviewLearningDeletes,
      appliedReviewLearningIds,
    );
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
