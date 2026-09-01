import { config } from "../config";
import { WorkflowRunnerResourceError } from "../k8s/workflow-runner-spawner";
import { logger } from "../logger";
import { reconcilePendingWorkflowFailureNotifications } from "./workflow-expiry-notifier";
import { deriveWorkflowRunnerCapability } from "./workflow-runner-capability";
import { failWorkflowRunnerResourceAttempt } from "./workflow-runner-dispatch";
import { ensureCurrentWorkflowRunnerResources } from "./workflow-runner-resources";
import {
  cleanupWorkflowRunnerAttempt,
  reconcilePendingWorkflowRunnerResults,
} from "./workflow-runner-result";
import {
  findWorkflowRunnerCleanupCandidates,
  listActiveWorkflowRunnerAttempts,
} from "./workflow-runner-store";

async function reconcileActiveResources(): Promise<void> {
  const image = config.daemonImage;
  const orchestratorUrl = config.orchestratorPublicUrl;
  const capabilitySecret = config.workflowRunnerCapabilitySecret;
  if (
    config.githubPersonalAccessToken !== undefined ||
    image === undefined ||
    orchestratorUrl === undefined ||
    capabilitySecret === undefined
  ) {
    return;
  }
  const attempts = await listActiveWorkflowRunnerAttempts();
  for (const attempt of attempts) {
    try {
      const capability = deriveWorkflowRunnerCapability(
        capabilitySecret,
        attempt.runId,
        attempt.attemptId,
        attempt.attemptDeadlineAt,
      );
      // eslint-disable-next-line no-await-in-loop -- Kubernetes reconciliation is bounded
      await ensureCurrentWorkflowRunnerResources({ attempt, capability, image, orchestratorUrl });
    } catch (err) {
      if (err instanceof WorkflowRunnerResourceError && err.kind === "permanent") {
        try {
          // eslint-disable-next-line no-await-in-loop -- exact attempt failure is ordered
          await failWorkflowRunnerResourceAttempt(attempt, err.message);
          continue;
        } catch (failureErr) {
          logger.error(
            { failureErr, runId: attempt.runId, attemptId: attempt.attemptId },
            "Workflow runner boundary violation could not be fenced",
          );
        }
      }
      logger.warn(
        { err, runId: attempt.runId, attemptId: attempt.attemptId },
        "Workflow runner resource reconciliation failed",
      );
    }
  }
}

async function reconcileCleanup(): Promise<void> {
  const candidates = await findWorkflowRunnerCleanupCandidates();
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop -- Kubernetes cleanup is bounded
      await cleanupWorkflowRunnerAttempt(candidate);
    } catch (err) {
      logger.warn(
        { err, runId: candidate.runId, attemptId: candidate.attemptId },
        "Workflow runner cleanup reconciliation failed",
      );
    }
  }
}

export async function reconcileWorkflowRunners(): Promise<void> {
  await reconcilePendingWorkflowRunnerResults();
  await reconcilePendingWorkflowFailureNotifications();
  await reconcileActiveResources();
  await reconcileCleanup();
}
