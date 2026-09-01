import { config } from "../config";
import { logger } from "../logger";
import { getInstanceId } from "./instance-id";
import { dispatchJob, markJobTerminallyFailed } from "./job-dispatcher";
import {
  deferLeasedWorkflowJob,
  ensureWorkflowJobQueued,
  leaseJob,
  type QueuedJob,
  releaseLeasedJob,
  requeueLeasedJob,
} from "./job-queue";
import { dispatchWorkflowRunner } from "./workflow-runner-dispatch";

const EMPTY_POLL_MS = 200;
const INITIAL_BACKOFF_MS = 100;
const WORKFLOW_CAPACITY_BACKOFF_MS = 1_000;

let running = false;
let loopPromise: Promise<void> | null = null;
let stopRequested = false;
let loopAbortController: AbortController | null = null;

function sleep(ms: number, abortSignal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (abortSignal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      abortSignal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    abortSignal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Compute the sleep-before-rerun when a leased job was re-pushed to the
 * shared queue because no locally-connected daemon could take it. Backoff
 * scales with the job's retry count so a spin between instances that all
 * decline the job converges instead of hot-looping.
 */
function backoffFor(retryCount: number): number {
  const doubled = INITIAL_BACKOFF_MS * 2 ** Math.min(retryCount, 10);
  return Math.min(doubled, config.queueWorkerBackoffMaxMs);
}

async function deferWorkflow(
  instanceId: string,
  raw: string,
  job: Extract<QueuedJob, { kind: "workflow-run" }>,
  abortSignal: AbortSignal,
  reason: "capacity" | "dispatch-error",
): Promise<void> {
  const deferralId = crypto.randomUUID();
  let retryDelayMs = INITIAL_BACKOFF_MS;
  for (;;) {
    if (abortSignal.aborted) return;
    try {
      const result = await deferLeasedWorkflowJob(instanceId, raw, job, deferralId);
      if (result.status === "missing") {
        await ensureWorkflowJobQueued(job, instanceId);
        logger.warn(
          { deliveryId: job.deliveryId, runId: job.workflowRun.runId, instanceId },
          "Workflow lease was missing; published a recoverable duplicate",
        );
      }
      logger.debug(
        {
          deliveryId: job.deliveryId,
          runId: job.workflowRun.runId,
          reason,
          deferralStatus: result.status,
          backoffMs: WORKFLOW_CAPACITY_BACKOFF_MS,
        },
        "Deferred isolated workflow runner dispatch",
      );
      await sleep(WORKFLOW_CAPACITY_BACKOFF_MS, abortSignal);
      return;
    } catch (err) {
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          deliveryId: job.deliveryId,
          runId: job.workflowRun.runId,
          instanceId,
          retryDelayMs,
        },
        "Workflow deferral failed; retaining the processing lease",
      );
      await sleep(retryDelayMs, abortSignal);
      retryDelayMs = Math.min(retryDelayMs * 2, config.queueWorkerBackoffMaxMs);
    }
  }
}

async function iterate(instanceId: string, abortSignal: AbortSignal): Promise<void> {
  const leased = await leaseJob(instanceId);
  if (leased === null) {
    await sleep(EMPTY_POLL_MS, abortSignal);
    return;
  }
  if (abortSignal.aborted) return;

  const { job, raw } = leased;

  logger.debug(
    {
      kind: job.kind,
      deliveryId: job.deliveryId,
      retryCount: job.retryCount,
      instanceId,
      workflowRunId: job.kind === "workflow-run" ? job.workflowRun.runId : undefined,
    },
    "Queue worker leased a job",
  );

  let dispatched = false;
  if (job.kind === "workflow-run") {
    try {
      const outcome = await dispatchWorkflowRunner(job);
      if (outcome === "capacity") {
        await deferWorkflow(instanceId, raw, job, abortSignal, "capacity");
        return;
      }
      await releaseLeasedJob(instanceId, raw);
      logger.debug(
        {
          deliveryId: job.deliveryId,
          runId: job.workflowRun.runId,
          outcome,
          instanceId,
        },
        "Queue worker transferred workflow recovery authority to PostgreSQL",
      );
      return;
    } catch (err) {
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          deliveryId: job.deliveryId,
          runId: job.workflowRun.runId,
        },
        "Isolated workflow runner dispatch failed before authority transfer",
      );
      await deferWorkflow(instanceId, raw, job, abortSignal, "dispatch-error");
      return;
    }
  }

  try {
    dispatched = await dispatchJob(job);
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        deliveryId: job.deliveryId,
      },
      "dispatchJob threw, treating as miss and re-queuing",
    );
  }

  if (dispatched) {
    logger.debug(
      { deliveryId: job.deliveryId, instanceId },
      "Queue worker dispatched job, releasing lease",
    );
    await releaseLeasedJob(instanceId, raw);
    return;
  }

  // No daemon on this instance could take the job. Either another instance
  // has a capable daemon (re-push to head, let them lease it), or nobody
  // does (retry cap eventually fails the job).
  if (job.retryCount >= config.jobMaxRetries) {
    logger.warn(
      { deliveryId: job.deliveryId, retryCount: job.retryCount },
      "Job exceeded max retries with no capable daemon in the fleet, failing terminally",
    );
    await markJobTerminallyFailed(job, "No capable daemon in the fleet after maximum retries");
    await releaseLeasedJob(instanceId, raw);
    return;
  }

  const newRetryCount = await requeueLeasedJob(instanceId, raw, job);
  const delay = backoffFor(newRetryCount);
  logger.debug(
    { deliveryId: job.deliveryId, retryCount: newRetryCount, backoffMs: delay },
    "Re-queued job with no local capable daemon",
  );
  await sleep(delay, abortSignal);
}

/**
 * Start the per-orchestrator queue worker. Idempotent: calling twice does
 * nothing. The worker runs until `stopQueueWorker()` is awaited.
 */
export function startQueueWorker(): void {
  if (running) return;
  running = true;
  stopRequested = false;
  const instanceId = getInstanceId();
  const abortController = new AbortController();
  const abortSignal = abortController.signal;
  loopAbortController = abortController;

  logger.info({ instanceId }, "Queue worker started");

  loopPromise = (async (): Promise<void> => {
    while (!stopRequested) {
      try {
        await iterate(instanceId, abortSignal);
      } catch (err) {
        // Catastrophic errors (Valkey blip, DB outage) should NOT kill the
        // worker, sleep briefly and keep going. dispatchJob failures are
        // already caught inside `iterate` and treated as misses.
        logger.error(
          { err: err instanceof Error ? err.message : String(err), instanceId },
          "Queue worker iteration failed, sleeping before retry",
        );
        await sleep(EMPTY_POLL_MS * 5, abortSignal);
      }
    }
    if (loopAbortController === abortController) loopAbortController = null;
    logger.info({ instanceId }, "Queue worker stopped");
  })();
}

/**
 * Signal the worker to stop and wait for the in-flight iteration to finish.
 * Safe to call before `startQueueWorker` (no-op) and more than once.
 *
 * Leased jobs still in `queue:processing:{instanceId}` are NOT drained here,
 * they are recovered on next startup by `recoverProcessingList`, or by the
 * cross-instance reaper on any live orchestrator. Draining during shutdown
 * would race Valkey's closing connection.
 */
export async function stopQueueWorker(): Promise<void> {
  if (!running) return;
  stopRequested = true;
  loopAbortController?.abort();
  const pending = loopPromise;
  loopPromise = null;
  running = false;
  if (pending !== null) await pending;
}
