import { config } from "../config";
import { getDb } from "../db";
import { EphemeralSpawnError, spawnEphemeralDaemon } from "../k8s/ephemeral-daemon-spawner";
import { getActiveCount, isAtCapacity } from "../orchestrator/concurrency";
import { getPersistentPoolFreeSlots } from "../orchestrator/daemon-registry";
import {
  decideEphemeralSpawn,
  markSpawn,
  rollbackSpawn,
} from "../orchestrator/ephemeral-daemon-scaler";
import { createExecution } from "../orchestrator/history";
import { dispatchJob } from "../orchestrator/job-dispatcher";
import { enqueueJob, getQueueLength, type QueuedJob } from "../orchestrator/job-queue";
import { triageRequest, type TriageResult } from "../orchestrator/triage";
import { isValkeyHealthy } from "../orchestrator/valkey";
import type { DispatchReason, DispatchTarget } from "../shared/dispatch-types";
import { type BotContext, serializeBotContext } from "../types";
import { safePostToGitHub } from "../utils/github-output-guard";
import { isOwnerAllowed } from "./authorize";
import { getTriageLLMClient } from "./triage-client-factory";

/**
 * DispatchDecision: the in-memory record the router produces for each
 * event. Post dispatch-collapse, target is always `"daemon"`; the reason
 * carries the four-valued routing verdict (persistent vs ephemeral vs
 * spawn-failed). `triage` is populated when the LLM classifier returned a
 * parsed result; `triageAttempted` is true whenever the LLM path ran at
 * all (even on parse/timeout/circuit-open fallbacks).
 */
export interface DispatchDecision {
  target: DispatchTarget;
  reason: DispatchReason;
  triage?: TriageResult;
  triageAttempted?: boolean;
  /**
   * Set when `reason === "ephemeral-spawn-failed"`. Retained for operator-side
   * surfaces only (structured logs, executions row): never interpolated into
   * public GitHub comments because the underlying error string can embed an
   * installation token or other Kubernetes API detail.
   */
  spawnError?: string;
}

export function logDispatchDecision(ctx: BotContext, decision: DispatchDecision): void {
  const triage = decision.triage;
  ctx.log.info(
    {
      deliveryId: ctx.deliveryId,
      owner: ctx.owner,
      repo: ctx.repo,
      eventType: ctx.eventName,
      dispatchTarget: decision.target,
      dispatchReason: decision.reason,
      triageInvoked: decision.triageAttempted === true,
      ...(triage !== undefined && {
        triageHeavy: triage.heavy,
        triageConfidence: triage.confidence,
        triageModel: triage.model,
        triageProvider: triage.provider,
        triageLatencyMs: triage.latencyMs,
        triageCostUsd: triage.costUsd,
      }),
      ...(decision.spawnError !== undefined && { spawnError: decision.spawnError }),
    },
    "dispatch decision",
  );
}

/**
 * Triage + dispatch a single request through the orchestrator → daemon flow.
 *
 * Reachable ONLY via the dev-only `/api/test/webhook` endpoint (`app.ts`,
 * 404 in production); production webhook handlers in `webhook/events/*`
 * bypass this path entirely. It carries no idempotency layer of its own:
 * the dev endpoint mints a fresh synthetic delivery id per call so there
 * is nothing to dedup, and real redelivery dedup belongs to the production
 * handlers (`claimDelivery` + the `idx_workflow_runs_inflight` backstop,
 * issue #202). The legacy in-memory Map + `isAlreadyProcessed()` durable
 * scan that used to guard this entry point were retired in issue #211.
 */
export async function processRequest(ctx: BotContext): Promise<void> {
  // Owner allowlist check, MUST run before any GitHub side effects to
  // preserve the "silent skip" guarantee for non-allowlisted repos.
  const authResult = isOwnerAllowed(ctx.owner, ctx.log);
  if (!authResult.allowed) {
    ctx.log.info({ reason: authResult.reason }, "skipping request, owner not allowlisted");
    return;
  }

  if (isAtCapacity()) {
    const currentCount = getActiveCount();
    ctx.log.warn(
      { activeCount: currentCount, limit: config.maxConcurrentRequests },
      "Concurrency limit reached, rejecting request",
    );
    try {
      await safePostToGitHub({
        body: `**${config.triggerPhrase}** is at capacity (${currentCount}/${config.maxConcurrentRequests} concurrent requests active). Please re-trigger in a moment.`,
        source: "system",
        callsite: "webhook.router.capacity",
        log: ctx.log,
        deliveryId: ctx.deliveryId,
        post: (cleanBody) =>
          ctx.octokit.rest.issues.createComment({
            owner: ctx.owner,
            repo: ctx.repo,
            issue_number: ctx.entityNumber,
            body: cleanBody,
          }),
      });
    } catch (commentError) {
      ctx.log.error({ err: commentError }, "Failed to post capacity comment");
    }
    return;
  }

  const decision = await decideDispatch(ctx);

  logDispatchDecision(ctx, decision);

  await dispatch(ctx, decision);
}

/**
 * Pick a DispatchReason for this event. The target is always `"daemon"`,
 * the reason distinguishes persistent-pool routing from ephemeral scale-up.
 *
 * Flow:
 *   1. Run triage; extract the binary `heavy` signal (defaults to `false` on fallback).
 *   2. Poll queue length + persistent free slots.
 *   3. Ask the scaler whether an ephemeral spawn is warranted (honouring cooldown).
 *   4. If spawn: attempt `spawnEphemeralDaemon`; on K8s failure return
 *      `ephemeral-spawn-failed` so the tracking comment surfaces it.
 *   5. Otherwise: route to the persistent pool.
 */
export async function decideDispatch(ctx: BotContext): Promise<DispatchDecision> {
  const triageOutcome = await triageRequest(
    {
      deliveryId: ctx.deliveryId,
      owner: ctx.owner,
      repo: ctx.repo,
      eventName: ctx.eventName,
      isPR: ctx.isPR,
      labels: ctx.labels,
      triggerBody: ctx.triggerBody,
      // Issue #117: pass octokit + entityNumber so triage can sample fresh
      // PR state via the github-state tools when text alone is ambiguous.
      // Tools are only used on PR events; the triage executor checks isPR
      // before activating the tool path.
      ...(ctx.isPR ? { octokit: ctx.octokit, prNumber: ctx.entityNumber } : {}),
    },
    getTriageLLMClient(),
  );

  const triage = triageOutcome.outcome === "result" ? triageOutcome.result : undefined;
  const triageAttempted =
    triageOutcome.outcome === "result" ||
    (triageOutcome.outcome === "fallback" && triageOutcome.reason !== "disabled");
  const heavy = triage?.heavy ?? false;

  const queueLength = await getQueueLength();
  const persistentFreeSlots = await getPersistentPoolFreeSlots();

  const verdict = decideEphemeralSpawn({
    heavy,
    queueLength,
    persistentFreeSlots,
    now: Date.now(),
  });

  if (!verdict.spawn) {
    return {
      target: "daemon",
      reason: "persistent-daemon",
      ...(triage !== undefined && { triage }),
      ...(triageAttempted && { triageAttempted: true }),
    };
  }

  const image = config.daemonImage;
  const orchestratorUrl = config.orchestratorPublicUrl;
  const daemonAuthToken = config.daemonAuthToken;
  if (
    image === undefined ||
    image === "" ||
    orchestratorUrl === undefined ||
    orchestratorUrl === "" ||
    daemonAuthToken === undefined ||
    daemonAuthToken === ""
  ) {
    const missing = [
      image === undefined || image === "" ? "DAEMON_IMAGE" : null,
      orchestratorUrl === undefined || orchestratorUrl === "" ? "ORCHESTRATOR_PUBLIC_URL" : null,
      daemonAuthToken === undefined || daemonAuthToken === "" ? "DAEMON_AUTH_TOKEN" : null,
    ]
      .filter((v): v is string => v !== null)
      .join(", ");
    ctx.log.error(
      { deliveryId: ctx.deliveryId, missing },
      "Ephemeral daemon spawn required but scaler config is incomplete",
    );
    return {
      target: "daemon",
      reason: "ephemeral-spawn-failed",
      spawnError: `infra-absent: missing ${missing}`,
      ...(triage !== undefined && { triage }),
      ...(triageAttempted && { triageAttempted: true }),
    };
  }

  // Reserve the cooldown slot BEFORE awaiting the K8s round-trip so N
  // concurrent webhooks cannot each pass the cooldown check and trigger
  // N simultaneous Pod creations. If the spawn then fails we roll the
  // timestamp back so the next legitimate attempt isn't blocked.
  const spawnAttemptAt = Date.now();
  markSpawn(spawnAttemptAt);
  try {
    await spawnEphemeralDaemon({
      deliveryId: ctx.deliveryId,
      image,
      orchestratorUrl,
    });
    return {
      target: "daemon",
      reason:
        verdict.trigger === "triage-heavy"
          ? "ephemeral-daemon-triage"
          : "ephemeral-daemon-overflow",
      ...(triage !== undefined && { triage }),
      ...(triageAttempted && { triageAttempted: true }),
    };
  } catch (err) {
    // Spawn failed, release only *our* reservation. Unconditionally
    // zeroing the timestamp would stomp on a newer concurrent spawn
    // that already won the cooldown race while this call was in flight,
    // reopening the thundering-herd window the cooldown exists to close.
    rollbackSpawn(spawnAttemptAt);
    const kind = err instanceof EphemeralSpawnError ? err.kind : undefined;
    const message =
      err instanceof EphemeralSpawnError
        ? `${err.kind}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    ctx.log.error(
      { err, deliveryId: ctx.deliveryId, spawnErrorKind: kind },
      "Ephemeral daemon spawn failed, rejecting request",
    );
    return {
      target: "daemon",
      reason: "ephemeral-spawn-failed",
      spawnError: message,
      ...(triage !== undefined && { triage }),
      ...(triageAttempted && { triageAttempted: true }),
    };
  }
}

export async function dispatch(ctx: BotContext, decision: DispatchDecision): Promise<void> {
  if (decision.reason === "ephemeral-spawn-failed") {
    await recordSpawnFailedRejection(ctx, decision);
    return;
  }
  await dispatchDaemon(ctx, decision);
}

/**
 * FR: graceful rejection when Kubernetes cannot spawn the ephemeral daemon
 * required to serve this request. Writes an executions row for analytics
 * and posts an infrastructure-unavailable comment. Never silently routes
 * to the persistent pool: if the scaler decided a spawn was needed, the
 * persistent pool is not expected to absorb the work.
 */
async function recordSpawnFailedRejection(
  ctx: BotContext,
  decision: DispatchDecision,
): Promise<void> {
  ctx.log.warn(
    { deliveryId: ctx.deliveryId, spawnError: decision.spawnError },
    "Request rejected, ephemeral-daemon spawn failed",
  );

  const db = getDb();
  if (db !== null) {
    try {
      await createExecution({
        deliveryId: ctx.deliveryId,
        repoOwner: ctx.owner,
        repoName: ctx.repo,
        entityNumber: ctx.entityNumber,
        entityType: ctx.isPR ? "pull_request" : "issue",
        eventName: ctx.eventName,
        triggerUsername: ctx.triggerUsername,
        dispatchMode: "daemon",
        dispatchReason: "ephemeral-spawn-failed",
        ...(decision.triage !== undefined && {
          triageConfidence: decision.triage.confidence,
          triageCostUsd: decision.triage.costUsd,
        }),
        contextJson: serializeBotContext(ctx),
      });
    } catch (recordErr) {
      ctx.log.error(
        { err: recordErr },
        "Failed to write ephemeral-spawn-failed execution row (non-fatal)",
      );
    }
  }

  try {
    // Public comment, do NOT include `decision.spawnError`. The raw
    // text can carry K8s API URLs, RBAC detail, or other operational
    // info. The structured spawn error is already on the log line and
    // in the executions row for operators.
    await safePostToGitHub({
      body:
        `**${config.triggerPhrase}** cannot dispatch this request: scaling up the ephemeral ` +
        `daemon pool requires Kubernetes infrastructure that is unavailable right now. ` +
        `Please re-trigger in a few minutes; if this persists, check server logs.`,
      source: "system",
      callsite: "webhook.router.ephemeral-spawn-failed",
      log: ctx.log,
      deliveryId: ctx.deliveryId,
      post: (cleanBody) =>
        ctx.octokit.rest.issues.createComment({
          owner: ctx.owner,
          repo: ctx.repo,
          issue_number: ctx.entityNumber,
          body: cleanBody,
        }),
    });
  } catch (commentError) {
    ctx.log.error({ err: commentError }, "Failed to post ephemeral-spawn-failed comment");
  }
}

/**
 * Daemon dispatch: validate Valkey health, persist the executions row,
 * attempt direct dispatch to a claimable daemon, fall back to enqueue.
 * The concurrency slot is owned by handleAccept/handleResult in
 * connection-handler.ts; this function only writes the executions row and
 * publishes the queued job. Capacity bookkeeping is no longer this layer's
 * concern.
 */
async function dispatchDaemon(ctx: BotContext, decision: DispatchDecision): Promise<void> {
  if (!isValkeyHealthy()) {
    ctx.log.error("Valkey unavailable, rejecting request (FM-7)");
    try {
      await safePostToGitHub({
        body: `**${config.triggerPhrase}** cannot process this request: the job queue service is temporarily unavailable. Please try again in a few minutes.`,
        source: "system",
        callsite: "webhook.router.valkey-unavailable",
        log: ctx.log,
        deliveryId: ctx.deliveryId,
        post: (cleanBody) =>
          ctx.octokit.rest.issues.createComment({
            owner: ctx.owner,
            repo: ctx.repo,
            issue_number: ctx.entityNumber,
            body: cleanBody,
          }),
      });
    } catch (commentError) {
      ctx.log.error({ err: commentError }, "Failed to post Valkey unavailable comment");
    }
    return;
  }

  const serializedCtx = serializeBotContext(ctx);
  await createExecution({
    deliveryId: ctx.deliveryId,
    repoOwner: ctx.owner,
    repoName: ctx.repo,
    entityNumber: ctx.entityNumber,
    entityType: ctx.isPR ? "pull_request" : "issue",
    eventName: ctx.eventName,
    triggerUsername: ctx.triggerUsername,
    dispatchMode: "daemon",
    dispatchReason: decision.reason,
    ...(decision.triage !== undefined && {
      triageConfidence: decision.triage.confidence,
      triageCostUsd: decision.triage.costUsd,
    }),
    contextJson: serializedCtx,
  });

  const queuedJob: QueuedJob = {
    kind: "legacy",
    deliveryId: ctx.deliveryId,
    repoOwner: ctx.owner,
    repoName: ctx.repo,
    entityNumber: ctx.entityNumber,
    isPR: ctx.isPR,
    eventName: ctx.eventName,
    triggerUsername: ctx.triggerUsername,
    labels: ctx.labels,
    triggerBodyPreview: ctx.triggerBody.slice(0, 200),
    enqueuedAt: Date.now(),
    retryCount: 0,
  };

  const dispatched = await dispatchJob(queuedJob);
  if (dispatched) {
    ctx.log.info({ deliveryId: ctx.deliveryId }, "Job dispatched to daemon");
  } else {
    await enqueueJob(queuedJob);
    ctx.log.info(
      { deliveryId: ctx.deliveryId },
      "No daemon available, job enqueued, awaiting daemon claim",
    );
  }
}
