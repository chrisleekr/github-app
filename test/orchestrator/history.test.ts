/**
 * Tests for src/orchestrator/history.ts: Execution history in Postgres.
 *
 * Mocks the db module (getDb) and valkey module (requireValkeyClient).
 * Does NOT mock daemon-registry: it uses the real module with mocked valkey
 * dependencies underneath, avoiding mock.module conflicts with
 * daemon-registry.test.ts in multi-file runs.
 *
 * Tests cover all execution lifecycle transitions: create, offered, running,
 * completed, failed, requeue, getState, orphaned, and stale recovery.
 */

import type { SQL } from "bun";
import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { CreateExecutionParams } from "../../src/orchestrator/history";

// Mock dependencies

const mockLoggerInfo = mock(() => {});
const mockLoggerWarn = mock(() => {});
const mockLoggerDebug = mock(() => {});

void mock.module("../../src/logger", () => ({
  logger: {
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mock(() => {}),
    debug: mockLoggerDebug,
    child: mock(() => ({
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    })),
  },
}));

// Mock Valkey (used by daemon-registry which is imported by history)
const mockVSend = mock(() => Promise.resolve(null));
void mock.module("../../src/orchestrator/valkey", () => ({
  requireValkeyClient: (): { send: typeof mockVSend } => ({ send: mockVSend }),
  getValkeyClient: (): { send: typeof mockVSend } => ({ send: mockVSend }),
  isValkeyHealthy: (): boolean => true,
  closeValkey: (): void => {},
}));

// Mock DB, SQL tagged template function
let mockDbResult: unknown[] = [];
const mockDbFn = mock((_strings: TemplateStringsArray, ..._values: unknown[]) =>
  Promise.resolve(mockDbResult),
);
let dbEnabled = true;

void mock.module("../../src/db", () => ({
  getDb: (): typeof mockDbFn | null => (dbEnabled ? mockDbFn : null),
  requireDb: (): typeof mockDbFn => mockDbFn,
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

// Import AFTER mocks, history.ts will use the mocked valkey for its
// transitive import of daemon-registry.decrementDaemonActiveJobs
const {
  createExecution,
  markExecutionOffered,
  markExecutionRunning,
  markExecutionCompleted,
  markExecutionFailed,
  requeueExecution,
  getExecutionState,
  getOrphanedExecutions,
  recoverStaleExecutions,
} = await import("../../src/orchestrator/history");

// Also import decrementDaemonActiveJobs to spy on it for stale recovery tests
const _daemonRegistry = await import("../../src/orchestrator/daemon-registry");

// Helpers

/** Type-safe accessor for mock call args, avoids `!` assertions and `as NonNullable<>`. */
function firstCall<T>(m: { mock: { calls: T[][] } }): T[] {
  const call = m.mock.calls[0];
  if (call === undefined) {
    throw new Error("Expected mock to have been called at least once");
  }
  return call;
}

// Test fixtures

function makeCreateParams(overrides: Partial<CreateExecutionParams> = {}): CreateExecutionParams {
  return {
    deliveryId: "delivery-001",
    repoOwner: "test-owner",
    repoName: "test-repo",
    entityNumber: 42,
    entityType: "pull_request",
    eventName: "issue_comment",
    triggerUsername: "user1",
    dispatchMode: "daemon",
    ...overrides,
  };
}

// Tests

beforeEach(() => {
  mockDbFn.mockClear();
  mockDbResult = [];
  dbEnabled = true;
  mockLoggerInfo.mockClear();
  mockLoggerWarn.mockClear();
  mockLoggerDebug.mockClear();
  mockVSend.mockClear();
  // Reset the mockVSend default behavior
  mockVSend.mockResolvedValue(null);
  mockConfig.staleExecutionThresholdMs = 600_000;
});

describe("createExecution", () => {
  it("throws when database is not configured", async () => {
    dbEnabled = false;

    let threw = false;
    try {
      await createExecution(makeCreateParams());
    } catch (e: unknown) {
      threw = true;
      expect((e as Error).message).toContain("Database not configured");
    }
    expect(threw).toBe(true);
  });

  it("returns the generated UUID from INSERT RETURNING", async () => {
    mockDbResult = [{ id: "uuid-123" }];

    const id = await createExecution(makeCreateParams());

    expect(id).toBe("uuid-123");
  });

  it("throws when INSERT RETURNING yields no row", async () => {
    mockDbResult = [];

    let threw = false;
    try {
      await createExecution(makeCreateParams());
    } catch (e: unknown) {
      threw = true;
      expect((e as Error).message).toContain("INSERT RETURNING yielded no row");
    }
    expect(threw).toBe(true);
  });

  it("passes contextJson to the INSERT when provided", async () => {
    mockDbResult = [{ id: "uuid-ctx" }];
    const context = {
      deliveryId: "d-1",
      repoOwner: "o",
      repoName: "r",
      entityNumber: 1,
      isPR: true,
      eventName: "issue_comment",
      triggerUsername: "u",
      triggerBody: "body",
      labels: [],
    };

    await createExecution(
      makeCreateParams({ contextJson: context as CreateExecutionParams["contextJson"] }),
    );

    expect(mockDbFn).toHaveBeenCalled();
    const call = firstCall(mockDbFn);
    const interpolatedValues = call.slice(1);
    const hasContext = interpolatedValues.some(
      (v) => typeof v === "object" && v !== null && "deliveryId" in (v as Record<string, unknown>),
    );
    expect(hasContext).toBe(true);
  });

  it("passes null contextJson when not provided", async () => {
    mockDbResult = [{ id: "uuid-no-ctx" }];

    await createExecution(makeCreateParams());

    expect(mockDbFn).toHaveBeenCalled();
    const call = firstCall(mockDbFn);
    const interpolatedValues = call.slice(1);
    expect(interpolatedValues).toContain(null);
  });

  it("writes dispatch_target column (migration 003) in all INSERT branches", async () => {
    // Regression for Copilot PR #20: without dispatch_target in the
    // INSERT, FR-014 aggregates read the DB default ('inline') regardless
    // of the resolved target.
    mockDbResult = [{ id: "uuid-target" }];

    await createExecution(makeCreateParams({ dispatchMode: "shared-runner" }));
    const defaultSql = (firstCall(mockDbFn)[0] as TemplateStringsArray).join("?");
    expect(defaultSql).toContain("dispatch_target");

    mockDbFn.mockClear();
    mockDbResult = [{ id: "uuid-reason" }];
    await createExecution(makeCreateParams({ dispatchMode: "daemon", dispatchReason: "label" }));
    const reasonSql = (firstCall(mockDbFn)[0] as TemplateStringsArray).join("?");
    expect(reasonSql).toContain("dispatch_target");

    mockDbFn.mockClear();
    mockDbResult = [{ id: "uuid-triage" }];
    await createExecution(
      makeCreateParams({
        dispatchMode: "isolated-job",
        dispatchReason: "triage",
        triageConfidence: 0.9,
        triageCostUsd: 0.0001,
        triageComplexity: "moderate",
      }),
    );
    const triageSql = (firstCall(mockDbFn)[0] as TemplateStringsArray).join("?");
    expect(triageSql).toContain("dispatch_target");
  });

  it("throws when triage fields are provided without dispatchReason", async () => {
    // Guard-rail for Copilot PR #20: triage_* columns must not be
    // persisted alongside the DB-default `static-default` reason.
    mockDbResult = [{ id: "uuid-guard" }];
    let threw = false;
    try {
      await createExecution(
        makeCreateParams({
          triageConfidence: 0.9,
          triageCostUsd: 0.0001,
          triageComplexity: "trivial",
        }),
      );
    } catch (e: unknown) {
      threw = true;
      expect((e as Error).message).toContain("dispatchReason is required");
    }
    expect(threw).toBe(true);
    expect(mockDbFn).not.toHaveBeenCalled();
  });
});

describe("markExecutionOffered", () => {
  it("updates status to offered with daemon ID when db is available", async () => {
    await markExecutionOffered("d-001", "daemon-5");

    expect(mockDbFn).toHaveBeenCalled();
    const call = firstCall(mockDbFn);
    const values = call.slice(1);
    expect(values).toContain("daemon-5");
    expect(values).toContain("d-001");
  });

  it("does nothing when db is not available", async () => {
    dbEnabled = false;

    await markExecutionOffered("d-001", "daemon-5");

    expect(mockDbFn).not.toHaveBeenCalled();
  });
});

describe("markExecutionRunning", () => {
  it("updates status to running when db is available", async () => {
    await markExecutionRunning("d-002");

    expect(mockDbFn).toHaveBeenCalled();
    const call = firstCall(mockDbFn);
    const values = call.slice(1);
    expect(values).toContain("d-002");
  });

  it("does nothing when db is not available", async () => {
    dbEnabled = false;

    await markExecutionRunning("d-002");

    expect(mockDbFn).not.toHaveBeenCalled();
  });
});

describe("markExecutionCompleted", () => {
  it("updates status to completed with result metrics", async () => {
    await markExecutionCompleted("d-003", {
      costUsd: 0.15,
      durationMs: 30000,
      numTurns: 5,
    });

    expect(mockDbFn).toHaveBeenCalled();
    const call = firstCall(mockDbFn);
    const values = call.slice(1);
    expect(values).toContain(0.15);
    expect(values).toContain(30000);
    expect(values).toContain(5);
  });

  it("passes null for missing result metrics", async () => {
    await markExecutionCompleted("d-004", {});

    expect(mockDbFn).toHaveBeenCalled();
    const call = firstCall(mockDbFn);
    const values = call.slice(1);
    const nullCount = values.filter((v) => v === null).length;
    expect(nullCount).toBeGreaterThanOrEqual(3);
  });

  it("does nothing when db is not available", async () => {
    dbEnabled = false;

    await markExecutionCompleted("d-003", { costUsd: 0.1 });

    expect(mockDbFn).not.toHaveBeenCalled();
  });
});

describe("markExecutionFailed", () => {
  it("updates status to failed with error message", async () => {
    await markExecutionFailed("d-005", "timeout exceeded");

    expect(mockDbFn).toHaveBeenCalled();
    const call = firstCall(mockDbFn);
    const values = call.slice(1);
    expect(values).toContain("timeout exceeded");
    expect(values).toContain("d-005");
  });

  it("does nothing when db is not available", async () => {
    dbEnabled = false;

    await markExecutionFailed("d-005", "error");

    expect(mockDbFn).not.toHaveBeenCalled();
  });
});

describe("requeueExecution", () => {
  it("updates status back to queued and clears daemon_id", async () => {
    await requeueExecution("d-006");

    expect(mockDbFn).toHaveBeenCalled();
    const call = firstCall(mockDbFn);
    const values = call.slice(1);
    expect(values).toContain("d-006");
  });

  it("does nothing when db is not available", async () => {
    dbEnabled = false;

    await requeueExecution("d-006");

    expect(mockDbFn).not.toHaveBeenCalled();
  });
});

describe("getExecutionState", () => {
  it("returns null when db is not available", async () => {
    dbEnabled = false;

    const result = await getExecutionState("d-007");

    expect(result).toBeNull();
  });

  it("returns null when no execution matches", async () => {
    mockDbResult = [];

    const result = await getExecutionState("d-notfound");

    expect(result).toBeNull();
  });

  it("returns status and daemonId from matching execution", async () => {
    mockDbResult = [{ status: "running", daemon_id: "daemon-10" }];

    const result = await getExecutionState("d-008");

    expect(result).toEqual({
      status: "running",
      daemonId: "daemon-10",
    });
  });

  it("returns null daemonId when daemon_id column is null", async () => {
    mockDbResult = [{ status: "queued", daemon_id: null }];

    const result = await getExecutionState("d-009");

    expect(result).toEqual({
      status: "queued",
      daemonId: null,
    });
  });
});

describe("getOrphanedExecutions", () => {
  it("returns empty array when db is not available", async () => {
    dbEnabled = false;

    const result = await getOrphanedExecutions("daemon-x");

    expect(result).toEqual([]);
  });

  it("returns empty array when no orphaned executions exist", async () => {
    mockDbResult = [];

    const result = await getOrphanedExecutions("daemon-x");

    expect(result).toEqual([]);
  });

  it("returns mapped delivery IDs and statuses for orphaned executions", async () => {
    mockDbResult = [
      { delivery_id: "d-10", status: "offered" },
      { delivery_id: "d-11", status: "running" },
    ];

    const result = await getOrphanedExecutions("daemon-y");

    expect(result).toEqual([
      { deliveryId: "d-10", status: "offered" },
      { deliveryId: "d-11", status: "running" },
    ]);
  });
});

describe("recoverStaleExecutions", () => {
  // For recoverStaleExecutions, the `db` parameter is a SQL tagged template
  // function passed directly (not from getDb()). We create a mock for it.
  let directDbCallCount: number;
  let directDbResults: unknown[][];
  let mockDirectDb: ReturnType<typeof mock>;

  beforeEach(() => {
    directDbCallCount = 0;
    directDbResults = [];
    mockDirectDb = mock((_strings: TemplateStringsArray, ..._values: unknown[]) => {
      // eslint-disable-next-line security/detect-object-injection
      const result = directDbResults[directDbCallCount] ?? [];
      directDbCallCount++;
      return Promise.resolve(result);
    });
  });

  it("does nothing when no stale executions exist", async () => {
    directDbResults = [[]];

    await recoverStaleExecutions(mockDirectDb as unknown as SQL);

    expect(directDbCallCount).toBe(1);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it("marks stale running executions as failed", async () => {
    directDbResults = [
      [{ id: "exec-1", delivery_id: "d-stale-1", daemon_id: "daemon-a", status: "running" }],
      [],
    ];

    await recoverStaleExecutions(mockDirectDb as unknown as SQL);

    expect(directDbCallCount).toBe(2);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: "d-stale-1",
        daemonId: "daemon-a",
        previousStatus: "running",
      }),
      "Recovered stale execution on startup",
    );
  });

  it("marks stale offered executions as failed", async () => {
    directDbResults = [
      [{ id: "exec-2", delivery_id: "d-stale-2", daemon_id: "daemon-b", status: "offered" }],
      [],
    ];

    await recoverStaleExecutions(mockDirectDb as unknown as SQL);

    expect(directDbCallCount).toBe(2);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        previousStatus: "offered",
      }),
      "Recovered stale execution on startup",
    );
  });

  it("handles multiple stale executions", async () => {
    directDbResults = [
      [
        { id: "e-1", delivery_id: "d-1", daemon_id: "daemon-1", status: "running" },
        { id: "e-2", delivery_id: "d-2", daemon_id: "daemon-2", status: "offered" },
        { id: "e-3", delivery_id: "d-3", daemon_id: null, status: "offered" },
      ],
      [],
      [],
      [],
    ];

    await recoverStaleExecutions(mockDirectDb as unknown as SQL);

    expect(directDbCallCount).toBe(4);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { count: 3 },
      "Recovered stale executions on startup",
    );
  });

  it("decrements active_jobs via valkey for daemons with non-null daemon_id", async () => {
    mockVSend.mockClear();
    // The Lua EVAL for decrement will be called through the real daemon-registry module
    // which uses mockVSend since valkey is mocked.
    mockVSend.mockResolvedValue(0); // Lua script returns 0 (decremented from 1)

    directDbResults = [
      [{ id: "e-decr", delivery_id: "d-decr", daemon_id: "daemon-decr", status: "running" }],
      [],
    ];

    await recoverStaleExecutions(mockDirectDb as unknown as SQL);

    // decrementDaemonActiveJobs should have been called, which sends EVAL to valkey
    expect(mockVSend).toHaveBeenCalledWith(
      "EVAL",
      expect.arrayContaining(["daemon:daemon-decr:active_jobs"]),
    );
  });

  it("skips active_jobs decrement when daemon_id is null", async () => {
    mockVSend.mockClear();

    directDbResults = [
      [{ id: "e-null", delivery_id: "d-null", daemon_id: null, status: "offered" }],
      [],
    ];

    await recoverStaleExecutions(mockDirectDb as unknown as SQL);

    // No EVAL should have been called since daemon_id is null
    const evalCalls = mockVSend.mock.calls.filter((c) => (c as unknown[])[0] === "EVAL");
    expect(evalCalls.length).toBe(0);
  });

  it("catches and logs errors from decrementDaemonActiveJobs", async () => {
    mockVSend.mockClear();
    // Make the EVAL call throw
    mockVSend.mockRejectedValueOnce(new Error("Valkey down"));

    directDbResults = [
      [{ id: "e-err", delivery_id: "d-err", daemon_id: "daemon-err", status: "running" }],
      [],
    ];

    await recoverStaleExecutions(mockDirectDb as unknown as SQL);

    // Should not throw, the error is caught and logged
    expect(mockLoggerDebug).toHaveBeenCalledWith(
      expect.objectContaining({
        daemonId: "daemon-err",
      }),
      "Failed to decrement active_jobs for stale execution (daemon may be deregistered)",
    );
  });

  it("uses staleExecutionThresholdMs from config", async () => {
    mockConfig.staleExecutionThresholdMs = 300_000;
    directDbResults = [[]];

    await recoverStaleExecutions(mockDirectDb as unknown as SQL);

    const call = firstCall(mockDirectDb);
    const interpolatedValues = call.slice(1);
    // thresholdMs / 1000 = 300
    expect(interpolatedValues).toContain(300);
  });
});
