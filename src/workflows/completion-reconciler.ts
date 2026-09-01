import type { SQL } from "bun";
import type { Octokit } from "octokit";
import type pino from "pino";

import { requireDb } from "../db";
import { logger } from "../logger";
import { type CompletionResult, onStepComplete } from "./orchestrator";
import {
  findByAttemptId,
  markAttemptCascadeCompleted,
  type WorkflowAttempt,
  type WorkflowRunRow,
} from "./runs-store";

function completionFromRow(row: WorkflowRunRow): CompletionResult | null {
  if (row.status === "succeeded") return { status: "succeeded" };
  if (row.status === "incomplete") {
    const reason = row.state["incompleteReason"];
    return {
      status: "failed",
      reason: `incomplete: ${typeof reason === "string" ? reason : "workflow incomplete"}`,
    };
  }
  if (row.status === "failed") {
    const reason = row.state["failedReason"];
    return {
      status: "failed",
      reason: typeof reason === "string" ? reason : "workflow failed",
    };
  }
  return null;
}

/** Apply a terminal workflow's parent cascade before its result can be acknowledged. */
export async function ensureWorkflowCascadeForOffer(
  offerId: string,
  log: pino.Logger = logger,
  sql: SQL = requireDb(),
  octokit: Octokit | null = null,
): Promise<"not-workflow" | "pending" | "complete"> {
  const row = await findByAttemptId(offerId, sql);
  if (row === null) return "not-workflow";
  if (row.attempt_completed_at === null) return "pending";
  const completion = completionFromRow(row);
  if (completion === null || row.cascade_completed_at !== null) return "complete";

  await onStepComplete(
    { octokit, logger: log, emitGitHub: octokit !== null, sql },
    row.id,
    completion,
  );
  const attempt: WorkflowAttempt = { runId: row.id, attemptId: offerId };
  if (!(await markAttemptCascadeCompleted(attempt, sql))) {
    throw new Error("Workflow cascade receipt was no longer current");
  }
  return "complete";
}

/** Retry terminal cascades left pending by a daemon or orchestrator crash. */
export async function reconcilePendingWorkflowCascades(
  sql: SQL = requireDb(),
  limit = 100,
): Promise<number> {
  const rows: { attempt_id: string }[] = await sql`
    SELECT wr.attempt_id
      FROM workflow_runs AS wr
      JOIN executions AS e ON e.delivery_id = wr.execution_delivery_id
     WHERE wr.attempt_id IS NOT NULL
       AND wr.attempt_completed_at IS NOT NULL
       AND wr.cascade_completed_at IS NULL
       AND wr.status IN ('succeeded', 'failed', 'incomplete')
       AND NOT (e.workflow_result_payload IS NOT NULL AND e.result_processed_at IS NULL)
     ORDER BY wr.attempt_completed_at
     LIMIT ${limit}
  `;
  let completed = 0;
  for (const row of rows) {
    try {
      // eslint-disable-next-line no-await-in-loop -- cascades are ordered and bounded
      if ((await ensureWorkflowCascadeForOffer(row.attempt_id, logger, sql)) === "complete") {
        completed++;
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err : new Error(String(err)), attemptId: row.attempt_id },
        "Pending workflow cascade failed",
      );
    }
  }
  return completed;
}
