/**
 * Integration test for the mention rail's workflow dispatch (T036).
 *
 * Proves FR-008: a mention that classifies to a registry workflow produces a
 * `workflow_runs` row indistinguishable from the row the label trigger
 * `dispatchByLabel("bot:ship")` creates. This is the contract the registry
 * depends on: downstream consumers (orchestrator, tracking-mirror) must not
 * care which trigger produced the run.
 *
 * Both triggers now call the same `dispatchWorkflowByName`, so this test is
 * what keeps them from drifting apart again.
 *
 * Strategy:
 *   1. Mock the label-mutex + refusal-comment surfaces (they touch GitHub).
 *   2. Point `requireDb()` at the local integration database.
 *   3. Run `dispatchByLabel("bot:ship")` on issue #401.
 *   4. Run `dispatchWorkflowByName` with mention-shaped params on issue #402.
 *   5. Compare the two resulting rows field-by-field (excluding the per-row
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
  process.env["TEST_DATABASE_URL"] ?? "postgres://bot:bot@localhost:55432/github_app_test";

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

const mockEnsureWorkflowJobQueued = mock(() => Promise.resolve(true));
void mock.module("../../../src/orchestrator/job-queue", () => ({
  ensureWorkflowJobQueued: mockEnsureWorkflowJobQueued,
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

describe.skipIf(sql === null)("issue-comment → dispatchWorkflowByName integration (T036)", () => {
  beforeAll(async () => {
    await requireSql().unsafe(`
      DROP TABLE IF EXISTS _migrations CASCADE;
      DROP TABLE IF EXISTS workflow_attempt_commands CASCADE;
      DROP TABLE IF EXISTS review_learnings CASCADE;
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
      DROP TABLE IF EXISTS workflow_attempt_commands CASCADE;
      DROP TABLE IF EXISTS review_learnings CASCADE;
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
    const { dispatchByLabel, dispatchWorkflowByName } =
      await import("../../../src/workflows/dispatcher");
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

    const intentOutcome = await dispatchWorkflowByName({
      octokit: fakeOctokit,
      logger: silentLogger(),
      workflowName: "ship",
      target: { type: "issue", owner: "acme", repo: "repo", number: 402 },
      senderLogin: "acme",
      deliveryId: "delivery-intent-402",
      triggerCommentId: 555_402,
      triggerEventType: "issue_comment",
      triggerBodyPreview: "@chrisleekr-bot ship this end-to-end, please.",
      addRocketReaction: true,
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
    expect(mockEnsureWorkflowJobQueued).toHaveBeenCalledTimes(2);
    const labelCall = mockEnsureWorkflowJobQueued.mock.calls[0]?.[0] as
      | { workflowRun: { workflowName: string }; repoOwner: string; entityNumber: number }
      | undefined;
    const intentCall = mockEnsureWorkflowJobQueued.mock.calls[1]?.[0] as
      | { workflowRun: { workflowName: string }; repoOwner: string; entityNumber: number }
      | undefined;
    expect(labelCall?.workflowRun.workflowName).toBe("ship");
    expect(intentCall?.workflowRun.workflowName).toBe("ship");
  });
});
