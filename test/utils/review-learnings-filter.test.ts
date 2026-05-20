/**
 * Unit tests for src/utils/review-learnings-filter.ts. Pure functions only:
 * no I/O, no DB. Covers picomatch filter semantics, glob safety, the byte-
 * budgeted renderer (1.5.G), and per-row truncation.
 */

import { describe, expect, it } from "bun:test";

import {
  type AppliedReviewLearning,
  isSafeGlob,
  pickApplicableLearnings,
  renderReviewLearningsBlock,
} from "../../src/utils/review-learnings-filter";

function makeLearning(
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

describe("isSafeGlob", () => {
  it("accepts common globs", () => {
    expect(isSafeGlob("test/**/*.test.ts")).toBe(true);
    expect(isSafeGlob("src/**/{a,b,c}/*.ts")).toBe(true);
    expect(isSafeGlob("**/*.md")).toBe(true);
    expect(isSafeGlob("foo.txt")).toBe(true);
  });

  it("rejects empty and length-exceeding strings", () => {
    expect(isSafeGlob("")).toBe(false);
    expect(isSafeGlob("a".repeat(501))).toBe(false);
  });

  it("rejects globs with too many alternations", () => {
    // 9 commas -> 9 alternations, exceeds GLOB_MAX_ALTERNATIONS=8
    expect(isSafeGlob("{a,b,c,d,e,f,g,h,i,j}")).toBe(false);
  });

  it("rejects globs with too many groups", () => {
    // 7 group openings, exceeds GLOB_MAX_GROUPS=6
    expect(isSafeGlob("{a}{b}{c}{d}{e}{f}{g}")).toBe(false);
  });

  it("rejects globs with too many stars", () => {
    expect(isSafeGlob("*".repeat(33))).toBe(false);
  });
});

describe("pickApplicableLearnings", () => {
  it("returns [] for undefined or empty input", () => {
    expect(pickApplicableLearnings(undefined, ["a.ts"])).toEqual([]);
    expect(pickApplicableLearnings([], ["a.ts"])).toEqual([]);
  });

  it("with empty changedFiles, returns only null-glob (repo-wide) rows", () => {
    const learnings = [
      makeLearning({ id: "1", directive: "always", fileGlob: null }),
      makeLearning({ id: "2", directive: "tests", fileGlob: "test/**/*.test.ts" }),
    ];
    const out = pickApplicableLearnings(learnings, []);
    expect(out.map((l) => l.id)).toEqual(["1"]);
  });

  it("with matching changedFiles, includes glob-scoped rows that match", () => {
    const learnings = [
      makeLearning({ id: "1", directive: "tests", fileGlob: "test/**/*.test.ts" }),
      makeLearning({ id: "2", directive: "src", fileGlob: "src/**/*.ts" }),
    ];
    const out = pickApplicableLearnings(learnings, ["test/foo.test.ts"]);
    expect(out.map((l) => l.id)).toEqual(["1"]);
  });

  it("excludes glob-scoped rows whose glob does NOT match any changed file", () => {
    const learnings = [
      makeLearning({ id: "1", directive: "tests", fileGlob: "test/**/*.test.ts" }),
    ];
    expect(pickApplicableLearnings(learnings, ["src/app.ts"])).toEqual([]);
  });

  it("drops rows with pathological globs (isSafeGlob defense)", () => {
    const learnings = [
      makeLearning({ id: "bad", directive: "evil", fileGlob: "*".repeat(33) }),
      makeLearning({ id: "ok", directive: "good", fileGlob: "src/**/*.ts" }),
    ];
    const out = pickApplicableLearnings(learnings, ["src/app.ts"]);
    expect(out.map((l) => l.id)).toEqual(["ok"]);
  });
});

describe("renderReviewLearningsBlock (1.5.G byte cap)", () => {
  it("returns empty result for empty input", () => {
    const r = renderReviewLearningsBlock("tag", []);
    expect(r.block).toBe("");
    expect(r.renderedCount).toBe(0);
    expect(r.omittedCount).toBe(0);
    expect(r.bytes).toBe(0);
  });

  it("renders all rows when total fits under 24KB cap", () => {
    const learnings = [
      makeLearning({
        id: "11111111-2222-3333-4444-555555555555",
        directive: "Do not flag intentional duplication in mock factories.",
        rationale: "Closures need the literal at module-evaluation time.",
        fileGlob: "test/**/*.test.ts",
        sourcePr: 79,
        sourceAuthor: "chrisleekr",
      }),
      makeLearning({
        id: "66666666-7777-8888-9999-aaaaaaaaaaaa",
        directive: "Allow `as const` casts in registries.",
        rationale: "TypeScript needs literal types for narrowing.",
      }),
    ];
    const r = renderReviewLearningsBlock("review_learnings_xyz", learnings);
    expect(r.renderedCount).toBe(2);
    expect(r.omittedCount).toBe(0);
    expect(r.block).toContain("<review_learnings_xyz>");
    expect(r.block).toContain("intentional duplication");
    expect(r.block).toContain("`as const` casts");
    expect(r.block).toContain("</review_learnings_xyz>");
    // No truncation marker.
    expect(r.block).not.toContain("older learning");
  });

  it("truncates entries past the 24KB byte budget and emits an omitted marker", () => {
    // Each row is ~1.5KB at this size; 30 rows = ~45KB, well over the 24KB cap.
    const bigRationale = "x".repeat(1400);
    const learnings: AppliedReviewLearning[] = [];
    for (let i = 0; i < 30; i++) {
      learnings.push(
        makeLearning({
          id: `id-${String(i).padStart(2, "0")}`,
          directive: `Directive number ${String(i)}.`,
          rationale: bigRationale,
        }),
      );
    }
    const r = renderReviewLearningsBlock("review_learnings", learnings);
    expect(r.renderedCount).toBeLessThan(30);
    expect(r.omittedCount).toBeGreaterThan(0);
    expect(r.renderedCount + r.omittedCount).toBe(30);
    expect(r.block).toContain("older learnings omitted");
    expect(r.block).toContain("get_review_learnings");
    expect(r.bytes).toBeGreaterThan(0);
    // Sanity: the rendered block must not far exceed the cap (allow header/footer/marker).
    expect(r.bytes).toBeLessThan(30_000);
  });

  it("applies per-row truncation when one learning exceeds the 2000-char row cap", () => {
    const oversized = makeLearning({
      id: "id-oversize",
      directive: "x".repeat(2500),
      rationale: "y".repeat(2500),
    });
    const r = renderReviewLearningsBlock("review_learnings", [oversized]);
    expect(r.renderedCount).toBe(1);
    // The row should be truncated below the 2000-char cap (with some leeway
    // for the surrounding block header/footer; cap is on the row content).
    // The "…" truncation marker must appear.
    expect(r.block).toContain("…");
    // The full original 2500-char directive should NOT be present verbatim.
    expect(r.block).not.toContain("x".repeat(2500));
  });

  it("singular vs plural in the omitted marker", () => {
    // Make one row big enough to occupy the entire budget so the next is the only omission.
    const big = "z".repeat(1900);
    const learnings: AppliedReviewLearning[] = [];
    for (let i = 0; i < 16; i++) {
      learnings.push(
        makeLearning({
          id: `id-${String(i)}`,
          directive: `Directive ${String(i)}`,
          rationale: big,
        }),
      );
    }
    const r = renderReviewLearningsBlock("review_learnings", learnings);
    // The seed deliberately overflows the byte budget; without an explicit
    // floor this case can pass vacuously if a future tuning lifts the cap.
    expect(r.omittedCount).toBeGreaterThan(0);
    if (r.omittedCount === 1) {
      expect(r.block).toContain("1 older learning omitted");
      expect(r.block).not.toContain("1 older learnings omitted");
    } else {
      expect(r.block).toContain(`${String(r.omittedCount)} older learnings omitted`);
    }
  });
});
