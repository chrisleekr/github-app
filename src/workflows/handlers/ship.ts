import type { WorkflowRunSnapshot } from "../../shared/workflow-types";
import {
  getByName,
  type WorkflowHandler,
  type WorkflowName,
  type WorkflowRunContext,
} from "../registry";
import { StaleWorkflowAttemptError } from "../runs-store";
// T028 v2 entry, re-exported for spec-locator parity with the
// CanonicalCommand path described in the tasks.md T028 description. The
// legacy WorkflowHandler `handler` below covers the workflow_runs
// composite lifecycle; `runShipFromCommand` covers the new
// ship_intents lifecycle driven by trigger-router.routeTrigger(...).
export { runShipFromCommand } from "../ship/session-runner";

/**
 * `ship` composite handler (T031): the entry point for the end-to-end
 * triage → plan → implement → review → resolve pipeline.
 *
 * Resume semantics (T033 / FR-013 / FR-020):
 *   - `bot:ship` is re-applicable on a target that has a prior **terminal**
 *     parent row (succeeded or failed). The partial unique index on
 *     `workflow_runs` only blocks in-flight rows, so a new parent insert
 *     succeeds.
 *   - The handler walks `registry.ship.steps` left-to-right and, for each
 *     step, asks: does a fresh output exist for this target? Staleness
 *     rules per `contracts/handoff-protocol.md`:
 *       triage   : fresh iff succeeded row exists AND `state.recommendedNext==='plan'`
 *       plan     : fresh iff succeeded row exists AND created AFTER the last triage success
 *       implement: fresh iff succeeded row exists AND recorded PR is still open
 *       review   : always stale (bot self-reviews on every ship iteration)
 *       resolve  : always stale
 *   - The first stale step becomes `startIndex`. Prior-step run ids are
 *     carried forward in `state.stepRuns` so the tracking comment can link
 *     them.
 *
 * Return value is `handed-off`: the executor merges state but keeps the
 * parent row in `running` until the final child succeeds or any child
 * fails. The orchestrator's cascade (in `src/workflows/orchestrator.ts`)
 * handles the terminal transition.
 */
export const handler: WorkflowHandler = async (ctx) => {
  const { target, logger: log } = ctx;

  try {
    if (target.type !== "issue") {
      return { status: "failed", reason: "ship requires issue target" };
    }

    const steps = getByName("ship").steps;

    const { startIndex, priorRunIds } = await computeStartIndex({
      steps,
      target,
      octokit: ctx.octokit,
      logger: log,
      stepRuns: ctx.shipStepRuns ?? {},
    });

    const firstStep = steps[startIndex];
    if (firstStep === undefined) {
      // All steps fresh → nothing to do; mark handed-off with no child so
      // the orchestrator flips the parent immediately. We do that by
      // inserting a synthetic completion path: cascade to succeeded.
      // Simplest path: fall through to insert a child for the last step
      // anyway, but resolve is always stale, so this branch is unreachable
      // in practice. Defensive failure.
      return { status: "failed", reason: "ship: computed startIndex out of range" };
    }

    const state = {
      currentStepIndex: startIndex,
      stepRuns: priorRunIds,
    };
    if (ctx.handOffChild === undefined) {
      throw new Error("ship requires an attempt-scoped hand-off operation");
    }
    const humanMessage =
      startIndex === 0
        ? `ship started, first step \`${firstStep}\` queued.`
        : `ship resumed at step ${String(startIndex)} (\`${firstStep}\`); ${String(priorRunIds.length)} prior step(s) reused.`;
    const handOff = await ctx.handOffChild({
      workflowName: firstStep,
      target,
      parentStepIndex: startIndex,
      state,
      humanMessage,
    });
    const committedState = { ...state, handedOffTo: handOff.childRunId };

    log.info(
      { startIndex, firstStep, childRunId: handOff.childRunId, priorRunIds },
      "ship handler handed off to first child",
    );

    return {
      status: "handed-off",
      state: committedState,
      humanMessage,
      childRunId: handOff.childRunId,
    };
  } catch (err) {
    if (err instanceof StaleWorkflowAttemptError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err }, "ship handler caught error");
    return { status: "failed", reason: `ship failed: ${message}` };
  }
};

interface ComputeStartIndexParams {
  readonly steps: readonly WorkflowName[];
  readonly target: WorkflowRunContext["target"];
  readonly octokit: WorkflowRunContext["octokit"];
  readonly logger: WorkflowRunContext["logger"];
  readonly stepRuns: Readonly<Partial<Record<WorkflowName, WorkflowRunSnapshot>>>;
}

async function computeStartIndex(params: ComputeStartIndexParams): Promise<{
  startIndex: number;
  priorRunIds: string[];
}> {
  const { steps, target, octokit, logger, stepRuns } = params;
  const priorRunIds: string[] = [];

  let triageCreatedAt: Date | null = null;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step === undefined) continue;
    const latest = stepRuns[step] ?? null;

    // eslint-disable-next-line no-await-in-loop -- sequential by design
    const fresh = await isFresh({
      step,
      latest,
      triageCreatedAt,
      octokit,
      owner: target.owner,
      repo: target.repo,
      logger,
    });
    if (!fresh) {
      return { startIndex: i, priorRunIds };
    }

    if (latest !== null) {
      priorRunIds.push(latest.id);
      if (step === "triage") triageCreatedAt = new Date(latest.createdAt);
    }
  }

  // All steps fresh, should be unreachable because `resolve` is always
  // stale. Return the last index so caller defensively inserts a resolve
  // child.
  return { startIndex: steps.length - 1, priorRunIds: priorRunIds.slice(0, -1) };
}

interface IsFreshParams {
  readonly step: WorkflowName;
  readonly latest: WorkflowRunSnapshot | null;
  readonly triageCreatedAt: Date | null;
  readonly octokit: WorkflowRunContext["octokit"];
  readonly owner: string;
  readonly repo: string;
  readonly logger: WorkflowRunContext["logger"];
}

async function isFresh(params: IsFreshParams): Promise<boolean> {
  const { step, latest, triageCreatedAt, octokit, owner, repo, logger } = params;

  if (latest?.status !== "succeeded") return false;

  if (step === "review" || step === "resolve") return false;

  if (step === "triage") {
    return latest.state.recommendedNext === "plan";
  }

  if (step === "plan") {
    if (triageCreatedAt === null) return false;
    return new Date(latest.createdAt).getTime() > triageCreatedAt.getTime();
  }

  if (step === "implement") {
    const prNumber = latest.state.pr_number;
    if (typeof prNumber !== "number") return false;
    try {
      const { data: pr } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });
      return pr.state === "open";
    } catch (err) {
      logger.warn(
        { err, prNumber, owner, repo },
        "ship: failed to verify PR state, treating implement as stale",
      );
      return false;
    }
  }

  return true;
}
