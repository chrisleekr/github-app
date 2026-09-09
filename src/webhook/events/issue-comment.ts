import type { IssueCommentEvent } from "@octokit/webhooks-types";
import type { Octokit } from "octokit";
import type { Logger } from "pino";

import { containsTrigger } from "../../core/trigger";
import { softDeleteComment, upsertComment } from "../../db/queries/conversation-store";
import { createChildLogger, logger } from "../../logger";
import { runProposalPollOnce } from "../../orchestrator/proposal-poller";
import { addReaction } from "../../utils/reactions";
import { dispatchCommentSurface } from "../../workflows/ship/command-dispatch";
import { isOwnerAllowed } from "../authorize";
import { postDispatchFailure } from "../dispatch-failure";
import { claimDelivery } from "../idempotency";

/**
 * Handler for issue_comment.created events.
 *
 * When a comment mentions `@chrisleekr-bot`, the body goes to
 * `dispatchCommentSurface`, the one comment rail: it classifies once and
 * routes to the ship, scoped, or registry-workflow handler. Registry
 * workflows land in `workflow_runs` via `dispatchWorkflowByName`, the same
 * primitive the label trigger uses.
 */
export function handleIssueComment(
  octokit: Octokit,
  payload: IssueCommentEvent,
  deliveryId: string,
): void {
  // Cache write-through (chat-thread): every created/edited/deleted action
  // hits the cache before any dispatch so subsequent chat-thread turns see
  // the freshest body. Bot self-comments are cached too, chat-thread reads
  // them as prior conversation turns.
  void writeCommentCacheThrough(payload).catch((err: unknown) => {
    logger.warn({ err, deliveryId }, "issue-comment: cache write-through failed");
  });

  // Dispatch is created-only: editing a previously-mentioned comment must
  // not re-fire the workflow (would be surprising UX and double-bill the
  // user). The cache write-through above must run BEFORE this gate.
  if (payload.action !== "created") return;
  if (payload.comment.user.type === "Bot") return;

  // Authorize before dispatch. Mirrors the structure used in `issues.ts`,
  // `pull-request.ts`, and `review-comment.ts`.
  const senderLogin = payload.comment.user.login;
  const ownerLogin = payload.repository.owner.login;
  const log = createChildLogger({
    deliveryId,
    owner: ownerLogin,
    repo: payload.repository.name,
    // `issue_comment` fires on PR comments too (payload.issue.pull_request),
    // so the canonical `entityNumber` covers both surfaces under one field.
    entityNumber: payload.issue.number,
    senderLogin,
    // Per-installation rate-limit triage (#177). Conditional because this
    // logger is built before the `payload.installation === undefined` guard
    // below; the guard can't move up (the owner-allowlist drop line logs
    // through `log` first).
    ...(payload.installation !== undefined ? { installationId: payload.installation.id } : {}),
  });

  const auth = isOwnerAllowed(ownerLogin, log);
  if (!auth.allowed) {
    log.info({ reason: auth.reason }, "issue_comment dropped, owner not allowlisted");
    return;
  }

  if (payload.installation === undefined) return;

  const installationId = payload.installation.id;
  const owner = ownerLogin;
  const repo = payload.repository.name;
  const targetNumber = payload.issue.number;
  const commentBody = payload.comment.body;
  const isPR = payload.issue.pull_request !== undefined;
  const eventSurface = isPR ? "pr-comment" : "issue-comment";
  // Facts the repo-config trigger filters evaluate. `issue.draft` is
  // populated when the issue is really a PR, so `ignore_draft_prs` covers
  // comments too, not just label events. No base ref on this payload, so
  // the `base_branches` rule is the one that skips here.
  const trigger = { title: payload.issue.title, draft: isPR ? payload.issue.draft : undefined };

  // Trigger-surface dispatch (T028e + T090). PR comments and Issue
  // comments share the same `issue_comment` event; the
  // `payload.issue.pull_request` flag distinguishes them. The
  // `event_surface` tag enforces per-intent eligibility, e.g.,
  // `bot:investigate` only fires on Issue comments and `bot:summarize`
  // only on PR comments. One rail: `dispatchCommentSurface` classifies once
  // and routes to the ship, scoped, or workflow handler.
  void (async (): Promise<void> => {
    // Idempotency gate (issue #202): GitHub redelivers with the same
    // deliveryId, so a redelivery would re-run the NL classifier and any
    // chat-thread turn. Claim the delivery before any dispatch; a redelivery
    // skips. Fail-open in claimDelivery.
    if (!(await claimDelivery(deliveryId, log))) return;
    const dispatchLog = log.child({ event_surface: eventSurface });

    // Acknowledge before the classifier call. This used to fire only on the
    // legacy path, so a mention the canonical rail handled got no reaction at
    // all while the model was thinking.
    if (containsTrigger(commentBody)) {
      void addReaction({
        octokit,
        logger: log,
        owner,
        repo,
        commentId: payload.comment.id,
        eventType: "issue_comment",
        content: "eyes",
      });
    }

    try {
      await dispatchCommentSurface({
        commentBody,
        principal_login: senderLogin,
        pr: { owner, repo, number: targetNumber, installation_id: installationId },
        event_surface: eventSurface,
        trigger_comment_id: payload.comment.id,
        deliveryId,
        octokit,
        log: dispatchLog,
        trigger,
      });
    } catch (err) {
      dispatchLog.error({ err }, "ship dispatchCommentSurface threw for issue_comment");
      // A mention the bot acknowledged with 👀 and then dropped silently reads
      // as the bot being broken. Same fixed, secret-free reply the label rails
      // post; the raw error stays in the log line above.
      await postDispatchFailure({ octokit, log, deliveryId, owner, repo, number: targetNumber });
    }

    // Runs for every comment, triggering or not: a comment that didn't
    // address the bot may still carry an approval reply by the original asker
    // (they react 👍 and then type something unrelated).
    piggybackProposalPoll(octokit, installationId, owner, repo, log);
  })();
}

/**
 * Cache write-through for the chat-thread executor. Runs on every
 * `created` / `edited` / `deleted` action so the cache stays a faithful
 * projection of GitHub state. Inline-mode deployments (no DB) silently
 * skip: `upsertComment` requires `requireDb()` which throws if not
 * configured, so wrap in try/catch and downgrade DB-not-configured to
 * a no-op.
 */
export async function writeCommentCacheThrough(payload: IssueCommentEvent): Promise<void> {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const targetNumber = payload.issue.number;
  const targetType: "issue" | "pr" = payload.issue.pull_request !== undefined ? "pr" : "issue";

  try {
    if (payload.action === "deleted") {
      await softDeleteComment({ owner, repo, commentId: payload.comment.id });
      return;
    }
    if (payload.action === "created" || payload.action === "edited") {
      await upsertComment({
        owner,
        repo,
        targetType,
        targetNumber,
        commentId: payload.comment.id,
        surface: "issue-comment",
        inReplyToId: null,
        authorLogin: payload.comment.user.login,
        authorType: payload.comment.user.type,
        body: payload.comment.body,
        path: null,
        line: null,
        diffHunk: null,
        createdAt: new Date(payload.comment.created_at),
        updatedAt: new Date(payload.comment.updated_at),
      });
    }
  } catch (err) {
    // DB not configured (inline mode) → harmless skip. Other errors are
    // surfaced via the caller's outer .catch: we still throw here.
    if (err instanceof Error && /DATABASE_URL/i.test(err.message)) return;
    throw err;
  }
}

/**
 * Piggyback proposal-poll: after dispatching the webhook, scan any
 * pending chat-thread proposals for this target. The most common UX is
 * "user reacts then types something": this poll is what flips that
 * proposal during the same delivery without waiting for the periodic
 * scanner.
 */
function piggybackProposalPoll(
  octokit: Octokit,
  installationId: number,
  owner: string,
  repo: string,
  log: Logger,
): void {
  void runProposalPollOnce({
    resolveOctokit: () => Promise.resolve(octokit),
    resolveInstallationId: (q) =>
      Promise.resolve(q.owner === owner && q.repo === repo ? installationId : null),
    log: log.child({ component: "proposal-poller", trigger: "piggyback-issue-comment" }),
  }).catch((err: unknown) => {
    logger.debug({ err }, "piggybackProposalPoll: scan failed");
  });
}
