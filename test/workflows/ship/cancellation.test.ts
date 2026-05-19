/**
 * T056: cancellation-token discipline. Verifies that mutating ship-workflow
 * functions consult `checkpointCancelled(intent_id)` and bail when set,
 * with no further side effects.
 *
 * Real Postgres + mocked Valkey (in-memory map).
 */

import { SQL } from "bun";
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";

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

// In-memory Valkey: arms a single key that the cancel-flag check reads.
const valkeyState = new Map<string, string>();

void mock.module("../../../src/db", () => ({
  requireDb: () => requireSql(),
  getDb: () => requireSql(),
  closeDb: () => Promise.resolve(),
}));

const valkeyClient = {
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
    if (cmd === "LPUSH" || cmd === "LMOVE" || cmd === "LREM") return Promise.resolve(1);
    return Promise.resolve(null);
  },
};

void mock.module("../../../src/orchestrator/valkey", () => ({
  getValkeyClient: () => valkeyClient,
  requireValkeyClient: () => valkeyClient,
  isValkeyHealthy: () => true,
  closeValkey: () => {},
}));

const { runShipFromCommand } = await import("../../../src/workflows/ship/session-runner");
const { requestAbort, checkpointCancelled, CANCEL_TTL_SECONDS } =
  await import("../../../src/workflows/ship/abort");

const command: CanonicalCommand = {
  intent: "ship",
  surface: "literal",
  principal_login: "alice",
  pr: { owner: "acme", repo: "repo", number: 501, installation_id: 99 },
};

const eligibleResponse = {
  repository: {
    pullRequest: {
      state: "OPEN",
      merged: false,
      baseRefName: "main",
      baseRepository: { id: "repo-1" },
      headRepository: { id: "repo-1" },
      author: { login: "alice" },
    },
  },
};

const probeResponse = {
  repository: {
    pullRequest: {
      number: 501,
      isDraft: true,
      state: "OPEN",
      merged: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      baseRefName: "main",
      baseRefOid: "base-sha",
      headRefName: "feat",
      headRefOid: "head-sha",
      author: { login: "alice" },
      reviewThreads: { totalCount: 0, nodes: [] },
      commits: {
        nodes: [
          {
            commit: {
              oid: "head-sha",
              committedDate: new Date().toISOString(),
              author: { user: { login: "chrisleekr-bot[bot]" }, email: "bot@example.com" },
              statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [] } },
            },
          },
        ],
      },
      reviews: { nodes: [] },
    },
  },
};

interface OctokitCalls {
  graphqlCalls: { query: string }[];
  createCommentCalls: unknown[];
  updateCommentCalls: unknown[];
}

function buildOctokit(): { octokit: Octokit; calls: OctokitCalls } {
  const calls: OctokitCalls = {
    graphqlCalls: [],
    createCommentCalls: [],
    updateCommentCalls: [],
  };
  const graphql = (query: string): Promise<unknown> => {
    calls.graphqlCalls.push({ query });
    if (query.includes("query Eligibility")) return Promise.resolve(eligibleResponse);
    if (query.includes("query MergeReadinessProbe")) return Promise.resolve(probeResponse);
    if (query.includes("query GetPrId")) {
      return Promise.resolve({ repository: { pullRequest: { id: "PR_id" } } });
    }
    if (query.includes("mutation MarkReady")) {
      return Promise.resolve({
        markPullRequestReadyForReview: { pullRequest: { id: "PR_id", isDraft: false } },
      });
    }
    return Promise.reject(new Error(`unmocked: ${query.slice(0, 30)}`));
  };
  const octokit = {
    graphql,
    rest: {
      issues: {
        createComment: (p: unknown) => {
          calls.createCommentCalls.push(p);
          return Promise.resolve({ data: { id: 99 } });
        },
        updateComment: (p: unknown) => {
          calls.updateCommentCalls.push(p);
          return Promise.resolve({ data: {} });
        },
      },
    },
  } as unknown as Octokit;
  return { octokit, calls };
}

describe.skipIf(sql === null)("cancellation-token discipline (T056)", () => {
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

  afterAll(async () => {
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

  it("CANCEL_TTL_SECONDS is the documented 1-hour value", () => {
    expect(CANCEL_TTL_SECONDS).toBe(3600);
  });

  it("checkpointCancelled returns false when no flag is set", async () => {
    expect(await checkpointCancelled("00000000-0000-0000-0000-000000000000")).toBe(false);
  });

  it("checkpointCancelled returns true after requestAbort", async () => {
    const valkey = (await import("../../../src/orchestrator/valkey")).getValkeyClient();
    if (valkey === null) throw new Error("mock valkey missing");
    await requestAbort("11111111-1111-1111-1111-111111111111", valkey);
    expect(await checkpointCancelled("11111111-1111-1111-1111-111111111111")).toBe(true);
  });

  it("session bails before markReady mutation when cancel flag set after createIntent", async () => {
    const { octokit, calls } = buildOctokit();

    // Pre-arm the cancel flag for the intent the run is about to create.
    // The session-runner creates the intent then checks the flag, we
    // simulate the abort racing the run by setting the flag for the
    // PR's slot. We don't know the intent id ahead of time, so instead
    // we set a global "all PRs cancelled" by listening on the createIntent
    // call: easier is to seed AFTER createIntent completes. Use a different
    // approach: kick off a 2-step test where we set the flag, then run.
    // To keep it deterministic, we patch checkpointCancelled itself via
    // mock.module already-done up top by setting the in-memory key.
    // We approximate by forcing every key cancelled on first GET by using
    // a wildcard sentinel.

    // Set cancel flag for any future intent id by intercepting the first
    // createComment call (which happens BEFORE markReady), at that point
    // the intent id exists in the DB, we can read it and set the flag,
    // then the next checkpoint (before markReady) will hit it.
    const originalCreate = octokit.rest.issues.createComment.bind(octokit.rest.issues);
    octokit.rest.issues.createComment = (async (params: unknown) => {
      // Before tracking comment creation, set cancel flag for ALL active intents.
      const rows: { id: string }[] =
        await requireSql()`SELECT id FROM ship_intents WHERE status = 'active'`;
      for (const r of rows) valkeyState.set(`ship:cancel:${r.id}`, "1");
      return originalCreate(params as never);
    }) as typeof octokit.rest.issues.createComment;

    await runShipFromCommand({ command, octokit });

    // markReady GraphQL must NOT have fired.
    const markReady = calls.graphqlCalls.find((c) => c.query.includes("mutation MarkReady"));
    expect(markReady).toBeUndefined();

    // Intent stays active (NOT terminal), the bail is a no-side-effect return.
    const rows: { status: string }[] = await requireSql()`
      SELECT status FROM ship_intents WHERE owner='acme' AND repo='repo' AND pr_number=501
    `;
    expect(rows[0]?.status).toBe("active");
  });
});
