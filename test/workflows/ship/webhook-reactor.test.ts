/**
 * T013: webhook-reactor tests covering the 11 scenarios from
 * `contracts/webhook-event-subscriptions.md` §"Tests".
 *
 * DB-backed integration test (skips when Postgres is unreachable).
 * Valkey is mocked via a Pick<RedisClient, "send"> stub so the reactor
 * can be exercised without a live Redis-compatible server: the
 * contract under test is "what does the reactor do given this event,
 * not what does Valkey do given this command".
 */

import { SQL } from "bun";
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

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

const BOT_LOGIN = "chrisleekr-bot[bot]";

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
  pr_number: 8001,
  target_base_sha: "a".repeat(40),
  target_head_sha: "b".repeat(40),
  deadline_at: new Date(Date.now() + 4 * 3_600_000),
  created_by_user: "alice",
  tracking_comment_marker: "<!-- ship-intent:test -->",
  ...overrides,
});

function buildValkeyStub() {
  const send = mock(() => Promise.resolve("OK"));
  return { stub: { send }, send };
}

async function persistContinuationFor(intent_id: string): Promise<void> {
  await requireConn()`
    INSERT INTO ship_continuations (intent_id, wait_for, wake_at, state_blob, state_version)
    VALUES (${intent_id}, ${"{}"}, ${new Date(Date.now() + 600_000)},
            ${JSON.stringify({ v: 1, phase: "probe", last_action: "init", iteration_n: 0 })}::jsonb,
            ${1})
  `;
}

describe.skipIf(sql === null)("webhook-reactor fanOut", () => {
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

  it("synchronize from the bot itself does NOT terminate: updates target_head_sha and early-wakes", async () => {
    const { insertIntent } = await import("../../../src/db/queries/ship");
    const { fanOut, TICKLE_KEY } = await import("../../../src/workflows/ship/webhook-reactor");
    const intent = await insertIntent(baseInsert(), requireConn());
    await persistContinuationFor(intent.id);
    const valkey = buildValkeyStub();

    await fanOut(
      {
        type: "pull_request.synchronize",
        installation_id: 12345,
        owner: "chrisleekr",
        repo: "github-app-playground",
        pr_number: 8001,
        head_sha: "c".repeat(40),
        head_author_login: BOT_LOGIN,
      },
      { sql: requireConn(), valkey: valkey.stub, botAppLogin: BOT_LOGIN },
    );

    const after = await requireConn()`SELECT * FROM ship_intents WHERE id = ${intent.id}`;
    expect((after[0] as { status: string }).status).toBe("active");
    expect((after[0] as { target_head_sha: string }).target_head_sha).toBe("c".repeat(40));
    expect(valkey.send).toHaveBeenCalledWith("ZADD", [TICKLE_KEY, "0", intent.id]);
  });

  it("synchronize from a non-bot (foreign push) → terminal human_took_over + manual-push-detected (FR-010)", async () => {
    const { insertIntent } = await import("../../../src/db/queries/ship");
    const { fanOut } = await import("../../../src/workflows/ship/webhook-reactor");
    const intent = await insertIntent(baseInsert(), requireConn());
    const valkey = buildValkeyStub();

    await fanOut(
      {
        type: "pull_request.synchronize",
        installation_id: 12345,
        owner: "chrisleekr",
        repo: "github-app-playground",
        pr_number: 8001,
        head_sha: "d".repeat(40),
        head_author_login: "intruder",
      },
      { sql: requireConn(), valkey: valkey.stub, botAppLogin: BOT_LOGIN },
    );

    const after = await requireConn()`SELECT * FROM ship_intents WHERE id = ${intent.id}`;
    expect((after[0] as { status: string }).status).toBe("human_took_over");
    expect((after[0] as { terminal_blocker_category: string }).terminal_blocker_category).toBe(
      "manual-push-detected",
    );
  });

  it("pull_request.closed merged=true → terminal merged_externally", async () => {
    const { insertIntent } = await import("../../../src/db/queries/ship");
    const { fanOut } = await import("../../../src/workflows/ship/webhook-reactor");
    const intent = await insertIntent(baseInsert(), requireConn());

    await fanOut(
      {
        type: "pull_request.closed",
        installation_id: 12345,
        owner: "chrisleekr",
        repo: "github-app-playground",
        pr_number: 8001,
        merged: true,
      },
      { sql: requireConn(), valkey: null, botAppLogin: BOT_LOGIN },
    );

    const after = await requireConn()`SELECT status FROM ship_intents WHERE id = ${intent.id}`;
    expect((after[0] as { status: string }).status).toBe("merged_externally");
  });

  it("pull_request.closed merged=false → terminal pr_closed", async () => {
    const { insertIntent } = await import("../../../src/db/queries/ship");
    const { fanOut } = await import("../../../src/workflows/ship/webhook-reactor");
    const intent = await insertIntent(baseInsert(), requireConn());

    await fanOut(
      {
        type: "pull_request.closed",
        installation_id: 12345,
        owner: "chrisleekr",
        repo: "github-app-playground",
        pr_number: 8001,
        merged: false,
      },
      { sql: requireConn(), valkey: null, botAppLogin: BOT_LOGIN },
    );

    const after = await requireConn()`SELECT status FROM ship_intents WHERE id = ${intent.id}`;
    expect((after[0] as { status: string }).status).toBe("pr_closed");
  });

  it("review submitted → early-wake on active; no-op on paused", async () => {
    const { insertIntent } = await import("../../../src/db/queries/ship");
    const { fanOut, TICKLE_KEY } = await import("../../../src/workflows/ship/webhook-reactor");
    const intent = await insertIntent(baseInsert(), requireConn());
    await persistContinuationFor(intent.id);

    const valkey = buildValkeyStub();
    await fanOut(
      {
        type: "pull_request_review.submitted",
        installation_id: 12345,
        owner: "chrisleekr",
        repo: "github-app-playground",
        pr_number: 8001,
      },
      { sql: requireConn(), valkey: valkey.stub, botAppLogin: BOT_LOGIN },
    );
    expect(valkey.send).toHaveBeenCalledWith("ZADD", [TICKLE_KEY, "0", intent.id]);

    // Now pause the intent and confirm the next event is a no-op.
    await requireConn()`UPDATE ship_intents SET status = 'paused' WHERE id = ${intent.id}`;
    const valkey2 = buildValkeyStub();
    await fanOut(
      {
        type: "pull_request_review.submitted",
        installation_id: 12345,
        owner: "chrisleekr",
        repo: "github-app-playground",
        pr_number: 8001,
      },
      { sql: requireConn(), valkey: valkey2.stub, botAppLogin: BOT_LOGIN },
    );
    expect(valkey2.send).not.toHaveBeenCalled();
  });

  it("review_comment created → early-wake (active intent)", async () => {
    const { insertIntent } = await import("../../../src/db/queries/ship");
    const { fanOut, TICKLE_KEY } = await import("../../../src/workflows/ship/webhook-reactor");
    const intent = await insertIntent(baseInsert(), requireConn());
    await persistContinuationFor(intent.id);
    const valkey = buildValkeyStub();
    await fanOut(
      {
        type: "pull_request_review_comment",
        installation_id: 12345,
        owner: "chrisleekr",
        repo: "github-app-playground",
        pr_number: 8001,
      },
      { sql: requireConn(), valkey: valkey.stub, botAppLogin: BOT_LOGIN },
    );
    expect(valkey.send).toHaveBeenCalledWith("ZADD", [TICKLE_KEY, "0", intent.id]);
  });

  it("check_run.completed matching one PR → early-wake the matching intent only", async () => {
    const { insertIntent } = await import("../../../src/db/queries/ship");
    const { fanOut, TICKLE_KEY } = await import("../../../src/workflows/ship/webhook-reactor");
    const matched = await insertIntent(baseInsert({ pr_number: 8002 }), requireConn());
    const unmatched = await insertIntent(baseInsert({ pr_number: 8003 }), requireConn());
    await persistContinuationFor(matched.id);
    await persistContinuationFor(unmatched.id);

    const valkey = buildValkeyStub();
    await fanOut(
      {
        type: "check_run.completed",
        installation_id: 12345,
        owner: "chrisleekr",
        repo: "github-app-playground",
        pr_numbers: [8002],
      },
      { sql: requireConn(), valkey: valkey.stub, botAppLogin: BOT_LOGIN },
    );
    expect(valkey.send).toHaveBeenCalledWith("ZADD", [TICKLE_KEY, "0", matched.id]);
    const calls = valkey.send.mock.calls;
    const sentForUnmatched = calls.some((c) => (c[1] as readonly string[])[2] === unmatched.id);
    expect(sentForUnmatched).toBe(false);
  });

  it("check_run.completed for a PR with NO active intent is a silent no-op", async () => {
    const { fanOut } = await import("../../../src/workflows/ship/webhook-reactor");
    const valkey = buildValkeyStub();
    await fanOut(
      {
        type: "check_run.completed",
        installation_id: 12345,
        owner: "chrisleekr",
        repo: "github-app-playground",
        pr_numbers: [9999],
      },
      { sql: requireConn(), valkey: valkey.stub, botAppLogin: BOT_LOGIN },
    );
    expect(valkey.send).not.toHaveBeenCalled();
  });

  it("check_suite.completed reporting two PRs early-wakes both matching intents", async () => {
    const { insertIntent } = await import("../../../src/db/queries/ship");
    const { fanOut, TICKLE_KEY } = await import("../../../src/workflows/ship/webhook-reactor");
    const a = await insertIntent(baseInsert({ pr_number: 9001 }), requireConn());
    const b = await insertIntent(baseInsert({ pr_number: 9002 }), requireConn());
    await persistContinuationFor(a.id);
    await persistContinuationFor(b.id);
    const valkey = buildValkeyStub();
    await fanOut(
      {
        type: "check_suite.completed",
        installation_id: 12345,
        owner: "chrisleekr",
        repo: "github-app-playground",
        pr_numbers: [9001, 9002],
      },
      { sql: requireConn(), valkey: valkey.stub, botAppLogin: BOT_LOGIN },
    );
    expect(valkey.send).toHaveBeenCalledWith("ZADD", [TICKLE_KEY, "0", a.id]);
    expect(valkey.send).toHaveBeenCalledWith("ZADD", [TICKLE_KEY, "0", b.id]);
  });

  it("duplicate delivery (same event twice) is idempotent: no extra terminal transitions", async () => {
    const { insertIntent } = await import("../../../src/db/queries/ship");
    const { fanOut } = await import("../../../src/workflows/ship/webhook-reactor");
    const intent = await insertIntent(baseInsert(), requireConn());

    const event = {
      type: "pull_request.closed" as const,
      installation_id: 12345,
      owner: "chrisleekr",
      repo: "github-app-playground",
      pr_number: 8001,
      merged: true,
    };
    await fanOut(event, { sql: requireConn(), valkey: null, botAppLogin: BOT_LOGIN });
    await fanOut(event, { sql: requireConn(), valkey: null, botAppLogin: BOT_LOGIN });

    const after = await requireConn()`SELECT status FROM ship_intents WHERE id = ${intent.id}`;
    expect((after[0] as { status: string }).status).toBe("merged_externally");
  });

  it("an intent already in a terminal state silently skips fan-out (no exception)", async () => {
    const { insertIntent } = await import("../../../src/db/queries/ship");
    const { fanOut } = await import("../../../src/workflows/ship/webhook-reactor");
    const intent = await insertIntent(baseInsert(), requireConn());
    await requireConn()`UPDATE ship_intents SET status = 'aborted_by_user', terminated_at = now(), terminal_blocker_category = 'stopped-by-user' WHERE id = ${intent.id}`;
    const valkey = buildValkeyStub();
    // The reactor's findIntentsForPr filters to status IN ('active','paused')
    // so terminal intents are silently skipped, fanOut returns without error.
    await fanOut(
      {
        type: "pull_request_review.submitted",
        installation_id: 12345,
        owner: "chrisleekr",
        repo: "github-app-playground",
        pr_number: 8001,
      },
      { sql: requireConn(), valkey: valkey.stub, botAppLogin: BOT_LOGIN },
    );
    expect(valkey.send).not.toHaveBeenCalled();
  });
});
