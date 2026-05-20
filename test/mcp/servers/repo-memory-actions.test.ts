/**
 * Unit tests for src/mcp/servers/repo-memory-actions.ts: the pure builders +
 * file round-trip that back the repo_memory MCP server tools. Exercises:
 *
 *   - sanitisation invariants (issue #112): HTML comments, BIDI markers,
 *     GitHub tokens, control chars all stripped before write.
 *   - snake_case → camelCase normalisation for save_review_learning input.
 *   - empty-after-sanitise short-circuit (no scratch-file write, ok:false).
 *   - .daemon-actions.json round-trip via append → read → append → read.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  appendActionToPath,
  buildSaveAction,
  buildSaveReviewLearningAction,
  readActionsFromPath,
} from "../../../src/mcp/servers/repo-memory-actions";

describe("buildSaveAction (1.5.A)", () => {
  it("sanitises HTML comments out of content before save", () => {
    const result = buildSaveAction({
      category: "setup",
      content: "real value <!-- attacker note -->",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.type).toBe("save");
      expect(result.action.category).toBe("setup");
      expect(result.action.content).not.toContain("<!--");
      expect(result.action.content).toContain("real value");
    }
  });

  it("redacts GitHub token shapes inside content", () => {
    const tok = `ghp_${"A".repeat(36)}`;
    const result = buildSaveAction({ category: "env", content: `uses ${tok}` });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.content).not.toContain(tok);
      expect(result.action.content).toContain("[REDACTED_GITHUB_TOKEN]");
    }
  });

  it("returns ok=false with reason=empty_after_sanitize for HTML-only content", () => {
    const result = buildSaveAction({ category: "setup", content: "<!-- only -->" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("empty_after_sanitize");
    }
  });

  it("returns ok=false for invisible-only content (BIDI + zero-width)", () => {
    // U+202E (right-to-left override) + U+200B (zero-width space)
    const result = buildSaveAction({ category: "setup", content: "‮​" });
    expect(result.ok).toBe(false);
  });
});

describe("buildSaveReviewLearningAction (1.5.A)", () => {
  it("builds a minimal action when only directive is supplied", () => {
    const result = buildSaveReviewLearningAction({ directive: "Do not flag X." });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.type).toBe("save_learning");
      expect(result.action.directive).toBe("Do not flag X.");
      // No optional fields should be present.
      expect(result.action.rationale).toBeUndefined();
      expect(result.action.fileGlob).toBe(undefined);
      expect(result.action.scope).toBe(undefined);
      expect(result.action.sourcePr).toBe(undefined);
      expect(result.action.sourceThread).toBe(undefined);
      expect(result.action.sourceAuthor).toBe(undefined);
    }
  });

  it("normalises snake_case inputs to camelCase action fields", () => {
    const result = buildSaveReviewLearningAction({
      directive: "Mocks may inline literals.",
      rationale: "Module-evaluation timing.",
      file_glob: "test/**/*.test.ts",
      scope: "local",
      source_pr: 79,
      source_thread: "review_comment:123",
      source_author: "chrisleekr",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.directive).toBe("Mocks may inline literals.");
      expect(result.action.rationale).toBe("Module-evaluation timing.");
      expect(result.action.fileGlob).toBe("test/**/*.test.ts");
      expect(result.action.scope).toBe("local");
      expect(result.action.sourcePr).toBe(79);
      expect(result.action.sourceThread).toBe("review_comment:123");
      expect(result.action.sourceAuthor).toBe("chrisleekr");
    }
  });

  it("sanitises poisoned directive (HTML comment) before writing", () => {
    const result = buildSaveReviewLearningAction({
      directive: "real directive <!-- attacker -->",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.directive).not.toContain("<!--");
      expect(result.action.directive).toContain("real directive");
    }
  });

  it("redacts GitHub tokens embedded in directive", () => {
    const tok = `ghp_${"A".repeat(36)}`;
    const result = buildSaveReviewLearningAction({ directive: `Use ${tok} for X.` });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.directive).not.toContain(tok);
      expect(result.action.directive).toContain("[REDACTED_GITHUB_TOKEN]");
    }
  });

  it("returns ok=false when directive collapses to empty post-sanitise", () => {
    const result = buildSaveReviewLearningAction({ directive: "<!-- only -->​" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("empty_after_sanitize");
    }
  });

  it("drops optional fields that sanitise to empty", () => {
    const result = buildSaveReviewLearningAction({
      directive: "valid directive",
      rationale: "<!-- nothing -->",
      file_glob: "",
      source_thread: "​",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.rationale).toBe(undefined);
      expect(result.action.fileGlob).toBe(undefined);
      expect(result.action.sourceThread).toBe(undefined);
    }
  });
});

describe(".daemon-actions.json file round-trip (1.5.A)", () => {
  let workDir: string;
  let path: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "repo-memory-actions-test-"));
    path = join(workDir, ".daemon-actions.json");
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("readActionsFromPath returns [] for a missing file", () => {
    expect(readActionsFromPath(path)).toEqual([]);
  });

  it("appendActionToPath + readActionsFromPath preserve action shapes", () => {
    appendActionToPath(path, { type: "save", category: "setup", content: "bun install" });
    appendActionToPath(path, { type: "delete", id: "abc-123" });
    appendActionToPath(path, {
      type: "save_learning",
      directive: "Allow X.",
      fileGlob: "src/**/*.ts",
      scope: "local",
    });
    appendActionToPath(path, { type: "delete_learning", id: "def-456" });

    const actions = readActionsFromPath(path);
    expect(actions.length).toBe(4);
    expect(actions[0]).toEqual({ type: "save", category: "setup", content: "bun install" });
    expect(actions[1]).toEqual({ type: "delete", id: "abc-123" });
    expect(actions[2]).toEqual({
      type: "save_learning",
      directive: "Allow X.",
      fileGlob: "src/**/*.ts",
      scope: "local",
    });
    expect(actions[3]).toEqual({ type: "delete_learning", id: "def-456" });
  });

  it("readActionsFromPath returns [] on corrupted JSON", () => {
    // Write a corrupted file directly.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- temp test path
    writeFileSync(path, "{ not valid json");
    expect(readActionsFromPath(path)).toEqual([]);
  });
});
