/**
 * T037: intent state-machine tests covering data-model.md §"State machine"
 * transitions plus the cascade base-ref Q2-round1 behaviour: when probe
 * detects a `baseRefOid` mismatch, intent updates `target_base_sha` in
 * place WITHOUT resetting `deadline_at` or `spent_usd`.
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

const baseInput = (
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
  pr_number: 7777,
  target_base_sha: "a".repeat(40),
  target_head_sha: "b".repeat(40),
  deadline_at: new Date(Date.now() + 4 * 3_600_000),
  created_by_user: "alice",
  tracking_comment_marker: "<!-- ship-intent:test -->",
  ...overrides,
});

describe.skipIf(sql === null)("intent.ts state machine", () => {
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

  it("createIntent inserts an active intent and is recoverable via getActiveIntent / getIntentById", async () => {
    const { createIntent, getActiveIntent, getIntentById } =
      await import("../../../src/workflows/ship/intent");
    const result = await createIntent(baseInput(), requireConn());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intent.status).toBe("active");
    const byActive = await getActiveIntent(
      "chrisleekr",
      "github-app-playground",
      7777,
      requireConn(),
    );
    expect(byActive?.id).toBe(result.intent.id);
    const byId = await getIntentById(result.intent.id, requireConn());
    expect(byId?.id).toBe(result.intent.id);
  });

  it("createIntent rejects a second concurrent active intent on the same PR (FR-007a)", async () => {
    const { createIntent } = await import("../../../src/workflows/ship/intent");
    const first = await createIntent(baseInput(), requireConn());
    expect(first.ok).toBe(true);
    const second = await createIntent(baseInput(), requireConn());
    expect(second.ok).toBe(false);
  });

  it("transitionToTerminal moves active → ready_awaiting_human_merge with terminated_at set", async () => {
    const { createIntent, transitionToTerminal } =
      await import("../../../src/workflows/ship/intent");
    const created = await createIntent(baseInput(), requireConn());
    if (!created.ok) throw new Error("setup");
    const after = await transitionToTerminal(
      created.intent.id,
      "ready_awaiting_human_merge",
      null,
      requireConn(),
    );
    expect(after?.status).toBe("ready_awaiting_human_merge");
    expect(after?.terminated_at).not.toBeNull();
  });

  it("transitionToTerminal is idempotent: second call to a terminal returns null (no-op)", async () => {
    const { createIntent, transitionToTerminal } =
      await import("../../../src/workflows/ship/intent");
    const created = await createIntent(baseInput(), requireConn());
    if (!created.ok) throw new Error("setup");
    await transitionToTerminal(
      created.intent.id,
      "aborted_by_user",
      "stopped-by-user",
      requireConn(),
    );
    const second = await transitionToTerminal(
      created.intent.id,
      "ready_awaiting_human_merge",
      null,
      requireConn(),
    );
    expect(second).toBeNull();
  });

  it("transitionToTerminal records the BlockerCategory on human_took_over", async () => {
    const { createIntent, transitionToTerminal } =
      await import("../../../src/workflows/ship/intent");
    const created = await createIntent(baseInput(), requireConn());
    if (!created.ok) throw new Error("setup");
    const after = await transitionToTerminal(
      created.intent.id,
      "human_took_over",
      "iteration-cap",
      requireConn(),
    );
    expect(after?.terminal_blocker_category).toBe("iteration-cap");
  });

  it("pauseIntent / resumeIntent cycle: active → paused → active (FR-011)", async () => {
    const { createIntent, pauseIntent, resumeIntent } =
      await import("../../../src/workflows/ship/intent");
    const created = await createIntent(baseInput(), requireConn());
    if (!created.ok) throw new Error("setup");
    const paused = await pauseIntent(created.intent.id, "alice", requireConn());
    expect(paused?.status).toBe("paused");
    const resumed = await resumeIntent(created.intent.id, "alice", requireConn());
    expect(resumed?.status).toBe("active");
  });

  it("pauseIntent on a terminal intent is a no-op (returns null)", async () => {
    const { createIntent, pauseIntent, transitionToTerminal } =
      await import("../../../src/workflows/ship/intent");
    const created = await createIntent(baseInput(), requireConn());
    if (!created.ok) throw new Error("setup");
    await transitionToTerminal(
      created.intent.id,
      "aborted_by_user",
      "stopped-by-user",
      requireConn(),
    );
    const paused = await pauseIntent(created.intent.id, "alice", requireConn());
    expect(paused).toBeNull();
  });

  it("resumeIntent on an active intent is a no-op (guarded UPDATE)", async () => {
    const { createIntent, resumeIntent } = await import("../../../src/workflows/ship/intent");
    const created = await createIntent(baseInput(), requireConn());
    if (!created.ok) throw new Error("setup");
    const result = await resumeIntent(created.intent.id, "alice", requireConn());
    expect(result).toBeNull();
  });

  it("resyncBaseSha updates target_base_sha in place; deadline_at and spent_usd_cents unchanged (Q2-round1)", async () => {
    const { createIntent, resyncBaseSha } = await import("../../../src/workflows/ship/intent");
    const created = await createIntent(baseInput(), requireConn());
    if (!created.ok) throw new Error("setup");
    const before = created.intent;
    const newSha = "c".repeat(40);
    const after = await resyncBaseSha(before.id, newSha, requireConn());
    expect(after?.target_base_sha).toBe(newSha);
    expect(after?.deadline_at.getTime()).toBe(before.deadline_at.getTime());
    expect(after?.spent_usd_cents).toBe(before.spent_usd_cents);
  });

  it("recordIteration appends an iteration row tied to the intent", async () => {
    const { createIntent, recordIteration } = await import("../../../src/workflows/ship/intent");
    const created = await createIntent(baseInput(), requireConn());
    if (!created.ok) throw new Error("setup");
    const iter = await recordIteration(
      {
        intent_id: created.intent.id,
        iteration_n: 1,
        kind: "probe",
        verdict_json: { ready: false, reasons: ["pending_checks"] },
      },
      requireConn(),
    );
    expect(iter.intent_id).toBe(created.intent.id);
    expect(iter.iteration_n).toBe(1);
    expect(iter.kind).toBe("probe");
  });

  it("forceAbortIntent transitions to aborted_by_user with terminal_blocker_category=stopped-by-user", async () => {
    const { createIntent, forceAbortIntent } = await import("../../../src/workflows/ship/intent");
    const created = await createIntent(baseInput(), requireConn());
    if (!created.ok) throw new Error("setup");
    const after = await forceAbortIntent(created.intent.id, "alice", requireConn());
    expect(after?.status).toBe("aborted_by_user");
    expect(after?.terminal_blocker_category).toBe("stopped-by-user");
  });
});
