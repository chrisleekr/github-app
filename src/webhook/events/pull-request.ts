import type { PullRequestEvent } from "@octokit/webhooks-types";
import type { Octokit } from "octokit";

import { config } from "../../config";
import { upsertTarget } from "../../db/queries/conversation-store";
import { createChildLogger, logger } from "../../logger";
import { loadRepoPolicy, policyForWorkflow } from "../../repo-config/effective";
import { runPrConfigCheck } from "../../repo-config/pr-check";
import { dispatchByLabel, dispatchWorkflowByName } from "../../workflows/dispatcher";
import { dispatchCanonicalCommand } from "../../workflows/ship/command-dispatch";
import { fireReactor } from "../../workflows/ship/reactor-bridge";
import { routeTrigger } from "../../workflows/ship/trigger-router";
import { isOwnerAllowed } from "../authorize";
import {
  computeDiffFingerprint,
  hasActiveShipIntent,
  isSelfPush,
  matchesLastReviewed,
  recordReviewedFingerprint,
} from "../auto-review-guard";
import { postDispatchFailure } from "../dispatch-failure";
import { claimDelivery } from "../idempotency";

// Permits the documented label shapes:
//   bot:ship, bot:abort-ship, bot:fix-thread, bot:investigate, ...
//   bot:ship/deadline=2h (parameterised ship)
const BOT_LABEL_PATTERN = /^bot:[a-z][a-z-]*(?:\/deadline=\d+(?:\.\d+)?[hms])?$/;

/**
 * Handler for `pull_request.*` events.
 *
 * Two responsibilities:
 *
 *   1. Cache write-through (every action). The `target_cache` row for this
 *      PR is upserted from `payload.pull_request` before any dispatch gate,
 *      so the chat-thread executor sees the freshest title/body/state/
 *      is_draft/base_ref/head_ref on the very turn the edit triggered.
 *      Mirrors the `writeCommentCacheThrough` pattern in `issue-comment.ts`.
 *      PR deletion is not a real GitHub action (PRs close, never delete),
 *      so there is no hard-delete branch. See issues #129 and #130.
 *
 *   2. Config validation (`opened` / `synchronize` / `reopened`). When the
 *      PR touches `.github-app.yaml`, validate the HEAD-ref copy and post a
 *      sticky verdict comment. Read-only feedback: the copy the bot applies
 *      is still the default branch's. See `repo-config/pr-check.ts`.
 *
 *   3. Action-specific dispatch:
 *      - `opened`: config validation only (trigger detection lands when ready)
 *      - `edited` / `reopened` / `converted_to_draft` / `ready_for_review`:
 *        cache-only, no dispatch
 *      - `labeled`: legacy workflow dispatch + ship reactor label dispatch
 *      - `synchronize`: ship reactor early-wake / foreign-push detection,
 *        plus auto-review dispatch when the pusher is allowlisted
 *      - `closed`: ship reactor terminal transition (merged_externally /
 *        pr_closed)
 *
 * Registered in `src/app.ts` via explicit per-action listeners; each
 * delegates here for action-specific dispatch.
 */
export function handlePullRequest(
  octokit: Octokit,
  payload: PullRequestEvent,
  deliveryId: string,
): void {
  // Cache write-through runs BEFORE any dispatch gate / early-return so
  // every subscribed action keeps target_cache fresh. The fire-and-forget
  // shape matches `writeCommentCacheThrough` in issue-comment.ts; the
  // .catch downgrades inline-mode (no DATABASE_URL) to a no-op inside the
  // writer.
  void writePrTargetCacheThrough(payload).catch((err: unknown) => {
    logger.warn({ err, deliveryId }, "pull_request: cache write-through failed");
  });

  // Config validation is orthogonal to the dispatch branches below, each of
  // which returns early for its own action. Invoked here rather than
  // duplicated into three of them.
  if (
    payload.action === "opened" ||
    payload.action === "synchronize" ||
    payload.action === "reopened"
  ) {
    handlePullRequestConfigCheck(octokit, payload, deliveryId);
  }

  if (payload.action === "labeled") {
    handlePullRequestLabeled(octokit, payload, deliveryId);
    return;
  }

  if (payload.action === "synchronize") {
    if (payload.installation === undefined) return;
    handlePullRequestSynchronize(octokit, payload, deliveryId);
    return;
  }

  if (payload.action === "closed") {
    if (payload.installation === undefined) return;
    fireReactor({
      type: "pull_request.closed",
      installation_id: payload.installation.id,
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      pr_number: payload.pull_request.number,
      merged: payload.pull_request.merged,
    });
    return;
  }

  if (payload.action !== "opened") return;

  logger.info(
    {
      deliveryId,
      action: payload.action,
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
    },
    "pull_request.opened received (no action configured)",
  );
}

/**
 * Validate this PR's own copy of `.github-app.yaml` and post a sticky
 * verdict comment (issue #3). Shaped like `handlePullRequestLabeled`:
 * authorize, then defer the work behind an idempotency claim.
 *
 * The claim key is suffixed rather than the bare `deliveryId`, because
 * `claimDelivery` is one-shot per key and `handlePullRequestLabeled` already
 * claims the bare id. A shared key would let whichever branch of a delivery
 * ran first silently starve the other.
 *
 * This is a GitHub-write path, so it honours the repo-wide `enabled: false`
 * master switch from the default branch's config (see the comment on the
 * `loadRepoPolicy` call for why only that switch, not the full Gate-1 rule
 * set). The lookup lives here rather than in `pr-check.ts`, which must stay
 * structurally unable to reach the applied-policy path (C4).
 */
export function handlePullRequestConfigCheck(
  octokit: Octokit,
  payload: PullRequestEvent,
  deliveryId: string,
): void {
  const senderLogin = payload.sender.login;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const prNumber = payload.pull_request.number;
  const headSha = payload.pull_request.head.sha;

  const log = createChildLogger({
    deliveryId,
    event: `pull_request.${payload.action}`,
    senderLogin,
    owner,
    repo,
    entityNumber: prNumber,
    ...(payload.installation !== undefined ? { installationId: payload.installation.id } : {}),
  });

  const auth = isOwnerAllowed(senderLogin, log);
  if (!auth.allowed) {
    log.info({ reason: auth.reason }, "pull_request config check: sender not in ALLOWED_OWNERS");
    return;
  }

  void (async (): Promise<void> => {
    if (!(await claimDelivery(`${deliveryId}:config-check`, log))) return;
    try {
      // Only the document-level `enabled` master switch, deliberately NOT the
      // full `checkRepoGate` trigger set. The `triggers.*` filters exist to
      // stop the bot ACTING on a pull request; suppressing authoring feedback
      // because the config PR is a draft, or because its title matches
      // `ignore_title_keywords`, is the opposite of what an author wants. Same
      // scope the scheduler applies to its unattended runs.
      const policy = await loadRepoPolicy({ octokit, owner, repo, log });
      if (!policy.enabled) {
        log.info(
          { event: "repo_config.pr_check.disabled", owner, repo, prNumber },
          "repo-config PR check: repo disabled by config, staying silent",
        );
        return;
      }
      await runPrConfigCheck({ octokit, owner, repo, prNumber, headSha, deliveryId, log });
    } catch (err) {
      log.error({ err }, "pull_request config check failed");
    }
  })();
}

/**
 * Resolve the actual commit author for the new head SHA before firing
 * the reactor. `payload.sender.login` is the webhook actor, not the
 * commit author: for cherry-picks, rebases, or push-on-behalf-of
 * automation those differ, and the foreign-push detector downstream
 * needs the real author to avoid both false positives (bot pushes
 * surfaced as foreign) and false negatives (human pushes hidden behind
 * a bot sender). This mirrors the lifecycle-commands.ts pattern that
 * also calls `repos.getCommit` for the same reason.
 */
function handlePullRequestSynchronize(
  octokit: Octokit,
  payload: PullRequestEvent & { action: "synchronize" },
  deliveryId: string,
): void {
  if (payload.installation === undefined) return;
  const installationId = payload.installation.id;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const prNumber = payload.pull_request.number;
  const headSha = payload.pull_request.head.sha;
  const senderFallback = payload.sender.login;

  void (async (): Promise<void> => {
    let authorLogin: string = senderFallback;
    try {
      const { data: commit } = await octokit.rest.repos.getCommit({ owner, repo, ref: headSha });
      authorLogin = commit.author?.login ?? commit.committer?.login ?? senderFallback;
    } catch (err) {
      logger.warn(
        { err, deliveryId, owner, repo, prNumber, headSha },
        "pull_request.synchronize: repos.getCommit failed; falling back to sender.login",
      );
    }
    fireReactor({
      type: "pull_request.synchronize",
      installation_id: installationId,
      owner,
      repo,
      pr_number: prNumber,
      head_sha: headSha,
      head_author_login: authorLogin,
    });

    // `.catch`, not a bare await: this IIFE is fire-and-forget, and
    // `installFatalHandlers` (src/logger.ts) answers `unhandledRejection` with
    // `process.exit(1)`. One bad webhook must not take the server down.
    await maybeAutoReview(octokit, payload, deliveryId).catch((err: unknown) => {
      logger.error({ err, deliveryId, event: "auto_review.failed" }, "auto-review threw");
    });
  })();
}

/**
 * Auto-dispatch `review` when an `AUTO_REVIEW_USERS` login pushes to an open PR
 * (work item #1). Two keys must agree: that env allowlist and the repo's own
 * `workflows.review.auto`. Either one unset means this returns early.
 *
 * Reads `payload.sender.login`, deliberately NOT the `authorLogin` resolved
 * above. That value comes from the commit's author *email*, which anyone can set
 * with `git config user.email`; the reactor wants it because it asks a semantic
 * question (did a human take over this branch?). This gate asks an authorization
 * question (may we spend tokens on this push?), and only the authenticated
 * pusher answers that. Do not "simplify" this to reuse `authorLogin`.
 *
 * Gate 1 still runs inside `dispatchWorkflowByName`, so `enabled: false`,
 * `workflows.review.enabled: false`, and every `triggers.*` filter keep their
 * veto.
 */
async function maybeAutoReview(
  octokit: Octokit,
  payload: PullRequestEvent & { action: "synchronize" },
  deliveryId: string,
): Promise<void> {
  const allowlist = config.autoReviewUsers;
  if (allowlist === undefined) return;

  const senderLogin = payload.sender.login;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const prNumber = payload.pull_request.number;

  const log = createChildLogger({
    deliveryId,
    event: "pull_request.synchronize",
    senderLogin,
    owner,
    repo,
    entityNumber: prNumber,
    ...(payload.installation !== undefined ? { installationId: payload.installation.id } : {}),
  });

  // Two lists, two questions. ALLOWED_OWNERS gates the *repository* (its
  // documented meaning, and what `router.ts` passes), AUTO_REVIEW_USERS gates
  // the *person* who pushed. Testing the pusher against ALLOWED_OWNERS instead
  // would refuse a collaborator the operator deliberately allowlisted here.
  if (!isOwnerAllowed(owner, log).allowed) return;

  const normalized = senderLogin.toLowerCase();
  if (!allowlist.some((u) => u.toLowerCase() === normalized)) return;

  // `checkoutRepo` clones the BASE repo and asks for the PR's head *branch name*
  // (`src/core/checkout.ts`), so a fork ref either fails to clone or, worse,
  // silently resolves to a same-named branch in the base repo and reviews the
  // wrong tree. Nobody asked for this run, so skip rather than guess. Matches
  // the fork test in `src/workflows/handlers/branch-refresh.ts`.
  if (payload.pull_request.head.repo?.full_name !== payload.repository.full_name) {
    log.info({ event: "auto_review.skipped_fork_pr" }, "auto-review: head is on a fork");
    return;
  }

  try {
    // Claim first, per the idempotency contract in CLAUDE.md: a redelivery must
    // short-circuit before any GitHub pagination, and two concurrent deliveries
    // must not both pay for `computeDiffFingerprint`'s paginated listFiles.
    // Suffixed key: `claimDelivery` is one-shot per key and the config-check
    // branch already claims one on this same delivery. See the note above
    // `handlePullRequestConfigCheck`.
    if (!(await claimDelivery(`${deliveryId}:auto-review`, log))) return;

    // Remaining gates are ordered cheapest-first. The self-push check costs
    // nothing under App auth, the policy read is an ETag-cached conditional
    // request, and only then do we pay for a paginated listFiles.
    if (await isSelfPush(payload.sender, log)) {
      log.info({ event: "auto_review.skipped_self_push" }, "auto-review: our own push");
      return;
    }

    // A PR that `ship` is driving already gets reviewed by ship's own
    // review -> resolve iteration, so a second review would duplicate the spend
    // and race ship's `insertQueued` on `idx_workflow_runs_inflight`. Best
    // effort: with no DATABASE_URL there are no intents to collide with.
    if (await hasActiveShipIntent(owner, repo, prNumber, log)) {
      log.info({ event: "auto_review.skipped_ship_active" }, "auto-review: ship owns this PR");
      return;
    }

    // Per-repo opt-in. `loadRepoPolicy` fails open to DEFAULT_REPO_POLICY, where
    // `auto` is false, so an unreachable or invalid config means no auto-review.
    const policy = await loadRepoPolicy({ octokit, owner, repo, log });
    if (!policyForWorkflow(policy, "review").auto) {
      log.debug(
        { event: "auto_review.skipped_repo_opt_out" },
        "auto-review: not enabled for this repo",
      );
      return;
    }

    // A push that leaves the PR's own diff byte-identical (a rebase) bought no
    // new code to review, so it buys no review.
    const fingerprint = await computeDiffFingerprint(octokit, owner, repo, prNumber, log);
    if (
      fingerprint !== null &&
      (await matchesLastReviewed(owner, repo, prNumber, fingerprint, log))
    ) {
      log.info({ event: "auto_review.skipped_unchanged_diff" }, "auto-review: diff unchanged");
      return;
    }

    // `auto: true` => never comments, never touches labels. An in-flight review
    // for this PR makes `insertQueued` return a silent `refused`, which is the
    // ignore-do-not-queue behaviour this feature wants.
    const outcome = await dispatchWorkflowByName({
      octokit,
      logger: log,
      workflowName: "review",
      target: { type: "pr", owner, repo, number: prNumber },
      senderLogin,
      deliveryId,
      triggerBodyPreview: "",
      addRocketReaction: false,
      auto: true,
      // Reuse the policy loaded above so Gate 1 does not re-fetch it.
      repoPolicy: policy,
      trigger: {
        title: payload.pull_request.title,
        draft: payload.pull_request.draft,
        baseBranch: payload.pull_request.base.ref,
      },
    });

    // Recorded only on a real dispatch, so a Gate-1 refusal cannot poison the
    // fingerprint and suppress the next genuine review.
    if (outcome.status === "dispatched" && fingerprint !== null) {
      await recordReviewedFingerprint(owner, repo, prNumber, fingerprint, log);
    }
    log.info(
      { event: "auto_review.outcome", status: outcome.status },
      "auto-review: dispatch settled",
    );
  } catch (err) {
    log.error({ err, event: "auto_review.failed" }, "auto-review: dispatch threw");
  }
}

function handlePullRequestLabeled(
  octokit: Octokit,
  payload: PullRequestEvent & { action: "labeled" },
  deliveryId: string,
): void {
  const labelName = payload.label?.name;
  if (labelName === undefined || !BOT_LABEL_PATTERN.test(labelName)) return;

  const senderLogin = payload.sender.login;
  const log = createChildLogger({
    deliveryId,
    event: "pull_request.labeled",
    label: labelName,
    senderLogin,
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    entityNumber: payload.pull_request.number,
    // Per-installation rate-limit triage (#177): App webhooks always carry
    // installation, but stay undefined-safe.
    ...(payload.installation !== undefined ? { installationId: payload.installation.id } : {}),
  });

  const auth = isOwnerAllowed(senderLogin, log);
  if (!auth.allowed) {
    log.info(
      { reason: auth.reason },
      "pull_request.labeled: sender not in ALLOWED_OWNERS, dropped",
    );
    return;
  }

  // Canonical routing wins; legacy `dispatchByLabel` runs only when
  // `routeTrigger` returns null. Without this precedence, an overlapping
  // label (e.g. `bot:ship`) fires both pipelines for one webhook.
  // FR-029..FR-035 eligibility, labels declared issue-only (e.g.
  // `bot:investigate`) are rejected here and fall through to the legacy
  // path, which ignores them on PRs.
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const prNumber = payload.pull_request.number;
  const installationId = payload.installation?.id;
  // Facts the repo-config trigger filters evaluate. Taken from the payload
  // rather than re-fetched, so the gate costs no extra API call.
  const trigger = {
    title: payload.pull_request.title,
    draft: payload.pull_request.draft,
    baseBranch: payload.pull_request.base.ref,
  };

  void (async (): Promise<void> => {
    // Idempotency gate (issue #202): skip a redelivery before any dispatch.
    if (!(await claimDelivery(deliveryId, log))) return;
    if (installationId !== undefined) {
      try {
        const command = await routeTrigger({
          surface: "label",
          payload: {
            label_name: labelName,
            principal_login: senderLogin,
            pr: { owner, repo, number: prNumber, installation_id: installationId },
            event_surface: "pr-label",
          },
        });
        if (command !== null) {
          dispatchCanonicalCommand(command, { octokit, log, trigger });
          return;
        }
      } catch (err) {
        log.error({ err }, "trigger-router threw for pull_request.labeled");
      }
    }

    try {
      await dispatchByLabel({
        octokit,
        logger: log,
        label: labelName,
        target: { type: "pr", owner, repo, number: prNumber },
        senderLogin,
        deliveryId,
        trigger,
      });
    } catch (err) {
      log.error({ err }, "dispatchByLabel threw for pull_request.labeled");
      await postDispatchFailure({ octokit, log, deliveryId, owner, repo, number: prNumber });
    }
  })();
}

/**
 * Cache write-through for the chat-thread executor. Mirrors
 * `writeCommentCacheThrough` in issue-comment.ts but targets
 * `target_cache` (PR body) rather than `comment_cache`. Runs on every
 * subscribed action so the cache stays a faithful projection of GitHub
 * state. Inline-mode deployments (no DB) silently skip via the
 * DATABASE_URL guard, matching the existing pattern.
 *
 * State semantics: a merged PR reports `state: "closed"` and `merged:
 * true` in the payload; downstream readers expect `"merged"` in
 * target_cache (see `backfillFromGitHub` for the same translation), so
 * we collapse the two flags here.
 */
export async function writePrTargetCacheThrough(payload: PullRequestEvent): Promise<void> {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const pr = payload.pull_request;
  const targetNumber = pr.number;

  try {
    await upsertTarget({
      owner,
      repo,
      targetType: "pr",
      targetNumber,
      title: pr.title,
      body: pr.body ?? "",
      state: pr.merged === true ? "merged" : pr.state,
      // `user` is optional-chained because partial test fixtures and rare
      // ghost-user payloads can lack it, matching `backfillFromGitHub`.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- schema marks user non-nullable but partial fixtures omit it
      authorLogin: pr.user?.login ?? "",
      isDraft: pr.draft,
      baseRef: pr.base.ref,
      headRef: pr.head.ref,
      createdAt: new Date(pr.created_at),
      updatedAt: new Date(pr.updated_at),
    });
  } catch (err) {
    if (err instanceof Error && /DATABASE_URL/i.test(err.message)) return;
    throw err;
  }
}
