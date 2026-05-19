/**
 * T033: fix-attempts ledger tests. Real Postgres.
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

const { recordAttempt, getAttempts, isCapped } =
  await import("../../../src/workflows/ship/fix-attempts");
const { insertIntent } = await import("../../../src/db/queries/ship");

async function makeIntent(suffix: number): Promise<string> {
  const intent = await insertIntent(
    {
      installation_id: 99,
      owner: "acme",
      repo: "repo",
      pr_number: 600 + suffix,
      target_base_sha: `base-${suffix}`,
      target_head_sha: `head-${suffix}`,
      deadline_at: new Date(Date.now() + 3_600_000),
      created_by_user: "alice",
      tracking_comment_marker: `<!-- m -->`,
    },
    requireSql(),
  );
  return intent.id;
}

describe.skipIf(sql === null)("fix-attempts ledger (T033)", () => {
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

  it("increments on new attempt then on subsequent attempts", async () => {
    const id = await makeIntent(1);
    const a = await recordAttempt({ intent_id: id, signature: "sig-A", tier: 1 });
    expect(a.attempts).toBe(1);
    const b = await recordAttempt({ intent_id: id, signature: "sig-A", tier: 1 });
    expect(b.attempts).toBe(2);
  });

  it("isCapped fires once attempts >= cap (3 by default)", async () => {
    const id = await makeIntent(2);
    expect(await isCapped(id, "sig-X")).toBe(false);
    await recordAttempt({ intent_id: id, signature: "sig-X", tier: 2 });
    await recordAttempt({ intent_id: id, signature: "sig-X", tier: 2 });
    expect(await isCapped(id, "sig-X")).toBe(false);
    await recordAttempt({ intent_id: id, signature: "sig-X", tier: 2 });
    expect(await isCapped(id, "sig-X")).toBe(true);
  });

  it("attempts persist across iterations within a single intent", async () => {
    const id = await makeIntent(3);
    await recordAttempt({ intent_id: id, signature: "sig-Y", tier: 1 });
    await recordAttempt({ intent_id: id, signature: "sig-Y", tier: 1 });
    const row = await getAttempts(id, "sig-Y");
    expect(row?.attempts).toBe(2);
  });

  it("isolation between intents: same signature, different intents", async () => {
    const idA = await makeIntent(4);
    const idB = await makeIntent(5);
    await recordAttempt({ intent_id: idA, signature: "sig-Z", tier: 1 });
    await recordAttempt({ intent_id: idA, signature: "sig-Z", tier: 1 });
    expect((await getAttempts(idA, "sig-Z"))?.attempts).toBe(2);
    expect(await getAttempts(idB, "sig-Z")).toBeNull();
    expect(await isCapped(idB, "sig-Z")).toBe(false);
  });
});
