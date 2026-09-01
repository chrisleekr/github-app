import type { Octokit } from "octokit";
import type pino from "pino";

import { type LLMTool, type LLMToolHandler, resolveModelId, runWithTools } from "../ai/llm-client";
import { config } from "../config";
import { getDb } from "../db";
import { isPostgresUniqueViolation } from "../db/postgres-error";
import { getInstanceId } from "../orchestrator/instance-id";
import { type EffectiveRepoPolicy, loadRepoPolicy } from "../repo-config/effective";
import { checkRepoGate, type TriggerContext } from "../repo-config/gate";
import type { TriggerEventType } from "../shared/dispatch-types";
import { addReaction } from "../utils/reactions";
import { getTriageLLMClient } from "../webhook/triage-client-factory";
import { publishWorkflowRunById } from "./dispatch-outbox";
import { recordWorkflowExecution } from "./execution-row";
import { classify } from "./intent-classifier";
import { enforceSingleBotLabel } from "./label-mutex";
import {
  logWorkflowRunDispatchRefused,
  logWorkflowRunEnqueueFailed,
  logWorkflowRunQueued,
} from "./log-fields";
import { getByLabel, getByName, type WorkflowName } from "./registry";
import {
  findCommittedWorkflowDispatch,
  findLatestSucceededForTarget,
  insertQueued,
  type WorkflowRunRow,
} from "./runs-store";
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
  /** Trigger facts for the repo-config filter rules. See `TriggerContext`. */
  readonly trigger?: TriggerContext;
}

interface DurableWorkflowDispatchParams {
  readonly workflowName: WorkflowName;
  readonly target: DispatchTarget;
  readonly deliveryId: string;
  readonly senderLogin: string;
  readonly labels: readonly string[];
  readonly triggerBodyPreview: string;
  readonly logger: pino.Logger;
  readonly triggerCommentId?: number;
  readonly triggerEventType?: TriggerEventType;
}

const COMMIT_RECONCILIATION_MAX_ATTEMPTS = 8;
const COMMIT_RECONCILIATION_MAX_DELAY_MS = 100;

async function reconcileCommittedWorkflowDispatch(
  params: DurableWorkflowDispatchParams,
  db: NonNullable<ReturnType<typeof getDb>>,
): Promise<WorkflowRunRow | null> {
  let delayMs = 50;
  for (let attempt = 1; attempt <= COMMIT_RECONCILIATION_MAX_ATTEMPTS; attempt++) {
    try {
      return await findCommittedWorkflowDispatch(
        {
          workflowName: params.workflowName,
          target: params.target,
          executionDeliveryId: params.deliveryId,
        },
        db,
      );
    } catch (err) {
      params.logger.warn(
        {
          err,
          deliveryId: params.deliveryId,
          attempt,
          maxAttempts: COMMIT_RECONCILIATION_MAX_ATTEMPTS,
          retryDelayMs: delayMs,
        },
        "Workflow commit reconciliation unavailable; retaining trigger ownership",
      );
      if (attempt === COMMIT_RECONCILIATION_MAX_ATTEMPTS) return null;
      await Bun.sleep(delayMs);
      delayMs = Math.min(delayMs * 2, COMMIT_RECONCILIATION_MAX_DELAY_MS);
    }
  }
  return null;
}

async function commitDurableWorkflowDispatch(
  params: DurableWorkflowDispatchParams,
): Promise<WorkflowRunRow> {
  const db = getDb();
  if (db === null) throw new Error("Database not configured");
  try {
    return await db.begin(async (tx) => {
      const row = await insertQueued(
        {
          workflowName: params.workflowName,
          target: params.target,
          deliveryId: params.deliveryId,
          triggerBodyPreview: params.triggerBodyPreview,
          ownerKind: "orchestrator",
          ownerId: getInstanceId(),
          ...(params.triggerCommentId !== undefined
            ? { triggerCommentId: params.triggerCommentId }
            : {}),
          ...(params.triggerEventType !== undefined
            ? { triggerEventType: params.triggerEventType }
            : {}),
        },
        tx,
      );
      await recordWorkflowExecution({
        deliveryId: params.deliveryId,
        target: params.target,
        senderLogin: params.senderLogin,
        workflowName: params.workflowName,
        runId: row.id,
        labels: params.labels,
        logger: params.logger,
        ...(params.triggerCommentId !== undefined
          ? { triggerCommentId: params.triggerCommentId }
          : {}),
        ...(params.triggerEventType !== undefined
          ? { triggerEventType: params.triggerEventType }
          : {}),
        sql: tx,
      });
      return row;
    });
  } catch (err) {
    const committed = await reconcileCommittedWorkflowDispatch(params, db);
    if (committed === null) throw err;
    params.logger.warn(
      { err, runId: committed.id, deliveryId: params.deliveryId },
      "Recovered workflow dispatch after an ambiguous commit response",
    );
    return committed;
  }
}

async function publishDurableWorkflowDispatch(
  row: WorkflowRunRow,
  params: Pick<DurableWorkflowDispatchParams, "workflowName" | "target" | "deliveryId" | "logger">,
): Promise<void> {
  try {
    await publishWorkflowRunById(row.id);
  } catch (err) {
    logWorkflowRunEnqueueFailed(params.logger, {
      runId: row.id,
      workflowName: params.workflowName,
      target: params.target,
      deliveryId: params.deliveryId,
      reason: err instanceof Error ? err.message : String(err),
    });
    params.logger.warn(
      { err, runId: row.id, workflowName: params.workflowName, target: params.target },
      "Workflow dispatch publication failed; the durable outbox will retry",
    );
  }
}

/**
 * Gate 1. Loads the repo's default-branch config and evaluates it against
 * this trigger, before any run row, label mutex, queue job, or tracking
 * comment exists.
 *
 * Returns the refusal outcome when blocked, `null` when the dispatch may
 * proceed. Fail-open: `loadRepoPolicy` never throws, and a missing or
 * broken config yields the permissive default policy.
 */
async function applyRepoGate(input: {
  readonly octokit: Octokit;
  readonly logger: pino.Logger;
  readonly target: DispatchTarget;
  readonly senderLogin: string;
  readonly deliveryId: string;
  readonly workflowName?: WorkflowName;
  readonly trigger?: TriggerContext;
  /** Reuses a policy already loaded upstream, saving a second fetch. */
  readonly policy?: EffectiveRepoPolicy;
  /** See `auto` on `dispatchWorkflowByName`. Suppresses the refusal comment. */
  readonly auto?: boolean;
}): Promise<DispatchOutcome | null> {
  const { octokit, logger, target, senderLogin, deliveryId, workflowName } = input;
  const policy =
    input.policy ??
    (await loadRepoPolicy({ octokit, owner: target.owner, repo: target.repo, log: logger }));

  const verdict = checkRepoGate({ policy, workflowName, senderLogin, trigger: input.trigger });
  if (verdict.allowed) return null;

  const named = workflowName ?? "unknown";
  // A passive filter the owner set to keep the bot quiet must stay quiet; only a
  // deliberate label or mention earns a reply. An auto-trigger is not a
  // deliberate ask either: a repo with `workflows.review.enabled: false` would
  // otherwise be answered on every push. The refusal is still logged.
  const explained = verdict.explain && input.auto !== true;
  logWorkflowRunDispatchRefused(logger, {
    workflowName: named,
    target,
    deliveryId,
    reason: verdict.reason,
  });
  logger.info(
    {
      event: "repo_config.gate_blocked",
      workflowName: named,
      target,
      deliveryId,
      senderLogin,
      reason: verdict.reason,
      explained,
    },
    "Workflow dispatch blocked by repo config",
  );
  if (explained) {
    await postRefusalComment({ octokit, logger }, target, named, verdict.reason);
  }
  return {
    status: "refused",
    workflowName: named,
    reason: verdict.reason,
    explained,
  };
}

export type DispatchOutcome =
  | { readonly status: "dispatched"; readonly runId: string; readonly workflowName: WorkflowName }
  | { readonly status: "ignored"; readonly reason: string }
  | {
      readonly status: "refused";
      readonly reason: string;
      readonly workflowName: WorkflowName | "unknown";
      /**
       * Whether the refusal was told to the user via `postRefusalComment`.
       * Required, not optional: a caller that suppresses its own failure
       * message on the assumption the dispatcher already spoke (see
       * `WorkflowRefusedByDispatcher` in ship/scoped/chat-thread.ts) would
       * otherwise dead-end silently. The repo-config trigger filters refuse
       * without commenting on purpose, so this is the only signal that
       * distinguishes the two.
       */
      readonly explained: boolean;
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

  const blocked = await applyRepoGate({
    octokit,
    logger,
    target,
    senderLogin,
    deliveryId,
    workflowName: entry.name,
    ...(params.trigger !== undefined ? { trigger: params.trigger } : {}),
  });
  if (blocked !== null) return blocked;

  const contextMatches =
    entry.context === "both" ||
    (entry.context === "issue" && target.type === "issue") ||
    (entry.context === "pr" && target.type === "pr");

  if (!contextMatches) {
    const reason = `workflow '${entry.name}' only accepts ${entry.context} targets (this is a ${target.type})`;
    logWorkflowRunDispatchRefused(logger, { workflowName: entry.name, target, deliveryId, reason });
    await postRefusalComment({ octokit, logger }, target, entry.name, reason);
    return { status: "refused", workflowName: entry.name, reason, explained: true };
  }

  if (entry.requiresPrior !== null) {
    const prior = await findLatestSucceededForTarget(entry.requiresPrior, target);
    if (prior === null) {
      const reason = `requires a successful '${entry.requiresPrior}' run before '${entry.name}'`;
      logWorkflowRunDispatchRefused(logger, {
        workflowName: entry.name,
        target,
        deliveryId,
        reason,
      });
      await postRefusalComment({ octokit, logger }, target, entry.name, reason);
      return { status: "refused", workflowName: entry.name, reason, explained: true };
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

  let runRow: WorkflowRunRow;
  try {
    runRow = await commitDurableWorkflowDispatch({
      workflowName: entry.name,
      target,
      deliveryId,
      senderLogin,
      labels: [label],
      triggerBodyPreview: "",
      logger,
    });
    logWorkflowRunQueued(logger, {
      runId: runRow.id,
      workflowName: entry.name,
      target,
      deliveryId,
    });
  } catch (err) {
    if (isPostgresUniqueViolation(err, "idx_workflow_runs_inflight")) {
      logWorkflowRunDispatchRefused(logger, {
        workflowName: entry.name,
        target,
        deliveryId,
        reason: "workflow-dispatch-inflight",
      });
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
      return { status: "refused", workflowName: entry.name, reason, explained: true };
    }
    throw err;
  }

  await publishDurableWorkflowDispatch(runRow, {
    workflowName: entry.name,
    target,
    deliveryId,
    logger,
  });

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
  /** Trigger facts for the repo-config filter rules. See `TriggerContext`. */
  readonly trigger?: TriggerContext;
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

  // Gate before classification: a disabled repo or a filtered author must
  // not cost an LLM call. The workflow name is unknown at this point, so
  // the per-workflow rule is re-checked in `dispatchWorkflowByName` below,
  // against this same already-loaded policy.
  const policy = await loadRepoPolicy({
    octokit,
    owner: target.owner,
    repo: target.repo,
    log: logger,
  });
  const blocked = await applyRepoGate({
    octokit,
    logger,
    target,
    senderLogin,
    deliveryId,
    policy,
    ...(params.trigger !== undefined ? { trigger: params.trigger } : {}),
  });
  if (blocked !== null) return blocked;

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
    return {
      status: "refused",
      workflowName: "unknown",
      reason: verdict.rationale,
      explained: true,
    };
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
    repoPolicy: policy,
    ...(params.trigger !== undefined ? { trigger: params.trigger } : {}),
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
 * durable workflow/execution commit → outbox publication → return outcome. Postable
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
  /** Omitted for triggers with no originating comment, e.g. a push. */
  readonly triggerCommentId?: number;
  /** Omitted for triggers with no originating comment, e.g. a push. */
  readonly triggerEventType?: TriggerEventType;
  readonly triggerBodyPreview: string;
  /** When true, drop a `rocket` reaction on the trigger comment after enqueue. */
  readonly addRocketReaction: boolean;
  /** Trigger facts for the repo-config filter rules. See `TriggerContext`. */
  readonly trigger?: TriggerContext;
  /** Policy already loaded by the caller, reused instead of re-fetched. */
  readonly repoPolicy?: EffectiveRepoPolicy;
  /**
   * A trigger nobody asked for, e.g. an auto-review on push. Suppresses every
   * refusal comment (no audience) and the bot-label mutex (no label is being
   * applied, and the mutex removes every *other* `bot:*` label, which would
   * strip a `bot:ship` the user set). Refusals are still logged; only the
   * GitHub-visible reply is dropped.
   */
  readonly auto?: boolean;
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
    addRocketReaction,
  } = input;
  const entry = getByName(workflowName);

  const blocked = await applyRepoGate({
    octokit,
    logger,
    target,
    senderLogin,
    deliveryId,
    workflowName: entry.name,
    ...(input.auto === true ? { auto: true } : {}),
    ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
    ...(input.repoPolicy !== undefined ? { policy: input.repoPolicy } : {}),
  });
  if (blocked !== null) return blocked;

  const contextMatches =
    entry.context === "both" ||
    (entry.context === "issue" && target.type === "issue") ||
    (entry.context === "pr" && target.type === "pr");

  if (!contextMatches) {
    const reason = `workflow '${entry.name}' only accepts ${entry.context} targets (this is a ${target.type})`;
    logWorkflowRunDispatchRefused(logger, { workflowName: entry.name, target, deliveryId, reason });
    if (input.auto !== true) {
      await postRefusalComment({ octokit, logger }, target, entry.name, reason);
    }
    return { status: "refused", workflowName: entry.name, reason, explained: input.auto !== true };
  }

  if (entry.requiresPrior !== null) {
    const prior = await findLatestSucceededForTarget(entry.requiresPrior, target);
    if (prior === null) {
      const reason = `requires a successful '${entry.requiresPrior}' run before '${entry.name}'`;
      logWorkflowRunDispatchRefused(logger, {
        workflowName: entry.name,
        target,
        deliveryId,
        reason,
      });
      if (input.auto !== true) {
        await postRefusalComment({ octokit, logger }, target, entry.name, reason);
      }
      return {
        status: "refused",
        workflowName: entry.name,
        reason,
        explained: input.auto !== true,
      };
    }
  }

  // Skipped for auto-triggers: no label is being applied, so there is nothing
  // to be mutually exclusive with, and the mutex removes every *other* `bot:*`
  // label, which would strip a `bot:ship` the user set on their next push.
  if (input.auto !== true) {
    await enforceSingleBotLabel({
      octokit,
      owner: target.owner,
      repo: target.repo,
      number: target.number,
      justApplied: entry.label,
      logger,
    });
  }

  let runRow: WorkflowRunRow;
  try {
    runRow = await commitDurableWorkflowDispatch({
      workflowName: entry.name,
      target,
      deliveryId,
      senderLogin,
      labels: [entry.label],
      triggerBodyPreview: input.triggerBodyPreview,
      logger,
      ...(triggerCommentId !== undefined ? { triggerCommentId } : {}),
      ...(triggerEventType !== undefined ? { triggerEventType } : {}),
    });
    logWorkflowRunQueued(logger, {
      runId: runRow.id,
      workflowName: entry.name,
      target,
      deliveryId,
    });
  } catch (err) {
    if (isPostgresUniqueViolation(err, "idx_workflow_runs_inflight")) {
      logWorkflowRunDispatchRefused(logger, {
        workflowName: entry.name,
        target,
        deliveryId,
        reason: "workflow-dispatch-inflight",
      });
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
      // Auto-triggers ignore rather than queue: a push landing while a review is
      // already running is dropped, and dropped silently.
      if (input.auto !== true) {
        await postRefusalComment({ octokit, logger }, target, entry.name, reason);
      }
      return {
        status: "refused",
        workflowName: entry.name,
        reason,
        explained: input.auto !== true,
      };
    }
    throw err;
  }

  await publishDurableWorkflowDispatch(runRow, {
    workflowName: entry.name,
    target,
    deliveryId,
    logger,
  });

  if (addRocketReaction && triggerCommentId !== undefined && triggerEventType !== undefined) {
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
