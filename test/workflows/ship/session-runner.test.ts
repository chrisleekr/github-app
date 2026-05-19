/**
 * Tests for `runShipFromCommand` (T028 v2 entry).
 *
 * Verifies the three control-flow gates that protect ship_intents writes
 * and the FR-019 ready-for-review terminal action. Real DB; mocked
 * octokit per Constitution V.
 */

import { SQL } from "bun";
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";

import { config } from "../../../src/config";
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
  if (sql === null) throw new Error("Database not available, test should have been skipped");
  return sql;
}

void mock.module("../../../src/db", () => ({
  requireDb: () => requireSql(),
  getDb: () => requireSql(),
  closeDb: () => Promise.resolve(),
}));

// Iteration-0 reroute (issue #119) hands `human_took_over` triggers to
// chat-thread instead of creating intent state. Stub the helper so the
// session-runner tests can verify the reroute call without spinning up
// the chat-thread executor (which itself imports comment caches, the
// LLM client, the github-state tool registry, etc.).
const rerouteCalls: { intent: string; comment_body?: string; trigger_comment_id?: number }[] = [];
void mock.module("../../../src/workflows/ship/scoped/dispatch-scoped", () => ({
  runChatThreadFromCommand: (command: {
    intent: string;
    comment_body?: string;
    trigger_comment_id?: number;
  }) => {
    rerouteCalls.push({
      intent: command.intent,
      ...(command.comment_body !== undefined ? { comment_body: command.comment_body } : {}),
      ...(command.trigger_comment_id !== undefined
        ? { trigger_comment_id: command.trigger_comment_id }
        : {}),
    });
    return Promise.resolve();
  },
}));

const { runShipFromCommand } = await import("../../../src/workflows/ship/session-runner");

interface OctokitCalls {
  graphqlCalls: { query: string; vars: unknown }[];
  createCommentCalls: unknown[];
  updateCommentCalls: unknown[];
}

interface BuildOctokitInput {
  readonly eligibilityResponse?: unknown;
  readonly probeResponse?: unknown;
  readonly prIdResponse?: unknown;
  readonly markReadyResponse?: unknown;
  readonly throwOnGraphql?: string;
  /**
   * Pre-existing comments returned by the listComments paginator.
   * Used to test the iteration-0 reroute marker-based dedup path.
   */
  readonly existingComments?: readonly { body: string }[];
}

function buildOctokit(input: BuildOctokitInput): { octokit: Octokit; calls: OctokitCalls } {
  const calls: OctokitCalls = {
    graphqlCalls: [],
    createCommentCalls: [],
    updateCommentCalls: [],
  };

  const graphql = (query: string, vars: unknown): Promise<unknown> => {
    calls.graphqlCalls.push({ query, vars });
    if (input.throwOnGraphql !== undefined && query.includes(input.throwOnGraphql)) {
      return Promise.reject(new Error("forced graphql failure"));
    }
    if (query.includes("query Eligibility")) {
      return Promise.resolve(input.eligibilityResponse);
    }
    if (query.includes("query MergeReadinessProbe")) {
      return Promise.resolve(input.probeResponse);
    }
    if (query.includes("query GetPrId")) {
      return Promise.resolve(input.prIdResponse);
    }
    if (query.includes("mutation MarkReady")) {
      return Promise.resolve(input.markReadyResponse);
    }
    return Promise.reject(new Error(`unmocked graphql: ${query.slice(0, 50)}`));
  };

  const existingComments = input.existingComments ?? [];
  // Async iterator returning a single page with the configured comments.
  // Mirrors octokit.paginate.iterator's `{ data: [...] }` page shape.
  const paginateIterator = (): AsyncIterableIterator<{
    data: readonly { body: string }[];
  }> => {
    let yielded = false;
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        if (yielded) return Promise.resolve({ value: undefined, done: true } as const);
        yielded = true;
        return Promise.resolve({
          value: { data: existingComments },
          done: false,
        } as const);
      },
    } as unknown as AsyncIterableIterator<{ data: readonly { body: string }[] }>;
  };

  const octokit = {
    graphql,
    paginate: { iterator: paginateIterator },
    rest: {
      issues: {
        createComment: (params: unknown) => {
          calls.createCommentCalls.push(params);
          return Promise.resolve({ data: { id: 12345 } });
        },
        updateComment: (params: unknown) => {
          calls.updateCommentCalls.push(params);
          return Promise.resolve({ data: {} });
        },
        listComments: () => Promise.resolve({ data: existingComments }),
      },
    },
  } as unknown as Octokit;

  return { octokit, calls };
}

const baseCommand: CanonicalCommand = {
  intent: "ship",
  surface: "literal",
  principal_login: "alice",
  pr: { owner: "acme", repo: "repo", number: 401, installation_id: 99 },
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

const ineligibleClosedResponse = {
  repository: {
    pullRequest: {
      state: "CLOSED",
      merged: false,
      baseRefName: "main",
      baseRepository: { id: "repo-1" },
      headRepository: { id: "repo-1" },
      author: { login: "alice" },
    },
  },
};

function buildProbeResponse(opts: {
  readonly ready: boolean;
  readonly isDraft: boolean;
  readonly headSha?: string;
  readonly baseSha?: string;
  readonly mergeable?: "MERGEABLE" | "CONFLICTING";
  readonly headAuthorLogin?: string;
}): unknown {
  const headSha = opts.headSha ?? "sha-head";
  const baseSha = opts.baseSha ?? "sha-base";
  // Verdict priority 1 (foreign-push detection) inspects the head
  // commit's author login. Default to the bot so non-ready fixtures
  // reach the merge-state ladder (verdict=behind_base) instead of
  // tripping the iteration-0 reroute (issue #119) which short-circuits
  // intent creation. Tests exercising the reroute pass a non-bot login
  // explicitly.
  const headAuthorLogin = opts.headAuthorLogin ?? config.botAppLogin;
  return {
    repository: {
      pullRequest: {
        number: 401,
        isDraft: opts.isDraft,
        state: "OPEN",
        merged: false,
        mergeable: opts.mergeable ?? "MERGEABLE",
        mergeStateStatus: opts.ready ? "CLEAN" : "BEHIND",
        reviewDecision: opts.ready ? "APPROVED" : "REVIEW_REQUIRED",
        baseRefName: "main",
        baseRefOid: baseSha,
        headRefName: "feat/x",
        headRefOid: headSha,
        author: { login: "alice" },
        reviewThreads: { totalCount: 0, nodes: [] },
        commits: {
          nodes: [
            {
              commit: {
                oid: headSha,
                committedDate: new Date().toISOString(),
                author: {
                  user: { login: headAuthorLogin },
                  email: `${headAuthorLogin}@example.com`,
                },
                statusCheckRollup: opts.ready
                  ? { state: "SUCCESS", contexts: { nodes: [] } }
                  : { state: "PENDING", contexts: { nodes: [] } },
              },
            },
          ],
        },
        reviews: { nodes: [] },
      },
    },
  };
}

describe.skipIf(sql === null)("runShipFromCommand", () => {
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
    await requireSql().unsafe(
      `TRUNCATE ship_fix_attempts, ship_continuations, ship_iterations, ship_intents`,
    );
  });

  it("(b) ineligible PR (closed): no intent row, posts refusal comment", async () => {
    const { octokit, calls } = buildOctokit({ eligibilityResponse: ineligibleClosedResponse });
    await runShipFromCommand({ command: baseCommand, octokit });
    const rows: { count: bigint }[] =
      await requireSql()`SELECT COUNT(*)::bigint AS count FROM ship_intents`;
    expect(Number(rows[0]?.count ?? 0n)).toBe(0);
    expect(calls.createCommentCalls.length).toBe(1);
    const body = (calls.createCommentCalls[0] as { body: string }).body;
    expect(body).toContain("declined");
    expect(body).toContain("closed");
  });

  it("(c) re-trigger when an active session exists: no second row, posts already-in-progress reply", async () => {
    // First run: probe returns non-ready so the intent stays active.
    const first = buildOctokit({
      eligibilityResponse: eligibleResponse,
      probeResponse: buildProbeResponse({ ready: false, isDraft: false }),
    });
    await runShipFromCommand({ command: baseCommand, octokit: first.octokit });

    // Second run: same PR, must reject.
    const second = buildOctokit({
      eligibilityResponse: eligibleResponse,
      probeResponse: buildProbeResponse({ ready: false, isDraft: false }),
    });
    await runShipFromCommand({ command: baseCommand, octokit: second.octokit });

    const rows: { count: bigint }[] = await requireSql()`
      SELECT COUNT(*)::bigint AS count FROM ship_intents
       WHERE owner='acme' AND repo='repo' AND pr_number=401 AND status='active'
    `;
    expect(Number(rows[0]?.count ?? 0n)).toBe(1);
    const lastReply = second.calls.createCommentCalls.at(-1) as { body: string } | undefined;
    expect(lastReply?.body).toContain("already in progress");
  });

  it("(e) verdict=ready terminal: marks ready-for-review on draft, transitions to ready_awaiting_human_merge", async () => {
    const { octokit, calls } = buildOctokit({
      eligibilityResponse: eligibleResponse,
      probeResponse: buildProbeResponse({ ready: true, isDraft: true }),
      prIdResponse: { repository: { pullRequest: { id: "PR_node_1" } } },
      markReadyResponse: {
        markPullRequestReadyForReview: { pullRequest: { id: "PR_node_1", isDraft: false } },
      },
    });

    await runShipFromCommand({ command: baseCommand, octokit });

    const rows: { status: string; terminal_blocker_category: string | null }[] = await requireSql()`
      SELECT status, terminal_blocker_category
        FROM ship_intents
       WHERE owner='acme' AND repo='repo' AND pr_number=401
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("ready_awaiting_human_merge");
    expect(rows[0]?.terminal_blocker_category).toBeNull();

    const markReady = calls.graphqlCalls.find((c) => c.query.includes("mutation MarkReady"));
    expect(markReady).toBeDefined();

    expect(calls.updateCommentCalls.length).toBe(1);
    const updated = calls.updateCommentCalls[0] as { body: string };
    expect(updated.body).toContain("ready_awaiting_human_merge");
  });

  it("(e) verdict=ready on non-draft PR: skips markReadyForReview, still transitions terminal", async () => {
    const { octokit, calls } = buildOctokit({
      eligibilityResponse: eligibleResponse,
      probeResponse: buildProbeResponse({ ready: true, isDraft: false }),
      prIdResponse: { repository: { pullRequest: { id: "PR_node_2" } } },
    });

    await runShipFromCommand({ command: baseCommand, octokit });

    const rows: { status: string }[] = await requireSql()`
      SELECT status FROM ship_intents WHERE owner='acme' AND repo='repo' AND pr_number=401
    `;
    expect(rows[0]?.status).toBe("ready_awaiting_human_merge");
    const markReady = calls.graphqlCalls.find((c) => c.query.includes("mutation MarkReady"));
    expect(markReady).toBeUndefined();
  });

  it("(e) markReadyForReview failure does NOT block transition: terminal still set, error surfaced in tracking comment", async () => {
    const { octokit, calls } = buildOctokit({
      eligibilityResponse: eligibleResponse,
      probeResponse: buildProbeResponse({ ready: true, isDraft: true }),
      prIdResponse: { repository: { pullRequest: { id: "PR_node_3" } } },
      throwOnGraphql: "mutation MarkReady",
    });

    await runShipFromCommand({ command: baseCommand, octokit });

    const rows: { status: string }[] = await requireSql()`
      SELECT status FROM ship_intents WHERE owner='acme' AND repo='repo' AND pr_number=401
    `;
    expect(rows[0]?.status).toBe("ready_awaiting_human_merge");
    const updated = calls.updateCommentCalls[0] as { body: string };
    expect(updated.body).toContain("markReadyForReview failed");
  });

  it("(#119) human_took_over with comment body: reroutes to chat-thread, no intent row, no tracking comment", async () => {
    rerouteCalls.length = 0;
    const { octokit, calls } = buildOctokit({
      eligibilityResponse: eligibleResponse,
      probeResponse: buildProbeResponse({
        ready: false,
        isDraft: false,
        headAuthorLogin: "alice",
      }),
    });

    const nlCommand: CanonicalCommand = {
      ...baseCommand,
      surface: "nl",
      event_surface: "pr-comment",
      comment_body: "@chrisleekr-bot can you make this PR merge ready?",
      trigger_comment_id: 99001,
    };

    await runShipFromCommand({ command: nlCommand, octokit });

    const rows: { count: bigint }[] =
      await requireSql()`SELECT COUNT(*)::bigint AS count FROM ship_intents`;
    expect(Number(rows[0]?.count ?? 0n)).toBe(0);
    expect(calls.createCommentCalls.length).toBe(0);
    expect(calls.updateCommentCalls.length).toBe(0);
    expect(rerouteCalls.length).toBe(1);
    expect(rerouteCalls[0]?.intent).toBe("ship");
    expect(rerouteCalls[0]?.comment_body).toBe(nlCommand.comment_body);
    expect(rerouteCalls[0]?.trigger_comment_id).toBe(99001);
  });

  it("(#119) human_took_over from label trigger: posts prose refusal, no intent row, no chat-thread reroute", async () => {
    rerouteCalls.length = 0;
    const { octokit, calls } = buildOctokit({
      eligibilityResponse: eligibleResponse,
      probeResponse: buildProbeResponse({
        ready: false,
        isDraft: false,
        headAuthorLogin: "alice",
      }),
    });

    // Label trigger, no comment_body, no trigger_comment_id.
    const labelCommand: CanonicalCommand = {
      ...baseCommand,
      surface: "label",
      event_surface: "pr-label",
    };

    await runShipFromCommand({ command: labelCommand, octokit });

    const rows: { count: bigint }[] =
      await requireSql()`SELECT COUNT(*)::bigint AS count FROM ship_intents`;
    expect(Number(rows[0]?.count ?? 0n)).toBe(0);
    expect(rerouteCalls.length).toBe(0);
    expect(calls.createCommentCalls.length).toBe(1);
    const refusal = calls.createCommentCalls[0] as { body: string };
    expect(refusal.body).toContain("can't take over");
    expect(refusal.body).toContain("alice");
  });

  it("(#119) human_took_over from label trigger: re-fire with prior refusal marker is a no-op", async () => {
    rerouteCalls.length = 0;
    const labelCommand: CanonicalCommand = {
      ...baseCommand,
      surface: "label",
      event_surface: "pr-label",
    };

    // First fire, no existing comments; refusal posted with marker.
    const first = buildOctokit({
      eligibilityResponse: eligibleResponse,
      probeResponse: buildProbeResponse({
        ready: false,
        isDraft: false,
        headAuthorLogin: "alice",
      }),
    });
    await runShipFromCommand({ command: labelCommand, octokit: first.octokit });
    expect(first.calls.createCommentCalls.length).toBe(1);
    const firstBody = (first.calls.createCommentCalls[0] as { body: string }).body;
    expect(firstBody).toContain(`<!-- ship-reroute-refusal:acme/repo#401:human_took_over -->`);

    // Second fire, surface the prior refusal as an existing comment so
    // the dedup helper sees the marker and skips. No new write.
    const second = buildOctokit({
      eligibilityResponse: eligibleResponse,
      probeResponse: buildProbeResponse({
        ready: false,
        isDraft: false,
        headAuthorLogin: "alice",
      }),
      existingComments: [{ body: firstBody }],
    });
    await runShipFromCommand({ command: labelCommand, octokit: second.octokit });
    expect(second.calls.createCommentCalls.length).toBe(0);
    expect(rerouteCalls.length).toBe(0);
  });
});
