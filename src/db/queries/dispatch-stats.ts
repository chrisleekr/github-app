/**
 * FR-014 operator aggregate queries for the triage-dispatch-modes feature.
 *
 * Thin typed wrappers over `Bun.sql` for the four dispatch-telemetry
 * aggregate queries. Operator dashboards and ad-hoc reports read through this module so
 * the SQL stays in one place: any future schema migration only needs to
 * update the queries here.
 *
 * All queries accept a `days` window (default 30) and use parameterised
 * intervals (`NOW() - make_interval(days => $1)`) so the caller-provided
 * value cannot build into a SQL-injection surface. The backing indexes
 * (`idx_executions_dispatch_target_created_at`,
 * `idx_triage_results_created_at`) from migration 003 keep each query in
 * the low-millisecond range at expected data volumes.
 *
 * Each function also accepts an optional `sql` override that defaults to
 * the `requireDb()` singleton. Tests pass a dedicated connection so they
 * don't have to mutate `process.env.DATABASE_URL` (which wouldn't take
 * effect anyway once `config` is captured at first import).
 */

import type { SQL } from "bun";

import type { DispatchTarget } from "../../shared/dispatch-types";
import { requireDb } from "..";

/**
 * One row per distinct `dispatch_target` observed in the window. The
 * `events` counter is bigint in Postgres; Bun.sql returns JS `number` for
 * values up to `Number.MAX_SAFE_INTEGER`, which covers every realistic
 * volume here.
 */
export interface EventsPerTargetRow {
  readonly dispatch_target: DispatchTarget;
  readonly events: number;
}

/**
 * One row per calendar day covered by the window. `triaged` counts rows
 * whose `dispatch_reason` came from the auto-triage cascade; `total`
 * counts all rows. `triage_pct` is pre-rounded to 2 dp for dashboards.
 */
export interface TriageRateRow {
  readonly day: string;
  readonly triaged: number;
  readonly total: number;
  readonly triage_pct: number;
}

/**
 * Single-row summary of triage classifier performance. `avg_confidence`
 * is the raw mean; `sub_threshold_rate` is the share of calls whose
 * confidence fell below 1.0 (i.e. the router used the secondary target
 * on a "default-fallback" reason). Both are NULL when no triage calls
 * landed in the window: consumers must treat that explicitly.
 */
export interface ConfidenceAndFallbackRow {
  readonly avg_confidence: number | null;
  readonly sub_threshold_rate: number | null;
}

/**
 * Single-row summary of total triage spend across the window. NULL when
 * no triage calls landed.
 */
export interface TriageSpendRow {
  readonly total_triage_spend_usd: number | null;
}

/**
 * 5.1: Events per dispatch target, last `days` days.
 *
 * Returns rows ordered by event count descending. Targets with zero
 * events in the window are omitted (GROUP BY only surfaces observed
 * values); treat a missing row as `events === 0`.
 */
export async function eventsPerTarget(
  days = 30,
  sql: SQL = requireDb(),
): Promise<EventsPerTargetRow[]> {
  const rows: EventsPerTargetRow[] = await sql`
    SELECT dispatch_target, COUNT(*)::int AS events
    FROM executions
    WHERE created_at >= NOW() - make_interval(days => ${days})
    GROUP BY dispatch_target
    ORDER BY events DESC
  `;
  return rows;
}

/**
 * 5.2: Triage-driven ephemeral spawn rate per day, last `days` days.
 *
 * Post dispatch-collapse, triage runs on every request, so the useful
 * aggregate is no longer "did triage run?" but rather "did triage drive
 * a scale-up?": `dispatch_reason = 'ephemeral-daemon-triage'`.
 */
export async function triageRate(days = 30, sql: SQL = requireDb()): Promise<TriageRateRow[]> {
  const rows: TriageRateRow[] = await sql`
    SELECT
      DATE(created_at)::text AS day,
      COUNT(*) FILTER (
        WHERE dispatch_reason = 'ephemeral-daemon-triage'
      )::int AS triaged,
      COUNT(*)::int AS total,
      COALESCE(
        ROUND(
          100.0
            * COUNT(*) FILTER (
                WHERE dispatch_reason = 'ephemeral-daemon-triage'
              )
            / NULLIF(COUNT(*), 0),
          2
        ),
        0
      )::float AS triage_pct
    FROM executions
    WHERE created_at >= NOW() - make_interval(days => ${days})
    GROUP BY day
    ORDER BY day DESC
  `;
  return rows;
}

/**
 * 5.3: Average classifier confidence and sub-threshold fallback rate.
 *
 * Reads `triage_results` directly so the avg is over _successful_
 * triage parses only: failures (timeout / parse-error / circuit-open)
 * never reach this table.
 *
 * `sub_threshold_rate` uses a hardcoded `confidence < 1.0` predicate to
 * measure "any doubt" from the classifier: this is intentionally distinct
 * from the configurable `TRIAGE_CONFIDENCE_THRESHOLD` env var used at
 * runtime for routing decisions. Keep them separate on future edits so
 * dashboards don't silently change meaning when operators tune the
 * routing threshold.
 */
export async function avgConfidenceAndFallback(
  days = 30,
  sql: SQL = requireDb(),
): Promise<ConfidenceAndFallbackRow> {
  const rows: ConfidenceAndFallbackRow[] = await sql`
    SELECT
      AVG(confidence)::float AS avg_confidence,
      (COUNT(*) FILTER (WHERE confidence < 1.0) * 1.0 / NULLIF(COUNT(*), 0))::float
        AS sub_threshold_rate
    FROM triage_results
    WHERE created_at >= NOW() - make_interval(days => ${days})
  `;
  return rows[0] ?? { avg_confidence: null, sub_threshold_rate: null };
}

/**
 * 5.4: Total triage spend in USD, last `days` days. Used as a rough
 * budget monitor; returns `{ total_triage_spend_usd: null }` when no
 * triage calls landed in the window.
 */
export async function triageSpend(days = 30, sql: SQL = requireDb()): Promise<TriageSpendRow> {
  const rows: TriageSpendRow[] = await sql`
    SELECT SUM(cost_usd)::float AS total_triage_spend_usd
    FROM triage_results
    WHERE created_at >= NOW() - make_interval(days => ${days})
  `;
  return rows[0] ?? { total_triage_spend_usd: null };
}
