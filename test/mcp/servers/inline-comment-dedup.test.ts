/**
 * Unit tests for the inline-comment duplicate matcher (work item #1).
 *
 * `review` can be auto-triggered on every push, and each finding is its own
 * review thread, so without this check an unfixed finding accumulates one thread
 * per run. Those duplicates are not marked outdated by GitHub (each anchors to
 * the new head SHA) and they count against ship's merge gate, so the matcher is
 * what keeps auto-review from degrading a PR.
 *
 * Only the location half is covered here. The authorship half is
 * `isSelfActor`, tested in `test/utils/github-actor.test.ts`.
 */

import { describe, expect, it } from "bun:test";

import {
  type ExistingComment,
  hasDuplicateAt,
} from "../../../src/mcp/servers/inline-comment-dedup";

const TARGET = { path: "src/a.ts", line: 42, side: "RIGHT" };
const SELF = "chrisleekr-bot[bot]";

function comment(overrides: Partial<ExistingComment> = {}): ExistingComment {
  return {
    path: "src/a.ts",
    line: 42,
    side: "RIGHT",
    user: { login: "chrisleekr-bot[bot]", type: "Bot" },
    ...overrides,
  };
}

describe("hasDuplicateAt", () => {
  it("finds our own comment at the same path, line, and side", () => {
    expect(hasDuplicateAt([comment()], TARGET, SELF)).toBe(true);
  });

  it("returns false on an empty thread list", () => {
    expect(hasDuplicateAt([], TARGET, null)).toBe(false);
  });

  it("does not match a comment carrying a null line", () => {
    // Pinned as a plain null-safety property, NOT as an assertion about when
    // GitHub nulls `line`. The REST reference documents no outdated-nulling
    // rule, so the module deliberately does not depend on one.
    expect(hasDuplicateAt([comment({ line: null })], TARGET, SELF)).toBe(false);
  });

  it("ignores a human's comment at the same location", () => {
    // Suppressing our finding because a reviewer happened to comment there would
    // silently drop it.
    const human = comment({ user: { login: "someone", type: "User" } });
    expect(hasDuplicateAt([human], TARGET, null)).toBe(false);
  });

  it("does not match a different line", () => {
    expect(hasDuplicateAt([comment({ line: 43 })], TARGET, SELF)).toBe(false);
  });

  it("does not match a different path", () => {
    expect(hasDuplicateAt([comment({ path: "src/b.ts" })], TARGET, SELF)).toBe(false);
  });

  it("does not match the other side of the diff", () => {
    expect(hasDuplicateAt([comment({ side: "LEFT" })], TARGET, SELF)).toBe(false);
  });

  it("finds a match anywhere in the list, not just first", () => {
    const list = [comment({ line: 1 }), comment({ path: "src/z.ts" }), comment()];
    expect(hasDuplicateAt(list, TARGET, SELF)).toBe(true);
  });

  it("does NOT treat another bot's comment as our duplicate", () => {
    // Otherwise anyone who can post as `github-actions[bot]` suppresses one of
    // our findings by commenting on that line first, and the agent is told
    // "already exists, do not retry this finding".
    const theirs = comment({ user: { login: "github-actions[bot]", type: "Bot" } });
    expect(hasDuplicateAt([theirs], TARGET, SELF)).toBe(false);
  });

  it("matches our PAT-authored comment when a self-login is supplied", () => {
    const mine = comment({ user: { login: "chrisleekr", type: "User" } });
    expect(hasDuplicateAt([mine], TARGET, "chrisleekr")).toBe(true);
    // ...and not when it could not be resolved, which fails open to posting.
    expect(hasDuplicateAt([mine], TARGET, null)).toBe(false);
  });

  it("does not treat our reply inside someone else's thread as a finding", () => {
    // The bot replies in humans' threads (fix-thread, chat-thread) and those
    // replies carry the thread's location. Counting one would let a single
    // reply on this line permanently suppress a genuine later finding there.
    const reply = comment({ in_reply_to_id: 12345 });
    expect(hasDuplicateAt([reply], TARGET, SELF)).toBe(false);
  });

  it("still matches our own top-level finding at that location", () => {
    expect(hasDuplicateAt([comment({ in_reply_to_id: undefined })], TARGET, SELF)).toBe(true);
  });
});
