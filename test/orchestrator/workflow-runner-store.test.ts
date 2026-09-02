import { SQL } from "bun";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import type { WorkflowRunQueuedJob } from "../../src/orchestrator/job-queue";
import type { WorkflowRunnerAttempt } from "../../src/orchestrator/workflow-runner-store";
import type { WorkflowRunnerResultPayload } from "../../src/shared/workflow-runner-messages";
import { expectToReject } from "../utils/assertions";

const TEST_DATABASE_URL =
  process.env["TEST_DATABASE_URL"] ?? "postgres://bot:bot@localhost:55432/github_app_test";

let sql: SQL | null = null;
try {
  const connection = new SQL(TEST_DATABASE_URL);
  await connection`SELECT 1 AS ok`;
  sql = connection;
} catch {
  sql = null;
}

function requireSql(): SQL {
  if (sql === null) throw new Error("Database not available, test should have been skipped");
  return sql;
}

async function resetSchema(): Promise<void> {
  await requireSql().unsafe(`
    DROP TABLE IF EXISTS _migrations CASCADE;
    DROP TABLE IF EXISTS review_learnings CASCADE;
    DROP TABLE IF EXISTS scheduled_action_state CASCADE;
    DROP TABLE IF EXISTS comment_cache CASCADE;
    DROP TABLE IF EXISTS target_cache CASCADE;
    DROP TABLE IF EXISTS chat_proposals CASCADE;
    DROP TABLE IF EXISTS ship_fix_attempts CASCADE;
    DROP TABLE IF EXISTS ship_continuations CASCADE;
    DROP TABLE IF EXISTS ship_iterations CASCADE;
    DROP TABLE IF EXISTS ship_intents CASCADE;
    DROP TABLE IF EXISTS workflow_attempt_commands CASCADE;
    DROP TABLE IF EXISTS workflow_runs CASCADE;
    DROP TABLE IF EXISTS repo_memory CASCADE;
    DROP TABLE IF EXISTS triage_results CASCADE;
    DROP TABLE IF EXISTS executions CASCADE;
    DROP TABLE IF EXISTS daemons CASCADE;
  `);
}

async function queuedWorkflow(number: number): Promise<WorkflowRunQueuedJob> {
  const deliveryId = crypto.randomUUID();
  const { createExecution } = await import("../../src/orchestrator/history");
  const { insertQueued } = await import("../../src/workflows/runs-store");
  await createExecution(
    {
      deliveryId,
      repoOwner: "acme",
      repoName: "widgets",
      entityNumber: number,
      entityType: "issue",
      eventName: "issue_comment",
      triggerUsername: "maintainer",
      dispatchMode: "workflow-runner",
      dispatchTarget: "workflow-runner",
      dispatchReason: "workflow-runner",
    },
    requireSql(),
  );
  const run = await insertQueued(
    {
      workflowName: "implement",
      target: { type: "issue", owner: "acme", repo: "widgets", number },
      deliveryId,
      ownerKind: "orchestrator",
      ownerId: "orchestrator-test",
    },
    requireSql(),
  );
  return {
    kind: "workflow-run",
    deliveryId,
    repoOwner: "acme",
    repoName: "widgets",
    entityNumber: number,
    isPR: false,
    eventName: "issue_comment",
    triggerUsername: "maintainer",
    labels: [],
    triggerBodyPreview: "",
    enqueuedAt: Date.now(),
    retryCount: 0,
    workflowRun: { runId: run.id, workflowName: "implement" },
  };
}

async function claimedWorkflow(number: number): Promise<WorkflowRunnerAttempt> {
  const { claimWorkflowRunnerAttempt } =
    await import("../../src/orchestrator/workflow-runner-store");
  const job = await queuedWorkflow(number);
  const claim = await claimWorkflowRunnerAttempt(job, 60_000, 10, requireSql());
  if (claim.outcome !== "claimed") throw new Error(`Expected claim, received ${claim.outcome}`);
  return claim.attempt;
}

function succeededResult(attempt: WorkflowRunnerAttempt): WorkflowRunnerResultPayload {
  return {
    runId: attempt.runId,
    attemptId: attempt.attemptId,
    result: {
      status: "succeeded",
      state: { phase: "complete" },
      daemonActions: {
        learnings: [{ category: "architecture", content: "The controller owns state." }],
        deletions: ["11111111-1111-4111-8111-111111111111"],
      },
    },
    durationMs: 321,
  };
}

describe.skipIf(sql === null)("workflow runner admission", () => {
  beforeAll(async () => {
    await resetSchema();
    const { runMigrations } = await import("../../src/db/migrate");
    await runMigrations(requireSql());
  });

  beforeEach(async () => {
    await requireSql().unsafe("TRUNCATE workflow_runs, executions CASCADE");
  });

  afterAll(async () => {
    await resetSchema();
    await requireSql().close();
  });

  it("defers queued work at capacity while active duplicates reconcile", async () => {
    const { claimWorkflowRunnerAttempt, failWorkflowRunnerAttempt } =
      await import("../../src/orchestrator/workflow-runner-store");
    const firstJob = await queuedWorkflow(16);
    const secondJob = await queuedWorkflow(17);

    await expectToReject(
      claimWorkflowRunnerAttempt(firstJob, 60_000, 0, requireSql()),
      "maxActive must be a positive integer",
    );

    const first = await claimWorkflowRunnerAttempt(firstJob, 60_000, 1, requireSql());
    expect(first.outcome).toBe("claimed");
    if (first.outcome !== "claimed") throw new Error("Expected first claim");

    const duplicate = await claimWorkflowRunnerAttempt(firstJob, 60_000, 1, requireSql());
    expect(duplicate).toEqual({ outcome: "active", attempt: first.attempt });

    const capacity = await claimWorkflowRunnerAttempt(secondJob, 60_000, 1, requireSql());
    expect(capacity).toEqual({ outcome: "capacity" });
    const queuedRows: {
      workflow_status: string;
      owner_kind: string | null;
      owner_id: string | null;
      attempt_id: string | null;
      lease_expires_at: Date | null;
      execution_status: string;
      daemon_id: string | null;
      offer_id: string | null;
    }[] = await requireSql()`
        SELECT wr.status AS workflow_status,
               wr.owner_kind,
               wr.owner_id,
               wr.attempt_id,
               wr.lease_expires_at,
               e.status AS execution_status,
               e.daemon_id,
               e.offer_id
          FROM workflow_runs AS wr
          JOIN executions AS e ON e.delivery_id = wr.execution_delivery_id
         WHERE wr.id = ${secondJob.workflowRun.runId}
      `;
    expect(queuedRows[0]).toEqual({
      workflow_status: "queued",
      owner_kind: "orchestrator",
      owner_id: "orchestrator-test",
      attempt_id: null,
      lease_expires_at: null,
      execution_status: "queued",
      daemon_id: null,
      offer_id: null,
    });

    await failWorkflowRunnerAttempt(first.attempt, "test terminal slot", requireSql());
    const second = await claimWorkflowRunnerAttempt(secondJob, 60_000, 1, requireSql());
    expect(second.outcome).toBe("claimed");
    if (second.outcome !== "claimed") throw new Error("Expected second claim");

    const thirdJob = await queuedWorkflow(18);
    await requireSql()`
      UPDATE workflow_runs
         SET lease_expires_at = now() - interval '1 second'
       WHERE id = ${second.attempt.runId}
    `;
    const third = await claimWorkflowRunnerAttempt(thirdJob, 60_000, 1, requireSql());
    expect(third.outcome).toBe("claimed");
  });

  it("lists only exact live attempts in reconciliation order", async () => {
    const { failWorkflowRunnerAttempt, listActiveWorkflowRunnerAttempts } =
      await import("../../src/orchestrator/workflow-runner-store");
    const first = await claimedWorkflow(19);
    const terminal = await claimedWorkflow(20);
    const expiredLease = await claimedWorkflow(21);
    const expiredDeadline = await claimedWorkflow(22);
    const wrongOwner = await claimedWorkflow(23);
    const second = await claimedWorkflow(24);

    await failWorkflowRunnerAttempt(terminal, "test terminal attempt", requireSql());
    await requireSql()`
      UPDATE workflow_runs
         SET lease_expires_at = now() - interval '1 second'
       WHERE id = ${expiredLease.runId}
    `;
    await requireSql()`
      UPDATE workflow_runs
         SET attempt_deadline_at = now() - interval '1 second'
       WHERE id = ${expiredDeadline.runId}
    `;
    await requireSql()`
      UPDATE workflow_runs
         SET owner_id = ${`workflow-runner:${crypto.randomUUID()}`}
       WHERE id = ${wrongOwner.runId}
    `;
    await requireSql()`
      UPDATE workflow_runs
         SET updated_at = '2026-01-01T00:00:00Z'::timestamptz
       WHERE id = ${first.runId}
    `;
    await requireSql()`
      UPDATE workflow_runs
         SET updated_at = '2026-01-02T00:00:00Z'::timestamptz
       WHERE id = ${second.runId}
    `;

    expect(await listActiveWorkflowRunnerAttempts(requireSql(), 1)).toEqual([first]);
    expect(await listActiveWorkflowRunnerAttempts(requireSql())).toEqual([first, second]);
  });

  it("replays stable command receipts and rejects command-id content conflicts", async () => {
    const { findWorkflowRunnerCommandReceipt, insertWorkflowRunnerCommandReceipt } =
      await import("../../src/orchestrator/workflow-runner-store");
    const attempt = await claimedWorkflow(30);
    const commandId = crypto.randomUUID();
    const command = {
      type: "set-state" as const,
      patch: { phase: "reviewing" },
      humanMessage: "Reviewing.",
    };

    await insertWorkflowRunnerCommandReceipt(
      attempt,
      commandId,
      command,
      { trackingCommentId: 301 },
      requireSql(),
    );
    await insertWorkflowRunnerCommandReceipt(
      attempt,
      commandId,
      command,
      { trackingCommentId: 999 },
      requireSql(),
    );

    expect(await findWorkflowRunnerCommandReceipt(attempt, commandId, requireSql())).toEqual({
      commandKind: "set-state",
      request: command,
      response: { trackingCommentId: 301 },
    });
    await expectToReject(
      insertWorkflowRunnerCommandReceipt(
        attempt,
        commandId,
        { ...command, patch: { phase: "different" } },
        { trackingCommentId: 301 },
        requireSql(),
      ),
      "command id was reused with different content",
    );
  });

  it("fences registration and renewal at the immutable attempt deadline", async () => {
    const { getWorkflowRunnerRegistrationState } =
      await import("../../src/orchestrator/workflow-runner-store");
    const { expireWorkflowAttempts, renewWorkflowAttempts } =
      await import("../../src/workflows/runs-store");
    const attempt = await claimedWorkflow(34);
    await requireSql()`
      UPDATE workflow_runs
         SET lease_expires_at = now() + interval '1 minute',
             attempt_deadline_at = now() - interval '1 second'
       WHERE id = ${attempt.runId}
    `;

    expect(await getWorkflowRunnerRegistrationState(attempt, requireSql())).toEqual({
      state: "invalid",
    });
    expect(
      await renewWorkflowAttempts(attempt.runnerId, [attempt.attemptId], 60_000, requireSql()),
    ).toEqual({ renewedAttemptIds: [], fencedAttemptIds: [attempt.attemptId] });
    const expired = await expireWorkflowAttempts(requireSql());
    expect(expired).toHaveLength(1);
    expect(expired[0]?.state["failedReason"]).toBe("workflow execution deadline expired");
  });

  it("records one payload delivery only when the token expires within the attempt", async () => {
    const safe = await claimedWorkflow(212);
    const unsafe = await claimedWorkflow(213);
    const { getWorkflowRunnerRegistrationState, recordWorkflowRunnerPayloadIssued } =
      await import("../../src/orchestrator/workflow-runner-store");
    const safeExpiry = new Date(safe.attemptDeadlineAt.getTime() - 60_000);

    expect(await recordWorkflowRunnerPayloadIssued(safe, safeExpiry, requireSql())).toBe(true);
    expect(await recordWorkflowRunnerPayloadIssued(safe, safeExpiry, requireSql())).toBe(false);
    expect(
      await recordWorkflowRunnerPayloadIssued(
        unsafe,
        new Date(unsafe.attemptDeadlineAt.getTime() + 1),
        requireSql(),
      ),
    ).toBe(false);

    expect(await getWorkflowRunnerRegistrationState(safe, requireSql())).toMatchObject({
      state: "ready",
      payloadIssuedAt: expect.any(Date),
      tokenExpiresAt: safeExpiry,
    });
    expect(await getWorkflowRunnerRegistrationState(unsafe, requireSql())).toMatchObject({
      state: "ready",
      payloadIssuedAt: null,
      tokenExpiresAt: null,
    });
  });

  it("stores one exact terminal result atomically and rejects conflicting replay", async () => {
    const { storeWorkflowRunnerResult } =
      await import("../../src/orchestrator/workflow-runner-store");
    const attempt = await claimedWorkflow(31);
    const payload = succeededResult(attempt);

    expect(await storeWorkflowRunnerResult(payload, requireSql())).toBe("stored");
    const rows: {
      workflow_status: string;
      workflow_state: Record<string, unknown>;
      attempt_completed_at: Date | null;
      lease_expires_at: Date | null;
      execution_status: string;
      duration_ms: number | null;
      workflow_result_payload: unknown;
      result_processed_at: Date | null;
    }[] = await requireSql()`
      SELECT wr.status AS workflow_status,
             wr.state AS workflow_state,
             wr.attempt_completed_at,
             wr.lease_expires_at,
             e.status AS execution_status,
             e.duration_ms,
             e.workflow_result_payload,
             e.result_processed_at
        FROM workflow_runs AS wr
        JOIN executions AS e ON e.delivery_id = wr.execution_delivery_id
       WHERE wr.id = ${attempt.runId}
    `;
    expect(rows[0]).toEqual({
      workflow_status: "succeeded",
      workflow_state: { phase: "complete" },
      attempt_completed_at: expect.any(Date),
      lease_expires_at: null,
      execution_status: "completed",
      duration_ms: 321,
      workflow_result_payload: payload,
      result_processed_at: null,
    });
    expect(await storeWorkflowRunnerResult(payload, requireSql())).toBe("already-stored");
    await expectToReject(
      storeWorkflowRunnerResult({ ...payload, durationMs: 322 }, requireSql()),
      "id was reused with different content",
    );
  });

  it("stores a handed-off result only when every hand-off precondition holds", async () => {
    const { storeWorkflowRunnerResult } =
      await import("../../src/orchestrator/workflow-runner-store");
    const attempt = await claimedWorkflow(37);
    const childRunId = crypto.randomUUID();
    // The state `commitAttemptHandOffChild` leaves behind: the parent is still
    // `running`, its attempt is complete, its lease is released, and its state
    // names the child it handed off to.
    await requireSql()`
      UPDATE workflow_runs
         SET attempt_completed_at = now(),
             lease_expires_at = NULL,
             state = jsonb_build_object('handedOffTo', ${childRunId}::text)
       WHERE id = ${attempt.runId}
    `;
    const payload: WorkflowRunnerResultPayload = {
      runId: attempt.runId,
      attemptId: attempt.attemptId,
      result: { status: "handed-off", childRunId, humanMessage: "Handed off to the child run." },
      durationMs: 654,
    };

    expect(await storeWorkflowRunnerResult(payload, requireSql())).toBe("stored");
    const rows: { workflow_status: string; execution_status: string }[] = await requireSql()`
      SELECT wr.status AS workflow_status, e.status AS execution_status
        FROM workflow_runs AS wr
        JOIN executions AS e ON e.delivery_id = wr.execution_delivery_id
       WHERE wr.id = ${attempt.runId}
    `;
    // A hand-off terminalizes nothing: the child run carries the work forward.
    expect(rows[0]?.workflow_status).toBe("running");
    expect(rows[0]?.execution_status).toBe("completed");
  });

  it("rejects a handed-off result naming a child the parent never handed off to", async () => {
    const { storeWorkflowRunnerResult } =
      await import("../../src/orchestrator/workflow-runner-store");
    const attempt = await claimedWorkflow(38);
    await requireSql()`
      UPDATE workflow_runs
         SET attempt_completed_at = now(),
             lease_expires_at = NULL,
             state = jsonb_build_object('handedOffTo', ${crypto.randomUUID()}::text)
       WHERE id = ${attempt.runId}
    `;
    const payload: WorkflowRunnerResultPayload = {
      runId: attempt.runId,
      attemptId: attempt.attemptId,
      result: {
        status: "handed-off",
        childRunId: crypto.randomUUID(),
        humanMessage: "Handed off to the child run.",
      },
      durationMs: 654,
    };

    await expectToReject(
      storeWorkflowRunnerResult(payload, requireSql()),
      "workflow attempt is no longer current",
    );
  });

  it("stores an incomplete result as incomplete while failing its execution receipt", async () => {
    const { storeWorkflowRunnerResult } =
      await import("../../src/orchestrator/workflow-runner-store");
    const attempt = await claimedWorkflow(35);
    const payload: WorkflowRunnerResultPayload = {
      runId: attempt.runId,
      attemptId: attempt.attemptId,
      result: {
        status: "incomplete",
        reason: "CI still has required work",
        state: { outstanding: ["fix CI"] },
        humanMessage: "CI still has required work.",
      },
      durationMs: 456,
    };

    expect(await storeWorkflowRunnerResult(payload, requireSql())).toBe("stored");
    const [row] = await requireSql()<
      {
        workflow_status: string;
        workflow_state: Record<string, unknown>;
        execution_status: string;
        error_message: string | null;
      }[]
    >`
      SELECT wr.status AS workflow_status,
             wr.state AS workflow_state,
             e.status AS execution_status,
             e.error_message
        FROM workflow_runs AS wr
        JOIN executions AS e ON e.delivery_id = wr.execution_delivery_id
       WHERE wr.id = ${attempt.runId}
    `;
    expect(row).toEqual({
      workflow_status: "incomplete",
      workflow_state: {
        incompleteReason: "CI still has required work",
        outstanding: ["fix CI"],
      },
      execution_status: "failed",
      error_message: "CI still has required work",
    });
  });

  it("reaches a valid pending result behind a full page of schema-invalid rows", async () => {
    const { findPendingWorkflowRunnerResults, storeWorkflowRunnerResult } =
      await import("../../src/orchestrator/workflow-runner-store");
    const broken = await claimedWorkflow(41);
    await storeWorkflowRunnerResult(succeededResult(broken), requireSql());
    // Simulate a payload that passed the schema on the way in and no longer
    // does, which is what a schema narrowing across a deploy leaves behind.
    await requireSql()`
      UPDATE executions
         SET workflow_result_payload = jsonb_build_object('runId', 'not-a-uuid')
       WHERE delivery_id = ${broken.executionDeliveryId}
    `;

    const healthy = await claimedWorkflow(42);
    const payload = succeededResult(healthy);
    await storeWorkflowRunnerResult(payload, requireSql());

    // `limit = 1` makes the first page exactly the invalid row. Without paging
    // past it the loader returns nothing here, forever: the query re-selects the
    // same earliest row on every pass.
    expect(await findPendingWorkflowRunnerResults(requireSql(), 1)).toEqual([
      {
        runId: healthy.runId,
        attemptId: healthy.attemptId,
        executionDeliveryId: healthy.executionDeliveryId,
        payload,
      },
    ]);
  });

  it("reports registration, pending result, processed result, and cleanup states", async () => {
    const {
      findPendingWorkflowRunnerResults,
      findWorkflowRunnerCleanupCandidates,
      getWorkflowRunnerRegistrationState,
      getWorkflowRunnerResultProcessingState,
      markWorkflowRunnerResourcesCleaned,
      markWorkflowRunnerResultProcessed,
      storeWorkflowRunnerResult,
    } = await import("../../src/orchestrator/workflow-runner-store");
    const attempt = await claimedWorkflow(32);
    const payload = succeededResult(attempt);
    const pending = {
      runId: attempt.runId,
      attemptId: attempt.attemptId,
      executionDeliveryId: attempt.executionDeliveryId,
      payload,
    };

    expect(await getWorkflowRunnerRegistrationState(attempt, requireSql())).toEqual({
      state: "ready",
      attempt,
      payloadIssuedAt: null,
      tokenExpiresAt: null,
    });
    expect(
      await getWorkflowRunnerRegistrationState(
        { runId: attempt.runId, attemptId: crypto.randomUUID() },
        requireSql(),
      ),
    ).toEqual({ state: "invalid" });
    expect(await getWorkflowRunnerResultProcessingState(pending, requireSql())).toBe("missing");

    await storeWorkflowRunnerResult(payload, requireSql());
    expect(await getWorkflowRunnerResultProcessingState(pending, requireSql())).toBe("pending");
    expect(
      await getWorkflowRunnerResultProcessingState(
        { ...pending, executionDeliveryId: crypto.randomUUID() },
        requireSql(),
      ),
    ).toBe("missing");
    await expectToReject(
      getWorkflowRunnerResultProcessingState(
        { ...pending, payload: { ...payload, durationMs: payload.durationMs + 1 } },
        requireSql(),
      ),
      "id was reused with different content",
    );
    expect(await getWorkflowRunnerRegistrationState(attempt, requireSql())).toEqual({
      state: "result-pending",
      executionDeliveryId: attempt.executionDeliveryId,
      payload,
    });
    expect(await findPendingWorkflowRunnerResults(requireSql())).toEqual([
      {
        runId: attempt.runId,
        attemptId: attempt.attemptId,
        executionDeliveryId: attempt.executionDeliveryId,
        payload,
      },
    ]);
    expect(await findWorkflowRunnerCleanupCandidates(requireSql())).toEqual([
      { runId: attempt.runId, attemptId: attempt.attemptId },
    ]);

    expect(await markWorkflowRunnerResultProcessed(attempt.attemptId, requireSql())).toBe(true);
    expect(await markWorkflowRunnerResultProcessed(attempt.attemptId, requireSql())).toBe(true);
    expect(await getWorkflowRunnerResultProcessingState(pending, requireSql())).toBe("processed");
    expect(await getWorkflowRunnerRegistrationState(attempt, requireSql())).toEqual({
      state: "completed",
    });
    expect(await findPendingWorkflowRunnerResults(requireSql())).toEqual([]);
    expect(await findWorkflowRunnerCleanupCandidates(requireSql())).toEqual([
      { runId: attempt.runId, attemptId: attempt.attemptId },
    ]);
    expect(await markWorkflowRunnerResourcesCleaned(attempt, requireSql())).toBe(true);
    expect(await markWorkflowRunnerResourcesCleaned(attempt, requireSql())).toBe(true);
    expect(await findWorkflowRunnerCleanupCandidates(requireSql())).toEqual([]);
  });

  it("fails the exact workflow and execution rows atomically with the reason", async () => {
    const { failWorkflowRunnerAttempt } =
      await import("../../src/orchestrator/workflow-runner-store");
    const attempt = await claimedWorkflow(33);

    await failWorkflowRunnerAttempt(attempt, "runner configuration rejected", requireSql());

    const rows: {
      workflow_status: string;
      workflow_state: Record<string, unknown>;
      attempt_completed_at: Date | null;
      lease_expires_at: Date | null;
      execution_status: string;
      error_message: string | null;
      result_processed_at: Date | null;
    }[] = await requireSql()`
      SELECT wr.status AS workflow_status,
             wr.state AS workflow_state,
             wr.attempt_completed_at,
             wr.lease_expires_at,
             e.status AS execution_status,
             e.error_message,
             e.result_processed_at
        FROM workflow_runs AS wr
        JOIN executions AS e ON e.delivery_id = wr.execution_delivery_id
       WHERE wr.id = ${attempt.runId}
    `;
    expect(rows[0]).toEqual({
      workflow_status: "failed",
      workflow_state: {
        failedReason: "runner configuration rejected",
        phase: "runner-start-failed",
      },
      attempt_completed_at: expect.any(Date),
      lease_expires_at: null,
      execution_status: "failed",
      error_message: "runner configuration rejected",
      result_processed_at: expect.any(Date),
    });
  });
});
