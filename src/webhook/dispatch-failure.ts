import type { Octokit } from "octokit";
import type { Logger } from "pino";

import { safePostToGitHub } from "../utils/github-output-guard";

const DISPATCH_FAILURE_MESSAGE = "Sorry, I couldn't start that workflow. Please try again.";

interface DispatchFailureInput {
  readonly octokit: Octokit;
  readonly log: Logger;
  readonly deliveryId: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

/** Tell an explicit requester that dispatch failed without exposing operator details. */
export async function postDispatchFailure(input: DispatchFailureInput): Promise<void> {
  try {
    await safePostToGitHub({
      body: DISPATCH_FAILURE_MESSAGE,
      source: "system",
      callsite: "webhook.dispatch-failure",
      log: input.log,
      deliveryId: input.deliveryId,
      post: (body) =>
        input.octokit.rest.issues.createComment({
          owner: input.owner,
          repo: input.repo,
          issue_number: input.number,
          body,
        }),
    });
  } catch (err) {
    input.log.warn(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "Failed to post workflow dispatch failure comment",
    );
  }
}
