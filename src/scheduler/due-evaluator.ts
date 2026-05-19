/**
 * Pure cron due-evaluation for scheduled actions. No I/O: unit-testable
 * in isolation.
 *
 * Given an action's cron, timezone, and last-claimed slot, decide what the
 * scheduler should do this tick:
 *
 *   - "run":     a fresh slot fired within the grace window → enqueue a job.
 *   - "advance": the slot fired but the grace window has passed (the server
 *                was down across it) → advance `last_run_at` WITHOUT running.
 *                This is the "skip missed slots" policy: a daily action
 *                missed for three days runs zero times, not three.
 *   - "idle":    no new slot since `last_run_at` → do nothing.
 *
 * The grace window is sized at 2x the scan interval so a slot is never
 * dropped merely because a tick landed slightly late.
 */

import { CronExpressionParser } from "cron-parser";

export type DueAction = "run" | "advance" | "idle";

export interface DueDecisionInput {
  readonly cron: string;
  readonly timezone: string;
  /** Most recent slot already claimed (run or advanced-over); null if never. */
  readonly lastRunAt: Date | null;
  readonly now: Date;
  /** Grace window in ms: a slot older than this is "missed", not "run". */
  readonly graceMs: number;
}

export interface DueDecision {
  readonly action: DueAction;
  /** The cron slot this decision concerns; null when no past slot exists. */
  readonly slotTime: Date | null;
}

/**
 * Decide whether an action's most-recent cron slot is due. `cron` and
 * `timezone` are assumed already validated by `githubAppConfigSchema`.
 */
export function computeDueDecision(input: DueDecisionInput): DueDecision {
  const expr = CronExpressionParser.parse(input.cron, {
    tz: input.timezone,
    currentDate: input.now,
  });

  // `prev` = the most recent scheduled fire time at or before `now`.
  let prev: Date;
  try {
    prev = expr.prev().toDate();
  } catch {
    // No prior occurrence (cron only fires in the future), nothing due.
    return { action: "idle", slotTime: null };
  }

  // Already claimed this slot (or a later one).
  if (input.lastRunAt !== null && input.lastRunAt.getTime() >= prev.getTime()) {
    return { action: "idle", slotTime: prev };
  }

  // Fresh slot within the grace window → run it.
  if (input.now.getTime() - prev.getTime() <= input.graceMs) {
    return { action: "run", slotTime: prev };
  }

  // Slot fired while the server was down past the grace window → skip it.
  return { action: "advance", slotTime: prev };
}
