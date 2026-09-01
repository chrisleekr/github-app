/**
 * Handler tests for auto-review on push (work item #1).
 *
 * `maybeAutoReview` runs off `pull_request.synchronize` and dispatches `review`
 * with no label and no mention. What is pinned here is the gate order and the
 * refusal-to-act, not the review itself:
 *
 *   - both keys are required: the `AUTO_REVIEW_USERS` env allowlist AND the
 *     repo's `workflows.review.auto`, and an unreachable config fails to OFF;
 *   - the allowlist is matched against the authenticated **pusher**
 *     (`sender.login`), never the `repos.getCommit` author, which is derived
 *     from a commit email anyone can set;
 *   - our own pushes are skipped, which is what stops
 *     review -> resolve -> push -> review from looping;
 *   - a push whose diff fingerprint is unchanged (a rebase) is skipped;
 *   - the claim key is `${deliveryId}:auto-review`, so it cannot starve the
 *     `${deliveryId}:config-check` branch of the same delivery;
 *   - the fingerprint is recorded only on a real dispatch, so a Gate-1 refusal
 *     cannot suppress the next genuine review.
 *
 * Dispatch is fire-and-forget inside a `void (async () => {...})()` IIFE, so
 * every case drains the microtask queue before asserting.
 */

import type { PullRequestEvent } from "@octokit/webhooks-types";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";

// ─── Mocked downstream surfaces ──────────────────────────────────────────

let repoAuto = true;
const mockLoadRepoPolicy = mock((_input: unknown) => Promise.resolve({ enabled: true }));
const mockPolicyForWorkflow = mock((_p: unknown, _n: unknown) => ({
  enabled: true,
  extraAllowedTools: [],
  pathFilters: [],
  auto: repoAuto,
}));
void mock.module("../../../src/repo-config/effective", () => ({
  loadRepoPolicy: mockLoadRepoPolicy,
  policyForWorkflow: mockPolicyForWorkflow,
}));

void mock.module("../../../src/repo-config/pr-check", () => ({
  runPrConfigCheck: mock(() => Promise.resolve()),
}));

const claimed = new Set<string>();
const mockClaimDelivery = mock((key: string) => {
  if (claimed.has(key)) return Promise.resolve(false);
  claimed.add(key);
  return Promise.resolve(true);
});
void mock.module("../../../src/webhook/idempotency", () => ({
  claimDelivery: mockClaimDelivery,
}));

let dispatchOutcome: { status: string; runId?: string; workflowName?: string; reason?: string } = {
  status: "dispatched",
  runId: "run-1",
  workflowName: "review",
};
const mockDispatchWorkflowByName = mock((_input: unknown) => Promise.resolve(dispatchOutcome));
void mock.module("../../../src/workflows/dispatcher", () => ({
  dispatchByLabel: mock(() => Promise.resolve({ status: "ignored", reason: "test" })),
  dispatchWorkflowByName: mockDispatchWorkflowByName,
}));

const mockSafePostToGitHub = mock((_input: unknown) =>
  Promise.resolve({ posted: true, matchCount: 0, kinds: [] }),
);
void mock.module("../../../src/utils/github-output-guard", () => ({
  safePostToGitHub: mockSafePostToGitHub,
}));

// The guards are unit-tested separately; here they are swapped so gate ORDER
// and short-circuiting are what the assertions actually pin.
let selfPush = false;
let shipActive = false;
let fingerprint: string | null = "fp-current";
let lastReviewed: string | null = null;
const mockHasActiveShipIntent = mock(() => Promise.resolve(shipActive));
const mockIsSelfPush = mock((_o: unknown, _s: unknown) => Promise.resolve(selfPush));
const mockComputeDiffFingerprint = mock((..._a: unknown[]) => Promise.resolve(fingerprint));
const mockMatchesLastReviewed = mock((...a: unknown[]) =>
  Promise.resolve(lastReviewed !== null && a[3] === lastReviewed),
);
const mockRecordReviewedFingerprint = mock((..._a: unknown[]) => Promise.resolve());
void mock.module("../../../src/webhook/auto-review-guard", () => ({
  isSelfPush: mockIsSelfPush,
  hasActiveShipIntent: mockHasActiveShipIntent,
  computeDiffFingerprint: mockComputeDiffFingerprint,
  matchesLastReviewed: mockMatchesLastReviewed,
  recordReviewedFingerprint: mockRecordReviewedFingerprint,
}));

void mock.module("../../../src/workflows/ship/command-dispatch", () => ({
  dispatchCanonicalCommand: mock(() => undefined),
}));
void mock.module("../../../src/workflows/ship/reactor-bridge", () => ({
  fireReactor: mock(() => undefined),
}));
void mock.module("../../../src/workflows/ship/trigger-router", () => ({
  routeTrigger: mock(() => Promise.resolve(null)),
}));
void mock.module("../../../src/db/queries/conversation-store", () => ({
  upsertTarget: mock(() => Promise.resolve()),
}));

// Mutable so a case can unset the allowlist without re-importing the handler.
// `acme` for the repo owner (which is what auto-review checks) and
// `chrisleekr` for the sender (which is what the sibling config-check branch
// checks), so both branches of one delivery run and the claim keys can be
// asserted not to collide.
const testConfig: { allowedOwners: string[]; autoReviewUsers?: string[] } = {
  allowedOwners: ["acme", "chrisleekr"],
  autoReviewUsers: ["chrisleekr"],
};
// Getters, not a spread: a spread would freeze `autoReviewUsers` at mock-
// definition time and the "unset" case could never be exercised.
void mock.module("../../../src/config", () => ({
  config: {
    get allowedOwners() {
      return testConfig.allowedOwners;
    },
    get autoReviewUsers() {
      return testConfig.autoReviewUsers;
    },
    logLevel: "silent",
    nodeEnv: "test",
  },
}));

const { handlePullRequest } = await import("../../../src/webhook/events/pull-request");

const HEAD_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const fakeOctokit = {
  rest: { repos: { getCommit: () => Promise.resolve({ data: { author: { login: "someone" } } }) } },
} as unknown as Octokit;

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function syncPayload(
  senderLogin = "chrisleekr",
  opts?: { headRepoFullName?: string },
): PullRequestEvent {
  return {
    action: "synchronize",
    number: 77,
    before: "1111111111111111111111111111111111111111",
    after: HEAD_SHA,
    installation: { id: 555 },
    pull_request: {
      number: 77,
      title: "Add widget",
      body: "",
      state: "open",
      merged: false,
      draft: false,
      user: { login: "chrisleekr" },
      base: { ref: "main" },
      head: {
        ref: "feature",
        sha: HEAD_SHA,
        repo: { full_name: opts?.headRepoFullName ?? "acme/widgets" },
      },
    },
    repository: { name: "widgets", owner: { login: "acme" }, full_name: "acme/widgets" },
    sender: { login: senderLogin, type: "User" },
  } as unknown as PullRequestEvent;
}

async function fire(payload: PullRequestEvent, deliveryId = "d-1"): Promise<void> {
  handlePullRequest(fakeOctokit, payload, deliveryId);
  await flushMicrotasks();
}

describe("auto-review on pull_request.synchronize", () => {
  beforeEach(() => {
    claimed.clear();
    testConfig.allowedOwners = ["acme", "chrisleekr"];
    testConfig.autoReviewUsers = ["chrisleekr"];
    repoAuto = true;
    selfPush = false;
    shipActive = false;
    fingerprint = "fp-current";
    lastReviewed = null;
    dispatchOutcome = { status: "dispatched", runId: "run-1", workflowName: "review" };
    mockDispatchWorkflowByName.mockClear();
    mockSafePostToGitHub.mockClear();
    mockClaimDelivery.mockClear();
    mockRecordReviewedFingerprint.mockClear();
    mockComputeDiffFingerprint.mockClear();
    mockPolicyForWorkflow.mockClear();
  });

  it("dispatches review with auto:true, no rocket, and the trigger context", async () => {
    await fire(syncPayload());

    expect(mockDispatchWorkflowByName).toHaveBeenCalledTimes(1);
    const arg = mockDispatchWorkflowByName.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg["workflowName"]).toBe("review");
    expect(arg["auto"]).toBe(true);
    expect(arg["addRocketReaction"]).toBe(false);
    expect(arg["senderLogin"]).toBe("chrisleekr");
    expect(arg["target"]).toEqual({ type: "pr", owner: "acme", repo: "widgets", number: 77 });
    expect(arg["trigger"]).toEqual({ title: "Add widget", draft: false, baseBranch: "main" });
    // Gate 1 must not re-fetch the policy this handler already loaded.
    expect(arg["repoPolicy"]).toBeDefined();
  });

  it("does nothing when AUTO_REVIEW_USERS is unset", async () => {
    testConfig.autoReviewUsers = undefined;
    await fire(syncPayload());
    expect(mockDispatchWorkflowByName).not.toHaveBeenCalled();
  });

  it("does nothing when the pusher is not in the allowlist", async () => {
    await fire(syncPayload("someone-else"));
    expect(mockDispatchWorkflowByName).not.toHaveBeenCalled();
  });

  it("matches the allowlist case-insensitively", async () => {
    await fire(syncPayload("ChrisLeeKr"));
    expect(mockDispatchWorkflowByName).toHaveBeenCalledTimes(1);
  });

  it("gates on the pusher, NOT the commit author", async () => {
    // The commit author is allowlisted; the authenticated pusher is not. The
    // author comes from a settable commit email, so it must not grant a run.
    testConfig.autoReviewUsers = ["someone"];
    await fire(syncPayload("mallory"));
    expect(mockDispatchWorkflowByName).not.toHaveBeenCalled();
  });

  it("skips our own push, breaking the resolve -> review loop", async () => {
    selfPush = true;
    await fire(syncPayload());
    expect(mockDispatchWorkflowByName).not.toHaveBeenCalled();
  });

  it("skips when the repo has not opted in", async () => {
    repoAuto = false;
    await fire(syncPayload());
    expect(mockDispatchWorkflowByName).not.toHaveBeenCalled();
  });

  it("checks the repo opt-in BEFORE paying for a fingerprint", async () => {
    repoAuto = false;
    await fire(syncPayload());
    expect(mockPolicyForWorkflow).toHaveBeenCalled();
    expect(mockComputeDiffFingerprint).not.toHaveBeenCalled();
  });

  it("skips a rebase: same diff fingerprint as the last reviewed one", async () => {
    lastReviewed = "fp-current";
    await fire(syncPayload());
    expect(mockDispatchWorkflowByName).not.toHaveBeenCalled();
  });

  it("dispatches when the fingerprint changed", async () => {
    lastReviewed = "fp-old";
    fingerprint = "fp-current";
    await fire(syncPayload());
    expect(mockDispatchWorkflowByName).toHaveBeenCalledTimes(1);
  });

  it("still dispatches when the fingerprint is unavailable (fail-open)", async () => {
    fingerprint = null;
    await fire(syncPayload());
    expect(mockDispatchWorkflowByName).toHaveBeenCalledTimes(1);
    expect(mockRecordReviewedFingerprint).not.toHaveBeenCalled();
  });

  it("records the fingerprint only on a real dispatch", async () => {
    await fire(syncPayload());
    expect(mockRecordReviewedFingerprint).toHaveBeenCalledTimes(1);
  });

  it("does NOT record the fingerprint when the dispatch was refused", async () => {
    // Otherwise a Gate-1 refusal would poison the fingerprint and suppress the
    // next genuine review of the same diff.
    dispatchOutcome = { status: "refused", reason: "disabled", workflowName: "review" };
    await fire(syncPayload());
    expect(mockRecordReviewedFingerprint).not.toHaveBeenCalled();
  });

  it("claims `<deliveryId>:auto-review`, never the bare deliveryId", async () => {
    await fire(syncPayload());
    const keys = mockClaimDelivery.mock.calls.map((c) => c[0]);
    expect(keys).toContain("d-1:auto-review");
    expect(keys).not.toContain("d-1");
  });

  it("does not dispatch twice for a replayed delivery", async () => {
    await fire(syncPayload());
    await fire(syncPayload());
    expect(mockDispatchWorkflowByName).toHaveBeenCalledTimes(1);
  });

  it("does not starve the config-check branch of the same delivery", async () => {
    await fire(syncPayload());
    const keys = mockClaimDelivery.mock.calls.map((c) => c[0]);
    expect(keys).toContain("d-1:auto-review");
    expect(keys).toContain("d-1:config-check");
  });

  it("contains a dispatch failure instead of escalating it", async () => {
    mockDispatchWorkflowByName.mockImplementationOnce(() => Promise.reject(new Error("boom")));
    // Must not reject out of the fire-and-forget IIFE.
    await fire(syncPayload());
    expect(mockDispatchWorkflowByName).toHaveBeenCalledTimes(1);
    expect(mockSafePostToGitHub).not.toHaveBeenCalled();
  });

  it("ignores non-synchronize actions", async () => {
    const opened = { ...syncPayload(), action: "opened" } as unknown as PullRequestEvent;
    await fire(opened);
    expect(mockDispatchWorkflowByName).not.toHaveBeenCalled();
  });

  it("does nothing when ALLOWED_OWNERS excludes the repository owner", async () => {
    // The outermost authorization boundary for a path that spends tokens with
    // nobody asking. Without a case here, deleting the check keeps CI green.
    testConfig.allowedOwners = ["someone-else"];

    await fire(syncPayload());

    expect(mockDispatchWorkflowByName).not.toHaveBeenCalled();
    expect(mockClaimDelivery).not.toHaveBeenCalled();
  });

  it("skips a pull request whose head is on a fork", async () => {
    // `checkoutRepo` clones the BASE repo and asks for the head *branch name*,
    // so a fork ref either fails to clone or silently resolves to a same-named
    // base branch and reviews the wrong tree.
    await fire(syncPayload("chrisleekr", { headRepoFullName: "outsider/widgets" }));

    expect(mockDispatchWorkflowByName).not.toHaveBeenCalled();
  });

  it("still reviews a same-repo branch, which is the ordinary case", async () => {
    await fire(syncPayload("chrisleekr", { headRepoFullName: "acme/widgets" }));

    expect(mockDispatchWorkflowByName).toHaveBeenCalledTimes(1);
  });

  it("skips a pull request that ship is already driving", async () => {
    // Ship runs its own review -> resolve iteration, so a second review would
    // duplicate the spend and race ship's insertQueued on the in-flight index.
    shipActive = true;

    await fire(syncPayload());

    expect(mockDispatchWorkflowByName).not.toHaveBeenCalled();
  });
});
