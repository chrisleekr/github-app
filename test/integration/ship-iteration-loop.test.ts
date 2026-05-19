/**
 * T011 + T015: full round-trip for the ship-iteration handler against
 * real Postgres + real Valkey. Asserts:
 *
 *   - `runIteration` inserts a `workflow_runs` row whose `state.shipIntentId`
 *     matches the seeded intent and whose `workflow_name` matches the
 *     mapping selected by the verdict reason.
 *   - `enqueueJob` LPUSHes a `workflow-run` job carrying the same `runId`
 *     and `workflowName` (visible via `tryDequeueJob`).
 *   - `appendIteration` writes one `probe` row + one action row.
 *   - **T015**: when the run terminates `succeeded`, `onStepComplete`'s
 *     early-wake cascade ZADDs `ship:tickle` at score=0 for the intent.
 *
 * Skips cleanly when either dependency is unavailable.
 */

import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";

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

// Route every requireDb() call site (including the orchestrator cascade
// inside onStepComplete) through the same connection the test seeds with,
// so the early-wake hook can SELECT the child row we just inserted.
void mock.module("../../src/db", () => ({
  requireDb: () => requireSql(),
  getDb: () => requireSql(),
  closeDb: () => Promise.resolve(),
}));

// Lazily connect to Valkey so a missing dev:deps stack doesn't prevent
// `bun test` from collecting other suites.
let valkeyAvailable: boolean;
try {
  const { connectValkey, isValkeyHealthy } = await import("../../src/orchestrator/valkey");
  await connectValkey(2000);
  valkeyAvailable = isValkeyHealthy();
} catch {
  valkeyAvailable = false;
}

const skipSuite = sql === null || !valkeyAvailable;

describe.skipIf(skipSuite)("integration: ship-iteration loop end-to-end", () => {
  beforeAll(async () => {
    const db = requireSql();
    await db.unsafe(`
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
    await runMigrations(db);

    // Clear Valkey state owned by this suite so re-runs don't see stale
    // queue/tickle entries from a previous failed run.
    const { requireValkeyClient } = await import("../../src/orchestrator/valkey");
    const valkey = requireValkeyClient();
    await valkey.send("DEL", ["queue:jobs"]);
    await valkey.send("DEL", ["ship:tickle"]);
  });

  afterAll(async () => {
    if (sql !== null) {
      await sql.unsafe(`
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
      await sql.close();
    }
    const { closeValkey } = await import("../../src/orchestrator/valkey");
    closeValkey();
  });

  it("non-ready verdict drives an enqueue and a cascade ZADD on completion", async () => {
    const db = requireSql();
    const { insertIntent } = await import("../../src/db/queries/ship");
    const { runIteration } = await import("../../src/workflows/ship/iteration");
    const { tryDequeueJob } = await import("../../src/orchestrator/job-queue");
    const { onStepComplete } = await import("../../src/workflows/orchestrator");
    const { requireValkeyClient } = await import("../../src/orchestrator/valkey");

    const intent = await insertIntent(
      {
        installation_id: 9001,
        owner: "loop-it",
        repo: "fixtures",
        pr_number: 4242,
        target_base_sha: "base-sha",
        target_head_sha: "head-sha",
        deadline_at: new Date(Date.now() + 60 * 60 * 1000),
        created_by_user: "tester",
        tracking_comment_marker: "<!-- ship-intent: pending -->",
      },
      db,
    );

    const verdict = {
      ready: false as const,
      reason: "open_threads" as const,
      summary: "one open thread",
    };

    const outcome = await runIteration({ intent, probeVerdict: verdict, sql: db });

    expect(outcome.outcome).toBe("enqueued");
    if (outcome.outcome !== "enqueued") return;

    // Postgres side: workflow_runs row carries the intent id in state JSONB
    const runRows: { id: string; state: { shipIntentId?: string }; workflow_name: string }[] =
      await db`SELECT id, state, workflow_name FROM workflow_runs WHERE id = ${outcome.runId}`;
    expect(runRows[0]?.state.shipIntentId).toBe(intent.id);
    expect(runRows[0]?.workflow_name).toBe(outcome.workflowName);

    // Valkey side: queue:jobs LPUSH'd a workflow-run kind with the matching runId
    const dequeued = await tryDequeueJob();
    expect(dequeued).not.toBeNull();
    if (dequeued !== null && dequeued.kind === "workflow-run") {
      expect(dequeued.workflowRun.runId).toBe(outcome.runId);
      expect(dequeued.workflowRun.workflowName).toBe(outcome.workflowName);
    } else {
      throw new Error(`expected workflow-run kind, got ${String(dequeued?.kind)}`);
    }

    // ship_iterations: one probe row + one action row.
    const iterRows: { kind: string }[] = await db`
      SELECT kind FROM ship_iterations WHERE intent_id = ${intent.id} ORDER BY iteration_n
    `;
    expect(iterRows.map((r) => r.kind)).toEqual(["probe", "resolve"]);

    // T015: cascade fires on succeeded completion → ZADD ship:tickle 0 <intent>
    await db`UPDATE workflow_runs SET status = 'succeeded' WHERE id = ${outcome.runId}`;

    // Octokit/logger stubs: parent_run_id is null on the just-inserted row, so
    // the early-wake hook is the only side-effect path that fires.
    interface StubLogger {
      info: () => void;
      warn: () => void;
      error: () => void;
      debug: () => void;
      child: () => StubLogger;
    }
    const stubLogger: StubLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child(): StubLogger {
        return stubLogger;
      },
    };
    const stubOctokit = {} as unknown as Octokit;

    await onStepComplete(
      {
        octokit: stubOctokit,
        logger: stubLogger as unknown as Parameters<typeof onStepComplete>[0]["logger"],
      },
      outcome.runId,
      { status: "succeeded" },
    );

    const valkey = requireValkeyClient();
    // Bun's RedisClient returns ZSCORE as a number; some Valkey/Redis builds
    // surface it as a string. Normalise so the assertion holds on either.
    const scoreRaw = (await valkey.send("ZSCORE", ["ship:tickle", intent.id])) as
      | string
      | number
      | null;
    expect(scoreRaw).not.toBeNull();
    expect(Number(scoreRaw)).toBe(0);
  });
});
