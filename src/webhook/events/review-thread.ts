import type { PullRequestReviewThreadEvent } from "@octokit/webhooks-types";
import type { Octokit } from "octokit";

import { logger } from "../../logger";

/**
 * Handler for pull_request_review_thread.resolved and .unresolved events.
 * Registered in src/app.ts via app.webhooks.on([
 *   "pull_request_review_thread.resolved",
 *   "pull_request_review_thread.unresolved",
 * ], ...).
 *
 * Note: GitHub does NOT emit a "pull_request_review_thread.created" action.
 * The only valid actions are "resolved" and "unresolved".
 * Source: @octokit/webhooks-types, PullRequestReviewThreadResolvedEvent |
 *         PullRequestReviewThreadUnresolvedEvent
 *
 * Placeholder: no processing implemented yet.
 * Add trigger detection + processRequest() here when ready.
 */
export function handleReviewThread(
  _octokit: Octokit,
  payload: PullRequestReviewThreadEvent,
  deliveryId: string,
): void {
  logger.info(
    {
      deliveryId,
      action: payload.action,
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      entityNumber: payload.pull_request.number,
    },
    "pull_request_review_thread event received (no action configured)",
  );
}
