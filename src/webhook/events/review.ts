import type { PullRequestReviewEvent } from "@octokit/webhooks-types";
import type { Octokit } from "octokit";

import { logger } from "../../logger";
import { fireReactor } from "../../workflows/ship/reactor-bridge";

/**
 * Handler for pull_request_review.submitted events.
 * Registered in src/app.ts via app.webhooks.on("pull_request_review.submitted", ...).
 *
 * Fires the ship reactor (T024) so any active intent on this PR wakes early
 * to inspect the new review state.
 */
export function handleReview(
  _octokit: Octokit,
  payload: PullRequestReviewEvent,
  deliveryId: string,
): void {
  if (payload.action !== "submitted") return;

  if (payload.installation !== undefined) {
    fireReactor({
      type: "pull_request_review.submitted",
      installation_id: payload.installation.id,
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      pr_number: payload.pull_request.number,
    });
    logger.debug(
      {
        deliveryId,
        action: payload.action,
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        entityNumber: payload.pull_request.number,
      },
      "pull_request_review.submitted received → ship reactor fired",
    );
  }
}
