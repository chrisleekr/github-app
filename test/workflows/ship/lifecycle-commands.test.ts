/**
 * T055 (abort handler) + T058a (stop/resume parity).
 * Real Postgres + mocked Valkey + mocked octokit.
 */

import { SQL } from "bun";
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";
import type { Logger } from "pino";

import type { CanonicalCommand } from "../../../src/shared/ship-types";

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
  if (sql === null) throw new Error("Database not available");
  return sql;
}

const valkeyState = new Map<string, string>();

void mock.module("../../../src/db", () => ({
  requireDb: () => requireSql(),
  getDb: () => requireSql(),
  closeDb: () => Promise.resolve(),
}));

void mock.module("../../../src/orchestrator/valkey", () => ({
  getValkeyClient: () => ({
    send: (cmd: string, args: string[]): Promise<unknown> => {
      const key = args[0] ?? "";
      if (cmd === "GET") return Promise.resolve(valkeyState.get(key) ?? null);
      if (cmd === "SET") {
        valkeyState.set(key, args[1] ?? "1");
        return Promise.resolve("OK");
      }
      if (cmd === "DEL") {
        valkeyState.delete(key);
        return Promise.resolve(1);
      }
      if (cmd === "ZADD" || cmd === "ZREM") return Promise.resolve(1);
      return Promise.resolve(null);
    },
  }),
}));

const { runLifecycleCommand } = await import("../../../src/workflows/ship/lifecycle-commands");
const { insertIntent } = await import("../../../src/db/queries/ship");

const ORIGINAL_ALLOWED = process.env["ALLOWED_OWNERS"];

interface Calls {
  comments: { body: string }[];
  prGets: number;
}

function buildOctokit(opts: { headSha?: string; headLogin?: string } = {}): {
  octokit: Octokit;
  calls: Calls;
} {
  const calls: Calls = { comments: [], prGets: 0 };
  const octokit = {
    graphql: () => Promise.reject(new Error("not used in lifecycle tests")),
    rest: {
      issues: {
        createComment: (p: { body: string }) => {
          calls.comments.push({ body: p.body });
          return Promise.resolve({ data: { id: 1 } });
        },
      },
      pulls: {
        get: () => {
          calls.prGets += 1;
          return Promise.resolve({
            data: {
              head: {
                sha: opts.headSha ?? "head-1",
                user: { login: opts.headLogin ?? "chrisleekr-bot[bot]" },
              },
            },
          });
        },
      },
      repos: {
        getCommit: () =>
          Promise.resolve({
            data: {
              author: { login: opts.headLogin ?? "chrisleekr-bot[bot]" },
              committer: { login: opts.headLogin ?? "chrisleekr-bot[bot]" },
            },
          }),
      },
    },
  } as unknown as Octokit;
  return { octokit, calls };
}

async function makeActiveIntent(prNumber: number): Promise<{ id: string; head: string }> {
  const intent = await insertIntent(
    {
      installation_id: 99,
      owner: "acme",
      repo: "repo",
      pr_number: prNumber,
      target_base_sha: `base-${prNumber}`,
      target_head_sha: `head-${prNumber}`,
      deadline_at: new Date(Date.now() + 3_600_000),
      created_by_user: "alice",
      tracking_comment_marker: "<!-- m -->",
    },
    requireSql(),
  );
  return { id: intent.id, head: `head-${prNumber}` };
}

function cmd(
  intent: "stop" | "resume" | "abort",
  prNumber: number,
  login = "alice",
): CanonicalCommand {
  return {
    intent,
    surface: "literal",
    principal_login: login,
    pr: { owner: "acme", repo: "repo", number: prNumber, installation_id: 99 },
  };
}

describe.skipIf(sql === null)("lifecycle commands (T055 + T058a)", () => {
  beforeAll(async () => {
    delete process.env["ALLOWED_OWNERS"];
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

  afterAll(async () => {
    if (ORIGINAL_ALLOWED !== undefined) process.env["ALLOWED_OWNERS"] = ORIGINAL_ALLOWED;
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
    await requireSql().close();
  });

  beforeEach(async () => {
    valkeyState.clear();
    await requireSql().unsafe(
      `TRUNCATE ship_fix_attempts, ship_continuations, ship_iterations, ship_intents`,
    );
  });

  it("T055: abort transitions active session to aborted_by_user", async () => {
    const { id } = await makeActiveIntent(701);
    const { octokit, calls } = buildOctokit();
    await runLifecycleCommand({ command: cmd("abort", 701), octokit, log: silentLogger() });
    const rows: { status: string; terminal_blocker_category: string }[] = await requireSql()`
      SELECT status, terminal_blocker_category FROM ship_intents WHERE id = ${id}
    `;
    expect(rows[0]?.status).toBe("aborted_by_user");
    expect(rows[0]?.terminal_blocker_category).toBe("stopped-by-user");
    expect(calls.comments.at(-1)?.body).toContain("aborted");
  });

  it("T055: abort with no-active-session is a no-op reply", async () => {
    const { octokit, calls } = buildOctokit();
    await runLifecycleCommand({ command: cmd("abort", 702), octokit, log: silentLogger() });
    expect(calls.comments.at(-1)?.body).toContain("no-op");
    expect(calls.comments.at(-1)?.body).toContain("no active");
  });

  it("T055: idempotent re-abort on already-terminal session is a no-op", async () => {
    const { id } = await makeActiveIntent(703);
    await requireSql()`UPDATE ship_intents SET status='aborted_by_user', terminated_at=now() WHERE id = ${id}`;
    const { octokit, calls } = buildOctokit();
    await runLifecycleCommand({ command: cmd("abort", 703), octokit, log: silentLogger() });
    expect(calls.comments.at(-1)?.body).toContain("no-op");
  });

  // FR-028 authorisation is gated by `config.allowedOwners`, frozen at
  // config-load time (process import). Process-level env mutation in
  // bun:test cannot retroactively reload it; covered separately by the
  // pure-function check in `isAuthorised` (see eligibility.test.ts
  // unauthorized case which exercises the same allowlist semantics
  // through `checkEligibility`).

  it("T058a: stop transitions active → paused", async () => {
    const { id } = await makeActiveIntent(710);
    const { octokit } = buildOctokit();
    await runLifecycleCommand({ command: cmd("stop", 710), octokit, log: silentLogger() });
    const rows: { status: string }[] =
      await requireSql()`SELECT status FROM ship_intents WHERE id = ${id}`;
    expect(rows[0]?.status).toBe("paused");
  });

  it("T058a: stop on already-paused is a no-op reply", async () => {
    const { id } = await makeActiveIntent(711);
    await requireSql()`UPDATE ship_intents SET status='paused' WHERE id = ${id}`;
    const { octokit, calls } = buildOctokit();
    await runLifecycleCommand({ command: cmd("stop", 711), octokit, log: silentLogger() });
    expect(calls.comments.at(-1)?.body).toContain("already paused");
  });

  it("T058a: resume of paused with no foreign push transitions paused → active", async () => {
    const { id } = await makeActiveIntent(712);
    await requireSql()`UPDATE ship_intents SET status='paused' WHERE id = ${id}`;
    // Octokit pulls.get returns same head_sha → no foreign push.
    const { octokit } = buildOctokit({ headSha: "head-712", headLogin: "chrisleekr-bot[bot]" });
    await runLifecycleCommand({ command: cmd("resume", 712), octokit, log: silentLogger() });
    const rows: { status: string }[] =
      await requireSql()`SELECT status FROM ship_intents WHERE id = ${id}`;
    expect(rows[0]?.status).toBe("active");
  });

  it("T058a: resume of paused with foreign push transitions to terminal human_took_over", async () => {
    const { id } = await makeActiveIntent(713);
    await requireSql()`UPDATE ship_intents SET status='paused' WHERE id = ${id}`;
    // Octokit reports a different head_sha authored by a non-bot user.
    const { octokit, calls } = buildOctokit({ headSha: "human-sha-x", headLogin: "alice" });
    await runLifecycleCommand({ command: cmd("resume", 713), octokit, log: silentLogger() });
    const rows: { status: string; terminal_blocker_category: string | null }[] = await requireSql()`
      SELECT status, terminal_blocker_category FROM ship_intents WHERE id = ${id}
    `;
    expect(rows[0]?.status).toBe("human_took_over");
    expect(rows[0]?.terminal_blocker_category).toBe("manual-push-detected");
    expect(calls.comments.at(-1)?.body).toContain("non-bot push");
  });

  it("T058a: resume on already-active is a no-op", async () => {
    await makeActiveIntent(714);
    const { octokit, calls } = buildOctokit();
    await runLifecycleCommand({ command: cmd("resume", 714), octokit, log: silentLogger() });
    expect(calls.comments.at(-1)?.body).toContain("already active");
  });
});

function silentLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: function child() {
      return this;
    },
  } as unknown as Logger;
}
