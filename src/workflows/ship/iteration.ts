/**
 * Ship-iteration handler (US1, T012). Bridges a non-ready probe verdict
 * onto the isolated `workflow_runs` runner pipeline so a single iteration
 * does exactly one of:
 *
 *   - terminate the intent on cap or deadline,
 *   - leave the intent active because the verdict is already ready
 *     (the caller's terminal-shortcut is responsible for the GraphQL mutation),
 *   - or insert a `workflow_runs` row + publish a runner attempt + append a
 *     `ship_iterations` row so the orchestrator's completion cascade can
 *     early-wake the intent for the next iteration.
 *
 * One job per iteration (research.md Q4): the loop runs many iterations
 * rather than packing actions, because each runner attempt mutates PR state
 * and the next probe is the only way to detect that a fix worked.
 *
 * The handler stays inside the `workflow_runs` tree (no new JobKind);
 * `state.shipIntentId` is the single signal that the orchestrator's
 * cascade uses to early-wake the intent on completion.
 */

import type { SQL } from "bun";
import type { Logger } from "pino";

import { config } from "../../config";
import { requireDb } from "../../db";
import { appendIteration, type ShipIntentRow } from "../../db/queries/ship";
import { logger as rootLogger } from "../../logger";
import { getInstanceId } from "../../orchestrator/instance-id";
import { publishWorkflowRunById } from "../dispatch-outbox";
import { recordWorkflowExecution } from "../execution-row";
import { logWorkflowRunQueued } from "../log-fields";
import type { WorkflowName } from "../registry";
import { insertQueued } from "../runs-store";
import { transitionToTerminal } from "./intent";
import { SHIP_LOG_EVENTS } from "./log-fields";
import { type MergeReadiness, type NonReadinessReason, NonReadinessReasonSchema } from "./verdict";
import { serializeShipWorkflowContext } from "./workflow-context";

export interface RunIterationDeps {
  readonly sql?: SQL;
  readonly log?: Logger;
}

export interface RunIterationInput extends RunIterationDeps {
  readonly intent: ShipIntentRow;
  readonly probeVerdict: MergeReadiness;
}

export type RunIterationOutcome =
  | { readonly outcome: "enqueued"; readonly runId: string; readonly workflowName: WorkflowName }
  | { readonly outcome: "terminal-cap" }
  | { readonly outcome: "terminal-deadline" }
  | { readonly outcome: "ready-shortcut" }
  | { readonly outcome: "in-flight"; readonly runId: string };

/**
 * Drive one iteration. Pure-ish: no GitHub API calls; only Postgres +
 * Valkey writes via injected dependencies. Returns the outcome so the
 * caller can decide whether to short-circuit (e.g., on `ready-shortcut`).
 *
 * @throws when `probeVerdict` is non-ready but lacks a `reason` field
 *         (defensive: the verdict shape guarantees this, but we surface
 *         a clear error if a regression slips a malformed verdict in).
 */
export async function runIteration(input: RunIterationInput): Promise<RunIterationOutcome> {
  const sql = input.sql ?? requireDb();
  const log = (input.log ?? rootLogger).child({
    component: "ship.iteration",
    intent_id: input.intent.id,
    owner: input.intent.owner,
    repo: input.intent.repo,
    pr_number: input.intent.pr_number,
  });

  const intent = input.intent;

  // 0. In-flight guard. A non-terminal `workflow_runs` row tagged with
  //    this `shipIntentId` means a previous iteration is still running
  //    (cascade-fire-while-running, or two concurrent invocations from
  //    `resumeShipIntent` + a fresh comment trigger). Bail without
  //    enqueueing; the cascade hook on the in-flight row's eventual
  //    completion will tickle the intent again.
  const inflight = await findInflightShipIntentRun(intent.id, sql);
  if (inflight !== null) {
    log.info(
      {
        event: SHIP_LOG_EVENTS.iteration.skipInflight,
        run_id: inflight.id,
        run_status: inflight.status,
      },
      "ship iteration skipped, non-terminal workflow_run already in flight for this intent",
    );
    return { outcome: "in-flight", runId: inflight.id };
  }

  // 1. Cap check (FR-013, SC-005). Counted on the action-row count alone
  //    (probe rows that have not produced an action don't consume the
  //    budget). The action we are about to enqueue would push the count
  //    over the configured cap if it equals or exceeds it.
  const completedActions = await countActionIterations(intent.id, sql);
  if (completedActions >= config.maxShipIterations) {
    await transitionToTerminal(intent.id, "deadline_exceeded", "iteration-cap", sql);
    log.info(
      {
        event: SHIP_LOG_EVENTS.iteration.terminalCap,
        cap: config.maxShipIterations,
        completed_actions: completedActions,
      },
      "ship iteration cap reached, intent terminated",
    );
    return { outcome: "terminal-cap" };
  }

  // 2. Deadline check.
  if (intent.deadline_at.getTime() <= Date.now()) {
    await transitionToTerminal(intent.id, "deadline_exceeded", null, sql);
    log.info(
      {
        event: SHIP_LOG_EVENTS.iteration.terminalDeadline,
        deadline_at: intent.deadline_at.toISOString(),
      },
      "ship deadline exceeded, intent terminated",
    );
    return { outcome: "terminal-deadline" };
  }

  // 3. Ready verdicts are handled by the caller's terminal-shortcut. We
  //    return without writing iteration state so the caller can do the
  //    `markPullRequestReadyForReview` GraphQL mutation atomically.
  if (input.probeVerdict.ready) {
    return { outcome: "ready-shortcut" };
  }

  const verdict = input.probeVerdict;
  if (!isNonReadinessReason(verdict.reason)) {
    throw new Error(
      `runIteration: probeVerdict has missing or invalid reason field (got ${String(verdict.reason)})`,
    );
  }

  // 4. Persist the probe verdict as `kind=probe` (verdict columns allowed),
  //    then derive the iteration_n for the action row. Schema's
  //    `ship_iterations_verdict_only_on_probe_check` CHECK forbids verdict
  //    fields on action rows, so they live here.
  const totalRows = await countIterations(intent.id, sql);
  const probeIterationN = totalRows + 1;
  // 5. Map verdict → next workflow_runs.workflow_name. Each non-readiness
  //    reason picks exactly one downstream workflow (research.md Q4).
  const nextWorkflowName = selectNextWorkflow(verdict.reason);
  const actionIterationN = probeIterationN + 1;
  const childDeliveryId = `${intent.id}::iteration::${String(actionIterationN)}`;

  // 6. Insert a `workflow_runs` row with `state.shipIntentId` so the
  //    orchestrator's `onStepComplete` cascade ZADDs `ship:tickle` on
  //    completion (T007). The deliveryId is synthesized from the intent
  //    id + iteration number so reaper queries can correlate the row
  //    back to the originating ship session. The shipIntentId field is
  //    written through `serializeShipWorkflowContext` so producer-side
  //    validation matches the orchestrator's `extractShipIntentId` reader
  //    (workflow-context.ts owns the contract).
  const shipTarget = {
    type: "pr" as const,
    owner: intent.owner,
    repo: intent.repo,
    number: intent.pr_number,
  };
  const run = await sql.begin(async (tx) => {
    await appendIteration(
      {
        intent_id: intent.id,
        iteration_n: probeIterationN,
        kind: "probe",
        verdict_json: verdict,
        non_readiness_reason: verdict.reason,
      },
      tx,
    );
    const committedRun = await insertQueued(
      {
        workflowName: nextWorkflowName,
        target: shipTarget,
        ownerKind: "orchestrator",
        ownerId: getInstanceId(),
        executionDeliveryId: childDeliveryId,
        initialState: {
          ...serializeShipWorkflowContext(intent.id),
          iteration_n: actionIterationN,
        },
      },
      tx,
    );

    // Runner admission depends on both rows. Committing only one can strand
    // the target behind the in-flight index after a process crash.
    await recordWorkflowExecution({
      deliveryId: childDeliveryId,
      target: shipTarget,
      senderLogin: config.botAppLogin,
      workflowName: nextWorkflowName,
      runId: committedRun.id,
      logger: log,
      sql: tx,
    });

    const iterationKind = nextWorkflowName === "review" ? "review" : "resolve";
    await appendIteration(
      {
        intent_id: intent.id,
        iteration_n: actionIterationN,
        kind: iterationKind,
        runs_store_id: committedRun.id,
      },
      tx,
    );
    return committedRun;
  });
  logWorkflowRunQueued(log, { runId: run.id, workflowName: nextWorkflowName, target: shipTarget });

  // Queue publication follows the durable commit. A crash or Valkey failure
  // leaves dispatch_enqueued_at NULL for the periodic outbox retry.
  try {
    await publishWorkflowRunById(run.id, sql);
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err : new Error(String(err)),
        runId: run.id,
        workflowName: nextWorkflowName,
      },
      "Ship iteration publication failed; the durable outbox will retry",
    );
  }

  log.info(
    {
      event: SHIP_LOG_EVENTS.iteration.enqueued,
      iteration_n: actionIterationN,
      next_workflow: nextWorkflowName,
      run_id: run.id,
      verdict_reason: verdict.reason,
    },
    "ship iteration enqueued",
  );

  return { outcome: "enqueued", runId: run.id, workflowName: nextWorkflowName };
}

/**
 * Look up a non-terminal `workflow_runs` row carrying this `shipIntentId`
 * in its `state` JSONB. Returns the in-flight row if one exists, else null.
 *
 * Used by `runIteration` to refuse double-enqueueing when (a) the
 * cascade fired while the previous iteration was still running, or (b)
 * `resumeShipIntent` and a fresh comment trigger raced.
 */
async function findInflightShipIntentRun(
  intentId: string,
  sql: SQL,
): Promise<{ id: string; status: string } | null> {
  // `state ->> 'shipIntentId' = $1` is equivalent to `state @> '{"shipIntentId":...}'::jsonb`
  // here but parameter-binding is more reliable through Bun.sql than the
  // `@> ::jsonb` cast which depends on driver-side JSON encoding.
  const rows: { id: string; status: string }[] = await sql`
    SELECT id, status
      FROM workflow_runs
     WHERE state ->> 'shipIntentId' = ${intentId}
       AND status IN ('queued', 'running')
     LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Count action-flavored `ship_iterations` rows (kind ∈ {resolve, review,
 * branch-refresh}) for an intent. Probe rows do not consume the iteration
 * budget: only actions that mutate PR state do.
 */
async function countActionIterations(intentId: string, sql: SQL): Promise<number> {
  const rows: { count: number | string }[] = await sql`
    SELECT COUNT(*)::int AS count
      FROM ship_iterations
     WHERE intent_id = ${intentId}
       AND kind IN ('resolve', 'review', 'branch-refresh')
  `;
  const raw = rows[0]?.count;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") return Number(raw);
  return 0;
}

/**
 * Choose the downstream `workflow_name` to dispatch for a given non-readiness
 * reason. One reason → one workflow (research.md Q4 single-action rule);
 * the loop runs many iterations rather than packing actions per iteration.
 */
function selectNextWorkflow(reason: NonReadinessReason): WorkflowName {
  switch (reason) {
    case "open_threads":
    case "changes_requested":
    case "failing_checks":
      return "resolve";
    case "behind_base":
      return "implement";
    case "pending_checks":
    case "mergeable_pending":
    case "review_barrier_deferred":
      return "review";
    case "human_took_over":
      // The caller normally short-circuits to terminal `human_took_over`;
      // if we land here defensively, fall back to a review-only run that
      // the orchestrator cascade cannot cause harm with.
      return "review";
    default: {
      // Exhaustiveness guard: the `isNonReadinessReason` check at the
      // entry of `runIteration` already rejects unknown strings, so this
      // branch is unreachable; a `never` assignment surfaces a type error
      // if the enum grows without an accompanying case here.
      const _exhaustive: never = reason;
      throw new Error(`runIteration: unsupported non-readiness reason "${String(_exhaustive)}"`);
    }
  }
}

function isNonReadinessReason(reason: unknown): reason is NonReadinessReason {
  return NonReadinessReasonSchema.safeParse(reason).success;
}

/**
 * Count completed `ship_iterations` rows for an intent. Used to compute the
 * next `iteration_n` and to enforce `config.maxShipIterations`.
 *
 * Used internally by `runIteration`; exported for tests + debugging.
 */
export async function countIterations(intentId: string, sql: SQL = requireDb()): Promise<number> {
  const rows: { count: number | string }[] = await sql`
    SELECT COUNT(*)::int AS count FROM ship_iterations WHERE intent_id = ${intentId}
  `;
  const raw = rows[0]?.count;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") return Number(raw);
  return 0;
}
