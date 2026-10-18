/** Hard lifetime of one workflow-runner attempt, from claim. Also the Pod's activeDeadlineSeconds. */
export const WORKFLOW_RUNNER_ATTEMPT_DEADLINE_MS = 4_200_000;

/** GitHub installation tokens are issued for exactly one hour. */
export const GITHUB_INSTALLATION_TOKEN_LIFETIME_MS = 60 * 60 * 1_000;

/**
 * Latest a runner Pod may still be starting, measured from its creationTimestamp.
 *
 * Derived, not chosen: the payload gate rejects a registration with one token
 * lifetime or less before the deadline, so a Pod still starting past this point
 * can never receive a token. The minute of margin covers the normal
 * claim-to-create gap and runner boot. A Pod created late is caught by the
 * token-cutoff check in classifyPodStartup instead. Failing here frees the
 * concurrency slot at once instead of holding it until the deadline.
 */
export const WORKFLOW_RUNNER_STARTUP_BUDGET_MS =
  WORKFLOW_RUNNER_ATTEMPT_DEADLINE_MS - GITHUB_INSTALLATION_TOKEN_LIFETIME_MS - 60_000;
