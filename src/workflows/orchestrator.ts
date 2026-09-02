import type { SQL } from "bun";
import type { Octokit } from "octokit";
import type pino from "pino";

import { config } from "../config";
import { requireDb } from "../db";
import { getIntentById } from "../db/queries/ship";
import { requireValkeyClient } from "../orchestrator/valkey";
import { isSessionTerminalState } from "../shared/ship-types";
import { addReaction, type ReactionContent } from "../utils/reactions";
import { publishWorkflowRunById } from "./dispatch-outbox";
import { recordWorkflowExecution } from "./execution-row";
import { logWorkflowRunEnqueueFailed } from "./log-fields";
import { getByName, type WorkflowName } from "./registry";
import { findById, type WorkflowRunRow } from "./runs-store";
import { TICKLE_KEY } from "./ship/webhook-reactor";
import { extractShipIntentId } from "./ship/workflow-context";
import { LAST_HUMAN_MESSAGE_KEY, setState } from "./tracking-mirror";

/**
 * Composite-workflow hand-off engine. Runs as the LAST step of every
 * workflow job (after the handler's terminal write) and cascades completion
 * up the parent chain per `contracts/handoff-protocol.md`.
 *
 * For non-composite runs (no `parent_run_id`) this is a no-op apart from
 * the tracking-comment emit that the executor already made.
 *
 * Transaction invariants:
 *   - `SELECT … FOR UPDATE` on the parent row eliminates the race where two
 *     concurrent children's completion writes could each insert their own
 *     "next" child.
 *   - Job enqueue for the newly-inserted next child happens AFTER COMMIT so
 *     the queue never observes a run id that doesn't exist in the DB.
 *   - On a child failure, no further children are inserted: the parent is
 *     flipped to `failed` with `failedAtStepIndex` and the cascade stops.
 */

export interface CompletionResult {
  readonly status: "succeeded" | "failed";
  readonly reason?: string;
}

export interface OnStepCompleteDeps {
  readonly octokit: Octokit | null;
  readonly logger: pino.Logger;
  readonly emitGitHub?: boolean;
  readonly sql?: SQL;
}

export async function onStepComplete(
  deps: OnStepCompleteDeps,
  childRunId: string,
  result: CompletionResult,
): Promise<void> {
  const db = deps.sql ?? requireDb();
  const { logger } = deps;

  // Ship-iteration early-wake hook: when the just-completed child carries a
  // `shipIntentId` in its state JSONB, ZADD `ship:tickle` so the scheduler
  // re-enters the intent on the next tick. Runs BEFORE the parent-cascade
  // logic because ship-iteration runs may have no `parent_run_id`.
  await maybeEarlyWakeShipIntent(childRunId, logger, db);

  // Capture anything the transaction wants to emit AFTER commit so the DB
  // is the source of truth for enqueued jobs and GitHub API calls. The
  // transaction body populates this; the post-commit block consumes it.
  let postCommit: PostCommitActions = { enqueue: null, parentRunId: null, parentTerminal: null };

  await db.begin(async (tx) => {
    const child = await loadChild(tx, childRunId);
    if (child === null) {
      logger.warn({ childRunId }, "onStepComplete: child run row not found");
      return;
    }

    if (child.parent_run_id === null) {
      return;
    }

    const parent = await lockParent(tx, child.parent_run_id);
    if (parent === null) {
      logger.warn({ childRunId, parentId: child.parent_run_id }, "onStepComplete: parent missing");
      return;
    }
    if (parent.status !== "running") {
      logger.info(
        { childRunId, parentId: parent.id, parentStatus: parent.status },
        "onStepComplete replayed a child of a terminal parent",
      );
      const terminal = terminalProjectionFromParent(parent);
      if (terminal !== null) {
        postCommit = { enqueue: null, parentRunId: parent.id, parentTerminal: terminal };
      }
      return;
    }

    const steps = getByName(parent.workflow_name).steps;
    const childStepIndex = child.parent_step_index ?? -1;
    if (extractStepRuns(parent.state).includes(childRunId)) return;

    if (result.status === "failed") {
      // The executor edge maps `HandlerResult.status === "incomplete"` to a
      // `CompletionResult` with reason prefixed `incomplete:` so the cascade
      // can keep its binary `succeeded | failed` contract while the parent's
      // public surface still tells a clean-run-but-blocked outcome (CI red
      // after the resolve cap) from a true pipeline error. Strip the prefix
      // before persisting so `failedReason` carries the raw handler reason
      // (the prefix is a private executor-internal marker).
      const isIncomplete = (result.reason ?? "").startsWith("incomplete:");
      const rawReason = isIncomplete
        ? (result.reason ?? "").slice("incomplete:".length).trim()
        : (result.reason ?? "child failed");
      const humanMessage = isIncomplete
        ? `ship halted at step ${String(childStepIndex)} (${parent.workflow_name} → ${child.workflow_name}), ${child.workflow_name} returned incomplete; see PR tracking comment for outstanding items.`
        : `ship halted at step ${String(childStepIndex)} (${parent.workflow_name} → ${child.workflow_name}), see server logs for details.`;
      const failPatch = {
        failedAtStepIndex: childStepIndex,
        failedReason: rawReason || "child failed",
        [LAST_HUMAN_MESSAGE_KEY]: humanMessage,
      };
      await tx`
        UPDATE workflow_runs
           SET status = 'failed',
               state = state || ${failPatch}::jsonb
         WHERE id = ${parent.id}
           AND status = 'running'
      `;
      postCommit = {
        enqueue: null,
        parentRunId: parent.id,
        parentTerminal: {
          status: "failed",
          // Do NOT inline `result.reason` for the generic-failed branch,
          // handlers persist raw error strings in `reason` for DB+log
          // forensics and that surface is public on GitHub. The
          // `incomplete:` prefix is a private cascade marker set by
          // `completion-reconciler.ts`; the message above does not
          // include the reason payload itself, only flags the class.
          humanMessage,
        },
      };
      return;
    }

    const nextIndex = childStepIndex + 1;
    const stepRuns = extractStepRuns(parent.state);
    stepRuns.push(childRunId);

    // ── Bespoke ship review/resolve loop ──────────────────────────────────
    // Localised here intentionally, generalising the registry to express
    // "loop back to step N when condition X holds" would add surface area
    // for one use case. If a second composite ever needs looping, extract.
    //
    // Semantics (cap = config.reviewResolveMaxIterations, default 2):
    //   - Each completed `review` child increments parent.state.review_iterations
    //     and records its findings count on parent.state.last_review_findings.
    //   - After review-N: if N ≥ 2 AND findings == 0 → parent succeeds early
    //     (skip resolve; nothing left to fix).
    //   - After resolve-N: if N < cap → insert another review (loop back to
    //     ship.steps.indexOf("review")). Else → parent succeeds; if
    //     last_review_findings > 0 the terminal message recommends manual
    //     re-review (we did not get to confirm resolve-N's fixes).
    const isShipParent = parent.workflow_name === "ship";
    const isReviewChild = child.workflow_name === "review";
    const isResolveChild = child.workflow_name === "resolve";

    let reviewIterations = extractReviewIterations(parent.state);
    let lastReviewFindings = extractLastReviewFindings(parent.state);
    if (isShipParent && isReviewChild) {
      reviewIterations += 1;
      lastReviewFindings = extractFindings(child.state, logger, child.id);
    }
    const reviewLoopState: Record<string, number> =
      isShipParent && (isReviewChild || isResolveChild)
        ? { review_iterations: reviewIterations, last_review_findings: lastReviewFindings }
        : {};

    const cap = config.reviewResolveMaxIterations;
    // The early-exit floor is `min(2, cap)` so a `cap === 1` deployment
    //, which means "never loop", still terminates on its single review.
    // For `cap >= 2` this stays at 2, preserving the "at least two
    // independent passes" guarantee the user originally asked for.
    const reviewClean =
      isShipParent &&
      isReviewChild &&
      reviewIterations >= Math.min(2, cap) &&
      lastReviewFindings === 0;
    const shouldLoopBackToReview = isShipParent && isResolveChild && reviewIterations < cap;

    if (reviewClean || (nextIndex >= steps.length && !shouldLoopBackToReview)) {
      let humanMessage = `ship complete, all ${String(steps.length)} steps succeeded.`;
      if (reviewClean) {
        humanMessage = `ship complete, review found no issues after ${String(reviewIterations)} iterations.`;
      } else if (isShipParent && reviewIterations >= cap && lastReviewFindings > 0) {
        humanMessage = `ship complete, review-${String(reviewIterations)} flagged ${String(lastReviewFindings)} issue${
          lastReviewFindings === 1 ? "" : "s"
        }; resolve-${String(reviewIterations)} attempted fixes. Manual re-review recommended.`;
      }
      const successPatch = {
        currentStepIndex: nextIndex,
        stepRuns,
        ...reviewLoopState,
        [LAST_HUMAN_MESSAGE_KEY]: humanMessage,
      };
      await tx`
        UPDATE workflow_runs
           SET status = 'succeeded',
               state = state || ${successPatch}::jsonb
         WHERE id = ${parent.id}
           AND status = 'running'
      `;
      postCommit = {
        enqueue: null,
        parentRunId: parent.id,
        parentTerminal: { status: "succeeded", humanMessage },
      };
      return;
    }

    // Determine the next step. Loop-back overrides the natural advance so
    // resolve-N → review-(N+1) instead of falling off the end of `steps`.
    const nextStepIndex = shouldLoopBackToReview ? steps.indexOf("review") : nextIndex;
    const nextStepName = steps[nextStepIndex];
    if (nextStepName === undefined) {
      throw new Error(`orchestrator: step index ${String(nextStepIndex)} out of bounds`);
    }

    // Phase 1 retargeting: when the next step's registry context is "pr"
    // but the parent's target is an issue (e.g., ship → review/resolve),
    // discover the PR number from the just-completed child's state (typical
    // hand-off from `implement`) or the parent's state (preserved across
    // loop-back iterations).
    const targetResult = deriveChildTarget(parent, child, nextStepName);
    if ("error" in targetResult) {
      const humanMessage = `ship halted at step ${String(nextStepIndex)} (${parent.workflow_name} → ${nextStepName}): ${targetResult.error}`;
      const failPatch = {
        failedAtStepIndex: nextStepIndex,
        failedReason: targetResult.error,
        ...reviewLoopState,
        [LAST_HUMAN_MESSAGE_KEY]: humanMessage,
      };
      await tx`
        UPDATE workflow_runs
           SET status = 'failed',
               state = state || ${failPatch}::jsonb
         WHERE id = ${parent.id}
           AND status = 'running'
      `;
      postCommit = {
        enqueue: null,
        parentRunId: parent.id,
        parentTerminal: {
          status: "failed",
          humanMessage,
        },
      };
      return;
    }
    const childTarget = targetResult;

    const nextChildId = crypto.randomUUID();
    const inserted: WorkflowRunRow[] = await tx`
      INSERT INTO workflow_runs (
        id, workflow_name, target_type, target_owner, target_repo, target_number,
        parent_run_id, parent_step_index, status, state, delivery_id,
        execution_delivery_id, owner_kind, owner_id
      ) VALUES (
        ${nextChildId}, ${nextStepName}, ${childTarget.type}, ${childTarget.owner},
        ${childTarget.repo}, ${childTarget.number},
        ${parent.id}, ${nextStepIndex}, 'queued', '{}'::jsonb, ${parent.delivery_id},
        ${nextChildId}, NULL, NULL
      )
      RETURNING *
    `;
    const nextChild = inserted[0];
    if (nextChild === undefined) {
      throw new Error("orchestrator: failed to insert next child row");
    }
    await recordWorkflowExecution({
      deliveryId: nextChild.id,
      target: childTarget,
      senderLogin: config.botAppLogin,
      workflowName: nextStepName,
      runId: nextChild.id,
      logger,
      sql: tx,
    });

    const progressPatch: Record<string, unknown> = {
      currentStepIndex: nextStepIndex,
      stepRuns,
      ...reviewLoopState,
    };
    // Persist pr_number on parent state on first retarget so subsequent
    // loop-back inserts can rediscover it without re-reading a child row.
    if (childTarget.type === "pr" && parent.target_type === "issue") {
      progressPatch["pr_number"] = childTarget.number;
    }
    await tx`
      UPDATE workflow_runs
         SET state = state || ${progressPatch}::jsonb
     WHERE id = ${parent.id}
       AND status = 'running'
    `;

    postCommit = {
      enqueue: {
        runId: nextChild.id,
        workflowName: nextStepName,
        parentRunId: parent.id,
        parentStepIndex: nextStepIndex,
        deliveryId: parent.delivery_id,
        target: childTarget,
      },
      parentRunId: parent.id,
      parentTerminal: null,
    };
  });

  if (postCommit.enqueue !== null) {
    const job = postCommit.enqueue;
    try {
      await publishWorkflowRunById(job.runId, db);
      logger.info(
        { nextRunId: job.runId, nextWorkflow: job.workflowName, parentId: job.parentRunId },
        "orchestrator enqueued next step",
      );
    } catch (err) {
      const reason = `enqueue failed: ${err instanceof Error ? err.message : String(err)}`;
      logWorkflowRunEnqueueFailed(logger, {
        runId: job.runId,
        workflowName: job.workflowName,
        target: job.target,
        deliveryId: job.deliveryId,
        reason,
      });
      logger.error(
        { err, nextRunId: job.runId, parentId: job.parentRunId },
        "orchestrator post-commit enqueue failed, reconciliation will retry",
      );
    }
  }

  if (
    postCommit.parentTerminal !== null &&
    postCommit.parentRunId !== null &&
    deps.emitGitHub !== false &&
    deps.octokit !== null
  ) {
    const parentRunId = postCommit.parentRunId;
    const terminal = postCommit.parentTerminal;
    const trackingDeps = { octokit: deps.octokit, logger };
    await setState(trackingDeps, {
      runId: parentRunId,
      patch: {},
      humanMessage: terminal.humanMessage,
    });

    // Composite parents (e.g., ship) terminate here, not in the daemon
    // executor, so this is the right point to react on the user's trigger
    // comment with the chain's final outcome.
    await reactOnParentTrigger(
      trackingDeps,
      parentRunId,
      terminal.status === "succeeded" ? "hooray" : "confused",
    );
  }
}

/**
 * Read `state.shipIntentId` from a freshly-completed `workflow_runs` row and,
 * if present and the intent is non-terminal, push it onto the `ship:tickle`
 * sorted set with score 0 so the scheduler picks it up on the next tick.
 *
 * Defensive: a Valkey blip MUST NOT propagate up: the worst outcome is a
 * ship intent that waits for the next periodic tickle (config-driven, in
 * minutes), not a daemon-side throw that fails the parent cascade.
 *
 * @param childRunId  ID of the child `workflow_runs` row that just terminated.
 * @param log         Pino logger used by the cascade caller.
 */
/**
 * Read `state.failedReason` from a terminal workflow_runs state blob.
 * Returns `undefined` for legacy rows or non-failure states.
 */
export function extractFailedReason(state: unknown): string | undefined {
  if (state === null || typeof state !== "object") return undefined;
  const candidate = (state as Record<string, unknown>)["failedReason"];
  return typeof candidate === "string" && candidate !== "" ? candidate : undefined;
}

/** Conservative fallback when the quota error has no parseable reset clock. */
const QUOTA_FALLBACK_RETRY_DELAY_MS = 60 * 60 * 1000;

/**
 * Detect the Anthropic usage-limit error and compute when to retry.
 *
 * The Claude Agent SDK throws an Error with a message like
 * `Claude Code returned an error result: You've hit your limit · resets 6pm (UTC)`.
 * This is *transient* (it self-heals at the reset boundary) so the ship
 * loop should defer the next iteration to that timestamp instead of
 * stalling the intent.
 *
 * Returns `null` when the reason is absent or does not match the
 * usage-limit signature; caller falls back to the existing skip path.
 */
function parseResetsClock(
  reason: string,
  nowMs: number,
): { retryAtMs: number; resetPhrase: string } | null {
  const matches = reason.matchAll(/resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(?\s*UTC\s*\)?/gi);
  const match = matches.next().value;
  if (match === undefined) return null;
  // Reject ambiguous bare-hour formats like "resets 6 UTC" (no am/pm and
  // no minute). Treating them as 06:00 risks the next-day rollover at
  // line 437 pushing the wake out by ~24h when now is past the hour,
  // strictly worse than the caller's +1h fallback for unparseable clocks.
  if (match[2] === undefined && match[3] === undefined) return null;
  const hourRaw = Number(match[1]);
  const minute = match[2] !== undefined ? Number(match[2]) : 0;
  const meridiem = match[3]?.toLowerCase();
  let hour = hourRaw;
  if (meridiem === "pm" && hourRaw < 12) hour = hourRaw + 12;
  else if (meridiem === "am" && hourRaw === 12) hour = 0;
  if (!Number.isFinite(hour) || hour < 0 || hour >= 24 || minute < 0 || minute >= 60) {
    return null;
  }
  const today = new Date(nowMs);
  // 30s buffer past the boundary so we don't race the reset.
  const resetAt = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
    hour,
    minute,
    30,
  );
  const retryAtMs = resetAt > nowMs ? resetAt : resetAt + 24 * 60 * 60 * 1000;
  return { retryAtMs, resetPhrase: match[0] };
}

export function detectTransientQuotaError(
  reason: string | undefined,
  nowMs: number = Date.now(),
): { retryAtMs: number; resetPhrase: string } | null {
  if (reason === undefined || reason === "") return null;
  // Two confirmed Anthropic usage-limit signals: we deliberately do NOT
  // match a bare "rate limit" / "usage limit" because that pattern also
  // appears in GitHub secondary-rate-limit responses and other upstream
  // throttling we should not auto-defer:
  //   1. The Anthropic-specific phrase "hit your limit" (subscription
  //      quota copy from the Claude Agent SDK).
  //   2. A "resets ... UTC" clock: the Anthropic API includes the reset
  //      boundary inline; treat that as a sufficient confirmation.
  const hasAnthropicPhrase = /hit your limit/i.test(reason);
  const hasResetsClock = /\bresets\b/i.test(reason);
  if (!hasAnthropicPhrase && !hasResetsClock) return null;

  const parsed = parseResetsClock(reason, nowMs);
  if (parsed !== null) return parsed;

  // No parseable clock. The +1h fallback only fires for the Anthropic-
  // specific phrase: a bare "resets" without it could be unrelated.
  if (!hasAnthropicPhrase) return null;
  return { retryAtMs: nowMs + QUOTA_FALLBACK_RETRY_DELAY_MS, resetPhrase: "fallback_1h" };
}

async function maybeEarlyWakeShipIntent(
  childRunId: string,
  log: pino.Logger,
  db: SQL,
): Promise<void> {
  const rows: { state: Record<string, unknown>; status: string }[] = await db`
    SELECT state, status FROM workflow_runs WHERE id = ${childRunId}
  `;
  const child = rows[0];
  if (child === undefined) return;

  const intentId = extractShipIntentId(child.state);
  if (intentId === undefined) return;

  // Resolve intent state up-front: the same terminal-state guard must
  // gate both the immediate cascade and the deferred-quota retry. A
  // late failed child can otherwise re-arm an already terminal intent
  // (`aborted_by_user`, `merged_externally`, …) via the deferred ZADD
  // and reprocess a session that should stay dead.
  let intent: Awaited<ReturnType<typeof getIntentById>>;
  try {
    intent = await getIntentById(intentId);
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        intent_id: intentId,
        child_run_id: childRunId,
      },
      "ship-tickle early-wake skipped, intent lookup failed (non-fatal, periodic scan will catch up)",
    );
    return;
  }
  if (intent === null) {
    log.warn(
      { event: "ship.tickle.skip_terminal", intent_id: intentId, reason: "intent_not_found" },
      "ship-tickle early-wake skipped, intent not found",
    );
    return;
  }
  if (isSessionTerminalState(intent.status)) {
    log.info(
      { event: "ship.tickle.skip_terminal", intent_id: intentId, status: intent.status },
      "ship-tickle early-wake skipped, intent already terminal",
    );
    return;
  }

  // Only succeeded children fire the cascade immediately. A failed child
  // should not auto-spin the next iteration: the iteration cap would
  // eventually catch it, but until then the loop burns budget on a
  // permanently broken intent. Operators can re-arm a stalled intent
  // manually.
  //
  // Exception: a *transient* failure (Anthropic usage-limit cap) is
  // recoverable on its own clock. Defer the tickle to the reset time so
  // the periodic scanner picks it up automatically when the quota resets.
  if (child.status !== "succeeded") {
    const failedReason = extractFailedReason(child.state);
    const transient = detectTransientQuotaError(failedReason);
    if (transient !== null) {
      try {
        const valkey = requireValkeyClient();
        await valkey.send("ZADD", [TICKLE_KEY, String(transient.retryAtMs), intentId]);
        log.info(
          {
            event: "ship.tickle.deferred_quota",
            intent_id: intentId,
            child_run_id: childRunId,
            child_status: child.status,
            retry_at_ms: transient.retryAtMs,
            retry_at_iso: new Date(transient.retryAtMs).toISOString(),
            reset_phrase: transient.resetPhrase,
          },
          "ship-tickle deferred, child hit Anthropic usage limit, will retry after reset",
        );
      } catch (zaddErr) {
        log.warn(
          {
            err: zaddErr instanceof Error ? zaddErr.message : String(zaddErr),
            intent_id: intentId,
            child_run_id: childRunId,
          },
          "ship-tickle deferred-ZADD failed (non-fatal, periodic scan will catch up)",
        );
      }
      return;
    }
    log.info(
      {
        event: "ship.tickle.skip_failed_child",
        intent_id: intentId,
        child_run_id: childRunId,
        child_status: child.status,
      },
      "ship-tickle early-wake skipped, child workflow run did not succeed",
    );
    return;
  }

  try {
    const valkey = requireValkeyClient();
    await valkey.send("ZADD", [TICKLE_KEY, "0", intentId]);
    log.info(
      { event: "ship.tickle.due", intent_id: intentId, source: "workflow_run_completion" },
      "ship-tickle early-wake on workflow_run completion",
    );
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        intent_id: intentId,
        childRunId,
      },
      "ship-tickle early-wake failed (non-fatal, periodic scan will catch up)",
    );
  }
}

async function reactOnParentTrigger(
  deps: { octokit: Octokit; logger: pino.Logger },
  parentRunId: string,
  content: ReactionContent,
): Promise<void> {
  try {
    const row = await findById(parentRunId);
    if (row === null) return;
    if (row.trigger_comment_id === null || row.trigger_event_type === null) return;
    await addReaction({
      octokit: deps.octokit,
      logger: deps.logger,
      owner: row.target_owner,
      repo: row.target_repo,
      commentId: row.trigger_comment_id,
      eventType: row.trigger_event_type,
      content,
    });
  } catch (err) {
    deps.logger.warn(
      { err: err instanceof Error ? err.message : String(err), parentRunId, content },
      "reactOnParentTrigger failed",
    );
  }
}

interface PostCommitActions {
  enqueue: {
    runId: string;
    workflowName: WorkflowName;
    parentRunId: string;
    parentStepIndex: number;
    deliveryId: string | null;
    target: { type: "issue" | "pr"; owner: string; repo: string; number: number };
  } | null;
  parentRunId: string | null;
  parentTerminal: { status: "succeeded" | "failed"; humanMessage: string } | null;
}

function terminalProjectionFromParent(parent: WorkflowRunRow): PostCommitActions["parentTerminal"] {
  if (parent.status !== "succeeded" && parent.status !== "failed") return null;
  const stored = parent.state[LAST_HUMAN_MESSAGE_KEY];
  const humanMessage =
    typeof stored === "string" && stored.trim() !== ""
      ? stored
      : parent.status === "succeeded"
        ? `${parent.workflow_name} succeeded.`
        : `${parent.workflow_name} failed, see server logs for details.`;
  return { status: parent.status, humanMessage };
}

function extractStepRuns(state: Record<string, unknown>): string[] {
  const raw = state["stepRuns"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

function extractPrNumber(state: Record<string, unknown>): number | null {
  const raw = state["pr_number"];
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : null;
}

/**
 * Reads `state.findings.total` written by the `review` handler. A missing
 * or malformed value is treated as "non-clean" via `Number.MAX_SAFE_INTEGER`
 * so a regressed review handler that forgets to populate findings cannot
 * accidentally short-circuit the loop into an early ship-succeed (which is
 * the silent-bail class this PR is otherwise tightening). The warning
 * surfaces the regression in operator logs instead of swallowing it.
 */
function extractFindings(
  state: Record<string, unknown>,
  logger: pino.Logger,
  childRunId: string,
): number {
  const raw = state["findings"];
  if (raw !== null && typeof raw === "object") {
    const total = (raw as Record<string, unknown>)["total"];
    if (typeof total === "number" && Number.isFinite(total) && total >= 0) return total;
  }
  logger.warn(
    { childRunId, findings: raw },
    "orchestrator: review child has no usable findings.total, refusing to short-circuit ship loop",
  );
  return Number.MAX_SAFE_INTEGER;
}

function extractReviewIterations(state: Record<string, unknown>): number {
  const raw = state["review_iterations"];
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

function extractLastReviewFindings(state: Record<string, unknown>): number {
  const raw = state["last_review_findings"];
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

interface ChildTarget {
  type: "issue" | "pr";
  owner: string;
  repo: string;
  number: number;
}

function deriveChildTarget(
  parent: WorkflowRunRow,
  child: WorkflowRunRow,
  nextStepName: WorkflowName,
): ChildTarget | { error: string } {
  const nextEntry = getByName(nextStepName);
  if (nextEntry.context !== "pr" || parent.target_type === "pr") {
    return {
      type: parent.target_type,
      owner: parent.target_owner,
      repo: parent.target_repo,
      number: parent.target_number,
    };
  }
  const prNumber = extractPrNumber(child.state) ?? extractPrNumber(parent.state);
  if (prNumber === null) {
    return {
      error: `${nextStepName} requires PR target but no pr_number found in child or parent state`,
    };
  }
  return {
    type: "pr",
    owner: parent.target_owner,
    repo: parent.target_repo,
    number: prNumber,
  };
}

async function loadChild(tx: SQL, childRunId: string): Promise<WorkflowRunRow | null> {
  const rows: WorkflowRunRow[] = await tx`
    SELECT * FROM workflow_runs WHERE id = ${childRunId}
  `;
  return rows[0] ?? null;
}

async function lockParent(tx: SQL, parentId: string): Promise<WorkflowRunRow | null> {
  const rows: WorkflowRunRow[] = await tx`
    SELECT * FROM workflow_runs WHERE id = ${parentId} FOR UPDATE
  `;
  return rows[0] ?? null;
}
