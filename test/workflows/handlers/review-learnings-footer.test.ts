/**
 * Tests for the `🧠 Learnings used` footer (1.5.B).
 *
 * Two concerns:
 *   1. The renderer itself produces the expected shape (provenance + per-entry
 *      fenced block + collapsible summary).
 *   2. The footer text, when posted via `safePostToGitHub`, gets any leaked
 *      secret stripped before it reaches GitHub. This is the load-bearing
 *      output-side invariant from CLAUDE.md § "Output secret-strip chokepoint",
 *      made explicit for the new footer surface.
 */

import { describe, expect, it } from "bun:test";
import pino from "pino";

import { safePostToGitHub } from "../../../src/utils/github-output-guard";
import type { AppliedReviewLearning } from "../../../src/utils/review-learnings-filter";
import { renderReviewLearningsFooter } from "../../../src/workflows/handlers/review-learnings-footer";

const log = pino({ level: "fatal" });

function makeApplied(
  overrides: Partial<AppliedReviewLearning> & Pick<AppliedReviewLearning, "id" | "directive">,
): AppliedReviewLearning {
  return {
    scope: "local",
    fileGlob: null,
    rationale: null,
    sourcePr: null,
    sourceThread: null,
    sourceAuthor: null,
    ...overrides,
  };
}

describe("renderReviewLearningsFooter", () => {
  it("returns empty string for undefined / empty input", () => {
    expect(renderReviewLearningsFooter(undefined)).toBe("");
    expect(renderReviewLearningsFooter([])).toBe("");
  });

  it("includes provenance fields and collapsible summary", () => {
    const footer = renderReviewLearningsFooter([
      makeApplied({
        id: "11111111-2222-3333-4444-555555555555",
        directive: "Do not flag X.",
        rationale: "Y is intentional.",
        fileGlob: "src/**/*.ts",
        scope: "local",
        sourcePr: 79,
        sourceAuthor: "chrisleekr",
        createdAt: "2026-05-19T10:00:00.000Z",
      }),
    ]);
    expect(footer).toContain("<details>");
    expect(footer).toContain("🧠 Learnings used (1)");
    expect(footer).toContain("From:      chrisleekr");
    expect(footer).toContain("Source:    #79");
    expect(footer).toContain("Scope:     local");
    expect(footer).toContain("File glob: src/**/*.ts");
    expect(footer).toContain("Recorded:  2026-05-19");
    expect(footer).toContain("Directive: Do not flag X.");
    expect(footer).toContain("Why:       Y is intentional.");
    expect(footer).toContain("</details>");
  });

  it("renders fallback strings when provenance fields are null", () => {
    const footer = renderReviewLearningsFooter([
      makeApplied({ id: "id-unknown", directive: "Allow Z." }),
    ]);
    expect(footer).toContain("From:      (unknown)");
    expect(footer).toContain("Source:    (unknown source)");
    expect(footer).toContain("Recorded:  (unknown)");
    expect(footer).toContain("Why:       (not recorded)");
  });
});

describe("footer + safePostToGitHub secret-redaction (1.5.B)", () => {
  it("strips a ghp_ token planted in a directive before posting", async () => {
    const tok = `ghp_${"A".repeat(36)}`;
    const footer = renderReviewLearningsFooter([
      makeApplied({
        id: "id-with-token",
        directive: `Old credential ${tok} must not be flagged.`,
        rationale: "Pre-rotation grandfathered.",
        sourcePr: 1,
        sourceAuthor: "chrisleekr",
      }),
    ]);
    // Sanity: the token would be present in the unredacted body.
    expect(footer).toContain(tok);

    // Capture what would actually be posted to GitHub.
    let postedBody: string | undefined;
    const result = await safePostToGitHub({
      body: footer,
      source: "system",
      callsite: "test:review-learnings-footer",
      log,
      post: (cleanBody) => {
        postedBody = cleanBody;
        return Promise.resolve({ ok: true });
      },
    });

    expect(result.posted).toBe(true);
    expect(result.matchCount).toBeGreaterThan(0);
    expect(result.kinds).toContain("GITHUB_TOKEN");
    expect(postedBody).toBeDefined();
    expect(postedBody).not.toContain(tok);
    // Sanity: surrounding non-secret content survives redaction.
    expect(postedBody).toContain("Old credential");
    expect(postedBody).toContain("must not be flagged");
  });

  it("does not skip the post for ordinary directive content (matchCount=0)", async () => {
    const footer = renderReviewLearningsFooter([
      makeApplied({
        id: "id-benign",
        directive: "Allow inline literals in test factories.",
        rationale: "Module-evaluation timing.",
      }),
    ]);
    let posted = false;
    const result = await safePostToGitHub({
      body: footer,
      source: "system",
      callsite: "test:review-learnings-footer-benign",
      log,
      post: () => {
        posted = true;
        return Promise.resolve({ ok: true });
      },
    });
    expect(result.posted).toBe(true);
    expect(result.matchCount).toBe(0);
    expect(posted).toBe(true);
  });
});
