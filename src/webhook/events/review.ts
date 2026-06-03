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
 *
 * No `claimDelivery` idempotency gate (issue #202): unlike the comment/label
 * handlers, this fires only an idempotent reactor wake (no LLM dispatch, no
 * workflow_runs row, no GitHub write). A redelivery just re-pokes an already-
 * awake intent, which is harmless and self-deduping, so the dedup claim would
 * add a Valkey round trip with nothing to protect.
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
