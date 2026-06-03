import type { Octokit } from "octokit";
import type pino from "pino";

import { type LLMTool, type LLMToolHandler, resolveModelId, runWithTools } from "../ai/llm-client";
import { config } from "../config";
import { getDb } from "../db";
import { getInstanceId } from "../orchestrator/instance-id";
import { enqueueJob } from "../orchestrator/job-queue";
import type { TriggerEventType } from "../shared/dispatch-types";
import { addReaction } from "../utils/reactions";
import { getTriageLLMClient } from "../webhook/triage-client-factory";
import { recordWorkflowExecution } from "./execution-row";
import { classify } from "./intent-classifier";
import { enforceSingleBotLabel } from "./label-mutex";
import { getByLabel, getByName, type WorkflowName } from "./registry";
import { findLatestSucceededForTarget, insertQueued, markFailed } from "./runs-store";
import { runChatThread } from "./ship/scoped/chat-thread";
import { postRefusalComment } from "./tracking-mirror";

export interface DispatchTarget {
  readonly type: "issue" | "pr";
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

export interface DispatchByLabelParams {
  readonly octokit: Octokit;
  readonly logger: pino.Logger;
  readonly label: string;
  readonly target: DispatchTarget;
  readonly senderLogin: string;
  readonly deliveryId: string;
}

export type DispatchOutcome =
  | { readonly status: "dispatched"; readonly runId: string; readonly workflowName: WorkflowName }
  | { readonly status: "ignored"; readonly reason: string }
  | {
      readonly status: "refused";
      readonly reason: string;
      readonly workflowName: WorkflowName | "unknown";
    };

/**
 * Label-triggered workflow dispatch. Implements the seven-step label-trigger
 * protocol: registry lookup → context check → prior-output requirement →
 * label mutex → idempotency insert → job enqueue → return. Prior-output is
 * checked before the mutex so a refusal does not strip unrelated `bot:*`
 * labels from the target.
 *
 * ALLOWED_OWNERS enforcement is intentionally out of scope here: the
 * webhook event handler drops those events before calling the dispatcher
 * (no DB row, no queue job, no comment; see FR-015).
 */
export async function dispatchByLabel(params: DispatchByLabelParams): Promise<DispatchOutcome> {
  const { octokit, logger, label, target, senderLogin, deliveryId } = params;

  const entry = getByLabel(label);
  if (entry === undefined) {
    return { status: "ignored", reason: `no registry entry for label '${label}'` };
  }

  const contextMatches =
    entry.context === "both" ||
    (entry.context === "issue" && target.type === "issue") ||
    (entry.context === "pr" && target.type === "pr");

  if (!contextMatches) {
    const reason = `workflow '${entry.name}' only accepts ${entry.context} targets (this is a ${target.type})`;
    await postRefusalComment({ octokit, logger }, target, entry.name, reason);
    return { status: "refused", workflowName: entry.name, reason };
  }

  if (entry.requiresPrior !== null) {
    const prior = await findLatestSucceededForTarget(entry.requiresPrior, target);
    if (prior === null) {
      const reason = `requires a successful '${entry.requiresPrior}' run before '${entry.name}'`;
      await postRefusalComment({ octokit, logger }, target, entry.name, reason);
      return { status: "refused", workflowName: entry.name, reason };
    }
  }

  await enforceSingleBotLabel({
    octokit,
    owner: target.owner,
    repo: target.repo,
    number: target.number,
    justApplied: label,
    logger,
  });

  let runRow;
  try {
    runRow = await insertQueued({
      workflowName: entry.name,
      target,
      deliveryId,
      ownerKind: "orchestrator",
      ownerId: getInstanceId(),
    });
  } catch (err) {
    if (isInflightCollision(err)) {
      logger.info(
        {
          workflowName: entry.name,
          target,
          deliveryId,
          err: err instanceof Error ? err.message : String(err),
          reason: "workflow-dispatch-inflight",
        },
        "Workflow dispatch refused, in-flight run already exists",
      );
      const reason = "an in-flight run already exists for this workflow and target";
      await postRefusalComment({ octokit, logger }, target, entry.name, reason);
      return { status: "refused", workflowName: entry.name, reason };
    }
    throw err;
  }

  try {
    await recordWorkflowExecution({
      deliveryId,
      target,
      senderLogin,
      workflowName: entry.name,
      runId: runRow.id,
      labels: [label],
      logger,
    });
    await enqueueJob({
      kind: "workflow-run",
      deliveryId,
      repoOwner: target.owner,
      repoName: target.repo,
      entityNumber: target.number,
      isPR: target.type === "pr",
      eventName: target.type === "pr" ? "pull_request" : "issues",
      triggerUsername: senderLogin,
      labels: [label],
      triggerBodyPreview: "",
      enqueuedAt: Date.now(),
      retryCount: 0,
      workflowRun: { runId: runRow.id, workflowName: entry.name },
    });
  } catch (err) {
    // executions row may or may not have been written; the compensating
    // `markFailed` on the workflow_runs row is what matters for the partial
    // unique index. The capacity slot is owned by handleAccept/handleResult
    //, nothing to release here.
    logger.error(
      {
        runId: runRow.id,
        workflowName: entry.name,
        target,
        deliveryId,
        err: err instanceof Error ? err.message : String(err),
        reason: "workflow-dispatch-enqueue-failed",
      },
      "Workflow dispatch failed during enqueue; clearing in-flight guard",
    );
    await markFailed(runRow.id, "enqueue failed", {});
    throw err;
  }

  logger.info(
    {
      runId: runRow.id,
      workflowName: entry.name,
      target,
      deliveryId,
      senderLogin,
      reason: "workflow-dispatch",
    },
    "Workflow run dispatched",
  );

  return { status: "dispatched", runId: runRow.id, workflowName: entry.name };
}

export interface DispatchByIntentParams {
  readonly octokit: Octokit;
  readonly logger: pino.Logger;
  readonly commentBody: string;
  readonly target: DispatchTarget;
  readonly senderLogin: string;
  readonly deliveryId: string;
  readonly triggerCommentId: number;
  readonly triggerEventType: TriggerEventType;
  /**
   * For pull_request_review_comment triggers, the parent (top-level)
   * comment id of the review thread when this comment is itself a
   * reply. Used by the chat-thread executor to scope conversation
   * history to the right thread (FIX #1: without this, replies see
   * an empty conversation). Absent on issue_comment triggers.
   */
  readonly triggerInReplyToId?: number;
}

/**
 * Comment-triggered dispatch. Runs the intent classifier against the
 * comment body, then reuses the label-dispatch pathway (context check,
 * label mutex, prior-output check, idempotent insert, enqueue) for the
 * chosen workflow.
 *
 *   - confidence < `INTENT_CONFIDENCE_THRESHOLD` (or `workflow === 'clarify'`)
 *     → post a short clarification comment (FR-009) and return `ignored`.
 *   - `workflow === 'unsupported'`                → post a refusal (FR-010).
 *   - otherwise                                   → dispatch the workflow.
 */
export async function dispatchByIntent(params: DispatchByIntentParams): Promise<DispatchOutcome> {
  const { octokit, logger, commentBody, target, senderLogin, deliveryId } = params;
  const { triggerCommentId, triggerEventType } = params;

  const verdict = await classify(commentBody);
  logger.info(
    {
      target,
      deliveryId,
      senderLogin,
      intentWorkflow: verdict.workflow,
      intentConfidence: verdict.confidence,
      reason: "intent-classified",
    },
    "Intent classification complete",
  );

  if (verdict.workflow === "unsupported") {
    await postRefusalComment(
      { octokit, logger },
      target,
      "unknown",
      `unsupported request, ${verdict.rationale}`,
    );
    return { status: "refused", workflowName: "unknown", reason: verdict.rationale };
  }

  // Route ambiguous / clarify / explicit-chat-thread asks into the
  // conversational executor instead of refusing. The chat-thread
  // executor decides whether to answer, propose a workflow with
  // human-confirm, or decline honestly. Replaces the legacy
  // postClarifyComment dead-end (issue #N, freeform UX).
  if (
    verdict.workflow === "chat-thread" ||
    verdict.workflow === "clarify" ||
    verdict.confidence < config.intentConfidenceThreshold
  ) {
    await runChatThreadFromDispatcher({
      octokit,
      logger,
      commentBody,
      target,
      senderLogin,
      triggerCommentId,
      triggerEventType,
      ...(params.triggerInReplyToId !== undefined
        ? { triggerInReplyToId: params.triggerInReplyToId }
        : {}),
    });
    return {
      status: "ignored",
      reason: `routed to chat-thread (workflow=${verdict.workflow} confidence=${String(verdict.confidence)})`,
    };
  }

  const outcome = await dispatchWorkflowByName({
    octokit,
    logger,
    workflowName: verdict.workflow,
    target,
    senderLogin,
    deliveryId,
    triggerCommentId,
    triggerEventType,
    triggerBodyPreview: commentBody.slice(0, 120),
    addRocketReaction: true,
  });
  if (outcome.status === "dispatched") {
    logger.info(
      {
        runId: outcome.runId,
        workflowName: outcome.workflowName,
        target,
        deliveryId,
        senderLogin,
        reason: "workflow-dispatch-by-intent",
        intentConfidence: verdict.confidence,
      },
      "Workflow run dispatched via intent",
    );
  }
  return outcome;
}

/**
 * Direct workflow dispatch by name: extracted from `dispatchByIntent`
 * (FIX #6) so callers that already know the workflow (e.g. the
 * chat-thread proposal-approval path) can dispatch without bouncing
 * back through the LLM classifier with a synthetic comment body. The
 * synthetic-body bounce was fragile because the classifier could
 * legitimately re-route to chat-thread, silently swallowing the
 * approval.
 *
 * Identical seven-step protocol to the original inline block: context
 * check → prior-output check → label mutex → idempotent insert →
 * recordWorkflowExecution → enqueueJob → return outcome. Postable
 * refusals (context mismatch, missing prior output, in-flight
 * collision) are surfaced via `postRefusalComment` exactly as before.
 */
export async function dispatchWorkflowByName(input: {
  readonly octokit: Octokit;
  readonly logger: pino.Logger;
  readonly workflowName: WorkflowName;
  readonly target: DispatchTarget;
  readonly senderLogin: string;
  readonly deliveryId: string;
  readonly triggerCommentId: number;
  readonly triggerEventType: TriggerEventType;
  readonly triggerBodyPreview: string;
  /** When true, drop a `rocket` reaction on the trigger comment after enqueue. */
  readonly addRocketReaction: boolean;
}): Promise<DispatchOutcome> {
  const {
    octokit,
    logger,
    workflowName,
    target,
    senderLogin,
    deliveryId,
    triggerCommentId,
    triggerEventType,
    triggerBodyPreview,
    addRocketReaction,
  } = input;
  const entry = getByName(workflowName);

  const contextMatches =
    entry.context === "both" ||
    (entry.context === "issue" && target.type === "issue") ||
    (entry.context === "pr" && target.type === "pr");

  if (!contextMatches) {
    const reason = `workflow '${entry.name}' only accepts ${entry.context} targets (this is a ${target.type})`;
    await postRefusalComment({ octokit, logger }, target, entry.name, reason);
    return { status: "refused", workflowName: entry.name, reason };
  }

  if (entry.requiresPrior !== null) {
    const prior = await findLatestSucceededForTarget(entry.requiresPrior, target);
    if (prior === null) {
      const reason = `requires a successful '${entry.requiresPrior}' run before '${entry.name}'`;
      await postRefusalComment({ octokit, logger }, target, entry.name, reason);
      return { status: "refused", workflowName: entry.name, reason };
    }
  }

  await enforceSingleBotLabel({
    octokit,
    owner: target.owner,
    repo: target.repo,
    number: target.number,
    justApplied: entry.label,
    logger,
  });

  let runRow;
  try {
    runRow = await insertQueued({
      workflowName: entry.name,
      target,
      deliveryId,
      ownerKind: "orchestrator",
      ownerId: getInstanceId(),
      triggerCommentId,
      triggerEventType,
    });
  } catch (err) {
    if (isInflightCollision(err)) {
      logger.info(
        {
          workflowName: entry.name,
          target,
          deliveryId,
          err: err instanceof Error ? err.message : String(err),
          reason: "workflow-dispatch-inflight",
        },
        "Workflow dispatch refused, in-flight run already exists",
      );
      const reason = "an in-flight run already exists for this workflow and target";
      await postRefusalComment({ octokit, logger }, target, entry.name, reason);
      return { status: "refused", workflowName: entry.name, reason };
    }
    throw err;
  }

  try {
    await recordWorkflowExecution({
      deliveryId,
      target,
      senderLogin,
      workflowName: entry.name,
      runId: runRow.id,
      labels: [entry.label],
      logger,
      triggerCommentId,
      triggerEventType,
    });
    await enqueueJob({
      kind: "workflow-run",
      deliveryId,
      repoOwner: target.owner,
      repoName: target.repo,
      entityNumber: target.number,
      isPR: target.type === "pr",
      eventName: target.type === "pr" ? "pull_request" : "issues",
      triggerUsername: senderLogin,
      labels: [entry.label],
      triggerBodyPreview,
      enqueuedAt: Date.now(),
      retryCount: 0,
      workflowRun: { runId: runRow.id, workflowName: entry.name },
    });
  } catch (err) {
    logger.error(
      {
        runId: runRow.id,
        workflowName: entry.name,
        target,
        deliveryId,
        err: err instanceof Error ? err.message : String(err),
        reason: "workflow-dispatch-enqueue-failed",
      },
      "Workflow dispatch failed during enqueue; clearing in-flight guard",
    );
    await markFailed(runRow.id, "enqueue failed", {});
    throw err;
  }

  if (addRocketReaction) {
    void addReaction({
      octokit,
      logger,
      owner: target.owner,
      repo: target.repo,
      commentId: triggerCommentId,
      eventType: triggerEventType,
      content: "rocket",
    });
  }

  return { status: "dispatched", runId: runRow.id, workflowName: entry.name };
}

/**
 * Detect the Postgres unique-violation on `idx_workflow_runs_inflight` that
 * FR-011 relies on to reject a second in-flight row for the same (workflow,
 * target). Anything else: transport errors, check violations, permission
 * errors: must not be silently converted to "in-flight already exists".
 */
function isInflightCollision(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const record = err as { code?: unknown; constraint?: unknown };
  if (record.code !== "23505") {
    return false;
  }
  return record.constraint === "idx_workflow_runs_inflight";
}

/**
 * Bridge from the legacy intent-classifier dispatcher to the
 * conversational chat-thread executor. The legacy classifier doesn't
 * carry the comment body or trigger surface fields the chat-thread
 * executor needs, so we forward what we have and let the executor
 * fall back to GitHub for missing context (cache backfill).
 */
async function runChatThreadFromDispatcher(input: {
  readonly octokit: Octokit;
  readonly logger: pino.Logger;
  readonly commentBody: string;
  readonly target: DispatchTarget;
  readonly senderLogin: string;
  readonly triggerCommentId: number;
  readonly triggerEventType: TriggerEventType;
  readonly triggerInReplyToId?: number;
}): Promise<void> {
  // chat-thread relies on the conversation cache and chat_proposals
  // tables for state. Inline-mode deployments (no DATABASE_URL) cannot
  // run it, fall back to the legacy clarify-style refusal so the user
  // gets a coherent reply instead of a hung request.
  if (getDb() === null) {
    input.logger.info(
      { target: input.target },
      "runChatThreadFromDispatcher: DATABASE_URL not configured, posting clarify refusal instead",
    );
    try {
      await postRefusalComment(
        { octokit: input.octokit, logger: input.logger },
        { owner: input.target.owner, repo: input.target.repo, number: input.target.number },
        "unknown",
        "I'm not sure which workflow you'd like me to run, and conversational mode requires a database backend that this deployment isn't configured for. Try `@chrisleekr-bot bot:plan`, `bot:implement`, `bot:review`, or `bot:resolve`.",
      );
    } catch (err) {
      input.logger.error(
        { err, target: input.target },
        "runChatThreadFromDispatcher: postRefusalComment threw on inline-mode fallback",
      );
    }
    return;
  }
  try {
    const llm = getTriageLLMClient();
    const modelId = resolveModelId(config.triageModel, llm.provider);
    // Tools-aware adapter for chat-thread (issue #117). Single-turn for
    // callers without tools, runWithTools loop when tools are passed.
    const callLlm = async (params: {
      systemPrompt: string;
      userPrompt: string;
      tools?: readonly LLMTool[];
      onToolCall?: LLMToolHandler;
    }): Promise<string> => {
      if (params.tools !== undefined && params.onToolCall !== undefined) {
        const result = await runWithTools(llm, {
          model: modelId,
          system: params.systemPrompt,
          messages: [{ role: "user", content: params.userPrompt }],
          maxTokens: 1500,
          temperature: 0.2,
          tools: params.tools,
          onToolCall: params.onToolCall,
        });
        return result.text;
      }
      const res = await llm.create({
        model: modelId,
        system: params.systemPrompt,
        messages: [{ role: "user", content: params.userPrompt }],
        maxTokens: 1500,
        temperature: 0.2,
      });
      return res.text;
    };

    await runChatThread({
      octokit: input.octokit,
      owner: input.target.owner,
      repo: input.target.repo,
      targetType: input.target.type,
      targetNumber: input.target.number,
      // Top-level review-comment id, NOT the reply's id (FIX #1).
      threadId:
        input.triggerEventType === "pull_request_review_comment"
          ? String(input.triggerInReplyToId ?? input.triggerCommentId)
          : null,
      triggerCommentId: input.triggerCommentId,
      triggerCommentBody: input.commentBody,
      triggerEventType: input.triggerEventType,
      principalLogin: input.senderLogin,
      callLlm,
      log: input.logger,
    });
  } catch (err) {
    input.logger.error(
      { err, target: input.target },
      "runChatThreadFromDispatcher: chat-thread executor threw",
    );
  }
}
