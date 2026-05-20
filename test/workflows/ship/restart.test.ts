/**
 * T048: restart-safety integration test. Simulates process termination
 * mid-iteration: write a continuation row, then re-resume from a fresh
 * call site as if the prior process had exited via `process.exit(1)`.
 *
 * The contract asserted: a restarted session attaches to the existing
 * tracking comment via the marker on the persisted intent (no
 * duplicate created) and resumes from the persisted state-blob (no
 * iteration replay).
 *
 * DB-backed integration test (skips when Postgres is unreachable).
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

const baseInsert = (): {
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
  pr_number: 6001,
  target_base_sha: "a".repeat(40),
  target_head_sha: "b".repeat(40),
  deadline_at: new Date(Date.now() + 4 * 3_600_000),
  created_by_user: "alice",
  tracking_comment_marker: "<!-- ship-intent:restart-test -->",
});

describe.skipIf(sql === null)("restart safety, T048", () => {
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

  it("a process that wrote a continuation then `exited` resumes against the persisted state, no duplicate intent created", async () => {
    const { insertIntent, findActiveIntent } = await import("../../../src/db/queries/ship");
    const { persistContinuation, resumeContinuation } =
      await import("../../../src/workflows/ship/continuation");

    // Process #1, creates intent, sets tracking_comment_id (the
    // post-create CAS step in handlers/ship.ts), writes a continuation,
    // then "crashes".
    const intentInsert = await insertIntent(baseInsert(), requireConn());
    await requireConn()`
      UPDATE ship_intents SET tracking_comment_id = ${4242} WHERE id = ${intentInsert.id}
    `;
    await persistContinuation(
      {
        intent_id: intentInsert.id,
        wait_for: ["check_run.completed"],
        wake_at: new Date(Date.now() + 600_000),
        state_blob: {
          v: 1,
          phase: "fix",
          last_action: "applied lint autofix",
          iteration_n: 3,
        },
      },
      requireConn(),
    );
    // Simulate process termination: nothing actually exits, we just
    // re-enter via fresh imports below and assert state was preserved.

    // Process #2, restart, look up the intent by (owner, repo, pr) and
    // resume the continuation.
    const found = await findActiveIntent(
      "chrisleekr",
      "github-app-playground",
      6001,
      requireConn(),
    );
    expect(found).not.toBeNull();
    expect(found?.id).toBe(intentInsert.id);
    // Critical: tracking_comment_id is preserved so the restart attaches
    // to the SAME tracking comment (no duplicates per FR-006).
    // BIGINT columns come back as strings from Bun.sql to preserve precision.
    expect(Number(found?.tracking_comment_id)).toBe(4242);
    expect(found?.tracking_comment_marker).toBe("<!-- ship-intent:restart-test -->");

    // Resume reads the persisted state-blob.
    const resumed = await resumeContinuation(intentInsert.id, requireConn());
    expect(resumed.resumed).toBe(true);
    if (resumed.resumed) {
      expect(resumed.state.iteration_n).toBe(3);
      expect(resumed.state.phase).toBe("fix");
      expect(resumed.state.last_action).toBe("applied lint autofix");
    }
  });

  it("two restart cycles in a row still resolve to a single intent + single continuation row", async () => {
    const { insertIntent } = await import("../../../src/db/queries/ship");
    const { persistContinuation, resumeContinuation } =
      await import("../../../src/workflows/ship/continuation");
    const intentInsert = await insertIntent(baseInsert(), requireConn());

    for (let i = 0; i < 3; i += 1) {
      await persistContinuation(
        {
          intent_id: intentInsert.id,
          wait_for: [],
          wake_at: new Date(Date.now() + 60_000 * (i + 1)),
          state_blob: {
            v: 1,
            phase: "probe",
            last_action: `cycle-${String(i)}`,
            iteration_n: i,
          },
        },
        requireConn(),
      );
    }

    // Exactly one continuation row.
    const counts = await requireConn()`
      SELECT COUNT(*)::int AS n FROM ship_continuations WHERE intent_id = ${intentInsert.id}
    `;
    expect((counts[0] as { n: number }).n).toBe(1);

    // Final resume returns the latest state.
    const resumed = await resumeContinuation(intentInsert.id, requireConn());
    expect(resumed.resumed).toBe(true);
    if (resumed.resumed) expect(resumed.state.last_action).toBe("cycle-2");
  });
});
