/**
 * Integration tests for workflow_runs persistence.
 *
 * Requires Postgres (bun run dev:deps). Skipped automatically when the
 * database is unreachable: matches the pattern in test/db/migrate.test.ts
 * so the suite does not fail on machines without local infra.
 */

import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { expectToReject } from "../utils/assertions";

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

const target = { type: "issue" as const, owner: "acme", repo: "repo", number: 1 };

describe.skipIf(sql === null)("runs-store", () => {
  beforeAll(async () => {
    // Reset to a clean schema so test order is deterministic.
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
    expect(typeof row.id).toBe("string");
    expect(row.id.length).toBeGreaterThan(0);
  });

  it("markRunning only flips queued rows", async () => {
    const { insertQueued, markRunning, findById, markSucceeded } =
      await import("../../src/workflows/runs-store");
    const row = await insertQueued(
      {
        workflowName: "plan",
        target: { ...target, number: 101 },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );

    await markRunning(row.id, "test-daemon", requireSql());
    const afterRunning = await findById(row.id, requireSql());
    expect(afterRunning?.status).toBe("running");

    // Second call must not flip succeeded back to running.
    await markSucceeded(row.id, {}, requireSql());
    await markRunning(row.id, "test-daemon", requireSql());
    const afterNoop = await findById(row.id, requireSql());
    expect(afterNoop?.status).toBe("succeeded");
  });

  it("markSucceeded merges state via JSONB concat", async () => {
    const { insertQueued, markSucceeded, findById } =
      await import("../../src/workflows/runs-store");
    const row = await insertQueued(
      {
        workflowName: "implement",
        target: { ...target, number: 102 },
        initialState: { a: 1, b: 2 },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );

    await markSucceeded(row.id, { b: 99, c: 3 }, requireSql());
    const after = await findById(row.id, requireSql());
    expect(after?.status).toBe("succeeded");
    expect(after?.state).toEqual({ a: 1, b: 99, c: 3 });
  });

  it("markFailed records the reason inside state", async () => {
    const { insertQueued, markFailed, findById } = await import("../../src/workflows/runs-store");
    const row = await insertQueued(
      {
        workflowName: "resolve",
        target: { type: "pr", owner: "acme", repo: "repo", number: 103 },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );

    await markFailed(row.id, "handler exploded", { extra: "context" }, requireSql());
    const after = await findById(row.id, requireSql());
    expect(after?.status).toBe("failed");
    expect(after?.state).toEqual({ extra: "context", failedReason: "handler exploded" });
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
    const { insertQueued, findInflight, markRunning, markSucceeded } =
      await import("../../src/workflows/runs-store");
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

    await markRunning(row.id, "test-daemon", requireSql());
    const runningHit = await findInflight("plan", t, requireSql());
    expect(runningHit?.id).toBe(row.id);

    await markSucceeded(row.id, {}, requireSql());
    const terminalMiss = await findInflight("plan", t, requireSql());
    expect(terminalMiss).toBeNull();
  });

  it("findLatestForTarget orders by created_at DESC", async () => {
    const { insertQueued, markSucceeded, findLatestForTarget } =
      await import("../../src/workflows/runs-store");
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
    await markSucceeded(first.id, {}, requireSql());

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
    const { insertQueued, markSucceeded } = await import("../../src/workflows/runs-store");
    const first = await insertQueued(
      {
        workflowName: "triage",
        target: { ...target, number: 109 },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );
    await markSucceeded(first.id, {}, requireSql());

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

  it("findLatestSucceededForTarget returns the most recent succeeded row, ignoring later failed rows", async () => {
    const { insertQueued, markSucceeded, markFailed, findLatestSucceededForTarget } =
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
    await markSucceeded(first.id, { verdict: "valid" }, requireSql());
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
    await markFailed(second.id, "intermittent network error", {}, requireSql());

    const latestSucceeded = await findLatestSucceededForTarget("triage", t, requireSql());
    expect(latestSucceeded?.id).toBe(first.id);
  });

  it("findLatestSucceededForTarget returns null when no succeeded row exists", async () => {
    const { insertQueued, markFailed, findLatestSucceededForTarget } =
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
    await markFailed(row.id, "no CI yet", {}, requireSql());

    const latest = await findLatestSucceededForTarget("resolve", t, requireSql());
    expect(latest).toBeNull();
  });
});
