/**
 * Unit tests for the shared "is this actor us?" test (work item #1).
 *
 * Three call sites depend on it: the auto-review self-push guard (which is what
 * stops review -> resolve -> push -> review from looping), the inline-comment
 * MCP server's duplicate-finding check (`src/mcp/servers/inline-comment-dedup.ts`),
 * and, through those, what the bot is willing to suppress.
 *
 * The contract under test is that identity is a LOGIN, never the `type: "Bot"`
 * account class. Getting that wrong is not cosmetic: it would let the bot claim
 * every other GitHub App as itself.
 */

import { describe, expect, it } from "bun:test";

import { isSelfActor } from "../../src/utils/github-actor";

describe("isSelfActor", () => {
  it("recognises our own bot account by login (App installation token)", () => {
    // The default auth mode. `selfLogin` is `config.botAppLogin`, supplied by
    // `resolveSelfLogin` without an API call, because installation tokens
    // cannot call `GET /user`.
    expect(isSelfActor({ login: "chrisleekr-bot[bot]", type: "Bot" }, "chrisleekr-bot[bot]")).toBe(
      true,
    );
  });

  it("recognises the PAT owner, who is an ordinary User", () => {
    // Under GITHUB_PERSONAL_ACCESS_TOKEN our pushes and comments carry a real
    // human's login, which is usually the same person in AUTO_REVIEW_USERS.
    expect(isSelfActor({ login: "chrisleekr", type: "User" }, "chrisleekr")).toBe(true);
  });

  it("compares logins case-insensitively", () => {
    expect(isSelfActor({ login: "ChrisLeeKr", type: "User" }, "chrisleekr")).toBe(true);
  });

  it("does NOT claim a third-party bot as us", () => {
    // The load-bearing case. `type: "Bot"` is the account class every GitHub App
    // shares, not an identity. Claiming these would make `resolve` discard
    // CodeRabbit's feedback and let anyone able to post as `github-actions[bot]`
    // suppress one of our findings by commenting on the line first.
    for (const login of [
      "renovate[bot]",
      "dependabot[bot]",
      "coderabbitai[bot]",
      "github-actions[bot]",
    ]) {
      expect(isSelfActor({ login, type: "Bot" }, "chrisleekr-bot[bot]")).toBe(false);
    }
  });

  it("does not claim another human as us", () => {
    expect(isSelfActor({ login: "someone", type: "User" }, "chrisleekr")).toBe(false);
  });

  it("answers 'not us' when no self-login was resolved", () => {
    // Fail-open direction: a lookup failure costs a redundant review or a
    // duplicate comment, never a suppressed finding.
    expect(isSelfActor({ login: "chrisleekr-bot[bot]", type: "Bot" }, null)).toBe(false);
    expect(isSelfActor({ login: "chrisleekr", type: "User" }, null)).toBe(false);
  });

  it("treats a missing actor, or one with no login, as not us", () => {
    expect(isSelfActor(null, "chrisleekr")).toBe(false);
    expect(isSelfActor(undefined, "chrisleekr")).toBe(false);
    expect(isSelfActor({ type: "Bot" }, "chrisleekr-bot[bot]")).toBe(false);
  });
});
