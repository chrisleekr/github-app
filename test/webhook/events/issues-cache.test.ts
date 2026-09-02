/**
 * Regression tests for issue #130: chat-thread `target_cache` write-through
 * must fire on every `issues` action that mutates a cached field, not just
 * the cold-miss backfill path.
 *
 * Covers three layers (same shape as `issue-comment-cache.test.ts`):
 *
 *   1. Behaviour: `writeIssueTargetCacheThrough` correctly upserts on
 *      `opened` / `edited` / `closed` / `reopened` and hard-deletes on
 *      `deleted`, with `loadConversation` reflecting the post-edit body.
 *
 *   2. Subscription: `src/app.ts` registers all five actions
 *      (`opened`, `edited`, `closed`, `reopened`, `deleted`) plus the
 *      pre-existing `labeled` / `unlabeled` with `app.webhooks.on`. A
 *      future edit that narrows the subscription drops a write-through
 *      gap; the grep assertion fails first.
 *
 *   3. Ordering: `handleIssues` runs the cache write-through BEFORE any
 *      dispatch gate / early-return, so a `labeled` action whose
 *      `unlabeled` branch returns first does not skip the cache.
 *
 * Skips DB tests when the configured Postgres is unreachable.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { IssuesEvent } from "@octokit/webhooks-types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { getDb } from "../../../src/db";
import { loadConversation, upsertComment } from "../../../src/db/queries/conversation-store";
import { writeIssueTargetCacheThrough } from "../../../src/webhook/events/issues";

const TEST_OWNER = "issue-130-test-owner";
const TEST_REPO = "issue-130-test-repo";
const TEST_ISSUE_NUMBER = 13_000;

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
  await db`DELETE FROM target_cache WHERE owner = ${TEST_OWNER}`;
  await db`DELETE FROM comment_cache WHERE owner = ${TEST_OWNER}`;
}

beforeEach(cleanup);
afterAll(cleanup);

type IssueAction = "opened" | "edited" | "closed" | "reopened" | "deleted";

function basePayload(
  action: IssueAction,
  body: string,
  overrides: { readonly updatedAt?: string; readonly title?: string; readonly state?: string } = {},
): IssuesEvent {
  const createdAt = "2026-05-11T00:00:00Z";
  const updatedAt = overrides.updatedAt ?? createdAt;
  return {
    action,
    issue: {
      number: TEST_ISSUE_NUMBER,
      title: overrides.title ?? "Test issue title",
      body,
      state: overrides.state ?? (action === "closed" ? "closed" : "open"),
      created_at: createdAt,
      updated_at: updatedAt,
      user: { login: "alice", type: "User" },
      pull_request: undefined,
    } as unknown as IssuesEvent["issue"],
    repository: {
      name: TEST_REPO,
      owner: { login: TEST_OWNER },
    } as unknown as IssuesEvent["repository"],
    sender: { login: "alice", type: "User" } as unknown as IssuesEvent["sender"],
  } as unknown as IssuesEvent;
}

describe("writeIssueTargetCacheThrough: action coverage (issue #130)", () => {
  it("upserts the row on `opened` and loadConversation returns the body", async () => {
    if (skipIfNoDb()) return;
    await writeIssueTargetCacheThrough(basePayload("opened", "initial body"));

    const snap = await loadConversation({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      targetType: "issue",
      targetNumber: TEST_ISSUE_NUMBER,
    });
    expect(snap.target?.body).toBe("initial body");
    expect(snap.target?.state).toBe("open");
  });

  it("updates the body on `edited` so loadConversation returns the post-edit body", async () => {
    if (skipIfNoDb()) return;
    await writeIssueTargetCacheThrough(basePayload("opened", "initial body"));
    await writeIssueTargetCacheThrough(
      basePayload("edited", "post-edit body", { updatedAt: "2026-05-11T00:05:00Z" }),
    );

    const snap = await loadConversation({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      targetType: "issue",
      targetNumber: TEST_ISSUE_NUMBER,
    });
    expect(snap.target?.body).toBe("post-edit body");
  });

  it("flips state to `closed` on `closed` and back to `open` on `reopened`", async () => {
    if (skipIfNoDb()) return;
    await writeIssueTargetCacheThrough(basePayload("opened", "body", { state: "open" }));
    await writeIssueTargetCacheThrough(
      basePayload("closed", "body", {
        state: "closed",
        updatedAt: "2026-05-11T00:05:00Z",
      }),
    );

    let snap = await loadConversation({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      targetType: "issue",
      targetNumber: TEST_ISSUE_NUMBER,
    });
    expect(snap.target?.state).toBe("closed");

    await writeIssueTargetCacheThrough(
      basePayload("reopened", "body", {
        state: "open",
        updatedAt: "2026-05-11T00:10:00Z",
      }),
    );
    snap = await loadConversation({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      targetType: "issue",
      targetNumber: TEST_ISSUE_NUMBER,
    });
    expect(snap.target?.state).toBe("open");
  });

  it("does not clobber a newer body when an older payload arrives second", async () => {
    if (skipIfNoDb()) return;
    // Webhooks can be redelivered out of order. The newer `edited` lands
    // first; a stuck retry of the original `opened` arrives second. The
    // upsert must keep the newer body, gated on payload `updated_at`.
    await writeIssueTargetCacheThrough(
      basePayload("edited", "newer body", { updatedAt: "2026-05-11T01:00:00Z" }),
    );
    await writeIssueTargetCacheThrough(
      basePayload("opened", "older body", { updatedAt: "2026-05-11T00:00:00Z" }),
    );

    const snap = await loadConversation({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      targetType: "issue",
      targetNumber: TEST_ISSUE_NUMBER,
    });
    expect(snap.target?.body).toBe("newer body");
  });

  it("hard-deletes target + child comment rows on `deleted`", async () => {
    if (skipIfNoDb()) return;
    await writeIssueTargetCacheThrough(basePayload("opened", "doomed"));
    // Seed a comment on the same target to verify cascade-on-delete.
    await upsertComment({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      targetType: "issue",
      targetNumber: TEST_ISSUE_NUMBER,
      commentId: 99_999_001,
      surface: "issue-comment",
      inReplyToId: null,
      authorLogin: "alice",
      authorType: "User",
      body: "orphan candidate",
      path: null,
      line: null,
      diffHunk: null,
      createdAt: new Date("2026-05-11T00:01:00Z"),
      updatedAt: new Date("2026-05-11T00:01:00Z"),
    });

    await writeIssueTargetCacheThrough(basePayload("deleted", "doomed"));

    const snap = await loadConversation({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      targetType: "issue",
      targetNumber: TEST_ISSUE_NUMBER,
    });
    expect(snap.target).toBeNull();
    expect(snap.comments.length).toBe(0);
  });
});

/**
 * Subscription-level invariant. Without this, narrowing the array back to
 * `["issues.labeled", "issues.unlabeled"]` (the pre-#130 state, which
 * leaves target_cache stale) compiles, passes every behavioural test
 * (which call `writeIssueTargetCacheThrough` directly), but ships the gap.
 */
describe("src/app.ts subscription (issue #130)", () => {
  const appSrc = ((): string => {
    const path = join(import.meta.dir, "../../../src/app.ts");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is a fixed test fixture path, not user input
    return readFileSync(path, "utf8");
  })();

  it.each([
    ["issues.opened"],
    ["issues.edited"],
    ["issues.closed"],
    ["issues.reopened"],
    ["issues.deleted"],
    ["issues.labeled"],
    ["issues.unlabeled"],
  ])("subscribes to %s", (action) => {
    // Substring (not RegExp), same reasoning as `issue-comment-cache.test.ts`:
    // dynamic-regex builds get flagged by CodeQL as escape footguns.
    const hasDoubleQuoted = appSrc.includes(`"${action}"`);
    const hasSingleQuoted = appSrc.includes(`'${action}'`);
    expect(hasDoubleQuoted || hasSingleQuoted, `${action} not found as a quoted string`).toBe(true);
  });
});

/**
 * Source-level guard on the dispatch ordering inside `handleIssues`. The
 * cache write-through must run for every action, but dispatch must stay
 * gated to `labeled`. A refactor that moves the write-through call below
 * the early-return for `unlabeled` would silently re-introduce the gap;
 * this regex assertion fails first.
 */
describe("handleIssues cache write-through ordering (issue #130)", () => {
  const handlerSrc = ((): string => {
    const path = join(import.meta.dir, "../../../src/webhook/events/issues.ts");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is a fixed test fixture path, not user input
    return readFileSync(path, "utf8");
  })();

  it("calls writeIssueTargetCacheThrough BEFORE the unlabeled early-return", () => {
    const cacheCall = handlerSrc.indexOf("writeIssueTargetCacheThrough(payload)");
    expect(cacheCall, "cache write-through call missing").toBeGreaterThan(-1);

    const unlabeledGuard = handlerSrc.indexOf(`payload.action === "unlabeled"`);
    expect(unlabeledGuard, "unlabeled guard missing").toBeGreaterThan(-1);
    expect(
      cacheCall,
      "cache write-through must appear BEFORE the unlabeled early-return",
    ).toBeLessThan(unlabeledGuard);
  });
});
