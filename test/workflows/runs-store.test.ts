/**
 * Integration tests for workflow_runs persistence.
 *
 * Requires Postgres (bun run dev:deps). Skipped automatically when the
 * database is unreachable: matches the pattern in test/db/migrate.test.ts
 * so the suite does not fail on machines without local infra.
 */

import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { WorkflowName } from "../../src/workflows/registry";
import type { WorkflowRunRow } from "../../src/workflows/runs-store";
import { expectToReject } from "../utils/assertions";

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

async function markTestRunning(runId: string, daemonId: string, db: SQL): Promise<void> {
  await db`
    UPDATE workflow_runs
       SET status = 'running', owner_kind = 'daemon', owner_id = ${daemonId}
     WHERE id = ${runId} AND status = 'queued'
  `;
}

async function markTestSucceeded(
  runId: string,
  state: Record<string, unknown>,
  db: SQL,
): Promise<void> {
  await db`
    UPDATE workflow_runs
       SET status = 'succeeded', state = workflow_runs.state || ${state}::jsonb
     WHERE id = ${runId}
  `;
}

async function markTestFailed(
  runId: string,
  reason: string,
  state: Record<string, unknown>,
  db: SQL,
): Promise<void> {
  const merged = { ...state, failedReason: reason };
  await db`
    UPDATE workflow_runs
       SET status = 'failed', state = workflow_runs.state || ${merged}::jsonb
     WHERE id = ${runId}
  `;
}

async function claimTestAttempt(
  _store: object,
  row: {
    id: string;
    workflow_name: WorkflowName;
    execution_delivery_id: string | null;
  },
  input: { attemptId: string; daemonId: string; leaseMs: number; db?: SQL },
): Promise<WorkflowRunRow> {
  const db = input.db ?? requireSql();
  const executionDeliveryId = row.execution_delivery_id ?? crypto.randomUUID();
  if (row.execution_delivery_id === null) {
    await db`
      UPDATE workflow_runs
         SET execution_delivery_id = ${executionDeliveryId}
       WHERE id = ${row.id}
    `;
  }
  const rows: WorkflowRunRow[] = await db`
    UPDATE workflow_runs
       SET status = 'running',
           owner_kind = 'daemon',
           owner_id = ${input.daemonId},
           attempt_id = ${input.attemptId},
           lease_expires_at = now() + ${input.leaseMs} * interval '1 millisecond',
           attempt_deadline_at = now() + interval '70 minutes'
     WHERE id = ${row.id}
       AND workflow_name = ${row.workflow_name}
       AND execution_delivery_id = ${executionDeliveryId}
       AND status = 'queued'
    RETURNING *
  `;
  const claimed = rows[0];
  if (claimed === undefined) throw new Error("Expected workflow attempt fixture to be claimed");
  return claimed;
}

const target = { type: "issue" as const, owner: "acme", repo: "repo", number: 1 };

describe.skipIf(sql === null)("runs-store", () => {
  beforeAll(async () => {
    // Reset to a clean schema so test order is deterministic.
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
    const { runMigrations } = await import("../../src/db/migrate");
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

  it("insertQueued returns a row with the expected shape and defaults", async () => {
    const { insertQueued } = await import("../../src/workflows/runs-store");
    const row = await insertQueued(
      {
        workflowName: "triage",
        target: { ...target, number: 100 },
        deliveryId: "delivery-100",
        initialState: { seeded: true },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );

    expect(row.workflow_name).toBe("triage");
    expect(row.target_type).toBe("issue");
    expect(row.target_owner).toBe("acme");
    expect(row.target_repo).toBe("repo");
    expect(row.target_number).toBe(100);
    expect(row.parent_run_id).toBeNull();
    expect(row.parent_step_index).toBeNull();
    expect(row.status).toBe("queued");
    expect(row.state).toEqual({ seeded: true });
    expect(row.tracking_comment_id).toBeNull();
    expect(row.delivery_id).toBe("delivery-100");
    expect(row.trigger_body_preview).toBe("");
    expect(typeof row.id).toBe("string");
    expect(row.id.length).toBeGreaterThan(0);
  });

  it("mergeState updates state without changing status", async () => {
    const { insertQueued, mergeState, findById } = await import("../../src/workflows/runs-store");
    const row = await insertQueued(
      {
        workflowName: "triage",
        target: { ...target, number: 104 },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );

    await mergeState(row.id, { progress: 0.5 }, requireSql());
    const after = await findById(row.id, requireSql());
    expect(after?.status).toBe("queued");
    expect(after?.state).toEqual({ progress: 0.5 });
  });

  it("setTrackingCommentId records the GitHub comment id", async () => {
    const { insertQueued, setTrackingCommentId, findById } =
      await import("../../src/workflows/runs-store");
    const row = await insertQueued(
      {
        workflowName: "triage",
        target: { ...target, number: 105 },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );

    await setTrackingCommentId(row.id, 987654, requireSql());
    const after = await findById(row.id, requireSql());
    expect(after?.tracking_comment_id).toBe(987654);
  });

  it("findInflight returns row while queued/running and null once terminal", async () => {
    const { insertQueued, findInflight } = await import("../../src/workflows/runs-store");
    const t = { owner: "acme", repo: "repo", number: 106 };
    const row = await insertQueued(
      {
        workflowName: "plan",
        target: { ...target, number: 106 },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );

    const queuedHit = await findInflight("plan", t, requireSql());
    expect(queuedHit?.id).toBe(row.id);

    await markTestRunning(row.id, "test-daemon", requireSql());
    const runningHit = await findInflight("plan", t, requireSql());
    expect(runningHit?.id).toBe(row.id);

    await markTestSucceeded(row.id, {}, requireSql());
    const terminalMiss = await findInflight("plan", t, requireSql());
    expect(terminalMiss).toBeNull();
  });

  it("findLatestForTarget orders by created_at DESC", async () => {
    const { insertQueued, findLatestForTarget } = await import("../../src/workflows/runs-store");
    const t = { owner: "acme", repo: "repo", number: 107 };
    const first = await insertQueued(
      {
        workflowName: "triage",
        target: { ...target, number: 107 },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );
    await markTestSucceeded(first.id, {}, requireSql());

    // Ensure a distinct created_at tick, created_at defaults to now().
    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await insertQueued(
      {
        workflowName: "triage",
        target: { ...target, number: 107 },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );

    const latest = await findLatestForTarget("triage", t, requireSql());
    expect(latest?.id).toBe(second.id);
  });

  it("partial unique index rejects a second in-flight row for the same (workflow, target)", async () => {
    const { insertQueued } = await import("../../src/workflows/runs-store");
    await insertQueued(
      {
        workflowName: "triage",
        target: { ...target, number: 108 },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );

    await expectToReject(
      insertQueued({ workflowName: "triage", target: { ...target, number: 108 } }, requireSql()),
      "",
    );
  });

  it("allows a new queued row once the prior one is terminal", async () => {
    const { insertQueued } = await import("../../src/workflows/runs-store");
    const first = await insertQueued(
      {
        workflowName: "triage",
        target: { ...target, number: 109 },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );
    await markTestSucceeded(first.id, {}, requireSql());

    const second = await insertQueued(
      {
        workflowName: "triage",
        target: { ...target, number: 109 },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );
    expect(second.status).toBe("queued");
    expect(second.id).not.toBe(first.id);
  });

  it("listChildrenByParent returns children ordered by parent_step_index", async () => {
    const { insertQueued, listChildrenByParent } = await import("../../src/workflows/runs-store");
    const parent = await insertQueued(
      {
        workflowName: "ship",
        target: { ...target, number: 110 },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );

    // Insert children out of step order.
    await insertQueued(
      {
        workflowName: "plan",
        target: { ...target, number: 110 },
        parentRunId: parent.id,
        parentStepIndex: 1,
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );
    await insertQueued(
      {
        workflowName: "triage",
        target: { ...target, number: 110 },
        parentRunId: parent.id,
        parentStepIndex: 0,
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );

    const children = await listChildrenByParent(parent.id, requireSql());
    expect(children.map((c) => c.parent_step_index)).toEqual([0, 1]);
    expect(children.map((c) => c.workflow_name)).toEqual(["triage", "plan"]);
  });

  it("tryReserveTrackingCommentId: first caller wins the CAS; second caller observes the prior value", async () => {
    const { insertQueued, tryReserveTrackingCommentId } =
      await import("../../src/workflows/runs-store");
    const row = await insertQueued(
      {
        workflowName: "triage",
        target: { ...target, number: 115 },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );

    const first = await tryReserveTrackingCommentId(row.id, 11111, requireSql());
    expect(first).toEqual({ won: true, trackingCommentId: 11111 });

    // Second caller lost the race; observes the winning id.
    const second = await tryReserveTrackingCommentId(row.id, 22222, requireSql());
    expect(second).toEqual({ won: false, trackingCommentId: 11111 });
  });

  it("fences tracking-comment reservation by the exact live attempt", async () => {
    const store = await import("../../src/workflows/runs-store");
    const current = await store.insertQueued(
      {
        workflowName: "triage",
        target: { ...target, number: 1151 },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );
    const currentAttempt = { runId: current.id, attemptId: crypto.randomUUID() };
    await claimTestAttempt(store, current, {
      attemptId: currentAttempt.attemptId,
      daemonId: "daemon-current",
      leaseMs: 60_000,
    });
    expect(
      await store.tryReserveTrackingCommentId(current.id, 33333, currentAttempt, requireSql()),
    ).toEqual({ won: true, trackingCommentId: 33333 });

    const stale = await store.insertQueued(
      {
        workflowName: "triage",
        target: { ...target, number: 1152 },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );
    const staleAttempt = { runId: stale.id, attemptId: crypto.randomUUID() };
    await claimTestAttempt(store, stale, {
      attemptId: staleAttempt.attemptId,
      daemonId: "daemon-stale",
      leaseMs: 60_000,
    });
    await requireSql()`
      UPDATE workflow_runs
         SET lease_expires_at = now() - interval '1 second'
       WHERE id = ${stale.id}
    `;

    await expectToReject(
      store.tryReserveTrackingCommentId(stale.id, 44444, staleAttempt, requireSql()),
      "workflow attempt is no longer current",
    );
    expect((await store.findById(stale.id, requireSql()))?.tracking_comment_id).toBeNull();
    await requireSql()`DELETE FROM workflow_runs WHERE id IN ${requireSql()([current.id, stale.id])}`;
  });

  it("findLatestSucceededForTarget returns the most recent succeeded row, ignoring later failed rows", async () => {
    const { insertQueued, findLatestSucceededForTarget } =
      await import("../../src/workflows/runs-store");
    const t = { owner: "acme", repo: "repo", number: 116 };

    // First run: succeeded.
    const first = await insertQueued(
      {
        workflowName: "triage",
        target: { ...target, number: 116 },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );
    await markTestSucceeded(first.id, { verdict: "valid" }, requireSql());
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Second run: failed (must not shadow the earlier success).
    const second = await insertQueued(
      {
        workflowName: "triage",
        target: { ...target, number: 116 },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );
    await markTestFailed(second.id, "intermittent network error", {}, requireSql());

    const latestSucceeded = await findLatestSucceededForTarget("triage", t, requireSql());
    expect(latestSucceeded?.id).toBe(first.id);
  });

  it("findLatestSucceededForTarget returns null when no succeeded row exists", async () => {
    const { insertQueued, findLatestSucceededForTarget } =
      await import("../../src/workflows/runs-store");
    const t = { owner: "acme", repo: "repo", number: 117 };

    const row = await insertQueued(
      {
        workflowName: "resolve",
        target: { type: "pr", ...t },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );
    await markTestFailed(row.id, "no CI yet", {}, requireSql());

    const latest = await findLatestSucceededForTarget("resolve", t, requireSql());
    expect(latest).toBeNull();
  });

  it("renews only current, unexpired attempts owned by the runner", async () => {
    const store = await import("../../src/workflows/runs-store");
    const row = await store.insertQueued(
      {
        workflowName: "plan",
        target: { ...target, number: 119 },
        ownerKind: "orchestrator",
        ownerId: "orchestrator-a",
      },
      requireSql(),
    );
    const attemptId = crypto.randomUUID();
    const unknownAttemptId = crypto.randomUUID();
    await claimTestAttempt(store, row, {
      attemptId,
      daemonId: "daemon-a",
      leaseMs: 60_000,
    });

    const renewed = await store.renewWorkflowAttempts(
      "daemon-a",
      [attemptId, unknownAttemptId],
      120_000,
      requireSql(),
    );
    expect(renewed).toEqual({
      renewedAttemptIds: [attemptId],
      fencedAttemptIds: [unknownAttemptId],
    });
  });

  it("rejects stale progress and terminal writes without changing the row", async () => {
    const store = await import("../../src/workflows/runs-store");
    const row = await store.insertQueued(
      {
        workflowName: "implement",
        target: { ...target, number: 120 },
        ownerKind: "orchestrator",
        ownerId: "orchestrator-a",
      },
      requireSql(),
    );
    const attempt = { runId: row.id, attemptId: crypto.randomUUID() };
    await claimTestAttempt(store, row, {
      attemptId: attempt.attemptId,
      daemonId: "daemon-a",
      leaseMs: 60_000,
    });
    await requireSql()`
      UPDATE workflow_runs
         SET lease_expires_at = now() - interval '1 second'
       WHERE id = ${row.id}
    `;

    await expectToReject(
      store.assertCurrentWorkflowAttempt(attempt, requireSql()),
      "workflow attempt is no longer current",
    );
    await expectToReject(
      store.mergeAttemptState(attempt, { staleProgress: true }, requireSql()),
      "workflow attempt is no longer current",
    );
    await expectToReject(
      store.markAttemptSucceeded(attempt, { staleTerminal: true }, requireSql()),
      "workflow attempt is no longer current",
    );

    const after = await store.findById(row.id, requireSql());
    expect(after?.status).toBe("running");
    expect(after?.state).toEqual({});
    await requireSql()`DELETE FROM workflow_runs WHERE id = ${row.id}`;
  });

  it("expires only elapsed current attempts and releases the in-flight guard", async () => {
    const store = await import("../../src/workflows/runs-store");
    const expired = await store.insertQueued(
      {
        workflowName: "resolve",
        target: { type: "pr", owner: "acme", repo: "repo", number: 122 },
        ownerKind: "orchestrator",
        ownerId: "orchestrator-a",
      },
      requireSql(),
    );
    const live = await store.insertQueued(
      {
        workflowName: "triage",
        target: { ...target, number: 123 },
        ownerKind: "orchestrator",
        ownerId: "orchestrator-a",
      },
      requireSql(),
    );
    const expiredAttemptId = crypto.randomUUID();
    await claimTestAttempt(store, expired, {
      attemptId: expiredAttemptId,
      daemonId: "daemon-dead",
      leaseMs: 60_000,
    });
    await claimTestAttempt(store, live, {
      attemptId: crypto.randomUUID(),
      daemonId: "daemon-live",
      leaseMs: 60_000,
    });
    await requireSql()`
      UPDATE workflow_runs
         SET lease_expires_at = now() - interval '1 second'
       WHERE id = ${expired.id}
    `;

    const transitioned = await store.expireWorkflowAttempts(requireSql());
    expect(transitioned.map((candidate) => candidate.id)).toEqual([expired.id]);
    const failedReason = transitioned[0]?.state["failedReason"];
    expect(failedReason).toBeString();
    expect(failedReason as string).toContain("lease expired");
    expect(failedReason as string).not.toContain("daemon-dead");
    expect(transitioned[0]?.state["phase"]).toBe("lease-expired");
    expect(transitioned[0]?.lease_expires_at).toBeNull();
    expect(await store.findPendingWorkflowFailureNotifications(requireSql())).toEqual([
      expect.objectContaining({
        phase: "lease-expired",
        row: expect.objectContaining({ id: expired.id, attempt_id: expiredAttemptId }),
      }),
    ]);
    expect(
      await store.markWorkflowFailureNotified(
        { runId: expired.id, attemptId: expiredAttemptId },
        requireSql(),
      ),
    ).toBe(true);
    expect(await store.findPendingWorkflowFailureNotifications(requireSql())).toEqual([]);
    expect((await store.findById(live.id, requireSql()))?.status).toBe("running");

    const retry = await store.insertQueued(
      {
        workflowName: "resolve",
        target: { type: "pr", owner: "acme", repo: "repo", number: 122 },
        ownerKind: "orchestrator",
        ownerId: "orchestrator-b",
      },
      requireSql(),
    );
    expect(retry.status).toBe("queued");
  });

  it("expires a fresh queued dispatch after its publication retry budget", async () => {
    const store = await import("../../src/workflows/runs-store");
    const row = await store.insertQueued(
      {
        workflowName: "review",
        target: { type: "pr", owner: "acme", repo: "repo", number: 1235 },
        executionDeliveryId: crypto.randomUUID(),
        ownerKind: "orchestrator",
        ownerId: "orchestrator-a",
      },
      requireSql(),
    );
    await requireSql()`
      UPDATE workflow_runs SET dispatch_retry_count = 4 WHERE id = ${row.id}
    `;

    const expired = await store.expireQueuedWorkflowDispatches(4_200_000, 3, requireSql());

    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      id: row.id,
      status: "failed",
      state: {
        failedReason: "workflow dispatch retries exhausted",
        phase: "dispatch-expired",
      },
      attempt_completed_at: expect.any(Date),
    });
  });

  it("commits the parent hand-off, child row, and execution row in one transaction", async () => {
    const store = await import("../../src/workflows/runs-store");
    const { recordWorkflowExecution } = await import("../../src/workflows/execution-row");
    const parent = await store.insertQueued(
      {
        workflowName: "ship",
        target: { ...target, number: 124 },
        deliveryId: "trace-124",
        ownerKind: "orchestrator",
        ownerId: "orchestrator-a",
      },
      requireSql(),
    );
    const attempt = { runId: parent.id, attemptId: crypto.randomUUID() };
    await claimTestAttempt(store, parent, {
      attemptId: attempt.attemptId,
      daemonId: "daemon-a",
      leaseMs: 60_000,
    });

    const child = await requireSql().begin(async (tx) => {
      const committed = await store.commitAttemptHandOffChild(
        attempt,
        { currentStepIndex: 0, stepRuns: [] },
        {
          workflowName: "triage",
          target: { ...target, number: 124 },
          parentStepIndex: 0,
          traceDeliveryId: "trace-124",
        },
        tx,
      );
      await recordWorkflowExecution({
        deliveryId: committed.id,
        target: { ...target, number: 124 },
        senderLogin: "github-app-test",
        workflowName: "triage",
        runId: committed.id,
        logger: { info: () => undefined } as never,
        sql: tx,
      });
      return committed;
    });

    const parentAfter = await store.findById(parent.id, requireSql());
    expect(parentAfter?.status).toBe("running");
    expect(parentAfter?.lease_expires_at).toBeNull();
    expect(parentAfter?.attempt_completed_at).toBeInstanceOf(Date);
    expect(parentAfter?.state).toEqual({
      currentStepIndex: 0,
      stepRuns: [],
      handedOffTo: child.id,
    });
    expect(child.parent_run_id).toBe(parent.id);
    expect(child.execution_delivery_id).toBe(child.id);
    expect(child.owner_kind).toBeNull();
    expect(child.owner_id).toBeNull();
    expect(child.dispatch_enqueued_at).toBeNull();

    const executionRows: { delivery_id: string; status: string }[] = await requireSql()`
      SELECT delivery_id, status FROM executions WHERE delivery_id = ${child.id}
    `;
    expect(executionRows).toEqual([{ delivery_id: child.id, status: "queued" }]);
  });

  it("rolls back a child hand-off after the parent attempt lease expires", async () => {
    const store = await import("../../src/workflows/runs-store");
    const parent = await store.insertQueued(
      {
        workflowName: "ship",
        target: { ...target, number: 125 },
        ownerKind: "orchestrator",
        ownerId: "orchestrator-a",
      },
      requireSql(),
    );
    const attempt = { runId: parent.id, attemptId: crypto.randomUUID() };
    await claimTestAttempt(store, parent, {
      attemptId: attempt.attemptId,
      daemonId: "daemon-a",
      leaseMs: 60_000,
    });
    await requireSql()`
      UPDATE workflow_runs
         SET lease_expires_at = now() - interval '1 second'
       WHERE id = ${parent.id}
    `;

    await expectToReject(
      requireSql().begin(async (tx) =>
        store.commitAttemptHandOffChild(
          attempt,
          { currentStepIndex: 0, stepRuns: [] },
          {
            workflowName: "triage",
            target: { ...target, number: 125 },
            parentStepIndex: 0,
            traceDeliveryId: "trace-125",
          },
          tx,
        ),
      ),
      "workflow attempt is no longer current",
    );

    const children: { count: number | string }[] = await requireSql()`
      SELECT count(*) AS count FROM workflow_runs WHERE parent_run_id = ${parent.id}
    `;
    expect(Number(children[0]?.count)).toBe(0);
    expect((await store.findById(parent.id, requireSql()))?.state).toEqual({});
  });

  it("clears a prior tracking id only while the current attempt lease is live", async () => {
    const store = await import("../../src/workflows/runs-store");
    const current = await store.insertQueued(
      {
        workflowName: "plan",
        target: { ...target, number: 126 },
        ownerKind: "orchestrator",
        ownerId: "orchestrator-a",
      },
      requireSql(),
    );
    const prior = await store.insertQueued(
      {
        workflowName: "plan",
        target: { ...target, number: 127 },
        ownerKind: "orchestrator",
        ownerId: "orchestrator-a",
      },
      requireSql(),
    );
    const attempt = { runId: current.id, attemptId: crypto.randomUUID() };
    await claimTestAttempt(store, current, {
      attemptId: attempt.attemptId,
      daemonId: "daemon-a",
      leaseMs: 60_000,
    });
    await requireSql()`
      UPDATE workflow_runs SET tracking_comment_id = 8001 WHERE id = ${prior.id}
    `;

    await store.clearTrackingCommentIdForAttempt(prior.id, attempt, requireSql());
    expect((await store.findById(prior.id, requireSql()))?.tracking_comment_id).toBeNull();

    await requireSql()`
      UPDATE workflow_runs SET tracking_comment_id = 8002 WHERE id = ${prior.id}
    `;
    await requireSql()`
      UPDATE workflow_runs
         SET lease_expires_at = now() - interval '1 second'
       WHERE id = ${current.id}
    `;
    await expectToReject(
      store.clearTrackingCommentIdForAttempt(prior.id, attempt, requireSql()),
      "workflow attempt is no longer current",
    );
    expect((await store.findById(prior.id, requireSql()))?.tracking_comment_id).toBe(8002);
  });
});
