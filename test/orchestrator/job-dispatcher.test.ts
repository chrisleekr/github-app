/**
 * Tests for src/orchestrator/job-dispatcher.ts
 *
 * Covers: inferRequiredTools, selectDaemon, dispatchJob, handleJobAccept,
 * handleJobReject, getPendingOffer, removePendingOffer, and offer timeout logic.
 *
 * All external dependencies are mocked via mock.module().
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { QueuedJob } from "../../src/orchestrator/job-queue";
import {
  DISPATCHER_LOG_EVENTS,
  DispatcherNoEligibleDaemonLogSchema,
  DispatcherOfferLogSchema,
} from "../../src/orchestrator/log-fields";
import type { DaemonCapabilities, DaemonInfo } from "../../src/shared/daemon-types";

// ─── Mocks ────────────────────────────────────────────────────────────────────

// connection-handler
const mockConnections = new Map<string, { sendText: ReturnType<typeof mock> }>();
const mockGetConnections = mock(() => mockConnections);
const daemonInfoStore = new Map<string, DaemonInfo>();
const mockGetDaemonInfo = mock((id: string) => daemonInfoStore.get(id));
const mockIsDaemonDraining = mock((_id: string) => false);

void mock.module("../../src/orchestrator/connection-handler", () => ({
  getConnections: mockGetConnections,
  getDaemonInfo: mockGetDaemonInfo,
  isDaemonDraining: mockIsDaemonDraining,
  handleWsOpen: mock(() => {}),
  handleWsClose: mock(() => {}),
  handleDaemonMessage: mock(() => {}),
}));

// daemon-registry
const mockGetActiveDaemons = mock((): Promise<string[]> => Promise.resolve([]));
const mockGetDaemonActiveJobs = mock((): Promise<number> => Promise.resolve(0));

void mock.module("../../src/orchestrator/daemon-registry", () => ({
  getActiveDaemons: mockGetActiveDaemons,
  getDaemonActiveJobs: mockGetDaemonActiveJobs,
  registerDaemon: mock(() => Promise.resolve()),
  deregisterDaemon: mock(() => Promise.resolve()),
  refreshDaemonTtl: mock(() => Promise.resolve()),
  incrementDaemonActiveJobs: mock(() => Promise.resolve()),
  decrementDaemonActiveJobs: mock(() => Promise.resolve()),
}));

// history
const mockMarkExecutionOffered = mock(() => Promise.resolve());
const mockMarkExecutionFailed = mock(() => Promise.resolve());
const mockRequeueExecution = mock(() => Promise.resolve());

void mock.module("../../src/orchestrator/history", () => ({
  markExecutionOffered: mockMarkExecutionOffered,
  markExecutionFailed: mockMarkExecutionFailed,
  requeueExecution: mockRequeueExecution,
  markExecutionRunning: mock(() => Promise.resolve()),
  markExecutionCompleted: mock(() => Promise.resolve()),
  getExecutionState: mock(() => Promise.resolve(null)),
  getOrphanedExecutions: mock(() => Promise.resolve([])),
  createExecution: mock(() => Promise.resolve("exec-id")),
}));

// job-queue
const mockRequeueJob = mock((): Promise<boolean> => Promise.resolve(true));

void mock.module("../../src/orchestrator/job-queue", () => ({
  requeueJob: mockRequeueJob,
  enqueueJob: mock(() => Promise.resolve()),
  tryDequeueJob: mock(() => Promise.resolve(null)),
  dequeueJob: mock(() => Promise.resolve(null)),
  isScopedJob: () => false,
  SCOPED_JOB_KINDS: ["scoped-rebase", "scoped-fix-thread", "scoped-open-pr"],
  // C2: job-dispatcher's `reconstructJobFromOffer` re-validates
  // `offer.scoped` via the discriminated-union schema; the legacy-path
  // tests in this file never set `offer.scoped`, so a permanently-failing
  // safeParse keeps the legacy reconstruct branch live.
  QueuedJobSchema: { safeParse: () => ({ success: false, error: { issues: [] } }) },
}));

// concurrency
void mock.module("../../src/orchestrator/concurrency", () => ({
  decrementActiveCount: mock(() => {}),
  incrementActiveCount: mock(() => {}),
  getActiveCount: mock(() => 0),
  isAtCapacity: mock(() => false),
}));

// ws-server
void mock.module("../../src/orchestrator/ws-server", () => ({
  sendError: mock(() => {}),
  startWebSocketServer: mock(() => ({})),
  stopWebSocketServer: mock(() => {}),
}));

// db
void mock.module("../../src/db", () => ({
  getDb: mock(() => null),
  requireDb: mock(() => {
    throw new Error("no db");
  }),
}));

void mock.module("../../src/db/index", () => ({
  getDb: mock(() => null),
  requireDb: mock(() => {
    throw new Error("no db");
  }),
}));

// Capture structured log lines so a test can assert the REAL emitter (not just
// a hand-written schema fixture) satisfies the dispatcher log schemas, incl.
// the queue_wait_ms field (issue #200).
const capturedLogs: Record<string, unknown>[] = [];
void mock.module("../../src/logger", () => {
  const record = (obj: unknown): void => {
    if (obj !== null && typeof obj === "object") capturedLogs.push(obj as Record<string, unknown>);
  };
  const log = {
    info: record,
    debug: record,
    warn: record,
    error: record,
    fatal: record,
    trace: record,
    child: () => log,
  };
  return { logger: log };
});

// Import AFTER all mocks
const {
  inferRequiredTools,
  selectDaemon,
  dispatchJob,
  handleJobAccept,
  handleJobReject,
  getPendingOffer,
  removePendingOffer,
} = await import("../../src/orchestrator/job-dispatcher");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFakeCapabilities(overrides?: Partial<DaemonCapabilities>): DaemonCapabilities {
  return {
    platform: "linux",
    shells: [{ name: "bash", path: "/bin/bash", version: "5.0", functional: true }],
    packageManagers: [{ name: "bun", path: "/usr/bin/bun", version: "1.3.8", functional: true }],
    cliTools: [
      { name: "git", path: "/usr/bin/git", version: "2.40", functional: true },
      { name: "node", path: "/usr/bin/node", version: "22.0", functional: true },
    ],
    containerRuntime: null,
    authContexts: [],
    resources: { cpuCount: 4, memoryTotalMb: 8192, memoryFreeMb: 4096, diskFreeMb: 50000 },
    network: { hostname: "host-1" },
    cachedRepos: [],
    ephemeral: false,
    maxUptimeMs: null,
    ...overrides,
  };
}

function makeDaemonInfo(id: string, overrides?: Partial<DaemonInfo>): DaemonInfo {
  return {
    id,
    hostname: "host-1",
    platform: "linux",
    osVersion: "6.1",
    capabilities: makeFakeCapabilities(),
    status: "active",
    protocolVersion: "1.0.0",
    appVersion: "0.1.0",
    activeJobs: 0,
    lastSeenAt: Date.now(),
    firstSeenAt: Date.now(),
    ...overrides,
  };
}

function makeQueuedJob(overrides?: Partial<QueuedJob>): QueuedJob {
  return {
    // A real QueuedJob always carries the `kind` discriminator; default to
    // legacy so emitted log lines satisfy the dispatcher schemas.
    kind: "legacy",
    deliveryId: `del-${crypto.randomUUID().slice(0, 8)}`,
    repoOwner: "test-owner",
    repoName: "test-repo",
    entityNumber: 42,
    isPR: true,
    eventName: "issue_comment",
    triggerUsername: "testuser",
    labels: [],
    triggerBodyPreview: "fix the bug",
    enqueuedAt: Date.now(),
    retryCount: 0,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockConnections.clear();
  daemonInfoStore.clear();
  capturedLogs.length = 0;

  mockGetActiveDaemons.mockClear();
  mockGetDaemonActiveJobs.mockClear();
  mockMarkExecutionOffered.mockClear();
  mockMarkExecutionFailed.mockClear();
  mockRequeueExecution.mockClear();
  mockRequeueJob.mockClear();
  mockIsDaemonDraining.mockClear();
  mockGetDaemonInfo.mockClear();

  // Restore default implementations
  mockGetActiveDaemons.mockImplementation(() => Promise.resolve([]));
  mockGetDaemonActiveJobs.mockImplementation(() => Promise.resolve(0));
  mockIsDaemonDraining.mockImplementation(() => false);
  mockGetDaemonInfo.mockImplementation((id: string) => daemonInfoStore.get(id));
  mockRequeueJob.mockImplementation(() => Promise.resolve(true));
});

describe("inferRequiredTools", () => {
  it("always includes baseline tools (git, bun, node)", () => {
    const tools = inferRequiredTools([], "");
    expect(tools).toContain("git");
    expect(tools).toContain("bun");
    expect(tools).toContain("node");
  });

  it("infers docker from label", () => {
    const tools = inferRequiredTools(["bot:docker"], "");
    expect(tools).toContain("docker");
  });

  it("infers python3 from label", () => {
    const tools = inferRequiredTools(["python"], "");
    expect(tools).toContain("python3");
  });

  it("infers aws from label", () => {
    const tools = inferRequiredTools(["aws"], "");
    expect(tools).toContain("aws");
  });

  it("infers make from label", () => {
    const tools = inferRequiredTools(["make"], "");
    expect(tools).toContain("make");
  });

  it("infers docker from trigger body keyword 'container'", () => {
    const tools = inferRequiredTools([], "need to build a container image");
    expect(tools).toContain("docker");
  });

  it("infers docker from trigger body keyword 'docker'", () => {
    const tools = inferRequiredTools([], "run docker compose up");
    expect(tools).toContain("docker");
  });

  it("infers python3 from trigger body", () => {
    const tools = inferRequiredTools([], "run the python script");
    expect(tools).toContain("python3");
  });

  it("infers curl from trigger body", () => {
    const tools = inferRequiredTools([], "use curl to fetch the data");
    expect(tools).toContain("curl");
  });

  it("infers make from trigger body with 'makefile'", () => {
    const tools = inferRequiredTools([], "check the Makefile");
    expect(tools).toContain("make");
  });

  it("infers make from trigger body with 'make '", () => {
    const tools = inferRequiredTools([], "run make build");
    expect(tools).toContain("make");
  });

  it("deduplicates when both label and body match", () => {
    const tools = inferRequiredTools(["docker"], "deploy docker container");
    const dockerCount = tools.filter((t) => t === "docker").length;
    expect(dockerCount).toBe(1);
  });
});

describe("selectDaemon", () => {
  it("returns null when no active daemons", async () => {
    mockGetActiveDaemons.mockImplementation(() => Promise.resolve([]));
    const result = await selectDaemon(["git", "bun", "node"]);
    expect(result).toBeNull();
  });

  it("returns null when no daemon matches required tools", async () => {
    mockGetActiveDaemons.mockImplementation(() => Promise.resolve(["d1"]));
    daemonInfoStore.set("d1", makeDaemonInfo("d1"));

    const result = await selectDaemon(["git", "bun", "node", "docker"]);
    expect(result).toBeNull();
  });

  it("selects daemon matching required tools", async () => {
    mockGetActiveDaemons.mockImplementation(() => Promise.resolve(["d1"]));
    daemonInfoStore.set("d1", makeDaemonInfo("d1"));

    const result = await selectDaemon(["git", "bun", "node"]);
    expect(result).toBe("d1");
  });

  it("skips draining daemons", async () => {
    mockGetActiveDaemons.mockImplementation(() => Promise.resolve(["d1", "d2"]));
    daemonInfoStore.set("d1", makeDaemonInfo("d1"));
    daemonInfoStore.set("d2", makeDaemonInfo("d2"));
    mockIsDaemonDraining.mockImplementation((id: string) => id === "d1");

    const result = await selectDaemon(["git", "bun", "node"]);
    expect(result).toBe("d2");
  });

  it("skips non-active status daemons", async () => {
    mockGetActiveDaemons.mockImplementation(() => Promise.resolve(["d1", "d2"]));
    daemonInfoStore.set("d1", makeDaemonInfo("d1", { status: "inactive" }));
    daemonInfoStore.set("d2", makeDaemonInfo("d2"));

    const result = await selectDaemon(["git", "bun", "node"]);
    expect(result).toBe("d2");
  });

  it("prefers non-ephemeral daemon", async () => {
    mockGetActiveDaemons.mockImplementation(() => Promise.resolve(["d-eph", "d-perm"]));
    daemonInfoStore.set(
      "d-eph",
      makeDaemonInfo("d-eph", {
        capabilities: makeFakeCapabilities({ ephemeral: true }),
      }),
    );
    daemonInfoStore.set(
      "d-perm",
      makeDaemonInfo("d-perm", {
        capabilities: makeFakeCapabilities({ ephemeral: false }),
      }),
    );

    const result = await selectDaemon(["git", "bun", "node"]);
    expect(result).toBe("d-perm");
  });

  it("selects least loaded daemon among same type", async () => {
    mockGetActiveDaemons.mockImplementation(() => Promise.resolve(["d1", "d2"]));
    daemonInfoStore.set("d1", makeDaemonInfo("d1"));
    daemonInfoStore.set("d2", makeDaemonInfo("d2"));

    let callCount = 0;
    mockGetDaemonActiveJobs.mockImplementation(() => {
      callCount++;
      return Promise.resolve(callCount === 1 ? 5 : 1);
    });

    const result = await selectDaemon(["git", "bun", "node"]);
    expect(result).toBe("d2");
  });

  it("skips daemons with undefined info", async () => {
    mockGetActiveDaemons.mockImplementation(() => Promise.resolve(["d-unknown", "d-known"]));
    // d-unknown has no info in the store
    daemonInfoStore.set("d-known", makeDaemonInfo("d-known"));

    const result = await selectDaemon(["git", "bun", "node"]);
    expect(result).toBe("d-known");
  });

  it("matches container runtime as docker tool", async () => {
    mockGetActiveDaemons.mockImplementation(() => Promise.resolve(["d1"]));
    daemonInfoStore.set(
      "d1",
      makeDaemonInfo("d1", {
        capabilities: makeFakeCapabilities({
          containerRuntime: {
            name: "docker",
            path: "/usr/bin/docker",
            version: "24.0",
            daemonRunning: true,
            composeAvailable: true,
          },
        }),
      }),
    );

    const result = await selectDaemon(["git", "bun", "node", "docker"]);
    expect(result).toBe("d1");
  });

  it("does not match container runtime when daemon is not running", async () => {
    mockGetActiveDaemons.mockImplementation(() => Promise.resolve(["d1"]));
    daemonInfoStore.set(
      "d1",
      makeDaemonInfo("d1", {
        capabilities: makeFakeCapabilities({
          containerRuntime: {
            name: "docker",
            path: "/usr/bin/docker",
            version: "24.0",
            daemonRunning: false,
            composeAvailable: true,
          },
        }),
      }),
    );

    const result = await selectDaemon(["git", "bun", "node", "docker"]);
    expect(result).toBeNull();
  });
});

describe("dispatchJob", () => {
  it("returns false when no daemon available", async () => {
    const result = await dispatchJob(makeQueuedJob());
    expect(result).toBe(false);
    // The real emitter must produce a schema-valid no_eligible_daemon line
    // carrying queue_wait_ms (issue #200).
    const missLog = capturedLogs.find(
      (l) => l["event"] === DISPATCHER_LOG_EVENTS.no_eligible_daemon,
    );
    expect(missLog).toBeDefined();
    expect(DispatcherNoEligibleDaemonLogSchema.safeParse(missLog).success).toBe(true);
    expect(typeof missLog?.["queue_wait_ms"]).toBe("number");
  });

  it("returns false when daemon has no active connection", async () => {
    mockGetActiveDaemons.mockImplementation(() => Promise.resolve(["d1"]));
    daemonInfoStore.set("d1", makeDaemonInfo("d1"));
    // No connection in mockConnections

    const result = await dispatchJob(makeQueuedJob());
    expect(result).toBe(false);
  });

  it("dispatches job to available daemon", async () => {
    const fakeWs = { sendText: mock(() => {}) };
    mockGetActiveDaemons.mockImplementation(() => Promise.resolve(["d1"]));
    daemonInfoStore.set("d1", makeDaemonInfo("d1"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockConnections.set("d1", fakeWs as any);

    const job = makeQueuedJob({ deliveryId: "dispatch-test" });
    const result = await dispatchJob(job);

    expect(result).toBe(true);
    expect(mockMarkExecutionOffered).toHaveBeenCalledWith("dispatch-test", "d1");
    expect(fakeWs.sendText).toHaveBeenCalled();

    // Verify job:offer message
    const sentText = (fakeWs.sendText as ReturnType<typeof mock>).mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(sentText) as { type: string; payload: { deliveryId: string } };
    expect(parsed.type).toBe("job:offer");
    expect(parsed.payload.deliveryId).toBe("dispatch-test");

    // The real emitter must produce a schema-valid offer.sent line carrying
    // queue_wait_ms (issue #200).
    const offerLog = capturedLogs.find((l) => l["event"] === DISPATCHER_LOG_EVENTS.offer_sent);
    expect(offerLog).toBeDefined();
    expect(DispatcherOfferLogSchema.safeParse(offerLog).success).toBe(true);
    expect(typeof offerLog?.["queue_wait_ms"]).toBe("number");
  });

  it("creates pending offer with correct metadata", async () => {
    const fakeWs = { sendText: mock(() => {}) };
    mockGetActiveDaemons.mockImplementation(() => Promise.resolve(["d1"]));
    daemonInfoStore.set("d1", makeDaemonInfo("d1"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockConnections.set("d1", fakeWs as any);

    const job = makeQueuedJob({
      deliveryId: "meta-test",
      repoOwner: "owner1",
      repoName: "repo1",
      entityNumber: 99,
      isPR: false,
      triggerUsername: "bot",
      labels: ["bug"],
      triggerBodyPreview: "fix it",
    });

    await dispatchJob(job);

    // The sent message has an offerId in its `id` field
    const sentText = (fakeWs.sendText as ReturnType<typeof mock>).mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(sentText) as { id: string };
    const offerId = parsed.id;

    const offer = getPendingOffer(offerId);
    if (offer === undefined) {
      throw new Error("Expected offer to be defined");
    }
    expect(offer.deliveryId).toBe("meta-test");
    expect(offer.repoOwner).toBe("owner1");
    expect(offer.repoName).toBe("repo1");
    expect(offer.triggerUsername).toBe("bot");
    expect(offer.labels).toEqual(["bug"]);

    // Cleanup
    removePendingOffer(offerId);
  });
});

describe("getPendingOffer / removePendingOffer", () => {
  it("returns undefined for non-existent offer", () => {
    expect(getPendingOffer("nonexistent")).toBeUndefined();
  });

  it("removePendingOffer is a no-op for non-existent offer", () => {
    expect(() => {
      removePendingOffer("nonexistent");
    }).not.toThrow();
  });

  it("removePendingOffer clears the timer and deletes the offer", async () => {
    // Dispatch a job to create a pending offer
    const fakeWs = { sendText: mock(() => {}) };
    mockGetActiveDaemons.mockImplementation(() => Promise.resolve(["d1"]));
    daemonInfoStore.set("d1", makeDaemonInfo("d1"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockConnections.set("d1", fakeWs as any);

    await dispatchJob(makeQueuedJob());

    const sentText = (fakeWs.sendText as ReturnType<typeof mock>).mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(sentText) as { id: string };
    const offerId = parsed.id;

    expect(getPendingOffer(offerId)).toBeDefined();

    removePendingOffer(offerId);

    expect(getPendingOffer(offerId)).toBeUndefined();
  });
});

describe("handleJobAccept", () => {
  it("sends job:payload to the daemon", () => {
    const fakeWs = { sendText: mock(() => {}) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockConnections.set("d1", fakeWs as any);

    handleJobAccept({
      offerId: "offer-1",
      daemonId: "d1",
      deliveryId: "del-1",
      installationToken: "ghs_token",
      contextJson: { owner: "o", repo: "r" },
      maxTurns: 25,
      allowedTools: ["Bash", "Read"],
      envVars: { CUSTOM: "val" },
      memory: [{ id: "m1", category: "convention", content: "use strict", pinned: false }],
    });

    expect(fakeWs.sendText).toHaveBeenCalled();
    const sentText = (fakeWs.sendText as ReturnType<typeof mock>).mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(sentText) as {
      type: string;
      payload: {
        installationToken: string;
        maxTurns: number;
        allowedTools: string[];
        envVars: Record<string, string>;
        memory: { id: string }[];
      };
    };
    expect(parsed.type).toBe("job:payload");
    expect(parsed.payload.installationToken).toBe("ghs_token");
    expect(parsed.payload.maxTurns).toBe(25);
    expect(parsed.payload.allowedTools).toEqual(["Bash", "Read"]);
    expect(parsed.payload.envVars).toEqual({ CUSTOM: "val" });
    expect(parsed.payload.memory).toHaveLength(1);
  });

  it("omits envVars when empty", () => {
    const fakeWs = { sendText: mock(() => {}) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockConnections.set("d2", fakeWs as any);

    handleJobAccept({
      offerId: "offer-2",
      daemonId: "d2",
      deliveryId: "del-2",
      installationToken: "ghs_token",
      contextJson: {},
      maxTurns: 10,
      allowedTools: [],
      envVars: {},
      memory: [],
    });

    const sentText = (fakeWs.sendText as ReturnType<typeof mock>).mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(sentText) as { payload: Record<string, unknown> };
    expect(parsed.payload.envVars).toBeUndefined();
    expect(parsed.payload.memory).toBeUndefined();
  });

  it("returns early when daemon disconnected", () => {
    // No connection in map
    expect(() => {
      handleJobAccept({
        offerId: "offer-gone",
        daemonId: "d-gone",
        deliveryId: "del-gone",
        installationToken: "tok",
        contextJson: {},
        maxTurns: 10,
        allowedTools: [],
        envVars: {},
        memory: [],
      });
    }).not.toThrow();
  });
});

describe("handleJobReject", () => {
  it("re-queues the job on rejection", async () => {
    // First create a pending offer via dispatchJob
    const fakeWs = { sendText: mock(() => {}) };
    mockGetActiveDaemons.mockImplementation(() => Promise.resolve(["d1"]));
    daemonInfoStore.set("d1", makeDaemonInfo("d1"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockConnections.set("d1", fakeWs as any);

    await dispatchJob(makeQueuedJob({ deliveryId: "reject-test" }));

    const sentText = (fakeWs.sendText as ReturnType<typeof mock>).mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(sentText) as { id: string };
    const offerId = parsed.id;

    await handleJobReject(offerId, "no capacity");

    expect(mockRequeueExecution).toHaveBeenCalledWith("reject-test");
    expect(mockRequeueJob).toHaveBeenCalled();
    // Offer should be removed
    expect(getPendingOffer(offerId)).toBeUndefined();
  });

  it("marks execution failed when max retries exceeded on reject", async () => {
    mockRequeueJob.mockImplementation(() => Promise.resolve(false));

    const fakeWs = { sendText: mock(() => {}) };
    mockGetActiveDaemons.mockImplementation(() => Promise.resolve(["d1"]));
    daemonInfoStore.set("d1", makeDaemonInfo("d1"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockConnections.set("d1", fakeWs as any);

    await dispatchJob(makeQueuedJob({ deliveryId: "reject-max" }));

    const sentText = (fakeWs.sendText as ReturnType<typeof mock>).mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(sentText) as { id: string };
    const offerId = parsed.id;

    await handleJobReject(offerId, "tool missing");

    expect(mockMarkExecutionFailed).toHaveBeenCalled();
    const args = mockMarkExecutionFailed.mock.calls[0] as [string, string];
    expect(args[1]).toContain("tool missing");
  });

  it("returns early for unknown offer on reject", async () => {
    await handleJobReject("nonexistent-offer", "reason");
    expect(mockRequeueExecution).not.toHaveBeenCalled();
  });
});

describe("offer timeout", () => {
  it("re-queues job on offer timeout", async () => {
    // We need a very short timeout to test. The default config.offerTimeoutMs
    // is used in dispatchJob. We'll set a short one by manipulating config.
    const { config } = await import("../../src/config");
    const originalTimeout = config.offerTimeoutMs;

    try {
      // Set a very short timeout
      (config as { offerTimeoutMs: number }).offerTimeoutMs = 50;

      const fakeWs = { sendText: mock(() => {}) };
      mockGetActiveDaemons.mockImplementation(() => Promise.resolve(["d1"]));
      daemonInfoStore.set("d1", makeDaemonInfo("d1"));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockConnections.set("d1", fakeWs as any);

      await dispatchJob(makeQueuedJob({ deliveryId: "timeout-test" }));

      // Wait for timeout to fire
      await new Promise((r) => setTimeout(r, 100));

      expect(mockRequeueExecution).toHaveBeenCalledWith("timeout-test");
      expect(mockRequeueJob).toHaveBeenCalled();
    } finally {
      (config as { offerTimeoutMs: number }).offerTimeoutMs = originalTimeout;
    }
  });

  it("timeout is a no-op when offer already handled", async () => {
    const { config } = await import("../../src/config");
    const originalTimeout = config.offerTimeoutMs;

    try {
      (config as { offerTimeoutMs: number }).offerTimeoutMs = 50;

      const fakeWs = { sendText: mock(() => {}) };
      mockGetActiveDaemons.mockImplementation(() => Promise.resolve(["d1"]));
      daemonInfoStore.set("d1", makeDaemonInfo("d1"));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockConnections.set("d1", fakeWs as any);

      await dispatchJob(makeQueuedJob({ deliveryId: "timeout-noop" }));

      // Get the offerId and remove the offer (as if accepted)
      const sentText = (fakeWs.sendText as ReturnType<typeof mock>).mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(sentText) as { id: string };
      removePendingOffer(parsed.id);

      // Wait for timeout to fire
      await new Promise((r) => setTimeout(r, 100));

      // Should NOT have re-queued (offer was already removed)
      expect(mockRequeueExecution).not.toHaveBeenCalled();
    } finally {
      (config as { offerTimeoutMs: number }).offerTimeoutMs = originalTimeout;
    }
  });

  it("marks execution failed on timeout when max retries exceeded", async () => {
    const { config } = await import("../../src/config");
    const originalTimeout = config.offerTimeoutMs;
    mockRequeueJob.mockImplementation(() => Promise.resolve(false));

    try {
      (config as { offerTimeoutMs: number }).offerTimeoutMs = 50;

      const fakeWs = { sendText: mock(() => {}) };
      mockGetActiveDaemons.mockImplementation(() => Promise.resolve(["d1"]));
      daemonInfoStore.set("d1", makeDaemonInfo("d1"));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockConnections.set("d1", fakeWs as any);

      await dispatchJob(makeQueuedJob({ deliveryId: "timeout-maxretry" }));

      // Wait for timeout
      await new Promise((r) => setTimeout(r, 100));

      expect(mockMarkExecutionFailed).toHaveBeenCalled();
      const args = mockMarkExecutionFailed.mock.calls[0] as [string, string];
      expect(args[0]).toBe("timeout-maxretry");
      expect(args[1]).toContain("maximum retries");
    } finally {
      (config as { offerTimeoutMs: number }).offerTimeoutMs = originalTimeout;
    }
  });
});
