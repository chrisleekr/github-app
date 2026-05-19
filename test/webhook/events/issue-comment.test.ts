/**
 * Integration test for `issue_comment` → `dispatchByIntent` (T036).
 *
 * Proves FR-008: a free-form comment with a clear `ship` intent dispatches
 * through `dispatchByIntent` and produces a `workflow_runs` row whose shape
 * is indistinguishable from the row created by the label trigger
 * `dispatchByLabel("bot:ship")`. This is the contract the registry depends
 * on: downstream consumers (orchestrator, tracking-mirror) must not care
 * which trigger produced the run.
 *
 * Strategy:
 *   1. Stub the LLM with a canned ship-intent verdict.
 *   2. Mock the label-mutex + refusal-comment surfaces (they touch GitHub).
 *   3. Point `requireDb()` at the local integration database.
 *   4. Run `dispatchByLabel("bot:ship")` on issue #401.
 *   5. Run `dispatchByIntent(<ship comment>)` on issue #402.
 *   6. Compare the two resulting rows field-by-field (excluding the per-row
 *      fields that MUST differ: `id`, `target_number`, `delivery_id`,
 *      timestamps).
 */

import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";
import type pino from "pino";

// Warm the registry first to avoid the ship-handler TDZ circular import
// (see notes in test/workflows/handlers/ship.test.ts).
await import("../../../src/workflows/registry");

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

// ─── Mocks ───────────────────────────────────────────────────────────────

const mockEnqueueJob = mock(() => Promise.resolve());
void mock.module("../../../src/orchestrator/job-queue", () => ({
  enqueueJob: mockEnqueueJob,
  isScopedJob: () => false,
  SCOPED_JOB_KINDS: ["scoped-rebase", "scoped-fix-thread", "scoped-open-pr"],
}));

const mockEnforceSingleBotLabel = mock(() => Promise.resolve({ kept: "bot:ship", removed: [] }));
void mock.module("../../../src/workflows/label-mutex", () => ({
  enforceSingleBotLabel: mockEnforceSingleBotLabel,
}));

const mockPostRefusalComment = mock(() => Promise.resolve());
const mockSetState = mock(() => Promise.resolve());
void mock.module("../../../src/workflows/tracking-mirror", () => ({
  postRefusalComment: mockPostRefusalComment,
  setState: mockSetState,
}));

// Stub the intent classifier with a perfect ship verdict for the comment
// body used in the test.
const mockClassify = mock((body: string) => {
  if (body.toLowerCase().includes("ship")) {
    return Promise.resolve({
      workflow: "ship" as const,
      confidence: 0.97,
      rationale: "user explicitly asked to ship",
    });
  }
  return Promise.resolve({
    workflow: "clarify" as const,
    confidence: 0,
    rationale: "no match",
  });
});
void mock.module("../../../src/workflows/intent-classifier", () => ({
  classify: mockClassify,
  IntentWorkflowSchema: {},
  ClassifyResultSchema: {},
}));

void mock.module("../../../src/db", () => ({
  requireDb: () => requireSql(),
  getDb: () => requireSql(),
  closeDb: () => Promise.resolve(),
}));

function silentLogger(): pino.Logger {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    child: mock(function (this: unknown) {
      return this;
    }),
  } as unknown as pino.Logger;
}

const fakeOctokit = {
  rest: {
    issues: {
      createComment: mock(() => Promise.resolve({ data: { id: 1 } })),
    },
  },
} as unknown as Octokit;

describe.skipIf(sql === null)("issue-comment → dispatchByIntent integration (T036)", () => {
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

  it("produces a workflow_runs row indistinguishable from the label path", async () => {
    const { dispatchByLabel, dispatchByIntent } = await import("../../../src/workflows/dispatcher");
    const { findById } = await import("../../../src/workflows/runs-store");

    const labelOutcome = await dispatchByLabel({
      octokit: fakeOctokit,
      logger: silentLogger(),
      label: "bot:ship",
      target: { type: "issue", owner: "acme", repo: "repo", number: 401 },
      senderLogin: "acme",
      deliveryId: "delivery-label-401",
    });
    expect(labelOutcome.status).toBe("dispatched");
    if (labelOutcome.status !== "dispatched") throw new Error("expected dispatched");
    const labelRow = await findById(labelOutcome.runId, requireSql());
    expect(labelRow).not.toBeNull();

    const intentOutcome = await dispatchByIntent({
      octokit: fakeOctokit,
      logger: silentLogger(),
      commentBody: "@chrisleekr-bot ship this end-to-end, please.",
      target: { type: "issue", owner: "acme", repo: "repo", number: 402 },
      senderLogin: "acme",
      deliveryId: "delivery-intent-402",
      triggerCommentId: 555_402,
      triggerEventType: "issue_comment",
    });
    expect(intentOutcome.status).toBe("dispatched");
    if (intentOutcome.status !== "dispatched") throw new Error("expected dispatched");
    const intentRow = await findById(intentOutcome.runId, requireSql());
    expect(intentRow).not.toBeNull();

    // Shape-equivalence: fields that MUST be identical between the two
    // dispatch paths.
    if (labelRow === null || intentRow === null) throw new Error("rows must exist");
    expect(intentRow.workflow_name).toBe(labelRow.workflow_name);
    expect(intentRow.workflow_name).toBe("ship");
    expect(intentRow.target_type).toBe(labelRow.target_type);
    expect(intentRow.target_owner).toBe(labelRow.target_owner);
    expect(intentRow.target_repo).toBe(labelRow.target_repo);
    expect(intentRow.parent_run_id).toBe(labelRow.parent_run_id);
    expect(intentRow.parent_step_index).toBe(labelRow.parent_step_index);
    expect(intentRow.status).toBe(labelRow.status);
    expect(intentRow.status).toBe("queued");
    expect(intentRow.tracking_comment_id).toBe(labelRow.tracking_comment_id);
    expect(Object.keys(intentRow.state)).toEqual(Object.keys(labelRow.state));

    // Both dispatches enqueued exactly one job each.
    expect(mockEnqueueJob).toHaveBeenCalledTimes(2);
    const labelCall = mockEnqueueJob.mock.calls[0]?.[0] as
      | { workflowRun: { workflowName: string }; repoOwner: string; entityNumber: number }
      | undefined;
    const intentCall = mockEnqueueJob.mock.calls[1]?.[0] as
      | { workflowRun: { workflowName: string }; repoOwner: string; entityNumber: number }
      | undefined;
    expect(labelCall?.workflowRun.workflowName).toBe("ship");
    expect(intentCall?.workflowRun.workflowName).toBe("ship");

    // The intent path must have consulted the classifier exactly once.
    expect(mockClassify).toHaveBeenCalledTimes(1);
  });

  it("low-confidence intent comment does NOT create a workflow_runs row", async () => {
    const { dispatchByIntent } = await import("../../../src/workflows/dispatcher");

    mockEnqueueJob.mockClear();
    mockClassify.mockClear();

    const outcome = await dispatchByIntent({
      octokit: fakeOctokit,
      logger: silentLogger(),
      commentBody: "@chrisleekr-bot hey",
      target: { type: "issue", owner: "acme", repo: "repo", number: 403 },
      senderLogin: "acme",
      deliveryId: "delivery-intent-403",
      triggerCommentId: 555_403,
      triggerEventType: "issue_comment",
    });
    expect(outcome.status).toBe("ignored");
    expect(mockEnqueueJob).not.toHaveBeenCalled();

    const rows =
      (await requireSql()`SELECT * FROM workflow_runs WHERE target_number = ${403}`) as unknown as {
        length: number;
      };
    expect(rows.length).toBe(0);
  });
});
