/**
 * Integration tests for src/orchestrator/review-learnings.ts.
 *
 * Opt-in via TEST_DATABASE_URL (same convention as repo-knowledge.test.ts).
 * Exercises the DB queries end-to-end on a real Postgres so the migration,
 * schema constraints, and Bun.sql array-binding form are all covered.
 */

import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

let sql: SQL | null = null;
if (TEST_DATABASE_URL !== undefined && TEST_DATABASE_URL.length > 0) {
  try {
    const conn = new SQL(TEST_DATABASE_URL);
    await conn`SELECT 1 AS ok`;
    sql = conn;
  } catch {
    sql = null;
  }
}

function requireSql(): SQL {
  if (sql === null) throw new Error("Database not available, test should have been skipped");
  return sql;
}

const TEST_OWNER = "review-learnings-test-owner";
const TEST_REPO = "review-learnings-test-repo";

describe.skipIf(sql === null)("review-learnings loader and persistence", () => {
  beforeAll(async () => {
    const db = requireSql();
    await db.unsafe(`
      DROP TABLE IF EXISTS _migrations CASCADE;
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
    const { runMigrations } = await import("../../src/db/migrate");
    await runMigrations(db);
  });

  afterAll(async () => {
    const db = sql;
    if (db === null) return;
    try {
      await db`DELETE FROM review_learnings WHERE repo_owner = ${TEST_OWNER}`;
    } finally {
      await db.close();
    }
  });

  it("saveReviewLearnings persists a local-scope directive with provenance", async () => {
    const db = requireSql();
    const { saveReviewLearnings } = await import("../../src/orchestrator/review-learnings");

    const saved = await saveReviewLearnings(
      TEST_OWNER,
      TEST_REPO,
      [
        {
          directive: "Do not flag SCOPED_JOB_KINDS literal inlining in mock.module factories",
          rationale: "factory closures need the literal at module-evaluation time",
          fileGlob: "test/**/*.test.ts",
          sourcePr: 79,
          sourceAuthor: "chrisleekr",
          sourceThread: "review_comment:3254289529",
        },
      ],
      db,
    );

    expect(saved).toBe(1);

    const rows: { directive: string; scope: string; repo_name: string; file_glob: string }[] =
      await db`SELECT directive, scope, repo_name, file_glob FROM review_learnings
               WHERE repo_owner = ${TEST_OWNER}`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.scope).toBe("local");
    expect(rows[0]!.repo_name).toBe(TEST_REPO);
    expect(rows[0]!.file_glob).toBe("test/**/*.test.ts");
    expect(rows[0]!.directive).toContain("mock.module factories");
  });

  it("loadReviewLearnings returns the full owner+repo set without bumping use_count (1.5.E)", async () => {
    const db = requireSql();
    const { loadReviewLearnings } = await import("../../src/orchestrator/review-learnings");

    // Loader is intentionally file-glob agnostic AND pure-read: the
    // orchestrator does not yet know which files the PR touched at
    // job-accept time, so the daemon-side prompt-builder applies the filter
    // via pickApplicableLearnings. Per 1.5.E, the use_count bump moved to
    // bumpReviewLearningUsage and fires only after the daemon reports the
    // applied ids in job:result.
    const loaded = await loadReviewLearnings(TEST_OWNER, TEST_REPO, {}, db);

    expect(loaded.length).toBe(1);
    expect(loaded[0]!.fileGlob).toBe("test/**/*.test.ts");
    expect(loaded[0]!.sourcePr).toBe(79);

    const after: { use_count: number; last_used_at: Date | null }[] =
      await db`SELECT use_count, last_used_at FROM review_learnings
               WHERE repo_owner = ${TEST_OWNER}`;
    expect(after[0]!.use_count).toBe(0);
    expect(after[0]!.last_used_at).toBeNull();
  });

  it("bumpReviewLearningUsage increments use_count and stamps last_used_at (1.5.E)", async () => {
    const db = requireSql();
    const { loadReviewLearnings, bumpReviewLearningUsage } =
      await import("../../src/orchestrator/review-learnings");

    const loaded = await loadReviewLearnings(TEST_OWNER, TEST_REPO, {}, db);
    const ids = loaded.map((l) => l.id);
    expect(ids.length).toBeGreaterThan(0);

    // First bump.
    await bumpReviewLearningUsage(ids, db);
    const after1: { use_count: number; last_used_at: Date | null }[] =
      await db`SELECT use_count, last_used_at FROM review_learnings
               WHERE id IN ${db(ids)}`;
    expect(after1[0]!.use_count).toBe(1);
    expect(after1[0]!.last_used_at).not.toBeNull();

    // Second bump on the same ids; counter increments to 2.
    await bumpReviewLearningUsage(ids, db);
    const after2: { use_count: number }[] =
      await db`SELECT use_count FROM review_learnings WHERE id IN ${db(ids)}`;
    expect(after2[0]!.use_count).toBe(2);

    // Empty input is a no-op.
    await bumpReviewLearningUsage([], db);
  });

  it("pickApplicableLearnings excludes glob-scoped rows when no changed file matches", async () => {
    const db = requireSql();
    const { loadReviewLearnings } = await import("../../src/orchestrator/review-learnings");
    const { pickApplicableLearnings } = await import("../../src/utils/review-learnings-filter");

    const loaded = await loadReviewLearnings(TEST_OWNER, TEST_REPO, {}, db);
    const filtered = pickApplicableLearnings(
      loaded.map((l) => ({
        id: l.id,
        scope: l.scope,
        fileGlob: l.fileGlob,
        directive: l.directive,
        rationale: l.rationale,
        sourcePr: l.sourcePr,
        sourceThread: l.sourceThread,
        sourceAuthor: l.sourceAuthor,
      })),
      ["src/app.ts"],
    );
    expect(filtered.length).toBe(0);
  });

  it("pickApplicableLearnings with empty changedFiles only keeps repo-wide (null-glob) rows", async () => {
    const db = requireSql();
    const { loadReviewLearnings } = await import("../../src/orchestrator/review-learnings");
    const { pickApplicableLearnings } = await import("../../src/utils/review-learnings-filter");

    const loaded = await loadReviewLearnings(TEST_OWNER, TEST_REPO, {}, db);
    const filtered = pickApplicableLearnings(
      loaded.map((l) => ({
        id: l.id,
        scope: l.scope,
        fileGlob: l.fileGlob,
        directive: l.directive,
        rationale: l.rationale,
        sourcePr: l.sourcePr,
        sourceThread: l.sourceThread,
        sourceAuthor: l.sourceAuthor,
      })),
      [],
    );
    // The seeded row has fileGlob='test/**/*.test.ts' (non-null), so the
    // issue-context (empty changedFiles) filter drops it.
    expect(filtered.length).toBe(0);
  });

  it("saveReviewLearnings downgrades scope='global' to 'local' when allowedOwners has > 1 owner", async () => {
    const db = requireSql();

    const { saveReviewLearnings } = await import("../../src/orchestrator/review-learnings");

    // Re-import config to mutate at module level. Test relies on the config
    // singleton's allowedOwners array shape; we mutate then restore.
    const { config } = await import("../../src/config");
    const original = config.allowedOwners;
    Object.defineProperty(config, "allowedOwners", {
      value: ["owner-a", "owner-b"],
      configurable: true,
    });

    try {
      const saved = await saveReviewLearnings(
        TEST_OWNER,
        TEST_REPO,
        [{ directive: "global-attempt directive", scope: "global" }],
        db,
      );
      expect(saved).toBe(1);

      const rows: { scope: string; repo_name: string }[] =
        await db`SELECT scope, repo_name FROM review_learnings
                 WHERE repo_owner = ${TEST_OWNER} AND directive = 'global-attempt directive'`;
      expect(rows.length).toBe(1);
      // Downgraded.
      expect(rows[0]!.scope).toBe("local");
      expect(rows[0]!.repo_name).toBe(TEST_REPO);
    } finally {
      Object.defineProperty(config, "allowedOwners", {
        value: original,
        configurable: true,
      });
    }
  });

  it("saveReviewLearnings preserves scope='global' when allowedOwners has exactly one owner", async () => {
    const db = requireSql();
    const { saveReviewLearnings } = await import("../../src/orchestrator/review-learnings");

    const { config } = await import("../../src/config");
    const original = config.allowedOwners;
    Object.defineProperty(config, "allowedOwners", {
      value: [TEST_OWNER],
      configurable: true,
    });

    try {
      const saved = await saveReviewLearnings(
        TEST_OWNER,
        "any-repo",
        [{ directive: "global-allowed directive", scope: "global" }],
        db,
      );
      expect(saved).toBe(1);

      const rows: { scope: string; repo_name: string }[] =
        await db`SELECT scope, repo_name FROM review_learnings
                 WHERE repo_owner = ${TEST_OWNER} AND directive = 'global-allowed directive'`;
      expect(rows.length).toBe(1);
      expect(rows[0]!.scope).toBe("global");
      // Wildcard repo per migration 014 invariant.
      expect(rows[0]!.repo_name).toBe("*");
    } finally {
      Object.defineProperty(config, "allowedOwners", {
        value: original,
        configurable: true,
      });
    }
  });

  it("loadReviewLearnings returns global rows for any repo under the owner", async () => {
    const db = requireSql();
    const { loadReviewLearnings } = await import("../../src/orchestrator/review-learnings");

    const loaded = await loadReviewLearnings(TEST_OWNER, "some-other-repo", {}, db);
    const directives = loaded.map((r) => r.directive);
    expect(directives).toContain("global-allowed directive");
  });

  it("saveReviewLearnings skips a learning whose directive sanitises to empty", async () => {
    const db = requireSql();
    const { saveReviewLearnings } = await import("../../src/orchestrator/review-learnings");

    const saved = await saveReviewLearnings(
      TEST_OWNER,
      TEST_REPO,
      [{ directive: "<!-- only -->​‌" }],
      db,
    );
    expect(saved).toBe(0);
  });

  it("deleteReviewLearnings removes ids scoped to the owner/repo", async () => {
    const db = requireSql();
    const { deleteReviewLearnings, saveReviewLearnings } =
      await import("../../src/orchestrator/review-learnings");

    await saveReviewLearnings(
      TEST_OWNER,
      TEST_REPO,
      [{ directive: "to-delete A" }, { directive: "to-delete B" }, { directive: "keep-me" }],
      db,
    );

    const targets: { id: string }[] = await db`
      SELECT id FROM review_learnings
      WHERE repo_owner = ${TEST_OWNER} AND directive LIKE 'to-delete%'
    `;
    expect(targets.length).toBe(2);

    const deleted = await deleteReviewLearnings(
      TEST_OWNER,
      TEST_REPO,
      targets.map((r) => r.id),
      db,
    );
    expect(deleted).toBe(2);

    const remaining: { directive: string }[] = await db`
      SELECT directive FROM review_learnings
      WHERE repo_owner = ${TEST_OWNER}
        AND (directive LIKE 'to-delete%' OR directive = 'keep-me')
    `;
    const directives = remaining.map((r) => r.directive);
    expect(directives).toContain("keep-me");
    expect(directives).not.toContain("to-delete A");
    expect(directives).not.toContain("to-delete B");
  });

  it("deleteReviewLearnings refuses to delete a row owned by another repo (1.5.D)", async () => {
    const db = requireSql();
    const { deleteReviewLearnings, saveReviewLearnings } =
      await import("../../src/orchestrator/review-learnings");

    // Seed a row under (TEST_OWNER, TEST_REPO).
    await saveReviewLearnings(TEST_OWNER, TEST_REPO, [{ directive: "owned-by-test-repo" }], db);
    const target: { id: string }[] = await db`
      SELECT id FROM review_learnings
      WHERE repo_owner = ${TEST_OWNER} AND directive = 'owned-by-test-repo'
    `;
    expect(target.length).toBe(1);

    // Try to delete from a DIFFERENT repo's job context. The id is real but
    // belongs to another repo, so the WHERE clause matches nothing.
    const deleted = await deleteReviewLearnings(TEST_OWNER, "some-other-repo", [target[0]!.id], db);
    expect(deleted).toBe(0);

    // Row should still exist.
    const after: { id: string }[] = await db`
      SELECT id FROM review_learnings WHERE id = ${target[0]!.id}
    `;
    expect(after.length).toBe(1);
  });

  it("deleteReviewLearnings can delete global rows from any repo under the same owner (1.5.D)", async () => {
    const db = requireSql();
    const { deleteReviewLearnings, saveReviewLearnings } =
      await import("../../src/orchestrator/review-learnings");

    // Force scope=global by setting allowedOwners to a single owner.
    const { config } = await import("../../src/config");
    const original = config.allowedOwners;
    Object.defineProperty(config, "allowedOwners", {
      value: [TEST_OWNER],
      configurable: true,
    });

    try {
      await saveReviewLearnings(
        TEST_OWNER,
        TEST_REPO,
        [{ directive: "global-deletable", scope: "global" }],
        db,
      );
      const target: { id: string }[] = await db`
        SELECT id FROM review_learnings
        WHERE repo_owner = ${TEST_OWNER}
          AND directive = 'global-deletable'
          AND scope = 'global'
      `;
      expect(target.length).toBe(1);

      // Delete from an arbitrary repo under the same owner. Global rows are
      // owner-scoped, not repo-scoped, so this should succeed.
      const deleted = await deleteReviewLearnings(
        TEST_OWNER,
        "any-repo-under-owner",
        [target[0]!.id],
        db,
      );
      expect(deleted).toBe(1);
    } finally {
      Object.defineProperty(config, "allowedOwners", {
        value: original,
        configurable: true,
      });
    }
  });

  it("loadReviewLearnings with scope='local' excludes owner-wide rows (1.5.F)", async () => {
    const db = requireSql();
    const { loadReviewLearnings, saveReviewLearnings } =
      await import("../../src/orchestrator/review-learnings");

    // Seed a global row under single-owner allowlist.
    const { config } = await import("../../src/config");
    const original = config.allowedOwners;
    Object.defineProperty(config, "allowedOwners", {
      value: [TEST_OWNER],
      configurable: true,
    });
    try {
      await saveReviewLearnings(
        TEST_OWNER,
        TEST_REPO,
        [{ directive: "global-row-for-filter-test", scope: "global" }],
        db,
      );
    } finally {
      Object.defineProperty(config, "allowedOwners", { value: original, configurable: true });
    }

    const withGlobal = await loadReviewLearnings(TEST_OWNER, TEST_REPO, { scope: "global" }, db);
    expect(withGlobal.some((l) => l.directive === "global-row-for-filter-test")).toBe(true);

    const localOnly = await loadReviewLearnings(TEST_OWNER, TEST_REPO, { scope: "local" }, db);
    expect(localOnly.some((l) => l.directive === "global-row-for-filter-test")).toBe(false);
  });

  it("loadReviewLearnings with maxAgeDays excludes rows older than the cutoff (1.5.F)", async () => {
    const db = requireSql();
    const { loadReviewLearnings, saveReviewLearnings } =
      await import("../../src/orchestrator/review-learnings");

    await saveReviewLearnings(TEST_OWNER, TEST_REPO, [{ directive: "old-row-for-age-test" }], db);
    // Force created_at to 200 days ago.
    await db`UPDATE review_learnings
             SET created_at = now() - INTERVAL '200 days'
             WHERE repo_owner = ${TEST_OWNER} AND directive = 'old-row-for-age-test'`;

    const noCap = await loadReviewLearnings(TEST_OWNER, TEST_REPO, {}, db);
    expect(noCap.some((l) => l.directive === "old-row-for-age-test")).toBe(true);

    const with90Day = await loadReviewLearnings(TEST_OWNER, TEST_REPO, { maxAgeDays: 90 }, db);
    expect(with90Day.some((l) => l.directive === "old-row-for-age-test")).toBe(false);
  });

  it("deleteReviewLearnings with empty array is a no-op (does not query DB)", async () => {
    const { deleteReviewLearnings } = await import("../../src/orchestrator/review-learnings");
    const result = await deleteReviewLearnings(TEST_OWNER, TEST_REPO, [], requireSql());
    expect(result).toBe(0);
  });
});
