import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

import type { DaemonInfo } from "../../src/shared/daemon-types";

const TEST_DATABASE_URL =
  process.env["TEST_DATABASE_URL"] ?? "postgres://bot:bot@localhost:55432/github_app_test";
const originalDatabaseUrl = process.env["DATABASE_URL"];
process.env["DATABASE_URL"] = TEST_DATABASE_URL;

const connections = new Map<string, { sendText: ReturnType<typeof mock> }>();
const daemonInfo = new Map<string, DaemonInfo>();
let activeDaemonIds: string[] = [];

void mock.module("../../src/orchestrator/connection-handler", () => ({
  getConnections: () => connections,
  getDaemonInfo: (id: string) => daemonInfo.get(id),
  isDaemonDraining: () => false,
}));
void mock.module("../../src/orchestrator/daemon-registry", () => ({
  getActiveDaemons: () => Promise.resolve(activeDaemonIds),
  getDaemonActiveJobs: () => Promise.resolve(0),
  decrementDaemonActiveJobs: () => Promise.resolve(),
}));

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

describe.skipIf(sql === null)("daemon disconnect incarnation lifecycle", () => {
  beforeAll(async () => {
    await resetSchema();
    const { runMigrations } = await import("../../src/db/migrate");
    await runMigrations(requireSql());
  });

  afterAll(async () => {
    const { closeDb } = await import("../../src/db");
    await closeDb();
    await resetSchema();
    await requireSql().close();
    if (originalDatabaseUrl === undefined) Reflect.deleteProperty(process.env, "DATABASE_URL");
    else process.env["DATABASE_URL"] = originalDatabaseUrl;
  });

  it("fences the old Pod incarnation before a same-Pod replacement receives redispatch", async () => {
    const oldDaemon = `daemon-github-app-daemon-pod-${crypto.randomUUID()}`;
    const newDaemon = `daemon-github-app-daemon-pod-${crypto.randomUUID()}`;
    const oldDelivery = crypto.randomUUID();
    const replacementDelivery = crypto.randomUUID();
    const { createExecution, failDisconnectedDaemon } =
      await import("../../src/orchestrator/history");
    const { dispatchJob, getPendingOffer, removePendingOffer } =
      await import("../../src/orchestrator/job-dispatcher");
    const { findPendingWorkflowFailureNotifications, insertQueued, markWorkflowFailureNotified } =
      await import("../../src/workflows/runs-store");

    await requireSql()`
      INSERT INTO daemons (
        id, hostname, platform, os_version, capabilities, resources, status,
        first_seen_at, last_seen_at
      ) VALUES
        (${oldDaemon}, 'github-app-daemon-pod', 'linux', '6', '{}'::jsonb, '{}'::jsonb,
         'active', now(), now()),
        (${newDaemon}, 'github-app-daemon-pod', 'linux', '6', '{}'::jsonb, '{}'::jsonb,
         'active', now(), now())
    `;
    await createExecution(
      {
        deliveryId: oldDelivery,
        repoOwner: "acme",
        repoName: "widgets",
        entityNumber: 16,
        entityType: "issue",
        eventName: "issue_comment",
        triggerUsername: "maintainer",
        dispatchMode: "daemon",
        dispatchTarget: "daemon",
        dispatchReason: "persistent-daemon",
      },
      requireSql(),
    );
    const oldRun = await insertQueued(
      {
        workflowName: "triage",
        target: { type: "issue", owner: "acme", repo: "widgets", number: 16 },
        executionDeliveryId: oldDelivery,
        ownerKind: "daemon",
        ownerId: oldDaemon,
      },
      requireSql(),
    );
    await requireSql()`
      UPDATE workflow_runs
         SET status = 'running'
       WHERE id = ${oldRun.id}
    `;
    await requireSql()`
      UPDATE executions
         SET status = 'running', daemon_id = ${oldDaemon}, started_at = now()
       WHERE delivery_id = ${oldDelivery}
    `;
    await requireSql()`
      INSERT INTO scheduled_action_state (
        installation_id, owner, repo, action_name, in_flight_job_id, in_flight_started_at
      ) VALUES (1, 'acme', 'widgets', 'disconnect-test', ${oldDelivery}, now())
    `;

    const failed = await failDisconnectedDaemon(oldDaemon, requireSql());
    expect(failed.executionDeliveryIds).toContain(oldDelivery);
    expect(failed.workflowRunIds).toContain(oldRun.id);
    expect(await findPendingWorkflowFailureNotifications(requireSql())).toEqual([
      expect.objectContaining({
        phase: "orphaned",
        row: expect.objectContaining({ id: oldRun.id, attempt_id: null }),
      }),
    ]);
    expect(
      await markWorkflowFailureNotified({ runId: oldRun.id, attemptId: null }, requireSql()),
    ).toBe(true);
    expect(await findPendingWorkflowFailureNotifications(requireSql())).toEqual([]);

    const activeOld: { count: number }[] = await requireSql()`
      SELECT count(*)::int AS count
        FROM executions
       WHERE daemon_id = ${oldDaemon}
         AND status IN ('queued', 'offered', 'running')
    `;
    expect(activeOld[0]?.count).toBe(0);
    const activeRuns: { count: number }[] = await requireSql()`
      SELECT count(*)::int AS count
        FROM workflow_runs
       WHERE owner_id = ${oldDaemon}
         AND status IN ('queued', 'running')
    `;
    expect(activeRuns[0]?.count).toBe(0);
    const locks: { in_flight_job_id: string | null }[] = await requireSql()`
      SELECT in_flight_job_id FROM scheduled_action_state WHERE action_name = 'disconnect-test'
    `;
    expect(locks[0]?.in_flight_job_id).toBeNull();

    await createExecution(
      {
        deliveryId: replacementDelivery,
        repoOwner: "acme",
        repoName: "widgets",
        entityNumber: 16,
        entityType: "issue",
        eventName: "issue_comment",
        triggerUsername: "maintainer",
        dispatchMode: "daemon",
        dispatchTarget: "daemon",
        dispatchReason: "persistent-daemon",
      },
      requireSql(),
    );
    const retryRun = await insertQueued(
      {
        workflowName: "triage",
        target: { type: "issue", owner: "acme", repo: "widgets", number: 16 },
        executionDeliveryId: replacementDelivery,
        ownerKind: "orchestrator",
        ownerId: "replacement-controller",
      },
      requireSql(),
    );
    expect(retryRun.status).toBe("queued");

    const sendText = mock(() => 1);
    connections.set(newDaemon, { sendText });
    activeDaemonIds = [newDaemon];
    daemonInfo.set(newDaemon, {
      id: newDaemon,
      hostname: "github-app-daemon-pod",
      platform: "linux",
      osVersion: "6",
      capabilities: {
        platform: "linux",
        shells: [{ name: "bash", path: "/bin/bash", version: "5", functional: true }],
        packageManagers: [
          { name: "bun", path: "/usr/bin/bun", version: "1.3.14", functional: true },
        ],
        cliTools: [
          { name: "git", path: "/usr/bin/git", version: "2", functional: true },
          { name: "node", path: "/usr/bin/node", version: "24", functional: true },
        ],
        containerRuntime: null,
        authContexts: [],
        resources: {
          cpuCount: 2,
          memoryTotalMb: 4096,
          memoryFreeMb: 2048,
          diskFreeMb: 10_000,
        },
        network: { hostname: "github-app-daemon-pod" },
        cachedRepos: [],
        ephemeral: false,
        maxUptimeMs: null,
      },
      status: "active",
      protocolVersion: "1.0.0",
      appVersion: "test",
      activeJobs: 0,
      lastSeenAt: Date.now(),
      firstSeenAt: Date.now(),
    });
    const replacementJob = {
      kind: "legacy" as const,
      deliveryId: replacementDelivery,
      repoOwner: "acme",
      repoName: "widgets",
      entityNumber: 16,
      isPR: false,
      eventName: "issue_comment",
      triggerUsername: "maintainer",
      labels: [],
      triggerBodyPreview: "retry after daemon restart",
      enqueuedAt: Date.now(),
      retryCount: 0,
    };

    expect(await dispatchJob(replacementJob)).toBe(true);
    const frame = JSON.parse(String(sendText.mock.calls[0]?.[0])) as {
      id: string;
      type: string;
      payload: { deliveryId: string };
    };
    expect(frame).toMatchObject({
      type: "job:offer",
      payload: { deliveryId: replacementDelivery },
    });
    const [replacementReceipt] = await requireSql()<
      { status: string; daemon_id: string | null }[]
    >`SELECT status, daemon_id FROM executions WHERE delivery_id = ${replacementDelivery}`;
    expect(replacementReceipt).toEqual({ status: "offered", daemon_id: newDaemon });
    expect(getPendingOffer(frame.id)?.daemonId).toBe(newDaemon);
    removePendingOffer(frame.id);
  });

  it("terminalizes a composite parent owned by another daemon", async () => {
    const parentDaemon = `daemon-parent-${crypto.randomUUID()}`;
    const childDaemon = `daemon-child-${crypto.randomUUID()}`;
    const childDelivery = crypto.randomUUID();
    const { createExecution, failDisconnectedDaemon } =
      await import("../../src/orchestrator/history");
    const { findPendingWorkflowFailureNotifications, insertQueued } =
      await import("../../src/workflows/runs-store");

    await requireSql()`
      INSERT INTO daemons (
        id, hostname, platform, os_version, capabilities, resources, status,
        first_seen_at, last_seen_at
      ) VALUES
        (${parentDaemon}, 'parent-host', 'linux', '6', '{}'::jsonb, '{}'::jsonb,
         'active', now(), now()),
        (${childDaemon}, 'child-host', 'linux', '6', '{}'::jsonb, '{}'::jsonb,
         'active', now(), now())
    `;
    const parent = await insertQueued(
      {
        workflowName: "ship",
        target: { type: "issue", owner: "acme", repo: "widgets", number: 17 },
        ownerKind: "daemon",
        ownerId: parentDaemon,
      },
      requireSql(),
    );
    await requireSql()`UPDATE workflow_runs SET status = 'running' WHERE id = ${parent.id}`;

    await createExecution(
      {
        deliveryId: childDelivery,
        repoOwner: "acme",
        repoName: "widgets",
        entityNumber: 1701,
        entityType: "pull_request",
        eventName: "issue_comment",
        triggerUsername: "maintainer",
        dispatchMode: "daemon",
        dispatchTarget: "daemon",
        dispatchReason: "persistent-daemon",
      },
      requireSql(),
    );
    const child = await insertQueued(
      {
        workflowName: "review",
        target: { type: "pr", owner: "acme", repo: "widgets", number: 1701 },
        parentRunId: parent.id,
        parentStepIndex: 3,
        executionDeliveryId: childDelivery,
        ownerKind: "daemon",
        ownerId: childDaemon,
      },
      requireSql(),
    );
    await requireSql()`
      UPDATE workflow_runs SET status = 'running' WHERE id = ${child.id}
    `;
    await requireSql()`
      UPDATE executions
         SET status = 'running', daemon_id = ${childDaemon}, started_at = now()
       WHERE delivery_id = ${childDelivery}
    `;

    const failed = await failDisconnectedDaemon(childDaemon, requireSql());

    expect(failed.workflowRunIds).toEqual(expect.arrayContaining([child.id, parent.id]));
    const [parentAfter] = await requireSql()<
      { status: string; state: Record<string, unknown>; attempt_completed_at: Date | null }[]
    >`
      SELECT status, state, attempt_completed_at FROM workflow_runs WHERE id = ${parent.id}
    `;
    const [childAfter] = await requireSql()<{ status: string }[]>`
      SELECT status FROM workflow_runs WHERE id = ${child.id}
    `;
    expect(parentAfter).toMatchObject({
      status: "failed",
      state: {
        phase: "orphaned",
        failedAtStepIndex: 3,
        failedReason: "daemon disconnected during execution",
      },
      attempt_completed_at: expect.any(Date),
    });
    expect(childAfter?.status).toBe("failed");
    const pending = await findPendingWorkflowFailureNotifications(requireSql());
    expect(pending).toHaveLength(2);
    expect(pending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "orphaned",
          row: expect.objectContaining({ id: child.id }),
        }),
        expect.objectContaining({
          phase: "orphaned",
          row: expect.objectContaining({ id: parent.id }),
        }),
      ]),
    );

    const retry = await insertQueued(
      {
        workflowName: "ship",
        target: { type: "issue", owner: "acme", repo: "widgets", number: 17 },
        ownerKind: "orchestrator",
        ownerId: "replacement-controller",
      },
      requireSql(),
    );
    expect(retry.status).toBe("queued");
  });
});
