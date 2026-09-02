import { createHash } from "node:crypto";

import type { Octokit } from "octokit";

import { getDb } from "../db";
import { findActiveIntent } from "../db/queries/ship";
import type { Logger } from "../logger";
import { getValkeyClient, isValkeyHealthy } from "../orchestrator/valkey";
import { resolveSelfLogin } from "../utils/bot-identity";
import { type GithubActorLike, isSelfActor } from "../utils/github-actor";

/**
 * Guards for auto-review-on-push (work item #1).
 *
 * Every helper here is advisory. On any error each returns the value that lets
 * the review proceed, because a missing review is a worse failure than a
 * redundant one. The exception is the repo opt-in, which lives in
 * `pull-request.ts` and fails the other way: it reads `loadRepoPolicy`, whose
 * fail-open default has `auto: false`.
 */

/** Long enough to outlive a PR's active life; the key is per-PR, not per-repo. */
const FINGERPRINT_TTL_SECONDS = 60 * 60 * 24 * 30;

/**
 * `pulls.listFiles` truncates above this many files, so the fingerprint would
 * silently stop representing the whole diff. Skip the guard instead.
 */
const MAX_FINGERPRINTED_FILES = 3000;

function fingerprintKey(owner: string, repo: string, prNumber: number): string {
  return `autoreview:fp:${owner}/${repo}#${String(prNumber)}`;
}

/**
 * True when this push came from our own credential.
 *
 * `resolve` fixes review findings, commits, and pushes; that push fires
 * `pull_request.synchronize`. Under `GITHUB_PERSONAL_ACCESS_TOKEN` the pusher is
 * the PAT owner, who is exactly the human listed in `AUTO_REVIEW_USERS`, so
 * without this the loop closes: review -> resolve -> push -> review. This is the
 * only thing breaking that loop: `resolve` deliberately does not filter review
 * comments by author, because our own findings are ship's review -> resolve
 * handoff.
 *
 * Degrades rather than fails closed. `resolveSelfLogin` returns null when the
 * PAT-mode `GET /user` errors, and `isSelfActor(sender, null)` then answers
 * "not us" (its documented fail-open direction, shared with the inline-comment
 * MCP server). A GitHub outage during a bot-authored push therefore costs one
 * redundant review: a standalone `review` does not chain into `resolve`, so the
 * loop does not close. The `warn` exists so that state is visible rather than
 * silent, since the docstring above claims an invariant this case relaxes.
 */
export async function isSelfPush(sender: GithubActorLike, log?: Logger): Promise<boolean> {
  const selfLogin = await resolveSelfLogin();
  if (selfLogin === null) {
    log?.warn(
      { event: "auto_review.self_login_unresolved" },
      "auto-review: could not resolve our own login; self-push check degraded",
    );
  }
  return isSelfActor(sender, selfLogin);
}

/**
 * Hash of the PR's own changes: sorted `filename\0status\0blobSha` triples from
 * `pulls.listFiles`, which is merge-base-relative by definition, so base commits
 * the PR did not author never enter it.
 *
 * A pure rebase rewrites every commit SHA but leaves those blobs untouched, so
 * the hash is stable and the push is recognised as content-free. A rebase that
 * pulls a base change into a file the PR also touches DOES alter the head blob,
 * which is correct: that content genuinely changed and deserves a review.
 *
 * Returns null when the fingerprint cannot be trusted, which disables the guard
 * and lets the review run.
 */
export async function computeDiffFingerprint(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  log: Logger,
): Promise<string | null> {
  try {
    const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });
    if (files.length === 0 || files.length >= MAX_FINGERPRINTED_FILES) {
      // Its own event, not `fingerprint_failed`: nothing failed, the diff is
      // simply not fingerprintable. An operator asking "why did this PR
      // re-review after a rebase?" needs to find this rather than silence.
      log.info(
        {
          event: "auto_review.fingerprint_skipped",
          owner,
          repo,
          prNumber,
          fileCount: files.length,
        },
        "auto-review: diff not fingerprintable, not skipping",
      );
      return null;
    }
    const hash = createHash("sha256");
    for (const line of files.map((f) => `${f.filename}\0${f.status}\0${f.sha}`).sort()) {
      hash.update(line);
      hash.update("\n");
    }
    return hash.digest("hex");
  } catch (err) {
    log.warn(
      { err, event: "auto_review.fingerprint_failed", owner, repo, prNumber },
      "auto-review: could not fingerprint the diff, not skipping",
    );
    return null;
  }
}

/**
 * True when this exact diff was already auto-reviewed.
 *
 * Gated on `isValkeyHealthy()` for the same reason `claimDelivery` is: Bun's
 * RedisClient queues offline commands by default, so issuing GET against a
 * disconnected client would block instead of failing open.
 */
export async function matchesLastReviewed(
  owner: string,
  repo: string,
  prNumber: number,
  fingerprint: string,
  log: Logger,
): Promise<boolean> {
  const client = getValkeyClient();
  if (client === null || !isValkeyHealthy()) return false;
  try {
    const stored = (await client.send("GET", [fingerprintKey(owner, repo, prNumber)])) as
      | string
      | null;
    return stored === fingerprint;
  } catch (err) {
    log.warn(
      { err, event: "auto_review.fingerprint_read_failed", owner, repo, prNumber },
      "auto-review: fingerprint read failed, not skipping",
    );
    return false;
  }
}

/** Record the reviewed diff. Best-effort: a write failure only costs one re-review. */
export async function recordReviewedFingerprint(
  owner: string,
  repo: string,
  prNumber: number,
  fingerprint: string,
  log: Logger,
): Promise<void> {
  const client = getValkeyClient();
  if (client === null || !isValkeyHealthy()) return;
  try {
    await client.send("SET", [
      fingerprintKey(owner, repo, prNumber),
      fingerprint,
      "EX",
      String(FINGERPRINT_TTL_SECONDS),
    ]);
  } catch (err) {
    log.warn(
      { err, event: "auto_review.fingerprint_write_failed", owner, repo, prNumber },
      "auto-review: fingerprint write failed",
    );
  }
}

/**
 * True when `ship` is actively driving this PR.
 *
 * Ship runs its own `review` -> `resolve` iteration, so auto-reviewing the same
 * PR both duplicates the spend and races ship's `insertQueued` on the
 * `idx_workflow_runs_inflight` partial-unique index.
 *
 * Fail-open like every other guard here: no database configured, or a query
 * error, answers "no intent" and the review proceeds.
 */
export async function hasActiveShipIntent(
  owner: string,
  repo: string,
  prNumber: number,
  log: Logger,
): Promise<boolean> {
  if (getDb() === null) return false;
  try {
    return (await findActiveIntent(owner, repo, prNumber)) !== null;
  } catch (err) {
    log.warn(
      { err, event: "auto_review.ship_intent_check_failed", owner, repo, prNumber },
      "auto-review: ship-intent lookup failed, not skipping",
    );
    return false;
  }
}
