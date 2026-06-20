import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

// Source-assertion guard (non-brittle) that the six leak sites route Octokit
// error messages through `redactErrorMessage` before they reach the agent
// tool-result channel. import.meta.dir is test/mcp, so the repo root is two
// levels up. Assertions bind on the assignment form `= redactErrorMessage(`
// so an import line or a stray comment mentioning the helper cannot satisfy
// the check; only the actual catch-path usage does.
const repoRoot = join(import.meta.dir, "..", "..");
const ASSIGN = "= redactErrorMessage(";

function readSource(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), "utf8");
}

describe("error-redaction wiring", () => {
  it("comment.ts routes errors through redactErrorMessage", () => {
    expect(readSource("src/mcp/servers/comment.ts")).toContain(ASSIGN);
  });

  it("inline-comment.ts routes errors through redactErrorMessage", () => {
    expect(readSource("src/mcp/servers/inline-comment.ts")).toContain(ASSIGN);
  });

  it("github-state.ts routes errors through redactErrorMessage", () => {
    expect(readSource("src/mcp/servers/github-state.ts")).toContain(ASSIGN);
  });

  it("resolve-review-thread.ts routes errors through redactErrorMessage", () => {
    expect(readSource("src/mcp/servers/resolve-review-thread.ts")).toContain(ASSIGN);
  });

  it("merge-readiness.ts uses redactErrorMessage and drops the inline regex", () => {
    const src = readSource("src/mcp/servers/merge-readiness.ts");
    expect(src).toContain(ASSIGN);
    expect(src).not.toContain("x-access-token:");
  });

  it("state-fetchers.ts routes errors through redactErrorMessage", () => {
    expect(readSource("src/github/state-fetchers.ts")).toContain(ASSIGN);
  });
});
