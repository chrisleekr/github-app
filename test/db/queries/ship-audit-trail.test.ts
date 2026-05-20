/**
 * T049: iteration audit-trail tests (extension of T008's
 * `test/db/queries/ship.test.ts`). Asserts the per-iteration
 * invariants:
 *
 *   - every iteration writes a row with monotonically increasing `iteration_n`
 *   - the row carries the full `verdict_json` for `kind = 'probe'`
 *   - the row carries `cost_usd` for agent-invoking kinds
 *
 * Constitution V: DB-backed integration; no mocks.
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
  pr_number: 5500,
  target_base_sha: "a".repeat(40),
  target_head_sha: "b".repeat(40),
  deadline_at: new Date(Date.now() + 4 * 3_600_000),
  created_by_user: "alice",
  tracking_comment_marker: "<!-- ship-intent:audit -->",
});

describe.skipIf(sql === null)("iteration audit trail, T049", () => {
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

  it("appendIteration writes monotonically increasing iteration_n rows", async () => {
    const { insertIntent, appendIteration } = await import("../../../src/db/queries/ship");
    const intent = await insertIntent(baseInsert(), requireConn());
    for (let n = 1; n <= 4; n += 1) {
      await appendIteration(
        {
          intent_id: intent.id,
          iteration_n: n,
          kind: "probe",
          verdict_json: { ready: false, reasons: ["pending_checks"] },
        },
        requireConn(),
      );
    }
    const rows = await requireConn()`
      SELECT iteration_n FROM ship_iterations
       WHERE intent_id = ${intent.id}
       ORDER BY iteration_n ASC
    `;
    const seen = (rows as readonly { iteration_n: number }[]).map((r) => r.iteration_n);
    expect(seen).toEqual([1, 2, 3, 4]);
    // Strictly monotonic, no duplicates, no gaps.
    for (let i = 1; i < seen.length; i += 1) {
      expect((seen[i] ?? 0) - (seen[i - 1] ?? 0)).toBe(1);
    }
  });

  it("probe iterations carry verdict_json verbatim through Postgres jsonb round-trip", async () => {
    const { insertIntent, appendIteration } = await import("../../../src/db/queries/ship");
    const intent = await insertIntent(baseInsert(), requireConn());
    const verdict = {
      ready: false,
      reasons: ["pending_checks", "open_threads"],
      mergeable_state: "blocked",
      head_sha: "c".repeat(40),
    };
    await appendIteration(
      {
        intent_id: intent.id,
        iteration_n: 1,
        kind: "probe",
        verdict_json: verdict,
      },
      requireConn(),
    );
    const rows = await requireConn()`
      SELECT verdict_json FROM ship_iterations WHERE intent_id = ${intent.id}
    `;
    const stored = (rows[0] as { verdict_json: unknown }).verdict_json;
    expect(stored).toEqual(verdict);
  });

  it("agent-invoking iterations carry non-zero cost_usd", async () => {
    const { insertIntent, appendIteration } = await import("../../../src/db/queries/ship");
    const intent = await insertIntent(baseInsert(), requireConn());
    // Allowed iteration kinds per migration 008_ship_intents.sql:
    // 'probe', 'resolve', 'review', 'branch-refresh'. `resolve` is the
    // canonical agent-invoking iteration that pays a per-call USD cost.
    await appendIteration(
      {
        intent_id: intent.id,
        iteration_n: 1,
        kind: "resolve",
        cost_usd: 1.52,
      },
      requireConn(),
    );
    const rows = await requireConn()`
      SELECT cost_usd FROM ship_iterations WHERE intent_id = ${intent.id}
    `;
    // NUMERIC values come back as strings from Bun.sql to preserve precision.
    expect(Number((rows[0] as { cost_usd: string | number }).cost_usd)).toBeCloseTo(1.52, 4);
  });
});
