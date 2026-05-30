import type { PullRequestEvent } from "@octokit/webhooks-types";
import type { Octokit } from "octokit";

import { upsertTarget } from "../../db/queries/conversation-store";
import { createChildLogger, logger } from "../../logger";
import { dispatchByLabel } from "../../workflows/dispatcher";
import { dispatchCanonicalCommand } from "../../workflows/ship/command-dispatch";
import { fireReactor } from "../../workflows/ship/reactor-bridge";
import { routeTrigger } from "../../workflows/ship/trigger-router";
import { isOwnerAllowed } from "../authorize";

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
 *   2. Action-specific dispatch:
 *      - `opened`: placeholder (trigger detection lands when ready)
 *      - `edited` / `reopened` / `converted_to_draft` / `ready_for_review`:
 *        cache-only, no dispatch
 *      - `labeled`: legacy workflow dispatch + ship reactor label dispatch
 *      - `synchronize`: ship reactor early-wake / foreign-push detection
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
  })();
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

  void (async (): Promise<void> => {
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
          dispatchCanonicalCommand(command, { octokit, log });
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
      });
    } catch (err) {
      log.error({ err }, "dispatchByLabel threw for pull_request.labeled");
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
