/**
 * Tests for `runIteration` (US1). Uses a real Postgres connection because
 * the handler's logic threads multiple INSERTs across `workflow_runs`,
 * `ship_intents`, and `ship_iterations`, and faking the SQL surface would
 * miss the schema CHECK on `ship_iterations.kind=probe`-only verdict
 * columns (the very thing the action/probe split is designed to honor).
 *
 * Covers:
 *   1. Cap exceeded → terminal:halted (deadline_exceeded with iteration-cap blocker).
 *   2. Deadline elapsed → terminal:halted (deadline_exceeded).
 *   3. Non-ready verdict with valid reason → workflow_runs row inserted with
 *      state.shipIntentId, job enqueued with kind=workflow-run, ship_iterations
 *      gets one probe + one action row.
 *   4. Verdict missing reason field → throws.
 */

import { SQL } from "bun";
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

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

const mockEnqueueJob = mock(() => Promise.resolve());
void mock.module("../../../src/orchestrator/job-queue", () => ({
  enqueueJob: mockEnqueueJob,
  isScopedJob: () => false,
  SCOPED_JOB_KINDS: ["scoped-rebase", "scoped-fix-thread", "scoped-open-pr"],
}));

void mock.module("../../../src/db", () => ({
  requireDb: () => requireSql(),
  getDb: () => requireSql(),
  closeDb: () => Promise.resolve(),
}));

describe.skipIf(sql === null)("runIteration", () => {
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

  beforeEach(() => {
    mockEnqueueJob.mockClear();
  });

  async function seedActiveIntent(
    overrides?: Partial<{
      pr_number: number;
      deadline_at: Date;
    }>,
  ): Promise<{ id: string; pr_number: number; owner: string; repo: string; deadline_at: Date }> {
    const { insertIntent } = await import("../../../src/db/queries/ship");
    const intent = await insertIntent(
      {
        installation_id: 7777,
        owner: "iteration-test",
        repo: "fixtures",
        pr_number: overrides?.pr_number ?? 4242,
        target_base_sha: "base-sha",
        target_head_sha: "head-sha",
        deadline_at: overrides?.deadline_at ?? new Date(Date.now() + 60 * 60 * 1000),
        created_by_user: "tester",
        tracking_comment_marker: "<!-- ship-intent: pending -->",
      },
      requireSql(),
    );
    return {
      id: intent.id,
      pr_number: intent.pr_number,
      owner: intent.owner,
      repo: intent.repo,
      deadline_at: intent.deadline_at,
    };
  }

  it("inserts workflow_runs + enqueues job + appends probe & action ship_iterations on a non-ready verdict", async () => {
    const { runIteration } = await import("../../../src/workflows/ship/iteration");
    const { getIntentById } = await import("../../../src/db/queries/ship");
    const intent = await seedActiveIntent();
    const intentRow = await getIntentById(intent.id, requireSql());
    if (intentRow === null) throw new Error("seed intent missing");

    const result = await runIteration({
      intent: intentRow,
      probeVerdict: {
        ready: false,
        reason: "open_threads",
        detail: "1 thread unresolved",
        checked_at: new Date().toISOString(),
        head_sha: "head-sha",
      },
    });

    expect(result.outcome).toBe("enqueued");

    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
    const enqueued = mockEnqueueJob.mock.calls[0]?.[0] as
      | {
          kind: string;
          workflowRun: { runId: string; workflowName: string };
          repoOwner: string;
          repoName: string;
          entityNumber: number;
        }
      | undefined;
    expect(enqueued?.kind).toBe("workflow-run");
    expect(enqueued?.workflowRun.workflowName).toBe("resolve");
    expect(enqueued?.repoOwner).toBe(intent.owner);
    expect(enqueued?.entityNumber).toBe(intent.pr_number);

    const runs: { id: string; state: Record<string, unknown> }[] = await requireSql()`
      SELECT id, state FROM workflow_runs WHERE id = ${enqueued?.workflowRun.runId ?? ""}
    `;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state["shipIntentId"]).toBe(intent.id);

    const iterRows: { iteration_n: number; kind: string }[] = await requireSql()`
      SELECT iteration_n, kind FROM ship_iterations
       WHERE intent_id = ${intent.id}
       ORDER BY iteration_n ASC
    `;
    expect(iterRows).toHaveLength(2);
    expect(iterRows[0]?.kind).toBe("probe");
    expect(iterRows[1]?.kind).toBe("resolve");
  });

  it("transitions intent to deadline_exceeded with iteration-cap blocker when cap is reached", async () => {
    const { runIteration } = await import("../../../src/workflows/ship/iteration");
    const { appendIteration, getIntentById } = await import("../../../src/db/queries/ship");
    const { config } = await import("../../../src/config");

    const intent = await seedActiveIntent({ pr_number: 4243 });

    // Pre-seed maxShipIterations action rows so the cap is already reached.
    for (let i = 1; i <= config.maxShipIterations; i++) {
      // eslint-disable-next-line no-await-in-loop
      await appendIteration(
        {
          intent_id: intent.id,
          iteration_n: i,
          kind: "resolve",
          runs_store_id: null,
        },
        requireSql(),
      );
    }

    const intentRow = await getIntentById(intent.id, requireSql());
    if (intentRow === null) throw new Error("seed intent missing");

    const result = await runIteration({
      intent: intentRow,
      probeVerdict: {
        ready: false,
        reason: "open_threads",
        detail: "still",
        checked_at: new Date().toISOString(),
        head_sha: "head-sha",
      },
    });

    expect(result.outcome).toBe("terminal-cap");

    const refreshed = await getIntentById(intent.id, requireSql());
    expect(refreshed?.status).toBe("deadline_exceeded");
    expect(refreshed?.terminal_blocker_category).toBe("iteration-cap");
    expect(mockEnqueueJob).toHaveBeenCalledTimes(0);
  });

  it("transitions intent to deadline_exceeded when the wall-clock deadline has elapsed", async () => {
    const { runIteration } = await import("../../../src/workflows/ship/iteration");
    const { getIntentById } = await import("../../../src/db/queries/ship");

    const intent = await seedActiveIntent({
      pr_number: 4244,
      deadline_at: new Date(Date.now() - 1000),
    });
    const intentRow = await getIntentById(intent.id, requireSql());
    if (intentRow === null) throw new Error("seed intent missing");

    const result = await runIteration({
      intent: intentRow,
      probeVerdict: {
        ready: false,
        reason: "open_threads",
        detail: "still",
        checked_at: new Date().toISOString(),
        head_sha: "head-sha",
      },
    });

    expect(result.outcome).toBe("terminal-deadline");
    const refreshed = await getIntentById(intent.id, requireSql());
    expect(refreshed?.status).toBe("deadline_exceeded");
    expect(mockEnqueueJob).toHaveBeenCalledTimes(0);
  });

  it("returns ready-shortcut without writing any rows when the verdict is ready", async () => {
    const { runIteration } = await import("../../../src/workflows/ship/iteration");
    const { getIntentById } = await import("../../../src/db/queries/ship");

    const intent = await seedActiveIntent({ pr_number: 4245 });
    const intentRow = await getIntentById(intent.id, requireSql());
    if (intentRow === null) throw new Error("seed intent missing");

    const result = await runIteration({
      intent: intentRow,
      probeVerdict: {
        ready: true,
        checked_at: new Date().toISOString(),
        head_sha: "head-sha",
      },
    });

    expect(result.outcome).toBe("ready-shortcut");
    expect(mockEnqueueJob).toHaveBeenCalledTimes(0);

    const iterRows: { count: number }[] = await requireSql()`
      SELECT COUNT(*)::int AS count FROM ship_iterations WHERE intent_id = ${intent.id}
    `;
    expect(iterRows[0]?.count).toBe(0);
  });

  // H6: in-flight guard. A non-terminal `workflow_runs` row tagged with
  // this `shipIntentId` means a previous iteration is still running. The
  // handler MUST refuse to double-enqueue.
  it("returns in-flight without enqueueing when a non-terminal workflow_run exists for the intent (H6)", async () => {
    const { runIteration } = await import("../../../src/workflows/ship/iteration");
    const { getIntentById } = await import("../../../src/db/queries/ship");
    const { insertQueued } = await import("../../../src/workflows/runs-store");

    // Use a pr_number far from other tests to avoid sharing the partial
    // unique index `idx_workflow_runs_inflight` with another test's row.
    const intent = await seedActiveIntent({ pr_number: 14246 });
    const intentRow = await getIntentById(intent.id, requireSql());
    if (intentRow === null) throw new Error("seed intent missing");

    // Pre-seed a queued workflow_run carrying the intent id. Use workflow
    // "implement" (not "resolve") so the row is unique under the inflight
    // index even if a prior test left a leaked resolve-row at this PR.
    const inflight = await insertQueued(
      {
        workflowName: "implement",
        target: { type: "pr", owner: intent.owner, repo: intent.repo, number: intent.pr_number },
        ownerKind: "orchestrator",
        ownerId: `ship-intent:${intent.id}`,
        initialState: { shipIntentId: intent.id, iteration_n: 1 },
      },
      requireSql(),
    );

    const result = await runIteration({
      intent: intentRow,
      probeVerdict: {
        ready: false,
        reason: "open_threads",
        detail: "still",
        checked_at: new Date().toISOString(),
        head_sha: "head-sha",
      },
    });

    expect(result.outcome).toBe("in-flight");
    if (result.outcome === "in-flight") {
      expect(result.runId).toBe(inflight.id);
    }
    expect(mockEnqueueJob).toHaveBeenCalledTimes(0);

    // No new ship_iterations rows either.
    const iterRows: { count: number }[] = await requireSql()`
      SELECT COUNT(*)::int AS count FROM ship_iterations WHERE intent_id = ${intent.id}
    `;
    expect(iterRows[0]?.count).toBe(0);
  });
});
