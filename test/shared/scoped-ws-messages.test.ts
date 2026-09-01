import { describe, expect, it } from "bun:test";

import {
  createMessageEnvelope,
  daemonMessageSchema,
  type ScopedJobCompletionMessage,
  type ScopedJobOfferMessage,
  serverMessageSchema,
  WS_REJECT_REASONS,
} from "../../src/shared/ws-messages";

describe("scoped-job:offer schema", () => {
  function buildOffer(overrides?: Partial<ScopedJobOfferMessage["payload"]>): unknown {
    return {
      type: "scoped-job:offer",
      ...createMessageEnvelope(),
      payload: {
        jobKind: "scoped-rebase",
        deliveryId: "delivery-1",
        installationId: 12345,
        owner: "octo",
        repo: "repo",
        prNumber: 42,
        triggerCommentId: 7777,
        enqueuedAt: Date.now(),
        ...overrides,
      },
    };
  }

  it("round-trips a scoped-rebase offer", () => {
    const parsed = serverMessageSchema.safeParse(buildOffer());
    expect(parsed.success).toBe(true);
  });

  it("requires threadRef for scoped-fix-thread", () => {
    const missing = serverMessageSchema.safeParse({
      type: "scoped-job:offer",
      ...createMessageEnvelope(),
      payload: {
        jobKind: "scoped-fix-thread",
        deliveryId: "d",
        installationId: 1,
        owner: "o",
        repo: "r",
        prNumber: 1,
        triggerCommentId: 1,
        enqueuedAt: Date.now(),
        // threadRef intentionally omitted
      },
    });
    expect(missing.success).toBe(false);
  });

  it("requires issueNumber + verdictSummary for scoped-open-pr", () => {
    const missing = serverMessageSchema.safeParse({
      type: "scoped-job:offer",
      ...createMessageEnvelope(),
      payload: {
        jobKind: "scoped-open-pr",
        deliveryId: "d",
        installationId: 1,
        owner: "o",
        repo: "r",
        triggerCommentId: 1,
        enqueuedAt: Date.now(),
        // issueNumber + verdictSummary intentionally omitted
      },
    });
    expect(missing.success).toBe(false);
  });

  it("rejects unknown jobKind values at the discriminator", () => {
    const wrong = serverMessageSchema.safeParse({
      type: "scoped-job:offer",
      ...createMessageEnvelope(),
      payload: {
        jobKind: "scoped-mystery",
        deliveryId: "d",
        installationId: 1,
        owner: "o",
        repo: "r",
        triggerCommentId: 1,
        enqueuedAt: Date.now(),
      },
    });
    expect(wrong.success).toBe(false);
  });
});

describe("scoped-job:completion schema", () => {
  function buildCompletion(
    payload: ScopedJobCompletionMessage["payload"],
  ): ScopedJobCompletionMessage {
    return {
      type: "scoped-job:completion",
      ...createMessageEnvelope(),
      payload,
    };
  }

  it("round-trips a successful scoped-rebase completion with a clean merge", () => {
    const msg = buildCompletion({
      offerId: "offer-1",
      deliveryId: "delivery-1",
      jobKind: "scoped-rebase",
      status: "succeeded",
      rebaseOutcome: { result: "merged", commentId: 1, mergeCommitSha: "abc123" },
      durationMs: 1234,
    });
    const parsed = daemonMessageSchema.safeParse(msg);
    expect(parsed.success).toBe(true);
  });

  it("round-trips a scoped-fix-thread halt with reason", () => {
    const msg = buildCompletion({
      offerId: "offer-2",
      deliveryId: "delivery-2",
      jobKind: "scoped-fix-thread",
      status: "halted",
      reason: "fix exceeded thread scope",
    });
    const parsed = daemonMessageSchema.safeParse(msg);
    expect(parsed.success).toBe(true);
  });

  it("rejects malformed rebaseOutcome (missing commentId)", () => {
    const wrong = daemonMessageSchema.safeParse({
      type: "scoped-job:completion",
      ...createMessageEnvelope(),
      payload: {
        offerId: "offer-3",
        deliveryId: "delivery-3",
        jobKind: "scoped-rebase",
        status: "succeeded",
        rebaseOutcome: { result: "merged", mergeCommitSha: "abc" },
      },
    });
    expect(wrong.success).toBe(false);
  });
});

describe("WS_REJECT_REASONS", () => {
  it("includes scoped-kind-unsupported", () => {
    expect(WS_REJECT_REASONS.SCOPED_KIND_UNSUPPORTED).toBe("scoped-kind-unsupported");
  });
});
