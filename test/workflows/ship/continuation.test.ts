/**
 * T012: continuation persist/resume tests covering the restart-safety
 * property: write a continuation, simulate process restart, resume
 * against the same intent_id, assert no duplicates and resumed state
 * matches.
 *
 * DB-backed integration test (skips when Postgres is unreachable, per
 * the established `test/db/queries/ship.test.ts` pattern). Constitution
 * V mandates real DB exercise here so the Zod-validated state-blob
 * schema actually round-trips through Postgres jsonb.
 */

import { SQL } from "bun";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

const TEST_DATABASE_URL =
  process.env["TEST_DATABASE_URL"] ?? "postgres://bot:bot@localhost:55432/github_app_test";

let sql: SQL | null = null;
try {
  const conn = new SQL(TEST_DATABASE_URL);
  await conn`SELECT 1 AS ok`;
  sql = conn;
} catch {
  sql = null;
}

function requireConn(): SQL {
  if (sql === null) throw new Error("Database not available, test should have been skipped");
  return sql;
}

const baseInsert = (
  overrides: Record<string, unknown> = {},
): {
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
  pr_number: 9001,
  target_base_sha: "a".repeat(40),
  target_head_sha: "b".repeat(40),
  deadline_at: new Date(Date.now() + 4 * 3_600_000),
  created_by_user: "alice",
  tracking_comment_marker: "<!-- ship-intent:test -->",
  ...overrides,
});

describe.skipIf(sql === null)("continuation persist/resume", () => {
  beforeAll(async () => {
    const { runMigrations } = await import("../../../src/db/migrate");
    await runMigrations(requireConn());
  });

  beforeEach(async () => {
    await requireConn().unsafe("TRUNCATE TABLE ship_intents CASCADE");
  });

  afterAll(async () => {
    await requireConn().unsafe("TRUNCATE TABLE ship_intents CASCADE");
    await requireConn().close();
  });

  it("persistContinuation writes a row and resumeContinuation returns it on a fresh resume", async () => {
    const { insertIntent } = await import("../../../src/db/queries/ship");
    const { persistContinuation, resumeContinuation } =
      await import("../../../src/workflows/ship/continuation");
    const intent = await insertIntent(baseInsert(), requireConn());

    const wakeAt = new Date(Date.now() + 60_000);
    await persistContinuation(
      {
        intent_id: intent.id,
        wait_for: ["check_run.completed"],
        wake_at: wakeAt,
        state_blob: { v: 1, phase: "probe", last_action: "fired probe", iteration_n: 1 },
      },
      requireConn(),
    );

    const result = await resumeContinuation(intent.id, requireConn());
    expect(result.resumed).toBe(true);
    if (result.resumed) {
      expect(result.state.phase).toBe("probe");
      expect(result.state.iteration_n).toBe(1);
      expect(result.wake_at.getTime()).toBe(wakeAt.getTime());
    }
  });

  it("persistContinuation overwrites an existing row in place: restart safe (no duplicates)", async () => {
    const { insertIntent } = await import("../../../src/db/queries/ship");
    const { persistContinuation, resumeContinuation } =
      await import("../../../src/workflows/ship/continuation");
    const intent = await insertIntent(baseInsert(), requireConn());

    await persistContinuation(
      {
        intent_id: intent.id,
        wait_for: [],
        wake_at: new Date(Date.now() + 30_000),
        state_blob: { v: 1, phase: "probe", last_action: "first", iteration_n: 1 },
      },
      requireConn(),
    );

    // Simulate process restart: the next instance writes again with
    // the SAME intent_id.
    await persistContinuation(
      {
        intent_id: intent.id,
        wait_for: [],
        wake_at: new Date(Date.now() + 60_000),
        state_blob: { v: 1, phase: "fix", last_action: "second", iteration_n: 2 },
      },
      requireConn(),
    );

    // Exactly one row exists, the second write replaced the first.
    const rows = await requireConn()`
      SELECT COUNT(*)::int AS n FROM ship_continuations WHERE intent_id = ${intent.id}
    `;
    const count = (rows[0] as { n: number }).n;
    expect(count).toBe(1);

    const resumed = await resumeContinuation(intent.id, requireConn());
    expect(resumed.resumed).toBe(true);
    if (resumed.resumed) {
      expect(resumed.state.phase).toBe("fix");
      expect(resumed.state.iteration_n).toBe(2);
      expect(resumed.state.last_action).toBe("second");
    }
  });

  it("resumeContinuation returns not_found when no row exists for the intent", async () => {
    const { insertIntent } = await import("../../../src/db/queries/ship");
    const { resumeContinuation } = await import("../../../src/workflows/ship/continuation");
    const intent = await insertIntent(baseInsert(), requireConn());
    const result = await resumeContinuation(intent.id, requireConn());
    expect(result.resumed).toBe(false);
    if (!result.resumed) expect(result.reason).toBe("not_found");
  });

  it("resumeContinuation refuses an unknown state-blob version (returns invalid_blob)", async () => {
    const { insertIntent } = await import("../../../src/db/queries/ship");
    const { resumeContinuation } = await import("../../../src/workflows/ship/continuation");
    const intent = await insertIntent(baseInsert(), requireConn());

    // Bypass the public API to write a future-version blob. This
    // simulates an old replica reading a row written by a newer one.
    await requireConn()`
      INSERT INTO ship_continuations (intent_id, wait_for, wake_at, state_blob, state_version)
      VALUES (${intent.id}, ${"{}"}, ${new Date()}, ${JSON.stringify({ v: 99, phase: "probe", last_action: "x", iteration_n: 0 })}::jsonb, ${99})
    `;

    const result = await resumeContinuation(intent.id, requireConn());
    expect(result.resumed).toBe(false);
    if (!result.resumed) expect(result.reason).toBe("invalid_blob");
  });

  it("deleteContinuation removes the row and returns the deleted count", async () => {
    const { insertIntent } = await import("../../../src/db/queries/ship");
    const { persistContinuation, deleteContinuation, resumeContinuation } =
      await import("../../../src/workflows/ship/continuation");
    const intent = await insertIntent(baseInsert(), requireConn());
    await persistContinuation(
      {
        intent_id: intent.id,
        wait_for: [],
        wake_at: new Date(),
        state_blob: { v: 1, phase: "probe", last_action: "x", iteration_n: 0 },
      },
      requireConn(),
    );
    const deleted = await deleteContinuation(intent.id, requireConn());
    expect(deleted).toBe(1);
    const after = await resumeContinuation(intent.id, requireConn());
    expect(after.resumed).toBe(false);
  });
});
