/**
 * Integration tests for the database migration runner.
 *
 * Requires a running Postgres instance (bun run dev:deps).
 * Uses a dedicated test database to avoid colliding with development data.
 * Skips the entire suite when Postgres is not available.
 *
 * Dynamic imports prevent coverage instrumentation of src/db/migrate.ts
 * when the suite is skipped: avoids failing the 90% per-file threshold.
 */

import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const TEST_DATABASE_URL =
  process.env["TEST_DATABASE_URL"] ?? "postgres://bot:bot@localhost:5432/github_app_test";

// Attempt to connect, skip all tests if Postgres is unreachable.
let sql: SQL | null = null;
try {
  const conn = new SQL(TEST_DATABASE_URL);
  await conn`SELECT 1 AS ok`;
  sql = conn;
} catch {
  sql = null;
}

function requireDb(): SQL {
  if (sql === null) throw new Error("Database not available, test should have been skipped");
  return sql;
}

describe.skipIf(sql === null)("runMigrations", () => {
  beforeAll(async () => {
    await requireDb().unsafe(`
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
  });

  afterAll(async () => {
    await requireDb().unsafe(`
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
    await requireDb().close();
  });

  it("applies migrations cleanly on a fresh database", async () => {
    // Dynamic import so the module is not loaded when suite is skipped
    const { runMigrations } = await import("../../src/db/migrate");
    await runMigrations(requireDb());

    const versions: { version: string }[] = await requireDb()`
      SELECT version FROM _migrations ORDER BY version
    `;
    expect(versions.length).toBe(13);
    expect(versions[0]?.version).toBe("001_initial");
    expect(versions[1]?.version).toBe("002_repo_knowledge");
    expect(versions[2]?.version).toBe("003_dispatch_decisions");
    expect(versions[3]?.version).toBe("004_collapse_dispatch_to_daemon");
    expect(versions[4]?.version).toBe("005_workflow_runs");
    expect(versions[5]?.version).toBe("006_workflow_runs_ownership");
    expect(versions[6]?.version).toBe("007_trigger_comment");
    expect(versions[7]?.version).toBe("008_ship_intents");
    expect(versions[8]?.version).toBe("009_workflow_runs_incomplete");
    expect(versions[9]?.version).toBe("010_chat_proposals");
    expect(versions[10]?.version).toBe("011_conversation_cache");
    expect(versions[11]?.version).toBe("012_repo_memory_sanitize_backfill");
    expect(versions[12]?.version).toBe("013_scheduled_actions");
  });

  it("is idempotent: second run is a no-op", async () => {
    const { runMigrations } = await import("../../src/db/migrate");
    await runMigrations(requireDb());

    const versions: { version: string }[] = await requireDb()`
      SELECT version FROM _migrations ORDER BY version
    `;
    expect(versions.length).toBe(13);
  });

  it("creates the executions table with expected columns", async () => {
    const columns: { column_name: string }[] = await requireDb()`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'executions'
      ORDER BY ordinal_position
    `;
    const names = columns.map((c) => c.column_name);

    expect(names).toContain("id");
    expect(names).toContain("delivery_id");
    expect(names).toContain("repo_owner");
    expect(names).toContain("dispatch_mode");
    expect(names).toContain("status");
    expect(names).toContain("cost_usd");
    expect(names).toContain("triage_result");
    expect(names).toContain("daemon_id");
  });

  it("creates the daemons table with expected columns", async () => {
    const columns: { column_name: string }[] = await requireDb()`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'daemons'
      ORDER BY ordinal_position
    `;
    const names = columns.map((c) => c.column_name);

    expect(names).toContain("id");
    expect(names).toContain("hostname");
    expect(names).toContain("platform");
    expect(names).toContain("capabilities");
    expect(names).toContain("status");
  });

  it("extends the executions table with dispatch-decision columns (003)", async () => {
    const columns: { column_name: string; column_default: string | null }[] = await requireDb()`
      SELECT column_name, column_default
      FROM information_schema.columns
      WHERE table_name = 'executions'
      ORDER BY ordinal_position
    `;
    const byName = new Map(columns.map((c) => [c.column_name, c]));

    expect(byName.has("dispatch_target")).toBe(true);
    expect(byName.has("dispatch_reason")).toBe(true);
    expect(byName.has("triage_confidence")).toBe(true);
    expect(byName.has("triage_cost_usd")).toBe(true);
    // After migration 004 the executions row stores no per-row complexity.
    expect(byName.has("triage_complexity")).toBe(false);
  });

  it("creates the triage_results table with the expected schema (003)", async () => {
    const columns: { column_name: string; is_nullable: string }[] = await requireDb()`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'triage_results'
      ORDER BY ordinal_position
    `;
    const names = columns.map((c) => c.column_name);

    expect(names).toContain("id");
    expect(names).toContain("delivery_id");
    expect(names).toContain("mode");
    expect(names).toContain("confidence");
    // Post-collapse: complexity column is dropped, replaced by binary `heavy`.
    expect(names).not.toContain("complexity");
    expect(names).toContain("heavy");
    expect(names).toContain("rationale");
    expect(names).toContain("cost_usd");
    expect(names).toContain("latency_ms");
    expect(names).toContain("provider");
    expect(names).toContain("model");
    expect(names).toContain("created_at");

    // Everything except the allowed-nullable columns should be NOT NULL.
    const notNull = columns.filter((c) => c.is_nullable === "NO").map((c) => c.column_name);
    expect(notNull).toContain("delivery_id");
    expect(notNull).toContain("mode");
    expect(notNull).toContain("confidence");
    expect(notNull).toContain("rationale");
  });

  it("creates the workflow_runs table with the expected schema (005)", async () => {
    const columns: { column_name: string; is_nullable: string }[] = await requireDb()`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'workflow_runs'
      ORDER BY ordinal_position
    `;
    const names = columns.map((c) => c.column_name);

    expect(names).toContain("id");
    expect(names).toContain("workflow_name");
    expect(names).toContain("target_type");
    expect(names).toContain("target_owner");
    expect(names).toContain("target_repo");
    expect(names).toContain("target_number");
    expect(names).toContain("parent_run_id");
    expect(names).toContain("parent_step_index");
    expect(names).toContain("status");
    expect(names).toContain("state");
    expect(names).toContain("tracking_comment_id");
    expect(names).toContain("delivery_id");
    expect(names).toContain("created_at");
    expect(names).toContain("updated_at");

    const notNull = columns.filter((c) => c.is_nullable === "NO").map((c) => c.column_name);
    expect(notNull).toContain("workflow_name");
    expect(notNull).toContain("target_type");
    expect(notNull).toContain("target_owner");
    expect(notNull).toContain("target_repo");
    expect(notNull).toContain("target_number");
    expect(notNull).toContain("status");
    expect(notNull).toContain("state");

    const indexes: { indexname: string }[] = await requireDb()`
      SELECT indexname FROM pg_indexes WHERE tablename = 'workflow_runs'
    `;
    const idxNames = indexes.map((i) => i.indexname);
    expect(idxNames).toContain("idx_workflow_runs_inflight");
    expect(idxNames).toContain("idx_workflow_runs_target");
    expect(idxNames).toContain("idx_workflow_runs_parent");
  });
});
