/**
 * Integration test for the heartbeat-based liveness reaper.
 *
 * Seeds workflow_runs rows owned by both alive and dead orchestrators/
 * daemons, sets the matching Valkey heartbeat keys, and asserts that
 * `reapOnce()` flips only the abandoned rows to `failed` (with a reason in
 * `state`). Also asserts the daemons-table sweep flips only daemons
 * missing a `daemon:{id}` heartbeat.
 *
 * The reaper relies on real SQL (`UPDATE … RETURNING`) and real Valkey
 * (`SCAN orchestrator:*:alive`, `SMEMBERS active_daemons`, `EXISTS …`),
 * so this test owns both clients via the project's standard
 * `TEST_DATABASE_URL` / `VALKEY_URL` env vars.
 */

import { SQL } from "bun";
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

void mock.module("../../src/orchestrator/workflow-runner-reconciler", () => ({
  reconcileWorkflowRunners: mock(() => Promise.resolve()),
}));
void mock.module("../../src/workflows/dispatch-outbox", () => ({
  publishPendingWorkflowRuns: mock(() => Promise.resolve(0)),
  publishWorkflowRunById: mock(() => Promise.resolve(true)),
}));

const TEST_DATABASE_URL =
  process.env["TEST_DATABASE_URL"] ?? "postgres://bot:bot@localhost:55432/github_app_test";
const TEST_VALKEY_URL = process.env["VALKEY_URL"] ?? "redis://localhost:56379";

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

describe.skipIf(sql === null)("liveness-reaper", () => {
  beforeAll(async () => {
    process.env["VALKEY_URL"] = TEST_VALKEY_URL;
    const { connectValkey } = await import("../../src/orchestrator/valkey");
    await connectValkey();

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
    const { closeValkey } = await import("../../src/orchestrator/valkey");
    closeValkey();
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

  beforeEach(async () => {
    await requireSql()`DELETE FROM workflow_runs`;
    await requireSql()`DELETE FROM executions`;
    await requireSql()`DELETE FROM scheduled_action_state`;
    await requireSql()`DELETE FROM daemons`;
    const { requireValkeyClient } = await import("../../src/orchestrator/valkey");
    const valkey = requireValkeyClient();
    // Wipe any leftover heartbeat keys from prior runs.
    const orchKeys: string[] = [];
    let cursor = "0";
    do {
      // eslint-disable-next-line no-await-in-loop -- Valkey SCAN
      const result: [string, string[]] = await valkey.send("SCAN", [
        cursor,
        "MATCH",
        "orchestrator:*:alive",
        "COUNT",
        "100",
      ]);
      cursor = result[0];
      orchKeys.push(...result[1]);
    } while (cursor !== "0");
    if (orchKeys.length > 0) await valkey.send("DEL", orchKeys);
    const processingKeys: string[] = [];
    cursor = "0";
    do {
      // eslint-disable-next-line no-await-in-loop -- Valkey SCAN
      const result: [string, string[]] = await valkey.send("SCAN", [
        cursor,
        "MATCH",
        "queue:processing:*",
        "COUNT",
        "100",
      ]);
      cursor = result[0];
      processingKeys.push(...result[1]);
    } while (cursor !== "0");
    if (processingKeys.length > 0) await valkey.send("DEL", processingKeys);
    await valkey.send("DEL", ["queue:jobs"]);
    const daemonMembers: string[] = await valkey.send("SMEMBERS", ["active_daemons"]);
    for (const id of daemonMembers) {
      await valkey.send("DEL", [`daemon:${id}`]);
    }
    await valkey.send("DEL", ["active_daemons"]);
  });

  async function setOrchestratorAlive(id: string): Promise<void> {
    const { requireValkeyClient } = await import("../../src/orchestrator/valkey");
    await requireValkeyClient().send("SET", [`orchestrator:${id}:alive`, "1", "EX", "60"]);
  }

  async function setDaemonAlive(id: string): Promise<void> {
    const { requireValkeyClient } = await import("../../src/orchestrator/valkey");
    const valkey = requireValkeyClient();
    await valkey.send("SET", [`daemon:${id}`, "{}", "EX", "60"]);
    await valkey.send("SADD", ["active_daemons", id]);
  }

  async function setDaemonHeartbeatOnly(id: string): Promise<void> {
    const { requireValkeyClient } = await import("../../src/orchestrator/valkey");
    await requireValkeyClient().send("SET", [`daemon:${id}`, "{}", "EX", "60"]);
  }

  async function insertWorkflowRow(
    target: { number: number },
    ownerKind: "orchestrator" | "daemon",
    ownerId: string,
    status: "queued" | "running" | "succeeded" = "queued",
  ): Promise<string> {
    const rows: { id: string }[] = await requireSql()`
      INSERT INTO workflow_runs (
        workflow_name, target_type, target_owner, target_repo, target_number,
        status, state, owner_kind, owner_id, dispatch_enqueued_at
      ) VALUES (
        'triage', 'issue', 'acme', 'repo', ${target.number},
        ${status}, '{}'::jsonb, ${ownerKind}, ${ownerId},
        ${ownerKind === "orchestrator" ? new Date() : null}
      )
      RETURNING id
    `;
    if (rows[0] === undefined) throw new Error("seed insert returned no row");
    return rows[0].id;
  }

  it("reaps orchestrator-owned rows whose owner heartbeat is missing", async () => {
    await setOrchestratorAlive("orch-alive");
    const liveId = await insertWorkflowRow({ number: 1001 }, "orchestrator", "orch-alive");
    const deadId = await insertWorkflowRow({ number: 1002 }, "orchestrator", "orch-dead");

    const { reapOnce } = await import("../../src/orchestrator/liveness-reaper");
    const result = await reapOnce(requireSql());

    expect(result.workflowRunsReaped.map((r) => r.id)).toEqual([deadId]);

    const [aliveRow] = await requireSql()<
      { status: string; state: Record<string, unknown> }[]
    >`SELECT status, state FROM workflow_runs WHERE id = ${liveId}`;
    expect(aliveRow?.status).toBe("queued");

    const [deadRow] = await requireSql()<
      { status: string; state: Record<string, unknown> }[]
    >`SELECT status, state FROM workflow_runs WHERE id = ${deadId}`;
    expect(deadRow?.status).toBe("failed");
    expect(deadRow?.state["failedReason"]).toContain("orch-dead");
  });

  it("preserves an unpublished outbox row after its owner exits", async () => {
    const runId = await insertWorkflowRow({ number: 1011 }, "orchestrator", "orch-dead");
    await requireSql()`
      UPDATE workflow_runs SET dispatch_enqueued_at = NULL WHERE id = ${runId}
    `;

    const { reapOnce } = await import("../../src/orchestrator/liveness-reaper");
    const result = await reapOnce(requireSql());

    expect(result.workflowRunsReaped.map((row) => row.id)).not.toContain(runId);
    const [row] = await requireSql()<{ status: string }[]>`
      SELECT status FROM workflow_runs WHERE id = ${runId}
    `;
    expect(row?.status).toBe("queued");
  });

  it("reaps daemon-owned 'running' rows whose daemon heartbeat is missing", async () => {
    await setDaemonAlive("daemon-alive");
    const liveId = await insertWorkflowRow({ number: 1003 }, "daemon", "daemon-alive", "running");
    const deadId = await insertWorkflowRow({ number: 1004 }, "daemon", "daemon-dead", "running");

    const { reapOnce } = await import("../../src/orchestrator/liveness-reaper");
    const result = await reapOnce(requireSql());

    expect(result.workflowRunsReaped.map((r) => r.id)).toEqual([deadId]);

    const [aliveRow] = await requireSql()<
      { status: string }[]
    >`SELECT status FROM workflow_runs WHERE id = ${liveId}`;
    expect(aliveRow?.status).toBe("running");
  });

  it("rechecks a candidate heartbeat before changing durable daemon ownership", async () => {
    const daemonId = "daemon-registered-after-snapshot";
    const runId = await insertWorkflowRow({ number: 1013 }, "daemon", daemonId, "running");
    await requireSql()`
      INSERT INTO daemons (
        id, hostname, platform, os_version, capabilities, resources,
        status, first_seen_at, last_seen_at
      ) VALUES (
        ${daemonId}, 'host', 'linux', '6', '{}'::jsonb, '{}'::jsonb,
        'active', now(), now()
      )
    `;
    // The fleet snapshot reads active_daemons, while registration publishes the
    // liveness key first. This reproduces that interleaving without a test hook.
    await setDaemonHeartbeatOnly(daemonId);

    const { reapOnce } = await import("../../src/orchestrator/liveness-reaper");
    const result = await reapOnce(requireSql());

    expect(result.workflowRunsReaped.map((row) => row.id)).not.toContain(runId);
    expect(result.daemonsMarkedInactive).toBe(0);
    const [workflow] = await requireSql()<{ status: string }[]>`
      SELECT status FROM workflow_runs WHERE id = ${runId}
    `;
    const [daemon] = await requireSql()<{ status: string }[]>`
      SELECT status FROM daemons WHERE id = ${daemonId}
    `;
    expect(workflow?.status).toBe("running");
    expect(daemon?.status).toBe("active");
  });

  it("recovers a crashed instance processing list after its heartbeat expires", async () => {
    const oldInstanceId = `orchestrator-old-${crypto.randomUUID()}`;
    const raw = JSON.stringify({ deliveryId: crypto.randomUUID() });
    const { requireValkeyClient } = await import("../../src/orchestrator/valkey");
    const valkey = requireValkeyClient();
    await valkey.send("LPUSH", [`queue:processing:${oldInstanceId}`, raw]);
    await valkey.send("SET", [`orchestrator:${oldInstanceId}:alive`, "1", "EX", "60"]);
    const { reapOnce } = await import("../../src/orchestrator/liveness-reaper");

    await reapOnce(requireSql());
    expect(await valkey.send("LLEN", [`queue:processing:${oldInstanceId}`])).toBe(1);

    await valkey.send("DEL", [`orchestrator:${oldInstanceId}:alive`]);
    await reapOnce(requireSql());
    expect(await valkey.send("LLEN", [`queue:processing:${oldInstanceId}`])).toBe(0);
    expect(await valkey.send("LPOP", ["queue:jobs"])).toBe(raw);
  });

  it("fails a dead daemon's standalone execution and releases its lock", async () => {
    const deliveryId = crypto.randomUUID();
    const daemonId = `daemon-worker-${crypto.randomUUID()}`;
    await requireSql()`
      INSERT INTO executions (
        delivery_id, repo_owner, repo_name, entity_number, entity_type,
        event_name, trigger_username, dispatch_mode, dispatch_target, dispatch_reason,
        daemon_id, status, started_at
      ) VALUES (
        ${deliveryId}, 'acme', 'repo', 1012, 'issue',
        'issue_comment', 'user', 'daemon', 'daemon', 'persistent-daemon',
        ${daemonId}, 'running', now()
      )
    `;
    await requireSql()`
      INSERT INTO scheduled_action_state (
        installation_id, owner, repo, action_name, in_flight_job_id, in_flight_started_at
      ) VALUES (1, 'acme', 'repo', 'standalone-reap', ${deliveryId}, now())
    `;
    const { reapOnce } = await import("../../src/orchestrator/liveness-reaper");

    await reapOnce(requireSql());

    const [execution] = await requireSql()<{ status: string; error_message: string | null }[]>`
      SELECT status, error_message FROM executions WHERE delivery_id = ${deliveryId}
    `;
    const [lock] = await requireSql()<{ in_flight_job_id: string | null }[]>`
      SELECT in_flight_job_id FROM scheduled_action_state WHERE action_name = 'standalone-reap'
    `;
    expect(execution).toEqual({
      status: "failed",
      error_message: "Owning daemon is no longer alive",
    });
    expect(lock?.in_flight_job_id).toBeNull();
  });

  it("does not reap an unexpired runner attempt because Valkey has no runner heartbeat", async () => {
    const attemptId = crypto.randomUUID();
    const runId = await insertWorkflowRow(
      { number: 1010 },
      "daemon",
      `workflow-runner:${attemptId}`,
      "running",
    );
    await requireSql()`
      UPDATE workflow_runs
         SET attempt_id = ${attemptId},
             lease_expires_at = now() + interval '2 minutes',
             attempt_deadline_at = now() + interval '70 minutes'
       WHERE id = ${runId}
    `;

    const { reapOnce } = await import("../../src/orchestrator/liveness-reaper");
    const result = await reapOnce(requireSql());

    expect(result.workflowRunsReaped.map((row) => row.id)).not.toContain(runId);
    const [row] = await requireSql()<
      { status: string }[]
    >`SELECT status FROM workflow_runs WHERE id = ${runId}`;
    expect(row?.status).toBe("running");
  });

  it("atomically fails an expired runner attempt, receipt, parent, and lock", async () => {
    const attemptId = crypto.randomUUID();
    const runnerId = `workflow-runner:${attemptId}`;
    const executionDeliveryId = crypto.randomUUID();
    const [parent] = await requireSql()<{ id: string }[]>`
      INSERT INTO workflow_runs (
        workflow_name, target_type, target_owner, target_repo, target_number,
        status, state
      ) VALUES (
        'ship', 'pr', 'acme', 'repo', 1011, 'running', '{}'::jsonb
      )
      RETURNING id
    `;
    if (parent === undefined) throw new Error("Expected parent fixture");
    const [child] = await requireSql()<{ id: string }[]>`
      INSERT INTO workflow_runs (
        workflow_name, target_type, target_owner, target_repo, target_number,
        parent_run_id, parent_step_index, status, state,
        execution_delivery_id, owner_kind, owner_id, attempt_id, lease_expires_at,
        attempt_deadline_at
      ) VALUES (
        'triage', 'pr', 'acme', 'repo', 1011,
        ${parent.id}, 0, 'running', '{}'::jsonb,
        ${executionDeliveryId}, 'daemon', ${runnerId}, ${attemptId},
        now() - interval '1 second', now() + interval '70 minutes'
      )
      RETURNING id
    `;
    if (child === undefined) throw new Error("Expected child fixture");
    await requireSql()`
      INSERT INTO executions (
        delivery_id, repo_owner, repo_name, entity_number, entity_type,
        event_name, trigger_username, dispatch_mode, dispatch_target, dispatch_reason,
        daemon_id, offer_id, status, started_at
      ) VALUES (
        ${executionDeliveryId}, 'acme', 'repo', 1011, 'pr',
        'issue_comment', 'user', 'workflow-runner', 'workflow-runner', 'workflow-runner',
        ${runnerId}, ${attemptId}, 'running', now()
      )
    `;
    await requireSql()`
      INSERT INTO scheduled_action_state (
        installation_id, owner, repo, action_name,
        in_flight_job_id, in_flight_started_at
      ) VALUES (
        1, 'acme', 'repo', 'expiry-test', ${executionDeliveryId}, now()
      )
    `;

    const { reapOnce } = await import("../../src/orchestrator/liveness-reaper");
    await reapOnce(requireSql());

    const [childAfter] = await requireSql()<
      { status: string; attempt_completed_at: Date | null }[]
    >`SELECT status, attempt_completed_at FROM workflow_runs WHERE id = ${child.id}`;
    const [parentAfter] = await requireSql()<
      { status: string; state: Record<string, unknown> }[]
    >`SELECT status, state FROM workflow_runs WHERE id = ${parent.id}`;
    const [executionAfter] = await requireSql()<
      { status: string; error_message: string | null; result_processed_at: Date | null }[]
    >`
      SELECT status, error_message, result_processed_at
        FROM executions
       WHERE delivery_id = ${executionDeliveryId}
    `;
    const [scheduleAfter] = await requireSql()<{ in_flight_job_id: string | null }[]>`
      SELECT in_flight_job_id
        FROM scheduled_action_state
       WHERE action_name = 'expiry-test'
    `;

    expect(childAfter?.status).toBe("failed");
    expect(childAfter?.attempt_completed_at).toBeInstanceOf(Date);
    expect(parentAfter?.status).toBe("failed");
    expect(parentAfter?.state["failedAtStepIndex"]).toBe(0);
    expect(executionAfter).toMatchObject({
      status: "failed",
      error_message: "Workflow execution lease expired",
    });
    expect(executionAfter?.result_processed_at).toBeInstanceOf(Date);
    expect(scheduleAfter?.in_flight_job_id).toBeNull();
  });

  it("records the immutable deadline reason on the workflow, parent, and execution", async () => {
    const attemptId = crypto.randomUUID();
    const runnerId = `workflow-runner:${attemptId}`;
    const executionDeliveryId = crypto.randomUUID();
    const [parent] = await requireSql()<{ id: string }[]>`
      INSERT INTO workflow_runs (
        workflow_name, target_type, target_owner, target_repo, target_number,
        status, state
      ) VALUES ('ship', 'pr', 'acme', 'repo', 1014, 'running', '{}'::jsonb)
      RETURNING id
    `;
    if (parent === undefined) throw new Error("Expected deadline parent fixture");
    const [child] = await requireSql()<{ id: string }[]>`
      INSERT INTO workflow_runs (
        workflow_name, target_type, target_owner, target_repo, target_number,
        parent_run_id, parent_step_index, status, state,
        execution_delivery_id, owner_kind, owner_id, attempt_id, lease_expires_at,
        attempt_deadline_at
      ) VALUES (
        'review', 'pr', 'acme', 'repo', 1014,
        ${parent.id}, 2, 'running', '{}'::jsonb,
        ${executionDeliveryId}, 'daemon', ${runnerId}, ${attemptId},
        now() + interval '2 minutes', now() - interval '1 second'
      )
      RETURNING id
    `;
    if (child === undefined) throw new Error("Expected deadline child fixture");
    await requireSql()`
      INSERT INTO executions (
        delivery_id, repo_owner, repo_name, entity_number, entity_type,
        event_name, trigger_username, dispatch_mode, dispatch_target, dispatch_reason,
        daemon_id, offer_id, status, started_at
      ) VALUES (
        ${executionDeliveryId}, 'acme', 'repo', 1014, 'pr',
        'issue_comment', 'user', 'workflow-runner', 'workflow-runner', 'workflow-runner',
        ${runnerId}, ${attemptId}, 'running', now()
      )
    `;

    const { reapOnce } = await import("../../src/orchestrator/liveness-reaper");
    await reapOnce(requireSql());

    const [childAfter] = await requireSql()<
      { status: string; state: Record<string, unknown> }[]
    >`SELECT status, state FROM workflow_runs WHERE id = ${child.id}`;
    const [parentAfter] = await requireSql()<
      { status: string; state: Record<string, unknown> }[]
    >`SELECT status, state FROM workflow_runs WHERE id = ${parent.id}`;
    const [executionAfter] = await requireSql()<
      { status: string; error_message: string | null }[]
    >`SELECT status, error_message FROM executions WHERE delivery_id = ${executionDeliveryId}`;
    expect(childAfter).toMatchObject({
      status: "failed",
      state: {
        failedReason: "workflow execution deadline expired",
        phase: "deadline-expired",
      },
    });
    expect(parentAfter).toMatchObject({
      status: "failed",
      state: {
        failedAtStepIndex: 2,
        failedReason: "workflow execution deadline expired",
      },
    });
    expect(executionAfter).toEqual({
      status: "failed",
      error_message: "Workflow execution deadline expired",
    });
  });

  it("terminalizes an over-age queued dispatch and releases its durable lock", async () => {
    const { config } = await import("../../src/config");
    const deliveryId = crypto.randomUUID();
    const [parent] = await requireSql()<{ id: string }[]>`
      INSERT INTO workflow_runs (
        workflow_name, target_type, target_owner, target_repo, target_number,
        status, state
      ) VALUES ('ship', 'issue', 'acme', 'repo', 1015, 'running', '{}'::jsonb)
      RETURNING id
    `;
    if (parent === undefined) throw new Error("Expected queued-expiry parent fixture");
    const [child] = await requireSql()<{ id: string }[]>`
      INSERT INTO workflow_runs (
        workflow_name, target_type, target_owner, target_repo, target_number,
        parent_run_id, parent_step_index, status, state, execution_delivery_id,
        owner_kind, owner_id, created_at
      ) VALUES (
        'review', 'pr', 'acme', 'repo', 1015,
        ${parent.id}, 3, 'queued', '{}'::jsonb, ${deliveryId},
        NULL, NULL,
        now() - ${config.workflowDispatchTimeoutMs + 1_000} * interval '1 millisecond'
      )
      RETURNING id
    `;
    if (child === undefined) throw new Error("Expected queued-expiry child fixture");
    await requireSql()`
      INSERT INTO executions (
        delivery_id, repo_owner, repo_name, entity_number, entity_type,
        event_name, trigger_username, dispatch_mode, dispatch_target, dispatch_reason, status
      ) VALUES (
        ${deliveryId}, 'acme', 'repo', 1015, 'pr',
        'issue_comment', 'user', 'workflow-runner', 'workflow-runner', 'workflow-runner', 'queued'
      )
    `;
    await requireSql()`
      INSERT INTO scheduled_action_state (
        installation_id, owner, repo, action_name, in_flight_job_id, in_flight_started_at
      ) VALUES (1, 'acme', 'repo', 'dispatch-expiry-test', ${deliveryId}, now())
    `;

    const { reapOnce } = await import("../../src/orchestrator/liveness-reaper");
    await reapOnce(requireSql());

    const [childAfter] = await requireSql()<
      { status: string; state: Record<string, unknown>; attempt_completed_at: Date | null }[]
    >`SELECT status, state, attempt_completed_at FROM workflow_runs WHERE id = ${child.id}`;
    const [parentAfter] = await requireSql()<
      { status: string; state: Record<string, unknown> }[]
    >`SELECT status, state FROM workflow_runs WHERE id = ${parent.id}`;
    const [executionAfter] = await requireSql()<
      { status: string; error_message: string | null; result_processed_at: Date | null }[]
    >`SELECT status, error_message, result_processed_at FROM executions WHERE delivery_id = ${deliveryId}`;
    const [scheduleAfter] = await requireSql()<{ in_flight_job_id: string | null }[]>`
      SELECT in_flight_job_id
        FROM scheduled_action_state
       WHERE action_name = 'dispatch-expiry-test'
    `;
    expect(childAfter).toMatchObject({
      status: "failed",
      state: {
        failedReason: "workflow dispatch deadline expired",
        phase: "dispatch-expired",
      },
      attempt_completed_at: expect.any(Date),
    });
    expect(parentAfter).toMatchObject({
      status: "failed",
      state: {
        failedAtStepIndex: 3,
        failedReason: "workflow dispatch deadline expired",
      },
    });
    expect(executionAfter).toMatchObject({
      status: "failed",
      error_message: "Workflow dispatch deadline expired",
      result_processed_at: expect.any(Date),
    });
    expect(scheduleAfter?.in_flight_job_id).toBeNull();
  });

  it("atomically fails the exact execution and lock for a heartbeat-reaped daemon owner", async () => {
    const deliveryId = crypto.randomUUID();
    const daemonId = "daemon-dead-with-receipt";
    const [run] = await requireSql()<{ id: string }[]>`
      INSERT INTO workflow_runs (
        workflow_name, target_type, target_owner, target_repo, target_number,
        status, state, execution_delivery_id, owner_kind, owner_id
      ) VALUES (
        'review', 'pr', 'acme', 'repo', 1012,
        'running', '{}'::jsonb, ${deliveryId}, 'daemon', ${daemonId}
      )
      RETURNING id
    `;
    if (run === undefined) throw new Error("Expected workflow fixture");
    await requireSql()`
      INSERT INTO executions (
        delivery_id, repo_owner, repo_name, entity_number, entity_type,
        event_name, trigger_username, dispatch_mode, dispatch_target, dispatch_reason,
        daemon_id, status, started_at
      ) VALUES (
        ${deliveryId}, 'acme', 'repo', 1012, 'pr',
        'issue_comment', 'user', 'daemon', 'daemon', 'persistent-daemon',
        ${daemonId}, 'running', now()
      )
    `;
    await requireSql()`
      INSERT INTO scheduled_action_state (
        installation_id, owner, repo, action_name,
        in_flight_job_id, in_flight_started_at
      ) VALUES (1, 'acme', 'repo', 'dead-daemon-test', ${deliveryId}, now())
    `;

    const { reapOnce } = await import("../../src/orchestrator/liveness-reaper");
    await reapOnce(requireSql());

    const [workflow] = await requireSql()<{ status: string }[]>`
      SELECT status FROM workflow_runs WHERE id = ${run.id}
    `;
    const [execution] = await requireSql()<
      { status: string; error_message: string | null }[]
    >`SELECT status, error_message FROM executions WHERE delivery_id = ${deliveryId}`;
    const [schedule] = await requireSql()<{ in_flight_job_id: string | null }[]>`
      SELECT in_flight_job_id FROM scheduled_action_state WHERE action_name = 'dead-daemon-test'
    `;
    expect(workflow?.status).toBe("failed");
    expect(execution).toEqual({
      status: "failed",
      error_message: "Owning daemon is no longer alive",
    });
    expect(schedule?.in_flight_job_id).toBeNull();
  });

  it("ignores rows in terminal status and rows with NULL owner_kind", async () => {
    // No live heartbeats at all → would reap everything reapable.
    await insertWorkflowRow({ number: 1005 }, "orchestrator", "orch-x", "succeeded");
    const legacyRows: { id: string }[] = await requireSql()`
      INSERT INTO workflow_runs (
        workflow_name, target_type, target_owner, target_repo, target_number,
        status, state
      ) VALUES (
        'triage', 'issue', 'acme', 'repo', 1006,
        'queued', '{}'::jsonb
      )
      RETURNING id
    `;
    const legacyId = legacyRows[0]?.id;

    const { reapOnce } = await import("../../src/orchestrator/liveness-reaper");
    const result = await reapOnce(requireSql());

    expect(result.workflowRunsReaped).toHaveLength(0);

    const [legacyRow] = await requireSql()<
      { status: string }[]
    >`SELECT status FROM workflow_runs WHERE id = ${legacyId ?? ""}`;
    expect(legacyRow?.status).toBe("queued");
  });

  it("flips daemons-table rows whose Valkey heartbeat is missing", async () => {
    await setDaemonAlive("daemon-alive-2");
    await requireSql()`
      INSERT INTO daemons (id, hostname, platform, os_version, capabilities, resources, status, first_seen_at, last_seen_at)
      VALUES
        ('daemon-alive-2', 'h', 'linux', '6', '{}'::jsonb, '{}'::jsonb, 'active', now(), now()),
        ('daemon-dead-2', 'h', 'linux', '6', '{}'::jsonb, '{}'::jsonb, 'active', now(), now())
    `;

    const { reapOnce } = await import("../../src/orchestrator/liveness-reaper");
    const result = await reapOnce(requireSql());

    expect(result.daemonsMarkedInactive).toBe(1);

    const rows: { id: string; status: string }[] =
      await requireSql()`SELECT id, status FROM daemons ORDER BY id`;
    expect(rows).toEqual([
      { id: "daemon-alive-2", status: "active" },
      { id: "daemon-dead-2", status: "inactive" },
    ]);
  });

  it("with zero live owners: reaps every in-flight row of that kind", async () => {
    const a = await insertWorkflowRow({ number: 1007 }, "orchestrator", "orch-1");
    const b = await insertWorkflowRow({ number: 1008 }, "orchestrator", "orch-2");

    const { reapOnce } = await import("../../src/orchestrator/liveness-reaper");
    const result = await reapOnce(requireSql());

    const reapedIds = result.workflowRunsReaped.map((r) => r.id).sort();
    expect(reapedIds).toEqual([a, b].sort());
  });
});
