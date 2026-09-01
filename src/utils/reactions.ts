import type { Octokit } from "octokit";
import type pino from "pino";

import type { TriggerEventType } from "../shared/dispatch-types";

/**
 * GitHub comment reaction lifecycle for bot-driven workflows.
 *
 *   eyes    : trigger detected, work queued
 *   rocket  : workflow durably queued for execution
 *   hooray  : workflow succeeded
 *   confused: workflow failed (handler error, daemon disconnect, OOM)
 *
 * Reactions are additive on GitHub: adding `confused` after `eyes` does not
 * remove `eyes`. The combined set is the audit trail of the run.
 */
export type ReactionContent = "eyes" | "rocket" | "hooray" | "confused";

export interface AddReactionParams {
  octokit: Octokit;
  logger: pino.Logger;
  owner: string;
  repo: string;
  commentId: number;
  eventType: TriggerEventType;
  content: ReactionContent;
}

/**
 * Best-effort reaction add. Failures are logged at warn level and swallowed
 * so a missing reactions:write scope (or a deleted comment) never blocks
 * the workflow that produced the reaction.
 *
 * Floating-promise contract for callers (`void addReaction(...)`):
 * the parameter destructuring below cannot throw at runtime because every
 * call site passes a literal `AddReactionParams` object under strict TS
 * (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`). The only
 * runtime error surface is the awaited Octokit call itself, which is
 * inside the try/catch.
 */
export async function addReaction(params: AddReactionParams): Promise<void> {
  const { octokit, logger, owner, repo, commentId, eventType, content } = params;

  try {
    if (eventType === "issue_comment") {
      await octokit.rest.reactions.createForIssueComment({
        owner,
        repo,
        comment_id: commentId,
        content,
      });
    } else {
      await octokit.rest.reactions.createForPullRequestReviewComment({
        owner,
        repo,
        comment_id: commentId,
        content,
      });
    }
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        owner,
        repo,
        commentId,
        eventType,
        content,
      },
      "Failed to add reaction, continuing without it",
    );
  }
}
