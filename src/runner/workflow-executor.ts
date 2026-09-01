import { Octokit } from "octokit";

import { logger } from "../logger";
import type { SerializableBotContext } from "../shared/daemon-types";
import type { WorkflowRunnerPayload } from "../shared/workflow-runner-messages";
import {
  type HandlerResult,
  HandlerResultSchema,
  workflowRunnerId,
} from "../shared/workflow-types";
import { getByName, type WorkflowRunContext } from "../workflows/registry";
import type { WorkflowRunnerClient } from "./ws-client";

/** Execute one handler without direct access to PostgreSQL, Valkey, or Kubernetes. */
export async function executeWorkflowRunnerJob(
  job: WorkflowRunnerPayload,
  client: WorkflowRunnerClient,
  signal: AbortSignal,
): Promise<HandlerResult> {
  const context = job.context as unknown as SerializableBotContext;
  const workflowRun = job.workflowRun;
  const target = {
    type: context.isPR ? ("pr" as const) : ("issue" as const),
    owner: context.owner,
    repo: context.repo,
    number: context.entityNumber,
  };
  const log = logger.child({
    workflowRunId: workflowRun.runId,
    workflowName: workflowRun.workflowName,
    attemptId: client.attemptId,
    deliveryId: context.deliveryId,
    target,
  });
  const runContext: WorkflowRunContext = {
    runId: workflowRun.runId,
    workflowName: workflowRun.workflowName,
    target,
    ...(workflowRun.parentRunId !== undefined && workflowRun.parentStepIndex !== undefined
      ? { parent: { runId: workflowRun.parentRunId, stepIndex: workflowRun.parentStepIndex } }
      : {}),
    logger: log,
    octokit: new Octokit({ auth: job.installationToken }),
    deliveryId: context.deliveryId,
    daemonId: workflowRunnerId(client.attemptId),
    signal,
    handOffChild: async (input) => {
      const response = await client.command({ type: "hand-off-child", ...input });
      if (response.childRunId === undefined) {
        throw new Error("Controller acknowledged hand-off without a child run id");
      }
      return { childRunId: response.childRunId };
    },
    ...(job.reviewLearnings !== undefined ? { reviewLearnings: job.reviewLearnings } : {}),
    ...(job.repoMemory !== undefined ? { repoMemory: job.repoMemory } : {}),
    ...(job.policy !== undefined ? { policy: job.policy } : {}),
    ...(job.maxTurns !== undefined ? { maxTurns: job.maxTurns } : {}),
    ...(job.priorPlanState !== undefined ? { priorPlanState: job.priorPlanState } : {}),
    ...(job.shipStepRuns !== undefined ? { shipStepRuns: job.shipStepRuns } : {}),
    setState: async (state, humanMessage) => {
      const patch =
        typeof state === "object" && state !== null
          ? (state as Record<string, unknown>)
          : { state };
      return client.command({ type: "set-state", patch, humanMessage });
    },
  };
  signal.throwIfAborted();
  const result = await getByName(workflowRun.workflowName).handler(runContext);
  signal.throwIfAborted();
  return HandlerResultSchema.parse(result);
}
