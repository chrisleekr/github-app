import { Octokit } from "octokit";

import { logger } from "../logger";
import type { SerializableBotContext } from "../shared/daemon-types";
import { createMessageEnvelope, type JobPayloadMessage } from "../shared/ws-messages";
import { addReaction, type ReactionContent } from "../utils/reactions";
import { type CompletionResult, onStepComplete } from "../workflows/orchestrator";
import { getByName, type WorkflowRunContext } from "../workflows/registry";
import {
  markFailed,
  markIncomplete,
  markRunning,
  markSucceeded,
  mergeState,
} from "../workflows/runs-store";
import { setState } from "../workflows/tracking-mirror";
import { getDaemonId } from "./daemon-id";

/**
 * Daemon-side entry point for jobs carrying a `workflowRun` field. Implements
 * T019 (job-type router) from `specs/20260421-181205-bot-workflows`:
 *
 *   1. Resolve registry entry by `workflowRun.workflowName`.
 *   2. Build `WorkflowRunContext` (logger + octokit + deliveryId + setState).
 *   3. `runs-store.markRunning(runId)`.
 *   4. Invoke handler.
 *   5. Translate `HandlerResult` → `markSucceeded` | `markFailed` plus a final
 *      `tracking-mirror.setState` write.
 *   6. On uncaught throw → `markFailed({ reason: "uncaught: <message>" })`.
 *   7. Send `job:result` back to orchestrator.
 *
 * Structured log bindings (T024): every log line emitted from `log` carries
 * `{ workflowRunId, workflowName, target, deliveryId, offerId }`.
 */
export async function executeWorkflowRun(
  payload: JobPayloadMessage,
  send: (msg: unknown) => void,
): Promise<void> {
  const offerId = payload.id;
  const startedAt = Date.now();
  const workflowRun = payload.payload.workflowRun;
  const context = payload.payload.context as unknown as SerializableBotContext;
  const installationToken = payload.payload.installationToken;
  const reviewLearnings = payload.payload.reviewLearnings;

  if (workflowRun === undefined) {
    // Defensive, `executeJob` already branches on this; if we get here the
    // caller routed an ordinary pipeline job to the wrong executor.
    logger.error({ offerId }, "executeWorkflowRun called without workflowRun, misrouted payload");
    return;
  }

  const target = {
    type: context.isPR ? ("pr" as const) : ("issue" as const),
    owner: context.owner,
    repo: context.repo,
    number: context.entityNumber,
  };

  const log = logger.child({
    offerId,
    workflowRunId: workflowRun.runId,
    workflowName: workflowRun.workflowName,
    deliveryId: context.deliveryId,
    target,
  });

  const octokit = new Octokit({ auth: installationToken });

  // Best-effort reaction on the user's trigger comment. No-op for child runs
  // (commentId === 0 because children inherit nothing from the parent's
  // dispatch payload) and for label-triggered runs (no comment exists).
  const reactOnTrigger = (content: ReactionContent): void => {
    if (context.commentId === 0) return;
    void addReaction({
      octokit,
      logger: log,
      owner: context.owner,
      repo: context.repo,
      commentId: context.commentId,
      eventType: context.eventName,
      content,
    });
  };

  try {
    const entry = getByName(workflowRun.workflowName);
    const daemonId = getDaemonId();
    await markRunning(workflowRun.runId, daemonId);

    const runCtx: WorkflowRunContext = {
      runId: workflowRun.runId,
      workflowName: workflowRun.workflowName,
      target,
      ...(workflowRun.parentRunId !== undefined && workflowRun.parentStepIndex !== undefined
        ? { parent: { runId: workflowRun.parentRunId, stepIndex: workflowRun.parentStepIndex } }
        : {}),
      logger: log,
      octokit,
      deliveryId: context.deliveryId,
      daemonId,
      // The review and resolve handlers pull this off ctx and forward into
      // botCtx so runPipeline's prompt-builder + MCP server see the data.
      // Other handlers ignore. Without this thread, the orchestrator's load
      // is wired through the wire and discarded here: silent feature breakage.
      ...(reviewLearnings !== undefined ? { reviewLearnings } : {}),
      setState: async (state, humanMessage) => {
        const patch =
          typeof state === "object" && state !== null
            ? (state as Record<string, unknown>)
            : { state };
        await setState({ octokit, logger: log }, { runId: workflowRun.runId, patch, humanMessage });
      },
    };

    const result = await entry.handler(runCtx);

    if (result.status === "handed-off") {
      // Composite parent: merge state, emit tracking comment, but leave
      // `status = running`. The orchestrator cascade will flip this row's
      // status once the final descendant completes. No `onStepComplete`
      // call here: this run has no terminal result to propagate yet.
      const handOffState =
        typeof result.state === "object" && result.state !== null
          ? (result.state as Record<string, unknown>)
          : {};
      await mergeState(workflowRun.runId, handOffState);
      try {
        await setState(
          { octokit, logger: log },
          {
            runId: workflowRun.runId,
            patch: {},
            humanMessage:
              result.humanMessage ?? `${entry.name} handed off to child ${result.childRunId}`,
          },
        );
      } catch (mirrorErr) {
        log.warn(
          { err: mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr) },
          "Tracking-mirror update failed after hand-off; DB state is authoritative",
        );
      }

      log.info(
        {
          durationMs: Date.now() - startedAt,
          outcome: "handed-off",
          childRunId: result.childRunId,
        },
        "Workflow run handed off to child",
      );

      send({
        type: "job:result",
        ...createMessageEnvelope(offerId),
        payload: {
          success: true,
          deliveryId: context.deliveryId,
          durationMs: Date.now() - startedAt,
        },
      });
      return;
    }

    let completion: CompletionResult;

    if (result.status === "succeeded") {
      const state =
        typeof result.state === "object" && result.state !== null
          ? (result.state as Record<string, unknown>)
          : {};
      await markSucceeded(workflowRun.runId, state);
      try {
        await setState(
          { octokit, logger: log },
          {
            runId: workflowRun.runId,
            patch: {},
            humanMessage: result.humanMessage ?? `${entry.name} succeeded`,
          },
        );
      } catch (mirrorErr) {
        log.warn(
          { err: mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr) },
          "Tracking-mirror update failed after markSucceeded; DB state is authoritative",
        );
      }

      log.info(
        { durationMs: Date.now() - startedAt, outcome: "succeeded" },
        "Workflow run completed",
      );

      reactOnTrigger("hooray");

      completion = { status: "succeeded" };

      // Forward applied review-learning IDs (when the handler is review or
      // resolve and the pipeline actually rendered any) so the orchestrator
      // bumps `use_count`. Direct-pipeline path forwards the same field in
      // job-executor.ts; without it here, workflow-dispatched review/resolve
      // jobs silently skip the bump even when the prompt block fired.
      const appliedReviewLearningIds = result.appliedReviewLearningIds;
      send({
        type: "job:result",
        ...createMessageEnvelope(offerId),
        payload: {
          success: true,
          deliveryId: context.deliveryId,
          durationMs: Date.now() - startedAt,
          ...(appliedReviewLearningIds !== undefined && appliedReviewLearningIds.length > 0
            ? { appliedReviewLearningIds }
            : {}),
        },
      });
    } else if (result.status === "incomplete") {
      // Handler returned `incomplete`: the agent ran cleanly but a handler-
      // side gate (e.g. resolve's post-pipeline CI re-check) found surviving
      // failures. We persist a distinct DB status so operators can tell a
      // clean-run-but-blocked outcome from a true pipeline error, but the
      // orchestrator cascade still needs a binary outcome, propagate it as
      // a non-success completion with the original reason preserved.
      const incState =
        typeof result.state === "object" && result.state !== null
          ? (result.state as Record<string, unknown>)
          : {};
      await markIncomplete(workflowRun.runId, result.reason, incState);
      try {
        await setState(
          { octokit, logger: log },
          {
            runId: workflowRun.runId,
            patch: {},
            humanMessage:
              result.humanMessage ??
              `${entry.name} incomplete, see tracking comment for outstanding items.`,
          },
        );
      } catch (mirrorErr) {
        log.warn(
          { err: mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr) },
          "Tracking-mirror update failed after markIncomplete; DB state is authoritative",
        );
      }

      log.warn(
        {
          durationMs: Date.now() - startedAt,
          outcome: "incomplete",
          reason: result.reason,
        },
        "Workflow run reported incomplete",
      );

      reactOnTrigger("confused");

      completion = { status: "failed", reason: `incomplete: ${result.reason}` };

      // Same bump rationale as the succeeded branch above: even when the
      // handler reports `incomplete`, the pipeline did render the directives,
      // so the orchestrator should still credit the use_count.
      const appliedReviewLearningIds = result.appliedReviewLearningIds;
      send({
        type: "job:result",
        ...createMessageEnvelope(offerId),
        payload: {
          success: false,
          deliveryId: context.deliveryId,
          durationMs: Date.now() - startedAt,
          errorMessage: `incomplete: ${result.reason}`,
          ...(appliedReviewLearningIds !== undefined && appliedReviewLearningIds.length > 0
            ? { appliedReviewLearningIds }
            : {}),
        },
      });
    } else {
      // Handler returned `failed`.
      const failState =
        typeof result.state === "object" && result.state !== null
          ? (result.state as Record<string, unknown>)
          : {};
      await markFailed(workflowRun.runId, result.reason, failState);
      try {
        await setState(
          { octokit, logger: log },
          {
            runId: workflowRun.runId,
            patch: {},
            // Defense-in-depth: never default to `result.reason` for the
            // public comment, handlers may put raw error messages in
            // `reason` (intended for DB state.failedReason and operator
            // logs only). Handlers that want a richer comment must set
            // `humanMessage` explicitly.
            humanMessage:
              result.humanMessage ?? `${entry.name} failed, see server logs for details.`,
          },
        );
      } catch (mirrorErr) {
        log.warn(
          { err: mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr) },
          "Tracking-mirror update failed after markFailed; DB state is authoritative",
        );
      }

      log.warn(
        { durationMs: Date.now() - startedAt, outcome: "failed", reason: result.reason },
        "Workflow run reported failure",
      );

      reactOnTrigger("confused");

      completion = { status: "failed", reason: result.reason };

      send({
        type: "job:result",
        ...createMessageEnvelope(offerId),
        payload: {
          success: false,
          deliveryId: context.deliveryId,
          durationMs: Date.now() - startedAt,
          errorMessage: result.reason,
        },
      });
    }

    // T030: propagate the terminal result up the composite chain. Wrapped
    // so a cascade error never masks the original handler outcome, the
    // daemon has already ack'd the job above.
    try {
      await onStepComplete({ octokit, logger: log }, workflowRun.runId, completion);
    } catch (cascadeErr) {
      log.error({ err: cascadeErr }, "onStepComplete cascade failed");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = `uncaught: ${message}`;

    try {
      await markFailed(workflowRun.runId, reason, {});
      await setState(
        { octokit, logger: log },
        {
          runId: workflowRun.runId,
          patch: {},
          // Public comment must NOT carry the raw uncaught-throw message.
          // octokit error stacks include the request URL with the
          // installation token (`https://x-access-token:GHS_xxx@…`); other
          // throws may surface file paths or env values. Raw `reason` is
          // still persisted to DB state.failedReason via markFailed above.
          humanMessage: `${workflowRun.workflowName} failed, see server logs for details.`,
        },
      );
    } catch (cleanupErr) {
      log.error(
        { err: cleanupErr },
        "Failed to persist failure state after uncaught handler throw",
      );
    }

    log.error(
      { err, durationMs: Date.now() - startedAt, outcome: "uncaught" },
      "Workflow handler threw",
    );

    reactOnTrigger("confused");

    try {
      await onStepComplete({ octokit, logger: log }, workflowRun.runId, {
        status: "failed",
        reason,
      });
    } catch (cascadeErr) {
      log.error({ err: cascadeErr }, "onStepComplete cascade failed after uncaught");
    }

    send({
      type: "job:result",
      ...createMessageEnvelope(offerId),
      payload: {
        success: false,
        deliveryId: context.deliveryId,
        durationMs: Date.now() - startedAt,
        errorMessage: reason,
      },
    });
  }
}
