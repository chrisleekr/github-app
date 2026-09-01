import type { Octokit } from "octokit";
import type pino from "pino";

import type { CommandIntent } from "../shared/ship-types";
import { safePostToGitHub } from "../utils/github-output-guard";
import type { WorkflowName } from "./registry";
import {
  assertCurrentWorkflowAttempt,
  clearTrackingCommentId,
  clearTrackingCommentIdForAttempt,
  findById,
  findPriorTrackingComments,
  listChildrenByParent,
  mergeAttemptState,
  mergeState,
  StaleWorkflowAttemptError,
  tryReserveTrackingCommentId,
  type WorkflowAttempt,
  type WorkflowRunRow,
} from "./runs-store";

/**
 * State key used to persist the last human-readable message written by a
 * setState call. The cascade refresh re-uses this when re-rendering the
 * parent's composite tracking comment so the parent's own narrative survives
 * across child step updates. Underscore prefix marks it as an internal field
 * not meant for handler-visible state.
 */
export const LAST_HUMAN_MESSAGE_KEY = "_lastHumanMessage";

/**
 * State key holding the run's `.github-app.yaml` notice (invalid-config
 * fail-open warning and/or the `review.path_filters` scope reduction).
 *
 * Persisted on the row rather than prepended to one message because
 * `renderCommentBody` rebuilds the body from scratch on every write: a
 * one-shot prepend is erased by the next progress or terminal update.
 *
 * Underscore prefix per this file's convention: the key shares the flat
 * `workflow_runs.state` namespace that handlers merge into via `ctx.setState`,
 * and marks it as internal rather than handler-visible state.
 */
export const CONFIG_NOTICE_KEY = "_configNotice";

/**
 * Render the persisted config notice as a GitHub alert block. Each stored
 * line becomes its own paragraph inside the alert.
 *
 * Whitespace is collapsed per line: a lone `\r` breaks out of the `> ` line
 * and orphans the rest of the notice outside the blockquote. A blank or
 * non-string value renders nothing, so a whitespace-only warning is treated
 * as absent (same rule as the direct rail's `createTrackingComment`).
 */
function renderConfigNotice(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const lines = raw
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "");
  if (lines.length === 0) return "";
  return `> [!WARNING]\n${lines.map((line) => `> ${line}`).join("\n>\n")}\n\n`;
}

/**
 * Hidden HTML-comment marker embedded in every tracking-comment body. Used
 * to recover a comment id when the DB row's `tracking_comment_id` is still
 * NULL but a comment was actually committed server-side: e.g. octokit's
 * built-in plugin-retry can duplicate a non-idempotent POST when the
 * upstream returns 5xx after writing, or a pod can crash between
 * `createComment` and the CAS reservation. Pairing the marker with a
 * `?since=row.created_at` listComments scan lets us adopt the orphan
 * instead of stamping a fresh duplicate.
 */
function runMarker(runId: string): string {
  return `<!-- workflow-run:${runId} -->`;
}

/**
 * FR-026: the tracking comment is a projection of `workflow_runs.state`, not
 * an independent record. `setState` writes the partial state and the
 * human-readable comment body in the same unit of work so they cannot drift.
 *
 * First call on a run creates the comment and records its id on the row.
 * Subsequent calls patch the same comment.
 */

export interface TrackingMirrorDeps {
  readonly octokit: Octokit;
  readonly logger: pino.Logger;
}

/**
 * Render the tracking-comment body from a workflow_runs row. Intentionally
 * plain: one line for the header (workflow + status) plus the caller's
 * human-readable message. Richer templating lands per-workflow if needed.
 */
export function renderCommentBody(row: WorkflowRunRow, humanMessage: string): string {
  const header = `**bot workflow \`${row.workflow_name}\`**, ${row.status}`;
  const notice = renderConfigNotice(row.state[CONFIG_NOTICE_KEY]);
  return `${runMarker(row.id)}\n${header}\n\n${notice}${humanMessage}`;
}

/**
 * Scan comments on the target issue/PR for our run marker. Scoped by
 * `since=row.created_at` to bound the page-1 result set, but paginates via
 * `octokit.paginate` because `since` filters by `updated_at` (not
 * `created_at`): on a busy issue, comments updated since `row.created_at`
 * can exceed 100 and push our marker comment to a later page. We must
 * walk every page until exhausted, otherwise we'd miss the marker and
 * post a duplicate. Returns oldest-first (this endpoint orders ascending
 * by id within a page; pages are concatenated by octokit in order).
 */
async function findCommentsByMarker(
  deps: TrackingMirrorDeps,
  row: WorkflowRunRow,
): Promise<readonly { id: number; created_at: string }[]> {
  const marker = runMarker(row.id);
  const all = await deps.octokit.paginate(deps.octokit.rest.issues.listComments, {
    owner: row.target_owner,
    repo: row.target_repo,
    issue_number: row.target_number,
    per_page: 100,
    since: row.created_at.toISOString(),
  });
  return all
    .filter((c) => typeof c.body === "string" && c.body.includes(marker))
    .map((c) => ({ id: c.id, created_at: c.created_at }));
}

export interface SetStateParams {
  readonly runId: string;
  readonly patch: Record<string, unknown>;
  readonly humanMessage: string;
  readonly attempt?: WorkflowAttempt;
}

async function assertAttempt(attempt: WorkflowAttempt | undefined): Promise<void> {
  if (attempt === undefined) return;
  await assertCurrentWorkflowAttempt(attempt);
}

/**
 * Merge `patch` into the row's state and update the tracking comment on
 * GitHub. Creates the comment on first call for the run. Returns the
 * post-merge row for callers that want to inspect the latest state.
 *
 * Ordering is DB-first so an API failure after the DB write re-tries cleanly
 * on the next setState call: the row is authoritative.
 */
export async function setState(
  deps: TrackingMirrorDeps,
  params: SetStateParams,
): Promise<WorkflowRunRow> {
  const { octokit, logger } = deps;
  const { runId, patch, humanMessage, attempt } = params;
  if (attempt !== undefined && attempt.runId !== runId) {
    throw new Error("tracking-mirror.setState received a mismatched workflow attempt");
  }

  // Persist the human message alongside the caller's patch so the cascade
  // refresh can re-render the parent's composite body without losing this
  // run's narrative.
  const mergedPatch = { ...patch, [LAST_HUMAN_MESSAGE_KEY]: humanMessage };
  let row: WorkflowRunRow | null;
  if (attempt === undefined) {
    await mergeState(runId, mergedPatch);
    row = await findById(runId);
  } else {
    row = await mergeAttemptState(attempt, mergedPatch);
  }
  if (row === null) {
    throw new Error(`tracking-mirror.setState: run ${runId} not found after merge`);
  }

  const body = renderCommentBody(row, humanMessage);

  let resultRow: WorkflowRunRow;
  if (row.tracking_comment_id === null) {
    resultRow = await createOrAdoptTrackingComment(deps, row, body, humanMessage, attempt);
    // First touch for this run: AFTER the new comment is safely created and
    // reserved, delete this workflow's stale tracking comment(s) from earlier
    // runs so re-running a workflow does not pile up comments. Ordered after
    // create so a create failure never leaves the thread with no comment.
    // Best-effort: never blocks.
    await cleanupPriorTrackingComments(deps, resultRow, attempt);
  } else {
    const commentId = row.tracking_comment_id;
    await safePostToGitHub({
      body,
      source: "agent",
      callsite: "workflows.tracking-mirror.update",
      log: logger,
      post: async (cleanBody) => {
        await assertAttempt(attempt);
        return octokit.rest.issues.updateComment({
          owner: row.target_owner,
          repo: row.target_repo,
          comment_id: commentId,
          body: cleanBody,
        });
      },
    });
    resultRow = row;
  }

  // Cascade: when this run is a child of a composite (e.g., ship), refresh
  // the parent's tracking comment so the user sees this child's status
  // reflected on the parent's comment in real time. Best-effort: a cascade
  // failure must never bubble up because the child's own write already
  // succeeded.
  if (resultRow.parent_run_id !== null) {
    await refreshParentCompositeBody(deps, resultRow.parent_run_id, attempt).catch(
      (err: unknown) => {
        if (err instanceof StaleWorkflowAttemptError) throw err;
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            parentRunId: resultRow.parent_run_id,
            childRunId: runId,
          },
          "Cascade refresh of parent composite body failed",
        );
      },
    );
  }

  return resultRow;
}

/**
 * Re-run hygiene: delete the tracking comment(s) left by earlier terminal
 * runs of the same (workflow, target) so re-running a workflow replaces its
 * output comment instead of piling a new one alongside the stale ones.
 *
 * Best-effort end to end: a DB error or a delete error is logged and
 * swallowed, it must never block the new run's own comment. A run equal to
 * the current run's `parent_run_id` is skipped so a child run can never
 * delete a live composite parent's comment (defence-in-depth, the
 * same-`workflow_name` scoping in `findPriorTrackingComments` already
 * excludes the parent).
 */
async function cleanupPriorTrackingComments(
  deps: TrackingMirrorDeps,
  row: WorkflowRunRow,
  attempt: WorkflowAttempt | undefined,
): Promise<void> {
  const { octokit, logger } = deps;
  try {
    const priors = await findPriorTrackingComments(
      row.workflow_name,
      { owner: row.target_owner, repo: row.target_repo, number: row.target_number },
      row.id,
    );
    for (const prior of priors) {
      if (prior.runId === row.parent_run_id) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await assertAttempt(attempt);
        await octokit.rest.issues.deleteComment({
          owner: row.target_owner,
          repo: row.target_repo,
          comment_id: prior.trackingCommentId,
        });
        // Clear the prior row's id so a future re-run does not re-list and
        // re-attempt a 404 delete on this already-removed comment.
        // eslint-disable-next-line no-await-in-loop
        if (attempt === undefined) await clearTrackingCommentId(prior.runId);
        // eslint-disable-next-line no-await-in-loop
        else await clearTrackingCommentIdForAttempt(prior.runId, attempt);
        logger.info(
          {
            runId: row.id,
            priorRunId: prior.runId,
            commentId: prior.trackingCommentId,
            workflowName: row.workflow_name,
          },
          "Deleted prior-run tracking comment on workflow re-run",
        );
      } catch (err) {
        if (err instanceof StaleWorkflowAttemptError) throw err;
        logger.warn(
          {
            runId: row.id,
            priorRunId: prior.runId,
            commentId: prior.trackingCommentId,
            err: err instanceof Error ? err.message : String(err),
          },
          "Failed to delete prior-run tracking comment, continuing",
        );
      }
    }
  } catch (err) {
    if (err instanceof StaleWorkflowAttemptError) throw err;
    logger.warn(
      { runId: row.id, err: err instanceof Error ? err.message : String(err) },
      "Prior tracking-comment lookup failed, skipping re-run cleanup",
    );
  }
}

/**
 * First-touch path for a run that has no `tracking_comment_id` yet. Three
 * stages so we never leave duplicate comments behind:
 *
 *   1. Pre-scan via `findCommentsByMarker`: recovers from a prior crash or
 *      reschedule that committed a comment server-side without writing the
 *      CAS reservation. Adopting the orphan also avoids a wasted POST.
 *   2. POST `createComment`. Octokit v5 ships with `@octokit/plugin-retry`
 *      enabled, which retries POSTs on transient 5xx; if the server already
 *      committed before the timeout, retries duplicate the comment. We
 *      catch the create error so reconciliation can still run.
 *   3. Post-create scan: re-list and adopt the OLDEST marker comment, delete
 *      any extras (octokit retries OR a concurrent racer). The losing comments
 *      are deleted best-effort: the CAS guarantees one canonical id wins.
 */
async function createOrAdoptTrackingComment(
  deps: TrackingMirrorDeps,
  row: WorkflowRunRow,
  body: string,
  humanMessage: string,
  attempt: WorkflowAttempt | undefined,
): Promise<WorkflowRunRow> {
  const { octokit, logger } = deps;
  const runId = row.id;

  const adopted = await tryAdoptExistingMarkerComment(deps, row, humanMessage, attempt);
  if (adopted !== null) return adopted;

  let createErr: unknown = null;
  try {
    const guarded = await safePostToGitHub({
      body,
      source: "agent",
      callsite: "workflows.tracking-mirror.create",
      log: deps.logger,
      post: async (cleanBody) => {
        await assertAttempt(attempt);
        return octokit.rest.issues.createComment({
          owner: row.target_owner,
          repo: row.target_repo,
          issue_number: row.target_number,
          body: cleanBody,
        });
      },
    });
    // safePostToGitHub returns posted:false when the body is emptied by
    // secret redaction. Surface that as a synthetic createErr so the
    // post-scan branch below produces a clear failure instead of silently
    // dropping the create and falling through to the misleading
    // "createComment returned no row" path.
    if (!guarded.posted) {
      createErr = new Error(
        `workflows.tracking-mirror.create: post skipped after secret redaction (matchCount=${guarded.matchCount}, reason=${guarded.reason ?? "unknown"})`,
      );
    }
  } catch (err) {
    createErr = err;
  }

  // Re-scan after create. This is the load-bearing step: it covers
  // octokit-internal retry duplicates AND concurrent setState racers in
  // one branch. The pre-scan above is a fast-path optimisation; this
  // post-scan is the correctness backstop.
  const matches = await findCommentsByMarker(deps, row);
  if (matches.length === 0) {
    if (createErr !== null) {
      // Re-wrap so the linter's only-throw-error rule sees an Error
      // instance, but preserve the original via `cause` for stack traces.
      const wrapped = createErr instanceof Error ? createErr : new Error("createComment failed");
      if (!(createErr instanceof Error)) {
        (wrapped as Error & { cause?: unknown }).cause = createErr;
      }
      throw wrapped;
    }
    throw new Error(
      `tracking-mirror.createOrAdoptTrackingComment: createComment returned no row and post-create scan found no marker for run ${runId}`,
    );
  }

  const candidate = matches[0];
  if (candidate === undefined) {
    throw new Error(
      `tracking-mirror.createOrAdoptTrackingComment: marker scan length>0 but first element undefined (run ${runId})`,
    );
  }

  // CAS must run BEFORE delete: otherwise a concurrent racer that already
  // reserved a different comment id (e.g. one of our `losers`) would see
  // its canonical comment silently deleted by us. After CAS, the canonical
  // id is whatever the row holds, every other marker comment is a true
  // duplicate and safe to delete.
  const reservation =
    attempt === undefined
      ? await tryReserveTrackingCommentId(runId, candidate.id)
      : await tryReserveTrackingCommentId(runId, candidate.id, attempt);
  const winningId = reservation.trackingCommentId;
  const losers = matches.filter((m) => m.id !== winningId);

  if (losers.length > 0 || createErr !== null) {
    logger.warn(
      {
        runId,
        winnerCommentId: winningId,
        loserCount: losers.length,
        createErr: createErr instanceof Error ? createErr.message : null,
        workflowName: row.workflow_name,
      },
      "Reconciling duplicate tracking comments, adopting CAS winner, deleting extras",
    );
  }

  for (const loser of losers) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await assertAttempt(attempt);
      await octokit.rest.issues.deleteComment({
        owner: row.target_owner,
        repo: row.target_repo,
        comment_id: loser.id,
      });
    } catch (deleteErr) {
      if (deleteErr instanceof StaleWorkflowAttemptError) throw deleteErr;
      logger.warn(
        {
          runId,
          loserCommentId: loser.id,
          err: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
        },
        "Failed to delete duplicate tracking comment",
      );
    }
  }

  if (reservation.won) {
    logger.info(
      { runId, commentId: winningId, workflowName: row.workflow_name },
      "Created tracking comment",
    );
  }

  // Re-render against the freshest row so a concurrent racer's newer
  // human message survives. `_lastHumanMessage` is merged before this
  // function runs, so the post-merge view already contains it.
  const latest = (await findById(runId)) ?? row;
  await safePostToGitHub({
    body: renderCommentBody(latest, humanMessage),
    source: "agent",
    callsite: "workflows.tracking-mirror.post-create-update",
    log: deps.logger,
    post: async (cleanBody) => {
      await assertAttempt(attempt);
      return octokit.rest.issues.updateComment({
        owner: latest.target_owner,
        repo: latest.target_repo,
        comment_id: winningId,
        body: cleanBody,
      });
    },
  });
  return { ...latest, tracking_comment_id: winningId };
}

/**
 * Pre-create adoption path: if a previous attempt already wrote a comment
 * carrying our marker (crash before CAS, octokit retry, etc.), reuse it
 * instead of POSTing a new one. Returns null when no marker is found, which
 * is the steady-state happy path on a fresh run.
 */
async function tryAdoptExistingMarkerComment(
  deps: TrackingMirrorDeps,
  row: WorkflowRunRow,
  humanMessage: string,
  attempt: WorkflowAttempt | undefined,
): Promise<WorkflowRunRow | null> {
  const { octokit, logger } = deps;
  const matches = await findCommentsByMarker(deps, row);
  if (matches.length === 0) return null;

  const candidate = matches[0];
  if (candidate === undefined) return null;

  // CAS first, delete after, see createOrAdoptTrackingComment for the
  // race that justifies this ordering. The reservation determines the
  // canonical id; every non-canonical marker comment is then deleted.
  const reservation =
    attempt === undefined
      ? await tryReserveTrackingCommentId(row.id, candidate.id)
      : await tryReserveTrackingCommentId(row.id, candidate.id, attempt);
  const winningId = reservation.trackingCommentId;
  const losers = matches.filter((m) => m.id !== winningId);

  logger.warn(
    {
      runId: row.id,
      winnerCommentId: winningId,
      loserCount: losers.length,
      workflowName: row.workflow_name,
    },
    "Pre-scan found existing tracking comment(s) for run, adopting CAS winner",
  );

  for (const loser of losers) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await assertAttempt(attempt);
      await octokit.rest.issues.deleteComment({
        owner: row.target_owner,
        repo: row.target_repo,
        comment_id: loser.id,
      });
    } catch (deleteErr) {
      if (deleteErr instanceof StaleWorkflowAttemptError) throw deleteErr;
      logger.warn(
        {
          runId: row.id,
          loserCommentId: loser.id,
          err: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
        },
        "Failed to delete duplicate tracking comment during pre-scan adoption",
      );
    }
  }

  const latest = (await findById(row.id)) ?? row;
  await safePostToGitHub({
    body: renderCommentBody(latest, humanMessage),
    source: "agent",
    callsite: "workflows.tracking-mirror.adopt-update",
    log: deps.logger,
    post: async (cleanBody) => {
      await assertAttempt(attempt);
      return octokit.rest.issues.updateComment({
        owner: latest.target_owner,
        repo: latest.target_repo,
        comment_id: winningId,
        body: cleanBody,
      });
    },
  });
  return { ...latest, tracking_comment_id: winningId };
}

/**
 * Re-render the parent's tracking comment with this run's narrative plus a
 * verbose block per child step. No-op when the parent never created its own
 * comment (no `tracking_comment_id`): handlers that opted out cannot have
 * their comment refreshed.
 */
async function refreshParentCompositeBody(
  deps: TrackingMirrorDeps,
  parentRunId: string,
  attempt: WorkflowAttempt | undefined,
): Promise<void> {
  const { octokit } = deps;

  const parent = await findById(parentRunId);
  if (parent === null) return;
  if (parent.tracking_comment_id === null) return;

  const children = await listChildrenByParent(parentRunId);
  const body = renderCompositeBody(parent, children);
  const commentId = parent.tracking_comment_id;

  await safePostToGitHub({
    body,
    source: "agent",
    callsite: "workflows.tracking-mirror.composite-refresh",
    log: deps.logger,
    post: async (cleanBody) => {
      await assertAttempt(attempt);
      return octokit.rest.issues.updateComment({
        owner: parent.target_owner,
        repo: parent.target_repo,
        comment_id: commentId,
        body: cleanBody,
      });
    },
  });
}

/**
 * Composite render for a parent (e.g., ship) and its child steps. Verbose by
 * design: each child gets its own block with status, narrative, and a deep
 * link to the child's own tracking comment so the user can drill in.
 */
export function renderCompositeBody(
  parent: WorkflowRunRow,
  children: readonly WorkflowRunRow[],
): string {
  const parentMessage = readLastHumanMessage(parent);
  const parentBody = renderCommentBody(parent, parentMessage ?? "");

  if (children.length === 0) return parentBody;

  const childBlocks = children.map((child) => renderChildBlock(child)).join("\n\n");

  return `${parentBody}\n\n---\n\n## Steps\n\n${childBlocks}`;
}

function renderChildBlock(child: WorkflowRunRow): string {
  const emoji = statusEmoji(child.status);
  const link =
    child.tracking_comment_id !== null
      ? ` · [open comment](https://github.com/${child.target_owner}/${child.target_repo}/issues/${String(child.target_number)}#issuecomment-${String(child.tracking_comment_id)})`
      : "";

  const meta = renderChildMeta(child);
  const message = readLastHumanMessage(child);
  const messageBlock = message === null ? "" : `\n${truncateForComposite(message)}`;

  return `### ${emoji} \`${child.workflow_name}\`, ${child.status}${link}${meta}${messageBlock}`;
}

function readLastHumanMessage(row: WorkflowRunRow): string | null {
  const raw = row.state[LAST_HUMAN_MESSAGE_KEY];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function renderChildMeta(child: WorkflowRunRow): string {
  const cost = child.state["costUsd"];
  const turns = child.state["turns"];
  const parts: string[] = [];
  if (typeof cost === "number") parts.push(`cost: $${cost.toFixed(4)}`);
  if (typeof turns === "number") parts.push(`turns: ${String(turns)}`);
  return parts.length > 0 ? `\n_${parts.join(" · ")}_` : "";
}

function statusEmoji(status: WorkflowRunRow["status"]): string {
  switch (status) {
    case "queued":
      return "⏳";
    case "running":
      return "🔄";
    case "succeeded":
      return "✅";
    case "failed":
      return "❌";
    case "incomplete":
      return "⚠️";
  }
}

/**
 * The composite body sits inside one GitHub comment alongside the parent's
 * own narrative: keep each child's excerpt short so the comment stays
 * readable. Drill-in users follow the per-step link to read the full body.
 */
function truncateForComposite(text: string): string {
  const limit = 600;
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}…`;
}

/**
 * Dispatcher refusal helper: posts a one-off comment, no DB row needed.
 *
 * Best-effort: `createComment` failures are logged as warnings and swallowed,
 * mirroring the compensating-delete pattern above. The refusal comment is
 * purely cosmetic: the DB is already authoritative, so a transient GitHub
 * API blip must not bubble up into `dispatchByLabel` / `dispatchByIntent` and
 * surface as a webhook 500.
 *
 * `label` names what the user asked for. The dispatcher passes a registry
 * workflow name; the canonical ship rail passes a `CommandIntent`, since most
 * of its verbs are scoped actions with no registry entry and echoing
 * "unknown" back at someone who typed `bot:summarize` explains nothing.
 */
export async function postRefusalComment(
  deps: TrackingMirrorDeps,
  target: { owner: string; repo: string; number: number },
  workflowName: WorkflowName | CommandIntent | "unknown",
  reason: string,
): Promise<void> {
  const body = `**bot workflow \`${workflowName}\`** refused: ${reason}`;
  try {
    await safePostToGitHub({
      body,
      source: "agent",
      callsite: "workflows.tracking-mirror.postRefusalComment",
      log: deps.logger,
      post: (cleanBody) =>
        deps.octokit.rest.issues.createComment({
          owner: target.owner,
          repo: target.repo,
          issue_number: target.number,
          body: cleanBody,
        }),
    });
    deps.logger.info({ target, workflowName, reason }, "Posted workflow refusal comment");
  } catch (err) {
    deps.logger.warn(
      { target, workflowName, reason, err: err instanceof Error ? err.message : String(err) },
      "Failed to post workflow refusal comment, refusal remains authoritative in the DB",
    );
  }
}
