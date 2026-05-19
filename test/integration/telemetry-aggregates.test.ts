/**
 * Integration test for the operator aggregate queries in
 * `src/db/queries/dispatch-stats.ts`, post dispatch-collapse.
 *
 * Seeds a realistic mix of `executions` + `triage_results` rows through
 * the real migration pipeline, then runs each query and asserts shapes
 * and aggregate values. Skips cleanly when the DB is unreachable so
 * contributors without local infra can still run `bun test`.
 */

import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const TEST_DATABASE_URL =
  process.env["TEST_DATABASE_URL"] ?? "postgres://bot:bot@localhost:5432/github_app_test";

let sql: SQL | null = null;
try {
  const conn = new SQL(TEST_DATABASE_URL);
  await conn`SELECT 1 AS ok`;
  sql = conn;
} catch {
  sql = null;
}

function requireSql(): SQL {
  if (sql === null) throw new Error("Database not available, test should have been skipped");
  return sql;
}

describe.skipIf(sql === null)("FR-014 aggregate queries, dispatch-stats.ts", () => {
  beforeAll(async () => {
    const db = requireSql();
    await db.unsafe(`
      DROP TABLE IF EXISTS _migrations CASCADE;
      DROP TABLE IF EXISTS scheduled_action_state CASCADE;
      DROP TABLE IF EXISTS comment_cache CASCADE;
      DROP TABLE IF EXISTS target_cache CASCADE;
      DROP TABLE IF EXISTS chat_proposals CASCADE;
      DROP TABLE IF EXISTS ship_fix_attempts CASCADE;
      DROP TABLE IF EXISTS ship_continuations CASCADE;
      DROP TABLE IF EXISTS ship_iterations CASCADE;
      DROP TABLE IF EXISTS ship_intents CASCADE;
      DROP TABLE IF EXISTS workflow_runs CASCADE;
      DROP TABLE IF EXISTS repo_memory CASCADE;
      DROP TABLE IF EXISTS triage_results CASCADE;
      DROP TABLE IF EXISTS executions CASCADE;
      DROP TABLE IF EXISTS daemons CASCADE;
    `);
    const { runMigrations } = await import("../../src/db/migrate");
    await runMigrations(db);

    // Post-collapse dispatch values: target always 'daemon'; reason in
    // {persistent-daemon, ephemeral-daemon-triage, ephemeral-daemon-overflow,
    // ephemeral-spawn-failed}. All rows inside the default 30-day window
    // except the '60 days' out-of-window row used for window-filter coverage.
    await db`
      INSERT INTO executions (
        delivery_id, repo_owner, repo_name, entity_number, entity_type,
        event_name, trigger_username, dispatch_mode, dispatch_target, dispatch_reason,
        triage_confidence, triage_cost_usd, status, created_at
      ) VALUES
        ('d-1',  'o', 'r', 1,  'issue', 'issue_comment', 'u', 'daemon', 'daemon', 'persistent-daemon',         NULL, NULL, 'queued', NOW() - INTERVAL '6 hours'),
        ('d-2',  'o', 'r', 2,  'issue', 'issue_comment', 'u', 'daemon', 'daemon', 'ephemeral-daemon-triage',   0.92, 0.0009, 'queued', NOW() - INTERVAL '6 hours'),
        ('d-3',  'o', 'r', 3,  'issue', 'issue_comment', 'u', 'daemon', 'daemon', 'persistent-daemon',         0.55, 0.0008, 'queued', NOW() - INTERVAL '6 hours'),
        ('d-4',  'o', 'r', 4,  'issue', 'issue_comment', 'u', 'daemon', 'daemon', 'ephemeral-spawn-failed',    NULL, NULL, 'queued', NOW() - INTERVAL '2 days'),
        ('d-5',  'o', 'r', 5,  'issue', 'issue_comment', 'u', 'daemon', 'daemon', 'persistent-daemon',         NULL, NULL, 'queued', NOW() - INTERVAL '2 days'),
        ('d-6',  'o', 'r', 6,  'issue', 'issue_comment', 'u', 'daemon', 'daemon', 'ephemeral-daemon-overflow', NULL, NULL, 'queued', NOW() - INTERVAL '2 days'),
        ('d-old','o', 'r', 99, 'issue', 'issue_comment', 'u', 'daemon', 'daemon', 'persistent-daemon',         NULL, NULL, 'queued', NOW() - INTERVAL '60 days')
    `;

    // Triage rows, three in-window (two with confidence < 1.0) plus one outside.
    await db`
      INSERT INTO triage_results (
        delivery_id, mode, confidence, heavy, rationale,
        cost_usd, latency_ms, provider, model, created_at
      ) VALUES
        ('d-2',         'daemon', 0.92, true,  'ok',    0.0009, 300, 'anthropic', 'haiku-3-5', NOW() - INTERVAL '6 hours'),
        ('d-3',         'daemon', 0.55, false, 'weak',  0.0008, 250, 'anthropic', 'haiku-3-5', NOW() - INTERVAL '6 hours'),
        ('d-7',         'daemon', 1.00, true,  'solid', 0.0010, 400, 'anthropic', 'haiku-3-5', NOW() - INTERVAL '3 days'),
        ('d-old-triage','daemon', 0.80, false, 'aged',  0.0007, 280, 'anthropic', 'haiku-3-5', NOW() - INTERVAL '60 days')
    `;
  });

  afterAll(async () => {
    const db = requireSql();
    await db.unsafe(`
      DROP TABLE IF EXISTS _migrations CASCADE;
      DROP TABLE IF EXISTS scheduled_action_state CASCADE;
      DROP TABLE IF EXISTS comment_cache CASCADE;
      DROP TABLE IF EXISTS target_cache CASCADE;
      DROP TABLE IF EXISTS chat_proposals CASCADE;
      DROP TABLE IF EXISTS ship_fix_attempts CASCADE;
      DROP TABLE IF EXISTS ship_continuations CASCADE;
      DROP TABLE IF EXISTS ship_iterations CASCADE;
      DROP TABLE IF EXISTS ship_intents CASCADE;
      DROP TABLE IF EXISTS workflow_runs CASCADE;
      DROP TABLE IF EXISTS repo_memory CASCADE;
      DROP TABLE IF EXISTS triage_results CASCADE;
      DROP TABLE IF EXISTS executions CASCADE;
      DROP TABLE IF EXISTS daemons CASCADE;
    `);
    await db.close();
  });

  it("eventsPerTarget, all rows collapse to 'daemon' post-migration", async () => {
    const { eventsPerTarget } = await import("../../src/db/queries/dispatch-stats");
    const rows = await eventsPerTarget(30, requireSql());
    expect(rows.length).toBe(1);
    expect(rows[0]?.dispatch_target).toBe("daemon");
    // 6 rows in the 30-day window; the 60-day row is excluded.
    expect(rows[0]?.events).toBe(6);
  });

  it("triageRate: counts ephemeral-daemon-triage as triaged", async () => {
    const { triageRate } = await import("../../src/db/queries/dispatch-stats");
    const rows = await triageRate(30, requireSql());

    const totalTriaged = rows.reduce((acc, r) => acc + r.triaged, 0);
    const totalAll = rows.reduce((acc, r) => acc + r.total, 0);
    // Only d-2 has reason='ephemeral-daemon-triage'; 6 total in-window.
    expect(totalTriaged).toBe(1);
    expect(totalAll).toBe(6);

    for (const r of rows) {
      expect(typeof r.triage_pct).toBe("number");
      expect(r.triage_pct).toBeGreaterThanOrEqual(0);
      expect(r.triage_pct).toBeLessThanOrEqual(100);
    }
  });

  it("avgConfidenceAndFallback: averages over triage_results only, in-window", async () => {
    const { avgConfidenceAndFallback } = await import("../../src/db/queries/dispatch-stats");
    const row = await avgConfidenceAndFallback(30, requireSql());

    expect(row.avg_confidence).not.toBeNull();
    // (0.92 + 0.55 + 1.00) / 3 ≈ 0.823
    expect(row.avg_confidence).toBeGreaterThan(0.8);
    expect(row.avg_confidence).toBeLessThan(0.85);

    expect(row.sub_threshold_rate).not.toBeNull();
    expect(row.sub_threshold_rate).toBeCloseTo(2 / 3, 5);
  });

  it("triageSpend: sums cost_usd across in-window triage_results", async () => {
    const { triageSpend } = await import("../../src/db/queries/dispatch-stats");
    const row = await triageSpend(30, requireSql());

    expect(row.total_triage_spend_usd).not.toBeNull();
    expect(row.total_triage_spend_usd).toBeCloseTo(0.0027, 6);
  });

  it("queries honour the `days` parameter, shrinking the window drops rows", async () => {
    const { eventsPerTarget, triageSpend } = await import("../../src/db/queries/dispatch-stats");

    // 1-day window: only d-1, d-2, d-3 survive (3 rows).
    const rows = await eventsPerTarget(1, requireSql());
    expect(rows.length).toBe(1);
    expect(rows[0]?.dispatch_target).toBe("daemon");
    expect(rows[0]?.events).toBe(3);

    const spend = await triageSpend(1, requireSql());
    expect(spend.total_triage_spend_usd).toBeCloseTo(0.0017, 6);
  });
});
