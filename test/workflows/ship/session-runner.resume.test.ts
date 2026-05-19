/**
 * Tests for `resumeShipIntent` (US2). The scheduler's `onDue` callback
 * fires this function for every tickled intent: terminal intents must
 * be no-ops (otherwise a stale `ship:tickle` entry could keep firing
 * after a successful merge), and missing intents must not throw (the
 * tickle scheduler can't distinguish a still-existing intent from one
 * that was hand-deleted by an operator).
 *
 * Active intents now run `runProbe` against the live PR: the probe is
 * stubbed via `octokitFactory` so the test keeps the existing
 * "no DB mutation" assertion without hitting GitHub.
 */

import { SQL } from "bun";
import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";

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

// Stub the probe so `resumeShipIntent` can run without a real Octokit.
// Each test sets `mockProbeVerdict` before invoking; the default `ready: true`
// drives the terminal-ready branch and never touches GitHub or Valkey.
let mockProbeVerdict: { ready: true } | { ready: false; reason: string } = { ready: true };
void mock.module("../../../src/workflows/ship/probe", () => ({
  runProbe: () =>
    Promise.resolve({
      verdict: mockProbeVerdict,
      response: {},
    }),
}));

const throwingOctokitFactory = (): Promise<Octokit> => {
  throw new Error("octokitFactory should not be called for terminal/missing intent paths");
};

const stubOctokitFactory = (): Promise<Octokit> =>
  // The mocked runProbe ignores the octokit, so an empty object is fine.
  Promise.resolve({} as Octokit);

describe.skipIf(sql === null)("resumeShipIntent", () => {
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

  // Don't close the SQL connection, other test files in the same Bun
  // run share it via the `mock.module` indirection. Closing here would
  // cascade as `Connection closed` errors into later files.

  it("is a no-op on a missing intent (stale tickle entry)", async () => {
    const { resumeShipIntent } = await import("../../../src/workflows/ship/session-runner");
    await resumeShipIntent({
      intentId: "00000000-0000-0000-0000-000000000000",
      octokitFactory: throwingOctokitFactory,
    });
    // No throw == pass. Side-effects are limited to a warn log.
    expect(true).toBe(true);
  });

  it("is a no-op on a terminal intent (tickle obsolete after merge)", async () => {
    const { resumeShipIntent } = await import("../../../src/workflows/ship/session-runner");
    const { insertIntent, transitionIntent } = await import("../../../src/db/queries/ship");

    const intent = await insertIntent(
      {
        installation_id: 8001,
        owner: "resume-test",
        repo: "fixtures",
        pr_number: 8101,
        target_base_sha: "base",
        target_head_sha: "head",
        deadline_at: new Date(Date.now() + 60 * 60 * 1000),
        created_by_user: "tester",
        tracking_comment_marker: "<!-- ship-intent: terminal -->",
      },
      requireSql(),
    );
    await transitionIntent(intent.id, "merged_externally", null, requireSql());

    await resumeShipIntent({
      intentId: intent.id,
      octokitFactory: throwingOctokitFactory,
    });
    // No throw, no DB mutation expected. The status should remain terminal.
    const { getIntentById } = await import("../../../src/db/queries/ship");
    const refreshed = await getIntentById(intent.id, requireSql());
    expect(refreshed?.status).toBe("merged_externally");
  });

  it("transitions to ready_awaiting_human_merge when probe verdict is ready on resume", async () => {
    mockProbeVerdict = { ready: true };
    const { resumeShipIntent } = await import("../../../src/workflows/ship/session-runner");
    const { insertIntent } = await import("../../../src/db/queries/ship");

    const intent = await insertIntent(
      {
        installation_id: 8002,
        owner: "resume-test",
        repo: "fixtures",
        pr_number: 8102,
        target_base_sha: "base",
        target_head_sha: "head",
        deadline_at: new Date(Date.now() + 60 * 60 * 1000),
        created_by_user: "tester",
        tracking_comment_marker: "<!-- ship-intent: active -->",
      },
      requireSql(),
    );

    await resumeShipIntent({
      intentId: intent.id,
      octokitFactory: stubOctokitFactory,
    });

    // C3 fix: ready verdict on resume terminates the intent. The legacy
    // stub-only behavior left it `active`; the wired-up handler closes it.
    const { getIntentById } = await import("../../../src/db/queries/ship");
    const refreshed = await getIntentById(intent.id, requireSql());
    expect(refreshed?.status).toBe("ready_awaiting_human_merge");
  });
});
