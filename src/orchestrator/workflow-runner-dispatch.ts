import { config } from "../config";
import { EphemeralSpawnError } from "../k8s/ephemeral-daemon-spawner";
import { WorkflowRunnerResourceError } from "../k8s/workflow-runner-spawner";
import { logger } from "../logger";
import { ensureWorkflowCascadeForOffer } from "../workflows/completion-reconciler";
import { logWorkflowRunRunning } from "../workflows/log-fields";
import type { WorkflowRunQueuedJob } from "./job-queue";
import { notifyRunnerStartFailures } from "./workflow-expiry-notifier";
import { deriveWorkflowRunnerCapability } from "./workflow-runner-capability";
import {
  cleanupCurrentWorkflowRunnerResources,
  ensureCurrentWorkflowRunnerResources,
} from "./workflow-runner-resources";
import {
  claimWorkflowRunnerAttempt,
  failWorkflowRunnerAttempt,
  type WorkflowRunnerAttempt,
} from "./workflow-runner-store";

export const WORKFLOW_RUNNER_STARTUP_LEASE_MS = Math.max(300_000, 4 * config.heartbeatTimeoutMs);

function requiredRunnerConfig(): {
  readonly image: string;
  readonly orchestratorUrl: string;
  readonly capabilitySecret: string;
} {
  if (config.githubPersonalAccessToken !== undefined) {
    throw new WorkflowRunnerResourceError(
      "permanent",
      "Workflow runners require GitHub App mode; PAT mode cannot mint a target-repository token",
    );
  }
  if (config.daemonImage === undefined || config.daemonImage === "") {
    throw new WorkflowRunnerResourceError("permanent", "DAEMON_IMAGE is required for workflows");
  }
  if (config.orchestratorPublicUrl === undefined || config.orchestratorPublicUrl === "") {
    throw new WorkflowRunnerResourceError(
      "permanent",
      "ORCHESTRATOR_PUBLIC_URL is required for workflows",
    );
  }
  if (
    config.workflowRunnerCapabilitySecret === undefined ||
    config.workflowRunnerCapabilitySecret === ""
  ) {
    throw new WorkflowRunnerResourceError(
      "permanent",
      "WORKFLOW_RUNNER_CAPABILITY_SECRET is required to derive workflow runner capabilities",
    );
  }
  return {
    image: config.daemonImage,
    orchestratorUrl: config.orchestratorPublicUrl,
    capabilitySecret: config.workflowRunnerCapabilitySecret,
  };
}

function isPermanentResourceFailure(err: unknown): boolean {
  if (err instanceof WorkflowRunnerResourceError) return err.kind === "permanent";
  return (
    err instanceof EphemeralSpawnError &&
    (err.kind === "infra-absent" || err.kind === "auth-load-failed" || err.kind === "api-rejected")
  );
}

export async function failWorkflowRunnerResourceAttempt(
  attempt: WorkflowRunnerAttempt,
  reason: string,
): Promise<void> {
  const row = await failWorkflowRunnerAttempt(attempt, reason);
  await ensureWorkflowCascadeForOffer(attempt.attemptId, logger).catch((err: unknown) => {
    logger.warn({ err, attemptId: attempt.attemptId }, "Runner-start cascade will be reconciled");
  });
  await notifyRunnerStartFailures([row]);
  await cleanupCurrentWorkflowRunnerResources(attempt).catch((err: unknown) => {
    logger.warn({ err, attemptId: attempt.attemptId }, "Runner resource cleanup will be retried");
  });
}

/** Admit a workflow queue item into its durable, isolated runner attempt. */
export async function dispatchWorkflowRunner(
  job: WorkflowRunQueuedJob,
): Promise<"accepted" | "stale" | "capacity"> {
  const maxActive = config.maxConcurrentRequests;
  if (!Number.isInteger(maxActive) || maxActive <= 0) {
    throw new RangeError("MAX_CONCURRENT_REQUESTS must be a positive integer");
  }
  const claim = await claimWorkflowRunnerAttempt(job, WORKFLOW_RUNNER_STARTUP_LEASE_MS, maxActive);
  if (claim.outcome === "stale" || claim.outcome === "capacity") return claim.outcome;
  const attempt = claim.attempt;
  if (claim.outcome === "claimed") {
    logWorkflowRunRunning(logger, {
      runId: attempt.runId,
      workflowName: attempt.workflowName,
      target: {
        type: job.isPR ? "pr" : "issue",
        owner: job.repoOwner,
        repo: job.repoName,
        number: job.entityNumber,
      },
      deliveryId: job.deliveryId,
    });
  }

  try {
    const runnerConfig = requiredRunnerConfig();
    const capability = deriveWorkflowRunnerCapability(
      runnerConfig.capabilitySecret,
      attempt.runId,
      attempt.attemptId,
      attempt.attemptDeadlineAt,
    );
    await ensureCurrentWorkflowRunnerResources({
      attempt,
      capability,
      image: runnerConfig.image,
      orchestratorUrl: runnerConfig.orchestratorUrl,
    });
  } catch (err) {
    if (isPermanentResourceFailure(err)) {
      const reason = err instanceof Error ? err.message : "Workflow runner configuration failed";
      await failWorkflowRunnerResourceAttempt(attempt, reason);
      return "accepted";
    }
    logger.warn(
      { err, runId: attempt.runId, attemptId: attempt.attemptId },
      "Workflow runner resource state is ambiguous; durable reconciliation will retry",
    );
  }
  return "accepted";
}
