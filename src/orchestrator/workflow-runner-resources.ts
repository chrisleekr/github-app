import {
  deleteWorkflowRunnerResources,
  ensureWorkflowRunnerResources,
  type RunnerPodStartup,
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

/**
 * Durable lifecycle state of the attempt, plus what kubelet is doing with its
 * Pod. `startup` rides the `ready` case because that is the only branch where a
 * Pod was actually reconciled, and the reconciler needs it to tell a Pod that is
 * still coming up from a runner that will never report in.
 */
export type EnsureRunnerResourcesResult =
  | {
      readonly state: "ready";
      readonly startup: RunnerPodStartup;
      /**
       * Null until the runner receives its credential. The reconciler's startup
       * handling is gated on it: once issued, the attempt may have cloned and
       * pushed, so a dead Pod is no longer a start failure.
       */
      readonly payloadIssuedAt: Date | null;
    }
  | { readonly state: "result-pending" }
  | { readonly state: "terminal" };

/** Recheck durable ownership under the same per-attempt chain as cleanup. */
export async function ensureCurrentWorkflowRunnerResources(input: {
  readonly attempt: WorkflowRunnerAttempt;
  readonly capability: string;
  readonly image: string;
  readonly orchestratorUrl: string;
}): Promise<EnsureRunnerResourcesResult> {
  return serializeResourceOperation(input.attempt.attemptId, async () => {
    const before = await getWorkflowRunnerRegistrationState(input.attempt);
    if (before.state !== "ready") {
      if (before.state !== "result-pending") await deleteAndRecord(input.attempt);
      return before.state === "result-pending"
        ? ({ state: "result-pending" } as const)
        : ({ state: "terminal" } as const);
    }

    const startup = await ensureWorkflowRunnerResources(input);
    const after = await getWorkflowRunnerRegistrationState(input.attempt);
    if (after.state === "ready")
      return { state: "ready", startup, payloadIssuedAt: after.payloadIssuedAt } as const;
    if (after.state !== "result-pending") await deleteAndRecord(input.attempt);
    return after.state === "result-pending"
      ? ({ state: "result-pending" } as const)
      : ({ state: "terminal" } as const);
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
