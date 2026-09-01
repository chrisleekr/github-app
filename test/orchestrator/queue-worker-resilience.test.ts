import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { QueuedJob } from "../../src/orchestrator/job-queue";

const workflowJob: Extract<QueuedJob, { kind: "workflow-run" }> = {
  kind: "workflow-run",
  deliveryId: "workflow-16",
  repoOwner: "acme",
  repoName: "widgets",
  entityNumber: 42,
  isPR: false,
  eventName: "issue_comment",
  triggerUsername: "user",
  labels: [],
  triggerBodyPreview: "",
  enqueuedAt: Date.now(),
  retryCount: 3,
  workflowRun: { runId: crypto.randomUUID(), workflowName: "implement" },
};
const raw = JSON.stringify(workflowJob);

const leaseJob = mock(() => Promise.resolve(null as { job: QueuedJob; raw: string } | null));
const deferLeasedWorkflowJob = mock(() =>
  Promise.resolve({ status: "moved" as "moved" | "already-moved" | "missing" }),
);
const ensureWorkflowJobQueued = mock(() => Promise.resolve(true));
const releaseLeasedJob = mock(() => Promise.resolve());
const requeueLeasedJob = mock(() => Promise.resolve(1));
const dispatchJob = mock(() => Promise.resolve(false));
const markJobTerminallyFailed = mock(() => Promise.resolve());
const dispatchWorkflowRunner = mock(() =>
  Promise.resolve("accepted" as "accepted" | "stale" | "capacity"),
);

void mock.module("../../src/orchestrator/job-queue", () => ({
  deferLeasedWorkflowJob,
  ensureWorkflowJobQueued,
  leaseJob,
  releaseLeasedJob,
  requeueLeasedJob,
}));
void mock.module("../../src/orchestrator/job-dispatcher", () => ({
  dispatchJob,
  markJobTerminallyFailed,
}));
void mock.module("../../src/orchestrator/workflow-runner-dispatch", () => ({
  dispatchWorkflowRunner,
}));
void mock.module("../../src/orchestrator/instance-id", () => ({
  getInstanceId: () => "orchestrator-test",
}));
void mock.module("../../src/config", () => ({
  config: { jobMaxRetries: 3, queueWorkerBackoffMaxMs: 200 },
}));
void mock.module("../../src/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));

const { startQueueWorker, stopQueueWorker } = await import("../../src/orchestrator/queue-worker");

describe("isolated workflow queue dispatch", () => {
  beforeEach(async () => {
    await stopQueueWorker();
    leaseJob.mockReset();
    deferLeasedWorkflowJob.mockReset();
    ensureWorkflowJobQueued.mockReset();
    releaseLeasedJob.mockReset();
    requeueLeasedJob.mockReset();
    dispatchJob.mockReset();
    markJobTerminallyFailed.mockReset();
    dispatchWorkflowRunner.mockReset();

    let leased = false;
    leaseJob.mockImplementation(() => {
      if (leased) return Promise.resolve(null);
      leased = true;
      return Promise.resolve({ job: workflowJob, raw });
    });
    deferLeasedWorkflowJob.mockResolvedValue({ status: "moved" });
    ensureWorkflowJobQueued.mockResolvedValue(true);
    releaseLeasedJob.mockResolvedValue();
    requeueLeasedJob.mockResolvedValue(1);
    dispatchJob.mockResolvedValue(false);
    markJobTerminallyFailed.mockResolvedValue();
    dispatchWorkflowRunner.mockResolvedValue("accepted");
  });

  it("defers capacity without consuming retry budget or using the shared dispatcher", async () => {
    dispatchWorkflowRunner.mockResolvedValue("capacity");
    deferLeasedWorkflowJob.mockResolvedValue({ status: "missing" });
    let duplicatePublished: (() => void) | undefined;
    const published = new Promise<void>((resolve) => {
      duplicatePublished = resolve;
    });
    ensureWorkflowJobQueued.mockImplementation(() => {
      duplicatePublished?.();
      return Promise.resolve();
    });

    startQueueWorker();
    await published;
    await stopQueueWorker();

    expect(deferLeasedWorkflowJob).toHaveBeenCalledWith(
      "orchestrator-test",
      raw,
      workflowJob,
      expect.any(String),
    );
    expect(ensureWorkflowJobQueued).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "workflow-run",
        retryCount: workflowJob.retryCount,
      }),
      "orchestrator-test",
    );
    expect(dispatchJob).not.toHaveBeenCalled();
    expect(releaseLeasedJob).not.toHaveBeenCalled();
  });

  it("defers a pre-transfer dispatch error instead of falling back to a shared daemon", async () => {
    dispatchWorkflowRunner.mockRejectedValue(new Error("database unavailable"));
    let deferred: (() => void) | undefined;
    const deferralStarted = new Promise<void>((resolve) => {
      deferred = resolve;
    });
    deferLeasedWorkflowJob.mockImplementation(() => {
      deferred?.();
      return Promise.resolve({ status: "moved" });
    });

    startQueueWorker();
    await deferralStarted;
    await stopQueueWorker();

    expect(dispatchJob).not.toHaveBeenCalled();
    expect(markJobTerminallyFailed).not.toHaveBeenCalled();
    expect(releaseLeasedJob).not.toHaveBeenCalled();
  });

  it("releases the queue lease after PostgreSQL accepts recovery authority", async () => {
    let released: (() => void) | undefined;
    const leaseReleased = new Promise<void>((resolve) => {
      released = resolve;
    });
    releaseLeasedJob.mockImplementation(() => {
      released?.();
      return Promise.resolve();
    });

    startQueueWorker();
    await leaseReleased;
    await stopQueueWorker();

    expect(dispatchWorkflowRunner).toHaveBeenCalledWith(workflowJob);
    expect(releaseLeasedJob).toHaveBeenCalledWith("orchestrator-test", raw);
    expect(deferLeasedWorkflowJob).not.toHaveBeenCalled();
    expect(dispatchJob).not.toHaveBeenCalled();
  });
});
