/**
 * Integration tests for the composite-workflow hand-off orchestrator (T025, T026).
 *
 * Covers the `contracts/handoff-protocol.md` per-step cascade:
 *   - Success chain: parent + child 0 succeed → child 1 enqueued → … → on
 *     child-4 (resolve) success, parent flips to `succeeded` with the full
 *     `state.stepRuns` ordering.
 *   - Failure cascade: child-2 (implement) fails → parent flips to `failed`
 *     with `state.failedAtStepIndex=2` → no child 3 is enqueued.
 *
 * The test owns a real Postgres connection (Bun's `SQL`) because the
 * orchestrator's cascade logic lives entirely inside `db.begin()` and the
 * `SELECT … FOR UPDATE` lock cannot be meaningfully faked. Downstream
 * surfaces that escape the transaction (`job-queue`, `tracking-mirror`) are
 * mocked so the assertions stay deterministic and do not hit Valkey/GitHub.
 */

import { SQL } from "bun";
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type pino from "pino";

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

// ─── Mocked downstream surfaces ──────────────────────────────────────────

const mockEnqueueJob = mock(() => Promise.resolve());
void mock.module("../../src/orchestrator/job-queue", () => ({
  enqueueJob: mockEnqueueJob,
  isScopedJob: () => false,
  SCOPED_JOB_KINDS: ["scoped-rebase", "scoped-fix-thread", "scoped-open-pr"],
}));

void mock.module("../../src/workflows/execution-row", () => ({
  recordWorkflowExecution: mock(() => Promise.resolve()),
  buildWorkflowContextJson: mock(() => ({})),
}));

void mock.module("../../src/orchestrator/concurrency", () => ({
  incrementActiveCount: mock(() => {}),
  decrementActiveCount: mock(() => {}),
}));

const mockSetState = mock(() => Promise.resolve());
void mock.module("../../src/workflows/tracking-mirror", () => ({
  setState: mockSetState,
  postRefusalComment: mock(() => Promise.resolve()),
}));

// Point requireDb() at our test SQL so the orchestrator's `db.begin()`
// runs against the integration database rather than opening a new pool
// from config.databaseUrl.
void mock.module("../../src/db", () => ({
  requireDb: () => requireSql(),
  getDb: () => requireSql(),
  closeDb: () => Promise.resolve(),
}));

// Stand-in for the Valkey client used by the ship-intent early-wake hook.
// Records ZADD calls so the cascade test can assert exactly one tickle
// per completed run that carries `state.shipIntentId`.
const mockValkeySend = mock((_cmd: string, _args: string[]) => Promise.resolve(1));
const mockValkeyClient = { send: mockValkeySend };
void mock.module("../../src/orchestrator/valkey", () => ({
  requireValkeyClient: () => mockValkeyClient,
  getValkeyClient: () => mockValkeyClient,
  isValkeyHealthy: () => true,
  connectValkey: () => Promise.resolve(),
  closeValkey: () => Promise.resolve(),
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

const target = { type: "issue" as const, owner: "acme", repo: "repo", number: 200 };

describe.skipIf(sql === null)("orchestrator.onStepComplete", () => {
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
    const { runMigrations } = await import("../../src/db/migrate");
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

  beforeEach(() => {
    mockEnqueueJob.mockClear();
    mockSetState.mockClear();
    mockValkeySend.mockClear();
  });

  it("T025 success chain: each child success enqueues the next, final child flips parent to succeeded", async () => {
    const { insertQueued, findById, markRunning, markSucceeded } =
      await import("../../src/workflows/runs-store");
    const { onStepComplete } = await import("../../src/workflows/orchestrator");

    const issueNumber = 201;
    const shipTarget = { ...target, number: issueNumber };

    // Seed: parent ship + first child (triage@0). The executor flips the
    // parent to `running` before invoking the ship handler, replicate
    // that here so status expectations match production behaviour.
    const parent = await insertQueued(
      {
        workflowName: "ship",
        target: shipTarget,
        initialState: { currentStepIndex: 0, stepRuns: [] },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );
    await markRunning(parent.id, "test-daemon", requireSql());
    const child0 = await insertQueued(
      {
        workflowName: "triage",
        target: shipTarget,
        parentRunId: parent.id,
        parentStepIndex: 0,
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );

    // ── child 0 (triage) succeeds ────────────────────────────────────────
    // Simulate the executor's terminal write before the cascade runs, so
    // the orchestrator sees the child as already succeeded.
    await markSucceeded(child0.id, { verdict: "valid" }, requireSql());

    await onStepComplete({ octokit: {} as never, logger: silentLogger() }, child0.id, {
      status: "succeeded",
    });

    // Parent should now reference the new plan child at index 1.
    let parentRow = await findById(parent.id, requireSql());
    expect(parentRow?.status).toBe("running");
    expect(parentRow?.state["currentStepIndex"]).toBe(1);
    expect(parentRow?.state["stepRuns"]).toEqual([child0.id]);

    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
    const call0 = mockEnqueueJob.mock.calls[0]?.[0] as
      | { workflowRun: { workflowName: string; parentStepIndex: number; runId: string } }
      | undefined;
    expect(call0?.workflowRun.workflowName).toBe("plan");
    expect(call0?.workflowRun.parentStepIndex).toBe(1);
    const child1RunId = call0?.workflowRun.runId ?? "";
    expect(child1RunId).not.toBe("");

    // ── child 1 (plan) succeeds ──────────────────────────────────────────
    await markSucceeded(child1RunId, { planWritten: true }, requireSql());
    await onStepComplete({ octokit: {} as never, logger: silentLogger() }, child1RunId, {
      status: "succeeded",
    });

    parentRow = await findById(parent.id, requireSql());
    expect(parentRow?.state["currentStepIndex"]).toBe(2);
    expect(parentRow?.state["stepRuns"]).toEqual([child0.id, child1RunId]);

    const call1 = mockEnqueueJob.mock.calls[1]?.[0] as
      | { workflowRun: { workflowName: string; parentStepIndex: number; runId: string } }
      | undefined;
    expect(call1?.workflowRun.workflowName).toBe("implement");
    expect(call1?.workflowRun.parentStepIndex).toBe(2);
    const child2RunId = call1?.workflowRun.runId ?? "";

    // ── child 2 (implement) succeeds ─────────────────────────────────────
    await markSucceeded(child2RunId, { pr_number: 42 }, requireSql());
    await onStepComplete({ octokit: {} as never, logger: silentLogger() }, child2RunId, {
      status: "succeeded",
    });

    parentRow = await findById(parent.id, requireSql());
    expect(parentRow?.state["currentStepIndex"]).toBe(3);

    const call2 = mockEnqueueJob.mock.calls[2]?.[0] as
      | { workflowRun: { workflowName: string; parentStepIndex: number; runId: string } }
      | undefined;
    expect(call2?.workflowRun.workflowName).toBe("review");
    expect(call2?.workflowRun.parentStepIndex).toBe(3);
    const child3RunId = call2?.workflowRun.runId ?? "";

    // ── child 3 (review-1) succeeds with findings → resolve-1 enqueued ──
    // Phase 1: review must run on the PR target (#42), not the issue.
    await markSucceeded(
      child3RunId,
      { findings: { blocker: 0, major: 1, minor: 0, nit: 0, total: 1 } },
      requireSql(),
    );
    await onStepComplete({ octokit: {} as never, logger: silentLogger() }, child3RunId, {
      status: "succeeded",
    });

    parentRow = await findById(parent.id, requireSql());
    expect(parentRow?.state["currentStepIndex"]).toBe(4);
    expect(parentRow?.state["review_iterations"]).toBe(1);
    expect(parentRow?.state["last_review_findings"]).toBe(1);
    expect(parentRow?.state["pr_number"]).toBe(42);

    const call3 = mockEnqueueJob.mock.calls[3]?.[0] as
      | {
          workflowRun: { workflowName: string; parentStepIndex: number; runId: string };
          isPR: boolean;
          entityNumber: number;
        }
      | undefined;
    expect(call3?.workflowRun.workflowName).toBe("resolve");
    expect(call3?.workflowRun.parentStepIndex).toBe(4);
    expect(call3?.isPR).toBe(true);
    expect(call3?.entityNumber).toBe(42);
    const child4RunId = call3?.workflowRun.runId ?? "";

    // ── child 4 (resolve-1) succeeds → loops back to review-2 ───────────
    // Phase 2c: review_iterations(1) < cap(2), so a new review child is
    // inserted at parent_step_index = ship.steps.indexOf("review") = 3.
    await markSucceeded(child4RunId, { approved: true }, requireSql());
    await onStepComplete({ octokit: {} as never, logger: silentLogger() }, child4RunId, {
      status: "succeeded",
    });

    parentRow = await findById(parent.id, requireSql());
    expect(parentRow?.status).toBe("running");
    expect(parentRow?.state["currentStepIndex"]).toBe(3);

    const call4 = mockEnqueueJob.mock.calls[4]?.[0] as
      | {
          workflowRun: { workflowName: string; parentStepIndex: number; runId: string };
          isPR: boolean;
          entityNumber: number;
        }
      | undefined;
    expect(call4?.workflowRun.workflowName).toBe("review");
    expect(call4?.workflowRun.parentStepIndex).toBe(3);
    expect(call4?.isPR).toBe(true);
    expect(call4?.entityNumber).toBe(42);
    const child5RunId = call4?.workflowRun.runId ?? "";

    // ── child 5 (review-2) succeeds with no findings → parent succeeded ─
    // Phase 2c: review_iterations(2) >= 2 AND total findings == 0, so the
    // loop short-circuits and the ship parent terminates as succeeded.
    await markSucceeded(
      child5RunId,
      { findings: { blocker: 0, major: 0, minor: 0, nit: 0, total: 0 } },
      requireSql(),
    );
    await onStepComplete({ octokit: {} as never, logger: silentLogger() }, child5RunId, {
      status: "succeeded",
    });

    parentRow = await findById(parent.id, requireSql());
    expect(parentRow?.status).toBe("succeeded");
    expect(parentRow?.state["review_iterations"]).toBe(2);
    expect(parentRow?.state["last_review_findings"]).toBe(0);
    expect(parentRow?.state["stepRuns"]).toEqual([
      child0.id,
      child1RunId,
      child2RunId,
      child3RunId,
      child4RunId,
      child5RunId,
    ]);

    // Enqueue count: plan, implement, review-1, resolve-1, review-2 = 5.
    expect(mockEnqueueJob).toHaveBeenCalledTimes(5);
    expect(mockSetState).toHaveBeenCalled();
  });

  it("T026 failure cascade: child-2 failure flips parent to failed with failedAtStepIndex=2, no further children", async () => {
    const { insertQueued, findById, markRunning, markSucceeded, markFailed, listChildrenByParent } =
      await import("../../src/workflows/runs-store");
    const { onStepComplete } = await import("../../src/workflows/orchestrator");

    const issueNumber = 202;
    const shipTarget = { ...target, number: issueNumber };

    // Seed parent + first child, then walk two successful step completions
    // so the cascade naturally reaches step index 2.
    const parent = await insertQueued(
      {
        workflowName: "ship",
        target: shipTarget,
        initialState: { currentStepIndex: 0, stepRuns: [] },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );
    await markRunning(parent.id, "test-daemon", requireSql());
    const child0 = await insertQueued(
      {
        workflowName: "triage",
        target: shipTarget,
        parentRunId: parent.id,
        parentStepIndex: 0,
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );

    await markSucceeded(child0.id, { verdict: "valid" }, requireSql());
    await onStepComplete({ octokit: {} as never, logger: silentLogger() }, child0.id, {
      status: "succeeded",
    });

    const child1Enqueue = mockEnqueueJob.mock.calls[0]?.[0] as
      | { workflowRun: { runId: string } }
      | undefined;
    const child1RunId = child1Enqueue?.workflowRun.runId ?? "";
    await markSucceeded(child1RunId, {}, requireSql());
    await onStepComplete({ octokit: {} as never, logger: silentLogger() }, child1RunId, {
      status: "succeeded",
    });

    const child2Enqueue = mockEnqueueJob.mock.calls[1]?.[0] as
      | { workflowRun: { runId: string; workflowName: string; parentStepIndex: number } }
      | undefined;
    expect(child2Enqueue?.workflowRun.workflowName).toBe("implement");
    const child2RunId = child2Enqueue?.workflowRun.runId ?? "";

    mockEnqueueJob.mockClear();

    // ── child 2 (implement) FAILS ────────────────────────────────────────
    await markFailed(child2RunId, "merge conflict", {}, requireSql());
    await onStepComplete({ octokit: {} as never, logger: silentLogger() }, child2RunId, {
      status: "failed",
      reason: "merge conflict",
    });

    const parentRow = await findById(parent.id, requireSql());
    expect(parentRow?.status).toBe("failed");
    expect(parentRow?.state["failedAtStepIndex"]).toBe(2);
    expect(parentRow?.state["failedReason"]).toBe("merge conflict");

    // No new child row was inserted after the failure.
    const children = await listChildrenByParent(parent.id, requireSql());
    expect(children.map((c) => c.parent_step_index)).toEqual([0, 1, 2]);
    expect(mockEnqueueJob).not.toHaveBeenCalled();

    // Terminal tracking emit fired for the parent's failed transition.
    expect(mockSetState).toHaveBeenCalled();
  });

  it("T027 cascade retargeting: missing pr_number on implement → review fails the parent with a clear reason", async () => {
    const { insertQueued, findById, markRunning, markSucceeded } =
      await import("../../src/workflows/runs-store");
    const { onStepComplete } = await import("../../src/workflows/orchestrator");

    const issueNumber = 203;
    const shipTarget = { ...target, number: issueNumber };
    const parent = await insertQueued(
      {
        workflowName: "ship",
        target: shipTarget,
        initialState: { currentStepIndex: 2, stepRuns: [] },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );
    await markRunning(parent.id, "test-daemon", requireSql());

    // Seed an implement child as if the prior cascade reached it. Implement
    // forgets to write pr_number to its state, simulates a regressed
    // handler. Orchestrator must NOT silently inherit issue → review.
    const implementChild = await insertQueued(
      {
        workflowName: "implement",
        target: shipTarget,
        parentRunId: parent.id,
        parentStepIndex: 2,
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );
    await markSucceeded(implementChild.id, { branch: "feature/foo" }, requireSql());

    await onStepComplete({ octokit: {} as never, logger: silentLogger() }, implementChild.id, {
      status: "succeeded",
    });

    const parentRow = await findById(parent.id, requireSql());
    expect(parentRow?.status).toBe("failed");
    expect(parentRow?.state["failedAtStepIndex"]).toBe(3);
    expect(String(parentRow?.state["failedReason"])).toContain("pr_number");
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it("T028 cap reached: review-2 still has findings → resolve-2 runs → parent succeeds with manual-re-review warning", async () => {
    const { insertQueued, findById, markRunning, markSucceeded } =
      await import("../../src/workflows/runs-store");
    const { onStepComplete } = await import("../../src/workflows/orchestrator");

    const issueNumber = 204;
    const shipTarget = { ...target, number: issueNumber };
    const parent = await insertQueued(
      {
        workflowName: "ship",
        target: shipTarget,
        initialState: {
          currentStepIndex: 4,
          stepRuns: [],
          pr_number: 88,
          review_iterations: 1,
          last_review_findings: 2,
        },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );
    await markRunning(parent.id, "test-daemon", requireSql());

    // Resolve-1 just succeeded; this triggers loop back to review-2.
    const resolve1 = await insertQueued(
      {
        workflowName: "resolve",
        target: { ...shipTarget, type: "pr", number: 88 },
        parentRunId: parent.id,
        parentStepIndex: 4,
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );
    await markSucceeded(resolve1.id, {}, requireSql());

    await onStepComplete({ octokit: {} as never, logger: silentLogger() }, resolve1.id, {
      status: "succeeded",
    });

    // Loop-back inserted a review child at step index 3.
    const loopBackCall = mockEnqueueJob.mock.calls.at(-1)?.[0] as
      | { workflowRun: { workflowName: string; parentStepIndex: number; runId: string } }
      | undefined;
    expect(loopBackCall?.workflowRun.workflowName).toBe("review");
    expect(loopBackCall?.workflowRun.parentStepIndex).toBe(3);
    const review2Id = loopBackCall?.workflowRun.runId ?? "";

    // Review-2 still finds blocker issues (cap-reached scenario).
    await markSucceeded(
      review2Id,
      { findings: { blocker: 1, major: 1, minor: 0, nit: 0, total: 2 } },
      requireSql(),
    );
    await onStepComplete({ octokit: {} as never, logger: silentLogger() }, review2Id, {
      status: "succeeded",
    });

    // review_iterations is now 2 (== cap), so the next resolve must run
    // (cascade as normal), and after THAT, the cap-reached branch fires.
    const resolve2Call = mockEnqueueJob.mock.calls.at(-1)?.[0] as
      | { workflowRun: { workflowName: string; runId: string } }
      | undefined;
    expect(resolve2Call?.workflowRun.workflowName).toBe("resolve");
    const resolve2Id = resolve2Call?.workflowRun.runId ?? "";

    await markSucceeded(resolve2Id, {}, requireSql());
    await onStepComplete({ octokit: {} as never, logger: silentLogger() }, resolve2Id, {
      status: "succeeded",
    });

    const parentRow = await findById(parent.id, requireSql());
    expect(parentRow?.status).toBe("succeeded");
    expect(parentRow?.state["review_iterations"]).toBe(2);
    expect(parentRow?.state["last_review_findings"]).toBe(2);

    // setState was called with the manual-re-review warning message.
    const lastSetStateCall = mockSetState.mock.calls.at(-1) as
      | [unknown, { humanMessage?: string } | undefined]
      | undefined;
    const humanMessage = lastSetStateCall?.[1]?.humanMessage ?? "";
    expect(humanMessage).toContain("review-2");
    expect(humanMessage).toContain("Manual re-review recommended");
  });

  // ─── Ship-iteration early-wake (T009) ─────────────────────────────────
  it("ZADDs ship:tickle when a completed workflow_run carries state.shipIntentId and the intent is non-terminal", async () => {
    const { insertQueued, markSucceeded } = await import("../../src/workflows/runs-store");
    const { onStepComplete } = await import("../../src/workflows/orchestrator");
    const { insertIntent } = await import("../../src/db/queries/ship");

    const intent = await insertIntent(
      {
        installation_id: 100,
        owner: "acme",
        repo: "tickle-repo",
        pr_number: 9001,
        target_base_sha: "base-sha",
        target_head_sha: "head-sha",
        deadline_at: new Date(Date.now() + 60 * 60 * 1000),
        created_by_user: "tester",
        tracking_comment_marker: "<!-- ship-intent: pending -->",
      },
      requireSql(),
    );

    const run = await insertQueued(
      {
        workflowName: "implement",
        target: { type: "pr", owner: "acme", repo: "tickle-repo", number: 9001 },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );
    await markSucceeded(run.id, { shipIntentId: intent.id }, requireSql());

    await onStepComplete({ octokit: {} as never, logger: silentLogger() }, run.id, {
      status: "succeeded",
    });

    const zaddCalls = mockValkeySend.mock.calls.filter((c) => c[0] === "ZADD");
    expect(zaddCalls).toHaveLength(1);
    expect(zaddCalls[0]?.[1]).toEqual(["ship:tickle", "0", intent.id]);
  });

  it("does not ZADD ship:tickle when the workflow_run state has no shipIntentId", async () => {
    const { insertQueued, markSucceeded } = await import("../../src/workflows/runs-store");
    const { onStepComplete } = await import("../../src/workflows/orchestrator");

    const run = await insertQueued(
      {
        workflowName: "implement",
        target: { type: "pr", owner: "acme", repo: "no-intent", number: 9100 },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );
    await markSucceeded(run.id, { unrelated: true }, requireSql());

    await onStepComplete({ octokit: {} as never, logger: silentLogger() }, run.id, {
      status: "succeeded",
    });

    const zaddCalls = mockValkeySend.mock.calls.filter((c) => c[0] === "ZADD");
    expect(zaddCalls).toHaveLength(0);
  });

  it("does not ZADD ship:tickle when the intent is already terminal", async () => {
    const { insertQueued, markSucceeded } = await import("../../src/workflows/runs-store");
    const { onStepComplete } = await import("../../src/workflows/orchestrator");
    const { insertIntent, transitionIntent } = await import("../../src/db/queries/ship");

    const intent = await insertIntent(
      {
        installation_id: 101,
        owner: "acme",
        repo: "terminal-repo",
        pr_number: 9200,
        target_base_sha: "base",
        target_head_sha: "head",
        deadline_at: new Date(Date.now() + 60 * 60 * 1000),
        created_by_user: "tester",
        tracking_comment_marker: "<!-- ship-intent: pending -->",
      },
      requireSql(),
    );
    await transitionIntent(intent.id, "merged_externally", null, requireSql());

    const run = await insertQueued(
      {
        workflowName: "implement",
        target: { type: "pr", owner: "acme", repo: "terminal-repo", number: 9200 },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );
    await markSucceeded(run.id, { shipIntentId: intent.id }, requireSql());

    await onStepComplete({ octokit: {} as never, logger: silentLogger() }, run.id, {
      status: "succeeded",
    });

    const zaddCalls = mockValkeySend.mock.calls.filter((c) => c[0] === "ZADD");
    expect(zaddCalls).toHaveLength(0);
  });

  // H1: a failed child workflow_run must NOT trigger the cascade. Without
  // this guard a permanently broken intent would burn the iteration cap
  // re-firing on every failure.
  it("does not ZADD ship:tickle when the child workflow_run failed (H1)", async () => {
    const { insertQueued, markFailed } = await import("../../src/workflows/runs-store");
    const { onStepComplete } = await import("../../src/workflows/orchestrator");
    const { insertIntent } = await import("../../src/db/queries/ship");

    const intent = await insertIntent(
      {
        installation_id: 102,
        owner: "acme",
        repo: "failed-child-repo",
        pr_number: 9300,
        target_base_sha: "base",
        target_head_sha: "head",
        deadline_at: new Date(Date.now() + 60 * 60 * 1000),
        created_by_user: "tester",
        tracking_comment_marker: "<!-- ship-intent: pending -->",
      },
      requireSql(),
    );

    const run = await insertQueued(
      {
        workflowName: "implement",
        target: { type: "pr", owner: "acme", repo: "failed-child-repo", number: 9300 },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );
    await markFailed(run.id, "implement crashed", { shipIntentId: intent.id }, requireSql());

    mockValkeySend.mockClear();
    await onStepComplete({ octokit: {} as never, logger: silentLogger() }, run.id, {
      status: "failed",
      reason: "implement crashed",
    });

    const zaddCalls = mockValkeySend.mock.calls.filter(
      (c) => c[0] === "ZADD" && Array.isArray(c[1]) && c[1][0] === "ship:tickle",
    );
    expect(zaddCalls).toHaveLength(0);
  });

  // H2: a failed child whose state.failedReason matches the Anthropic
  // usage-limit signature must defer the next ship iteration to the
  // parsed reset boundary instead of stalling the intent. Guards the
  // wiring between extractFailedReason → detectTransientQuotaError →
  // ZADD with a future score.
  it("ZADDs ship:tickle at the parsed reset time when child failed with a quota error (H2)", async () => {
    const { insertQueued, markFailed } = await import("../../src/workflows/runs-store");
    const { onStepComplete } = await import("../../src/workflows/orchestrator");
    const { insertIntent } = await import("../../src/db/queries/ship");

    // Freeze the clock at 2026-05-02 10:00:00 UTC so the parsed
    // "resets 6pm (UTC)" boundary lands at a known instant
    // (2026-05-02 18:00:30 UTC). Asserting the exact score guards
    // against silent regression to the +1h fallback or any other
    // future-but-wrong timestamp.
    const frozenNowMs = Date.UTC(2026, 4, 2, 10, 0, 0);
    const expectedRetryAtMs = Date.UTC(2026, 4, 2, 18, 0, 30);
    const dateNowSpy = spyOn(Date, "now").mockReturnValue(frozenNowMs);
    try {
      const intent = await insertIntent(
        {
          installation_id: 103,
          owner: "acme",
          repo: "quota-defer-repo",
          pr_number: 9400,
          target_base_sha: "base",
          target_head_sha: "head",
          deadline_at: new Date(frozenNowMs + 60 * 60 * 1000),
          created_by_user: "tester",
          tracking_comment_marker: "<!-- ship-intent: pending -->",
        },
        requireSql(),
      );

      const run = await insertQueued(
        {
          workflowName: "implement",
          target: { type: "pr", owner: "acme", repo: "quota-defer-repo", number: 9400 },
          ownerKind: "orchestrator",
          ownerId: "test-orchestrator",
        },
        requireSql(),
      );
      const quotaReason =
        "Claude Code returned an error result: You've hit your limit · resets 6pm (UTC)";
      await markFailed(run.id, quotaReason, { shipIntentId: intent.id }, requireSql());

      mockValkeySend.mockClear();
      await onStepComplete({ octokit: {} as never, logger: silentLogger() }, run.id, {
        status: "failed",
        reason: quotaReason,
      });

      const zaddCalls = mockValkeySend.mock.calls.filter(
        (c) => c[0] === "ZADD" && Array.isArray(c[1]) && c[1][0] === "ship:tickle",
      );
      expect(zaddCalls).toHaveLength(1);
      const args = zaddCalls[0]?.[1] as [string, string, string];
      expect(args[0]).toBe("ship:tickle");
      expect(args[2]).toBe(intent.id);
      // Exact assertion: the parsed reset path must produce
      // 2026-05-02T18:00:30Z (== expectedRetryAtMs). A regression to the
      // +1h fallback (frozenNowMs + 3600_000) or any other future-ish
      // value would silently pass an "in the future" check.
      expect(Number(args[1])).toBe(expectedRetryAtMs);
    } finally {
      dateNowSpy.mockRestore();
    }
  });
});

describe("orchestrator helpers (pure)", () => {
  it("extractFailedReason reads state.failedReason set by markFailed", async () => {
    const { extractFailedReason } = await import("../../src/workflows/orchestrator");
    expect(extractFailedReason({ failedReason: "implement crashed" })).toBe("implement crashed");
    expect(extractFailedReason({ failedReason: "" })).toBeUndefined();
    expect(extractFailedReason({ other: "x" })).toBeUndefined();
    expect(extractFailedReason(null)).toBeUndefined();
    expect(extractFailedReason(undefined)).toBeUndefined();
    expect(extractFailedReason("not an object")).toBeUndefined();
  });

  it("detectTransientQuotaError returns null when reason is absent or unrelated", async () => {
    const { detectTransientQuotaError } = await import("../../src/workflows/orchestrator");
    expect(detectTransientQuotaError(undefined)).toBeNull();
    expect(detectTransientQuotaError("")).toBeNull();
    expect(detectTransientQuotaError("git clone failed: timeout")).toBeNull();
    expect(detectTransientQuotaError("review pipeline execution failed")).toBeNull();
  });

  // Regression guard for the tightened signature: a bare "rate limit"
  // or "usage limit" phrase without "hit your limit" AND without a
  // "resets ... UTC" clock must NOT auto-defer, it could be a GitHub
  // secondary rate limit or unrelated upstream throttling. Auto-deferring
  // those would burn the iteration cap re-firing on a non-recoverable
  // failure.
  it("detectTransientQuotaError returns null for bare 'rate limit'/'usage limit' without resets clock", async () => {
    const { detectTransientQuotaError } = await import("../../src/workflows/orchestrator");
    expect(detectTransientQuotaError("github secondary rate limit exceeded")).toBeNull();
    expect(detectTransientQuotaError("API usage limit reached for this hour")).toBeNull();
    expect(detectTransientQuotaError("upstream returned 429 rate-limit response")).toBeNull();
  });

  it("detectTransientQuotaError parses 'resets 6pm (UTC)' to today 18:00:30 UTC when in future", async () => {
    const { detectTransientQuotaError } = await import("../../src/workflows/orchestrator");
    // 2026-05-02T05:00:00Z → reset is later today at 18:00:30 UTC.
    const nowMs = Date.UTC(2026, 4, 2, 5, 0, 0);
    const result = detectTransientQuotaError(
      "Claude Code returned an error result: You've hit your limit · resets 6pm (UTC)",
      nowMs,
    );
    expect(result).not.toBeNull();
    expect(result!.retryAtMs).toBe(Date.UTC(2026, 4, 2, 18, 0, 30));
    expect(result!.resetPhrase).toMatch(/resets/i);
  });

  it("detectTransientQuotaError rolls reset to next day when boundary already passed", async () => {
    const { detectTransientQuotaError } = await import("../../src/workflows/orchestrator");
    // 2026-05-02T20:00:00Z is past 18:00 UTC, next reset is tomorrow.
    const nowMs = Date.UTC(2026, 4, 2, 20, 0, 0);
    const result = detectTransientQuotaError("You've hit your limit · resets 6pm UTC", nowMs);
    expect(result).not.toBeNull();
    expect(result!.retryAtMs).toBe(Date.UTC(2026, 4, 3, 18, 0, 30));
  });

  it("detectTransientQuotaError parses 24h '18:30 UTC' form", async () => {
    const { detectTransientQuotaError } = await import("../../src/workflows/orchestrator");
    const nowMs = Date.UTC(2026, 4, 2, 5, 0, 0);
    const result = detectTransientQuotaError("usage limit hit · resets 18:30 UTC", nowMs);
    expect(result).not.toBeNull();
    expect(result!.retryAtMs).toBe(Date.UTC(2026, 4, 2, 18, 30, 30));
  });

  it("detectTransientQuotaError falls back to +1h when reset clock is unparseable", async () => {
    const { detectTransientQuotaError } = await import("../../src/workflows/orchestrator");
    const nowMs = Date.UTC(2026, 4, 2, 5, 0, 0);
    const result = detectTransientQuotaError("You've hit your limit (no time mentioned)", nowMs);
    expect(result).not.toBeNull();
    expect(result!.retryAtMs).toBe(nowMs + 60 * 60 * 1000);
    expect(result!.resetPhrase).toBe("fallback_1h");
  });

  it("detectTransientQuotaError treats ambiguous 'resets 6 UTC' (no am/pm, no minute) as fallback, not 06:00", async () => {
    const { detectTransientQuotaError } = await import("../../src/workflows/orchestrator");
    // now = 14:00 UTC, "resets 6 UTC" without meridiem/minute is ambiguous.
    // Without the guard, parseResetsClock would interpret it as 06:00, see
    // it has already passed, and roll +24h → wake at next-day 06:00:30.
    // With the guard it falls through to the +1h fallback (15:00 UTC).
    const nowMs = Date.UTC(2026, 4, 2, 14, 0, 0);
    const result = detectTransientQuotaError("You've hit your limit · resets 6 UTC", nowMs);
    expect(result).not.toBeNull();
    expect(result!.retryAtMs).toBe(nowMs + 60 * 60 * 1000);
    expect(result!.resetPhrase).toBe("fallback_1h");
  });
});
