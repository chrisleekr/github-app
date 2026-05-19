import { config } from "../config";
import { logger } from "../logger";
import type { DaemonCapabilities, PendingOffer } from "../shared/daemon-types";
import type { WorkflowRunRef } from "../shared/workflow-types";
import { createMessageEnvelope, type ScopedJobContext } from "../shared/ws-messages";
import { markFailed as markWorkflowRunFailed } from "../workflows/runs-store";
import { getConnections, getDaemonInfo, isDaemonDraining } from "./connection-handler";
import { getActiveDaemons, getDaemonActiveJobs } from "./daemon-registry";
import { markExecutionFailed, markExecutionOffered, requeueExecution } from "./history";
import {
  isScopedJob,
  type QueuedJob,
  QueuedJobSchema,
  requeueJob,
  type ScopedQueuedJob,
} from "./job-queue";

// In-memory pending offers (keyed by offerId)

const pendingOffers = new Map<string, PendingOffer>();

export function getPendingOffer(offerId: string): PendingOffer | undefined {
  return pendingOffers.get(offerId);
}

export function removePendingOffer(offerId: string): void {
  const offer = pendingOffers.get(offerId);
  if (offer !== undefined) {
    clearTimeout(offer.timer);
    pendingOffers.delete(offerId);
  }
}

// Tool requirement inference (R-007)

const BASELINE_TOOLS = ["git", "bun", "node"];

/**
 * Infer required tools from job metadata (labels + trigger body keywords).
 */
export function inferRequiredTools(labels: string[], triggerBody: string): string[] {
  const tools = new Set(BASELINE_TOOLS);

  // Label-based inference (e.g., "bot:docker" -> docker)
  for (const label of labels) {
    const lower = label.toLowerCase();
    if (lower.includes("docker")) tools.add("docker");
    if (lower.includes("python")) tools.add("python3");
    if (lower.includes("aws")) tools.add("aws");
    if (lower.includes("make")) tools.add("make");
  }

  const bodyLower = triggerBody.toLowerCase();
  if (bodyLower.includes("docker") || bodyLower.includes("container")) tools.add("docker");
  if (bodyLower.includes("python")) tools.add("python3");
  if (bodyLower.includes("curl")) tools.add("curl");
  if (bodyLower.includes("makefile") || bodyLower.includes("make ")) tools.add("make");

  return [...tools];
}

// Daemon selection (R-007, FM-10)

/**
 * Check if a daemon has the required tools as functional.
 */
function hasRequiredTools(capabilities: DaemonCapabilities, requiredTools: string[]): boolean {
  const functionalTools = new Set<string>();
  for (const tool of capabilities.cliTools) {
    if (tool.functional) functionalTools.add(tool.name);
  }
  for (const tool of capabilities.packageManagers) {
    if (tool.functional) functionalTools.add(tool.name);
  }
  for (const tool of capabilities.shells) {
    if (tool.functional) functionalTools.add(tool.name);
  }
  // Container runtime counts as "docker" or "podman"
  if (capabilities.containerRuntime?.daemonRunning === true) {
    functionalTools.add(capabilities.containerRuntime.name);
  }

  return requiredTools.every((t) => functionalTools.has(t));
}

/**
 * Select the best daemon for a job offer.
 * Strategy: capability match -> filter draining -> ephemeral preference -> least loaded.
 */
export async function selectDaemon(requiredTools: string[]): Promise<string | null> {
  const activeDaemonIds = await getActiveDaemons();
  if (activeDaemonIds.length === 0) return null;

  const candidates: {
    id: string;
    activeJobs: number;
    ephemeral: boolean;
  }[] = [];

  for (const daemonId of activeDaemonIds) {
    if (isDaemonDraining(daemonId)) continue;

    const info = getDaemonInfo(daemonId);
    if (info === undefined) continue;
    if (info.status !== "active") continue;

    // Capability match
    if (!hasRequiredTools(info.capabilities, requiredTools)) continue;

    // eslint-disable-next-line no-await-in-loop
    const activeJobs = await getDaemonActiveJobs(daemonId);

    candidates.push({
      id: daemonId,
      activeJobs,
      ephemeral: info.capabilities.ephemeral,
    });
  }

  if (candidates.length === 0) return null;

  // Sort: prefer non-ephemeral for complex jobs, then least loaded
  // Phase 2 without triage: all jobs are treated as complex (maxTurns > 30)
  candidates.sort((a, b) => {
    // Prefer non-ephemeral
    if (a.ephemeral !== b.ephemeral) return a.ephemeral ? 1 : -1;
    // Then least loaded
    return a.activeJobs - b.activeJobs;
  });

  return candidates[0]?.id ?? null;
}

// Offer protocol (FR-010a)

/**
 * Dispatch a job to a daemon via the offer/accept/reject protocol.
 * Returns true if the job was offered to a daemon, false if no daemon available.
 *
 * Branches on `job.kind`:
 *   - `legacy` / `workflow-run` → existing `job:offer` envelope.
 *   - `scoped-*` → `scoped-job-offer` envelope per
 *     `specs/.../contracts/ws-messages.md`.
 */
export async function dispatchJob(job: QueuedJob): Promise<boolean> {
  const requiredTools = inferRequiredTools(job.labels, job.triggerBodyPreview);
  const daemonId = await selectDaemon(requiredTools);
  const fleetSize = getConnections().size;

  logger.debug(
    {
      kind: job.kind,
      deliveryId: job.deliveryId,
      requiredTools,
      fleetSize,
      selectedDaemon: daemonId,
    },
    "dispatchJob: selectDaemon result",
  );

  if (daemonId === null) {
    logger.info(
      { kind: job.kind, deliveryId: job.deliveryId, fleetSize, requiredTools },
      "dispatchJob: no daemon available, caller should enqueue or retry",
    );
    return false; // Caller handles FM-3 fallback
  }

  const connections = getConnections();
  const ws = connections.get(daemonId);
  if (ws === undefined) {
    logger.warn({ daemonId }, "Selected daemon has no active connection");
    return false;
  }

  const offerId = crypto.randomUUID();

  await markExecutionOffered(job.deliveryId, daemonId);

  if (isScopedJob(job)) {
    ws.sendText(JSON.stringify(buildScopedJobOfferEnvelope(offerId, job)));
  } else {
    ws.sendText(
      JSON.stringify({
        type: "job:offer",
        ...createMessageEnvelope(offerId),
        payload: {
          deliveryId: job.deliveryId,
          repoOwner: job.repoOwner,
          repoName: job.repoName,
          entityNumber: job.entityNumber,
          isPR: job.isPR,
          eventName: job.eventName,
          triggerUsername: job.triggerUsername,
          labels: job.labels,
          triggerBodyPreview: job.triggerBodyPreview,
          requiredTools,
        },
      }),
    );
  }

  const timer = setTimeout(() => {
    void handleOfferTimeout(offerId);
  }, config.offerTimeoutMs);

  pendingOffers.set(offerId, {
    offerId,
    deliveryId: job.deliveryId,
    daemonId,
    timer,
    offeredAt: Date.now(),
    retryCount: job.retryCount,
    repoOwner: job.repoOwner,
    repoName: job.repoName,
    entityNumber: job.entityNumber,
    isPR: job.isPR,
    eventName: job.eventName,
    triggerUsername: job.triggerUsername,
    labels: job.labels,
    triggerBodyPreview: job.triggerBodyPreview,
    ...(job.kind === "workflow-run" ? { workflowRun: normalizeWorkflowRun(job.workflowRun) } : {}),
    ...(isScopedJob(job) ? { scoped: job } : {}),
  });

  logger.info(
    { kind: job.kind, deliveryId: job.deliveryId, daemonId, offerId },
    "Job offered to daemon",
  );

  return true;
}

/**
 * `WorkflowRunRef` declares optional fields without `| undefined`; the
 * Zod-inferred shape includes `| undefined` because Zod surfaces missing
 * keys as `undefined`. Strip the explicit `undefined` keys so the value
 * fits `exactOptionalPropertyTypes: true` consumers like `PendingOffer`.
 */
function normalizeWorkflowRun(ref: {
  runId: string;
  workflowName: WorkflowRunRef["workflowName"];
  parentRunId?: string | undefined;
  parentStepIndex?: number | undefined;
}): WorkflowRunRef {
  const result: WorkflowRunRef = { runId: ref.runId, workflowName: ref.workflowName };
  if (ref.parentRunId !== undefined && ref.parentStepIndex !== undefined) {
    return { ...result, parentRunId: ref.parentRunId, parentStepIndex: ref.parentStepIndex };
  }
  if (ref.parentRunId !== undefined) {
    return { ...result, parentRunId: ref.parentRunId };
  }
  if (ref.parentStepIndex !== undefined) {
    return { ...result, parentStepIndex: ref.parentStepIndex };
  }
  return result;
}

/**
 * Build the `scoped-job-offer` envelope from a scoped queue payload. The
 * shape mirrors `contracts/ws-messages.md`: only the per-kind discriminating
 * fields are included so the daemon can route via Zod discriminated-union
 * parse before any executor runs.
 */
function buildScopedJobOfferEnvelope(
  offerId: string,
  job: ScopedQueuedJob,
): Record<string, unknown> {
  const base = {
    type: "scoped-job-offer" as const,
    ...createMessageEnvelope(offerId),
  };
  switch (job.kind) {
    case "scoped-rebase":
      return {
        ...base,
        payload: {
          jobKind: job.kind,
          deliveryId: job.deliveryId,
          installationId: job.installationId,
          owner: job.repoOwner,
          repo: job.repoName,
          prNumber: job.prNumber,
          triggerCommentId: job.triggerCommentId,
          enqueuedAt: job.enqueuedAt,
        },
      };
    case "scoped-fix-thread":
      return {
        ...base,
        payload: {
          jobKind: job.kind,
          deliveryId: job.deliveryId,
          installationId: job.installationId,
          owner: job.repoOwner,
          repo: job.repoName,
          prNumber: job.prNumber,
          threadRef: job.threadRef,
          triggerCommentId: job.triggerCommentId,
          enqueuedAt: job.enqueuedAt,
        },
      };
    case "scoped-open-pr":
      return {
        ...base,
        payload: {
          jobKind: job.kind,
          deliveryId: job.deliveryId,
          installationId: job.installationId,
          owner: job.repoOwner,
          repo: job.repoName,
          issueNumber: job.issueNumber,
          triggerCommentId: job.triggerCommentId,
          enqueuedAt: job.enqueuedAt,
          verdictSummary: job.verdictSummary,
        },
      };
    case "scheduled-action":
      return {
        ...base,
        payload: {
          jobKind: job.kind,
          deliveryId: job.deliveryId,
          installationId: job.installationId,
          owner: job.repoOwner,
          repo: job.repoName,
          actionName: job.actionName,
          cronSlotIso: job.cronSlotIso,
          promptText: job.promptText,
          ...(job.model !== undefined ? { model: job.model } : {}),
          ...(job.maxTurns !== undefined ? { maxTurns: job.maxTurns } : {}),
          ...(job.timeoutMs !== undefined ? { timeoutMs: job.timeoutMs } : {}),
          ...(job.allowedTools !== undefined ? { allowedTools: job.allowedTools } : {}),
          autoMerge: job.autoMerge,
          enqueuedAt: job.enqueuedAt,
        },
      };
  }
}

/**
 * Handle offer timeout: daemon didn't respond within offerTimeoutMs.
 * Re-queue or fail the job.
 */
async function handleOfferTimeout(offerId: string): Promise<void> {
  const offer = pendingOffers.get(offerId);
  if (offer === undefined) return; // Already handled (accepted or rejected)

  pendingOffers.delete(offerId);

  logger.warn(
    { deliveryId: offer.deliveryId, daemonId: offer.daemonId, offerId },
    "Job offer timed out",
  );

  // Re-queue the execution
  await requeueExecution(offer.deliveryId);

  const job = reconstructJobFromOffer(offer);
  if (job === null) {
    await markExecutionFailed(
      offer.deliveryId,
      "PendingOffer.scoped failed re-validation, refusing legacy fallback dispatch",
    );
    return;
  }

  const requeued = await requeueJob(job);
  if (!requeued) {
    await markJobTerminallyFailed(job, "All daemons rejected or timed out after maximum retries");
  }
}

/**
 * Reconstruct a `QueuedJob` from the in-memory `PendingOffer` so the same
 * payload can be re-queued on reject/timeout. Scoped offers preserve the
 * original scoped queue payload verbatim: every per-kind field survives the
 * round-trip so re-dispatch keeps the same daemon contract.
 *
 * `offer.scoped` is typed `unknown` in shared/daemon-types so the shared
 * module does not import orchestrator-only Zod schemas. The dispatcher
 * always stores `ScopedQueuedJob` shapes there, but a malformed write or a
 * test harness mutation would slip through; re-validate with the discriminated
 * union before casting so the failure surfaces at the queue boundary instead
 * of inside an async timeout/reject path.
 */
function reconstructJobFromOffer(offer: PendingOffer): QueuedJob | null {
  if (offer.scoped !== undefined) {
    const reparsed = QueuedJobSchema.safeParse(offer.scoped);
    if (!reparsed.success || !isScopedJob(reparsed.data)) {
      logger.error(
        {
          offerId: offer.offerId,
          deliveryId: offer.deliveryId,
          issues: reparsed.success ? "shape-not-scoped" : reparsed.error.issues,
        },
        "PendingOffer.scoped failed re-validation, failing job (do not fall back to legacy reconstruct)",
      );
      // Fail closed: a corrupted scoped offer must NOT be reconstructed as a
      // legacy or workflow-run job: that would dispatch the wrong job kind
      // against the same repo/PR. Caller marks the execution failed.
      return null;
    }
    const scoped: ScopedQueuedJob = reparsed.data;
    return { ...scoped, retryCount: offer.retryCount, enqueuedAt: Date.now() };
  }
  if (offer.workflowRun !== undefined) {
    return {
      kind: "workflow-run",
      deliveryId: offer.deliveryId,
      repoOwner: offer.repoOwner,
      repoName: offer.repoName,
      entityNumber: offer.entityNumber,
      isPR: offer.isPR,
      eventName: offer.eventName,
      triggerUsername: offer.triggerUsername,
      labels: offer.labels,
      triggerBodyPreview: offer.triggerBodyPreview,
      enqueuedAt: Date.now(),
      retryCount: offer.retryCount,
      workflowRun: offer.workflowRun,
    };
  }
  return {
    kind: "legacy",
    deliveryId: offer.deliveryId,
    repoOwner: offer.repoOwner,
    repoName: offer.repoName,
    entityNumber: offer.entityNumber,
    isPR: offer.isPR,
    eventName: offer.eventName,
    triggerUsername: offer.triggerUsername,
    labels: offer.labels,
    triggerBodyPreview: offer.triggerBodyPreview,
    enqueuedAt: Date.now(),
    retryCount: offer.retryCount,
  };
}

/**
 * Handle a job:accept message from a daemon.
 * Sends the full job:payload with context and installation token.
 */
export interface JobAcceptParams {
  offerId: string;
  daemonId: string;
  deliveryId: string;
  installationToken: string;
  contextJson: Record<string, unknown>;
  /** Optional turn cap. Omitted = no cap (the SDK runs the agent to completion). */
  maxTurns?: number;
  allowedTools: string[];
  envVars: Record<string, string>;
  memory: { id: string; category: string; content: string; pinned: boolean }[];
  /** Present for workflow-run jobs, forwarded verbatim into `job:payload`. */
  workflowRun?: WorkflowRunRef;
  /** Present for scoped jobs, forwarded verbatim into `job:payload` so the
   * daemon's `runScopedJob` router can dispatch on `scoped.jobKind`. */
  scoped?: ScopedJobContext;
}

export function handleJobAccept({
  offerId,
  daemonId,
  deliveryId,
  installationToken,
  contextJson,
  maxTurns,
  allowedTools,
  envVars,
  memory,
  workflowRun,
  scoped,
}: JobAcceptParams): void {
  // Note: the pending offer is already removed by handleAccept in connection-handler.ts
  // before this function is called (C2 fix, prevents timeout/accept race).

  const connections = getConnections();
  const ws = connections.get(daemonId);
  if (ws === undefined) {
    logger.error({ daemonId, offerId }, "Daemon disconnected before payload delivery");
    return;
  }

  ws.sendText(
    JSON.stringify({
      type: "job:payload",
      ...createMessageEnvelope(offerId),
      payload: {
        context: contextJson,
        installationToken,
        ...(maxTurns !== undefined ? { maxTurns } : {}),
        allowedTools,
        ...(Object.keys(envVars).length > 0 ? { envVars } : {}),
        ...(memory.length > 0 ? { memory } : {}),
        ...(workflowRun !== undefined ? { workflowRun } : {}),
        ...(scoped !== undefined ? { scoped } : {}),
      },
    }),
  );

  logger.info(
    { deliveryId, daemonId, offerId, jobKind: scoped?.jobKind ?? "non-scoped" },
    "Job payload sent to daemon",
  );
}

/**
 * Handle a job:reject message from a daemon.
 * Re-queue the job for another daemon.
 */
export async function handleJobReject(offerId: string, reason: string): Promise<void> {
  const offer = pendingOffers.get(offerId);
  if (offer === undefined) {
    logger.warn({ offerId }, "Reject for unknown/expired offer");
    return;
  }

  clearTimeout(offer.timer);
  pendingOffers.delete(offerId);

  logger.info(
    { deliveryId: offer.deliveryId, daemonId: offer.daemonId, reason },
    "Job rejected by daemon",
  );

  // Re-queue the execution back to 'queued'
  await requeueExecution(offer.deliveryId);

  // Re-enqueue the job with original metadata (retryCount incremented by requeueJob)
  const job = reconstructJobFromOffer(offer);
  if (job === null) {
    await markExecutionFailed(
      offer.deliveryId,
      "PendingOffer.scoped failed re-validation, refusing legacy fallback dispatch",
    );
    return;
  }
  const requeued = await requeueJob(job);
  if (!requeued) {
    await markJobTerminallyFailed(
      job,
      `All daemons rejected after maximum retries. Last reason: ${reason}`,
    );
  }
}

/**
 * Terminal failure write that covers both the legacy `executions` row (set by
 * `src/webhook/router.ts` for the `@chrisleekr-bot` mention path) and the
 * `workflow_runs` row (set by the workflow dispatcher path). Either or both
 * may be present for a given job; UPDATEs are no-ops when the row is absent.
 *
 * Marking the `workflow_runs` row as `failed` is essential: the partial
 * unique index `idx_workflow_runs_inflight` prevents future dispatches for
 * the same target until this row leaves the queued/running states.
 */
export async function markJobTerminallyFailed(job: QueuedJob, reason: string): Promise<void> {
  await markExecutionFailed(job.deliveryId, reason);
  if (job.kind === "workflow-run") {
    try {
      await markWorkflowRunFailed(job.workflowRun.runId, reason, {});
    } catch (err) {
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          runId: job.workflowRun.runId,
          deliveryId: job.deliveryId,
        },
        "Failed to mark workflow_runs row as failed, in-flight guard may block re-dispatch",
      );
    }
  }
}
