import { rmSync } from "node:fs";

import { Octokit } from "octokit";

import { config } from "../config";
import { runPipeline } from "../core/pipeline";
import { createChildLogger, logger } from "../logger";
import type { ActiveJob, DaemonCapabilities, SerializableBotContext } from "../shared/daemon-types";
import {
  createMessageEnvelope,
  type JobCancelMessage,
  type JobOfferMessage,
  type JobPayloadMessage,
  type ScopedJobKind,
  type ScopedJobOfferMessage,
  WS_REJECT_REASONS,
} from "../shared/ws-messages";
import { executeWorkflowRun } from "./workflow-executor";

// Active job tracking (FM-9)

const activeJobs = new Map<string, ActiveJob>();
/** Abort controllers keyed by offerId, used to prevent cancel/execute race sending duplicate job:result. */
const jobAbortControllers = new Map<string, AbortController>();

export function getActiveJobs(): ActiveJob[] {
  return [...activeJobs.values()];
}

export function getActiveJobCount(): number {
  return activeJobs.size;
}

/**
 * Register a process.on('exit') handler for sync cleanup of all tracked
 * work directories. This catches SIGKILL indirectly (node runs exit handlers
 * for process.exit() calls) and provides a last-resort cleanup path (FM-9).
 */
export function registerExitCleanup(): void {
  process.on("exit", () => {
    for (const job of activeJobs.values()) {
      // Scoped jobs never own a workspace path; skip the rm so we do not
      // accidentally target `.cred.sh` in the daemon's CWD.
      if (job.workDir === "") continue;
      try {
        rmSync(job.workDir, { recursive: true, force: true });
      } catch {
        // Best effort on exit
      }
      // Credential helper (${workDir}.cred.sh) is written by checkoutRepo beside
      // the workspace and contains the installation token, remove it too so a
      // SIGKILL / crash does not leak it for the app.ts stale-cred sweep window.
      try {
        rmSync(`${job.workDir}.cred.sh`, { force: true });
      } catch {
        // Best effort on exit
      }
    }
  });
}

// Offer evaluation (T029, FR-010, R-007)

const MAX_CONCURRENT_JOBS = parseInt(process.env["DAEMON_MAX_CONCURRENT_JOBS"] ?? "3", 10);

/**
 * Evaluate whether this daemon should accept a job offer.
 * Checks tool requirements, memory floor, disk floor, and capacity.
 */
export function evaluateOffer(
  offer: JobOfferMessage,
  capabilities: DaemonCapabilities,
): { accept: boolean; reason?: string } {
  // Check required tools
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
  if (capabilities.containerRuntime?.daemonRunning === true) {
    functionalTools.add(capabilities.containerRuntime.name);
  }

  for (const required of offer.payload.requiredTools) {
    if (!functionalTools.has(required)) {
      return { accept: false, reason: `missing tool: ${required}` };
    }
  }

  // Check memory floor
  if (capabilities.resources.memoryFreeMb < config.daemonMemoryFloorMb) {
    return {
      accept: false,
      reason: `insufficient memory: ${capabilities.resources.memoryFreeMb}MB < ${config.daemonMemoryFloorMb}MB minimum`,
    };
  }

  // Check disk floor
  if (capabilities.resources.diskFreeMb < config.daemonDiskFloorMb) {
    return {
      accept: false,
      reason: `insufficient disk: ${capabilities.resources.diskFreeMb}MB < ${config.daemonDiskFloorMb}MB minimum`,
    };
  }

  // Check capacity
  if (activeJobs.size >= MAX_CONCURRENT_JOBS) {
    return {
      accept: false,
      reason: `at capacity: ${activeJobs.size}/${MAX_CONCURRENT_JOBS} jobs active`,
    };
  }

  return { accept: true };
}

/**
 * Evaluate a `scoped-job-offer`. Scoped jobs do not declare `requiredTools`
 * (the four executors only need git + bun, both baseline) and do not consume
 * the legacy concurrency slot until `job:accept` is sent. The evaluator's
 * single responsibility is forward-compat: reject jobKinds this image does
 * not understand so the orchestrator can re-offer to a capable daemon.
 */
export function evaluateScopedOffer(
  offer: ScopedJobOfferMessage,
  capabilities: DaemonCapabilities,
  supportedKinds: readonly ScopedJobKind[],
): { accept: boolean; reason?: string } {
  if (!supportedKinds.includes(offer.payload.jobKind)) {
    return { accept: false, reason: WS_REJECT_REASONS.SCOPED_KIND_UNSUPPORTED };
  }

  // Memory floor still applies, scoped-rebase clones a repo.
  if (capabilities.resources.memoryFreeMb < config.daemonMemoryFloorMb) {
    return {
      accept: false,
      reason: `insufficient memory: ${capabilities.resources.memoryFreeMb}MB < ${config.daemonMemoryFloorMb}MB minimum`,
    };
  }

  if (capabilities.resources.diskFreeMb < config.daemonDiskFloorMb) {
    return {
      accept: false,
      reason: `insufficient disk: ${capabilities.resources.diskFreeMb}MB < ${config.daemonDiskFloorMb}MB minimum`,
    };
  }

  if (activeJobs.size >= MAX_CONCURRENT_JOBS) {
    return {
      accept: false,
      reason: WS_REJECT_REASONS.BUSY,
    };
  }

  return { accept: true };
}

// Helpers extracted from executeJob to reduce complexity / statement count

/** Validate critical context fields at boundary. Returns false if invalid (sends error result). */
function validateJobContext(
  context: SerializableBotContext,
  offerId: string,
  send: (msg: unknown) => void,
): boolean {
  if (
    typeof context.deliveryId !== "string" ||
    typeof context.owner !== "string" ||
    typeof context.repo !== "string" ||
    typeof context.entityNumber !== "number"
  ) {
    logger.error({ offerId }, "Job payload has malformed context, missing critical fields");
    send({
      type: "job:result",
      ...createMessageEnvelope(offerId),
      payload: {
        success: false,
        deliveryId: typeof context.deliveryId === "string" ? context.deliveryId : "unknown",
        durationMs: 0,
        errorMessage: "Malformed context: missing deliveryId, owner, repo, or entityNumber",
      },
    });
    return false;
  }
  return true;
}

/** Send a synthetic success result for dry-run mode. */
function sendDryRunResult(
  offerId: string,
  deliveryId: string,
  startedAt: number,
  aborted: boolean,
  send: (msg: unknown) => void,
): void {
  if (aborted) return;
  send({
    type: "job:result",
    ...createMessageEnvelope(offerId),
    payload: {
      success: true,
      deliveryId,
      durationMs: Date.now() - startedAt,
      costUsd: 0,
      numTurns: 0,
      dryRun: true,
    },
  });
}

// Job execution (T027)

/**
 * Execute a job received via job:payload.
 * Clones repo, reconstructs BotContext, runs the pipeline, reports result.
 *
 * @param send - Function to send messages back to the orchestrator.
 */
export async function executeJob(
  payload: JobPayloadMessage,
  capabilities: DaemonCapabilities,
  send: (msg: unknown) => void,
): Promise<void> {
  const offerId = payload.id;
  const context = payload.payload.context as unknown as SerializableBotContext;

  // Scoped-* jobs route through their own deterministic/agent-driven
  // executors. They do NOT go through the legacy BotContext pipeline, so
  // dispatch BEFORE the (legacy-shaped) context validation below.
  //
  // Register the offer in `activeJobs` for the duration of the scoped run
  // so heartbeats, capacity checks, idle-shutdown, and `handleJobCancel`
  // see the daemon as busy (CR #3163385094). `runScopedJob` clears the
  // entry on completion via the same `activeJobs.delete` path the legacy
  // executor uses.
  if (payload.payload.scoped !== undefined) {
    // Register an AbortController so handleJobCancel can suppress the
    // duplicate `scoped-job-completion` that runScopedJob would otherwise
    // send after the cancel path's synthetic `job:result`. Without this,
    // a cancel during a scoped run double-finalizes the execution and
    // double-decrements the orchestrator capacity counter.
    const scopedAbort = new AbortController();
    jobAbortControllers.set(offerId, scopedAbort);
    activeJobs.set(offerId, {
      offerId,
      deliveryId: payload.payload.scoped.deliveryId,
      // No workspace path for scoped jobs; cleanup paths must guard on
      // `workDir !== ""` before deriving credential-helper filenames.
      workDir: "",
      agentPid: null,
      startedAt: Date.now(),
    });
    try {
      await runScopedJob(payload, capabilities, send, scopedAbort.signal);
    } finally {
      activeJobs.delete(offerId);
      jobAbortControllers.delete(offerId);
    }
    return;
  }

  if (!validateJobContext(context, offerId, send)) return;

  // Workflow-run jobs route through a registry-driven executor instead of
  // the legacy single-shot pipeline. Everything downstream of this branch
  // assumes a traditional BotContext pipeline run.
  if (payload.payload.workflowRun !== undefined) {
    await executeWorkflowRun(payload, send);
    return;
  }

  const { installationToken, maxTurns, allowedTools, envVars, memory } = payload.payload;

  // Abort controller for cancel/execute race prevention (C1)
  const abortController = new AbortController();
  jobAbortControllers.set(offerId, abortController);

  // Track active job (FM-9). `agentPid` is intentionally left null, the
  // Claude Agent SDK does not expose the subprocess PID, but the per-job
  // AbortController plumbed into runPipeline below already gives
  // handleJobCancel a clean way to terminate the agent (and its MCP servers)
  // by aborting the SDK iterator.
  const job: ActiveJob = {
    offerId,
    deliveryId: context.deliveryId,
    workDir: "", // Set after clone
    agentPid: null,
    startedAt: Date.now(),
  };
  activeJobs.set(offerId, job);

  send({
    type: "job:status",
    ...createMessageEnvelope(offerId),
    payload: { status: "cloning" },
  });

  try {
    const enrichedCtx = context as SerializableBotContext & {
      headBranch?: string;
      baseBranch?: string;
    };
    const headBranch = enrichedCtx.headBranch ?? enrichedCtx.defaultBranch;
    const baseBranch = enrichedCtx.baseBranch ?? enrichedCtx.defaultBranch;

    const octokit = new Octokit({ auth: installationToken });

    const childLog = createChildLogger({
      deliveryId: context.deliveryId,
      owner: context.owner,
      repo: context.repo,
      entityNumber: context.entityNumber,
    });

    // Build the full BotContext. `envVars` is threaded through the context so
    // the pipeline can write `.env` into the agent workspace after its own
    // checkout. A second (outer) checkout here would leave `.env` in a
    // throwaway directory that the agent never sees.
    const fullCtx = {
      ...context,
      octokit,
      log: childLog,
      headBranch,
      baseBranch,
      daemonCapabilities: capabilities,
      ...(memory !== undefined ? { repoMemory: memory } : {}),
      ...(envVars !== undefined && Object.keys(envVars).length > 0 ? { envVars } : {}),
    };

    if (context.dryRun === true) {
      childLog.info("Dry-run mode, skipping checkout and pipeline execution");
      sendDryRunResult(
        offerId,
        context.deliveryId,
        job.startedAt,
        abortController.signal.aborted,
        send,
      );
      return;
    }

    send({
      type: "job:status",
      ...createMessageEnvelope(offerId),
      payload: { status: "executing" },
    });

    // Honor orchestrator-approved execution limits (maxTurns, tool allowlist)
    // so daemon execution matches what the orchestrator authorized.
    // `onWorkDirReady` records the pipeline's workspace on the ActiveJob so
    // handleJobCancel and registerExitCleanup can rm it (and its `.cred.sh`)
    // even if the pipeline does not finish its own cleanup.
    const result = await runPipeline(fullCtx, {
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      allowedTools,
      onWorkDirReady: (wd: string) => {
        job.workDir = wd;
      },
      signal: abortController.signal,
    });
    const learnings = result.daemonActions?.learnings ?? [];
    const deletions = result.daemonActions?.deletions ?? [];

    childLog.info(
      {
        learningsCount: learnings.length,
        deletionsCount: deletions.length,
        learnings,
        deletions,
      },
      "Daemon actions collected from execution",
    );

    // Only send result if not cancelled (prevents duplicate job:result)
    if (!abortController.signal.aborted) {
      send({
        type: "job:result",
        ...createMessageEnvelope(offerId),
        payload: {
          success: result.success,
          deliveryId: context.deliveryId,
          durationMs: Date.now() - job.startedAt,
          costUsd: result.costUsd,
          numTurns: result.numTurns,
          ...(result.success ? {} : { errorMessage: "Pipeline completed with failure" }),
          ...(learnings.length > 0 ? { learnings } : {}),
          ...(deletions.length > 0 ? { deletions } : {}),
        },
      });
    }
  } catch (error) {
    // Only send error result if not cancelled (prevents duplicate job:result)
    if (!abortController.signal.aborted) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error({ err, offerId, deliveryId: context.deliveryId }, "Job execution failed");

      send({
        type: "job:result",
        ...createMessageEnvelope(offerId),
        payload: {
          success: false,
          deliveryId: context.deliveryId,
          durationMs: Date.now() - job.startedAt,
          errorMessage: err.message,
        },
      });
    }
  } finally {
    activeJobs.delete(offerId);
    jobAbortControllers.delete(offerId);
  }
}

// Scoped-job dispatch (US3 routing surface)

/**
 * Dispatch a `scoped-*` job:payload to the matching executor. The executor
 * implementations land in US3 (T029-T032); this surface throws a structured
 * `not implemented` error per kind so a daemon image without the executors
 * surfaces a clean halt rather than a silent drop.
 *
 * Routes via the Zod-validated `payload.scoped.jobKind` discriminator,
 * matches the `scoped-job-offer` schema at the WS boundary, so a misrouted
 * payload is impossible by construction.
 */
async function runScopedJob(
  payload: JobPayloadMessage,
  _capabilities: DaemonCapabilities,
  send: (msg: unknown) => void,
  signal: AbortSignal,
): Promise<void> {
  const scoped = payload.payload.scoped;
  if (scoped === undefined) {
    logger.error({ offerId: payload.id }, "runScopedJob called without scoped payload");
    return;
  }

  const offerId = payload.id;
  const startedAt = Date.now();
  const installationToken = payload.payload.installationToken;

  // Wrap `send` so every scoped-job-completion is suppressed after a cancel,
  // matching the legacy executor's abort-then-skip-result pattern. The cancel
  // path emits its own synthetic `job:result`; we MUST NOT also emit a
  // scoped-job-completion or the orchestrator will double-decrement capacity.
  const sendIfNotAborted = (msg: unknown): void => {
    if (signal.aborted) return;
    send(msg);
  };

  try {
    switch (scoped.jobKind) {
      case "scoped-rebase": {
        const { executeScopedRebase } = await import("./scoped-rebase-executor");
        const outcome = await executeScopedRebase({
          installationToken,
          owner: scoped.owner,
          repo: scoped.repo,
          prNumber: scoped.prNumber,
        });
        // Exhaustive mapping over RebaseOutcome.kind so a future variant
        // forces a TypeScript error instead of silently mapping to `closed`.
        const rebaseOutcome = ((): {
          result: "merged" | "conflict" | "up-to-date" | "closed";
          commentId: number;
          mergeCommitSha?: string;
          conflictPaths?: string[];
        } => {
          switch (outcome.kind) {
            case "merged":
              return {
                result: "merged",
                commentId: outcome.comment_id,
                mergeCommitSha: outcome.merge_commit_sha,
              };
            case "conflict":
              return {
                result: "conflict",
                commentId: outcome.comment_id,
                conflictPaths: [...outcome.conflict_paths],
              };
            case "up-to-date":
              return { result: "up-to-date", commentId: outcome.comment_id };
            case "closed":
              return { result: "closed", commentId: outcome.comment_id };
            default: {
              const _exhaustive: never = outcome;
              throw new Error(
                `unhandled RebaseOutcome.kind: ${(_exhaustive as { kind: string }).kind}`,
              );
            }
          }
        })();
        sendIfNotAborted({
          type: "scoped-job-completion",
          ...createMessageEnvelope(offerId),
          payload: {
            offerId,
            deliveryId: scoped.deliveryId,
            jobKind: "scoped-rebase",
            status: "succeeded" as const,
            durationMs: Date.now() - startedAt,
            rebaseOutcome,
          },
        });
        return;
      }
      case "scoped-fix-thread": {
        const { executeScopedFixThread } = await import("./scoped-fix-thread-executor");
        const outcome = await executeScopedFixThread({
          installationToken,
          owner: scoped.owner,
          repo: scoped.repo,
          prNumber: scoped.prNumber,
          threadRef: scoped.threadRef,
          triggerCommentId: scoped.triggerCommentId,
        });
        sendIfNotAborted({
          type: "scoped-job-completion",
          ...createMessageEnvelope(offerId),
          payload: {
            offerId,
            deliveryId: scoped.deliveryId,
            jobKind: "scoped-fix-thread",
            status: outcome.status,
            durationMs: Date.now() - startedAt,
            ...(outcome.threadReplyId !== undefined
              ? { threadReplyId: outcome.threadReplyId }
              : {}),
            ...(outcome.pushedCommitSha !== undefined
              ? { pushedCommitSha: outcome.pushedCommitSha }
              : {}),
            ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
          },
        });
        return;
      }
      case "scoped-open-pr": {
        const { executeScopedOpenPr } = await import("./scoped-open-pr-executor");
        const outcome = await executeScopedOpenPr({
          installationToken,
          owner: scoped.owner,
          repo: scoped.repo,
          issueNumber: scoped.issueNumber,
          triggerCommentId: scoped.triggerCommentId,
          verdictSummary: scoped.verdictSummary,
        });
        sendIfNotAborted({
          type: "scoped-job-completion",
          ...createMessageEnvelope(offerId),
          payload: {
            offerId,
            deliveryId: scoped.deliveryId,
            jobKind: "scoped-open-pr",
            status: outcome.status,
            durationMs: Date.now() - startedAt,
            ...(outcome.newPrNumber !== undefined ? { newPrNumber: outcome.newPrNumber } : {}),
            ...(outcome.pushedCommitSha !== undefined
              ? { pushedCommitSha: outcome.pushedCommitSha }
              : {}),
            ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
          },
        });
        return;
      }
      case "scheduled-action": {
        const { executeScheduledAction } = await import("./scheduled-action-executor");
        const outcome = await executeScheduledAction({
          installationToken,
          owner: scoped.owner,
          repo: scoped.repo,
          actionName: scoped.actionName,
          deliveryId: scoped.deliveryId,
          promptText: scoped.promptText,
          autoMerge: scoped.autoMerge,
          signal,
          ...(scoped.model !== undefined ? { model: scoped.model } : {}),
          ...(scoped.maxTurns !== undefined ? { maxTurns: scoped.maxTurns } : {}),
          ...(scoped.timeoutMs !== undefined ? { timeoutMs: scoped.timeoutMs } : {}),
          ...(scoped.allowedTools !== undefined ? { allowedTools: scoped.allowedTools } : {}),
        });
        sendIfNotAborted({
          type: "scoped-job-completion",
          ...createMessageEnvelope(offerId),
          payload: {
            offerId,
            deliveryId: scoped.deliveryId,
            jobKind: "scheduled-action",
            status: outcome.status,
            durationMs: Date.now() - startedAt,
            ...(outcome.outcome !== undefined ? { outcome: outcome.outcome } : {}),
            ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
          },
        });
        return;
      }
      default: {
        // Exhaustiveness check: a future jobKind addition with an older
        // daemon image lands here. Surface a structured failed completion
        // so the orchestrator can map it onto the user-facing reply path
        // rather than letting the offer silently time out.
        const _exhaustive: never = scoped;
        const unknownKind = (_exhaustive as { jobKind: string }).jobKind;
        logger.error(
          {
            event: "ship.scoped.unknown_kind.daemon.failed",
            offerId,
            jobKind: unknownKind,
          },
          "runScopedJob received unknown jobKind",
        );
        sendIfNotAborted({
          type: "scoped-job-completion",
          ...createMessageEnvelope(offerId),
          payload: {
            offerId,
            deliveryId: (_exhaustive as { deliveryId: string }).deliveryId,
            jobKind: unknownKind,
            status: "failed" as const,
            durationMs: Date.now() - startedAt,
            reason: `unknown scoped jobKind: ${unknownKind}`,
          },
        });
        return;
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Per-kind event key matches the FR-018 canonical names documented in
    // `docs/OBSERVABILITY.md` (e.g. `ship.scoped.rebase.daemon.failed`).
    const kindKey = scoped.jobKind.replace(/^scoped-/, "").replaceAll("-", "_");
    logger.error(
      {
        event: `ship.scoped.${kindKey}.daemon.failed`,
        offerId,
        jobKind: scoped.jobKind,
        deliveryId: scoped.deliveryId,
        reason,
      },
      "scoped-job execution failed",
    );
    sendIfNotAborted({
      type: "scoped-job-completion",
      ...createMessageEnvelope(offerId),
      payload: {
        offerId,
        deliveryId: scoped.deliveryId,
        jobKind: scoped.jobKind,
        status: "failed" as const,
        durationMs: Date.now() - startedAt,
        reason,
      },
    });
  }
}

// Job cancellation (T031)

/**
 * Handle a job:cancel message, kill agent subprocess, cleanup, report failure.
 */
export function handleJobCancel(cancel: JobCancelMessage, send: (msg: unknown) => void): void {
  const offerId = cancel.id;
  const job = activeJobs.get(offerId);

  if (job === undefined) {
    logger.warn({ offerId }, "Cancel received for unknown job");
    return;
  }

  logger.info(
    { offerId, deliveryId: job.deliveryId, reason: cancel.payload.reason },
    "Job cancelled",
  );

  // Signal abort to prevent executeJob from sending a duplicate job:result (C1)
  const abortController = jobAbortControllers.get(offerId);
  if (abortController !== undefined) {
    abortController.abort();
    jobAbortControllers.delete(offerId);
  }

  if (job.agentPid !== null) {
    try {
      process.kill(job.agentPid, "SIGTERM");
    } catch {
      // Process may have already exited
    }
  }

  if (job.workDir !== "") {
    try {
      rmSync(job.workDir, { recursive: true, force: true });
    } catch {
      // Best effort
    }
    try {
      rmSync(`${job.workDir}.cred.sh`, { force: true });
    } catch {
      // Best effort
    }
  }

  activeJobs.delete(offerId);

  // Report failure, only the cancel path sends job:result for cancelled jobs
  send({
    type: "job:result",
    ...createMessageEnvelope(offerId),
    payload: {
      success: false,
      deliveryId: job.deliveryId,
      durationMs: Date.now() - job.startedAt,
      errorMessage: `Cancelled: ${cancel.payload.reason}`,
    },
  });
}
