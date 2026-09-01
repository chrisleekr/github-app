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
  process.env["TEST_DATABASE_URL"] ?? "postgres://bot:bot@localhost:55432/github_app_test";

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
      DROP TABLE IF EXISTS workflow_attempt_commands CASCADE;
      DROP TABLE IF EXISTS review_learnings CASCADE;
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
      DROP TABLE IF EXISTS workflow_attempt_commands CASCADE;
      DROP TABLE IF EXISTS review_learnings CASCADE;
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
    expect(versions.length).toBe(17);
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
    expect(versions[13]?.version).toBe("014_review_learnings");
    expect(versions[14]?.version).toBe("015_review_learnings_embedding");
    expect(versions[15]?.version).toBe("016_executions_tokens");
    expect(versions[16]?.version).toMatch(/^017_/);
  });

  it("is idempotent: second run is a no-op", async () => {
    const { runMigrations } = await import("../../src/db/migrate");
    await runMigrations(requireDb());

    const versions: { version: string }[] = await requireDb()`
      SELECT version FROM _migrations ORDER BY version
    `;
    expect(versions.length).toBe(17);
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
    // Migration 016 token columns (issue #192).
    expect(names).toContain("input_tokens");
    expect(names).toContain("output_tokens");
    expect(names).toContain("cache_read_input_tokens");
    expect(names).toContain("cache_creation_input_tokens");
    expect(names).toContain("model_usage");
    expect(names).toContain("offer_id");
    expect(names).toContain("result_processed_at");
    expect(names).toContain("workflow_result_payload");

    const indexes: { indexname: string; indexdef: string }[] = await requireDb()`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'executions'
    `;
    const offerIndex = indexes.find((index) => index.indexname === "idx_executions_offer_id");
    expect(offerIndex?.indexdef).toContain("UNIQUE");
    expect(offerIndex?.indexdef).toContain("offer_id IS NOT NULL");
    const runningDaemonIndex = indexes.find(
      (index) => index.indexname === "idx_executions_running_daemon",
    );
    expect(runningDaemonIndex?.indexdef).toContain("daemon_id");
    expect(runningDaemonIndex?.indexdef).toContain("status = 'running'");
    const resultPendingIndex = indexes.find(
      (index) => index.indexname === "idx_executions_workflow_result_pending",
    );
    expect(resultPendingIndex?.indexdef).toContain("workflow_result_payload IS NOT NULL");
    expect(resultPendingIndex?.indexdef).toContain("result_processed_at IS NULL");
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
    expect(names).toContain("attempt_id");
    expect(names).toContain("lease_expires_at");
    expect(names).toContain("attempt_deadline_at");
    expect(names).toContain("attempt_completed_at");
    expect(names).toContain("cascade_completed_at");
    expect(names).toContain("execution_delivery_id");
    expect(names).toContain("trigger_body_preview");
    expect(names).toContain("dispatch_enqueued_at");
    expect(names).toContain("dispatch_generation_id");
    expect(names).toContain("runner_payload_issued_at");
    expect(names).toContain("runner_token_expires_at");
    expect(names).toContain("runner_resources_cleaned_at");
    expect(names).toContain("failure_notified_at");
    expect(names).toContain("dispatch_retry_count");

    const notNull = columns.filter((c) => c.is_nullable === "NO").map((c) => c.column_name);
    expect(notNull).toContain("workflow_name");
    expect(notNull).toContain("target_type");
    expect(notNull).toContain("target_owner");
    expect(notNull).toContain("target_repo");
    expect(notNull).toContain("target_number");
    expect(notNull).toContain("status");
    expect(notNull).toContain("state");
    expect(notNull).toContain("trigger_body_preview");
    expect(notNull).toContain("dispatch_generation_id");
    expect(notNull).toContain("dispatch_retry_count");

    const [payloadReceiptConstraint] = await requireDb()<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conname = 'workflow_runs_runner_payload_receipt_check'
    `;
    expect(payloadReceiptConstraint?.definition).toContain("runner_payload_issued_at IS NULL");
    expect(payloadReceiptConstraint?.definition).toContain(
      "runner_token_expires_at <= attempt_deadline_at",
    );

    const indexes: { indexname: string; indexdef: string }[] = await requireDb()`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'workflow_runs'
    `;
    const idxNames = indexes.map((i) => i.indexname);
    expect(idxNames).toContain("idx_workflow_runs_inflight");
    expect(idxNames).toContain("idx_workflow_runs_target");
    expect(idxNames).toContain("idx_workflow_runs_parent");
    const leaseIndex = indexes.find((index) => index.indexdef.includes("lease_expires_at"));
    expect(leaseIndex?.indexdef).toContain("attempt_deadline_at");
    expect(leaseIndex?.indexdef).toContain("status");
    expect(leaseIndex?.indexdef).toContain("running");
    const attemptIndex = indexes.find(
      (index) => index.indexname === "idx_workflow_runs_attempt_id",
    );
    expect(attemptIndex?.indexdef).toContain("UNIQUE");
    expect(attemptIndex?.indexdef).toContain("attempt_id IS NOT NULL");
    const dispatchIndex = indexes.find(
      (index) => index.indexname === "idx_workflow_runs_dispatch_pending",
    );
    expect(dispatchIndex?.indexdef).toContain("execution_delivery_id IS NOT NULL");
    expect(dispatchIndex?.indexdef).toContain("dispatch_enqueued_at");
    expect(dispatchIndex?.indexdef).not.toContain("dispatch_enqueued_at IS NULL");
    const cleanupIndex = indexes.find(
      (index) => index.indexname === "idx_workflow_runs_runner_cleanup_pending",
    );
    expect(cleanupIndex?.indexdef).toContain("attempt_completed_at IS NOT NULL");
    expect(cleanupIndex?.indexdef).toContain("runner_resources_cleaned_at IS NULL");
    const notificationIndex = indexes.find(
      (index) => index.indexname === "idx_workflow_runs_failure_notification_pending",
    );
    expect(notificationIndex?.indexdef).toContain("status = 'failed'");
    expect(notificationIndex?.indexdef).toContain("attempt_completed_at IS NOT NULL");
    expect(notificationIndex?.indexdef).toContain("failure_notified_at IS NULL");
    expect(notificationIndex?.indexdef).not.toContain("attempt_id IS NOT NULL");

    const repoIndexes: { indexname: string; indexdef: string }[] = await requireDb()`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'repo_memory'
    `;
    const learningIndex = repoIndexes.find(
      (index) => index.indexname === "idx_repo_memory_learning_unique",
    );
    expect(learningIndex?.indexdef).toContain("UNIQUE");
    expect(learningIndex?.indexdef).toContain("content_sha256");
    expect(learningIndex?.indexdef).toContain("category <> 'env_var'");

    const repoColumns: { column_name: string }[] = await requireDb()`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_name = 'repo_memory'
    `;
    expect(repoColumns.map((column) => column.column_name)).toContain("content_sha256");
    const [hashTrigger] = await requireDb()<{ trigger_name: string }[]>`
      SELECT trigger_name
        FROM information_schema.triggers
       WHERE event_object_table = 'repo_memory'
         AND trigger_name = 'repo_memory_content_sha256'
    `;
    expect(hashTrigger?.trigger_name).toBe("repo_memory_content_sha256");
  });

  it("creates the workflow attempt command receipt table", async () => {
    const columns: { column_name: string; is_nullable: string }[] = await requireDb()`
      SELECT column_name, is_nullable
        FROM information_schema.columns
       WHERE table_name = 'workflow_attempt_commands'
       ORDER BY ordinal_position
    `;
    expect(columns.map((column) => column.column_name)).toEqual([
      "attempt_id",
      "command_id",
      "run_id",
      "command_kind",
      "request",
      "response",
      "created_at",
    ]);
    expect(columns.every((column) => column.is_nullable === "NO")).toBe(true);

    const constraints: { constraint_type: string; definition: string }[] = await requireDb()`
      SELECT CASE contype
               WHEN 'p' THEN 'PRIMARY KEY'
               WHEN 'f' THEN 'FOREIGN KEY'
               WHEN 'c' THEN 'CHECK'
               ELSE contype::text
             END AS constraint_type,
             pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = 'workflow_attempt_commands'::regclass
    `;
    expect(constraints).toContainEqual({
      constraint_type: "PRIMARY KEY",
      definition: "PRIMARY KEY (attempt_id, command_id)",
    });
    expect(constraints).toContainEqual({
      constraint_type: "FOREIGN KEY",
      definition: "FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE",
    });
  });

  it("backfills queued work and fails active shared-daemon workflow attempts", async () => {
    await requireDb().unsafe(`
      TRUNCATE workflow_runs, executions CASCADE;
      DELETE FROM repo_memory;
      DELETE FROM _migrations WHERE version = '017_workflow_run_leases';
      DROP TABLE IF EXISTS workflow_attempt_commands CASCADE;
      DROP INDEX idx_executions_running_daemon;
      DROP INDEX idx_repo_memory_learning_unique;
      DROP TRIGGER repo_memory_content_sha256 ON repo_memory;
      ALTER TABLE repo_memory
        DROP CONSTRAINT repo_memory_learning_hash_check,
        DROP COLUMN content_sha256;
      ALTER TABLE workflow_runs
        DROP COLUMN attempt_id,
        DROP COLUMN lease_expires_at,
        DROP COLUMN attempt_deadline_at,
        DROP COLUMN attempt_completed_at,
        DROP COLUMN cascade_completed_at,
        DROP COLUMN execution_delivery_id,
        DROP COLUMN trigger_body_preview,
        DROP COLUMN dispatch_enqueued_at,
        DROP COLUMN dispatch_generation_id,
        DROP COLUMN runner_payload_issued_at,
        DROP COLUMN runner_token_expires_at,
        DROP COLUMN runner_resources_cleaned_at,
        DROP COLUMN failure_notified_at,
        DROP COLUMN dispatch_retry_count;
      ALTER TABLE executions
        DROP COLUMN offer_id,
        DROP COLUMN result_processed_at,
        DROP COLUMN workflow_result_payload;
    `);

    const [parent] = await requireDb()<{ id: string }[]>`INSERT INTO workflow_runs (
        workflow_name, target_type, target_owner, target_repo, target_number,
        status, state, owner_kind, owner_id
      ) VALUES (
        'ship', 'pr', 'acme', 'widgets', 700,
        'running', '{}'::jsonb, 'daemon', 'old-daemon'
      ) RETURNING id`;
    if (parent === undefined) throw new Error("migration parent seed failed");

    const [missingChildParent] = await requireDb()<{ id: string }[]>`INSERT INTO workflow_runs (
        workflow_name, target_type, target_owner, target_repo, target_number,
        status, state, owner_kind, owner_id
      ) VALUES (
        'ship', 'pr', 'acme', 'widgets', 708,
        'running', '{}'::jsonb, 'daemon', 'old-daemon'
      ) RETURNING id`;
    const [activeChildParent] = await requireDb()<{ id: string }[]>`INSERT INTO workflow_runs (
        workflow_name, target_type, target_owner, target_repo, target_number,
        status, state, owner_kind, owner_id
      ) VALUES (
        'ship', 'pr', 'acme', 'widgets', 710,
        'running', '{}'::jsonb, 'daemon', 'old-daemon'
      ) RETURNING id`;
    const [overlapParent] = await requireDb()<{ id: string }[]>`INSERT INTO workflow_runs (
        workflow_name, target_type, target_owner, target_repo, target_number,
        status, state, delivery_id, owner_kind, owner_id
      ) VALUES (
        'ship', 'pr', 'acme', 'widgets', 712,
        'running', '{}'::jsonb, 'overlap-parent-execution', 'daemon', 'old-daemon'
      ) RETURNING id`;
    if (
      missingChildParent === undefined ||
      activeChildParent === undefined ||
      overlapParent === undefined
    ) {
      throw new Error("migration failure-propagation parent seed failed");
    }

    const rows: { id: string; target_number: number; updated_at: Date }[] = await requireDb()`
      INSERT INTO workflow_runs (
        workflow_name, target_type, target_owner, target_repo, target_number,
        parent_run_id, parent_step_index, status, state, delivery_id,
        owner_kind, owner_id
      ) VALUES
        ('review', 'pr', 'acme', 'widgets', 701,
         NULL, NULL, 'queued', '{}'::jsonb, 'top-level-delivery',
         'orchestrator', 'old-orchestrator'),
        ('review', 'pr', 'acme', 'widgets', 702,
         ${parent.id}, 0, 'queued', '{}'::jsonb, 'parent-trace-delivery',
         NULL, NULL),
        ('resolve', 'pr', 'acme', 'widgets', 703,
         NULL, NULL, 'queued', ${{ shipIntentId: "intent-1", iteration_n: 4 }}::jsonb, NULL,
         'orchestrator', 'old-orchestrator'),
        ('triage', 'issue', 'acme', 'widgets', 704,
         NULL, NULL, 'failed', '{}'::jsonb, 'terminal-delivery',
         NULL, NULL),
        ('triage', 'issue', 'acme', 'widgets', 706,
         NULL, NULL, 'queued', '{}'::jsonb, 'missing-execution',
         NULL, NULL),
        ('triage', 'issue', 'acme', 'widgets', 705,
         NULL, NULL, 'running', '{}'::jsonb, 'pre-017-offer',
         'daemon', 'old-daemon'),
        ('triage', 'issue', 'acme', 'widgets', 707,
         NULL, NULL, 'running', '{}'::jsonb, 'pre-017-running',
         'daemon', 'old-daemon'),
        ('review', 'pr', 'acme', 'widgets', 709,
         ${missingChildParent.id}, 2, 'queued', '{}'::jsonb, 'missing-child-execution',
         NULL, NULL),
        ('review', 'pr', 'acme', 'widgets', 711,
         ${activeChildParent.id}, 3, 'running', '{}'::jsonb, 'active-child-execution',
         'daemon', 'old-daemon'),
        ('review', 'pr', 'acme', 'widgets', 713,
         ${overlapParent.id}, 4, 'running', '{}'::jsonb, 'overlap-child-execution',
         'daemon', 'old-daemon')
      RETURNING id, target_number, updated_at
    `;
    const reconstructableChild = rows.find((row) => row.target_number === 702);
    const activeChild = rows.find((row) => row.target_number === 711);
    const overlapChild = rows.find((row) => row.target_number === 713);
    if (
      reconstructableChild === undefined ||
      activeChild === undefined ||
      overlapChild === undefined
    ) {
      throw new Error("migration child seed failed");
    }
    await requireDb()`
      INSERT INTO executions (
        delivery_id, repo_owner, repo_name, entity_number, entity_type,
        event_name, trigger_username, dispatch_mode, dispatch_target,
        dispatch_reason, status, daemon_id
      ) VALUES
        ('pre-017-offer', 'acme', 'widgets', 705, 'issue',
         'issue_comment', 'user', 'daemon', 'daemon',
         'persistent-daemon', 'offered', 'old-daemon'),
        ('pre-017-running', 'acme', 'widgets', 707, 'issue',
         'issue_comment', 'user', 'daemon', 'daemon',
         'persistent-daemon', 'running', 'old-daemon'),
        ('top-level-delivery', 'acme', 'widgets', 701, 'pr',
         'pull_request', 'user', 'daemon', 'daemon',
         'persistent-daemon', 'queued', NULL),
        (${reconstructableChild.id}, 'acme', 'widgets', 702, 'pr',
         'pull_request', 'user', 'daemon', 'daemon',
         'persistent-daemon', 'queued', NULL),
        ('intent-1::iteration::4', 'acme', 'widgets', 703, 'pr',
         'pull_request', 'user', 'daemon', 'daemon',
         'persistent-daemon', 'queued', NULL),
        (${activeChild.id}, 'acme', 'widgets', 711, 'pr',
         'pull_request', 'user', 'daemon', 'daemon',
         'persistent-daemon', 'running', 'old-daemon'),
        ('overlap-parent-execution', 'acme', 'widgets', 712, 'pr',
         'pull_request', 'user', 'daemon', 'daemon',
         'persistent-daemon', 'running', 'old-daemon'),
        (${overlapChild.id}, 'acme', 'widgets', 713, 'pr',
         'pull_request', 'user', 'daemon', 'daemon',
         'persistent-daemon', 'running', 'old-daemon')
    `;
    await requireDb()`
      INSERT INTO scheduled_action_state (
        installation_id, owner, repo, action_name, in_flight_job_id, in_flight_started_at
      ) VALUES
        (1, 'acme', 'widgets', 'pre-017-offer', 'pre-017-offer', now()),
        (1, 'acme', 'widgets', 'pre-017-running', 'pre-017-running', now())
    `;
    await requireDb()`
      INSERT INTO repo_memory (repo_owner, repo_name, category, content)
      VALUES
        ('acme', 'widgets', 'gotchas', 'A'),
        ('acme', 'widgets', 'gotchas', ${String.raw`\x41`}),
        ('acme', 'widgets', 'gotchas', ${String.raw`C:\Users\bin`})
    `;

    const { runMigrations } = await import("../../src/db/migrate");
    await runMigrations(requireDb());

    const learningHashes = await requireDb()<{ content: string; content_hash: string }[]>`
      SELECT content, encode(content_sha256, 'hex') AS content_hash
        FROM repo_memory
       WHERE repo_owner = 'acme' AND repo_name = 'widgets'
    `;
    expect(learningHashes.map((row) => row.content).sort()).toEqual(
      ["A", String.raw`\x41`, String.raw`C:\Users\bin`].sort(),
    );
    expect(new Set(learningHashes.map((row) => row.content_hash)).size).toBe(3);

    const migrated: {
      id: string;
      status: string;
      execution_delivery_id: string | null;
      trigger_body_preview: string;
      dispatch_enqueued_at: Date | null;
      state: Record<string, unknown>;
      updated_at: Date;
    }[] = await requireDb()`
      SELECT id, status, state, execution_delivery_id, trigger_body_preview,
             dispatch_enqueued_at, updated_at
        FROM workflow_runs
       WHERE target_number IN (701, 702, 703, 704, 706)
       ORDER BY target_number
    `;
    expect(migrated.map((row) => row.execution_delivery_id)).toEqual([
      "top-level-delivery",
      reconstructableChild.id,
      "intent-1::iteration::4",
      "terminal-delivery",
      "missing-execution",
    ]);
    expect(migrated.slice(0, 3).map((row) => row.dispatch_enqueued_at)).toEqual([null, null, null]);
    expect(migrated[3]?.dispatch_enqueued_at?.getTime()).toBe(migrated[3]?.updated_at.getTime());
    expect(migrated[4]?.dispatch_enqueued_at).toBeInstanceOf(Date);
    expect(migrated.map((row) => row.status)).toEqual([
      "queued",
      "queued",
      "queued",
      "failed",
      "failed",
    ]);
    expect(migrated.map((row) => row.trigger_body_preview)).toEqual(["", "", "", "", ""]);
    expect(migrated[4]?.state["failedReason"]).toBe(
      "workflow dispatch incomplete during lease migration",
    );
    expect(migrated[4]?.state["phase"]).toBe("migration-interrupted");

    const [pending] = await requireDb()<{ count: number }[]>`
      SELECT count(*)::int AS count
        FROM workflow_runs
       WHERE status = 'queued'
         AND execution_delivery_id IS NOT NULL
         AND dispatch_enqueued_at IS NULL
    `;
    expect(pending?.count).toBe(3);

    const dispatchTelemetry = await requireDb()<
      {
        delivery_id: string;
        dispatch_mode: string;
        dispatch_target: string;
        dispatch_reason: string;
      }[]
    >`
      SELECT delivery_id, dispatch_mode, dispatch_target, dispatch_reason
        FROM executions
       WHERE delivery_id IN (
         'pre-017-offer', 'pre-017-running', 'top-level-delivery',
         ${reconstructableChild.id}, 'intent-1::iteration::4'
       )
       ORDER BY delivery_id
    `;
    expect(
      dispatchTelemetry
        .filter((row) => row.delivery_id.startsWith("pre-017-"))
        .map((row) => [row.dispatch_mode, row.dispatch_target, row.dispatch_reason]),
    ).toEqual([
      ["daemon", "daemon", "persistent-daemon"],
      ["daemon", "daemon", "persistent-daemon"],
    ]);
    expect(
      dispatchTelemetry
        .filter((row) => !row.delivery_id.startsWith("pre-017-"))
        .map((row) => [row.dispatch_mode, row.dispatch_target, row.dispatch_reason]),
    ).toEqual([
      ["workflow-runner", "workflow-runner", "workflow-runner"],
      ["workflow-runner", "workflow-runner", "workflow-runner"],
      ["workflow-runner", "workflow-runner", "workflow-runner"],
    ]);

    const activeWorkflowRows = await requireDb()<
      { target_number: number; status: string; state: Record<string, unknown> }[]
    >`
      SELECT target_number, status, state
        FROM workflow_runs
       WHERE target_number IN (705, 707)
       ORDER BY target_number
    `;
    expect(activeWorkflowRows.map((row) => row.status)).toEqual(["failed", "failed"]);
    expect(activeWorkflowRows[0]?.state["failedReason"]).toBe(
      "workflow execution interrupted during isolated-runner migration",
    );
    expect(activeWorkflowRows.map((row) => row.state["phase"])).toEqual([
      "migration-interrupted",
      "migration-interrupted",
    ]);
    const [preservedParent] = await requireDb()<
      { status: string; owner_kind: string | null; owner_id: string | null }[]
    >`
      SELECT status, owner_kind, owner_id FROM workflow_runs WHERE id = ${parent.id}
    `;
    expect(preservedParent?.status).toBe("running");
    expect(preservedParent?.owner_kind).toBeNull();
    expect(preservedParent?.owner_id).toBeNull();

    const propagatedFailures = await requireDb()<
      { target_number: number; status: string; state: Record<string, unknown> }[]
    >`
      SELECT target_number, status, state
        FROM workflow_runs
       WHERE target_number IN (708, 709, 710, 711)
       ORDER BY target_number
    `;
    expect(propagatedFailures.map((row) => row.status)).toEqual([
      "failed",
      "failed",
      "failed",
      "failed",
    ]);
    expect(propagatedFailures[0]?.state).toMatchObject({
      failedAtStepIndex: 2,
      failedReason: "workflow dispatch incomplete during lease migration",
    });
    expect(propagatedFailures[1]?.state["failedReason"]).toBe(
      "workflow dispatch incomplete during lease migration",
    );
    expect(propagatedFailures[2]?.state).toMatchObject({
      failedAtStepIndex: 3,
      failedReason: "workflow execution interrupted during isolated-runner migration",
    });
    expect(propagatedFailures[3]?.state["failedReason"]).toBe(
      "workflow execution interrupted during isolated-runner migration",
    );
    const { findPendingWorkflowFailureNotifications } =
      await import("../../src/workflows/runs-store");
    const migrationNotifications = await findPendingWorkflowFailureNotifications(requireDb());
    expect(
      migrationNotifications
        .filter((entry) => entry.phase === "migration-interrupted")
        .map((entry) => entry.row.target_number)
        .sort((left, right) => left - right),
    ).toEqual([705, 706, 707, 709, 711, 712, 713]);

    const overlappingWorkflowRows = await requireDb()<
      {
        target_number: number;
        status: string;
        state: Record<string, unknown>;
        attempt_completed_at: Date | null;
      }[]
    >`
      SELECT target_number, status, state, attempt_completed_at
        FROM workflow_runs
       WHERE target_number IN (712, 713)
       ORDER BY target_number
    `;
    expect(overlappingWorkflowRows).toEqual([
      {
        target_number: 712,
        status: "failed",
        state: {
          phase: "migration-interrupted",
          failedReason: "workflow execution interrupted during isolated-runner migration",
        },
        attempt_completed_at: expect.any(Date),
      },
      {
        target_number: 713,
        status: "failed",
        state: {
          phase: "migration-interrupted",
          failedReason: "workflow execution interrupted during isolated-runner migration",
        },
        attempt_completed_at: expect.any(Date),
      },
    ]);
    const overlappingExecutions = await requireDb()<
      {
        delivery_id: string;
        entity_number: number;
        status: string;
        result_processed_at: Date | null;
      }[]
    >`
      SELECT delivery_id, entity_number, status, result_processed_at
        FROM executions
       WHERE entity_number IN (712, 713)
       ORDER BY entity_number
    `;
    expect(overlappingExecutions).toEqual([
      {
        delivery_id: "overlap-parent-execution",
        entity_number: 712,
        status: "failed",
        result_processed_at: expect.any(Date),
      },
      {
        delivery_id: overlapChild.id,
        entity_number: 713,
        status: "failed",
        result_processed_at: expect.any(Date),
      },
    ]);

    const interrupted = await requireDb()<
      {
        delivery_id: string;
        status: string;
        error_message: string | null;
        result_processed_at: Date | null;
      }[]
    >`
      SELECT delivery_id, status, error_message, result_processed_at
        FROM executions
       WHERE delivery_id IN ('pre-017-offer', 'pre-017-running')
       ORDER BY delivery_id
    `;
    expect(interrupted).toEqual([
      {
        delivery_id: "pre-017-offer",
        status: "failed",
        error_message: "workflow execution interrupted during isolated-runner migration",
        result_processed_at: expect.any(Date),
      },
      {
        delivery_id: "pre-017-running",
        status: "failed",
        error_message: "workflow execution interrupted during isolated-runner migration",
        result_processed_at: expect.any(Date),
      },
    ]);
    const locks = await requireDb()<{ action_name: string; in_flight_job_id: string | null }[]>`
      SELECT action_name, in_flight_job_id
        FROM scheduled_action_state
       WHERE action_name IN ('pre-017-offer', 'pre-017-running')
       ORDER BY action_name
    `;
    expect(locks).toEqual([
      { action_name: "pre-017-offer", in_flight_job_id: null },
      { action_name: "pre-017-running", in_flight_job_id: null },
    ]);
  });
});
