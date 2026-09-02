import type { SQL } from "bun";

import { requireDb } from "../db";
import type { TriggerEventType } from "../shared/dispatch-types";
import type { WorkflowName } from "./registry";

/**
 * Persistence layer for the `workflow_runs` table. All writes preserve prior
 * fields in `state` via `state || $new::jsonb` so workflow-specific fields
 * (`verdict`, `pr_number`, `currentStepIndex`, …) accumulate across updates.
 */

export type WorkflowRunStatus = "queued" | "running" | "succeeded" | "failed" | "incomplete";

export type WorkflowOwnerKind = "orchestrator" | "daemon";

export interface WorkflowRunRow {
  id: string;
  workflow_name: WorkflowName;
  target_type: "issue" | "pr";
  target_owner: string;
  target_repo: string;
  target_number: number;
  parent_run_id: string | null;
  parent_step_index: number | null;
  status: WorkflowRunStatus;
  state: Record<string, unknown>;
  tracking_comment_id: number | null;
  delivery_id: string | null;
  owner_kind: WorkflowOwnerKind | null;
  owner_id: string | null;
  attempt_id: string | null;
  lease_expires_at: Date | null;
  attempt_deadline_at: Date | null;
  attempt_completed_at: Date | null;
  cascade_completed_at: Date | null;
  execution_delivery_id: string | null;
  trigger_body_preview: string;
  dispatch_enqueued_at: Date | null;
  dispatch_generation_id: string;
  dispatch_retry_count: number;
  runner_payload_issued_at: Date | null;
  runner_token_expires_at: Date | null;
  runner_resources_cleaned_at: Date | null;
  failure_notified_at: Date | null;
  trigger_comment_id: number | null;
  trigger_event_type: TriggerEventType | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Bun's Postgres driver returns BIGINT columns as strings to preserve
 * precision. GitHub issue-comment IDs fit comfortably inside JS's safe integer
 * range, so we coerce to `number` here rather than leaking the driver detail
 * up through the rest of the codebase.
 */
function normalizeRow(row: WorkflowRunRow): WorkflowRunRow {
  const tracking_comment_id = coerceBigintId(row.tracking_comment_id as unknown);
  const trigger_comment_id = coerceBigintId(row.trigger_comment_id as unknown);
  return { ...row, tracking_comment_id, trigger_comment_id };
}

function coerceBigintId(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") return Number(raw);
  return raw as number;
}

export interface InsertQueuedParams {
  workflowName: WorkflowName;
  target: {
    type: "issue" | "pr";
    owner: string;
    repo: string;
    number: number;
  };
  parentRunId?: string | null;
  parentStepIndex?: number | null;
  deliveryId?: string | null;
  executionDeliveryId?: string | null;
  triggerBodyPreview?: string;
  initialState?: Record<string, unknown>;
  /**
   * Identifier of the process responsible for advancing this row. The
   * liveness reaper resolves the matching Valkey heartbeat key from
   * `(ownerKind, ownerId)` and fails the row if the key is missing.
   */
  ownerKind: WorkflowOwnerKind;
  ownerId: string;
  /**
   * REST id of the user comment that triggered this run. NULL for
   * label-triggered or system-spawned runs (no comment to react on).
   */
  triggerCommentId?: number | null;
  triggerEventType?: TriggerEventType | null;
}

export interface WorkflowAttempt {
  readonly runId: string;
  readonly attemptId: string;
}

export class StaleWorkflowAttemptError extends Error {
  constructor(attempt: WorkflowAttempt) {
    super(`workflow attempt is no longer current: ${attempt.attemptId}`);
    this.name = "StaleWorkflowAttemptError";
  }
}

/**
 * Insert a new `queued` row. Throws if the partial unique index rejects the
 * insert (another in-flight run for the same (workflow, target) exists).
 */
export async function insertQueued(
  params: InsertQueuedParams,
  sql: SQL = requireDb(),
): Promise<WorkflowRunRow> {
  const parentRunId = params.parentRunId ?? null;
  const parentStepIndex = params.parentStepIndex ?? null;
  const deliveryId = params.deliveryId ?? null;
  const executionDeliveryId = params.executionDeliveryId ?? deliveryId;
  const triggerBodyPreview = params.triggerBodyPreview ?? "";
  const state = params.initialState ?? {};
  const triggerCommentId = params.triggerCommentId ?? null;
  const triggerEventType = params.triggerEventType ?? null;

  const rows: WorkflowRunRow[] = await sql`
    INSERT INTO workflow_runs (
      workflow_name, target_type, target_owner, target_repo, target_number,
      parent_run_id, parent_step_index, status, state, delivery_id,
      execution_delivery_id, trigger_body_preview, owner_kind, owner_id,
      trigger_comment_id, trigger_event_type
    ) VALUES (
      ${params.workflowName}, ${params.target.type}, ${params.target.owner},
      ${params.target.repo}, ${params.target.number},
      ${parentRunId}, ${parentStepIndex}, 'queued', ${state}::jsonb, ${deliveryId},
      ${executionDeliveryId}, ${triggerBodyPreview}, ${params.ownerKind}, ${params.ownerId},
      ${triggerCommentId}, ${triggerEventType}
    )
    RETURNING *
  `;

  const row = rows[0];
  if (row === undefined) {
    throw new Error("insertQueued returned no row");
  }
  return normalizeRow(row);
}

function requireAttemptRow(rows: WorkflowRunRow[], attempt: WorkflowAttempt): WorkflowRunRow {
  const row = rows[0];
  if (row === undefined) throw new StaleWorkflowAttemptError(attempt);
  return normalizeRow(row);
}

export async function renewWorkflowAttempts(
  daemonId: string,
  attemptIds: readonly string[],
  leaseMs: number,
  sql: SQL = requireDb(),
): Promise<{ renewedAttemptIds: string[]; fencedAttemptIds: string[] }> {
  if (attemptIds.length === 0) return { renewedAttemptIds: [], fencedAttemptIds: [] };
  const requested = [...new Set(attemptIds)];
  const rows: { attempt_id: string }[] = await sql`
    UPDATE workflow_runs
       SET lease_expires_at = LEAST(
             attempt_deadline_at,
             now() + ${leaseMs} * interval '1 millisecond'
           )
     WHERE status = 'running'
       AND owner_kind = 'daemon'
       AND owner_id = ${daemonId}
       AND attempt_id IN ${sql(requested)}
       AND lease_expires_at > now()
       AND attempt_deadline_at > now()
    RETURNING attempt_id
  `;
  const renewed = new Set(rows.map((row) => row.attempt_id));
  return {
    renewedAttemptIds: requested.filter((attemptId) => renewed.has(attemptId)),
    fencedAttemptIds: requested.filter((attemptId) => !renewed.has(attemptId)),
  };
}

export async function assertCurrentWorkflowAttempt(
  attempt: WorkflowAttempt,
  sql: SQL = requireDb(),
): Promise<void> {
  const rows: { current: number }[] = await sql`
    SELECT 1 AS current
      FROM workflow_runs
     WHERE id = ${attempt.runId}
       AND attempt_id = ${attempt.attemptId}
       AND status = 'running'
       AND lease_expires_at > now()
       AND attempt_deadline_at > now()
  `;
  if (rows[0] === undefined) throw new StaleWorkflowAttemptError(attempt);
}

export async function mergeAttemptState(
  attempt: WorkflowAttempt,
  patch: Record<string, unknown>,
  sql: SQL = requireDb(),
): Promise<WorkflowRunRow> {
  const rows: WorkflowRunRow[] = await sql`
    UPDATE workflow_runs
       SET state = state || ${patch}::jsonb
     WHERE id = ${attempt.runId}
       AND attempt_id = ${attempt.attemptId}
       AND status = 'running'
       AND lease_expires_at > now()
       AND attempt_deadline_at > now()
    RETURNING *
  `;
  return requireAttemptRow(rows, attempt);
}

export async function markAttemptSucceeded(
  attempt: WorkflowAttempt,
  state: Record<string, unknown>,
  sql: SQL = requireDb(),
): Promise<WorkflowRunRow> {
  const rows: WorkflowRunRow[] = await sql`
    UPDATE workflow_runs
       SET status = 'succeeded',
           state = state || ${state}::jsonb,
           lease_expires_at = NULL,
           attempt_completed_at = now()
     WHERE id = ${attempt.runId}
       AND attempt_id = ${attempt.attemptId}
       AND status = 'running'
       AND lease_expires_at > now()
       AND attempt_deadline_at > now()
    RETURNING *
  `;
  return requireAttemptRow(rows, attempt);
}

export async function markAttemptFailed(
  attempt: WorkflowAttempt,
  reason: string,
  state: Record<string, unknown> = {},
  sql: SQL = requireDb(),
): Promise<WorkflowRunRow> {
  const merged = { ...state, failedReason: reason };
  const rows: WorkflowRunRow[] = await sql`
    UPDATE workflow_runs
       SET status = 'failed',
           state = state || ${merged}::jsonb,
           lease_expires_at = NULL,
           attempt_completed_at = now()
     WHERE id = ${attempt.runId}
       AND attempt_id = ${attempt.attemptId}
       AND status = 'running'
       AND lease_expires_at > now()
       AND attempt_deadline_at > now()
    RETURNING *
  `;
  return requireAttemptRow(rows, attempt);
}

export async function markAttemptIncomplete(
  attempt: WorkflowAttempt,
  reason: string,
  state: Record<string, unknown> = {},
  sql: SQL = requireDb(),
): Promise<WorkflowRunRow> {
  const merged = { ...state, incompleteReason: reason };
  const rows: WorkflowRunRow[] = await sql`
    UPDATE workflow_runs
       SET status = 'incomplete',
           state = state || ${merged}::jsonb,
           lease_expires_at = NULL,
           attempt_completed_at = now()
     WHERE id = ${attempt.runId}
       AND attempt_id = ${attempt.attemptId}
       AND status = 'running'
       AND lease_expires_at > now()
       AND attempt_deadline_at > now()
    RETURNING *
  `;
  return requireAttemptRow(rows, attempt);
}

export interface AttemptHandOffChild {
  readonly workflowName: WorkflowName;
  readonly target: InsertQueuedParams["target"];
  readonly parentStepIndex: number;
  readonly traceDeliveryId: string | null;
  readonly childRunId?: string;
}

/**
 * Commit a composite hand-off only while the parent attempt lease is current.
 *
 * Writes only the `workflow_runs` half of the durable pair. The caller owes the
 * matching `recordWorkflowExecution` in the SAME transaction: the dispatch
 * outbox joins `executions` on `execution_delivery_id`, so a child row without
 * its execution row never dispatches and strands the target behind the
 * in-flight index.
 */
export async function commitAttemptHandOffChild(
  attempt: WorkflowAttempt,
  state: Record<string, unknown>,
  child: AttemptHandOffChild,
  sql: SQL,
): Promise<WorkflowRunRow> {
  const childRunId = child.childRunId ?? crypto.randomUUID();
  const parentState = { ...state, handedOffTo: childRunId };
  const parentRows: WorkflowRunRow[] = await sql`
    UPDATE workflow_runs
       SET state = state || ${parentState}::jsonb,
           lease_expires_at = NULL,
           attempt_completed_at = now()
     WHERE id = ${attempt.runId}
       AND attempt_id = ${attempt.attemptId}
       AND status = 'running'
       AND lease_expires_at > now()
       AND attempt_deadline_at > now()
    RETURNING *
  `;
  requireAttemptRow(parentRows, attempt);

  const rows: WorkflowRunRow[] = await sql`
    INSERT INTO workflow_runs (
      id, workflow_name, target_type, target_owner, target_repo, target_number,
      parent_run_id, parent_step_index, status, state, delivery_id,
      execution_delivery_id, owner_kind, owner_id
    ) VALUES (
      ${childRunId}, ${child.workflowName}, ${child.target.type}, ${child.target.owner},
      ${child.target.repo}, ${child.target.number}, ${attempt.runId},
      ${child.parentStepIndex}, 'queued', '{}'::jsonb, ${child.traceDeliveryId},
      ${childRunId}, NULL, NULL
    )
    RETURNING *
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("commitAttemptHandOffChild returned no child row");
  return normalizeRow(row);
}

/**
 * Dormant on this branch: no scheduler calls this yet. The isolated-runner
 * slice wires it into `liveness-reaper.ts` `reapOnce()`, which is the interval
 * `src/app.ts` already starts. Until both land together, a crash between the
 * row commit and the Valkey publish is not swept up.
 */
export async function expireWorkflowAttempts(sql: SQL = requireDb()): Promise<WorkflowRunRow[]> {
  const rows: WorkflowRunRow[] = await sql`
    UPDATE workflow_runs
       SET status = 'failed',
           state = state || jsonb_build_object(
             'failedReason', CASE
               WHEN attempt_deadline_at <= now()
                 THEN 'workflow execution deadline expired'
               ELSE 'workflow execution lease expired'
             END,
             'phase', CASE
               WHEN attempt_deadline_at <= now() THEN 'deadline-expired'
               ELSE 'lease-expired'
             END
           ),
           lease_expires_at = NULL,
           attempt_completed_at = now()
     WHERE status = 'running'
       AND attempt_id IS NOT NULL
       AND lease_expires_at IS NOT NULL
       AND attempt_deadline_at IS NOT NULL
       AND LEAST(lease_expires_at, attempt_deadline_at) <= now()
    RETURNING *
  `;
  return rows.map(normalizeRow);
}

/**
 * Dormant on this branch: no scheduler calls this yet. The isolated-runner
 * slice wires it into `liveness-reaper.ts` `reapOnce()`, which is the interval
 * `src/app.ts` already starts. Until both land together, a crash between the
 * row commit and the Valkey publish is not swept up.
 */
/** Fail queued workflow dispatches whose retry or wall-clock budget is exhausted. */
export async function expireQueuedWorkflowDispatches(
  maxAgeMs: number,
  maxRetries: number,
  sql: SQL = requireDb(),
): Promise<WorkflowRunRow[]> {
  const rows: WorkflowRunRow[] = await sql`
    UPDATE workflow_runs
       SET status = 'failed',
           state = state || jsonb_build_object(
             'failedReason', CASE
               WHEN dispatch_retry_count > ${maxRetries}
                 THEN 'workflow dispatch retries exhausted'
               ELSE 'workflow dispatch deadline expired'
             END,
             'phase', 'dispatch-expired'
           ),
           owner_kind = NULL,
           owner_id = NULL,
           attempt_completed_at = now()
     WHERE status = 'queued'
       AND attempt_id IS NULL
       AND execution_delivery_id IS NOT NULL
       AND (
         dispatch_retry_count > ${maxRetries}
         OR created_at <= now() - ${maxAgeMs} * interval '1 millisecond'
       )
    RETURNING *
  `;
  return rows.map(normalizeRow);
}

export type WorkflowFailureNotificationPhase =
  | "deadline-expired"
  | "lease-expired"
  | "dispatch-expired"
  | "runner-start-failed"
  | "orphaned"
  | "migration-interrupted";

export interface PendingWorkflowFailureNotification {
  readonly row: WorkflowRunRow;
  readonly phase: WorkflowFailureNotificationPhase;
}

/** Read terminal workflow failures whose public projection has no durable receipt. */
export async function findPendingWorkflowFailureNotifications(
  sql: SQL = requireDb(),
  limit = 100,
): Promise<PendingWorkflowFailureNotification[]> {
  const rows: WorkflowRunRow[] = await sql`
    SELECT *
      FROM workflow_runs
     WHERE status = 'failed'
       AND attempt_completed_at IS NOT NULL
       AND failure_notified_at IS NULL
       AND state ->> 'phase' IN (
           'deadline-expired',
           'lease-expired',
           'dispatch-expired',
           'runner-start-failed',
           'orphaned',
           'migration-interrupted'
       )
     ORDER BY attempt_completed_at
     LIMIT ${limit}
  `;
  return rows.map((row) => ({
    row: normalizeRow(row),
    phase: row.state["phase"] as WorkflowFailureNotificationPhase,
  }));
}

/**
 * Claim the right to post one failure notice for this attempt.
 *
 * A compare-and-set, not an upsert: `failure_notified_at IS NULL` is in the
 * WHERE so exactly one caller gets `true`. Two orchestrator instances, or a
 * reconciler racing the live path, would otherwise both see success and both
 * comment on the same PR.
 */
export async function markWorkflowFailureNotified(
  receipt: { readonly runId: string; readonly attemptId: string | null },
  sql: SQL = requireDb(),
): Promise<boolean> {
  const rows: { id: string }[] = await sql`
    UPDATE workflow_runs
       SET failure_notified_at = now()
     WHERE id = ${receipt.runId}
       AND attempt_id IS NOT DISTINCT FROM ${receipt.attemptId}::uuid
       AND status = 'failed'
       AND attempt_completed_at IS NOT NULL
       AND failure_notified_at IS NULL
    RETURNING id
  `;
  return rows[0] !== undefined;
}

/** Mark a terminal attempt's parent cascade as durably applied. */
export async function markAttemptCascadeCompleted(
  attempt: WorkflowAttempt,
  sql: SQL = requireDb(),
): Promise<boolean> {
  const rows: { id: string }[] = await sql`
    UPDATE workflow_runs
       SET cascade_completed_at = COALESCE(cascade_completed_at, now())
     WHERE id = ${attempt.runId}
       AND attempt_id = ${attempt.attemptId}
       AND attempt_completed_at IS NOT NULL
       AND status IN ('succeeded', 'failed', 'incomplete')
    RETURNING id
  `;
  return rows[0] !== undefined;
}

export async function findByAttemptId(
  attemptId: string,
  sql: SQL = requireDb(),
): Promise<WorkflowRunRow | null> {
  const rows: WorkflowRunRow[] = await sql`
    SELECT * FROM workflow_runs WHERE attempt_id = ${attemptId}
  `;
  const row = rows[0];
  return row === undefined ? null : normalizeRow(row);
}

/**
 * Clearing `owner_kind` / `owner_id` takes the row out of `reapOnce()`'s
 * heartbeat-based sweep, which is correct once a runner owns the lease. A
 * published-but-unclaimed row is instead expired by
 * `expireQueuedWorkflowDispatches`, which is dormant on this branch (see its
 * note), so until the isolated-runner slice schedules it such a row sits in
 * `queued` past WORKFLOW_DISPATCH_TIMEOUT_MS with nothing to fail it.
 */
/** Close only the queued dispatch generation that was actually published. */
export async function markDispatchEnqueued(
  runId: string,
  expectedGeneration: string,
  expectedEnqueuedAt: Date | null,
  sql: SQL = requireDb(),
): Promise<boolean> {
  const rows: { id: string }[] = await sql`
    UPDATE workflow_runs
       SET dispatch_enqueued_at = now(),
           owner_kind = NULL,
           owner_id = NULL
     WHERE id = ${runId}
       AND status = 'queued'
       AND date_trunc('milliseconds', dispatch_enqueued_at)
             IS NOT DISTINCT FROM ${expectedEnqueuedAt}
       AND dispatch_generation_id = ${expectedGeneration}
    RETURNING id
  `;
  return rows[0] !== undefined;
}

/** Count a failed publish only while the same queued generation is current. */
export async function recordWorkflowDispatchPublishFailure(
  runId: string,
  expectedGeneration: string,
  expectedEnqueuedAt: Date | null,
  sql: SQL = requireDb(),
): Promise<number | null> {
  const rows: { dispatch_retry_count: number }[] = await sql`
    UPDATE workflow_runs
       SET dispatch_retry_count = dispatch_retry_count + 1
     WHERE id = ${runId}
       AND status = 'queued'
       AND attempt_id IS NULL
       AND dispatch_generation_id = ${expectedGeneration}
       AND date_trunc('milliseconds', dispatch_enqueued_at)
             IS NOT DISTINCT FROM ${expectedEnqueuedAt}
    RETURNING dispatch_retry_count
  `;
  return rows[0]?.dispatch_retry_count ?? null;
}

/**
 * Merge arbitrary fields into `state` without changing status. Used by
 * handlers to persist progress mid-run (e.g. the tracking-comment mirror).
 */
export async function mergeState(
  runId: string,
  patch: Record<string, unknown>,
  sql: SQL = requireDb(),
): Promise<void> {
  await sql`
    UPDATE workflow_runs
       SET state = state || ${patch}::jsonb
     WHERE id = ${runId}
  `;
}

/**
 * Record the GitHub comment id for the run's tracking comment. Called once,
 * after the comment is first created on GitHub.
 */
export async function setTrackingCommentId(
  runId: string,
  commentId: number,
  sql: SQL = requireDb(),
): Promise<void> {
  await sql`
    UPDATE workflow_runs
       SET tracking_comment_id = ${commentId}
     WHERE id = ${runId}
  `;
}

/**
 * Compare-and-set variant of {@link setTrackingCommentId}. Only writes the
 * row when `tracking_comment_id IS NULL`, so two racing creators cannot both
 * stamp their own comment ids. Returns the winning comment id: our `commentId`
 * if we won, or the pre-existing value if another worker got there first.
 */
export function tryReserveTrackingCommentId(
  runId: string,
  commentId: number,
  sql?: SQL,
): Promise<{ won: boolean; trackingCommentId: number }>;
export function tryReserveTrackingCommentId(
  runId: string,
  commentId: number,
  attempt: WorkflowAttempt,
  sql?: SQL,
): Promise<{ won: boolean; trackingCommentId: number }>;
export async function tryReserveTrackingCommentId(
  runId: string,
  commentId: number,
  sqlOrAttempt: SQL | WorkflowAttempt = requireDb(),
  explicitSql?: SQL,
): Promise<{ won: boolean; trackingCommentId: number }> {
  const attempt = typeof sqlOrAttempt === "function" ? undefined : sqlOrAttempt;
  const sql = typeof sqlOrAttempt === "function" ? sqlOrAttempt : (explicitSql ?? requireDb());
  if (attempt !== undefined && attempt.runId !== runId) {
    throw new StaleWorkflowAttemptError(attempt);
  }
  const rows: { tracking_comment_id: number | string }[] = await sql`
    UPDATE workflow_runs
       SET tracking_comment_id = ${commentId}
     WHERE id = ${runId}
       AND tracking_comment_id IS NULL
       ${attempt === undefined ? sql`` : sql`AND attempt_id = ${attempt.attemptId} AND status = 'running' AND lease_expires_at > now() AND attempt_deadline_at > now()`}
    RETURNING tracking_comment_id
  `;
  if (rows[0] !== undefined) {
    return { won: true, trackingCommentId: coerceCommentId(rows[0].tracking_comment_id) };
  }
  const existing: { tracking_comment_id: number | string | null }[] =
    attempt === undefined
      ? await sql`SELECT tracking_comment_id FROM workflow_runs WHERE id = ${runId}`
      : await sql`
          SELECT tracking_comment_id
            FROM workflow_runs
           WHERE id = ${runId}
             AND attempt_id = ${attempt.attemptId}
             AND status = 'running'
             AND lease_expires_at > now()
             AND attempt_deadline_at > now()
        `;
  const rawExisting = existing[0]?.tracking_comment_id ?? null;
  if (rawExisting === null) {
    if (attempt !== undefined) throw new StaleWorkflowAttemptError(attempt);
    throw new Error(
      `tryReserveTrackingCommentId: run ${runId} has no tracking_comment_id and CAS did not update`,
    );
  }
  return { won: false, trackingCommentId: coerceCommentId(rawExisting) };
}

/**
 * Bun's Postgres driver returns BIGINT as a string to avoid precision loss.
 * GitHub comment ids fit inside JS's safe integer range, so we coerce to
 * `number` here. Mirrors the treatment in `normalizeRow`.
 */
function coerceCommentId(raw: number | string): number {
  return typeof raw === "string" ? Number(raw) : raw;
}

export async function findById(
  runId: string,
  sql: SQL = requireDb(),
): Promise<WorkflowRunRow | null> {
  const rows: WorkflowRunRow[] = await sql`
    SELECT * FROM workflow_runs WHERE id = ${runId}
  `;
  const row = rows[0];
  return row === undefined ? null : normalizeRow(row);
}

/** Resolve an ambiguously committed workflow/execution pair by exact identity. */
export async function findCommittedWorkflowDispatch(
  input: {
    readonly workflowName: WorkflowName;
    readonly target: InsertQueuedParams["target"];
    readonly executionDeliveryId: string;
  },
  sql: SQL = requireDb(),
): Promise<WorkflowRunRow | null> {
  const rows: WorkflowRunRow[] = await sql`
    SELECT wr.*
      FROM workflow_runs AS wr
      JOIN executions AS e ON e.delivery_id = wr.execution_delivery_id
     WHERE wr.workflow_name = ${input.workflowName}
       AND wr.target_type = ${input.target.type}
       AND wr.target_owner = ${input.target.owner}
       AND wr.target_repo = ${input.target.repo}
       AND wr.target_number = ${input.target.number}
       AND wr.execution_delivery_id = ${input.executionDeliveryId}
       AND e.delivery_id = ${input.executionDeliveryId}
     LIMIT 1
  `;
  const row = rows[0];
  return row === undefined ? null : normalizeRow(row);
}

/**
 * Return the in-flight row for (workflow, target) if one exists. The partial
 * unique index guarantees at most one.
 */
export async function findInflight(
  workflowName: WorkflowName,
  target: { owner: string; repo: string; number: number },
  sql: SQL = requireDb(),
): Promise<WorkflowRunRow | null> {
  const rows: WorkflowRunRow[] = await sql`
    SELECT * FROM workflow_runs
     WHERE workflow_name = ${workflowName}
       AND target_owner = ${target.owner}
       AND target_repo = ${target.repo}
       AND target_number = ${target.number}
       AND status IN ('queued', 'running')
     LIMIT 1
  `;
  const row = rows[0];
  return row === undefined ? null : normalizeRow(row);
}

/**
 * Return the most-recent row for (workflow, target) regardless of status.
 * Used by the prior-output check (FR-004) and the `ship` resume path.
 */
export async function findLatestForTarget(
  workflowName: WorkflowName,
  target: { owner: string; repo: string; number: number },
  sql: SQL = requireDb(),
): Promise<WorkflowRunRow | null> {
  const rows: WorkflowRunRow[] = await sql`
    SELECT * FROM workflow_runs
     WHERE workflow_name = ${workflowName}
       AND target_owner = ${target.owner}
       AND target_repo = ${target.repo}
       AND target_number = ${target.number}
     ORDER BY created_at DESC
     LIMIT 1
  `;
  const row = rows[0];
  return row === undefined ? null : normalizeRow(row);
}

/**
 * Return the most-recent `succeeded` row for (workflow, target). Used by the
 * prior-output check (FR-004): a later `failed` row must not block a dispatch
 * that has a valid prior success earlier in history.
 */
export async function findLatestSucceededForTarget(
  workflowName: WorkflowName,
  target: { owner: string; repo: string; number: number },
  sql: SQL = requireDb(),
): Promise<WorkflowRunRow | null> {
  const rows: WorkflowRunRow[] = await sql`
    SELECT * FROM workflow_runs
     WHERE workflow_name = ${workflowName}
       AND target_owner = ${target.owner}
       AND target_repo = ${target.repo}
       AND target_number = ${target.number}
       AND status = 'succeeded'
     ORDER BY created_at DESC
     LIMIT 1
  `;
  const row = rows[0];
  return row === undefined ? null : normalizeRow(row);
}

/**
 * Terminal prior runs of the same (workflow, target) that still have a
 * tracking comment on GitHub. Used by the re-run cleanup in
 * `tracking-mirror.setState` to delete a workflow's stale output comment
 * before posting the new run's comment, keeping the thread free of pile-up.
 *
 * `status NOT IN ('queued','running')` excludes in-flight runs: their
 * comments are live. `id <> excludeRunId` excludes the current run. The
 * `workflow_name` match scopes cleanup to the same workflow.
 *
 * The `parent_run_id` clause protects a composite's children: a row that is
 * a child of a still-in-flight `ship` parent is left alone, otherwise a
 * standalone `bot:plan` re-run would delete the `plan` child comment that a
 * live `ship` composite's tracking comment still deep-links to. Standalone
 * runs (`parent_run_id IS NULL`) and children of terminal composites are
 * eligible.
 */
export async function findPriorTrackingComments(
  workflowName: WorkflowName,
  target: { owner: string; repo: string; number: number },
  excludeRunId: string,
  sql: SQL = requireDb(),
): Promise<{ runId: string; trackingCommentId: number }[]> {
  const rows: { id: string; tracking_comment_id: number | string }[] = await sql`
    SELECT id, tracking_comment_id FROM workflow_runs r
     WHERE workflow_name = ${workflowName}
       AND target_owner = ${target.owner}
       AND target_repo = ${target.repo}
       AND target_number = ${target.number}
       AND id <> ${excludeRunId}
       AND tracking_comment_id IS NOT NULL
       AND status NOT IN ('queued', 'running')
       AND (
         parent_run_id IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM workflow_runs p
            WHERE p.id = r.parent_run_id
              AND p.status IN ('queued', 'running')
         )
       )
  `;
  return rows.map((r) => ({
    runId: r.id,
    trackingCommentId: coerceCommentId(r.tracking_comment_id),
  }));
}

/**
 * Null out a run's `tracking_comment_id` after its tracking comment has been
 * deleted from GitHub by the re-run cleanup. Without this, the row keeps a
 * dangling id and `findPriorTrackingComments` would return it on every future
 * re-run, re-attempting a 404 delete each time.
 */
export async function clearTrackingCommentId(runId: string, sql: SQL = requireDb()): Promise<void> {
  await sql`
    UPDATE workflow_runs SET tracking_comment_id = NULL WHERE id = ${runId}
  `;
}

/** Clear a prior row only while the current workflow attempt still owns its lease. */
export async function clearTrackingCommentIdForAttempt(
  priorRunId: string,
  attempt: WorkflowAttempt,
  sql: SQL = requireDb(),
): Promise<void> {
  const rows: { attempt_current: boolean }[] = await sql`
    WITH current_attempt AS MATERIALIZED (
      SELECT 1
        FROM workflow_runs
       WHERE id = ${attempt.runId}
         AND attempt_id = ${attempt.attemptId}
         AND status = 'running'
         AND lease_expires_at > now()
         AND attempt_deadline_at > now()
    ), cleared AS (
      UPDATE workflow_runs
         SET tracking_comment_id = NULL
       WHERE id = ${priorRunId}
         AND EXISTS (SELECT 1 FROM current_attempt)
      RETURNING id
    )
    SELECT EXISTS (SELECT 1 FROM current_attempt) AS attempt_current
      FROM (SELECT count(*) FROM cleared) AS applied
  `;
  if (rows[0]?.attempt_current !== true) throw new StaleWorkflowAttemptError(attempt);
}

/**
 * Children of a composite parent, ordered by step index. Used by the
 * orchestrator to compute the next step.
 */
export async function listChildrenByParent(
  parentRunId: string,
  sql: SQL = requireDb(),
): Promise<WorkflowRunRow[]> {
  const rows = (await sql`
    SELECT * FROM workflow_runs
     WHERE parent_run_id = ${parentRunId}
     ORDER BY parent_step_index ASC
  `) as unknown as WorkflowRunRow[];
  return rows.map(normalizeRow);
}
