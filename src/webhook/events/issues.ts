import type { IssuesEvent } from "@octokit/webhooks-types";
import type { Octokit } from "octokit";

import { deleteTarget, upsertTarget } from "../../db/queries/conversation-store";
import { createChildLogger, logger } from "../../logger";
import { dispatchByLabel } from "../../workflows/dispatcher";
import { dispatchCanonicalCommand } from "../../workflows/ship/command-dispatch";
import { routeTrigger } from "../../workflows/ship/trigger-router";
import { isOwnerAllowed } from "../authorize";

// Permits hyphenated verbs (e.g. `bot:open-pr`, `bot:fix-thread`); the verb
// must start with a letter and may contain `-`-separated lowercase segments.
const BOT_LABEL_PATTERN = /^bot:[a-z]+(?:-[a-z]+)*$/;

/**
 * Handler for `issues.*` events.
 *
 * Two responsibilities:
 *
 *   1. Cache write-through (every action). The `target_cache` row for this
 *      issue is upserted from the payload before any dispatch gate, so the
 *      chat-thread executor sees the freshest title/body/state on the very
 *      turn the edit triggered. `deleted` hard-deletes the row plus its
 *      `comment_cache` children, since GitHub no longer holds the issue.
 *      Mirrors the `writeCommentCacheThrough` pattern in `issue-comment.ts`.
 *      See issues #129 and #130.
 *
 *   2. Label dispatch (`labeled` only). Implements the protocol from
 *      `specs/20260421-181205-bot-workflows/contracts/webhook-dispatch.md`
 *      §Label trigger:
 *
 *        1. label.name matches ^bot:[a-z]+$
 *        2. sender.login in ALLOWED_OWNERS
 *        → hand off to `dispatchByLabel` for the seven-step protocol.
 *
 *      FR-015: events that fail precondition 2 produce no DB row, no queue
 *      job, and no tracking comment. `unlabeled` is accepted so the webhook
 *      subscription stays symmetric with `labeled`, but the dispatch
 *      protocol does not run (label removal is a reversal of a prior state,
 *      not a fresh trigger).
 */
export function handleIssues(octokit: Octokit, payload: IssuesEvent, deliveryId: string): void {
  // Cache write-through runs BEFORE any dispatch gate / early-return so
  // every subscribed action keeps target_cache fresh. The fire-and-forget
  // shape matches `writeCommentCacheThrough` in issue-comment.ts; the
  // .catch downgrades inline-mode (no DATABASE_URL) to a no-op inside the
  // writer.
  void writeIssueTargetCacheThrough(payload).catch((err: unknown) => {
    logger.warn({ err, deliveryId }, "issues: cache write-through failed");
  });

  if (payload.action === "unlabeled") {
    const removedLabel = payload.label?.name;
    if (removedLabel !== undefined && BOT_LABEL_PATTERN.test(removedLabel)) {
      logger.info(
        { deliveryId, removedLabel, owner: payload.repository.owner.login },
        "issues.unlabeled received for bot:* label, no-op (label removal is not a trigger)",
      );
    }
    return;
  }

  if (payload.action !== "labeled") return;

  const labelName = payload.label?.name;
  if (labelName === undefined || !BOT_LABEL_PATTERN.test(labelName)) return;

  const senderLogin = payload.sender.login;
  const log = createChildLogger({
    deliveryId,
    event: "issues.labeled",
    label: labelName,
    senderLogin,
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    entityNumber: payload.issue.number,
    // Per-installation rate-limit triage (#177): App webhooks always carry
    // installation, but stay undefined-safe.
    ...(payload.installation !== undefined ? { installationId: payload.installation.id } : {}),
  });

  const auth = isOwnerAllowed(senderLogin, log);
  if (!auth.allowed) {
    log.info({ reason: auth.reason }, "issues.labeled: sender not in ALLOWED_OWNERS, dropped");
    return;
  }

  // Canonical routing wins; legacy `dispatchByLabel` runs only when
  // `routeTrigger` returns null. Without this precedence, an overlapping
  // label (e.g. `bot:triage`) fires both pipelines for one webhook.
  // FR-029..FR-035 eligibility, labels declared PR-only (e.g.
  // `bot:ship`) are rejected by the trigger-router and fall through to
  // the legacy path, which then ignores them.
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const issueNumber = payload.issue.number;
  const installationId = payload.installation?.id;

  void (async (): Promise<void> => {
    if (installationId !== undefined) {
      try {
        const command = await routeTrigger({
          surface: "label",
          payload: {
            label_name: labelName,
            principal_login: senderLogin,
            pr: { owner, repo, number: issueNumber, installation_id: installationId },
            event_surface: "issue-label",
          },
        });
        if (command !== null) {
          dispatchCanonicalCommand(command, { octokit, log });
          return;
        }
      } catch (err) {
        log.error({ err }, "trigger-router threw for issues.labeled");
      }
    }

    try {
      await dispatchByLabel({
        octokit,
        logger: log,
        label: labelName,
        target: { type: "issue", owner, repo, number: issueNumber },
        senderLogin,
        deliveryId,
      });
    } catch (err) {
      log.error({ err }, "dispatchByLabel threw for issues.labeled");
    }
  })();
}

/**
 * Cache write-through for the chat-thread executor. Mirrors
 * `writeCommentCacheThrough` in issue-comment.ts but targets
 * `target_cache` (issue body) rather than `comment_cache`. Runs on every
 * subscribed action so the cache stays a faithful projection of GitHub
 * state. Inline-mode deployments (no DB) silently skip via the
 * DATABASE_URL guard, matching the existing pattern.
 *
 * Actions:
 *   - opened / edited / closed / reopened: upsert title/body/state.
 *   - deleted: hard-delete the row plus its comment_cache children.
 *   - labeled / unlabeled: also upsert because GitHub bumps `updated_at`
 *     on label changes and an active conversation may run a chat-thread
 *     turn right after; staying current here costs one INSERT.
 */
export async function writeIssueTargetCacheThrough(payload: IssuesEvent): Promise<void> {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const targetNumber = payload.issue.number;

  try {
    if (payload.action === "deleted") {
      await deleteTarget({ owner, repo, targetType: "issue", targetNumber });
      return;
    }
    const i = payload.issue;
    await upsertTarget({
      owner,
      repo,
      targetType: "issue",
      targetNumber,
      title: i.title,
      // `state` widens to `string | undefined` across the IssuesEvent
      // union; default to "open" for the variants that omit it. `user`
      // is optional-chained because partial test fixtures and rare
      // ghost-user payloads can lack it, matching `backfillFromGitHub`.
      body: i.body ?? "",
      state: (i.state ?? "open") as string,
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- schema marks user non-nullable but partial fixtures omit it
      authorLogin: i.user?.login ?? "",
      isDraft: null,
      baseRef: null,
      headRef: null,
      createdAt: new Date(i.created_at),
      updatedAt: new Date(i.updated_at),
    });
  } catch (err) {
    if (err instanceof Error && /DATABASE_URL/i.test(err.message)) return;
    throw err;
  }
}
