/**
 * Handler tests for the PR-side `.github-app.yaml` validation branch
 * (issue #3, C7).
 *
 * `handlePullRequestConfigCheck` is the thin layer between the
 * `pull_request` subscription and `runPrConfigCheck`. What is pinned here is
 * the idempotency contract, not the rendering:
 *
 *   - a replayed delivery (same `X-GitHub-Delivery`) performs the GitHub
 *     write at most once;
 *   - the claim key is `${deliveryId}:config-check`, NOT the bare
 *     `deliveryId` that `handlePullRequestLabeled` already claims, so the two
 *     branches of one delivery can never starve each other;
 *   - the repo-wide `enabled: false` master switch silences this GitHub-write
 *     surface, and a `runPrConfigCheck` rejection is contained rather than
 *     escalated to the process-killing `unhandledRejection` handler;
 *   - the action guard inside `handlePullRequest` that reaches this handler at
 *     all (last describe block), which is the feature's actual on-switch.
 *
 * Dispatch is fire-and-forget inside a `void (async () => {...})()` IIFE whose
 * first statement is `await claimDelivery(...)` (issue #202). That await defers
 * the `runPrConfigCheck` call past the synchronous test body, so every positive
 * case must drain the microtask queue (`flushMicrotasks`) before asserting,
 * otherwise the deferred call also leaks into the next test after `mockClear`.
 */

import type { PullRequestEvent } from "@octokit/webhooks-types";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";

// ─── Mocked downstream surfaces ──────────────────────────────────────────

// Behaviour is swapped through a variable rather than `mockImplementationOnce`
// so the call-args assertions below keep binding to one stable mock.
let runPrConfigCheckImpl: () => Promise<void> = () => Promise.resolve();
const mockRunPrConfigCheck = mock((_input: unknown) => runPrConfigCheckImpl());
void mock.module("../../../src/repo-config/pr-check", () => ({
  runPrConfigCheck: mockRunPrConfigCheck,
}));

// The repo-wide `enabled: false` master switch. Only that switch is honoured
// on this surface, never the full Gate-1 trigger set.
let repoPolicy: { enabled: boolean } = { enabled: true };
const mockLoadRepoPolicy = mock((_input: unknown) => Promise.resolve(repoPolicy));
void mock.module("../../../src/repo-config/effective", () => ({
  loadRepoPolicy: mockLoadRepoPolicy,
  // `pull-request.ts` also imports this for the auto-review opt-in check. The
  // config-check path never reaches it, but the module mock must still export
  // it or the import fails at load time.
  policyForWorkflow: () => ({
    enabled: true,
    extraAllowedTools: [],
    pathFilters: [],
    auto: false,
  }),
}));

// One-shot claim per key, mirroring the Valkey `SET NX` semantics.
const claimed = new Set<string>();
const mockClaimDelivery = mock((key: string) => {
  if (claimed.has(key)) return Promise.resolve(false);
  claimed.add(key);
  return Promise.resolve(true);
});
void mock.module("../../../src/webhook/idempotency", () => ({
  claimDelivery: mockClaimDelivery,
}));

// The labeled branch's downstream surfaces: stubbed so the shared-delivery
// test can exercise it without touching the dispatcher or the DB.
const mockDispatchByLabel = mock(() =>
  Promise.resolve({ status: "dispatched" as const, runId: "run-1", workflowName: "triage" }),
);
void mock.module("../../../src/workflows/dispatcher", () => ({
  dispatchByLabel: mockDispatchByLabel,
  // Imported by `pull-request.ts` for auto-review. Unreachable here (no
  // AUTO_REVIEW_USERS in this suite's env), but the mock must export it.
  dispatchWorkflowByName: mock(() => Promise.resolve({ status: "ignored", reason: "test" })),
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

// Keep `isOwnerAllowed` real; pin ALLOWED_OWNERS to a controlled list.
void mock.module("../../../src/config", () => ({
  config: {
    allowedOwners: ["acme"],
    logLevel: "silent",
    nodeEnv: "test",
  },
}));

const { handlePullRequest, handlePullRequestConfigCheck } =
  await import("../../../src/webhook/events/pull-request");

const fakeOctokit = {} as unknown as Octokit;

const HEAD_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

// Drain the microtask queue so the fire-and-forget IIFE runs past its leading
// `await claimDelivery(...)` gate (#202) and the `runPrConfigCheck` call lands
// before assertions / the next test's `mockClear`.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

type PrAction = "opened" | "synchronize" | "reopened" | "labeled" | "closed" | "edited";

function prPayload(overrides?: {
  action?: PrAction;
  labelName?: string;
  senderLogin?: string;
}): PullRequestEvent {
  return {
    action: overrides?.action ?? "opened",
    number: 77,
    installation: { id: 555 },
    label: overrides?.labelName !== undefined ? { name: overrides.labelName } : undefined,
    pull_request: {
      number: 77,
      title: "Add repo config",
      body: "",
      state: "open",
      merged: false,
      draft: false,
      created_at: "2026-05-11T00:00:00Z",
      updated_at: "2026-05-11T00:00:00Z",
      user: { login: "acme" },
      base: { ref: "main" },
      head: { ref: "feature", sha: HEAD_SHA },
    },
    repository: {
      name: "widgets",
      owner: { login: "acme" },
    },
    sender: { login: overrides?.senderLogin ?? "acme" },
  } as unknown as PullRequestEvent;
}

describe("handlePullRequestConfigCheck", () => {
  beforeEach(() => {
    claimed.clear();
    runPrConfigCheckImpl = () => Promise.resolve();
    repoPolicy = { enabled: true };
    mockRunPrConfigCheck.mockClear();
    mockClaimDelivery.mockClear();
    mockDispatchByLabel.mockClear();
    mockLoadRepoPolicy.mockClear();
  });

  it("C7: claims `<deliveryId>:config-check`, never the bare deliveryId", async () => {
    handlePullRequestConfigCheck(fakeOctokit, prPayload(), "delivery-a");
    await flushMicrotasks();

    expect(mockClaimDelivery).toHaveBeenCalledTimes(1);
    const key = (mockClaimDelivery.mock.calls[0] as unknown as [string])[0];
    expect(key).toBe("delivery-a:config-check");

    expect(mockRunPrConfigCheck).toHaveBeenCalledTimes(1);
    const args = (
      mockRunPrConfigCheck.mock.calls[0] as unknown as [
        { owner: string; repo: string; prNumber: number; headSha: string; deliveryId: string },
      ]
    )[0];
    expect(args.owner).toBe("acme");
    expect(args.repo).toBe("widgets");
    expect(args.prNumber).toBe(77);
    expect(args.headSha).toBe(HEAD_SHA);
    expect(args.deliveryId).toBe("delivery-a");
  });

  it("C7: a replayed delivery performs the GitHub write at most once", async () => {
    handlePullRequestConfigCheck(fakeOctokit, prPayload(), "delivery-dup");
    await flushMicrotasks();
    handlePullRequestConfigCheck(fakeOctokit, prPayload({ action: "synchronize" }), "delivery-dup");
    await flushMicrotasks();

    expect(mockClaimDelivery).toHaveBeenCalledTimes(2);
    expect(mockRunPrConfigCheck).toHaveBeenCalledTimes(1);
  });

  it("C7: a labeled delivery that claimed the bare deliveryId does not starve the config check", async () => {
    // Same X-GitHub-Delivery reaching both branches: the labeled branch claims
    // `delivery-shared`, so a shared key would silently drop the validation
    // comment.
    handlePullRequest(
      fakeOctokit,
      prPayload({ action: "labeled", labelName: "bot:ship" }),
      "delivery-shared",
    );
    await flushMicrotasks();
    expect(mockClaimDelivery).toHaveBeenCalledWith("delivery-shared", expect.anything());

    handlePullRequestConfigCheck(fakeOctokit, prPayload(), "delivery-shared");
    await flushMicrotasks();

    expect(mockRunPrConfigCheck).toHaveBeenCalledTimes(1);
    const keys = mockClaimDelivery.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(keys).toContain("delivery-shared");
    expect(keys).toContain("delivery-shared:config-check");
  });

  it("drops events whose sender is outside ALLOWED_OWNERS before claiming anything", async () => {
    handlePullRequestConfigCheck(fakeOctokit, prPayload({ senderLogin: "stranger" }), "delivery-x");
    await flushMicrotasks();

    expect(mockClaimDelivery).not.toHaveBeenCalled();
    expect(mockRunPrConfigCheck).not.toHaveBeenCalled();
  });

  it("stays silent when the default branch's config sets `enabled: false`", async () => {
    repoPolicy = { enabled: false };
    handlePullRequestConfigCheck(fakeOctokit, prPayload(), "delivery-disabled");
    await flushMicrotasks();

    expect(mockLoadRepoPolicy).toHaveBeenCalledTimes(1);
    // No comment, and no refusal comment either: this surface carries no
    // `explain` obligation.
    expect(mockRunPrConfigCheck).not.toHaveBeenCalled();
  });

  it("contains a runPrConfigCheck rejection instead of leaking an unhandled rejection", async () => {
    // `src/logger.ts` installs an `unhandledRejection` handler that calls
    // `process.exit(1)`, so losing the handler's try/catch would take the
    // whole webhook server down on one bad config read.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      runPrConfigCheckImpl = () => Promise.reject(new Error("getContent exploded"));
      handlePullRequestConfigCheck(fakeOctokit, prPayload(), "delivery-throw");
      await flushMicrotasks();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockRunPrConfigCheck).toHaveBeenCalledTimes(1);
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

/**
 * The feature's on-switch. Every test above drives `handlePullRequestConfigCheck`
 * directly, so the action guard inside `handlePullRequest` that actually reaches
 * it is only covered here: deleting that block must fail a test rather than
 * silently turning the feature off.
 */
describe("handlePullRequest action gating for the config check", () => {
  beforeEach(() => {
    claimed.clear();
    runPrConfigCheckImpl = () => Promise.resolve();
    repoPolicy = { enabled: true };
    mockRunPrConfigCheck.mockClear();
    mockClaimDelivery.mockClear();
    mockDispatchByLabel.mockClear();
    mockLoadRepoPolicy.mockClear();
  });

  const cases: { action: PrAction; fires: boolean }[] = [
    { action: "opened", fires: true },
    { action: "synchronize", fires: true },
    { action: "reopened", fires: true },
    { action: "labeled", fires: false },
    { action: "closed", fires: false },
    { action: "edited", fires: false },
  ];

  for (const { action, fires } of cases) {
    it(`${fires ? "runs" : "skips"} the config check on pull_request.${action}`, async () => {
      handlePullRequest(fakeOctokit, prPayload({ action }), `delivery-${action}`);
      await flushMicrotasks();

      expect(mockRunPrConfigCheck).toHaveBeenCalledTimes(fires ? 1 : 0);
    });
  }
});
