/**
 * Regression tests for issue #130: chat-thread `target_cache` write-through
 * must fire on every `pull_request` action that mutates a cached field,
 * not just the cold-miss backfill path.
 *
 * Covers three layers (same shape as `issues-cache.test.ts`):
 *
 *   1. Behaviour: `writePrTargetCacheThrough` correctly upserts title /
 *      body / state / is_draft / base_ref / head_ref on `opened` / `edited`
 *      / `closed` / `reopened` / `converted_to_draft` / `ready_for_review`,
 *      and collapses `merged: true` to `state = "merged"`.
 *
 *   2. Subscription: `src/app.ts` registers all eight subscribed actions.
 *
 *   3. Ordering: `handlePullRequest` runs the cache write-through BEFORE
 *      any dispatch gate / early-return.
 *
 * Skips DB tests when the configured Postgres is unreachable.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { PullRequestEvent } from "@octokit/webhooks-types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { getDb } from "../../../src/db";
import { loadConversation } from "../../../src/db/queries/conversation-store";
import { writePrTargetCacheThrough } from "../../../src/webhook/events/pull-request";

const TEST_OWNER = "issue-130-pr-test-owner";
const TEST_REPO = "issue-130-pr-test-repo";
const TEST_PR_NUMBER = 13_001;

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
}

beforeEach(cleanup);
afterAll(cleanup);

type PrAction =
  | "opened"
  | "edited"
  | "closed"
  | "reopened"
  | "converted_to_draft"
  | "ready_for_review";

function basePayload(
  action: PrAction,
  body: string,
  overrides: {
    readonly updatedAt?: string;
    readonly title?: string;
    readonly state?: "open" | "closed";
    readonly merged?: boolean;
    readonly draft?: boolean;
    readonly baseRef?: string;
    readonly headRef?: string;
  } = {},
): PullRequestEvent {
  const createdAt = "2026-05-11T00:00:00Z";
  const updatedAt = overrides.updatedAt ?? createdAt;
  return {
    action,
    pull_request: {
      number: TEST_PR_NUMBER,
      title: overrides.title ?? "Test PR title",
      body,
      state: overrides.state ?? (action === "closed" ? "closed" : "open"),
      merged: overrides.merged ?? false,
      draft: overrides.draft ?? action === "converted_to_draft",
      created_at: createdAt,
      updated_at: updatedAt,
      user: { login: "alice", type: "User" },
      base: { ref: overrides.baseRef ?? "main" },
      head: { ref: overrides.headRef ?? "feature-branch", sha: "deadbeef" },
    } as unknown as PullRequestEvent["pull_request"],
    repository: {
      name: TEST_REPO,
      owner: { login: TEST_OWNER },
    } as unknown as PullRequestEvent["repository"],
    sender: { login: "alice", type: "User" } as unknown as PullRequestEvent["sender"],
  } as unknown as PullRequestEvent;
}

describe("writePrTargetCacheThrough: action coverage (issue #130)", () => {
  it("upserts the row on `opened` with title/body/state/is_draft/base_ref/head_ref", async () => {
    if (skipIfNoDb()) return;
    await writePrTargetCacheThrough(
      basePayload("opened", "initial body", {
        title: "Initial title",
        baseRef: "main",
        headRef: "feat/x",
      }),
    );

    const snap = await loadConversation({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      targetType: "pr",
      targetNumber: TEST_PR_NUMBER,
    });
    expect(snap.target?.title).toBe("Initial title");
    expect(snap.target?.body).toBe("initial body");
    expect(snap.target?.state).toBe("open");
    expect(snap.target?.is_draft).toBe(false);
    expect(snap.target?.base_ref).toBe("main");
    expect(snap.target?.head_ref).toBe("feat/x");
  });

  it("updates the body on `edited` so loadConversation returns the post-edit body", async () => {
    if (skipIfNoDb()) return;
    await writePrTargetCacheThrough(basePayload("opened", "initial body"));
    await writePrTargetCacheThrough(
      basePayload("edited", "post-edit body", { updatedAt: "2026-05-11T00:05:00Z" }),
    );

    const snap = await loadConversation({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      targetType: "pr",
      targetNumber: TEST_PR_NUMBER,
    });
    expect(snap.target?.body).toBe("post-edit body");
  });

  it("collapses `merged: true` to state = 'merged'", async () => {
    if (skipIfNoDb()) return;
    await writePrTargetCacheThrough(basePayload("opened", "body"));
    await writePrTargetCacheThrough(
      basePayload("closed", "body", {
        state: "closed",
        merged: true,
        updatedAt: "2026-05-11T00:10:00Z",
      }),
    );

    const snap = await loadConversation({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      targetType: "pr",
      targetNumber: TEST_PR_NUMBER,
    });
    expect(snap.target?.state).toBe("merged");
  });

  it("flips is_draft via `converted_to_draft` / `ready_for_review`", async () => {
    if (skipIfNoDb()) return;
    await writePrTargetCacheThrough(basePayload("opened", "body", { draft: false }));
    await writePrTargetCacheThrough(
      basePayload("converted_to_draft", "body", {
        draft: true,
        updatedAt: "2026-05-11T00:05:00Z",
      }),
    );

    let snap = await loadConversation({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      targetType: "pr",
      targetNumber: TEST_PR_NUMBER,
    });
    expect(snap.target?.is_draft).toBe(true);

    await writePrTargetCacheThrough(
      basePayload("ready_for_review", "body", {
        draft: false,
        updatedAt: "2026-05-11T00:10:00Z",
      }),
    );
    snap = await loadConversation({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      targetType: "pr",
      targetNumber: TEST_PR_NUMBER,
    });
    expect(snap.target?.is_draft).toBe(false);
  });
});

describe("src/app.ts subscription (issue #130, pull_request)", () => {
  const appSrc = ((): string => {
    const path = join(import.meta.dir, "../../../src/app.ts");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is a fixed test fixture path, not user input
    return readFileSync(path, "utf8");
  })();

  it.each([
    ["pull_request.opened"],
    ["pull_request.edited"],
    ["pull_request.labeled"],
    ["pull_request.synchronize"],
    ["pull_request.closed"],
    ["pull_request.reopened"],
    ["pull_request.converted_to_draft"],
    ["pull_request.ready_for_review"],
  ])("subscribes to %s", (action) => {
    const hasDoubleQuoted = appSrc.includes(`"${action}"`);
    const hasSingleQuoted = appSrc.includes(`'${action}'`);
    expect(hasDoubleQuoted || hasSingleQuoted, `${action} not found as a quoted string`).toBe(true);
  });
});

describe("handlePullRequest cache write-through ordering (issue #130)", () => {
  const handlerSrc = ((): string => {
    const path = join(import.meta.dir, "../../../src/webhook/events/pull-request.ts");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is a fixed test fixture path, not user input
    return readFileSync(path, "utf8");
  })();

  it("calls writePrTargetCacheThrough BEFORE the first action branch", () => {
    const cacheCall = handlerSrc.indexOf("writePrTargetCacheThrough(payload)");
    expect(cacheCall, "cache write-through call missing").toBeGreaterThan(-1);

    const firstActionBranch = handlerSrc.indexOf(`payload.action === "labeled"`);
    expect(firstActionBranch, "labeled action branch missing").toBeGreaterThan(-1);
    expect(
      cacheCall,
      "cache write-through must appear BEFORE the first action-branch",
    ).toBeLessThan(firstActionBranch);
  });
});
