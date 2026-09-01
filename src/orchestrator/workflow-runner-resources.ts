import {
  deleteWorkflowRunnerResources,
  ensureWorkflowRunnerResources,
} from "../k8s/workflow-runner-spawner";
import {
  getWorkflowRunnerRegistrationState,
  markWorkflowRunnerResourcesCleaned,
  type WorkflowRunnerAttempt,
} from "./workflow-runner-store";

const resourceChains = new Map<string, Promise<unknown>>();

async function serializeResourceOperation<T>(
  attemptId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const prior = resourceChains.get(attemptId) ?? Promise.resolve();
  const current = prior.catch(() => undefined).then(operation);
  resourceChains.set(attemptId, current);
  try {
    return await current;
  } finally {
    if (resourceChains.get(attemptId) === current) resourceChains.delete(attemptId);
  }
}

async function deleteAndRecord(attempt: {
  readonly runId: string;
  readonly attemptId: string;
}): Promise<void> {
  if (await deleteWorkflowRunnerResources(attempt)) {
    await markWorkflowRunnerResourcesCleaned(attempt);
  }
}

/** Recheck durable ownership under the same per-attempt chain as cleanup. */
export async function ensureCurrentWorkflowRunnerResources(input: {
  readonly attempt: WorkflowRunnerAttempt;
  readonly capability: string;
  readonly image: string;
  readonly orchestratorUrl: string;
}): Promise<"ready" | "result-pending" | "terminal"> {
  return serializeResourceOperation(input.attempt.attemptId, async () => {
    const before = await getWorkflowRunnerRegistrationState(input.attempt);
    if (before.state !== "ready") {
      if (before.state !== "result-pending") await deleteAndRecord(input.attempt);
      return before.state === "result-pending" ? "result-pending" : "terminal";
    }

    await ensureWorkflowRunnerResources(input);
    const after = await getWorkflowRunnerRegistrationState(input.attempt);
    if (after.state === "ready") return "ready";
    if (after.state !== "result-pending") await deleteAndRecord(input.attempt);
    return after.state === "result-pending" ? "result-pending" : "terminal";
  });
}

export async function cleanupCurrentWorkflowRunnerResources(attempt: {
  readonly runId: string;
  readonly attemptId: string;
}): Promise<void> {
  await serializeResourceOperation(attempt.attemptId, () => deleteAndRecord(attempt));
}

export function resetWorkflowRunnerResourceChainsForTests(): void {
  resourceChains.clear();
}
