/**
 * Tickle scheduler integration test (T018). Boots `createTickleScheduler`
 * against an in-memory Valkey fake + the real Postgres test schema, ZADDs
 * a due intent, and asserts the injected `onDue` callback fires exactly
 * once. Validates the FR-020 round-trip the orchestrator boot relies on.
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

void mock.module("../../../src/db", () => ({
  requireDb: () => requireSql(),
  getDb: () => requireSql(),
  closeDb: () => Promise.resolve(),
}));

/**
 * Fake Valkey client implementing only the ZSET commands the scheduler
 * exercises (`ZADD`, `ZRANGEBYSCORE`, `ZREM`). The scheduler treats this
 * `Pick<RedisClient, "send">` shape as an opaque dependency, so a struct-
 * compatible fake is sufficient for the round-trip test.
 */
function makeFakeValkey(): {
  client: { send: (cmd: string, args: string[]) => Promise<unknown> };
  zset: Map<string, number>;
} {
  const zset = new Map<string, number>();
  return {
    zset,
    client: {
      send: (cmd, args) => {
        switch (cmd.toUpperCase()) {
          case "ZADD": {
            const [, score, member] = args;
            if (score !== undefined && member !== undefined) {
              zset.set(member, Number(score));
            }
            return Promise.resolve(1);
          }
          case "ZRANGEBYSCORE": {
            const [, min, max] = args;
            const minScore = Number(min);
            const maxScore = Number(max);
            const due = [...zset.entries()]
              .filter(([, s]) => s >= minScore && s <= maxScore)
              .map(([m]) => m);
            return Promise.resolve(due);
          }
          case "ZREM": {
            const [, member] = args;
            if (member !== undefined) zset.delete(member);
            return Promise.resolve(1);
          }
          default:
            return Promise.resolve(null);
        }
      },
    },
  };
}

describe.skipIf(sql === null)("createTickleScheduler, round-trip", () => {
  beforeAll(async () => {
    await requireSql().unsafe(`
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
    const { runMigrations } = await import("../../../src/db/migrate");
    await runMigrations(requireSql());
  });

  afterAll(async () => {
    await requireSql().close();
  });

  it("dispatches a due intent via the onDue callback within one tick", async () => {
    const { createTickleScheduler } = await import("../../../src/workflows/ship/tickle-scheduler");

    const valkey = makeFakeValkey();
    valkey.zset.set("intent-AAAA", 0); // due immediately

    const onDue = mock((_intent: string) => Promise.resolve());

    const scheduler = createTickleScheduler({
      sql: requireSql(),
      valkey: valkey.client,
      intervalMs: 25,
      onDue,
    });

    await scheduler.start();
    // Wait one full tick + buffer.
    await new Promise((r) => setTimeout(r, 80));
    scheduler.stop();

    expect(onDue).toHaveBeenCalledTimes(1);
    expect(onDue.mock.calls[0]?.[0]).toBe("intent-AAAA");
    expect(valkey.zset.has("intent-AAAA")).toBe(false);
  });

  it("re-arms a transient onDue failure so a Valkey blip does not strand the intent", async () => {
    const { createTickleScheduler } = await import("../../../src/workflows/ship/tickle-scheduler");

    const valkey = makeFakeValkey();
    valkey.zset.set("intent-BBBB", 0);

    let attempts = 0;
    const onDue = mock((_intent: string) => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error("transient"));
      return Promise.resolve();
    });

    const scheduler = createTickleScheduler({
      sql: requireSql(),
      valkey: valkey.client,
      intervalMs: 20,
      onDue,
    });

    await scheduler.start();
    await new Promise((r) => setTimeout(r, 200));
    scheduler.stop();

    // First call rejected → ZADD re-armed → second call (eventual) succeeded.
    expect(attempts).toBeGreaterThanOrEqual(2);
  });
});
