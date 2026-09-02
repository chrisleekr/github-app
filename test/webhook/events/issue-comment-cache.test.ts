/**
 * Regression tests for issue #129: chat-thread `comment_cache` write-through
 * must fire on every `issue_comment` action, not just `created`.
 *
 * Covers two layers:
 *
 *   1. Behaviour: `writeCommentCacheThrough` correctly inserts, updates, and
 *      soft-deletes rows for `created` / `edited` / `deleted` payloads, and
 *      `loadConversation` reflects the post-edit body. This is the contract
 *      `src/db/queries/conversation-store.ts:7-13` documents.
 *
 *   2. Subscription: `src/app.ts` registers all three issue_comment actions
 *      with `app.webhooks.on`. This is the source-level invariant: if a
 *      future edit narrows the subscription back to `created`-only (the
 *      original bug), the regex match fails and the test fires loudly. Same
 *      shape as `test/mcp/registry.test.ts`'s build-discovery invariant.
 *
 * Skips DB tests when the configured Postgres is unreachable, matching the
 * pattern in `test/db/queries/proposals-store.test.ts`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { IssueCommentEvent } from "@octokit/webhooks-types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { getDb } from "../../../src/db";
import { loadConversation } from "../../../src/db/queries/conversation-store";
import { writeCommentCacheThrough } from "../../../src/webhook/events/issue-comment";

const TEST_OWNER = "issue-129-test-owner";
const TEST_REPO = "issue-129-test-repo";
const TEST_ISSUE_NUMBER = 12_999;
const TEST_COMMENT_ID = 99_000_001;

let dbAvailable = false;
beforeAll(async () => {
  const db = getDb();
  if (db === null) return;
  try {
    await db`SELECT 1`;
  } catch {
    return;
  }
  const { runMigrations } = await import("../../../src/db/migrate");
  await runMigrations(db);
  dbAvailable = true;
});

const skipIfNoDb = (): boolean => !dbAvailable;

async function cleanup(): Promise<void> {
  const db = getDb();
  if (db === null || !dbAvailable) return;
  await db`DELETE FROM comment_cache WHERE owner = ${TEST_OWNER}`;
}

beforeEach(cleanup);
afterAll(cleanup);

function basePayload(
  action: "created" | "edited" | "deleted",
  body: string,
  overrides: { readonly updatedAt?: string } = {},
): IssueCommentEvent {
  const createdAt = "2026-05-11T00:00:00Z";
  const updatedAt = overrides.updatedAt ?? createdAt;
  return {
    action,
    issue: {
      number: TEST_ISSUE_NUMBER,
      pull_request: undefined,
    } as unknown as IssueCommentEvent["issue"],
    comment: {
      id: TEST_COMMENT_ID,
      body,
      created_at: createdAt,
      updated_at: updatedAt,
      user: { login: "alice", type: "User" },
    } as unknown as IssueCommentEvent["comment"],
    repository: {
      name: TEST_REPO,
      owner: { login: TEST_OWNER },
    } as unknown as IssueCommentEvent["repository"],
    sender: { login: "alice", type: "User" } as unknown as IssueCommentEvent["sender"],
  } as unknown as IssueCommentEvent;
}

describe("writeCommentCacheThrough: action coverage (issue #129)", () => {
  it("inserts a row on `created` and `loadConversation` returns it", async () => {
    if (skipIfNoDb()) return;
    await writeCommentCacheThrough(basePayload("created", "original body"));

    const snap = await loadConversation({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      targetType: "issue",
      targetNumber: TEST_ISSUE_NUMBER,
    });
    expect(snap.comments.length).toBe(1);
    expect(snap.comments[0]?.body).toBe("original body");
  });

  it("updates the body on `edited` so loadConversation returns the post-edit body", async () => {
    if (skipIfNoDb()) return;
    await writeCommentCacheThrough(basePayload("created", "original body"));
    await writeCommentCacheThrough(
      basePayload("edited", "post-edit body", { updatedAt: "2026-05-11T00:05:00Z" }),
    );

    const snap = await loadConversation({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      targetType: "issue",
      targetNumber: TEST_ISSUE_NUMBER,
    });
    expect(snap.comments.length).toBe(1);
    expect(snap.comments[0]?.body).toBe("post-edit body");
  });

  it("soft-deletes on `deleted` so loadConversation no longer returns the row", async () => {
    if (skipIfNoDb()) return;
    await writeCommentCacheThrough(basePayload("created", "to be removed"));
    await writeCommentCacheThrough(basePayload("deleted", "to be removed"));

    const snap = await loadConversation({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      targetType: "issue",
      targetNumber: TEST_ISSUE_NUMBER,
    });
    // Soft-delete: loadConversation filters `deleted_at IS NULL`, so the row
    // is invisible to the chat-thread reader.
    expect(snap.comments.length).toBe(0);
  });
});

/**
 * Subscription-level invariant. Without this, narrowing the array back to
 * `["issue_comment.created"]` (the exact bug fixed in #129) compiles, passes
 * every behavioural test (which call `writeCommentCacheThrough` directly),
 * but ships the regression. A grep-based test is cheap and load-bearing.
 */
describe("src/app.ts subscription (issue #129)", () => {
  const appSrc = ((): string => {
    const path = join(import.meta.dir, "../../../src/app.ts");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is a fixed test fixture path, not user input
    return readFileSync(path, "utf8");
  })();

  it.each([["issue_comment.created"], ["issue_comment.edited"], ["issue_comment.deleted"]])(
    "subscribes to %s",
    (action) => {
      // Tolerate either quote style. Substring instead of RegExp avoids any
      // regex-escape footgun on the action name (CodeRabbit/CodeQL flagged
      // the dynamic-regex variant on PR #131).
      const hasDoubleQuoted = appSrc.includes(`"${action}"`);
      const hasSingleQuoted = appSrc.includes(`'${action}'`);
      expect(hasDoubleQuoted || hasSingleQuoted, `${action} not found as a quoted string`).toBe(
        true,
      );
    },
  );

  it("registers issue_comment via the multi-action array form, not the single-action form", () => {
    // Catches a future narrowing back to the regression shape
    // `app.webhooks.on("issue_comment.created", ...)`.
    const singleActionForm = /app\.webhooks\.on\(\s*['"]issue_comment\.created['"]\s*,/;
    expect(appSrc).not.toMatch(singleActionForm);
  });
});

/**
 * Source-level guard on the dispatch ordering inside `handleIssueComment`.
 * The cache write-through must run for every action (the fix), but dispatch
 * MUST stay gated to `created` only. A future refactor that moves the early
 * return below dispatch would silently re-fire workflows on every edit;
 * this regex assertion fails first.
 */
describe("handleIssueComment dispatch gate ordering (issue #129)", () => {
  const handlerSrc = ((): string => {
    const path = join(import.meta.dir, "../../../src/webhook/events/issue-comment.ts");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is a fixed test fixture path, not user input
    return readFileSync(path, "utf8");
  })();

  it("returns early on non-created actions before any dispatch call", () => {
    const earlyReturn = handlerSrc.indexOf(`if (payload.action !== "created") return;`);
    expect(earlyReturn, "early-return guard missing").toBeGreaterThan(-1);

    const firstDispatch = Math.min(
      ...["dispatchByIntent(", "dispatchCommentSurface("]
        .map((s) => handlerSrc.indexOf(s))
        .filter((i) => i !== -1),
    );
    expect(firstDispatch, "no dispatch call found").toBeGreaterThan(-1);
    expect(
      earlyReturn,
      "early-return must appear BEFORE the first dispatch call site",
    ).toBeLessThan(firstDispatch);
  });
});
