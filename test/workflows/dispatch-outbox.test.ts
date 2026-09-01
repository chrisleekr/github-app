import { SQL } from "bun";
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

import { expectToReject } from "../utils/assertions";

const TEST_DATABASE_URL =
  process.env["TEST_DATABASE_URL"] ?? "postgres://bot:bot@localhost:55432/github_app_test";

let sql: SQL | null = null;
try {
  const connection = new SQL(TEST_DATABASE_URL);
  await connection`SELECT 1`;
  sql = connection;
} catch {
  sql = null;
}

function requireSql(): SQL {
  if (sql === null) throw new Error("Database not available, test should have been skipped");
  return sql;
}

const ensureWorkflowJobQueued = mock(async () => Promise.resolve(true));
void mock.module("../../src/orchestrator/job-queue", () => ({
  ensureWorkflowJobQueued,
  isScopedJob: () => false,
  SCOPED_JOB_KINDS: ["scoped-rebase", "scoped-fix-thread", "scoped-open-pr"],
}));
void mock.module("../../src/orchestrator/instance-id", () => ({
  getInstanceId: () => "orchestrator-test",
}));

async function resetSchema(): Promise<void> {
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
}

describe.skipIf(sql === null)("workflow dispatch outbox", () => {
  beforeAll(async () => {
    await resetSchema();
    const { runMigrations } = await import("../../src/db/migrate");
    await runMigrations(requireSql());
  });

  afterAll(async () => {
    await resetSchema();
    await requireSql().close();
  });

  beforeEach(() => {
    ensureWorkflowJobQueued.mockReset();
    ensureWorkflowJobQueued.mockResolvedValue(true);
  });

  async function seedPendingRun(number: number): Promise<{ runId: string; deliveryId: string }> {
    const { insertQueued } = await import("../../src/workflows/runs-store");
    const { recordWorkflowExecution } = await import("../../src/workflows/execution-row");
    const deliveryId = crypto.randomUUID();
    const parent = await insertQueued(
      {
        workflowName: "ship",
        target: { type: "pr", owner: "acme", repo: "widgets", number },
        ownerKind: "orchestrator",
        ownerId: "orchestrator-test",
      },
      requireSql(),
    );
    const row = await insertQueued(
      {
        workflowName: "review",
        target: { type: "pr", owner: "acme", repo: "widgets", number },
        deliveryId: "parent-trace",
        executionDeliveryId: deliveryId,
        triggerBodyPreview: "run python in a docker container",
        parentRunId: parent.id,
        parentStepIndex: 3,
        ownerKind: "orchestrator",
        ownerId: "orchestrator-before-publish",
      },
      requireSql(),
    );
    await recordWorkflowExecution({
      deliveryId,
      target: { type: "pr", owner: "acme", repo: "widgets", number },
      senderLogin: "github-app-test",
      workflowName: "review",
      runId: row.id,
      labels: ["bot:review"],
      logger: { info: () => undefined } as never,
      sql: requireSql(),
    });
    return { runId: row.id, deliveryId };
  }

  it("publishes a committed row once and records the dispatch receipt", async () => {
    const { publishWorkflowRunById } = await import("../../src/workflows/dispatch-outbox");
    const { findById, findCommittedWorkflowDispatch } =
      await import("../../src/workflows/runs-store");
    const { runId, deliveryId } = await seedPendingRun(501);

    expect(
      await findCommittedWorkflowDispatch(
        {
          workflowName: "review",
          target: { type: "pr", owner: "acme", repo: "widgets", number: 501 },
          executionDeliveryId: deliveryId,
        },
        requireSql(),
      ),
    ).toMatchObject({ id: runId });
    expect(
      await findCommittedWorkflowDispatch(
        {
          workflowName: "review",
          target: { type: "pr", owner: "acme", repo: "widgets", number: 999 },
          executionDeliveryId: deliveryId,
        },
        requireSql(),
      ),
    ).toBeNull();

    expect(await publishWorkflowRunById(runId, requireSql())).toBe(true);
    expect(await publishWorkflowRunById(runId, requireSql())).toBe(false);
    expect(ensureWorkflowJobQueued).toHaveBeenCalledTimes(1);
    expect(ensureWorkflowJobQueued).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "workflow-run",
        repoOwner: "acme",
        repoName: "widgets",
        entityNumber: 501,
        isPR: true,
        labels: ["bot:review"],
        triggerBodyPreview: "run python in a docker container",
        workflowRun: expect.objectContaining({
          runId,
          workflowName: "review",
          parentStepIndex: 3,
        }),
      }),
      "orchestrator-test",
    );
    const row = await findById(runId, requireSql());
    expect(row?.dispatch_enqueued_at).toBeInstanceOf(Date);
    expect(row?.owner_kind).toBeNull();
    expect(row?.owner_id).toBeNull();
  });

  it("leaves a failed publication pending and retries it on the next pass", async () => {
    const { publishPendingWorkflowRuns } = await import("../../src/workflows/dispatch-outbox");
    const { findById } = await import("../../src/workflows/runs-store");
    const { runId } = await seedPendingRun(502);
    ensureWorkflowJobQueued.mockRejectedValueOnce(new Error("Valkey unavailable"));

    expect(await publishPendingWorkflowRuns(requireSql())).toBe(0);
    expect((await findById(runId, requireSql()))?.dispatch_enqueued_at).toBeNull();
    expect(await publishPendingWorkflowRuns(requireSql())).toBe(1);
    expect((await findById(runId, requireSql()))?.dispatch_enqueued_at).toBeInstanceOf(Date);
    expect(ensureWorkflowJobQueued).toHaveBeenCalledTimes(2);
  });

  it("durably counts failed publication attempts", async () => {
    const { publishWorkflowRunById } = await import("../../src/workflows/dispatch-outbox");
    const { findById } = await import("../../src/workflows/runs-store");
    const { runId } = await seedPendingRun(507);
    ensureWorkflowJobQueued.mockRejectedValueOnce(new Error("Valkey unavailable"));

    await expectToReject(publishWorkflowRunById(runId, requireSql()), "Valkey unavailable");

    expect((await findById(runId, requireSql()))?.dispatch_retry_count).toBe(1);
    expect(await publishWorkflowRunById(runId, requireSql())).toBe(true);
  });

  it("does not republish a row after its durable retry budget is exhausted", async () => {
    const { config } = await import("../../src/config");
    const { publishWorkflowRunById } = await import("../../src/workflows/dispatch-outbox");
    const { runId } = await seedPendingRun(508);
    await requireSql()`
      UPDATE workflow_runs
         SET dispatch_retry_count = ${config.jobMaxRetries + 1}
       WHERE id = ${runId}
    `;

    expect(await publishWorkflowRunById(runId, requireSql())).toBe(false);
    expect(ensureWorkflowJobQueued).not.toHaveBeenCalled();
  });

  it("publishes the durable retry count after an orchestrator restart", async () => {
    const { publishWorkflowRunById } = await import("../../src/workflows/dispatch-outbox");
    const { runId } = await seedPendingRun(504);
    await requireSql()`
      UPDATE workflow_runs
         SET dispatch_retry_count = 2
       WHERE id = ${runId}
    `;

    expect(await publishWorkflowRunById(runId, requireSql())).toBe(true);
    expect(ensureWorkflowJobQueued).toHaveBeenCalledWith(
      expect.objectContaining({ retryCount: 2 }),
      "orchestrator-test",
    );
  });

  it("does not let an old publication close a newer dispatch generation", async () => {
    const { publishWorkflowRunById } = await import("../../src/workflows/dispatch-outbox");
    const { findById } = await import("../../src/workflows/runs-store");
    const { runId } = await seedPendingRun(503);
    ensureWorkflowJobQueued.mockImplementationOnce(async () => {
      await requireSql()`
        UPDATE workflow_runs
           SET dispatch_generation_id = gen_random_uuid()
         WHERE id = ${runId}
      `;
    });

    expect(await publishWorkflowRunById(runId, requireSql())).toBe(false);
    expect((await findById(runId, requireSql()))?.dispatch_enqueued_at).toBeNull();
    expect(await publishWorkflowRunById(runId, requireSql())).toBe(true);
    expect((await findById(runId, requireSql()))?.dispatch_enqueued_at).toBeInstanceOf(Date);
    expect(ensureWorkflowJobQueued).toHaveBeenCalledTimes(2);
  });

  it("reconciles an acknowledged wake-up after its grace period without changing its bytes", async () => {
    const { publishPendingWorkflowRuns, WORKFLOW_DISPATCH_RECONCILE_GRACE_MS } =
      await import("../../src/workflows/dispatch-outbox");
    const { findById } = await import("../../src/workflows/runs-store");
    const { runId } = await seedPendingRun(505);

    expect(await publishPendingWorkflowRuns(requireSql())).toBe(1);
    const firstJob = ensureWorkflowJobQueued.mock.calls[0]?.[0];
    expect(await publishPendingWorkflowRuns(requireSql())).toBe(0);

    await requireSql()`
      UPDATE workflow_runs
         SET dispatch_enqueued_at = now() - ${WORKFLOW_DISPATCH_RECONCILE_GRACE_MS + 1_000} * interval '1 millisecond'
       WHERE id = ${runId}
    `;
    expect(await publishPendingWorkflowRuns(requireSql())).toBe(1);
    expect(ensureWorkflowJobQueued.mock.calls[1]?.[0]).toEqual(firstJob);
    expect((await findById(runId, requireSql()))?.dispatch_enqueued_at).toBeInstanceOf(Date);
  });

  it("does not let a stale publication overwrite a concurrent claim", async () => {
    const { publishPendingWorkflowRuns, WORKFLOW_DISPATCH_RECONCILE_GRACE_MS } =
      await import("../../src/workflows/dispatch-outbox");
    const { findById } = await import("../../src/workflows/runs-store");
    const { runId } = await seedPendingRun(506);
    await requireSql()`
      UPDATE workflow_runs
         SET dispatch_enqueued_at = now() - ${WORKFLOW_DISPATCH_RECONCILE_GRACE_MS + 1_000} * interval '1 millisecond'
       WHERE id = ${runId}
    `;
    ensureWorkflowJobQueued.mockImplementationOnce(async () => {
      await requireSql()`
        UPDATE workflow_runs
           SET status = 'failed', owner_kind = NULL, owner_id = NULL
         WHERE id = ${runId}
      `;
      return false;
    });

    expect(await publishPendingWorkflowRuns(requireSql())).toBe(0);
    expect(await findById(runId, requireSql())).toMatchObject({
      status: "failed",
      owner_kind: null,
      owner_id: null,
    });
  });
});
