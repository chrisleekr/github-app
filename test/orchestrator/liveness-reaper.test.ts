/**
 * Integration test for the heartbeat-based liveness reaper.
 *
 * Seeds workflow_runs rows owned by both alive and dead orchestrators/
 * daemons, sets the matching Valkey heartbeat keys, and asserts that
 * `reapOnce()` flips only the abandoned rows to `failed` (with a reason in
 * `state`). Also asserts the daemons-table sweep flips only daemons
 * missing a `daemon:{id}` heartbeat.
 *
 * The reaper relies on real SQL (`UPDATE … RETURNING`) and real Valkey
 * (`SCAN orchestrator:*:alive`, `SMEMBERS active_daemons`, `EXISTS …`),
 * so this test owns both clients via the project's standard
 * `TEST_DATABASE_URL` / `VALKEY_URL` env vars.
 */

import { SQL } from "bun";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

const TEST_DATABASE_URL =
  process.env["TEST_DATABASE_URL"] ?? "postgres://bot:bot@localhost:5432/github_app_test";
const TEST_VALKEY_URL = process.env["VALKEY_URL"] ?? "redis://localhost:6379";

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

describe.skipIf(sql === null)("liveness-reaper", () => {
  beforeAll(async () => {
    process.env["VALKEY_URL"] = TEST_VALKEY_URL;
    const { connectValkey } = await import("../../src/orchestrator/valkey");
    await connectValkey();

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
    const { runMigrations } = await import("../../src/db/migrate");
    await runMigrations(requireSql());
  });

  afterAll(async () => {
    const { closeValkey } = await import("../../src/orchestrator/valkey");
    closeValkey();
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
    await requireSql()`DELETE FROM workflow_runs`;
    await requireSql()`DELETE FROM daemons`;
    const { requireValkeyClient } = await import("../../src/orchestrator/valkey");
    const valkey = requireValkeyClient();
    // Wipe any leftover heartbeat keys from prior runs.
    const orchKeys: string[] = [];
    let cursor = "0";
    do {
      // eslint-disable-next-line no-await-in-loop -- Valkey SCAN
      const result: [string, string[]] = await valkey.send("SCAN", [
        cursor,
        "MATCH",
        "orchestrator:*:alive",
        "COUNT",
        "100",
      ]);
      cursor = result[0];
      orchKeys.push(...result[1]);
    } while (cursor !== "0");
    if (orchKeys.length > 0) await valkey.send("DEL", orchKeys);
    const daemonMembers: string[] = await valkey.send("SMEMBERS", ["active_daemons"]);
    for (const id of daemonMembers) {
      await valkey.send("DEL", [`daemon:${id}`]);
    }
    await valkey.send("DEL", ["active_daemons"]);
  });

  async function setOrchestratorAlive(id: string): Promise<void> {
    const { requireValkeyClient } = await import("../../src/orchestrator/valkey");
    await requireValkeyClient().send("SET", [`orchestrator:${id}:alive`, "1", "EX", "60"]);
  }

  async function setDaemonAlive(id: string): Promise<void> {
    const { requireValkeyClient } = await import("../../src/orchestrator/valkey");
    const valkey = requireValkeyClient();
    await valkey.send("SET", [`daemon:${id}`, "{}", "EX", "60"]);
    await valkey.send("SADD", ["active_daemons", id]);
  }

  async function insertWorkflowRow(
    target: { number: number },
    ownerKind: "orchestrator" | "daemon",
    ownerId: string,
    status: "queued" | "running" | "succeeded" = "queued",
  ): Promise<string> {
    const rows: { id: string }[] = await requireSql()`
      INSERT INTO workflow_runs (
        workflow_name, target_type, target_owner, target_repo, target_number,
        status, state, owner_kind, owner_id
      ) VALUES (
        'triage', 'issue', 'acme', 'repo', ${target.number},
        ${status}, '{}'::jsonb, ${ownerKind}, ${ownerId}
      )
      RETURNING id
    `;
    if (rows[0] === undefined) throw new Error("seed insert returned no row");
    return rows[0].id;
  }

  it("reaps orchestrator-owned rows whose owner heartbeat is missing", async () => {
    await setOrchestratorAlive("orch-alive");
    const liveId = await insertWorkflowRow({ number: 1001 }, "orchestrator", "orch-alive");
    const deadId = await insertWorkflowRow({ number: 1002 }, "orchestrator", "orch-dead");

    const { reapOnce } = await import("../../src/orchestrator/liveness-reaper");
    const result = await reapOnce(requireSql());

    expect(result.workflowRunsReaped.map((r) => r.id)).toEqual([deadId]);

    const [aliveRow] = await requireSql()<
      { status: string; state: Record<string, unknown> }[]
    >`SELECT status, state FROM workflow_runs WHERE id = ${liveId}`;
    expect(aliveRow?.status).toBe("queued");

    const [deadRow] = await requireSql()<
      { status: string; state: Record<string, unknown> }[]
    >`SELECT status, state FROM workflow_runs WHERE id = ${deadId}`;
    expect(deadRow?.status).toBe("failed");
    expect(deadRow?.state["failedReason"]).toContain("orch-dead");
  });

  it("reaps daemon-owned 'running' rows whose daemon heartbeat is missing", async () => {
    await setDaemonAlive("daemon-alive");
    const liveId = await insertWorkflowRow({ number: 1003 }, "daemon", "daemon-alive", "running");
    const deadId = await insertWorkflowRow({ number: 1004 }, "daemon", "daemon-dead", "running");

    const { reapOnce } = await import("../../src/orchestrator/liveness-reaper");
    const result = await reapOnce(requireSql());

    expect(result.workflowRunsReaped.map((r) => r.id)).toEqual([deadId]);

    const [aliveRow] = await requireSql()<
      { status: string }[]
    >`SELECT status FROM workflow_runs WHERE id = ${liveId}`;
    expect(aliveRow?.status).toBe("running");
  });

  it("ignores rows in terminal status and rows with NULL owner_kind", async () => {
    // No live heartbeats at all → would reap everything reapable.
    await insertWorkflowRow({ number: 1005 }, "orchestrator", "orch-x", "succeeded");
    const legacyRows: { id: string }[] = await requireSql()`
      INSERT INTO workflow_runs (
        workflow_name, target_type, target_owner, target_repo, target_number,
        status, state
      ) VALUES (
        'triage', 'issue', 'acme', 'repo', 1006,
        'queued', '{}'::jsonb
      )
      RETURNING id
    `;
    const legacyId = legacyRows[0]?.id;

    const { reapOnce } = await import("../../src/orchestrator/liveness-reaper");
    const result = await reapOnce(requireSql());

    expect(result.workflowRunsReaped).toHaveLength(0);

    const [legacyRow] = await requireSql()<
      { status: string }[]
    >`SELECT status FROM workflow_runs WHERE id = ${legacyId ?? ""}`;
    expect(legacyRow?.status).toBe("queued");
  });

  it("flips daemons-table rows whose Valkey heartbeat is missing", async () => {
    await setDaemonAlive("daemon-alive-2");
    await requireSql()`
      INSERT INTO daemons (id, hostname, platform, os_version, capabilities, resources, status, first_seen_at, last_seen_at)
      VALUES
        ('daemon-alive-2', 'h', 'linux', '6', '{}'::jsonb, '{}'::jsonb, 'active', now(), now()),
        ('daemon-dead-2', 'h', 'linux', '6', '{}'::jsonb, '{}'::jsonb, 'active', now(), now())
    `;

    const { reapOnce } = await import("../../src/orchestrator/liveness-reaper");
    const result = await reapOnce(requireSql());

    expect(result.daemonsMarkedInactive).toBe(1);

    const rows: { id: string; status: string }[] =
      await requireSql()`SELECT id, status FROM daemons ORDER BY id`;
    expect(rows).toEqual([
      { id: "daemon-alive-2", status: "active" },
      { id: "daemon-dead-2", status: "inactive" },
    ]);
  });

  it("with zero live owners: reaps every in-flight row of that kind", async () => {
    const a = await insertWorkflowRow({ number: 1007 }, "orchestrator", "orch-1");
    const b = await insertWorkflowRow({ number: 1008 }, "orchestrator", "orch-2");

    const { reapOnce } = await import("../../src/orchestrator/liveness-reaper");
    const result = await reapOnce(requireSql());

    const reapedIds = result.workflowRunsReaped.map((r) => r.id).sort();
    expect(reapedIds).toEqual([a, b].sort());
  });
});
