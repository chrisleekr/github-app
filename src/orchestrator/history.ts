import type { SQL } from "bun";

import { config } from "../config";
import { getDb } from "../db";
import { logger } from "../logger";
import type { SerializableBotContext } from "../shared/daemon-types";
import type { DispatchTarget } from "../shared/dispatch-types";
import type { ModelUsageEntry } from "../types";
import { decrementDaemonActiveJobs } from "./daemon-registry";

/**
 * Execution status transitions:
 *   queued -> offered -> running -> completed | failed
 *   offered -> queued (rejection/timeout, re-queue)
 *   queued -> failed (no daemons after retries)
 */
export type ExecutionStatus = "queued" | "offered" | "running" | "completed" | "failed";

export interface CreateExecutionParams {
  deliveryId: string;
  repoOwner: string;
  repoName: string;
  entityNumber: number;
  entityType: string;
  eventName: string;
  triggerUsername: string;
  dispatchMode: string;
  /** Exact persisted execution protocol. Defaults to the shared-daemon rail. */
  dispatchTarget?: DispatchTarget;
  /**
   * Dispatch-decision reason. Callers pass the resolved DispatchReason
   * (e.g. "persistent-daemon", "ephemeral-daemon-triage", "ephemeral-spawn-failed")
   * so analytics can distinguish spawn outcomes from steady-state routing.
   */
  dispatchReason?: string;
  /**
   * Triage denorm fields. Populated whenever the triage LLM produced a
   * result so FR-014 aggregates can read confidence/cost without joining
   * to `triage_results`.
   */
  triageConfidence?: number;
  triageCostUsd?: number;
  contextJson?: SerializableBotContext;
  /**
   * REST id of the user comment that triggered this run, persisted so the
   * orphan/disconnect path (which has no live BotContext) can still react
   * on the right comment after a daemon dies. NULL for label/system runs.
   */
  triggerCommentId?: number | null;
  triggerEventType?: "issue_comment" | "pull_request_review_comment" | null;
}

/**
 * Create an execution record when a webhook arrives.
 * Returns the generated UUID.
 */
export async function createExecution(params: CreateExecutionParams, sql?: SQL): Promise<string> {
  const db = sql ?? getDb();
  if (db === null) throw new Error("Database not configured");

  const hasDispatchReason = params.dispatchReason !== undefined;
  const hasTriageFields =
    params.triageConfidence !== undefined || params.triageCostUsd !== undefined;

  // Guard: triage denorm columns must only accompany an explicit reason.
  // Without this, callers could accidentally persist triage_* columns
  // alongside the DB-default `static-default` reason, which would mislead
  // FR-014 aggregates into attributing triage telemetry to non-triage rows.
  if (hasTriageFields && !hasDispatchReason) {
    throw new Error("createExecution: dispatchReason is required when triage fields are provided");
  }

  const dispatchTarget = params.dispatchTarget ?? "daemon";
  const triggerCommentId = params.triggerCommentId ?? null;
  const triggerEventType = params.triggerEventType ?? null;

  let rows: { id: string }[];
  if (hasTriageFields) {
    rows = await db`
      INSERT INTO executions (
        delivery_id, repo_owner, repo_name, entity_number, entity_type,
        event_name, trigger_username, dispatch_mode, dispatch_target, dispatch_reason,
        triage_confidence, triage_cost_usd,
        status, context_json, trigger_comment_id, trigger_event_type
      ) VALUES (
        ${params.deliveryId}, ${params.repoOwner}, ${params.repoName},
        ${params.entityNumber}, ${params.entityType}, ${params.eventName},
        ${params.triggerUsername}, ${dispatchTarget}, ${dispatchTarget},
        ${params.dispatchReason ?? "persistent-daemon"},
        ${params.triageConfidence ?? null}, ${params.triageCostUsd ?? null},
        'queued', ${params.contextJson ?? null}, ${triggerCommentId}, ${triggerEventType}
      )
      RETURNING id
    `;
  } else if (hasDispatchReason) {
    rows = await db`
      INSERT INTO executions (
        delivery_id, repo_owner, repo_name, entity_number, entity_type,
        event_name, trigger_username, dispatch_mode, dispatch_target, dispatch_reason,
        status, context_json, trigger_comment_id, trigger_event_type
      ) VALUES (
        ${params.deliveryId}, ${params.repoOwner}, ${params.repoName},
        ${params.entityNumber}, ${params.entityType}, ${params.eventName},
        ${params.triggerUsername}, ${dispatchTarget}, ${dispatchTarget}, ${params.dispatchReason},
        'queued', ${params.contextJson ?? null}, ${triggerCommentId}, ${triggerEventType}
      )
      RETURNING id
    `;
  } else {
    rows = await db`
      INSERT INTO executions (
        delivery_id, repo_owner, repo_name, entity_number, entity_type,
        event_name, trigger_username, dispatch_mode, dispatch_target, status, context_json,
        trigger_comment_id, trigger_event_type
      ) VALUES (
        ${params.deliveryId}, ${params.repoOwner}, ${params.repoName},
        ${params.entityNumber}, ${params.entityType}, ${params.eventName},
        ${params.triggerUsername}, ${dispatchTarget}, ${dispatchTarget}, 'queued',
        ${params.contextJson ?? null}, ${triggerCommentId}, ${triggerEventType}
      )
      RETURNING id
    `;
  }
  const row = rows[0];
  if (row === undefined) throw new Error("INSERT RETURNING yielded no row");
  return row.id;
}

/**
 * Update execution status to 'offered' with the assigned daemon ID.
 */
export type ExecutionOfferOutcome = "offered" | "daemon-inactive" | "stale";

/** Assign a queued receipt only while the exact daemon row is still active. */
export async function markExecutionOffered(
  deliveryId: string,
  daemonId: string,
  sql: SQL | null = getDb(),
): Promise<ExecutionOfferOutcome> {
  if (sql === null) return "offered";

  return sql.begin(async (tx) => {
    const active: { id: string }[] = await tx`
      SELECT id
        FROM daemons
       WHERE id = ${daemonId}
         AND status = 'active'
       FOR UPDATE
    `;
    if (active[0] === undefined) return "daemon-inactive";
    const offered: { delivery_id: string }[] = await tx`
      UPDATE executions
         SET status = 'offered', daemon_id = ${daemonId}
       WHERE delivery_id = ${deliveryId}
         AND status = 'queued'
      RETURNING delivery_id
    `;
    return offered[0] === undefined ? "stale" : "offered";
  });
}

/**
 * Update execution status to 'running' and record start time.
 */
export async function markExecutionRunning(deliveryId: string): Promise<void> {
  const db = getDb();
  if (db === null) return;

  await db`
    UPDATE executions
    SET status = 'running', started_at = now()
    WHERE delivery_id = ${deliveryId} AND status = 'offered'
  `;
}

/**
 * Update execution status to 'completed' with result metrics.
 */
export async function markExecutionCompleted(
  deliveryId: string,
  result: {
    costUsd?: number;
    durationMs?: number;
    numTurns?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    modelUsage?: readonly ModelUsageEntry[];
  },
): Promise<void> {
  const db = getDb();
  if (db === null) return;

  // Bun.sql serialises the modelUsage array to JSONB automatically.
  await db`
    UPDATE executions
    SET status = 'completed', completed_at = now(),
        cost_usd = ${result.costUsd ?? null},
        duration_ms = ${result.durationMs ?? null},
        num_turns = ${result.numTurns ?? null},
        input_tokens = ${result.inputTokens ?? null},
        output_tokens = ${result.outputTokens ?? null},
        cache_read_input_tokens = ${result.cacheReadInputTokens ?? null},
        cache_creation_input_tokens = ${result.cacheCreationInputTokens ?? null},
        model_usage = ${result.modelUsage ?? null}
    WHERE delivery_id = ${deliveryId} AND status = 'running'
  `;
}

/**
 * Update execution status to 'failed' with an error message.
 */
export async function markExecutionFailed(deliveryId: string, errorMessage: string): Promise<void> {
  const db = getDb();
  if (db === null) return;

  await db`
    UPDATE executions
    SET status = 'failed', completed_at = now(), error_message = ${errorMessage}
    WHERE delivery_id = ${deliveryId} AND status IN ('queued', 'offered', 'running')
  `;
}

/**
 * Re-queue an execution (offered -> queued) after rejection or timeout.
 */
export async function requeueExecution(deliveryId: string): Promise<boolean> {
  const db = getDb();
  if (db === null) return true;

  const rows: { delivery_id: string }[] = await db`
    UPDATE executions
       SET status = 'queued', daemon_id = NULL
     WHERE delivery_id = ${deliveryId}
       AND status = 'offered'
    RETURNING delivery_id
  `;
  return rows[0] !== undefined;
}

export interface DisconnectedDaemonCleanup {
  readonly executionDeliveryIds: readonly string[];
  readonly workflowRunIds: readonly string[];
}

export interface FailedDaemonWorkflow {
  readonly id: string;
  readonly workflowName: string;
  readonly ownerId: string;
}

export interface FailedDaemonOwnership extends DisconnectedDaemonCleanup {
  readonly daemonMarkedInactive: boolean;
  readonly workflows: readonly FailedDaemonWorkflow[];
}

interface DaemonFailure {
  readonly workflowReason: string;
  readonly executionReason: string;
  readonly clearOwner: boolean;
}

/** Terminalize one shared daemon's durable ownership inside the caller's transaction. */
export async function failDaemonOwnershipInTransaction(
  daemonId: string,
  failure: DaemonFailure,
  tx: SQL,
): Promise<FailedDaemonOwnership> {
  const daemonRows: { id: string }[] = await tx`
    UPDATE daemons
       SET status = 'inactive', last_seen_at = now()
     WHERE id = ${daemonId}
       AND status = 'active'
    RETURNING id
  `;
  const terminalWorkflows: {
    id: string;
    workflow_name: string;
    execution_delivery_id: string | null;
    propagated_parent: boolean;
  }[] = await tx`
    WITH failed_workflows AS (
      UPDATE workflow_runs
         SET status = 'failed',
             owner_kind = CASE WHEN ${failure.clearOwner}::boolean THEN NULL ELSE owner_kind END,
             owner_id = CASE WHEN ${failure.clearOwner}::boolean THEN NULL ELSE owner_id END,
             attempt_completed_at = COALESCE(attempt_completed_at, now()),
             state = state || jsonb_build_object(
                 'phase', 'orphaned',
                 'failedReason', ${failure.workflowReason}::text
             )
       WHERE owner_kind = 'daemon'
         AND owner_id = ${daemonId}
         AND attempt_id IS NULL
         AND status IN ('queued', 'running')
      RETURNING id, workflow_name, execution_delivery_id, parent_run_id, parent_step_index
    ),
    failed_parent_inputs AS (
      SELECT parent_run_id,
             min(COALESCE(parent_step_index, -1)) AS failed_step_index
        FROM failed_workflows
       WHERE parent_run_id IS NOT NULL
       GROUP BY parent_run_id
    ),
    failed_parents AS (
      UPDATE workflow_runs AS parent
         SET status = 'failed',
             attempt_completed_at = COALESCE(parent.attempt_completed_at, now()),
             state = parent.state || jsonb_build_object(
                 'phase', 'orphaned',
                 'failedAtStepIndex', failed_parent_inputs.failed_step_index,
                 'failedReason', ${failure.workflowReason}::text
             )
        FROM failed_parent_inputs
       WHERE parent.id = failed_parent_inputs.parent_run_id
         AND parent.status = 'running'
         AND NOT EXISTS (
             SELECT 1 FROM failed_workflows AS direct WHERE direct.id = parent.id
         )
      RETURNING parent.id, parent.workflow_name, parent.execution_delivery_id
    )
    SELECT id, workflow_name, execution_delivery_id, false AS propagated_parent
      FROM failed_workflows
    UNION ALL
    SELECT id, workflow_name, execution_delivery_id, true AS propagated_parent
      FROM failed_parents
  `;
  const workflows = terminalWorkflows.filter((row) => !row.propagated_parent);
  const workflowDeliveries = workflows.flatMap((row) =>
    row.execution_delivery_id === null ? [] : [row.execution_delivery_id],
  );
  const executions: { delivery_id: string }[] =
    workflowDeliveries.length === 0
      ? await tx`
          UPDATE executions
             SET status = 'failed',
                 completed_at = now(),
                 error_message = ${failure.executionReason}
           WHERE daemon_id = ${daemonId}
             AND offer_id IS NULL
             AND status IN ('queued', 'offered', 'running')
          RETURNING delivery_id
        `
      : await tx`
          UPDATE executions
             SET status = 'failed',
                 completed_at = now(),
                 error_message = ${failure.executionReason}
           WHERE (daemon_id = ${daemonId} OR delivery_id IN ${tx(workflowDeliveries)})
             AND offer_id IS NULL
             AND status IN ('queued', 'offered', 'running')
          RETURNING delivery_id
        `;
  const deliveryIds = executions.map((row) => row.delivery_id);
  if (deliveryIds.length > 0) {
    await tx`
      UPDATE scheduled_action_state
         SET in_flight_job_id = NULL,
             in_flight_started_at = NULL
       WHERE in_flight_job_id IN ${tx(deliveryIds)}
    `;
  }
  return {
    daemonMarkedInactive: daemonRows[0] !== undefined,
    executionDeliveryIds: deliveryIds,
    workflowRunIds: terminalWorkflows.map((row) => row.id),
    workflows: workflows.map((row) => ({
      id: row.id,
      workflowName: row.workflow_name,
      ownerId: daemonId,
    })),
  };
}

/** Fence one shared-daemon incarnation and terminalize all ownership atomically. */
export async function failDisconnectedDaemon(
  daemonId: string,
  sql: SQL | null = getDb(),
): Promise<DisconnectedDaemonCleanup> {
  if (sql === null) return { executionDeliveryIds: [], workflowRunIds: [] };
  const failed = await sql.begin((tx) =>
    failDaemonOwnershipInTransaction(
      daemonId,
      {
        workflowReason: "daemon disconnected during execution",
        executionReason: "daemon disconnected during execution",
        clearOwner: true,
      },
      tx,
    ),
  );
  return {
    executionDeliveryIds: failed.executionDeliveryIds,
    workflowRunIds: failed.workflowRunIds,
  };
}

/**
 * Get execution status and daemon_id for FM-6 late result guard.
 */
export async function getExecutionState(
  deliveryId: string,
): Promise<{ status: string; daemonId: string | null } | null> {
  const db = getDb();
  if (db === null) return null;

  const rows: { status: string; daemon_id: string | null }[] = await db`
    SELECT status, daemon_id FROM executions WHERE delivery_id = ${deliveryId}
  `;
  const row = rows[0];
  if (row === undefined) return null;
  return {
    status: row.status,
    daemonId: row.daemon_id,
  };
}

/**
 * Get orphaned executions for a daemon (FM-1 cleanup).
 * Returns delivery IDs of executions stuck in 'offered' or 'running' state.
 */
export async function getOrphanedExecutions(
  daemonId: string,
): Promise<{ deliveryId: string; status: string }[]> {
  const db = getDb();
  if (db === null) return [];

  const rows: { delivery_id: string; status: string }[] = await db`
    SELECT delivery_id, status FROM executions
    WHERE daemon_id = ${daemonId} AND status IN ('offered', 'running')
  `;
  return rows.map((r) => ({
    deliveryId: r.delivery_id,
    status: r.status,
  }));
}

/**
 * Startup recovery: scan for stale executions and mark them failed (FM-4).
 * Runs after db.migrate() but before startWebSocketServer().
 *
 * Two query conditions handle NULL started_at for 'offered' records:
 * - running: started_at < threshold
 * - offered: created_at < threshold (started_at is NULL)
 */
export async function recoverStaleExecutions(db: SQL): Promise<void> {
  const thresholdMs = config.staleExecutionThresholdMs;

  const staleRows: { id: string; delivery_id: string; daemon_id: string | null; status: string }[] =
    await db`
    SELECT id, delivery_id, daemon_id, status
    FROM executions
    WHERE offer_id IS NULL
      AND (
        (status = 'running' AND started_at < now() - make_interval(secs => ${thresholdMs / 1000}))
        OR (status = 'offered' AND created_at < now() - make_interval(secs => ${thresholdMs / 1000}))
      )
  `;

  if (staleRows.length === 0) return;

  for (const row of staleRows) {
    // eslint-disable-next-line no-await-in-loop
    await db`
      UPDATE executions
      SET status = 'failed', error_message = 'server restarted, execution state unknown', completed_at = now()
      WHERE id = ${row.id} AND status IN ('offered', 'running')
    `;

    // Decrement the daemon's Valkey active_jobs counter if it still exists (M11)
    if (row.daemon_id !== null) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await decrementDaemonActiveJobs(row.daemon_id);
      } catch (err) {
        logger.debug(
          { err, daemonId: row.daemon_id },
          "Failed to decrement active_jobs for stale execution (daemon may be deregistered)",
        );
      }
    }

    logger.warn(
      { deliveryId: row.delivery_id, daemonId: row.daemon_id, previousStatus: row.status },
      "Recovered stale execution on startup",
    );
  }

  logger.warn({ count: staleRows.length }, "Recovered stale executions on startup");
}
