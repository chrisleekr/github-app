/**
 * Pure duplicate-detection for the inline-comment MCP server.
 *
 * Split out of `inline-comment.ts` because that module self-starts (it exits
 * the process on missing env and connects a stdio transport at import), so its
 * logic cannot be imported by a test. Same split as `repo-memory-actions.ts`.
 *
 * Why this exists: `review` can be auto-triggered on every push (work item #1),
 * and each finding is posted as its own review thread. Without a check, the same
 * unfixed finding gets a fresh thread per run. GitHub does not mark those
 * outdated, because each anchors to the new head SHA, and ship's merge gate
 * counts unresolved-and-not-outdated threads, so duplicates block merges.
 */

import { type GithubActorLike, isSelfActor } from "../../utils/github-actor";

/** The fields of a review comment this matcher reads. */
export interface ExistingComment {
  readonly path?: string | undefined;
  /** Null once the line has moved, i.e. GitHub considers the comment outdated. */
  readonly line?: number | null | undefined;
  readonly side?: string | null | undefined;
  readonly user?: GithubActorLike | null | undefined;
  /** Set only on replies. A reply is never an independent finding. */
  readonly in_reply_to_id?: number | undefined;
}

/**
 * True when we already have a live comment at this exact location.
 *
 * Matched by location, not body text: the agent rewords the same finding between
 * runs, so a body hash would never match. Two consequences, both intended:
 *
 *   - A genuinely different second finding on an already-commented line is
 *     suppressed. The prompt asks for one comment per finding on the most
 *     relevant single line, so this is rare and the quieter failure.
 *
 * What happens to an outdated comment (one whose code has since moved) is
 * deliberately NOT relied on here. The REST reference documents no nulling rule
 * for `line`, and the vendored OpenAPI types make `line` non-nullable while
 * `start_line` IS nullable, so the two readings disagree. If GitHub nulls it the
 * finding is re-reported on its new line; if it does not, the finding stays
 * suppressed while that thread lives. Both are acceptable; neither is asserted.
 * Switching to GraphQL `PullRequestReviewThread.isOutdated` would settle it.
 */
export function hasDuplicateAt(
  existing: readonly ExistingComment[],
  target: { readonly path: string; readonly line: number; readonly side: string },
  selfLogin: string | null,
): boolean {
  return existing.some(
    (c) =>
      // Top-level only. The bot also replies inside humans' threads (fix-thread,
      // chat-thread), and those replies carry their thread's location, so
      // counting them would let one bot reply on `foo.ts:42` permanently
      // suppress a genuine later finding on that line. Same distinction
      // `resolve.ts` draws with `in_reply_to_id === undefined`.
      c.in_reply_to_id === undefined &&
      c.path === target.path &&
      c.line === target.line &&
      c.side === target.side &&
      isSelfActor(c.user, selfLogin),
  );
}
