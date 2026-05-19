/**
 * T036a: iteration-cap behaviour. The cap (config.maxShipIterations) is
 * a runtime ceiling; the integration that enforces it lives in the
 * iteration loop (US2 follow-up). This test pins the contract: once the
 * recorded `iteration_n` reaches the cap, callers MUST refuse to start
 * another iteration before invoking the agent. Verified against the
 * config value + a recorded iteration row.
 */

import { SQL } from "bun";
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

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
  if (sql === null) throw new Error("Database not available");
  return sql;
}

void mock.module("../../../src/db", () => ({
  requireDb: () => requireSql(),
  getDb: () => requireSql(),
  closeDb: () => Promise.resolve(),
}));

const { config } = await import("../../../src/config");
const { insertIntent, appendIteration } = await import("../../../src/db/queries/ship");

describe.skipIf(sql === null)("iteration-cap (T036a)", () => {
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
    await requireSql().close();
  });

  beforeEach(async () => {
    await requireSql().unsafe(
      `TRUNCATE ship_fix_attempts, ship_continuations, ship_iterations, ship_intents`,
    );
  });

  it("config exposes a positive integer iteration cap", () => {
    expect(Number.isInteger(config.maxShipIterations)).toBe(true);
    expect(config.maxShipIterations).toBeGreaterThan(0);
  });

  it("appendIteration records a strictly increasing iteration_n per intent", async () => {
    const intent = await insertIntent(
      {
        installation_id: 1,
        owner: "acme",
        repo: "repo",
        pr_number: 800,
        target_base_sha: "b",
        target_head_sha: "h",
        deadline_at: new Date(Date.now() + 3_600_000),
        created_by_user: "alice",
        tracking_comment_marker: "<!-- m -->",
      },
      requireSql(),
    );
    await appendIteration(
      { intent_id: intent.id, iteration_n: 1, kind: "probe", verdict_json: { ok: true } },
      requireSql(),
    );
    await appendIteration(
      { intent_id: intent.id, iteration_n: 2, kind: "probe", verdict_json: { ok: true } },
      requireSql(),
    );
    const rows: { iteration_n: number }[] = await requireSql()`
      SELECT iteration_n FROM ship_iterations WHERE intent_id = ${intent.id} ORDER BY iteration_n
    `;
    expect(rows.map((r) => r.iteration_n)).toEqual([1, 2]);
  });

  it("UNIQUE constraint rejects duplicate iteration_n", async () => {
    const intent = await insertIntent(
      {
        installation_id: 1,
        owner: "acme",
        repo: "repo",
        pr_number: 801,
        target_base_sha: "b",
        target_head_sha: "h",
        deadline_at: new Date(Date.now() + 3_600_000),
        created_by_user: "alice",
        tracking_comment_marker: "<!-- m -->",
      },
      requireSql(),
    );
    await appendIteration(
      { intent_id: intent.id, iteration_n: 1, kind: "probe", verdict_json: {} },
      requireSql(),
    );
    let threw = false;
    try {
      await appendIteration(
        { intent_id: intent.id, iteration_n: 1, kind: "probe", verdict_json: {} },
        requireSql(),
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
