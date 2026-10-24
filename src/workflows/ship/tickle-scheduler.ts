/**
 * Cron tickle (R1). Wakes due continuations by scanning the Valkey
 * sorted set `ship:tickle` on a `CRON_TICKLE_INTERVAL_MS` cadence and
 * re-enqueueing each intent's continuation as a daemon job.
 *
 * On boot, reconciles from Postgres so a missed wake during a crash
 * window does not strand intents:
 *
 *   SELECT intent_id, wake_at
 *     FROM ship_continuations
 *    WHERE wake_at <= now() + interval '5 minutes';
 *
 * This module is a long-running side-effecting timer; tests start and
 * stop it explicitly via `start()` / `stop()`.
 */

import type { RedisClient, SQL } from "bun";

import { config } from "../../config";
import { requireDb } from "../../db";
import { logger } from "../../logger";
import { TICKLE_KEY } from "./webhook-reactor";

export interface TickleSchedulerDeps {
  readonly sql?: SQL;
  readonly valkey: Pick<RedisClient, "send">;
  readonly intervalMs?: number;
  readonly onDue: (intent_id: string) => Promise<void>;
}

export interface TickleScheduler {
  readonly start: () => Promise<void>;
  readonly stop: () => void;
}

/**
 * Build (but do not start) the scheduler. `start()` runs the boot
 * reconciliation then begins the periodic scan; `stop()` cancels the
 * timer. The dispatch step (`onDue`) is injected so the scheduler can
 * be exercised without a real daemon job pipeline.
 */
export function createTickleScheduler(deps: TickleSchedulerDeps): TickleScheduler {
  const sql = deps.sql ?? requireDb();
  const intervalMs = deps.intervalMs ?? config.cronTickleIntervalMs;
  let timer: ReturnType<typeof setInterval> | null = null;
  // Reentrancy guard: setInterval does not await the previous tick, so a
  // slow Valkey/onDue call could otherwise let two ticks process the same
  // due window concurrently and dispatch the same intent twice.
  let ticking = false;

  async function reconcileFromPostgres(): Promise<void> {
    const rows: { intent_id: string; wake_at: Date }[] = await sql`
      SELECT intent_id, wake_at FROM ship_continuations
       WHERE wake_at <= now() + interval '5 minutes'
    `;
    for (const row of rows) {
      const score = String(row.wake_at.getTime());
      await deps.valkey.send("ZADD", [TICKLE_KEY, score, row.intent_id]);
    }
    logger.info(
      { event: "ship.tickle.reconcile", count: rows.length },
      "ship tickle reconciled from Postgres",
    );
  }

  /*
   * Reentrancy guard against overlapping `setInterval` invocations.
   * The check-then-set pair below is safe because JS is single-threaded
   * and no `await` separates the read from the write: `setInterval`
   * can only re-enter `tick` on a separate event-loop turn, by which
   * point `ticking` is already `true`. ESLint's `require-atomic-updates`
   * conservatively flags any cross-async read/write of a closure
   * variable; disabled inline because the guarantee is structural.
   */
  /* eslint-disable eslint-js/require-atomic-updates */
  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const nowMs = String(Date.now());
      const due = (await deps.valkey.send("ZRANGEBYSCORE", [
        TICKLE_KEY,
        "0",
        nowMs,
        "LIMIT",
        "0",
        "100",
      ])) as string[] | null;
      if (due === null || due.length === 0) return;
      for (const intent_id of due) {
        await deps.valkey.send("ZREM", [TICKLE_KEY, intent_id]);
        try {
          await deps.onDue(intent_id);
        } catch (err) {
          // Re-arm so a transient dispatch failure doesn't strand the
          // session until startup reconciliation runs again.
          await deps.valkey.send("ZADD", [TICKLE_KEY, String(Date.now() + intervalMs), intent_id]);
          logger.error(
            { event: "ship.tickle.dispatch_failed", intent_id, err: String(err) },
            "ship tickle dispatch failed; requeued",
          );
        }
      }
    } finally {
      ticking = false;
    }
  }
  /* eslint-enable eslint-js/require-atomic-updates */

  return {
    start: async (): Promise<void> => {
      await reconcileFromPostgres();
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
    },
    stop: (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
