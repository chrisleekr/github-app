/**
 * Integration tests for src/db/queries/ship.ts.
 *
 * Exercises every exported function against a real test database (no
 * SQL mocks per Constitution V). Skips when Postgres is unreachable.
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
  pr_number: 1000,
  target_base_sha: "a".repeat(40),
  target_head_sha: "b".repeat(40),
  deadline_at: new Date(Date.now() + 4 * 3_600_000),
  created_by_user: "alice",
  tracking_comment_marker: "<!-- ship-intent:test -->",
  ...overrides,
});

describe.skipIf(sql === null)("src/db/queries/ship.ts", () => {
  beforeAll(async () => {
    // Ensure schema is in place, the migrate.test suite may run first or last.
    const { runMigrations } = await import("../../../src/db/migrate");
    await runMigrations(requireConn());
  });

  beforeEach(async () => {
    // Each test owns its rows; truncate ship_* between tests for isolation.
    // Cascade clears child tables (iterations / continuations / fix_attempts).
    await requireConn().unsafe("TRUNCATE TABLE ship_intents CASCADE");
  });

  afterAll(async () => {
    await requireConn().unsafe("TRUNCATE TABLE ship_intents CASCADE");
    await requireConn().close();
  });

  it("insertIntent returns the inserted row with status='active'", async () => {
    const { insertIntent } = await import("../../../src/db/queries/ship");
    const row = await insertIntent(baseInsert(), requireConn());
    expect(row.status).toBe("active");
    expect(row.owner).toBe("chrisleekr");
    expect(row.repo).toBe("github-app-playground");
    expect(row.pr_number).toBe(1000);
    expect(row.terminated_at).toBeNull();
    expect(row.terminal_blocker_category).toBeNull();
  });

  it("insertIntent rejects a second active intent for the same PR", async () => {
    const { insertIntent } = await import("../../../src/db/queries/ship");
    await insertIntent(baseInsert(), requireConn());
    let threw = false;
    try {
      await insertIntent(baseInsert(), requireConn());
    } catch (err) {
      threw = true;
      expect(String(err)).toMatch(/ship_intents_one_active_per_pr/);
    }
    expect(threw).toBe(true);
  });

  it("findActiveIntent returns the in-flight row when status='active' or 'paused'", async () => {
    const { insertIntent, findActiveIntent } = await import("../../../src/db/queries/ship");
    const inserted = await insertIntent(baseInsert(), requireConn());
    const active = await findActiveIntent(
      "chrisleekr",
      "github-app-playground",
      1000,
      requireConn(),
    );
    expect(active?.id).toBe(inserted.id);

    await requireConn()`UPDATE ship_intents SET status = 'paused' WHERE id = ${inserted.id}`;
    const paused = await findActiveIntent(
      "chrisleekr",
      "github-app-playground",
      1000,
      requireConn(),
    );
    expect(paused?.id).toBe(inserted.id);
  });

  it("findActiveIntent returns null when no in-flight intent exists", async () => {
    const { findActiveIntent } = await import("../../../src/db/queries/ship");
    const result = await findActiveIntent("nope", "nope", 1, requireConn());
    expect(result).toBeNull();
  });

  it("getIntentById returns null for unknown id", async () => {
    const { getIntentById } = await import("../../../src/db/queries/ship");
    const result = await getIntentById("00000000-0000-0000-0000-000000000000", requireConn());
    expect(result).toBeNull();
  });

  it("transitionIntent moves an active intent to a terminal state", async () => {
    const { insertIntent, transitionIntent } = await import("../../../src/db/queries/ship");
    const inserted = await insertIntent(baseInsert(), requireConn());
    const updated = await transitionIntent(
      inserted.id,
      "human_took_over",
      "design-discussion-needed",
      requireConn(),
    );
    expect(updated?.status).toBe("human_took_over");
    expect(updated?.terminal_blocker_category).toBe("design-discussion-needed");
    expect(updated?.terminated_at).not.toBeNull();
  });

  it("transitionIntent is a no-op on already-terminal intents", async () => {
    const { insertIntent, transitionIntent } = await import("../../../src/db/queries/ship");
    const inserted = await insertIntent(baseInsert(), requireConn());
    await transitionIntent(inserted.id, "aborted_by_user", "stopped-by-user", requireConn());
    const second = await transitionIntent(inserted.id, "deadline_exceeded", null, requireConn());
    expect(second).toBeNull();
  });

  it("appendIteration writes a probe iteration with verdict_json", async () => {
    const { insertIntent, appendIteration } = await import("../../../src/db/queries/ship");
    const intent = await insertIntent(baseInsert(), requireConn());
    const iter = await appendIteration(
      {
        intent_id: intent.id,
        iteration_n: 1,
        kind: "probe",
        verdict_json: { ready: true, head_sha: "abc" },
        cost_usd: 0,
        finished_at: new Date(),
      },
      requireConn(),
    );
    expect(iter.iteration_n).toBe(1);
    expect(iter.kind).toBe("probe");
    expect(iter.verdict_json).toEqual({ ready: true, head_sha: "abc" });
  });

  it("appendIteration writes a non-probe iteration without verdict columns", async () => {
    const { insertIntent, appendIteration } = await import("../../../src/db/queries/ship");
    const intent = await insertIntent(baseInsert(), requireConn());
    const iter = await appendIteration(
      { intent_id: intent.id, iteration_n: 1, kind: "resolve", cost_usd: 0.42 },
      requireConn(),
    );
    expect(iter.kind).toBe("resolve");
    expect(iter.verdict_json).toBeNull();
    expect(iter.non_readiness_reason).toBeNull();
    expect(Number(iter.cost_usd)).toBeCloseTo(0.42, 4);
  });

  it("appendIteration UNIQUE (intent_id, iteration_n) blocks duplicates", async () => {
    const { insertIntent, appendIteration } = await import("../../../src/db/queries/ship");
    const intent = await insertIntent(baseInsert(), requireConn());
    await appendIteration({ intent_id: intent.id, iteration_n: 1, kind: "probe" }, requireConn());
    let threw = false;
    try {
      await appendIteration(
        { intent_id: intent.id, iteration_n: 1, kind: "resolve" },
        requireConn(),
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("upsertContinuation inserts and then updates the row in place", async () => {
    const { insertIntent, upsertContinuation } = await import("../../../src/db/queries/ship");
    const intent = await insertIntent(baseInsert(), requireConn());
    const wakeFirst = new Date(Date.now() + 60_000);
    const first = await upsertContinuation(
      {
        intent_id: intent.id,
        wait_for: ["ci"],
        wake_at: wakeFirst,
        state_blob: { v: 1, phase: "wait" },
        state_version: 1,
      },
      requireConn(),
    );
    expect(first.wait_for).toEqual(["ci"]);

    const wakeSecond = new Date(Date.now() + 120_000);
    const second = await upsertContinuation(
      {
        intent_id: intent.id,
        wait_for: ["ci", "review"],
        wake_at: wakeSecond,
        state_blob: { v: 1, phase: "probe" },
        state_version: 1,
      },
      requireConn(),
    );
    expect(second.wait_for).toEqual(["ci", "review"]);
    expect(second.wake_at.getTime()).toBe(wakeSecond.getTime());

    const count: { c: number }[] = await requireConn()`
      SELECT COUNT(*)::int AS c FROM ship_continuations WHERE intent_id = ${intent.id}
    `;
    expect(count[0]?.c).toBe(1);
  });

  it("findDueContinuations returns rows whose wake_at <= now and intent is in-flight", async () => {
    const { insertIntent, upsertContinuation, findDueContinuations, transitionIntent } =
      await import("../../../src/db/queries/ship");
    const intentDue = await insertIntent(baseInsert({ pr_number: 2000 }), requireConn());
    const intentFuture = await insertIntent(baseInsert({ pr_number: 2001 }), requireConn());
    const intentTerminated = await insertIntent(baseInsert({ pr_number: 2002 }), requireConn());

    await upsertContinuation(
      {
        intent_id: intentDue.id,
        wait_for: ["ci"],
        wake_at: new Date(Date.now() - 60_000),
        state_blob: { v: 1 },
        state_version: 1,
      },
      requireConn(),
    );
    await upsertContinuation(
      {
        intent_id: intentFuture.id,
        wait_for: ["ci"],
        wake_at: new Date(Date.now() + 600_000),
        state_blob: { v: 1 },
        state_version: 1,
      },
      requireConn(),
    );
    await upsertContinuation(
      {
        intent_id: intentTerminated.id,
        wait_for: ["ci"],
        wake_at: new Date(Date.now() - 60_000),
        state_blob: { v: 1 },
        state_version: 1,
      },
      requireConn(),
    );
    await transitionIntent(
      intentTerminated.id,
      "aborted_by_user",
      "stopped-by-user",
      requireConn(),
    );

    const due = await findDueContinuations(new Date(), requireConn());
    const dueIds = due.map((c) => c.intent_id);
    expect(dueIds).toContain(intentDue.id);
    expect(dueIds).not.toContain(intentFuture.id);
    expect(dueIds).not.toContain(intentTerminated.id);
  });

  it("deleteContinuation returns 1 on hit, 0 on miss", async () => {
    const { insertIntent, upsertContinuation, deleteContinuation } =
      await import("../../../src/db/queries/ship");
    const intent = await insertIntent(baseInsert(), requireConn());
    await upsertContinuation(
      {
        intent_id: intent.id,
        wait_for: ["ci"],
        wake_at: new Date(),
        state_blob: { v: 1 },
        state_version: 1,
      },
      requireConn(),
    );
    expect(await deleteContinuation(intent.id, requireConn())).toBe(1);
    expect(await deleteContinuation(intent.id, requireConn())).toBe(0);
  });

  it("incrementFixAttempt inserts on first call and increments on subsequent", async () => {
    const { insertIntent, incrementFixAttempt, getFixAttempt } =
      await import("../../../src/db/queries/ship");
    const intent = await insertIntent(baseInsert(), requireConn());
    const r1 = await incrementFixAttempt(intent.id, "sig-A", 1, requireConn());
    expect(r1.attempts).toBe(1);
    const r2 = await incrementFixAttempt(intent.id, "sig-A", 1, requireConn());
    expect(r2.attempts).toBe(2);
    const r3 = await incrementFixAttempt(intent.id, "sig-B", 2, requireConn());
    expect(r3.attempts).toBe(1);
    expect(r3.tier).toBe(2);

    const fetched = await getFixAttempt(intent.id, "sig-A", requireConn());
    expect(fetched?.attempts).toBe(2);
  });

  it("getFixAttempt returns null when no attempt has been recorded", async () => {
    const { insertIntent, getFixAttempt } = await import("../../../src/db/queries/ship");
    const intent = await insertIntent(baseInsert(), requireConn());
    const result = await getFixAttempt(intent.id, "never-seen", requireConn());
    expect(result).toBeNull();
  });

  it("isolation: fix-attempt counters are scoped per intent_id", async () => {
    const { insertIntent, incrementFixAttempt } = await import("../../../src/db/queries/ship");
    const a = await insertIntent(baseInsert({ pr_number: 3000 }), requireConn());
    const b = await insertIntent(baseInsert({ pr_number: 3001 }), requireConn());
    await incrementFixAttempt(a.id, "shared-sig", 1, requireConn());
    await incrementFixAttempt(a.id, "shared-sig", 1, requireConn());
    const ra = await incrementFixAttempt(a.id, "shared-sig", 1, requireConn());
    const rb = await incrementFixAttempt(b.id, "shared-sig", 1, requireConn());
    expect(ra.attempts).toBe(3);
    expect(rb.attempts).toBe(1);
  });
});
