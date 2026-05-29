import type { IssueCommentEvent } from "@octokit/webhooks-types";
import type { Octokit } from "octokit";
import type { Logger } from "pino";

import { containsTrigger } from "../../core/trigger";
import { softDeleteComment, upsertComment } from "../../db/queries/conversation-store";
import { createChildLogger, logger } from "../../logger";
import { runProposalPollOnce } from "../../orchestrator/proposal-poller";
import { addReaction } from "../../utils/reactions";
import { dispatchByIntent } from "../../workflows/dispatcher";
import { dispatchCommentSurface } from "../../workflows/ship/command-dispatch";
import { isOwnerAllowed } from "../authorize";

/**
 * Handler for issue_comment.created events.
 *
 * When a comment mentions `@chrisleekr-bot`, the body is routed through the
 * intent classifier (T039) and dispatched to the matching workflow. The old
 * ad-hoc `processRequest` pipeline path is removed for comment triggers,
 * all comment-driven work now lands in `workflow_runs` via the same
 * dispatcher the label trigger uses.
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

  // Authorize before dispatch, both the canonical (`dispatchCommentSurface`)
  // and legacy (`dispatchByIntent`) paths share the same allowlist gate so
  // a dropped repo can't slip through canonical routing. Mirrors the
  // structure used in `issues.ts`, `pull-request.ts`, and `review-comment.ts`.
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

  // Trigger-surface dispatch (T028e + T090). PR comments and Issue
  // comments share the same `issue_comment` event; the
  // `payload.issue.pull_request` flag distinguishes them. The
  // `event_surface` tag enforces per-intent eligibility, e.g.,
  // `bot:investigate` only fires on Issue comments and `bot:summarize`
  // only on PR comments. Canonical wins; legacy `dispatchByIntent`
  // runs only when canonical produced no command.
  void (async (): Promise<void> => {
    const dispatchLog = log.child({ event_surface: eventSurface });
    let canonicalHandled = false;
    try {
      canonicalHandled = await dispatchCommentSurface({
        commentBody,
        principal_login: senderLogin,
        pr: { owner, repo, number: targetNumber, installation_id: installationId },
        event_surface: eventSurface,
        trigger_comment_id: payload.comment.id,
        octokit,
        log: dispatchLog,
      });
    } catch (err) {
      dispatchLog.error({ err }, "ship dispatchCommentSurface threw for issue_comment");
    }

    if (canonicalHandled || !containsTrigger(commentBody)) {
      // Piggyback proposal-poll BEFORE returning, even comments that
      // didn't trigger the bot may carry an approval reply by the
      // original asker (the user reacts 👍 and then types something
      // unrelated). Running the poll here ensures the bot picks up
      // pending approvals on the next webhook for this target.
      piggybackProposalPoll(octokit, installationId, owner, repo, log);
      return;
    }

    log.info("Trigger detected in issue_comment, routing via intent classifier");

    void addReaction({
      octokit,
      logger: log,
      owner,
      repo,
      commentId: payload.comment.id,
      eventType: "issue_comment",
      content: "eyes",
    });

    try {
      await dispatchByIntent({
        octokit,
        logger: log,
        commentBody,
        target: { type: isPR ? "pr" : "issue", owner, repo, number: targetNumber },
        senderLogin,
        deliveryId,
        triggerCommentId: payload.comment.id,
        triggerEventType: "issue_comment",
      });
    } catch (err) {
      log.error({ err }, "dispatchByIntent threw for issue_comment");
    }

    // Piggyback proposal-poll on the trigger path too: the early-
    // return branch above already covered the non-trigger case.
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
