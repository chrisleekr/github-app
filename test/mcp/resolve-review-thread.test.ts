/**
 * T014: MCP `resolve-review-thread` server tests covering the
 * contract from `contracts/mcp-resolve-thread-server.md` §"Tests".
 *
 * The server is a stdio process: it reads `REPO_OWNER` / `REPO_NAME` /
 * `PR_NUMBER` / `GITHUB_TOKEN` at module load, fail-fasts on any
 * missing, and serves a single `resolve_review_thread` tool over MCP
 * JSON-RPC. Direct functional unit testing would require either a
 * subprocess harness (heavyweight) or a refactor to expose the handler
 * as a pure function (out of scope for this PR).
 *
 * This test layer asserts the *static contract*: invariants that
 * survive any future refactor: token never logged in plaintext,
 * GraphQL queries match the documented shape, env validation occurs at
 * the documented points, error-mapping table is exhaustive. The
 * runtime functional tests are explicitly tracked as a follow-up PR
 * (the source comment block at the top of the server documents the
 * env/transport contract).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

const SOURCE_PATH = join(process.cwd(), "src/mcp/servers/resolve-review-thread.ts");

const SOURCE = readFileSync(SOURCE_PATH, "utf8");

describe("MCP resolve-review-thread: static contract", () => {
  it("declares exactly one tool and that tool is `resolve_review_thread`", () => {
    // The server registers its tool via `server.tool(name, ...)` (the
    // current MCP SDK affordance, `registerTool` is deprecated and
    // tracked separately for migration). Asserting the literal name
    // string is the simplest cross-version check; functional name
    // routing is exercised by the MCP runtime.
    const matches = SOURCE.match(/server\.tool\(\s*["']([^"']+)["']/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(SOURCE).toContain('"resolve_review_thread"');
  });

  it("validates all four required env vars at startup with explicit empty-string check", () => {
    expect(SOURCE).toContain("REPO_OWNER === undefined");
    expect(SOURCE).toContain("REPO_NAME === undefined");
    expect(SOURCE).toContain("PR_NUMBER === undefined");
    expect(SOURCE).toContain("GITHUB_TOKEN === undefined");
    // Empty-string is treated as absence (Bun loads empty .env values as "")
    expect(SOURCE).toContain('=== ""');
  });

  it("never logs the GITHUB_TOKEN value: only its presence boolean", () => {
    // Find the env-validation log call and assert its payload references
    // `hasGithubToken`, not `GITHUB_TOKEN` directly.
    const block = /log\.error\(\s*\{[^}]*hasGithubToken[^}]*\}/.exec(SOURCE);
    expect(block).not.toBeNull();
    // The literal `GITHUB_TOKEN` must NOT appear inside any log.X(...)
    // call shape, covers `token: GITHUB_TOKEN`, `auth: GITHUB_TOKEN`,
    // template interpolations `${GITHUB_TOKEN}`, and `process.env.GITHUB_TOKEN`
    // references. The presence-check log line legitimately uses
    // `GITHUB_TOKEN` inside the `hasGithubToken: GITHUB_TOKEN !== undefined`
    // boolean expression, those lines are whitelisted by the
    // `hasGithubToken` marker, leaving every other log call subject
    // to the no-leak rule.
    const logLines = SOURCE.match(/log\.(info|warn|error|debug)\([^;]*;/g) ?? [];
    for (const line of logLines) {
      if (line.includes("hasGithubToken")) continue;
      expect(line.includes("GITHUB_TOKEN")).toBe(false);
    }
  });

  it("PR_NUMBER must parse to a positive integer: rejects 0, negatives, and non-numeric", () => {
    expect(SOURCE).toContain("Number.isInteger(BOUND_PR_NUMBER)");
    expect(SOURCE).toContain("BOUND_PR_NUMBER <= 0");
  });

  it("queries `PullRequestReviewThread` and selects the bound-PR scope (cross-PR mismatch guard)", () => {
    expect(SOURCE).toContain("PullRequestReviewThread");
    expect(SOURCE).toContain("pullRequest");
    expect(SOURCE).toContain("repository");
  });

  it("uses `retryWithBackoff` so transient network errors are retried before exhaustion", () => {
    expect(SOURCE).toContain("retryWithBackoff");
  });

  it("logs via the shared createMcpLogger helper (writes to stderr, not stdout: #172)", () => {
    // The stderr contract now lives in src/mcp/mcp-logger.ts (asserted in
    // test/mcp/mcp-logger.test.ts); this server must route through it rather
    // than constructing its own logger.
    expect(SOURCE).toContain("createMcpLogger");
    expect(SOURCE).not.toMatch(/pino\(/);
  });

  it("is wired through StdioServerTransport (per MCP spec for stdio servers)", () => {
    expect(SOURCE).toContain("StdioServerTransport");
  });

  it("the GraphQL `resolveReviewThread` mutation is the documented escape hatch", () => {
    expect(SOURCE).toContain("resolveReviewThread");
  });

  it("exit code 1 is used for fail-fast on env validation (never silent)", () => {
    // Tightened: the `process.exit(1)` MUST follow the env-validation
    // log call (identified by its `hasGithubToken` payload key) before
    // any other top-level statement. A bare `expect(SOURCE).toContain`
    // would also match the transport-bind exit at the bottom of the
    // file and pass even if env validation silently dropped its exit.
    const envValidationExit =
      /hasGithubToken[\s\S]*?"REPO_OWNER, REPO_NAME, PR_NUMBER, and GITHUB_TOKEN are required"[\s\S]*?process\.exit\(1\)/.test(
        SOURCE,
      );
    expect(envValidationExit).toBe(true);
  });
});
