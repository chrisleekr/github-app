/**
 * Detailed integration tests for migration 008_ship_intents.
 *
 * Requires a running Postgres (`bun run dev:deps`). Skips when the test
 * database is unreachable. Asserts each assertion-class from data-model.md:
 *   (a) all four tables exist with expected columns
 *   (b) the partial unique index rejects a second active intent for the same PR
 *   (c) every CHECK constraint rejects out-of-enumeration values
 *   (d) cascade delete on ship_intents removes related rows
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

function requireDb(): SQL {
  if (sql === null) throw new Error("Database not available, test should have been skipped");
  return sql;
}

async function dropAll(): Promise<void> {
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
}

const intentDefaults = (): {
  installation_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  target_base_sha: string;
  target_head_sha: string;
  deadline_at: Date;
  created_by_user: string;
  tracking_comment_marker: string;
} => ({
  installation_id: 12345,
  owner: "chrisleekr",
  repo: "github-app-playground",
  pr_number: 999,
  target_base_sha: "a".repeat(40),
  target_head_sha: "b".repeat(40),
  deadline_at: new Date(Date.now() + 4 * 3_600_000),
  created_by_user: "alice",
  tracking_comment_marker: "<!-- ship-intent:test -->",
});

describe.skipIf(sql === null)("migration 008_ship_intents", () => {
  beforeAll(async () => {
    await dropAll();
    const { runMigrations } = await import("../../../src/db/migrate");
    await runMigrations(requireDb());
  });

  afterAll(async () => {
    await dropAll();
    await requireDb().close();
  });

  // ─── (a) tables exist with expected columns ───────────────────────────────

  it("creates ship_intents with every documented column", async () => {
    const cols: { column_name: string; is_nullable: string }[] = await requireDb()`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'ship_intents'
      ORDER BY ordinal_position
    `;
    const names = cols.map((c) => c.column_name);
    for (const required of [
      "id",
      "installation_id",
      "owner",
      "repo",
      "pr_number",
      "target_base_sha",
      "target_head_sha",
      "status",
      "deadline_at",
      "spent_usd",
      "created_by_user",
      "tracking_comment_id",
      "tracking_comment_marker",
      "terminal_blocker_category",
      "created_at",
      "updated_at",
      "terminated_at",
    ]) {
      expect(names).toContain(required);
    }
    const nullable = new Set(cols.filter((c) => c.is_nullable === "YES").map((c) => c.column_name));
    expect(nullable.has("tracking_comment_id")).toBe(true);
    expect(nullable.has("terminal_blocker_category")).toBe(true);
    expect(nullable.has("terminated_at")).toBe(true);
  });

  it("creates ship_iterations with every documented column", async () => {
    const cols: { column_name: string }[] = await requireDb()`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'ship_iterations'
      ORDER BY ordinal_position
    `;
    const names = cols.map((c) => c.column_name);
    for (const required of [
      "id",
      "intent_id",
      "iteration_n",
      "kind",
      "started_at",
      "finished_at",
      "verdict_json",
      "non_readiness_reason",
      "cost_usd",
      "runs_store_id",
    ]) {
      expect(names).toContain(required);
    }
  });

  it("creates ship_continuations with every documented column", async () => {
    const cols: { column_name: string }[] = await requireDb()`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'ship_continuations'
      ORDER BY ordinal_position
    `;
    const names = cols.map((c) => c.column_name);
    for (const required of [
      "intent_id",
      "wait_for",
      "wake_at",
      "state_blob",
      "state_version",
      "updated_at",
    ]) {
      expect(names).toContain(required);
    }
  });

  it("creates ship_fix_attempts with every documented column", async () => {
    const cols: { column_name: string }[] = await requireDb()`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'ship_fix_attempts'
      ORDER BY ordinal_position
    `;
    const names = cols.map((c) => c.column_name);
    for (const required of [
      "intent_id",
      "signature",
      "tier",
      "attempts",
      "first_seen_at",
      "last_seen_at",
    ]) {
      expect(names).toContain(required);
    }
  });

  // ─── (b) partial unique index rejects second active intent ────────────────

  it("partial unique index rejects a second active intent for the same PR", async () => {
    const d = intentDefaults();
    await requireDb()`
      INSERT INTO ship_intents (
        installation_id, owner, repo, pr_number,
        target_base_sha, target_head_sha,
        status, deadline_at, created_by_user, tracking_comment_marker
      ) VALUES (
        ${d.installation_id}, ${d.owner}, ${d.repo}, ${d.pr_number},
        ${d.target_base_sha}, ${d.target_head_sha},
        'active', ${d.deadline_at}, ${d.created_by_user}, ${d.tracking_comment_marker}
      )
    `;
    let threw = false;
    try {
      await requireDb()`
        INSERT INTO ship_intents (
          installation_id, owner, repo, pr_number,
          target_base_sha, target_head_sha,
          status, deadline_at, created_by_user, tracking_comment_marker
        ) VALUES (
          ${d.installation_id}, ${d.owner}, ${d.repo}, ${d.pr_number},
          ${d.target_base_sha}, ${d.target_head_sha},
          'active', ${d.deadline_at}, ${d.created_by_user}, ${d.tracking_comment_marker}
        )
      `;
    } catch (err) {
      threw = true;
      expect(String(err)).toMatch(/ship_intents_one_active_per_pr/);
    }
    expect(threw).toBe(true);
    await requireDb()`DELETE FROM ship_intents WHERE pr_number = ${d.pr_number}`;
  });

  it("partial unique index also covers paused intents (FR-007a)", async () => {
    const d = { ...intentDefaults(), pr_number: 998 };
    const inserted: { id: string }[] = await requireDb()`
      INSERT INTO ship_intents (
        installation_id, owner, repo, pr_number,
        target_base_sha, target_head_sha,
        status, deadline_at, created_by_user, tracking_comment_marker
      ) VALUES (
        ${d.installation_id}, ${d.owner}, ${d.repo}, ${d.pr_number},
        ${d.target_base_sha}, ${d.target_head_sha},
        'active', ${d.deadline_at}, ${d.created_by_user}, ${d.tracking_comment_marker}
      )
      RETURNING id
    `;
    const id = inserted[0]?.id;
    expect(id).toBeDefined();
    await requireDb()`UPDATE ship_intents SET status = 'paused' WHERE id = ${id ?? ""}`;
    let threw = false;
    try {
      await requireDb()`
        INSERT INTO ship_intents (
          installation_id, owner, repo, pr_number,
          target_base_sha, target_head_sha,
          status, deadline_at, created_by_user, tracking_comment_marker
        ) VALUES (
          ${d.installation_id}, ${d.owner}, ${d.repo}, ${d.pr_number},
          ${d.target_base_sha}, ${d.target_head_sha},
          'active', ${d.deadline_at}, ${d.created_by_user}, ${d.tracking_comment_marker}
        )
      `;
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    await requireDb()`DELETE FROM ship_intents WHERE pr_number = ${d.pr_number}`;
  });

  // ─── (c) CHECK constraints reject out-of-enum values ──────────────────────

  it("status CHECK rejects invalid enum values", async () => {
    const d = { ...intentDefaults(), pr_number: 997 };
    let threw = false;
    try {
      await requireDb()`
        INSERT INTO ship_intents (
          installation_id, owner, repo, pr_number,
          target_base_sha, target_head_sha,
          status, deadline_at, created_by_user, tracking_comment_marker
        ) VALUES (
          ${d.installation_id}, ${d.owner}, ${d.repo}, ${d.pr_number},
          ${d.target_base_sha}, ${d.target_head_sha},
          'bogus_status', ${d.deadline_at}, ${d.created_by_user}, ${d.tracking_comment_marker}
        )
      `;
    } catch (err) {
      threw = true;
      expect(String(err)).toMatch(/ship_intents_status_check/);
    }
    expect(threw).toBe(true);
  });

  it("blocker_category CHECK rejects invalid enum values", async () => {
    const d = { ...intentDefaults(), pr_number: 996 };
    let threw = false;
    try {
      await requireDb()`
        INSERT INTO ship_intents (
          installation_id, owner, repo, pr_number,
          target_base_sha, target_head_sha,
          status, deadline_at, terminated_at, terminal_blocker_category,
          created_by_user, tracking_comment_marker
        ) VALUES (
          ${d.installation_id}, ${d.owner}, ${d.repo}, ${d.pr_number},
          ${d.target_base_sha}, ${d.target_head_sha},
          'human_took_over', ${d.deadline_at}, now(), 'bogus_category',
          ${d.created_by_user}, ${d.tracking_comment_marker}
        )
      `;
    } catch (err) {
      threw = true;
      expect(String(err)).toMatch(/ship_intents_blocker_category_check/);
    }
    expect(threw).toBe(true);
  });

  it("non-terminal status iff terminated_at IS NULL CHECK fires", async () => {
    const d = { ...intentDefaults(), pr_number: 995 };
    let threw = false;
    try {
      // active row WITH terminated_at set → must reject
      await requireDb()`
        INSERT INTO ship_intents (
          installation_id, owner, repo, pr_number,
          target_base_sha, target_head_sha,
          status, deadline_at, terminated_at,
          created_by_user, tracking_comment_marker
        ) VALUES (
          ${d.installation_id}, ${d.owner}, ${d.repo}, ${d.pr_number},
          ${d.target_base_sha}, ${d.target_head_sha},
          'active', ${d.deadline_at}, now(),
          ${d.created_by_user}, ${d.tracking_comment_marker}
        )
      `;
    } catch (err) {
      threw = true;
      expect(String(err)).toMatch(/ship_intents_terminated_at_check/);
    }
    expect(threw).toBe(true);
  });

  it("ship_iterations.kind CHECK rejects invalid enum values", async () => {
    const d = { ...intentDefaults(), pr_number: 994 };
    const inserted: { id: string }[] = await requireDb()`
      INSERT INTO ship_intents (
        installation_id, owner, repo, pr_number,
        target_base_sha, target_head_sha,
        status, deadline_at, created_by_user, tracking_comment_marker
      ) VALUES (
        ${d.installation_id}, ${d.owner}, ${d.repo}, ${d.pr_number},
        ${d.target_base_sha}, ${d.target_head_sha},
        'active', ${d.deadline_at}, ${d.created_by_user}, ${d.tracking_comment_marker}
      )
      RETURNING id
    `;
    const intentId = inserted[0]?.id ?? "";
    let threw = false;
    try {
      await requireDb()`
        INSERT INTO ship_iterations (intent_id, iteration_n, kind)
        VALUES (${intentId}, 1, 'bogus_kind')
      `;
    } catch (err) {
      threw = true;
      expect(String(err)).toMatch(/ship_iterations_kind_check/);
    }
    expect(threw).toBe(true);
    await requireDb()`DELETE FROM ship_intents WHERE id = ${intentId}`;
  });

  it("ship_iterations CHECK forbids verdict_json on non-probe rows", async () => {
    const d = { ...intentDefaults(), pr_number: 993 };
    const inserted: { id: string }[] = await requireDb()`
      INSERT INTO ship_intents (
        installation_id, owner, repo, pr_number,
        target_base_sha, target_head_sha,
        status, deadline_at, created_by_user, tracking_comment_marker
      ) VALUES (
        ${d.installation_id}, ${d.owner}, ${d.repo}, ${d.pr_number},
        ${d.target_base_sha}, ${d.target_head_sha},
        'active', ${d.deadline_at}, ${d.created_by_user}, ${d.tracking_comment_marker}
      )
      RETURNING id
    `;
    const intentId = inserted[0]?.id ?? "";
    let threw = false;
    try {
      await requireDb()`
        INSERT INTO ship_iterations (intent_id, iteration_n, kind, verdict_json)
        VALUES (${intentId}, 1, 'resolve', ${{ ready: true }})
      `;
    } catch (err) {
      threw = true;
      expect(String(err)).toMatch(/ship_iterations_verdict_only_on_probe_check/);
    }
    expect(threw).toBe(true);
    await requireDb()`DELETE FROM ship_intents WHERE id = ${intentId}`;
  });

  it("ship_fix_attempts.tier CHECK accepts only 1 or 2", async () => {
    const d = { ...intentDefaults(), pr_number: 992 };
    const inserted: { id: string }[] = await requireDb()`
      INSERT INTO ship_intents (
        installation_id, owner, repo, pr_number,
        target_base_sha, target_head_sha,
        status, deadline_at, created_by_user, tracking_comment_marker
      ) VALUES (
        ${d.installation_id}, ${d.owner}, ${d.repo}, ${d.pr_number},
        ${d.target_base_sha}, ${d.target_head_sha},
        'active', ${d.deadline_at}, ${d.created_by_user}, ${d.tracking_comment_marker}
      )
      RETURNING id
    `;
    const intentId = inserted[0]?.id ?? "";
    let threw = false;
    try {
      await requireDb()`
        INSERT INTO ship_fix_attempts (intent_id, signature, tier, attempts)
        VALUES (${intentId}, 'sig-x', 3, 1)
      `;
    } catch (err) {
      threw = true;
      expect(String(err)).toMatch(/ship_fix_attempts_tier_check/);
    }
    expect(threw).toBe(true);
    await requireDb()`DELETE FROM ship_intents WHERE id = ${intentId}`;
  });

  it("ship_continuations.state_version CHECK rejects values < 1", async () => {
    const d = { ...intentDefaults(), pr_number: 991 };
    const inserted: { id: string }[] = await requireDb()`
      INSERT INTO ship_intents (
        installation_id, owner, repo, pr_number,
        target_base_sha, target_head_sha,
        status, deadline_at, created_by_user, tracking_comment_marker
      ) VALUES (
        ${d.installation_id}, ${d.owner}, ${d.repo}, ${d.pr_number},
        ${d.target_base_sha}, ${d.target_head_sha},
        'active', ${d.deadline_at}, ${d.created_by_user}, ${d.tracking_comment_marker}
      )
      RETURNING id
    `;
    const intentId = inserted[0]?.id ?? "";
    let threw = false;
    try {
      await requireDb()`
        INSERT INTO ship_continuations (intent_id, wait_for, wake_at, state_blob, state_version)
        VALUES (${intentId}, ARRAY['ci']::text[], now(), ${{}}, 0)
      `;
    } catch (err) {
      threw = true;
      expect(String(err)).toMatch(/ship_continuations_state_version_check/);
    }
    expect(threw).toBe(true);
    await requireDb()`DELETE FROM ship_intents WHERE id = ${intentId}`;
  });

  // ─── (d) cascade delete ────────────────────────────────────────────────────

  it("cascades delete from ship_intents to children", async () => {
    const d = { ...intentDefaults(), pr_number: 990 };
    const inserted: { id: string }[] = await requireDb()`
      INSERT INTO ship_intents (
        installation_id, owner, repo, pr_number,
        target_base_sha, target_head_sha,
        status, deadline_at, created_by_user, tracking_comment_marker
      ) VALUES (
        ${d.installation_id}, ${d.owner}, ${d.repo}, ${d.pr_number},
        ${d.target_base_sha}, ${d.target_head_sha},
        'active', ${d.deadline_at}, ${d.created_by_user}, ${d.tracking_comment_marker}
      )
      RETURNING id
    `;
    const intentId = inserted[0]?.id ?? "";
    await requireDb()`
      INSERT INTO ship_iterations (intent_id, iteration_n, kind)
      VALUES (${intentId}, 1, 'resolve')
    `;
    await requireDb()`
      INSERT INTO ship_continuations (intent_id, wait_for, wake_at, state_blob, state_version)
      VALUES (${intentId}, ARRAY['ci']::text[], now(), ${{ v: 1 }}, 1)
    `;
    await requireDb()`
      INSERT INTO ship_fix_attempts (intent_id, signature, tier, attempts)
      VALUES (${intentId}, 'sig-y', 1, 1)
    `;

    await requireDb()`DELETE FROM ship_intents WHERE id = ${intentId}`;

    const iters: { c: number }[] = await requireDb()`
      SELECT COUNT(*)::int AS c FROM ship_iterations WHERE intent_id = ${intentId}
    `;
    const conts: { c: number }[] = await requireDb()`
      SELECT COUNT(*)::int AS c FROM ship_continuations WHERE intent_id = ${intentId}
    `;
    const fixes: { c: number }[] = await requireDb()`
      SELECT COUNT(*)::int AS c FROM ship_fix_attempts WHERE intent_id = ${intentId}
    `;
    expect(iters[0]?.c).toBe(0);
    expect(conts[0]?.c).toBe(0);
    expect(fixes[0]?.c).toBe(0);
  });

  // ─── secondary indexes exist ───────────────────────────────────────────────

  it("creates the documented secondary indexes", async () => {
    const indexes: { indexname: string; tablename: string }[] = await requireDb()`
      SELECT indexname, tablename FROM pg_indexes
      WHERE tablename IN ('ship_intents', 'ship_iterations', 'ship_continuations', 'ship_fix_attempts')
    `;
    const names = indexes.map((i) => i.indexname);
    expect(names).toContain("ship_intents_one_active_per_pr");
    expect(names).toContain("idx_ship_intents_active");
    expect(names).toContain("idx_ship_intents_pr");
    expect(names).toContain("idx_ship_iterations_intent");
    expect(names).toContain("idx_ship_iterations_probe_verdict");
    expect(names).toContain("idx_ship_continuations_wake");
  });
});
