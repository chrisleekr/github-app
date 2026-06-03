/**
 * Unit tests for dispatchByLabel: registry-driven label → workflow lookup
 * and the seven-step label-trigger protocol.
 *
 * Downstream surfaces (runs-store, job-queue, label-mutex, tracking-mirror)
 * are mocked: the dispatcher is a pure orchestrator over the registry.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";
import type pino from "pino";

import { expectToReject } from "../utils/assertions";

// ─── Mocked downstream surfaces ──────────────────────────────────────────

const mockEnqueueJob = mock(() => Promise.resolve());
void mock.module("../../src/orchestrator/job-queue", () => ({
  enqueueJob: mockEnqueueJob,
  isScopedJob: () => false,
  SCOPED_JOB_KINDS: ["scoped-rebase", "scoped-fix-thread", "scoped-open-pr"],
}));

const mockRecordWorkflowExecution = mock(() => Promise.resolve());
void mock.module("../../src/workflows/execution-row", () => ({
  recordWorkflowExecution: mockRecordWorkflowExecution,
  buildWorkflowContextJson: mock(() => ({})),
}));

void mock.module("../../src/orchestrator/concurrency", () => ({
  incrementActiveCount: mock(() => {}),
  decrementActiveCount: mock(() => {}),
}));

const mockEnforceSingleBotLabel = mock(() =>
  Promise.resolve({ kept: "bot:plan", removed: [] as string[] }),
);
void mock.module("../../src/workflows/label-mutex", () => ({
  enforceSingleBotLabel: mockEnforceSingleBotLabel,
}));

const mockInsertQueued = mock(() =>
  Promise.resolve({ id: "00000000-0000-0000-0000-000000000001" }),
);
const mockFindLatestForTarget = mock(() => Promise.resolve(null as unknown));
const mockFindLatestSucceededForTarget = mock(() => Promise.resolve(null as unknown));
const mockMarkFailed = mock(() => Promise.resolve());
void mock.module("../../src/workflows/runs-store", () => ({
  insertQueued: mockInsertQueued,
  findLatestForTarget: mockFindLatestForTarget,
  findLatestSucceededForTarget: mockFindLatestSucceededForTarget,
  markFailed: mockMarkFailed,
  // findById is imported by review/resolve handlers (transitively reachable
  // when registry resolves them). Provide a stub so module loading succeeds,
  // tests in this file don't exercise that code path.
  findById: mock(async () => Promise.resolve(null)),
}));

const mockPostRefusalComment = mock(() => Promise.resolve());
void mock.module("../../src/workflows/tracking-mirror", () => ({
  postRefusalComment: mockPostRefusalComment,
}));

// Import dispatcher AFTER mocks.
const { dispatchByLabel } = await import("../../src/workflows/dispatcher");

// ─── Test fixtures ───────────────────────────────────────────────────────

function silentLog(): pino.Logger {
  const log = {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    child: mock(function (this: unknown) {
      return this;
    }),
  } as unknown as pino.Logger;
  return log;
}

const fakeOctokit = {} as unknown as Octokit;

function baseParams(overrides: {
  label: string;
  targetType: "issue" | "pr";
}): Parameters<typeof dispatchByLabel>[0] {
  return {
    octokit: fakeOctokit,
    logger: silentLog(),
    label: overrides.label,
    target: {
      type: overrides.targetType,
      owner: "acme",
      repo: "repo",
      number: 42,
    },
    senderLogin: "alice",
    deliveryId: "delivery-abc",
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("dispatchByLabel", () => {
  beforeEach(() => {
    mockEnqueueJob.mockClear();
    mockEnforceSingleBotLabel.mockClear();
    mockInsertQueued.mockClear();
    mockFindLatestForTarget.mockClear();
    mockFindLatestSucceededForTarget.mockClear();
    mockMarkFailed.mockClear();
    mockPostRefusalComment.mockClear();
  });

  it("returns ignored for unknown labels without touching any downstream surface", async () => {
    const result = await dispatchByLabel(
      baseParams({ label: "needs-triage", targetType: "issue" }),
    );

    expect(result.status).toBe("ignored");
    if (result.status === "ignored") {
      expect(result.reason).toContain("needs-triage");
    }
    expect(mockEnforceSingleBotLabel).not.toHaveBeenCalled();
    expect(mockInsertQueued).not.toHaveBeenCalled();
    expect(mockEnqueueJob).not.toHaveBeenCalled();
    expect(mockPostRefusalComment).not.toHaveBeenCalled();
  });

  it("dispatches a known label whose context matches (bot:triage on issue)", async () => {
    const result = await dispatchByLabel(baseParams({ label: "bot:triage", targetType: "issue" }));

    expect(result.status).toBe("dispatched");
    if (result.status === "dispatched") {
      expect(result.workflowName).toBe("triage");
      expect(result.runId).toBe("00000000-0000-0000-0000-000000000001");
    }
    expect(mockEnforceSingleBotLabel).toHaveBeenCalledTimes(1);
    expect(mockInsertQueued).toHaveBeenCalledTimes(1);
    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);

    // workflowRun must be threaded into the queued job for daemon routing.
    const enqueueCall = mockEnqueueJob.mock.calls[0] as unknown as [
      { workflowRun?: { runId: string; workflowName: string } },
    ];
    const queued = enqueueCall[0];
    expect(queued.workflowRun?.runId).toBe("00000000-0000-0000-0000-000000000001");
    expect(queued.workflowRun?.workflowName).toBe("triage");
  });

  it("refuses a known label whose context mismatches (bot:resolve on issue)", async () => {
    const result = await dispatchByLabel(baseParams({ label: "bot:resolve", targetType: "issue" }));

    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.workflowName).toBe("resolve");
      expect(result.reason).toContain("pr");
    }
    expect(mockPostRefusalComment).toHaveBeenCalledTimes(1);
    expect(mockInsertQueued).not.toHaveBeenCalled();
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it("refuses when requiresPrior is unsatisfied (bot:plan without a successful triage)", async () => {
    mockFindLatestSucceededForTarget.mockResolvedValueOnce(null);

    const result = await dispatchByLabel(baseParams({ label: "bot:plan", targetType: "issue" }));

    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.workflowName).toBe("plan");
      expect(result.reason).toContain("triage");
    }
    expect(mockFindLatestSucceededForTarget).toHaveBeenCalledTimes(1);
    expect(mockPostRefusalComment).toHaveBeenCalledTimes(1);
    expect(mockInsertQueued).not.toHaveBeenCalled();
    expect(mockEnqueueJob).not.toHaveBeenCalled();
    expect(mockEnforceSingleBotLabel).not.toHaveBeenCalled();
  });

  it("refuses on insertQueued collision (in-flight run already exists)", async () => {
    const collisionErr = Object.assign(
      new Error("duplicate key value violates unique constraint"),
      {
        code: "23505",
        constraint: "idx_workflow_runs_inflight",
      },
    );
    mockInsertQueued.mockRejectedValueOnce(collisionErr);

    const result = await dispatchByLabel(baseParams({ label: "bot:triage", targetType: "issue" }));

    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.workflowName).toBe("triage");
      expect(result.reason).toContain("in-flight");
    }
    expect(mockPostRefusalComment).toHaveBeenCalledTimes(1);
    expect(mockEnqueueJob).not.toHaveBeenCalled();
    // #211 Part 2: a collision surfaces "in-flight" (refused), it must NOT be
    // marked failed. markFailed is reserved for post-insert enqueue failures
    // (next test), where it deliberately clears the in-flight guard for retry.
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it("rethrows non-collision insertQueued errors without refusing", async () => {
    mockInsertQueued.mockRejectedValueOnce(new Error("connection reset"));

    await expectToReject(
      dispatchByLabel(baseParams({ label: "bot:triage", targetType: "issue" })),
      "connection reset",
    );

    expect(mockPostRefusalComment).not.toHaveBeenCalled();
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it("clears in-flight guard via markFailed when enqueue fails after insert", async () => {
    mockEnqueueJob.mockRejectedValueOnce(new Error("valkey unreachable"));

    await expectToReject(
      dispatchByLabel(baseParams({ label: "bot:triage", targetType: "issue" })),
      "valkey unreachable",
    );

    expect(mockMarkFailed).toHaveBeenCalledTimes(1);
    expect(mockPostRefusalComment).not.toHaveBeenCalled();
  });
});
