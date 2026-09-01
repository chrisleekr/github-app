import type { SQL } from "bun";

import { config } from "../config";
import { requireDb } from "../db";
import { logger } from "../logger";
import { getInstanceId } from "../orchestrator/instance-id";
import { ensureWorkflowJobQueued, type WorkflowRunQueuedJob } from "../orchestrator/job-queue";
import {
  markDispatchEnqueued,
  recordWorkflowDispatchPublishFailure,
  type WorkflowRunRow,
} from "./runs-store";

export const WORKFLOW_DISPATCH_RECONCILE_GRACE_MS = Math.max(
  60_000,
  3 * config.livenessReaperIntervalMs,
);

interface PendingDispatchRow extends WorkflowRunRow {
  execution_context_json: Record<string, unknown> | null;
  execution_event_name: string;
  execution_trigger_username: string;
}

async function loadPendingDispatch(runId: string, sql: SQL): Promise<PendingDispatchRow | null> {
  const rows: PendingDispatchRow[] = await sql`
    SELECT wr.*,
           e.context_json AS execution_context_json,
           e.event_name AS execution_event_name,
           e.trigger_username AS execution_trigger_username
      FROM workflow_runs wr
      JOIN executions e ON e.delivery_id = wr.execution_delivery_id
     WHERE wr.id = ${runId}
       AND wr.status = 'queued'
       AND wr.dispatch_retry_count <= ${config.jobMaxRetries}
       AND wr.created_at > now() - ${config.workflowDispatchTimeoutMs} * interval '1 millisecond'
       AND (
         wr.dispatch_enqueued_at IS NULL
         OR wr.dispatch_enqueued_at < now() - ${WORKFLOW_DISPATCH_RECONCILE_GRACE_MS} * interval '1 millisecond'
       )
  `;
  return rows[0] ?? null;
}

function queuedJob(row: PendingDispatchRow): WorkflowRunQueuedJob {
  if (row.execution_delivery_id === null) {
    throw new Error(`Workflow run ${row.id} has no execution delivery id`);
  }
  const labels = row.execution_context_json?.["labels"];
  return {
    kind: "workflow-run",
    deliveryId: row.execution_delivery_id,
    repoOwner: row.target_owner,
    repoName: row.target_repo,
    entityNumber: row.target_number,
    isPR: row.target_type === "pr",
    eventName: row.execution_event_name,
    triggerUsername: row.execution_trigger_username || config.botAppLogin,
    labels: Array.isArray(labels)
      ? labels.filter((label): label is string => typeof label === "string")
      : [],
    triggerBodyPreview: row.trigger_body_preview,
    enqueuedAt: row.created_at.getTime(),
    retryCount: row.dispatch_retry_count,
    workflowRun: {
      runId: row.id,
      workflowName: row.workflow_name,
      ...(row.parent_run_id !== null && row.parent_step_index !== null
        ? { parentRunId: row.parent_run_id, parentStepIndex: row.parent_step_index }
        : {}),
    },
  };
}

/** Publish one committed workflow row. A duplicate publish is safe at the offer CAS. */
export async function publishWorkflowRunById(
  runId: string,
  sql: SQL = requireDb(),
): Promise<boolean> {
  const row = await loadPendingDispatch(runId, sql);
  if (row?.execution_delivery_id === null || row?.execution_delivery_id === undefined) return false;
  try {
    await ensureWorkflowJobQueued(queuedJob(row), getInstanceId());
  } catch (err) {
    await recordWorkflowDispatchPublishFailure(
      row.id,
      row.dispatch_generation_id,
      row.dispatch_enqueued_at,
      sql,
    ).catch((receiptErr: unknown) => {
      logger.error(
        { err: receiptErr, runId: row.id },
        "Workflow dispatch publish failure receipt could not be recorded",
      );
    });
    throw err;
  }
  return markDispatchEnqueued(row.id, row.dispatch_generation_id, row.dispatch_enqueued_at, sql);
}

/** Retry workflow rows committed before their Valkey publish completed. */
export async function publishPendingWorkflowRuns(
  sql: SQL = requireDb(),
  limit = 100,
): Promise<number> {
  const rows: { id: string }[] = await sql`
    SELECT id
      FROM workflow_runs
     WHERE status = 'queued'
       AND execution_delivery_id IS NOT NULL
       AND dispatch_retry_count <= ${config.jobMaxRetries}
       AND created_at > now() - ${config.workflowDispatchTimeoutMs} * interval '1 millisecond'
       AND (
         dispatch_enqueued_at IS NULL
         OR dispatch_enqueued_at < now() - ${WORKFLOW_DISPATCH_RECONCILE_GRACE_MS} * interval '1 millisecond'
       )
     ORDER BY created_at
     LIMIT ${limit}
  `;
  let published = 0;
  for (const row of rows) {
    try {
      // eslint-disable-next-line no-await-in-loop -- queue publication is bounded and ordered
      if (await publishWorkflowRunById(row.id, sql)) published++;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err : new Error(String(err)), runId: row.id },
        "Pending workflow dispatch publish failed",
      );
    }
  }
  return published;
}
