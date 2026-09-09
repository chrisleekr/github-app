import {
  readWorkflowRunnerPostMortem,
  type RunnerPodPostMortem,
} from "../k8s/workflow-runner-postmortem";
import { WorkflowRunnerResourceError } from "../k8s/workflow-runner-spawner";
import { logger } from "../logger";
import { reconcilePendingWorkflowFailureNotifications } from "./workflow-expiry-notifier";
import { deriveWorkflowRunnerCapability } from "./workflow-runner-capability";
import {
  failWorkflowRunnerResourceAttempt,
  requiredRunnerConfig,
  WORKFLOW_RUNNER_STARTUP_LEASE_MS,
} from "./workflow-runner-dispatch";
import { ensureCurrentWorkflowRunnerResources } from "./workflow-runner-resources";
import {
  cleanupWorkflowRunnerAttempt,
  reconcilePendingWorkflowRunnerResults,
} from "./workflow-runner-result";
import {
  extendWorkflowRunnerStartupLease,
  findWorkflowRunnerCleanupCandidates,
  hasWorkflowRunnerPostMortem,
  listActiveWorkflowRunnerAttempts,
  recordWorkflowRunnerPostMortem,
  type WorkflowRunnerAttempt,
} from "./workflow-runner-store";

/**
 * Whether the reading says anything the failure comment or an operator could
 * use. A pass that catches the Pod before kubelet has written any status reads
 * all nulls, and the store keeps the first write forever, so recording that
 * would spend the one slot on nothing and lock out the pass that has the answer.
 */
function isInformative(postMortem: RunnerPodPostMortem): boolean {
  return (
    postMortem.reason !== null ||
    postMortem.podReason !== null ||
    postMortem.exitCode !== null ||
    postMortem.logTail !== ""
  );
}

/**
 * Persist and log why the runner Pod died, at most once per attempt.
 *
 * This is the only durable record. The Pod, its terminated container status and
 * its logs are deleted on cleanup, so by the time anyone reads the failure
 * comment there is nothing left to inspect, and "the runner stopped renewing"
 * cannot distinguish an OOMKill from a crash from a node eviction.
 *
 * Never throws: a post-mortem that cannot be read must not derail the failure
 * path that prompted it.
 */
async function capturePodPostMortem(
  attempt: WorkflowRunnerAttempt,
  startupReason: string,
): Promise<void> {
  try {
    if (await hasWorkflowRunnerPostMortem(attempt)) return;
    const postMortem = await readWorkflowRunnerPostMortem(attempt);
    if (postMortem === null || !isInformative(postMortem)) return;
    if (!(await recordWorkflowRunnerPostMortem(attempt, { ...postMortem }))) return;
    logger.error(
      {
        event: "workflow_runner_pod_died",
        runId: attempt.runId,
        attemptId: attempt.attemptId,
        workflowName: attempt.workflowName,
        startupReason,
        ...postMortem,
      },
      "Workflow runner Pod died",
    );
  } catch (err) {
    logger.warn(
      { err, runId: attempt.runId, attemptId: attempt.attemptId },
      "Workflow runner post-mortem capture failed",
    );
  }
}

async function reconcileActiveResources(): Promise<void> {
  // Reuse the dispatch validator so both paths apply one rule. A hand-rolled
  // `undefined`-only guard here would let an empty-string `DAEMON_IMAGE` through
  // and push a rejected Pod spec at Kubernetes on every pass, while dispatch
  // terminalizes the same config as a permanent failure.
  let image: string;
  let orchestratorUrl: string;
  let capabilitySecret: string;
  try {
    ({ image, orchestratorUrl, capabilitySecret } = requiredRunnerConfig());
  } catch {
    // Runners are not configured on this deployment; there is nothing to reconcile.
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
      const result = await ensureCurrentWorkflowRunnerResources({
        attempt,
        capability,
        image,
        orchestratorUrl,
      });
      if (result.state !== "ready") continue;

      // Observing a dead Pod is not the same as acting on it, so this runs
      // regardless of what the branches below do with the attempt. It is the
      // only moment the controller holds both the evidence and a live Pod: the
      // lease has minutes left and neither the terminalization below nor its
      // cleanup has deleted anything yet.
      if (result.startup.phase === "stalled") {
        // eslint-disable-next-line no-await-in-loop -- one post-mortem per attempt, in order
        await capturePodPostMortem(attempt, result.startup.reason);
      }

      // Startup handling only. Once the payload is issued the runner holds its
      // credential and may have pushed commits, so a dead Pod is not a start
      // failure: leave it to lease expiry, whose notice tells the reader to
      // inspect the repository. Terminalizing here would replace that with
      // "could not start" and drop the warning after real GitHub writes.
      if (result.payloadIssuedAt !== null) continue;

      // The startup lease is claimed before the Pod exists, so scheduling, image
      // pull and volume setup all burn it. Renewals only begin once the runner
      // registers, which means a cold image pull slower than the lease killed a
      // healthy attempt that had not run a single line. Extend on evidence of
      // progress instead, bounded by the startup budget so a Pod that never
      // starts releases its concurrency slot.
      if (result.startup.phase === "stalled") {
        // eslint-disable-next-line no-await-in-loop -- exact attempt failure is ordered
        await failWorkflowRunnerResourceAttempt(
          attempt,
          `Runner Pod could not start: ${result.startup.reason}`,
        );
        continue;
      }
      if (result.startup.phase === "starting") {
        // eslint-disable-next-line no-await-in-loop -- lease extension is per attempt
        const extended = await extendWorkflowRunnerStartupLease(
          attempt,
          WORKFLOW_RUNNER_STARTUP_LEASE_MS,
        );
        // The fences reject the update when the payload was issued in the
        // registration race, when the lease lapsed between listing and here, or
        // at the attempt deadline. Without this line a dying attempt looks
        // identical to one being kept alive, since both keep logging `starting`.
        if (!extended) {
          logger.info(
            { runId: attempt.runId, attemptId: attempt.attemptId },
            "Workflow runner startup lease extension refused",
          );
        }
      }
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

/**
 * Run one phase in isolation. The phases are unrelated, so a rejection in an
 * early one must not skip the rest of the pass. The single caller (`reapOnce`)
 * wraps the whole call in one `.catch`, which would otherwise drop every later
 * phase on the first failure.
 */
async function runPhase(name: string, phase: () => Promise<unknown>): Promise<void> {
  try {
    await phase();
  } catch (err) {
    logger.warn({ err, phase: name }, "Workflow runner reconciliation phase failed");
  }
}

export async function reconcileWorkflowRunners(): Promise<void> {
  await runPhase("pending-results", reconcilePendingWorkflowRunnerResults);
  await runPhase("failure-notifications", reconcilePendingWorkflowFailureNotifications);
  await runPhase("active-resources", reconcileActiveResources);
  await runPhase("cleanup", reconcileCleanup);
}
