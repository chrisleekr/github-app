/**
 * Integration tests for the composite `ship` handler (T027, T028).
 *
 * The handler's core job is deciding `startIndex`: which step of
 * `triage → plan → implement → review → resolve` to enqueue first when a `bot:ship`
 * parent is launched. This is driven by the staleness rules in
 * `contracts/handoff-protocol.md` §Skip-if-output-exists.
 *
 *   T027: Resume after failure: parent failed at step 2 → on re-apply,
 *          the new parent enqueues at index 2 and carries prior step run
 *          ids through `state.stepRuns`.
 *   T028: Open-PR shortcut (FR-020): prior successful `implement` run
 *          whose recorded PR is still open → skip straight to step 3
 *          (`review`). The downstream `resolve` step (index 4) is
 *          enqueued by the orchestrator after `review` completes,
 *          covered separately in orchestrator.test.ts.
 *
 * Downstream writes (`enqueueJob`, `tracking-mirror`) are mocked; the
 * staleness check and the `stepRuns` bookkeeping are exercised against a
 * real Postgres database to catch any regression in the SQL round-trips.
 */

import { SQL } from "bun";
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";
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

// ─── Mocks ───────────────────────────────────────────────────────────────

const mockEnqueueJob = mock(() => Promise.resolve());
void mock.module("../../../src/orchestrator/job-queue", () => ({
  enqueueJob: mockEnqueueJob,
  isScopedJob: () => false,
  SCOPED_JOB_KINDS: ["scoped-rebase", "scoped-fix-thread", "scoped-open-pr"],
}));

void mock.module("../../../src/workflows/execution-row", () => ({
  recordWorkflowExecution: mock(() => Promise.resolve()),
  buildWorkflowContextJson: mock(() => ({})),
}));

void mock.module("../../../src/orchestrator/concurrency", () => ({
  incrementActiveCount: mock(() => {}),
  decrementActiveCount: mock(() => {}),
}));

void mock.module("../../../src/workflows/tracking-mirror", () => ({
  setState: mock(() => Promise.resolve()),
  postRefusalComment: mock(() => Promise.resolve()),
}));

void mock.module("../../../src/db", () => ({
  requireDb: () => requireSql(),
  getDb: () => requireSql(),
  closeDb: () => Promise.resolve(),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────

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

function buildOctokit(prState: "open" | "closed" | "throw"): Octokit {
  return {
    rest: {
      pulls: {
        get: mock(() => {
          if (prState === "throw") {
            return Promise.reject(new Error("404 not found"));
          }
          return Promise.resolve({ data: { state: prState } });
        }),
      },
    },
  } as unknown as Octokit;
}

// Warm the registry module graph BEFORE touching ship.ts. There is a
// circular-import trap: `src/workflows/handlers/ship.ts` imports `getByName`
// from `../registry`, and registry.ts eagerly references the ship handler
// in its top-level `rawRegistry`. If the test imports ship.ts first, the
// circular chain re-enters registry while ship.ts's `export const handler`
// binding is still in TDZ, and `RegistrySchema.parse(rawRegistry)` explodes
// with `Cannot access 'shipHandler' before initialization`. Importing
// registry first lets the chain resolve via the production path.
await import("../../../src/workflows/registry");
const { handler: shipHandler } = await import("../../../src/workflows/handlers/ship");

async function seedSucceededRun(params: {
  workflowName: "triage" | "plan" | "implement";
  target: { owner: string; repo: string; number: number };
  state: Record<string, unknown>;
}): Promise<{ runId: string }> {
  const { insertQueued, markSucceeded } = await import("../../../src/workflows/runs-store");
  const row = await insertQueued(
    {
      workflowName: params.workflowName,
      target: { type: "issue" as const, ...params.target },
      initialState: {},
      ownerKind: "orchestrator",
      ownerId: "test-orchestrator",
    },
    requireSql(),
  );
  await markSucceeded(row.id, params.state, requireSql());
  // Small tick so subsequent rows get a strictly-later created_at.
  await new Promise((resolve) => setTimeout(resolve, 5));
  return { runId: row.id };
}

describe.skipIf(sql === null)("ship handler", () => {
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

  it("T027 resume: prior triage + plan succeeded, implement previously failed → startIndex=2 with prior step runs carried forward", async () => {
    const { insertQueued, markFailed } = await import("../../../src/workflows/runs-store");

    const targetOwner = "acme";
    const targetRepo = "repo";
    const targetNumber = 301;

    // Seed prior succeeded triage + plan.
    const { runId: triageRunId } = await seedSucceededRun({
      workflowName: "triage",
      target: { owner: targetOwner, repo: targetRepo, number: targetNumber },
      state: { verdict: "bug", recommendedNext: "plan" },
    });
    const { runId: planRunId } = await seedSucceededRun({
      workflowName: "plan",
      target: { owner: targetOwner, repo: targetRepo, number: targetNumber },
      state: { planWritten: true },
    });
    // Seed an implement that FAILED previously (not a succeeded row → stale).
    const implementPrior = await insertQueued(
      {
        workflowName: "implement",
        target: {
          type: "issue",
          owner: targetOwner,
          repo: targetRepo,
          number: targetNumber,
        },
        initialState: {},
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );
    await markFailed(implementPrior.id, "merge conflict", {}, requireSql());

    // New parent ship row representing the re-apply of `bot:ship`.
    const parent = await insertQueued(
      {
        workflowName: "ship",
        target: {
          type: "issue",
          owner: targetOwner,
          repo: targetRepo,
          number: targetNumber,
        },
        initialState: { currentStepIndex: 0, stepRuns: [] },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );

    const setStateMock = mock(async () => Promise.resolve());
    const result = await shipHandler({
      runId: parent.id,
      workflowName: "ship",
      target: {
        type: "issue",
        owner: targetOwner,
        repo: targetRepo,
        number: targetNumber,
      },
      logger: silentLogger(),
      octokit: buildOctokit("open"),
      deliveryId: "delivery-301",
      setState: setStateMock,
    });

    expect(result.status).toBe("handed-off");
    if (result.status !== "handed-off") throw new Error("expected handed-off");
    const state = result.state as { currentStepIndex: number; stepRuns: string[] };
    expect(state.currentStepIndex).toBe(2);
    expect(state.stepRuns).toEqual([triageRunId, planRunId]);

    // Enqueue must be for the `implement` step, not triage or plan.
    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
    const call = mockEnqueueJob.mock.calls[0]?.[0] as
      | { workflowRun: { workflowName: string; parentStepIndex: number } }
      | undefined;
    expect(call?.workflowRun.workflowName).toBe("implement");
    expect(call?.workflowRun.parentStepIndex).toBe(2);

    expect(setStateMock).toHaveBeenCalledTimes(1);
  });

  it("T028 open-PR case (FR-020): prior implement succeeded with an open PR → skip straight to review", async () => {
    const { insertQueued } = await import("../../../src/workflows/runs-store");

    const targetOwner = "acme";
    const targetRepo = "repo";
    const targetNumber = 302;

    const { runId: triageRunId } = await seedSucceededRun({
      workflowName: "triage",
      target: { owner: targetOwner, repo: targetRepo, number: targetNumber },
      state: { verdict: "feature", recommendedNext: "plan" },
    });
    const { runId: planRunId } = await seedSucceededRun({
      workflowName: "plan",
      target: { owner: targetOwner, repo: targetRepo, number: targetNumber },
      state: { planWritten: true },
    });
    const { runId: implementRunId } = await seedSucceededRun({
      workflowName: "implement",
      target: { owner: targetOwner, repo: targetRepo, number: targetNumber },
      state: { pr_number: 999 },
    });

    const parent = await insertQueued(
      {
        workflowName: "ship",
        target: {
          type: "issue",
          owner: targetOwner,
          repo: targetRepo,
          number: targetNumber,
        },
        initialState: { currentStepIndex: 0, stepRuns: [] },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );

    const octokitOpen = buildOctokit("open");
    const setStateMock = mock(async () => Promise.resolve());

    const result = await shipHandler({
      runId: parent.id,
      workflowName: "ship",
      target: {
        type: "issue",
        owner: targetOwner,
        repo: targetRepo,
        number: targetNumber,
      },
      logger: silentLogger(),
      octokit: octokitOpen,
      deliveryId: "delivery-302",
      setState: setStateMock,
    });

    expect(result.status).toBe("handed-off");
    if (result.status !== "handed-off") throw new Error("expected handed-off");
    const state = result.state as { currentStepIndex: number; stepRuns: string[] };
    expect(state.currentStepIndex).toBe(3);
    expect(state.stepRuns).toEqual([triageRunId, planRunId, implementRunId]);

    // PR state was verified via the live octokit call.
    const pullsGet = (octokitOpen.rest.pulls.get as unknown as ReturnType<typeof mock>).mock;
    expect(pullsGet.calls.length).toBe(1);
    expect(pullsGet.calls[0]?.[0]).toMatchObject({
      owner: targetOwner,
      repo: targetRepo,
      pull_number: 999,
    });

    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
    const call = mockEnqueueJob.mock.calls[0]?.[0] as
      | { workflowRun: { workflowName: string; parentStepIndex: number } }
      | undefined;
    expect(call?.workflowRun.workflowName).toBe("review");
    expect(call?.workflowRun.parentStepIndex).toBe(3);
  });
});
