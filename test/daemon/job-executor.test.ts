/**
 * Wiring-only tests for the direct-pipeline rail's Gate-2 hop.
 *
 * `executeJob` spreads the wire `policy` into `runPipeline`. The wire schema
 * and the pipeline consumer both have their own suites; this hop between them
 * had none, so deleting the spread failed nothing.
 */

import { describe, expect, it, mock } from "bun:test";

import type { DaemonCapabilities } from "../../src/shared/daemon-types";
import { daemonMessageSchema, type JobPayloadMessage } from "../../src/shared/ws-messages";

const mockRunPipeline = mock(() => Promise.resolve({ success: true, durationMs: 1, numTurns: 1 }));
const mockGetPr = mock(() =>
  Promise.resolve({
    data: { state: "closed", merged: false, base: { ref: "main" }, head: { ref: "feat/x" } },
  }),
);
const mockCreateComment = mock(() => Promise.resolve({ data: { id: 4242 } }));

void mock.module("../../src/core/pipeline", () => ({
  runPipeline: mockRunPipeline,
}));

void mock.module("octokit", () => ({
  Octokit: class MockOctokit {
    rest = {
      pulls: { get: mockGetPr },
      issues: { createComment: mockCreateComment },
    };
  },
}));

const { executeJob } = await import("../../src/daemon/job-executor");

const CAPABILITIES = {
  daemonId: "daemon-test",
  tools: [],
} as unknown as DaemonCapabilities;

function buildPayload(policy?: Record<string, unknown>): JobPayloadMessage {
  return {
    id: "offer-1",
    timestamp: Date.now(),
    payload: {
      context: {
        owner: "acme",
        repo: "widgets",
        entityNumber: 42,
        isPR: true,
        eventName: "pull_request",
        commentId: 0,
        deliveryId: "delivery-1",
        defaultBranch: "main",
      },
      installationToken: "tok",
      allowedTools: ["Read"],
      ...(policy !== undefined ? { policy } : {}),
    },
  } as unknown as JobPayloadMessage;
}

describe("executeJob: per-repo policy forwarding (direct-pipeline rail)", () => {
  it("forwards the wire policy into the pipeline overrides", async () => {
    mockRunPipeline.mockClear();
    const policy = {
      model: "claude-repo-pinned-model",
      timeoutMs: 900_000,
      pathFilters: ["**/__snapshots__/**"],
    };

    await executeJob(buildPayload(policy), CAPABILITIES, () => {});

    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    const overrides = mockRunPipeline.mock.calls[0]?.[1] as
      | { policy?: Record<string, unknown> }
      | undefined;
    expect(overrides?.policy).toEqual(policy);
  });

  it("passes no policy key when the payload carries none (C8)", async () => {
    mockRunPipeline.mockClear();

    await executeJob(buildPayload(), CAPABILITIES, () => {});

    const overrides = mockRunPipeline.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(overrides).toBeDefined();
    // `exactOptionalPropertyTypes`: absent, not `undefined`-valued.
    expect(Object.hasOwn(overrides ?? {}, "policy")).toBe(false);
  });
});

describe("executeJob: scoped completion wire contract", () => {
  it("emits a schema-valid scoped-job:completion", async () => {
    mockGetPr.mockClear();
    mockCreateComment.mockClear();
    const sent: unknown[] = [];
    const payload: JobPayloadMessage = {
      type: "job:payload",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: {
        context: {},
        installationToken: "tok",
        allowedTools: [],
        scoped: {
          jobKind: "scoped-rebase",
          deliveryId: "scoped-delivery-1",
          installationId: 123,
          owner: "acme",
          repo: "widgets",
          prNumber: 42,
          triggerCommentId: 456,
          enqueuedAt: Date.now(),
        },
      },
    };

    await executeJob(payload, CAPABILITIES, (message) => sent.push(message));

    const completion = sent.find(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === "scoped-job:completion",
    );
    expect(completion).toBeDefined();
    expect(daemonMessageSchema.safeParse(completion).success).toBe(true);
    expect(completion).toMatchObject({
      type: "scoped-job:completion",
      payload: {
        jobKind: "scoped-rebase",
        status: "succeeded",
        rebaseOutcome: { result: "closed", commentId: 4242 },
      },
    });
    expect(mockGetPr).toHaveBeenCalledTimes(1);
    expect(mockCreateComment).toHaveBeenCalledTimes(1);
  });
});
