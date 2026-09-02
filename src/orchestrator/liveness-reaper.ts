import type { SQL } from "bun";

import { config } from "../config";
import { requireDb } from "../db";
import { clearInFlightByJobId } from "../db/queries/scheduled-actions-store";
import { logger } from "../logger";
import { WS_CLOSE_CODES } from "../shared/ws-messages";
import { reconcilePendingWorkflowCascades } from "../workflows/completion-reconciler";
import { publishPendingWorkflowRuns } from "../workflows/dispatch-outbox";
import {
  expireQueuedWorkflowDispatches,
  expireWorkflowAttempts,
  type WorkflowRunRow,
} from "../workflows/runs-store";
import { getConnections } from "./connection-handler";
import { failDaemonOwnershipInTransaction } from "./history";
import { getInstanceId } from "./instance-id";
import { requireValkeyClient } from "./valkey";
import { reapOrphanProcessingLists } from "./valkey-cleanup";
import {
  notifyExpiredWorkflowAttempts,
  notifyExpiredWorkflowDispatches,
} from "./workflow-expiry-notifier";
import { reconcileWorkflowRunners } from "./workflow-runner-reconciler";

const SCAN_BATCH = 100;
const ORCH_KEY_PREFIX = "orchestrator:";
const ORCH_KEY_SUFFIX = ":alive";

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<ReapResult> | null = null;

/**
 * Lease and heartbeat reaper for `workflow_runs` and the `daemons` table.
 *
 * Isolated workflow runners are fenced by their PostgreSQL lease. Legacy
 * orchestrator owners and shared-daemon registry rows use Valkey liveness:
 *
 *   - `orchestrator` owners → key `orchestrator:{owner_id}:alive`
 *     (published by `instance-liveness.ts`, 60s TTL, refreshed every 20s)
 *   - shared daemon owners   → key `daemon:{owner_id}`
 *
 * Each transition is conditional on the current owner, attempt, lease, and
 * status. Repeated passes therefore converge after the first successful write.
 */

async function listLiveOrchestratorIds(): Promise<string[]> {
  const valkey = requireValkeyClient();
  const ids: string[] = [];
  let cursor = "0";
  do {
    // eslint-disable-next-line no-await-in-loop, @typescript-eslint/no-unsafe-assignment -- Valkey SCAN returns [string, string[]]
    const result: [string, string[]] = await valkey.send("SCAN", [
      cursor,
      "MATCH",
      `${ORCH_KEY_PREFIX}*${ORCH_KEY_SUFFIX}`,
      "COUNT",
      String(SCAN_BATCH),
    ]);
    cursor = result[0];
    for (const key of result[1]) {
      if (!key.startsWith(ORCH_KEY_PREFIX) || !key.endsWith(ORCH_KEY_SUFFIX)) continue;
      const id = key.slice(ORCH_KEY_PREFIX.length, key.length - ORCH_KEY_SUFFIX.length);
      if (id !== "") ids.push(id);
    }
  } while (cursor !== "0");
  return ids;
}

async function listLiveDaemonIds(): Promise<string[]> {
  const valkey = requireValkeyClient();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Valkey SMEMBERS returns string[]
  const members: string[] = await valkey.send("SMEMBERS", ["active_daemons"]);
  const live: string[] = [];
  for (const id of members) {
    // eslint-disable-next-line no-await-in-loop, @typescript-eslint/no-unsafe-assignment -- Valkey EXISTS returns number
    const exists: number = await valkey.send("EXISTS", [`daemon:${id}`]);
    if (exists === 1) live.push(id);
  }
  return live;
}

interface ReapedRow {
  readonly id: string;
  readonly workflow_name: string;
  readonly owner_kind: "orchestrator" | "daemon" | null;
  readonly owner_id: string | null;
}

interface DeadDaemonReapResult {
  readonly rows: ReapedRow[];
  readonly daemonsMarkedInactive: number;
}

async function listDaemonCandidates(sql: SQL): Promise<string[]> {
  const rows: { id: string }[] = await sql`
    SELECT DISTINCT id
      FROM (
        SELECT id
          FROM daemons
         WHERE status = 'active'
        UNION
        SELECT owner_id AS id
          FROM workflow_runs
         WHERE owner_kind = 'daemon'
           AND owner_id IS NOT NULL
           AND attempt_id IS NULL
           AND status IN ('queued', 'running')
        UNION
        SELECT daemon_id AS id
          FROM executions
         WHERE daemon_id IS NOT NULL
           AND offer_id IS NULL
           AND status IN ('queued', 'offered', 'running')
      ) AS candidates
     WHERE id IS NOT NULL
  `;
  return rows.map((row) => row.id);
}

const VALKEY_RECHECK_TIMEOUT_MS = 2_000;

/**
 * `false` only when Valkey positively answered that the key is gone. A timeout
 * or an error returns `true` so the caller leaves the daemon alone this pass.
 */
async function daemonKeyExists(daemonId: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const query = (async (): Promise<boolean> => {
      const valkey = requireValkeyClient();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Valkey EXISTS returns number
      const exists: number = await valkey.send("EXISTS", [`daemon:${daemonId}`]);
      return exists === 1;
    })();
    const deadline = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        logger.warn(
          { event: "daemon.liveness_recheck_timeout", daemonId },
          "Valkey liveness recheck timed out; treating the daemon as alive",
        );
        resolve(true);
      }, VALKEY_RECHECK_TIMEOUT_MS);
    });
    return await Promise.race([query, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Lock, recheck, and fence one candidate so a reconnect cannot be reaped from a stale snapshot. */
async function reapDeadDaemonCandidates(
  sql: SQL,
  initiallyLiveDaemonIds: readonly string[],
): Promise<DeadDaemonReapResult> {
  const initiallyLive = new Set(initiallyLiveDaemonIds);
  const candidates = (await listDaemonCandidates(sql)).filter((id) => !initiallyLive.has(id));
  const rows: ReapedRow[] = [];
  let daemonsMarkedInactive = 0;

  for (const daemonId of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop -- each owner is fenced in its own short transaction
      const reaped = await sql.begin(async (tx) => {
        await tx`SELECT id FROM daemons WHERE id = ${daemonId} FOR UPDATE`;
        // Bounded: this runs inside the `FOR UPDATE` transaction, and Bun's
        // Valkey client has no per-command deadline. A stalled Valkey would
        // otherwise hold the `daemons` row lock until the force exit. Treat a
        // timeout as "still alive" so a stall defers the reap instead of
        // fencing a daemon on no evidence.
        if (await daemonKeyExists(daemonId)) return null;

        const connection = getConnections().get(daemonId);
        connection?.close(
          WS_CLOSE_CODES.HEARTBEAT_TIMEOUT.code,
          WS_CLOSE_CODES.HEARTBEAT_TIMEOUT.reason,
        );
        return failDaemonOwnershipInTransaction(
          daemonId,
          {
            workflowReason: `owner daemon:${daemonId} is no longer alive`,
            executionReason: "Owning daemon is no longer alive",
            clearOwner: false,
          },
          tx,
        );
      });
      if (reaped === null) continue;
      if (reaped.daemonMarkedInactive) daemonsMarkedInactive++;
      rows.push(
        ...reaped.workflows.map((workflow) => ({
          id: workflow.id,
          workflow_name: workflow.workflowName,
          owner_kind: "daemon" as const,
          owner_id: workflow.ownerId,
        })),
      );
    } catch (err) {
      logger.error({ err, daemonId }, "Dead daemon recheck failed, leaving ownership unchanged");
    }
  }
  return { rows, daemonsMarkedInactive };
}

export interface ReapResult {
  readonly workflowRunsReaped: ReapedRow[];
  readonly daemonsMarkedInactive: number;
}

/**
 * Run one reaper pass. Exported for tests and for one-shot invocations
 * (e.g. on startup, before the periodic timer kicks in).
 */
export async function reapOnce(sql: SQL = requireDb()): Promise<ReapResult> {
  await reapOrphanProcessingLists(getInstanceId()).catch((err: unknown) => {
    logger.warn({ err }, "Orphan processing-list recovery failed");
  });
  const expiredDispatches = await expireQueuedWorkflowExecutions(sql);
  await notifyExpiredWorkflowDispatches(expiredDispatches).catch((err: unknown) => {
    logger.warn({ err }, "Expired workflow dispatch notification pass failed");
  });
  const expiredAttempts = await expireLeasedWorkflowExecutions(sql);
  await notifyExpiredWorkflowAttempts(expiredAttempts).catch((err: unknown) => {
    logger.warn({ err }, "Expired workflow notification pass failed");
  });
  await reconcileWorkflowRunners().catch((err: unknown) => {
    logger.warn({ err }, "Workflow runner reconciliation failed");
  });
  await reconcilePendingWorkflowCascades(sql).catch((err: unknown) => {
    logger.warn({ err }, "Pending workflow cascade reconciliation failed");
  });
  await publishPendingWorkflowRuns(sql).catch((err: unknown) => {
    logger.warn({ err }, "Pending workflow dispatch reconciliation failed");
  });

  let orchIds: string[];
  let daemonIds: string[];
  try {
    [orchIds, daemonIds] = await Promise.all([listLiveOrchestratorIds(), listLiveDaemonIds()]);
  } catch (err) {
    logger.error({ err }, "Valkey liveness read failed after workflow lease expiry");
    return {
      workflowRunsReaped: [...expiredDispatches, ...expiredAttempts],
      daemonsMarkedInactive: 0,
    };
  }

  const reapedOrch: ReapedRow[] =
    orchIds.length === 0
      ? await sql`
          WITH reaped AS (
            UPDATE workflow_runs
               SET status = 'failed',
                   state = state || jsonb_build_object(
                     'failedReason', 'owner orchestrator:' || owner_id || ' is no longer alive',
                     'reapedAt', now()
                   )
             WHERE status IN ('queued', 'running')
               AND owner_kind = 'orchestrator'
               AND NOT (status = 'queued' AND dispatch_enqueued_at IS NULL)
            RETURNING id, workflow_name, owner_kind, owner_id, execution_delivery_id
          ), failed_executions AS (
            UPDATE executions AS e
               SET status = 'failed',
                   completed_at = now(),
                   error_message = 'Owning orchestrator is no longer alive'
              FROM reaped
             WHERE e.delivery_id = reaped.execution_delivery_id
               AND e.status IN ('queued', 'offered', 'running')
            RETURNING e.delivery_id
          ), released_locks AS (
            UPDATE scheduled_action_state
               SET in_flight_job_id = NULL,
                   in_flight_started_at = NULL
             WHERE in_flight_job_id IN (SELECT delivery_id FROM failed_executions)
          )
          SELECT id, workflow_name, owner_kind, owner_id FROM reaped
        `
      : await sql`
          WITH reaped AS (
            UPDATE workflow_runs
               SET status = 'failed',
                   state = state || jsonb_build_object(
                     'failedReason', 'owner orchestrator:' || owner_id || ' is no longer alive',
                     'reapedAt', now()
                   )
             WHERE status IN ('queued', 'running')
               AND owner_kind = 'orchestrator'
               AND NOT (status = 'queued' AND dispatch_enqueued_at IS NULL)
               AND owner_id NOT IN ${sql(orchIds)}
            RETURNING id, workflow_name, owner_kind, owner_id, execution_delivery_id
          ), failed_executions AS (
            UPDATE executions AS e
               SET status = 'failed',
                   completed_at = now(),
                   error_message = 'Owning orchestrator is no longer alive'
              FROM reaped
             WHERE e.delivery_id = reaped.execution_delivery_id
               AND e.status IN ('queued', 'offered', 'running')
            RETURNING e.delivery_id
          ), released_locks AS (
            UPDATE scheduled_action_state
               SET in_flight_job_id = NULL,
                   in_flight_started_at = NULL
             WHERE in_flight_job_id IN (SELECT delivery_id FROM failed_executions)
          )
          SELECT id, workflow_name, owner_kind, owner_id FROM reaped
        `;

  const deadDaemons = await reapDeadDaemonCandidates(sql, daemonIds);
  const reapedDaemon = deadDaemons.rows;

  const workflowRunsReaped = [
    ...expiredDispatches,
    ...expiredAttempts,
    ...reapedOrch,
    ...reapedDaemon,
  ];
  if (workflowRunsReaped.length > 0 || deadDaemons.daemonsMarkedInactive > 0) {
    logger.info(
      {
        workflowRunsReaped: workflowRunsReaped.length,
        daemonsMarkedInactive: deadDaemons.daemonsMarkedInactive,
        liveOrchestratorCount: orchIds.length,
        liveDaemonCount: daemonIds.length,
        reapedRunIds: workflowRunsReaped.map((r) => r.id),
      },
      "Liveness reaper flipped abandoned rows",
    );
  } else {
    logger.debug(
      {
        liveOrchestratorCount: orchIds.length,
        liveDaemonCount: daemonIds.length,
      },
      "Liveness reaper pass, nothing to reap",
    );
  }

  return { workflowRunsReaped, daemonsMarkedInactive: deadDaemons.daemonsMarkedInactive };
}

async function expireQueuedWorkflowExecutions(sql: SQL): Promise<WorkflowRunRow[]> {
  if (typeof sql.begin !== "function") {
    return expireQueuedWorkflowDispatches(
      config.workflowDispatchTimeoutMs,
      config.jobMaxRetries,
      sql,
    );
  }

  return sql.begin(async (tx) => {
    const rows = await expireQueuedWorkflowDispatches(
      config.workflowDispatchTimeoutMs,
      config.jobMaxRetries,
      tx,
    );
    for (const row of rows) {
      const failureReason =
        row.state["failedReason"] === "workflow dispatch retries exhausted"
          ? "workflow dispatch retries exhausted"
          : "workflow dispatch deadline expired";
      if (row.parent_run_id !== null) {
        const parentFailure = {
          failedAtStepIndex: row.parent_step_index ?? -1,
          failedReason: failureReason,
        };
        // eslint-disable-next-line no-await-in-loop -- parent and dispatch expire together
        await tx`
          UPDATE workflow_runs
             SET status = 'failed', state = state || ${parentFailure}::jsonb
           WHERE id = ${row.parent_run_id}
             AND status = 'running'
        `;
      }
      if (row.execution_delivery_id === null) continue;
      // eslint-disable-next-line no-await-in-loop -- execution and dispatch expire together
      await tx`
        UPDATE executions
           SET status = 'failed',
               completed_at = now(),
               error_message = ${
                 failureReason === "workflow dispatch retries exhausted"
                   ? "Workflow dispatch retries exhausted"
                   : "Workflow dispatch deadline expired"
               },
               result_processed_at = now()
         WHERE delivery_id = ${row.execution_delivery_id}
           AND offer_id IS NULL
           AND status = 'queued'
      `;
      // eslint-disable-next-line no-await-in-loop -- lock release shares the transaction
      await clearInFlightByJobId(row.execution_delivery_id, tx);
    }
    return rows;
  });
}

async function expireLeasedWorkflowExecutions(sql: SQL): Promise<WorkflowRunRow[]> {
  if (typeof sql.begin !== "function") return expireWorkflowAttempts(sql);

  return sql.begin(async (tx) => {
    const rows = await expireWorkflowAttempts(tx);
    for (const row of rows) {
      const failureReason =
        row.state["failedReason"] === "workflow execution deadline expired"
          ? "workflow execution deadline expired"
          : "workflow execution lease expired";
      const executionFailureReason =
        failureReason === "workflow execution deadline expired"
          ? "Workflow execution deadline expired"
          : "Workflow execution lease expired";
      if (row.parent_run_id !== null) {
        const parentFailure = {
          failedAtStepIndex: row.parent_step_index ?? -1,
          failedReason: failureReason,
        };
        // eslint-disable-next-line no-await-in-loop -- parent and attempt expire together
        await tx`
          UPDATE workflow_runs
             SET status = 'failed', state = state || ${parentFailure}::jsonb
           WHERE id = ${row.parent_run_id}
             AND status = 'running'
        `;
      }
      if (row.execution_delivery_id === null || row.attempt_id === null) continue;
      // eslint-disable-next-line no-await-in-loop -- execution and attempt expire together
      await tx`
        UPDATE executions
           SET status = 'failed',
               completed_at = now(),
               error_message = ${executionFailureReason},
               result_processed_at = now()
         WHERE delivery_id = ${row.execution_delivery_id}
           AND daemon_id = ${row.owner_id}
           AND offer_id = ${row.attempt_id}
           AND status = 'running'
      `;
      // eslint-disable-next-line no-await-in-loop -- lock release shares the transaction
      await clearInFlightByJobId(row.execution_delivery_id, tx);
    }
    return rows;
  });
}

/**
 * Start the periodic reaper. Idempotent: calling twice does nothing.
 *
 * Cadence comes from `config.livenessReaperIntervalMs`. Min sane value is
 * the orchestrator heartbeat refresh interval (20s); below that, a
 * heartbeat momentarily not yet republished could trigger a false reap.
 */
export function startLivenessReaper(): void {
  if (timer !== null) return;
  const intervalMs = config.livenessReaperIntervalMs;
  timer = setInterval(() => {
    if (inFlight !== null) {
      logger.warn("Liveness reaper tick skipped because the prior pass is still running");
      return;
    }
    const pass = reapOnce();
    inFlight = pass;
    void pass
      .catch((err: unknown) => {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          "Liveness reaper pass threw, will retry on next tick",
        );
      })
      .finally(() => {
        if (inFlight === pass) inFlight = null;
      });
  }, intervalMs);
  logger.info({ intervalMs }, "Liveness reaper started");
}

/** Stop future ticks and wait for the active pass before downstream clients close. */
export async function stopLivenessReaper(): Promise<void> {
  if (timer !== null) clearInterval(timer);
  timer = null;
  const active = inFlight;
  if (active !== null) await active.catch(() => undefined);
  logger.info("Liveness reaper stopped");
}
