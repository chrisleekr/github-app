/**
 * Tests for src/orchestrator/job-queue.ts: Job queue operations using Valkey.
 *
 * Mocks the valkey module (requireValkeyClient) and config to avoid real connections.
 * Tests cover enqueue, tryDequeue (non-blocking), dequeue (blocking), and requeue paths.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { QueuedJob } from "../../src/orchestrator/job-queue";

// Mock dependencies

const mockLoggerInfo = mock(() => {});
const mockLoggerWarn = mock(() => {});
const mockLoggerError = mock(() => {});

void mock.module("../../src/logger", () => ({
  logger: {
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError,
    debug: mock(() => {}),
    child: mock(() => ({
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    })),
  },
}));

const mockSend = mock(() => Promise.resolve(null));

void mock.module("../../src/orchestrator/valkey", () => ({
  requireValkeyClient: () => ({
    send: mockSend,
  }),
  getValkeyClient: () => ({
    send: mockSend,
  }),
  isValkeyHealthy: () => true,
  closeValkey: () => {},
}));

const mockConfig = {
  valkeyUrl: "redis://localhost:56379",
  logLevel: "silent",
  nodeEnv: "test",
  jobMaxRetries: 3,
  appId: "test-app-id",
  privateKey: "test-private-key",
  webhookSecret: "test-webhook-secret",
  provider: "anthropic" as const,
  anthropicApiKey: "test-key",
  agentJobMode: "inline" as const,
  staleExecutionThresholdMs: 600_000,
};

void mock.module("../../src/config", () => ({
  config: mockConfig,
}));

// Import AFTER mocks
const {
  enqueueJob,
  tryDequeueJob,
  dequeueJob,
  requeueJob,
  leaseJob,
  releaseLeasedJob,
  requeueLeasedJob,
  recoverProcessingList,
  processingListKey,
} = await import("../../src/orchestrator/job-queue");

// Test fixtures

function makeQueuedJob(overrides: Partial<QueuedJob> = {}): QueuedJob {
  return {
    kind: "legacy",
    deliveryId: "delivery-001",
    repoOwner: "test-owner",
    repoName: "test-repo",
    entityNumber: 42,
    isPR: true,
    eventName: "issue_comment",
    triggerUsername: "user1",
    labels: ["bug"],
    triggerBodyPreview: "@bot fix this",
    enqueuedAt: Date.now(),
    retryCount: 0,
    ...overrides,
  } as QueuedJob;
}

// Tests

describe("job-queue", () => {
  beforeEach(() => {
    mockSend.mockClear();
    mockLoggerInfo.mockClear();
    mockLoggerWarn.mockClear();
    mockLoggerError.mockClear();
    mockConfig.jobMaxRetries = 3;
  });

  describe("enqueueJob", () => {
    it("pushes serialized job to the queue via LPUSH", async () => {
      mockSend.mockResolvedValueOnce(1);
      const job = makeQueuedJob();

      await enqueueJob(job);

      expect(mockSend).toHaveBeenCalledWith("LPUSH", ["queue:jobs", JSON.stringify(job)]);
      expect(mockLoggerInfo).toHaveBeenCalled();
    });

    it("logs the delivery ID and retry count on enqueue", async () => {
      mockSend.mockResolvedValueOnce(1);
      const job = makeQueuedJob({ deliveryId: "d-123", retryCount: 2 });

      await enqueueJob(job);

      expect(mockLoggerInfo).toHaveBeenCalledWith(
        { kind: "legacy", deliveryId: "d-123", retryCount: 2 },
        "Job enqueued",
      );
    });
  });

  describe("tryDequeueJob", () => {
    it("returns null when the queue is empty (RPOP returns null)", async () => {
      mockSend.mockResolvedValueOnce(null);

      const result = await tryDequeueJob();

      expect(result).toBeNull();
      expect(mockSend).toHaveBeenCalledWith("RPOP", ["queue:jobs"]);
    });

    it("returns parsed QueuedJob when a job is available", async () => {
      const job = makeQueuedJob({ deliveryId: "d-found" });
      mockSend.mockResolvedValueOnce(JSON.stringify(job));

      const result = await tryDequeueJob();

      expect(result).not.toBeNull();
      expect(result!.deliveryId).toBe("d-found");
      expect(result!.repoOwner).toBe("test-owner");
    });

    it("returns null and logs error when JSON is malformed", async () => {
      mockSend.mockResolvedValueOnce("{invalid json}}}");

      const result = await tryDequeueJob();

      expect(result).toBeNull();
      expect(mockLoggerError).toHaveBeenCalledWith(
        "Failed to parse dequeued job, dropping poison pill",
      );
    });
  });

  describe("dequeueJob", () => {
    it("returns null when BRPOP times out (returns null)", async () => {
      mockSend.mockResolvedValueOnce(null);

      const result = await dequeueJob();

      expect(result).toBeNull();
      expect(mockSend).toHaveBeenCalledWith("BRPOP", ["queue:jobs", "5"]);
    });

    it("returns parsed QueuedJob from BRPOP [key, value] tuple", async () => {
      const job = makeQueuedJob({ deliveryId: "d-brpop" });
      mockSend.mockResolvedValueOnce(["queue:jobs", JSON.stringify(job)]);

      const result = await dequeueJob();

      expect(result).not.toBeNull();
      expect(result!.deliveryId).toBe("d-brpop");
    });

    it("returns null and logs error when JSON in BRPOP result is malformed", async () => {
      mockSend.mockResolvedValueOnce(["queue:jobs", "not-json!!!"]);

      const result = await dequeueJob();

      expect(result).toBeNull();
      expect(mockLoggerError).toHaveBeenCalledWith(
        "Failed to parse dequeued job, dropping poison pill",
      );
    });
  });

  describe("requeueJob", () => {
    it("re-enqueues with incremented retryCount when under max retries", async () => {
      mockSend.mockResolvedValueOnce(1); // LPUSH from enqueueJob
      const job = makeQueuedJob({ retryCount: 0 });

      const result = await requeueJob(job);

      expect(result).toBe(true);
      // The LPUSH call should contain retryCount: 1
      const lpushCall = mockSend.mock.calls[0];
      expect(lpushCall![0]).toBe("LPUSH");
      const serialized = JSON.parse(lpushCall![1][1] as string) as QueuedJob;
      expect(serialized.retryCount).toBe(1);
    });

    it("updates enqueuedAt timestamp on requeue", async () => {
      mockSend.mockResolvedValueOnce(1);
      const oldTimestamp = Date.now() - 60_000;
      const job = makeQueuedJob({ retryCount: 1, enqueuedAt: oldTimestamp });

      await requeueJob(job);

      const lpushCall = mockSend.mock.calls[0];
      const serialized = JSON.parse(lpushCall![1][1] as string) as QueuedJob;
      expect(serialized.enqueuedAt).toBeGreaterThan(oldTimestamp);
    });

    it("returns false and warns when max retries are exceeded", async () => {
      const job = makeQueuedJob({ retryCount: 3 });
      mockConfig.jobMaxRetries = 3;

      const result = await requeueJob(job);

      expect(result).toBe(false);
      expect(mockLoggerWarn).toHaveBeenCalled();
      // Should NOT have called LPUSH
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("returns false when retryCount equals jobMaxRetries", async () => {
      mockConfig.jobMaxRetries = 2;
      const job = makeQueuedJob({ retryCount: 2 });

      const result = await requeueJob(job);

      expect(result).toBe(false);
    });

    it("re-enqueues when retryCount is one less than jobMaxRetries", async () => {
      mockSend.mockResolvedValueOnce(1);
      mockConfig.jobMaxRetries = 3;
      const job = makeQueuedJob({ retryCount: 2 });

      const result = await requeueJob(job);

      expect(result).toBe(true);
    });

    it("preserves all other job fields on requeue", async () => {
      mockSend.mockResolvedValueOnce(1);
      const job = makeQueuedJob({
        deliveryId: "d-preserve",
        repoOwner: "owner-x",
        repoName: "repo-y",
        entityNumber: 99,
        isPR: false,
        eventName: "issues",
        triggerUsername: "admin",
        labels: ["feature", "urgent"],
        triggerBodyPreview: "please help",
        retryCount: 1,
      });

      await requeueJob(job);

      const lpushCall = mockSend.mock.calls[0];
      const serialized = JSON.parse(lpushCall![1][1] as string) as QueuedJob;
      expect(serialized.deliveryId).toBe("d-preserve");
      expect(serialized.repoOwner).toBe("owner-x");
      expect(serialized.repoName).toBe("repo-y");
      expect(serialized.entityNumber).toBe(99);
      expect(serialized.isPR).toBe(false);
      expect(serialized.eventName).toBe("issues");
      expect(serialized.triggerUsername).toBe("admin");
      expect(serialized.labels).toEqual(["feature", "urgent"]);
      expect(serialized.triggerBodyPreview).toBe("please help");
      expect(serialized.retryCount).toBe(2);
    });
  });

  describe("processingListKey", () => {
    it("namespaces the key with the instance id", () => {
      expect(processingListKey("orch-a")).toBe("queue:processing:orch-a");
    });
  });

  describe("leaseJob", () => {
    it("returns null when LMOVE reports an empty source", async () => {
      mockSend.mockResolvedValueOnce(null);

      const result = await leaseJob("orch-a");

      expect(result).toBeNull();
      expect(mockSend).toHaveBeenCalledWith("LMOVE", [
        "queue:jobs",
        "queue:processing:orch-a",
        "RIGHT",
        "LEFT",
      ]);
    });

    it("parses a leased job and returns the raw string alongside it", async () => {
      const job = makeQueuedJob({ deliveryId: "lease-1" });
      const raw = JSON.stringify(job);
      mockSend.mockResolvedValueOnce(raw);

      const result = await leaseJob("orch-a");

      expect(result).not.toBeNull();
      expect(result?.raw).toBe(raw);
      expect(result?.job.deliveryId).toBe("lease-1");
    });

    it("removes poison-pill JSON from the processing list and returns null", async () => {
      mockSend.mockResolvedValueOnce("not-valid-json");
      mockSend.mockResolvedValueOnce(1); // LREM result

      const result = await leaseJob("orch-a");

      expect(result).toBeNull();
      expect(mockSend).toHaveBeenCalledWith("LREM", [
        "queue:processing:orch-a",
        "1",
        "not-valid-json",
      ]);
    });
  });

  describe("releaseLeasedJob", () => {
    it("LREMs the raw element from the instance processing list", async () => {
      const raw = JSON.stringify(makeQueuedJob());
      await releaseLeasedJob("orch-a", raw);

      expect(mockSend).toHaveBeenCalledWith("LREM", ["queue:processing:orch-a", "1", raw]);
    });
  });

  describe("requeueLeasedJob", () => {
    it("increments retryCount and calls EVAL with processing + queue keys", async () => {
      const job = makeQueuedJob({ retryCount: 1 });
      const raw = JSON.stringify(job);

      const newRetry = await requeueLeasedJob("orch-a", raw, job);

      expect(newRetry).toBe(2);
      // eslint-disable-next-line max-nested-callbacks -- one-line predicate, no logic
      const call = mockSend.mock.calls.find((c) => c[0] === "EVAL");
      expect(call).toBeDefined();
      // EVAL args: [script, "2", procKey, queueKey, rawOldJson, rawNewJson]
      expect(call?.[1]?.[1]).toBe("2");
      expect(call?.[1]?.[2]).toBe("queue:processing:orch-a");
      expect(call?.[1]?.[3]).toBe("queue:jobs");
      expect(call?.[1]?.[4]).toBe(raw);
      const pushed = JSON.parse(call?.[1]?.[5] as string) as { retryCount: number };
      expect(pushed.retryCount).toBe(2);
    });
  });

  describe("recoverProcessingList", () => {
    it("drains the processing list back to queue:jobs and returns count", async () => {
      mockSend.mockResolvedValueOnce("job-a");
      mockSend.mockResolvedValueOnce("job-b");
      mockSend.mockResolvedValueOnce(null);

      const recovered = await recoverProcessingList("orch-a");

      expect(recovered).toBe(2);
      // Each LMOVE uses LEFT/LEFT so items end up at the HEAD of queue:jobs.
      expect(mockSend).toHaveBeenCalledWith("LMOVE", [
        "queue:processing:orch-a",
        "queue:jobs",
        "LEFT",
        "LEFT",
      ]);
    });

    it("returns 0 when the processing list is empty", async () => {
      mockSend.mockResolvedValueOnce(null);

      const recovered = await recoverProcessingList("orch-a");

      expect(recovered).toBe(0);
    });
  });
});
