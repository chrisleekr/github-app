/**
 * Typed `Bun.sql` helpers for the `scheduled_action_state` table
 * (migration `013_scheduled_actions.sql`).
 *
 * The scheduler reads `last_run_at` to decide if a cron slot is due, then
 * claims the slot via a compare-and-swap UPDATE. Two guards make the claim
 * safe across multiple webhook-server replicas:
 *
 *   - `last_run_at < slotTime`: only one replica can advance past a slot.
 *   - `in_flight_job_id IS NULL OR in_flight_started_at < staleBefore`,
 *     single-flight: a run cannot start while the action's previous run is
 *     still live, unless that run is older than the stale window (the lock
 *     self-heals if a daemon died mid-run).
 */

import type { SQL } from "bun";

import { requireDb } from "..";

/** Identity of one scheduled action. */
export interface ScheduleKey {
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly actionName: string;
}

export interface ScheduledActionStateRow {
  readonly id: string;
  readonly installation_id: number;
  readonly owner: string;
  readonly repo: string;
  readonly action_name: string;
  readonly last_run_at: Date | null;
  readonly last_content_sha: string | null;
  readonly in_flight_job_id: string | null;
  readonly in_flight_started_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** Ensure a state row exists for this action (idempotent). */
async function ensureRow(key: ScheduleKey, sql: SQL): Promise<void> {
  await sql`
    INSERT INTO scheduled_action_state (installation_id, owner, repo, action_name)
    VALUES (${key.installationId}, ${key.owner}, ${key.repo}, ${key.actionName})
    ON CONFLICT (installation_id, owner, repo, action_name) DO NOTHING
  `;
}

/** Read the schedule-state row, or null if the action has never been seen. */
export async function getScheduleState(
  key: ScheduleKey,
  sql: SQL = requireDb(),
): Promise<ScheduledActionStateRow | null> {
  const rows: ScheduledActionStateRow[] = await sql`
    SELECT * FROM scheduled_action_state
     WHERE installation_id = ${key.installationId}
       AND owner = ${key.owner}
       AND repo = ${key.repo}
       AND action_name = ${key.actionName}
  `;
  return rows[0] ?? null;
}

/**
 * Claim a cron slot for a RUN. Atomically advances `last_run_at` to
 * `slotTime` and takes the single-flight lock (`in_flight_job_id` +
 * `in_flight_started_at`). Returns true iff this caller won the claim:
 *
 *   - `last_run_at < slotTime` rejects a racing replica for the same slot.
 *   - the in-flight guard rejects the claim while a prior run is live,
 *     unless that run started before `staleBefore` (lock self-heal).
 */
export async function claimScheduleSlotForRun(
  input: ScheduleKey & {
    slotTime: Date;
    contentSha: string | null;
    jobId: string;
    staleBefore: Date;
  },
  sql: SQL = requireDb(),
): Promise<boolean> {
  await ensureRow(input, sql);
  const rows: { id: string }[] = await sql`
    UPDATE scheduled_action_state
       SET last_run_at = ${input.slotTime},
           last_content_sha = ${input.contentSha},
           in_flight_job_id = ${input.jobId},
           in_flight_started_at = now()
     WHERE installation_id = ${input.installationId}
       AND owner = ${input.owner}
       AND repo = ${input.repo}
       AND action_name = ${input.actionName}
       AND (last_run_at IS NULL OR last_run_at < ${input.slotTime})
       AND (in_flight_job_id IS NULL OR in_flight_started_at < ${input.staleBefore})
    RETURNING id
  `;
  return rows.length === 1;
}

/**
 * Release the single-flight lock when a claimed slot fails to enqueue a job
 * (the run never started, so nothing is genuinely in-flight). Scoped to
 * `jobId` so it cannot clear a different run's lock. Without this the slot
 * would stay locked until the stale window elapses.
 */
export async function releaseInFlight(
  input: ScheduleKey & { jobId: string },
  sql: SQL = requireDb(),
): Promise<void> {
  await sql`
    UPDATE scheduled_action_state
       SET in_flight_job_id = NULL, in_flight_started_at = NULL
     WHERE installation_id = ${input.installationId}
       AND owner = ${input.owner}
       AND repo = ${input.repo}
       AND action_name = ${input.actionName}
       AND in_flight_job_id = ${input.jobId}
  `;
}

/**
 * Clear the single-flight lock when a scheduled-action run completes.
 * Called from the scoped-job-completion handler so a finished run releases
 * the lock immediately instead of waiting out the stale window: without this
 * any cron more frequent than the stale window would have its later slots
 * skipped even after the prior run finished. Scoped to `jobId` (the unique
 * per-run deliveryId) so it cannot clear a newer run's lock.
 */
export async function clearInFlightByJobId(jobId: string, sql: SQL = requireDb()): Promise<void> {
  await sql`
    UPDATE scheduled_action_state
       SET in_flight_job_id = NULL, in_flight_started_at = NULL
     WHERE in_flight_job_id = ${jobId}
  `;
}

/**
 * Advance past a MISSED slot without running it (the "skip missed slots"
 * policy). Only the `last_run_at < slotTime` guard applies: advancing is
 * safe even while a prior run is in-flight, and it does not touch the lock.
 */
export async function advanceScheduleSlot(
  input: ScheduleKey & { slotTime: Date; contentSha: string | null },
  sql: SQL = requireDb(),
): Promise<boolean> {
  await ensureRow(input, sql);
  const rows: { id: string }[] = await sql`
    UPDATE scheduled_action_state
       SET last_run_at = ${input.slotTime},
           last_content_sha = ${input.contentSha}
     WHERE installation_id = ${input.installationId}
       AND owner = ${input.owner}
       AND repo = ${input.repo}
       AND action_name = ${input.actionName}
       AND (last_run_at IS NULL OR last_run_at < ${input.slotTime})
    RETURNING id
  `;
  return rows.length === 1;
}
