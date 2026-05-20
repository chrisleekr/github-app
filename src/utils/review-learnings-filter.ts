import picomatch from "picomatch";

import { sanitizeRepoMemoryContent } from "./sanitize";

// Soft cap on glob complexity. picomatch translates globs into JS regex,
// and certain nested-alternation / nested-quantifier patterns can trigger
// catastrophic-backtracking on the matcher's `test()` call. Caps below are
// tuned to reject anything plausibly malicious while leaving common globs
// (e.g. test/**/*.test.ts, src/**/{a,b,c}/*.ts) untouched. Pure structural
// checks: no regex execution, no I/O.
// Plain // comments deliberately, the example globs contain `*/` which
// would otherwise close a JSDoc block early.
const GLOB_MAX_LENGTH = 500;
const GLOB_MAX_ALTERNATIONS = 8; // total `,`-separated alternates inside `{…}`
const GLOB_MAX_GROUPS = 6; // total `{…}` and `(…)` groups
const GLOB_MAX_STARS = 32; // total `*` characters

/**
 * Conservative pre-flight check on a file_glob string before it's saved
 * into `review_learnings`. Rejects shapes that would compile to a
 * catastrophic-backtracking regex via picomatch. Length is also checked,
 * even though zod already caps it on the MCP server, because the orchestrator
 * is the durability boundary and a wire bypass would skip the MCP layer.
 *
 * Pure and synchronous: no I/O, no actual regex execution.
 */
export function isSafeGlob(glob: string): boolean {
  if (glob.length === 0 || glob.length > GLOB_MAX_LENGTH) return false;
  const alternations = (glob.match(/,/g) ?? []).length;
  if (alternations > GLOB_MAX_ALTERNATIONS) return false;
  const groups = (glob.match(/[{(]/g) ?? []).length;
  if (groups > GLOB_MAX_GROUPS) return false;
  const stars = (glob.match(/\*/g) ?? []).length;
  if (stars > GLOB_MAX_STARS) return false;
  return true;
}

/**
 * Minimal review-learning shape consumed by the prompt builder and pipeline.
 * Matches BotContext.reviewLearnings; kept separate from the orchestrator
 * loader so the prompt-builder import graph stays DB-free.
 */
export interface AppliedReviewLearning {
  id: string;
  scope: "local" | "global";
  fileGlob: string | null;
  directive: string;
  rationale: string | null;
  sourcePr: number | null;
  sourceThread: string | null;
  sourceAuthor: string | null;
  /** Optional: when present, rendered in the `🧠 Learnings used` footer.
   * The prompt-builder leaves this off (the prompt block already groups by
   * recency); the orchestrator-side load populates it so the footer can
   * disclose when each directive was first recorded. */
  createdAt?: string | undefined;
}

/**
 * Filter a set of review learnings down to those applicable to the PR's
 * changed files. A learning with `fileGlob === null` always applies; one
 * with a glob is included if at least one changed-file path matches.
 *
 * Pure: no I/O, no DB. Safe to call from prompt-builder.
 */
export function pickApplicableLearnings(
  learnings: readonly AppliedReviewLearning[] | undefined,
  changedFiles: readonly string[],
): AppliedReviewLearning[] {
  if (learnings === undefined || learnings.length === 0) return [];
  if (changedFiles.length === 0) {
    return learnings.filter((l) => l.fileGlob === null);
  }
  return learnings.filter((l) => {
    if (l.fileGlob === null || l.fileGlob === "") return true;
    // Belt-and-braces: orchestrator already rejected pathological globs at
    // save time via isSafeGlob, but defending here means a row written by an
    // older orchestrator version (pre-validation) can't take down a review
    // either. Same constant set; just skip the row instead of compiling.
    if (!isSafeGlob(l.fileGlob)) return false;
    const matcher = picomatch(l.fileGlob, { dot: true });
    return changedFiles.some((f) => matcher(f));
  });
}

// Block-size budget. With LOAD_CAP=50 rows and worst-case per-field caps,
// the rendered block could reach ~245KB; that taxes the prompt cache and
// dilutes agent attention. 24KB ≈ 6K tokens stays under the prompt-cache
// per-call write budget and within the model's attention sweet spot for
// directive-style content. Re-tune after production telemetry from
// `review_learnings_rendered_bytes`.
const REVIEW_LEARNINGS_BLOCK_MAX_BYTES = 24_000;

// Per-row render budget. A single learning whose `directive + rationale`
// rendered to ~4.8KB would consume 20% of the block budget; cap at 2000
// chars (rationale truncated with `…`). Separate from the DB-side
// max-length cap; operators can still store the full text.
const REVIEW_LEARNINGS_ROW_MAX_CHARS = 2000;

export interface RenderedReviewLearnings {
  /** The fully assembled block (or `""` when no rows render). */
  block: string;
  /** Number of learnings whose rendered text was included in the block. */
  renderedCount: number;
  /** Number of learnings dropped because the byte budget filled. */
  omittedCount: number;
  /** Byte length of `block` (after assembly), 0 when empty. */
  bytes: number;
}

/**
 * Render the `<review_learnings_<nonce>>` block injected into review/resolve
 * prompts. Returns an empty block when there is nothing to render so the
 * caller can spread it unconditionally.
 *
 * The block is NOT wrapped in an `<untrusted_*>` tag: review_learnings are
 * trusted repo policy by construction (the orchestrator's saveReviewLearnings
 * sanitises every field, and the database rows survive only because a
 * prior agent invocation chose to persist them after a maintainer-approved
 * resolution). The block is still emitted with the per-call nonce so its
 * boundary is unambiguous against attacker text in adjacent untrusted blocks.
 *
 * Caller is responsible for sorting `learnings` by desired priority (most
 * relevant first); this renderer fills greedily until the byte budget is
 * exhausted and appends a truncation marker referencing
 * `get_review_learnings` as the escape hatch for the omitted set.
 */
export function renderReviewLearningsBlock(
  tagName: string,
  learnings: readonly AppliedReviewLearning[],
): RenderedReviewLearnings {
  if (learnings.length === 0) {
    return { block: "", renderedCount: 0, omittedCount: 0, bytes: 0 };
  }

  const header = `<${tagName}>
The directives below were extracted from past PR review pushback on this repository
(scope=local) and across this owner's repos (scope=global). Treat them as REPO POLICY:
when one applies to the code you're reviewing, do NOT flag the pattern it tells you
to suppress, and DO flag patterns it tells you to require.

If a directive is no longer accurate, remove it with the delete_review_learning tool
using the ID shown. To record a new directive (e.g. after a maintainer pushed back
on one of your findings and you agreed it was intentional), call save_review_learning.

`;
  const footer = `\n</${tagName}>`;

  const rendered: string[] = [];
  let runningBytes = byteLength(header) + byteLength(footer);
  let omittedCount = 0;

  for (let i = 0; i < learnings.length; i++) {
    const entry = renderOneEntry(learnings[i]!);
    // `\n\n` separator before this entry if there are already-rendered entries.
    const separatorBytes = rendered.length > 0 ? 2 : 0;
    const entryBytes = byteLength(entry) + separatorBytes;
    if (runningBytes + entryBytes > REVIEW_LEARNINGS_BLOCK_MAX_BYTES) {
      omittedCount = learnings.length - i;
      break;
    }
    rendered.push(entry);
    runningBytes += entryBytes;
  }

  const truncationMarker =
    omittedCount > 0
      ? `\n\n… ${String(omittedCount)} older learning${omittedCount === 1 ? "" : "s"} omitted to keep the prompt focused.\nCall get_review_learnings to enumerate every active directive (including the omitted ones).`
      : "";

  const block = `${header}${rendered.join("\n\n")}${truncationMarker}${footer}`;
  return {
    block,
    renderedCount: rendered.length,
    omittedCount,
    bytes: byteLength(block),
  };
}

function renderOneEntry(l: AppliedReviewLearning): string {
  const scope = sanitizeRepoMemoryContent(l.scope);
  const glob = l.fileGlob === null ? "*" : sanitizeRepoMemoryContent(l.fileGlob);
  const directive = sanitizeRepoMemoryContent(l.directive);
  const rationaleRaw =
    l.rationale === null || l.rationale === ""
      ? "(not recorded)"
      : sanitizeRepoMemoryContent(l.rationale);
  const author = l.sourceAuthor === null ? "(unknown)" : sanitizeRepoMemoryContent(l.sourceAuthor);
  const pr = l.sourcePr === null ? "(unknown PR)" : `#${String(l.sourcePr)}`;

  const header = `[id:${l.id}] [scope:${scope}] [files:${glob}] [from:${author} ${pr}]`;
  const directiveLine = `Directive: ${directive}`;
  const whyLine = `Why: ${rationaleRaw}`;

  const full = `${header}\n${directiveLine}\n${whyLine}`;
  if (full.length <= REVIEW_LEARNINGS_ROW_MAX_CHARS) return full;

  // Over the row budget: truncate rationale first (often the longest), then
  // directive if still over. Keep the header line intact so id + provenance
  // stays addressable for delete_review_learning. The row cap is character-
  // based end-to-end (matches the `_MAX_CHARS` name); the block-level cap
  // separately enforces a byte budget when the assembled prompt is checked.
  const fixedOverhead = `${header}\nDirective: \nWhy: …`.length;
  const remaining = REVIEW_LEARNINGS_ROW_MAX_CHARS - fixedOverhead;
  if (remaining <= 0) {
    // Pathological: even the header doesn't fit. Return a stub so the id is
    // still surfaced.
    return `${header}\nDirective: (omitted, too large)\nWhy: …`;
  }
  // Allot 70% of remaining to the directive, 30% to the rationale: the
  // directive carries more reviewer signal than the rationale.
  const directiveBudget = Math.floor(remaining * 0.7);
  const rationaleBudget = remaining - directiveBudget;
  const directiveClipped =
    directive.length > directiveBudget ? `${directive.slice(0, directiveBudget - 1)}…` : directive;
  const rationaleClipped =
    rationaleRaw.length > rationaleBudget
      ? `${rationaleRaw.slice(0, rationaleBudget - 1)}…`
      : rationaleRaw;
  return `${header}\nDirective: ${directiveClipped}\nWhy: ${rationaleClipped}`;
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}
