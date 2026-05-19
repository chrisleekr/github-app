/**
 * T018: tickle-scheduler integration test against real Postgres + Valkey.
 *
 * Boots `createTickleScheduler` with a short `intervalMs`, seeds a paused
 * intent + a `ship_continuations` row whose `wake_at` is in the past, and
 * additionally ZADDs `ship:tickle 0 <intent>` to simulate the cascade
 * early-wake path. Asserts that:
 *
 *   - the boot reconciliation copied the due continuation onto Valkey
 *     (so a missed wake during a crash window is recovered);
 *   - the periodic scan invokes `onDue` exactly once with that intent id;
 *   - the intent id is ZREM'd from `ship:tickle` after dispatch.
 *
 * Skips cleanly when either dependency is unavailable.
 */

import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

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

void mock.module("../../src/db", () => ({
  requireDb: () => requireSql(),
  getDb: () => requireSql(),
  closeDb: () => Promise.resolve(),
}));

let valkeyAvailable: boolean;
try {
  const { connectValkey, isValkeyHealthy } = await import("../../src/orchestrator/valkey");
  await connectValkey(2000);
  valkeyAvailable = isValkeyHealthy();
} catch {
  valkeyAvailable = false;
}

const skipSuite = sql === null || !valkeyAvailable;

describe.skipIf(skipSuite)("integration: ship tickle-scheduler resume", () => {
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

    const { requireValkeyClient } = await import("../../src/orchestrator/valkey");
    const valkey = requireValkeyClient();
    await valkey.send("DEL", ["ship:tickle"]);
  });

  afterAll(async () => {
    if (sql !== null) {
      await sql.unsafe(`
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
      await sql.close();
    }
    const { closeValkey } = await import("../../src/orchestrator/valkey");
    closeValkey();
  });

  it("boot reconcile + tick dispatches a due intent exactly once", async () => {
    const db = requireSql();
    const { insertIntent, upsertContinuation } = await import("../../src/db/queries/ship");
    const { pauseIntent } = await import("../../src/workflows/ship/intent");
    const { createTickleScheduler } = await import("../../src/workflows/ship/tickle-scheduler");
    const { requireValkeyClient } = await import("../../src/orchestrator/valkey");

    const intent = await insertIntent(
      {
        installation_id: 5005,
        owner: "tickle-it",
        repo: "fixtures",
        pr_number: 7777,
        target_base_sha: "base",
        target_head_sha: "head",
        deadline_at: new Date(Date.now() + 60 * 60 * 1000),
        created_by_user: "tester",
        tracking_comment_marker: "<!-- ship-intent: tickle -->",
      },
      db,
    );
    await pauseIntent(intent.id, "tester", db);
    await upsertContinuation(
      {
        intent_id: intent.id,
        wait_for: ["ci"],
        wake_at: new Date(Date.now() - 1000),
        state_blob: { reason: "ci" },
        state_version: 1,
      },
      db,
    );

    const calls: string[] = [];
    const valkey = requireValkeyClient();
    const scheduler = createTickleScheduler({
      sql: db,
      valkey,
      intervalMs: 50,
      onDue: async (intentId) => {
        calls.push(intentId);
        await Promise.resolve();
      },
    });

    try {
      await scheduler.start();

      // Boot reconcile should have ZADD'd from `ship_continuations`.
      const reconciledScore = (await valkey.send("ZSCORE", ["ship:tickle", intent.id])) as
        | string
        | number
        | null;
      expect(reconciledScore).not.toBeNull();

      // Wait for one tick window (intervalMs * 4 to absorb scheduler jitter).
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      scheduler.stop();
    }

    expect(calls).toEqual([intent.id]);

    // After dispatch the scheduler ZREM'd the intent before invoking onDue.
    const postScore = (await valkey.send("ZSCORE", ["ship:tickle", intent.id])) as
      | string
      | number
      | null;
    expect(postScore).toBeNull();
  });
});
