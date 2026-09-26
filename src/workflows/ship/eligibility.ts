/**
 * Eligibility gate per FR-015. Enforces four refusal cases before any
 * `ship_intents` row is written:
 *
 *   1. PR head is on a fork (`headRepository.id !== baseRepository.id`)
 *   2. PR is already `closed` or `merged`
 *   3. Triggering principal is not in `ALLOWED_OWNERS`
 *   4. Target branch matches `SHIP_FORBIDDEN_TARGET_BRANCHES`
 *
 * Pure verdict: never mutates DB or comments. Callers (handler / router)
 * surface the maintainer-facing message.
 */

import type { Octokit } from "octokit";

import { config } from "../../config";

export type IneligibleReason =
  "fork" | "closed" | "merged" | "unauthorized" | "forbidden_target_branch";

export type EligibilityVerdict =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: IneligibleReason; readonly message: string };

export interface EligibilityInput {
  readonly octokit: Pick<Octokit, "graphql">;
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  readonly triggeringUserLogin: string;
}

interface EligibilityProbeResponse {
  readonly repository: {
    readonly pullRequest: {
      readonly state: "OPEN" | "CLOSED" | "MERGED";
      readonly merged: boolean;
      readonly baseRefName: string;
      readonly baseRepository: { readonly id: string };
      readonly headRepository: { readonly id: string } | null;
      readonly author: { readonly login: string } | null;
    } | null;
  } | null;
}

const ELIGIBILITY_QUERY = `
  query Eligibility($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        state
        merged
        baseRefName
        baseRepository { id }
        headRepository { id }
        author { login }
      }
    }
  }
`;

export async function checkEligibility(input: EligibilityInput): Promise<EligibilityVerdict> {
  const allowedOwners = config.allowedOwners;
  const forbidden = config.shipForbiddenTargetBranches;
  if (allowedOwners !== undefined && allowedOwners.length > 0) {
    const triggerOk = allowedOwners.some(
      (o) => o.toLowerCase() === input.triggeringUserLogin.toLowerCase(),
    );
    if (!triggerOk) {
      return {
        eligible: false,
        reason: "unauthorized",
        message: `\`${input.triggeringUserLogin}\` is not in the configured ALLOWED_OWNERS list.`,
      };
    }
  }

  const data = await input.octokit.graphql<EligibilityProbeResponse>(ELIGIBILITY_QUERY, {
    owner: input.owner,
    repo: input.repo,
    number: input.pr_number,
  });
  const pr = data.repository?.pullRequest;
  if (pr === undefined || pr === null) {
    return {
      eligible: false,
      reason: "closed",
      message: `PR #${input.pr_number} not found in ${input.owner}/${input.repo}.`,
    };
  }

  if (pr.merged) {
    return { eligible: false, reason: "merged", message: "PR is already merged." };
  }
  if (pr.state === "CLOSED") {
    return {
      eligible: false,
      reason: "closed",
      message: "PR is closed; reopen it before shipping.",
    };
  }
  if (pr.headRepository?.id !== pr.baseRepository.id) {
    return {
      eligible: false,
      reason: "fork",
      message: "Cannot shepherd a PR from a fork, push permission is unavailable.",
    };
  }
  if (forbidden.length > 0 && forbidden.includes(pr.baseRefName)) {
    return {
      eligible: false,
      reason: "forbidden_target_branch",
      message: `Target branch \`${pr.baseRefName}\` is in SHIP_FORBIDDEN_TARGET_BRANCHES.`,
    };
  }
  return { eligible: true };
}
