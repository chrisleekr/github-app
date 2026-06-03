/**
 * Handler tests for `issues.labeled` / `issues.unlabeled`.
 *
 * The handler is the thin layer between the webhook subscription and
 * `dispatchByLabel`. These tests verify:
 *
 *   - FR-015: sender not in ALLOWED_OWNERS → no dispatch call, no side effects
 *   - bot:* label on valid sender → dispatchByLabel invoked once with the
 *     expected target / senderLogin / deliveryId
 *   - Non-bot:* labels are ignored
 *   - unlabeled action is a no-op
 *   - T014 idempotency: the handler itself does not de-duplicate; it delegates
 *     to the dispatcher, which relies on the partial unique index at the
 *     runs-store layer. The handler is invoked twice → dispatcher is invoked
 *     twice → second call returns {status:"refused", reason:"in-flight…"}.
 *
 * Dispatch is fire-and-forget inside a `void (async () => {...})()` IIFE whose
 * first statement is `await claimDelivery(...)` (issue #202). That await defers
 * the `dispatchByLabel` call past the synchronous test body, so the positive
 * cases must drain the microtask queue (`flushMicrotasks`) before asserting,
 * otherwise the deferred call also leaks into the next test after `mockClear`.
 */

import type { IssuesEvent } from "@octokit/webhooks-types";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";

// ─── Mocked downstream surfaces ──────────────────────────────────────────

const mockDispatchByLabel = mock(() =>
  Promise.resolve({
    status: "dispatched" as const,
    runId: "run-1",
    workflowName: "triage" as const,
  }),
);
void mock.module("../../../src/workflows/dispatcher", () => ({
  dispatchByLabel: mockDispatchByLabel,
}));

// Keep `isOwnerAllowed` real, the handler depends on its behaviour via
// `config.allowedOwners`. Override the config module so ALLOWED_OWNERS is
// a controlled, single-entry list.
void mock.module("../../../src/config", () => ({
  config: {
    allowedOwners: ["acme"],
    logLevel: "silent",
    nodeEnv: "test",
  },
}));

const { handleIssues } = await import("../../../src/webhook/events/issues");

const fakeOctokit = {} as unknown as Octokit;

// Drain the microtask queue so the fire-and-forget dispatch IIFE runs past its
// leading `await claimDelivery(...)` gate (#202) and the `await dispatchByLabel`
// call lands before assertions / the next test's `mockClear`.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function issueLabeledPayload(overrides?: {
  labelName?: string;
  senderLogin?: string;
  action?: "labeled" | "unlabeled";
}): IssuesEvent {
  return {
    action: overrides?.action ?? "labeled",
    issue: { number: 42 } as IssuesEvent["issue"],
    label: overrides?.labelName !== undefined ? { name: overrides.labelName } : undefined,
    repository: {
      name: "repo",
      owner: { login: "acme" },
    } as IssuesEvent["repository"],
    sender: { login: overrides?.senderLogin ?? "acme" } as IssuesEvent["sender"],
  } as unknown as IssuesEvent;
}

describe("handleIssues", () => {
  beforeEach(() => {
    mockDispatchByLabel.mockClear();
    mockDispatchByLabel.mockImplementation(() =>
      Promise.resolve({
        status: "dispatched" as const,
        runId: "run-1",
        workflowName: "triage" as const,
      }),
    );
  });

  it("dispatches for bot:triage on open issue from allowed sender (T012)", async () => {
    handleIssues(fakeOctokit, issueLabeledPayload({ labelName: "bot:triage" }), "delivery-1");
    await flushMicrotasks();

    expect(mockDispatchByLabel).toHaveBeenCalledTimes(1);
    const call = mockDispatchByLabel.mock.calls[0] as unknown as [
      { label: string; target: { type: string; number: number }; deliveryId: string },
    ];
    expect(call[0]?.label).toBe("bot:triage");
    expect(call[0]?.target.type).toBe("issue");
    expect(call[0]?.target.number).toBe(42);
    expect(call[0]?.deliveryId).toBe("delivery-1");
  });

  it("drops events from senders outside ALLOWED_OWNERS without touching the dispatcher (FR-015)", () => {
    handleIssues(
      fakeOctokit,
      issueLabeledPayload({ labelName: "bot:triage", senderLogin: "stranger" }),
      "delivery-2",
    );

    expect(mockDispatchByLabel).not.toHaveBeenCalled();
  });

  it("ignores non-bot:* labels", () => {
    handleIssues(fakeOctokit, issueLabeledPayload({ labelName: "good first issue" }), "d3");

    expect(mockDispatchByLabel).not.toHaveBeenCalled();
  });

  it("ignores unlabeled action: label removal is not a trigger", () => {
    handleIssues(
      fakeOctokit,
      issueLabeledPayload({ labelName: "bot:triage", action: "unlabeled" }),
      "d4",
    );

    expect(mockDispatchByLabel).not.toHaveBeenCalled();
  });

  it("T014: duplicate label events delegate to dispatcher, second invocation is refused by idempotency guard", async () => {
    // First call: normal dispatch. Drain BEFORE arming the once-impl so this
    // dispatch resolves on the default "dispatched" path. Dispatch is deferred
    // past the leading `await claimDelivery(...)` gate (#202), so without this
    // drain the once-impl below would be consumed by THIS (first) call instead
    // of the second one.
    handleIssues(fakeOctokit, issueLabeledPayload({ labelName: "bot:triage" }), "delivery-dup-1");
    await flushMicrotasks();

    // Second call with the same (target, workflow): dispatcher reports the
    // partial unique index rejection surfaced by runs-store.
    mockDispatchByLabel.mockImplementationOnce(() =>
      Promise.resolve({
        status: "refused" as const,
        workflowName: "triage" as const,
        reason: "an in-flight run already exists for this workflow and target",
      }),
    );
    handleIssues(fakeOctokit, issueLabeledPayload({ labelName: "bot:triage" }), "delivery-dup-2");

    // Let the micro-task queue drain so the second fire-and-forget dispatch
    // resolves.
    await flushMicrotasks();

    expect(mockDispatchByLabel).toHaveBeenCalledTimes(2);
    // Second call's resolved outcome is the "in-flight" refusal, the handler
    // does not surface this to GitHub directly (dispatcher posts the refusal
    // comment). We assert the shape by inspecting the mock's return value.
    const secondCallResult = await (
      mockDispatchByLabel.mock.results[1] as { value: Promise<unknown> }
    ).value;
    expect((secondCallResult as { status: string }).status).toBe("refused");
  });
});
