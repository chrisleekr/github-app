import type { SQL } from "bun";

import { requireDb } from "../db";
import { logger } from "../logger";
import {
  type WorkflowRunnerCommand,
  type WorkflowRunnerResultPayload,
  WorkflowRunnerResultPayloadSchema,
} from "../shared/workflow-runner-messages";
import { workflowRunnerId } from "../shared/workflow-types";
import {
  markAttemptFailed,
  markAttemptIncomplete,
  markAttemptSucceeded,
  StaleWorkflowAttemptError,
  type WorkflowAttempt,
  type WorkflowRunRow,
} from "../workflows/runs-store";
import type { WorkflowRunQueuedJob } from "./job-queue";

const RUNNER_ID_PREFIX = "workflow-runner:";
export const WORKFLOW_RUNNER_ATTEMPT_DEADLINE_MS = 4_200_000;

export { workflowRunnerId };

interface ExactRunnerRow {
  id: string;
  workflow_name: string;
  execution_delivery_id: string;
  status: string;
  attempt_id: string | null;
  owner_kind: string | null;
  owner_id: string | null;
  lease_expires_at: Date | null;
  lease_active: boolean;
  attempt_deadline_at: Date | null;
  attempt_deadline_active: boolean;
  attempt_completed_at: Date | null;
  dispatch_generation_id: string;
  runner_payload_issued_at: Date | null;
  runner_token_expires_at: Date | null;
  execution_status: string;
  execution_daemon_id: string | null;
  execution_offer_id: string | null;
  result_processed_at: Date | null;
  workflow_result_payload: unknown;
}

export interface WorkflowRunnerAttempt {
  readonly runId: string;
  readonly attemptId: string;
  readonly runnerId: string;
  readonly executionDeliveryId: string;
  readonly workflowName: WorkflowRunQueuedJob["workflowRun"]["workflowName"];
  readonly attemptDeadlineAt: Date;
}

export type WorkflowRunnerClaim =
  | { readonly outcome: "claimed" | "active"; readonly attempt: WorkflowRunnerAttempt }
  | { readonly outcome: "capacity" }
  | { readonly outcome: "stale" };

function exactJobWhere(job: WorkflowRunQueuedJob): {
  readonly targetType: "issue" | "pr";
} {
  return { targetType: job.isPR ? "pr" : "issue" };
}

async function loadExactJobRow(
  job: WorkflowRunQueuedJob,
  sql: SQL,
): Promise<ExactRunnerRow | null> {
  const { targetType } = exactJobWhere(job);
  const rows: ExactRunnerRow[] = await sql`
    SELECT wr.id,
           wr.workflow_name,
           wr.execution_delivery_id,
           wr.status,
           wr.attempt_id,
           wr.owner_kind,
           wr.owner_id,
           wr.lease_expires_at,
           wr.lease_expires_at > now() AS lease_active,
           wr.attempt_deadline_at,
           wr.attempt_deadline_at > now() AS attempt_deadline_active,
           wr.attempt_completed_at,
           wr.dispatch_generation_id,
           wr.runner_payload_issued_at,
           wr.runner_token_expires_at,
           e.status AS execution_status,
           e.daemon_id AS execution_daemon_id,
           e.offer_id AS execution_offer_id,
           e.result_processed_at,
           e.workflow_result_payload
      FROM workflow_runs AS wr
      JOIN executions AS e ON e.delivery_id = wr.execution_delivery_id
     WHERE wr.id = ${job.workflowRun.runId}
       AND wr.workflow_name = ${job.workflowRun.workflowName}
       AND wr.execution_delivery_id = ${job.deliveryId}
       AND wr.target_type = ${targetType}
       AND wr.target_owner = ${job.repoOwner}
       AND wr.target_repo = ${job.repoName}
       AND wr.target_number = ${job.entityNumber}
  `;
  return rows[0] ?? null;
}

function activeAttemptFromRow(row: ExactRunnerRow): WorkflowRunnerAttempt | null {
  const attemptId = row.attempt_id;
  if (
    row.status !== "running" ||
    attemptId === null ||
    row.owner_kind !== "daemon" ||
    row.owner_id !== workflowRunnerId(attemptId) ||
    row.execution_status !== "running" ||
    row.execution_daemon_id !== row.owner_id ||
    row.execution_offer_id !== attemptId ||
    row.lease_expires_at === null ||
    row.attempt_deadline_at === null ||
    row.attempt_completed_at !== null ||
    !row.lease_active ||
    !row.attempt_deadline_active
  ) {
    return null;
  }
  return {
    runId: row.id,
    attemptId,
    runnerId: row.owner_id,
    executionDeliveryId: row.execution_delivery_id,
    workflowName: row.workflow_name as WorkflowRunnerAttempt["workflowName"],
    attemptDeadlineAt: row.attempt_deadline_at,
  };
}

/** Claim the workflow row and execution receipt directly for one runner Pod. */
export async function claimWorkflowRunnerAttempt(
  job: WorkflowRunQueuedJob,
  startupLeaseMs: number,
  maxActive: number,
  sql: SQL = requireDb(),
): Promise<WorkflowRunnerClaim> {
  if (!Number.isInteger(maxActive) || maxActive <= 0) {
    throw new RangeError("maxActive must be a positive integer");
  }
  try {
    const claim = await sql.begin(async (tx) => {
      const { targetType } = exactJobWhere(job);
      const exactRows: ExactRunnerRow[] = await tx`
        SELECT wr.id,
               wr.workflow_name,
               wr.execution_delivery_id,
               wr.status,
               wr.attempt_id,
               wr.owner_kind,
               wr.owner_id,
               wr.lease_expires_at,
               wr.lease_expires_at > now() AS lease_active,
               wr.attempt_deadline_at,
               wr.attempt_deadline_at > now() AS attempt_deadline_active,
               wr.attempt_completed_at,
               wr.dispatch_generation_id,
               wr.runner_payload_issued_at,
               wr.runner_token_expires_at,
               e.status AS execution_status,
               e.daemon_id AS execution_daemon_id,
               e.offer_id AS execution_offer_id,
               e.result_processed_at,
               e.workflow_result_payload
          FROM workflow_runs AS wr
          JOIN executions AS e ON e.delivery_id = wr.execution_delivery_id
         WHERE wr.id = ${job.workflowRun.runId}
           AND wr.workflow_name = ${job.workflowRun.workflowName}
           AND wr.execution_delivery_id = ${job.deliveryId}
           AND wr.target_type = ${targetType}
           AND wr.target_owner = ${job.repoOwner}
           AND wr.target_repo = ${job.repoName}
           AND wr.target_number = ${job.entityNumber}
         FOR UPDATE OF wr, e
      `;
      const exact = exactRows[0];
      if (exact === undefined) return null;
      const active = activeAttemptFromRow(exact);
      if (active !== null) return { outcome: "active" as const, attempt: active };
      if (
        exact.status !== "queued" ||
        exact.attempt_id !== null ||
        exact.execution_status !== "queued"
      ) {
        return null;
      }

      // The supported single queue worker serializes admissions. This transaction
      // keeps the capacity observation and exact claim mutation indivisible.
      const counts: { active_count: number }[] = await tx`
        SELECT count(*)::int AS active_count
          FROM workflow_runs AS wr
          JOIN executions AS e ON e.delivery_id = wr.execution_delivery_id
         WHERE wr.status = 'running'
           AND wr.owner_kind = 'daemon'
           AND wr.attempt_id IS NOT NULL
           AND wr.owner_id = ${RUNNER_ID_PREFIX} || wr.attempt_id::text
           AND wr.lease_expires_at > now()
           AND wr.attempt_deadline_at > now()
           AND wr.attempt_completed_at IS NULL
           AND e.status = 'running'
           AND e.daemon_id = wr.owner_id
           AND e.offer_id = wr.attempt_id
      `;
      if ((counts[0]?.active_count ?? 0) >= maxActive) {
        return { outcome: "capacity" as const };
      }

      const attemptId = exact.dispatch_generation_id;
      const runnerId = workflowRunnerId(attemptId);
      const workflowRows: { id: string; attempt_deadline_at: Date }[] = await tx`
        UPDATE workflow_runs
           SET status = 'running',
               owner_kind = 'daemon',
               owner_id = ${runnerId},
               attempt_id = ${attemptId},
               attempt_deadline_at = now() + ${WORKFLOW_RUNNER_ATTEMPT_DEADLINE_MS} * interval '1 millisecond',
               lease_expires_at = LEAST(
                 now() + ${startupLeaseMs} * interval '1 millisecond',
                 now() + ${WORKFLOW_RUNNER_ATTEMPT_DEADLINE_MS} * interval '1 millisecond'
               )
         WHERE id = ${exact.id}
           AND status = 'queued'
           AND attempt_id IS NULL
        RETURNING id, attempt_deadline_at
      `;
      if (workflowRows[0] === undefined) return null;

      const executionRows: { delivery_id: string }[] = await tx`
        UPDATE executions
           SET status = 'running',
               daemon_id = ${runnerId},
               offer_id = ${attemptId},
               started_at = now()
         WHERE delivery_id = ${exact.execution_delivery_id}
           AND status = 'queued'
        RETURNING delivery_id
      `;
      if (executionRows[0] === undefined)
        throw new StaleWorkflowAttemptError({
          runId: exact.id,
          attemptId,
        });

      return {
        outcome: "claimed" as const,
        attempt: {
          runId: exact.id,
          attemptId,
          runnerId,
          executionDeliveryId: exact.execution_delivery_id,
          workflowName: exact.workflow_name as WorkflowRunnerAttempt["workflowName"],
          attemptDeadlineAt: workflowRows[0].attempt_deadline_at,
        },
      };
    });
    if (claim !== null) return claim;
  } catch (err) {
    const row = await loadExactJobRow(job, sql).catch(() => null);
    const active = row === null ? null : activeAttemptFromRow(row);
    if (active !== null) return { outcome: "active", attempt: active };
    throw err;
  }

  const row = await loadExactJobRow(job, sql);
  const active = row === null ? null : activeAttemptFromRow(row);
  return active === null ? { outcome: "stale" } : { outcome: "active", attempt: active };
}

export type WorkflowRunnerRegistrationState =
  | {
      readonly state: "ready";
      readonly attempt: WorkflowRunnerAttempt;
      readonly payloadIssuedAt: Date | null;
      readonly tokenExpiresAt: Date | null;
    }
  | {
      readonly state: "result-pending";
      readonly executionDeliveryId: string;
      readonly payload: WorkflowRunnerResultPayload;
    }
  | { readonly state: "completed" }
  | { readonly state: "invalid" };

/** Resolve registration from durable state, including post-terminal ACK replay. */
export async function getWorkflowRunnerRegistrationState(
  attempt: WorkflowAttempt,
  sql: SQL = requireDb(),
): Promise<WorkflowRunnerRegistrationState> {
  const runnerId = workflowRunnerId(attempt.attemptId);
  const rows: ExactRunnerRow[] = await sql`
    SELECT wr.id,
           wr.workflow_name,
           wr.execution_delivery_id,
           wr.status,
           wr.attempt_id,
           wr.owner_kind,
           wr.owner_id,
           wr.lease_expires_at,
           wr.lease_expires_at > now() AS lease_active,
           wr.attempt_deadline_at,
           wr.attempt_deadline_at > now() AS attempt_deadline_active,
           wr.attempt_completed_at,
           wr.dispatch_generation_id,
           wr.runner_payload_issued_at,
           wr.runner_token_expires_at,
           e.status AS execution_status,
           e.daemon_id AS execution_daemon_id,
           e.offer_id AS execution_offer_id,
           e.result_processed_at,
           e.workflow_result_payload
      FROM workflow_runs AS wr
      JOIN executions AS e ON e.delivery_id = wr.execution_delivery_id
     WHERE wr.id = ${attempt.runId}
       AND wr.attempt_id = ${attempt.attemptId}
       AND wr.owner_id = ${runnerId}
       AND e.daemon_id = ${runnerId}
       AND e.offer_id = ${attempt.attemptId}
  `;
  const row = rows[0];
  if (row === undefined) return { state: "invalid" };
  const active = activeAttemptFromRow(row);
  if (active !== null) {
    return {
      state: "ready",
      attempt: active,
      payloadIssuedAt: row.runner_payload_issued_at,
      tokenExpiresAt: row.runner_token_expires_at,
    };
  }
  if (row.workflow_result_payload !== null) {
    const payload = WorkflowRunnerResultPayloadSchema.safeParse(row.workflow_result_payload);
    if (!payload.success) return { state: "invalid" };
    return row.result_processed_at === null
      ? {
          state: "result-pending",
          executionDeliveryId: row.execution_delivery_id,
          payload: payload.data,
        }
      : { state: "completed" };
  }
  return { state: "invalid" };
}

/** Record the only runner credential delivery if its token ends within the attempt. */
export async function recordWorkflowRunnerPayloadIssued(
  attempt: WorkflowAttempt,
  tokenExpiresAt: Date,
  sql: SQL = requireDb(),
): Promise<boolean> {
  const runnerId = workflowRunnerId(attempt.attemptId);
  const rows: { id: string }[] = await sql`
    UPDATE workflow_runs
       SET runner_payload_issued_at = now(),
           runner_token_expires_at = ${tokenExpiresAt}
     WHERE id = ${attempt.runId}
       AND attempt_id = ${attempt.attemptId}
       AND owner_id = ${runnerId}
       AND status = 'running'
       AND lease_expires_at > now()
       AND attempt_deadline_at > now()
       AND ${tokenExpiresAt} <= attempt_deadline_at
       AND runner_payload_issued_at IS NULL
       AND runner_token_expires_at IS NULL
    RETURNING id
  `;
  return rows[0] !== undefined;
}

export interface WorkflowRunnerCommandReceipt {
  readonly commandKind: WorkflowRunnerCommand["type"];
  readonly request: WorkflowRunnerCommand;
  readonly response: { readonly trackingCommentId?: number; readonly childRunId?: string };
}

export class WorkflowRunnerCommandConflictError extends Error {
  constructor(commandId: string) {
    super(`workflow runner command id was reused with different content: ${commandId}`);
    this.name = "WorkflowRunnerCommandConflictError";
  }
}

export async function findWorkflowRunnerCommandReceipt(
  attempt: WorkflowAttempt,
  commandId: string,
  sql: SQL = requireDb(),
): Promise<WorkflowRunnerCommandReceipt | null> {
  const rows: {
    command_kind: WorkflowRunnerCommand["type"];
    request: WorkflowRunnerCommand;
    response: WorkflowRunnerCommandReceipt["response"];
  }[] = await sql`
    SELECT command_kind, request, response
      FROM workflow_attempt_commands
     WHERE attempt_id = ${attempt.attemptId}
       AND command_id = ${commandId}
       AND run_id = ${attempt.runId}
  `;
  const row = rows[0];
  return row === undefined
    ? null
    : { commandKind: row.command_kind, request: row.request, response: row.response };
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJson(entry)]),
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

export function assertMatchingWorkflowRunnerCommand(
  receipt: WorkflowRunnerCommandReceipt,
  commandId: string,
  command: WorkflowRunnerCommand,
): void {
  if (receipt.commandKind !== command.type || !sameJson(receipt.request, command)) {
    throw new WorkflowRunnerCommandConflictError(commandId);
  }
}

export async function insertWorkflowRunnerCommandReceipt(
  attempt: WorkflowAttempt,
  commandId: string,
  command: WorkflowRunnerCommand,
  response: WorkflowRunnerCommandReceipt["response"],
  sql: SQL,
): Promise<void> {
  await sql`
    INSERT INTO workflow_attempt_commands (
      attempt_id, command_id, run_id, command_kind, request, response
    ) VALUES (
      ${attempt.attemptId}, ${commandId}, ${attempt.runId}, ${command.type},
      ${command}::jsonb, ${response}::jsonb
    )
    ON CONFLICT (attempt_id, command_id) DO NOTHING
  `;
  const receipt = await findWorkflowRunnerCommandReceipt(attempt, commandId, sql);
  if (receipt === null) throw new StaleWorkflowAttemptError(attempt);
  assertMatchingWorkflowRunnerCommand(receipt, commandId, command);
}

export type StoreWorkflowRunnerResultOutcome = "stored" | "already-stored";

interface StoredResultRow {
  workflow_status: string;
  workflow_state: Record<string, unknown>;
  attempt_completed_at: Date | null;
  lease_expires_at: Date | null;
  execution_status: string;
  workflow_result_payload: unknown;
}

/** Store the result and both terminal state transitions in one transaction. */
export async function storeWorkflowRunnerResult(
  payload: WorkflowRunnerResultPayload,
  sql: SQL = requireDb(),
): Promise<StoreWorkflowRunnerResultOutcome> {
  const attempt = { runId: payload.runId, attemptId: payload.attemptId };
  const runnerId = workflowRunnerId(payload.attemptId);
  return sql.begin(async (tx) => {
    const rows: StoredResultRow[] = await tx`
      SELECT wr.status AS workflow_status,
             wr.state AS workflow_state,
             wr.attempt_completed_at,
             wr.lease_expires_at,
             e.status AS execution_status,
             e.workflow_result_payload
        FROM workflow_runs AS wr
        JOIN executions AS e ON e.delivery_id = wr.execution_delivery_id
       WHERE wr.id = ${payload.runId}
         AND wr.attempt_id = ${payload.attemptId}
         AND wr.owner_id = ${runnerId}
         AND e.daemon_id = ${runnerId}
         AND e.offer_id = ${payload.attemptId}
       FOR UPDATE OF wr, e
    `;
    const row = rows[0];
    if (row === undefined) throw new StaleWorkflowAttemptError(attempt);
    if (row.workflow_result_payload !== null) {
      if (!sameJson(row.workflow_result_payload, payload)) {
        throw new WorkflowRunnerCommandConflictError(payload.attemptId);
      }
      return "already-stored";
    }

    const result = payload.result;
    if (result.status === "handed-off") {
      if (
        row.workflow_status !== "running" ||
        row.attempt_completed_at === null ||
        row.lease_expires_at !== null ||
        row.workflow_state["handedOffTo"] !== result.childRunId
      ) {
        throw new StaleWorkflowAttemptError(attempt);
      }
    } else {
      const state =
        typeof result.state === "object" && result.state !== null
          ? (result.state as Record<string, unknown>)
          : {};
      if (result.status === "succeeded") {
        await markAttemptSucceeded(attempt, state, tx);
      } else if (result.status === "incomplete") {
        await markAttemptIncomplete(attempt, result.reason, state, tx);
      } else {
        await markAttemptFailed(attempt, result.reason, state, tx);
      }
    }

    const executionSucceeded = result.status === "succeeded" || result.status === "handed-off";
    const errorMessage =
      result.status === "failed" || result.status === "incomplete" ? result.reason : null;
    const executionRows: { delivery_id: string }[] = await tx`
      UPDATE executions
         SET status = ${executionSucceeded ? "completed" : "failed"},
             completed_at = now(),
             duration_ms = ${payload.durationMs},
             error_message = ${errorMessage},
             workflow_result_payload = ${payload}::jsonb,
             result_processed_at = NULL
       WHERE daemon_id = ${runnerId}
         AND offer_id = ${payload.attemptId}
         AND status = 'running'
      RETURNING delivery_id
    `;
    if (executionRows[0] === undefined) throw new StaleWorkflowAttemptError(attempt);
    return "stored";
  });
}

export interface PendingWorkflowRunnerResult {
  readonly runId: string;
  readonly attemptId: string;
  readonly executionDeliveryId: string;
  readonly payload: WorkflowRunnerResultPayload;
}

export type WorkflowRunnerResultProcessingState = "pending" | "processed" | "missing";

/** Read the durable projection receipt for one exact stored result. */
export async function getWorkflowRunnerResultProcessingState(
  pending: PendingWorkflowRunnerResult,
  sql: SQL = requireDb(),
): Promise<WorkflowRunnerResultProcessingState> {
  const rows: {
    workflow_result_payload: unknown;
    result_processed_at: Date | null;
  }[] = await sql`
    SELECT e.workflow_result_payload, e.result_processed_at
      FROM executions AS e
      JOIN workflow_runs AS wr ON wr.execution_delivery_id = e.delivery_id
     WHERE wr.id = ${pending.runId}
       AND wr.attempt_id = ${pending.attemptId}
       AND wr.execution_delivery_id = ${pending.executionDeliveryId}
       AND e.delivery_id = ${pending.executionDeliveryId}
       AND e.offer_id = ${pending.attemptId}
  `;
  const row = rows[0];
  if (row === undefined || row.workflow_result_payload === null) return "missing";
  const stored = WorkflowRunnerResultPayloadSchema.parse(row.workflow_result_payload);
  if (!sameJson(stored, pending.payload)) {
    throw new WorkflowRunnerCommandConflictError(pending.attemptId);
  }
  return row.result_processed_at === null ? "pending" : "processed";
}

export async function findPendingWorkflowRunnerResults(
  sql: SQL = requireDb(),
  limit = 100,
): Promise<PendingWorkflowRunnerResult[]> {
  const rows: {
    run_id: string;
    attempt_id: string;
    delivery_id: string;
    workflow_result_payload: unknown;
  }[] = await sql`
    SELECT wr.id AS run_id, wr.attempt_id, e.delivery_id, e.workflow_result_payload
      FROM executions AS e
      JOIN workflow_runs AS wr ON wr.execution_delivery_id = e.delivery_id
     WHERE e.workflow_result_payload IS NOT NULL
       AND e.result_processed_at IS NULL
       AND wr.attempt_id = e.offer_id
     ORDER BY e.completed_at
     LIMIT ${limit}
  `;
  // Per-row `safeParse`: a single unparseable stored payload must not reject the
  // whole loader. `reconcilePendingWorkflowRunnerResults` awaits this outside its
  // per-result try, so one bad row would otherwise stall every other pending
  // result behind it on every pass.
  const results: PendingWorkflowRunnerResult[] = [];
  for (const row of rows) {
    const parsed = WorkflowRunnerResultPayloadSchema.safeParse(row.workflow_result_payload);
    if (!parsed.success) {
      logger.error(
        {
          event: "workflow_runner_result_payload_invalid",
          runId: row.run_id,
          attemptId: row.attempt_id,
          err: parsed.error,
        },
        "Stored workflow runner result payload is schema-invalid; skipping",
      );
      continue;
    }
    results.push({
      runId: row.run_id,
      attemptId: row.attempt_id,
      executionDeliveryId: row.delivery_id,
      payload: parsed.data,
    });
  }
  return results;
}

export async function markWorkflowRunnerResultProcessed(
  attemptId: string,
  sql: SQL = requireDb(),
): Promise<boolean> {
  const rows: { delivery_id: string }[] = await sql`
    UPDATE executions
       SET result_processed_at = now()
     WHERE offer_id = ${attemptId}
       AND workflow_result_payload IS NOT NULL
       AND result_processed_at IS NULL
       AND status IN ('completed', 'failed')
    RETURNING delivery_id
  `;
  if (rows[0] !== undefined) return true;
  const existing: { processed: boolean }[] = await sql`
    SELECT result_processed_at IS NOT NULL AS processed
      FROM executions
     WHERE offer_id = ${attemptId}
       AND workflow_result_payload IS NOT NULL
  `;
  return existing[0]?.processed === true;
}

export async function findWorkflowRunnerCleanupCandidates(
  sql: SQL = requireDb(),
  limit = 100,
): Promise<{ runId: string; attemptId: string }[]> {
  const rows: { id: string; attempt_id: string }[] = await sql`
    SELECT wr.id, wr.attempt_id
      FROM workflow_runs AS wr
      JOIN executions AS e ON e.delivery_id = wr.execution_delivery_id
     WHERE wr.attempt_id IS NOT NULL
       AND wr.attempt_completed_at IS NOT NULL
       AND wr.runner_resources_cleaned_at IS NULL
       AND e.offer_id = wr.attempt_id
       AND e.status IN ('completed', 'failed')
     ORDER BY wr.attempt_completed_at
     LIMIT ${limit}
  `;
  return rows.map((row) => ({ runId: row.id, attemptId: row.attempt_id }));
}

export async function markWorkflowRunnerResourcesCleaned(
  attempt: WorkflowAttempt,
  sql: SQL = requireDb(),
): Promise<boolean> {
  const rows: { id: string }[] = await sql`
    UPDATE workflow_runs
       SET runner_resources_cleaned_at = now()
     WHERE id = ${attempt.runId}
       AND attempt_id = ${attempt.attemptId}
       AND attempt_completed_at IS NOT NULL
       AND runner_resources_cleaned_at IS NULL
    RETURNING id
  `;
  if (rows[0] !== undefined) return true;
  const existing: { cleaned: boolean }[] = await sql`
    SELECT runner_resources_cleaned_at IS NOT NULL AS cleaned
      FROM workflow_runs
     WHERE id = ${attempt.runId}
       AND attempt_id = ${attempt.attemptId}
  `;
  return existing[0]?.cleaned === true;
}

export async function listActiveWorkflowRunnerAttempts(
  sql: SQL = requireDb(),
  limit = 100,
): Promise<WorkflowRunnerAttempt[]> {
  const rows: {
    id: string;
    attempt_id: string;
    owner_id: string;
    execution_delivery_id: string;
    workflow_name: WorkflowRunnerAttempt["workflowName"];
    attempt_deadline_at: Date;
  }[] = await sql`
    SELECT id, attempt_id, owner_id, execution_delivery_id, workflow_name,
           attempt_deadline_at
      FROM workflow_runs
     WHERE status = 'running'
       AND attempt_id IS NOT NULL
       AND owner_id = ${RUNNER_ID_PREFIX} || attempt_id::text
       AND lease_expires_at > now()
       AND attempt_deadline_at > now()
     ORDER BY updated_at
     LIMIT ${limit}
  `;
  return rows.map((row) => ({
    runId: row.id,
    attemptId: row.attempt_id,
    runnerId: row.owner_id,
    executionDeliveryId: row.execution_delivery_id,
    workflowName: row.workflow_name,
    attemptDeadlineAt: row.attempt_deadline_at,
  }));
}

/** Fail one claimed runner attempt and its execution receipt atomically. */
export async function failWorkflowRunnerAttempt(
  attempt: WorkflowRunnerAttempt,
  reason: string,
  sql: SQL = requireDb(),
): Promise<WorkflowRunRow> {
  return sql.begin(async (tx) => {
    const row = await markAttemptFailed(
      { runId: attempt.runId, attemptId: attempt.attemptId },
      reason,
      { phase: "runner-start-failed" },
      tx,
    );
    const executions: { delivery_id: string }[] = await tx`
      UPDATE executions
         SET status = 'failed',
             completed_at = now(),
             error_message = ${reason},
             result_processed_at = now()
       WHERE delivery_id = ${attempt.executionDeliveryId}
         AND daemon_id = ${attempt.runnerId}
         AND offer_id = ${attempt.attemptId}
         AND status = 'running'
      RETURNING delivery_id
    `;
    if (executions[0] === undefined) throw new StaleWorkflowAttemptError(attempt);
    return row;
  });
}
