import type { AppliedReviewLearning } from "../../utils/review-learnings-filter";

/**
 * Render the `🧠 Learnings used` collapsible footer appended to review /
 * resolve tracking comments. Discloses every learning that informed the run
 * with full provenance (source PR, author, file glob, timestamp).
 *
 * Empty input yields an empty string so the caller can spread the result
 * unconditionally. Newly-saved learnings (from `save_review_learning`) are
 * NOT included here because the persistence happens orchestrator-side after
 * the daemon emits the result; the next review will surface them.
 *
 * The block emits one fenced code section per learning so the layout stays
 * diffable and copy-pasteable, mirroring how operators read CI log blocks.
 */
export function renderReviewLearningsFooter(
  applied: readonly AppliedReviewLearning[] | undefined,
): string {
  if (applied === undefined || applied.length === 0) return "";

  const entries: string[] = [];
  let omitted = 0;
  let runningChars = 0;

  for (const l of applied) {
    const entry = renderEntry(l);
    if (runningChars + entry.length > FOOTER_BODY_BUDGET_CHARS && entries.length > 0) {
      omitted = applied.length - entries.length;
      break;
    }
    entries.push(entry);
    runningChars += entry.length;
  }

  const truncationMarker =
    omitted > 0
      ? `\n\n… ${String(omitted)} more learning${omitted === 1 ? "" : "s"} omitted to keep the comment within GitHub's size limit.`
      : "";

  return `\n\n<details>\n<summary>🧠 Learnings used (${String(applied.length)})</summary>\n\n${entries.join("\n\n")}${truncationMarker}\n\n</details>`;
}

// GitHub caps comment bodies at ~65536 chars. The tracking comment carries
// the agent's full reply ahead of this footer, so leave ample headroom and
// budget the footer body at 12000 chars.
const FOOTER_BODY_BUDGET_CHARS = 12_000;

function renderEntry(l: AppliedReviewLearning): string {
  const source = formatSource(l.sourcePr);
  const author = l.sourceAuthor ?? "(unknown)";
  const glob = l.fileGlob ?? "*";
  const rationale = l.rationale ?? "(not recorded)";
  const recorded = formatRecorded(l.createdAt);
  // Escape any literal triple-backtick inside the directive / rationale so
  // a stray fence in user-recorded text cannot break the surrounding fenced
  // block. Author / glob / source / recorded are bounded shapes and don't
  // need the escape.
  const directive = escapeFence(l.directive);
  const rationaleSafe = escapeFence(rationale);
  return [
    "```",
    `From:      ${author}`,
    `Source:    ${source}`,
    `Scope:     ${l.scope}`,
    `File glob: ${glob}`,
    `Recorded:  ${recorded}`,
    `Directive: ${directive}`,
    `Why:       ${rationaleSafe}`,
    "```",
  ].join("\n");
}

// Replace triple-backticks with an escaped variant that renders verbatim
// (zero-width breaker between the second and third backtick).
function escapeFence(text: string): string {
  return text.replace(/```/g, "``​`");
}

/**
 * Format a source-PR reference. Split out so the `prefer-nullish-coalescing`
 * rule's preferred shape (`??`) cannot apply: the PR number and the fallback
 * string differ structurally, not just by nullness.
 */
function formatSource(sourcePr: number | null): string {
  if (sourcePr === null) return "(unknown source)";
  return `#${String(sourcePr)}`;
}

/**
 * Format the "Recorded:" timestamp line. ISO strings from the DB are kept
 * compact (YYYY-MM-DD) so the footer stays scannable; full precision lives
 * in the DB row if anyone needs it.
 */
function formatRecorded(createdAt: string | undefined): string {
  if (createdAt === undefined) return "(unknown)";
  // Take the leading YYYY-MM-DD portion of an ISO 8601 timestamp. Defensive
  // slice in case the orchestrator hands back something unexpected.
  const date = createdAt.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : createdAt;
}
