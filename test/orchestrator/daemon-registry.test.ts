/**
 * Tests for src/orchestrator/daemon-registry.ts: Daemon registration with Valkey + Postgres.
 *
 * Mocks valkey (requireValkeyClient) and db (getDb) modules.
 * Tests cover register, deregister, TTL refresh, active daemon listing,
 * active job count read/increment/decrement, and Lua script edge cases.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { DaemonCapabilities } from "../../src/shared/daemon-types";
import type { DaemonRegisterMessage } from "../../src/shared/ws-messages";

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

// Mock Valkey client
const mockSend = mock(() => Promise.resolve(null));

void mock.module("../../src/orchestrator/valkey", () => ({
  requireValkeyClient: (): { send: typeof mockSend } => ({
    send: mockSend,
  }),
  getValkeyClient: (): { send: typeof mockSend } => ({
    send: mockSend,
  }),
  isValkeyHealthy: (): boolean => true,
  closeValkey: (): void => {},
}));

// Mock DB, SQL tagged template function
// The tagged template is called as db`SQL string` which calls the function
// with template parts and interpolated values.
let mockDbResult: unknown[] = [];
const mockDbFn = mock((_strings: TemplateStringsArray, ..._values: unknown[]) =>
  Promise.resolve(mockDbResult),
);
// Make the mock callable as a tagged template by ensuring it's a function
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

// Import AFTER mocks
const {
  registerDaemon,
  deregisterDaemon,
  refreshDaemonTtl,
  getActiveDaemons,
  getDaemonActiveJobs,
  incrementDaemonActiveJobs,
  decrementDaemonActiveJobs,
} = await import("../../src/orchestrator/daemon-registry");

// Test fixtures

function makeCapabilities(overrides: Partial<DaemonCapabilities> = {}): DaemonCapabilities {
  return {
    platform: "linux",
    shells: [{ name: "bash", path: "/bin/bash", version: "5.2", functional: true }],
    packageManagers: [{ name: "npm", path: "/usr/bin/npm", version: "10.0", functional: true }],
    cliTools: [{ name: "git", path: "/usr/bin/git", version: "2.40", functional: true }],
    containerRuntime: null,
    authContexts: ["github"],
    resources: {
      cpuCount: 4,
      memoryTotalMb: 8192,
      memoryFreeMb: 4096,
      diskFreeMb: 50000,
    },
    network: { hostname: "test-host" },
    cachedRepos: [],
    ephemeral: false,
    maxUptimeMs: null,
    ...overrides,
  };
}

function makeRegisterMessage(
  overrides: Partial<DaemonRegisterMessage["payload"]> = {},
): DaemonRegisterMessage {
  return {
    type: "daemon:register",
    id: "00000000-0000-0000-0000-000000000001",
    timestamp: Date.now(),
    payload: {
      daemonId: "daemon-1",
      hostname: "test-host",
      platform: "linux",
      osVersion: "Ubuntu 24.04",
      protocolVersion: "1.0.0",
      appVersion: "0.1.0",
      capabilities: makeCapabilities(),
      ...overrides,
    },
  };
}

// Tests

beforeEach(() => {
  mockSend.mockClear();
  mockSend.mockResolvedValue(null);
  mockDbFn.mockClear();
  mockDbResult = [];
  dbEnabled = true;
  mockLoggerInfo.mockClear();
  mockLoggerWarn.mockClear();
  mockLoggerDebug.mockClear();
});

describe("registerDaemon", () => {
  it("stores daemon liveness in Valkey with TTL and adds to active set", async () => {
    const msg = makeRegisterMessage();
    await registerDaemon(msg);

    // SETEX daemon:{id} 90 {capabilities JSON}
    expect(mockSend).toHaveBeenCalledWith("SETEX", [
      "daemon:daemon-1",
      "90",
      JSON.stringify(msg.payload.capabilities),
    ]);
    // SET daemon:{id}:active_jobs 0 EX 90, shares TTL with the liveness key
    // so an orchestrator crash can't leak the counter independently.
    expect(mockSend).toHaveBeenCalledWith("SET", ["daemon:daemon-1:active_jobs", "0", "EX", "90"]);
    // SADD active_daemons daemon-1
    expect(mockSend).toHaveBeenCalledWith("SADD", ["active_daemons", "daemon-1"]);
  });

  it("performs Postgres upsert when db is available", async () => {
    const msg = makeRegisterMessage();
    await registerDaemon(msg);

    // The db tagged template should have been called (Postgres INSERT ... ON CONFLICT)
    expect(mockDbFn).toHaveBeenCalled();
  });

  it("skips Postgres upsert when db is not available", async () => {
    dbEnabled = false;
    const msg = makeRegisterMessage();
    await registerDaemon(msg);

    expect(mockDbFn).not.toHaveBeenCalled();
    // Valkey calls should still happen
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it("returns a DaemonInfo object with correct fields", async () => {
    const msg = makeRegisterMessage({
      daemonId: "d-result",
      hostname: "h1",
      platform: "darwin",
      osVersion: "macOS 15",
      protocolVersion: "1.0.0",
      appVersion: "2.0.0",
    });

    const result = await registerDaemon(msg);

    expect(result.id).toBe("d-result");
    expect(result.hostname).toBe("h1");
    expect(result.platform).toBe("darwin");
    expect(result.osVersion).toBe("macOS 15");
    expect(result.status).toBe("active");
    expect(result.protocolVersion).toBe("1.0.0");
    expect(result.appVersion).toBe("2.0.0");
    expect(result.activeJobs).toBe(0);
    expect(result.capabilities).toEqual(msg.payload.capabilities);
    expect(typeof result.lastSeenAt).toBe("number");
    expect(typeof result.firstSeenAt).toBe("number");
  });

  it("separates resources from capabilities for Postgres columns", async () => {
    const msg = makeRegisterMessage();
    await registerDaemon(msg);

    // The db call receives the SQL template + interpolated values.
    // We verify it was called, the actual SQL is in the template strings.
    expect(mockDbFn).toHaveBeenCalled();
    const call = mockDbFn.mock.calls[0];
    if (call === undefined) {
      throw new Error("Expected mockDbFn to have been called");
    }
    // Interpolated values are args after the template strings array.
    // The capabilities without resources should be passed as one arg,
    // and resources as another. They are among the interpolated values.
    const interpolatedValues = call.slice(1);
    // Find the resources object among interpolated values
    const hasResources = interpolatedValues.some(
      (v) => typeof v === "object" && v !== null && "cpuCount" in (v as Record<string, unknown>),
    );
    expect(hasResources).toBe(true);
  });
});

describe("deregisterDaemon", () => {
  it("removes daemon keys from Valkey", async () => {
    await deregisterDaemon("daemon-99");

    expect(mockSend).toHaveBeenCalledWith("DEL", ["daemon:daemon-99"]);
    expect(mockSend).toHaveBeenCalledWith("DEL", ["daemon:daemon-99:active_jobs"]);
    expect(mockSend).toHaveBeenCalledWith("SREM", ["active_daemons", "daemon-99"]);
  });

  it("sets Postgres status to inactive when db is available", async () => {
    await deregisterDaemon("daemon-99");

    expect(mockDbFn).toHaveBeenCalled();
  });

  it("skips Postgres update when db is not available", async () => {
    dbEnabled = false;
    await deregisterDaemon("daemon-99");

    expect(mockDbFn).not.toHaveBeenCalled();
  });

  it("logs the deregistration", async () => {
    await deregisterDaemon("daemon-log");

    expect(mockLoggerInfo).toHaveBeenCalledWith({ daemonId: "daemon-log" }, "Daemon deregistered");
  });
});

describe("refreshDaemonTtl", () => {
  it("refreshes Valkey TTL with SETEX", async () => {
    const caps = makeCapabilities();
    await refreshDaemonTtl("daemon-5", caps);

    expect(mockSend).toHaveBeenCalledWith("SETEX", ["daemon:daemon-5", "90", JSON.stringify(caps)]);
  });

  it("also extends the active_jobs TTL via EXPIRE so both keys stay aligned", async () => {
    await refreshDaemonTtl("daemon-5", makeCapabilities());

    expect(mockSend).toHaveBeenCalledWith("EXPIRE", ["daemon:daemon-5:active_jobs", "90"]);
  });

  it("updates last_seen_at in Postgres when db is available", async () => {
    await refreshDaemonTtl("daemon-5", makeCapabilities());

    expect(mockDbFn).toHaveBeenCalled();
  });

  it("skips Postgres update when db is not available", async () => {
    dbEnabled = false;
    await refreshDaemonTtl("daemon-5", makeCapabilities());

    expect(mockDbFn).not.toHaveBeenCalled();
  });
});

describe("getActiveDaemons", () => {
  it("returns empty array when no daemons are in the set", async () => {
    mockSend.mockResolvedValueOnce([]); // SMEMBERS

    const result = await getActiveDaemons();

    expect(result).toEqual([]);
  });

  it("returns alive daemon IDs (those with existing liveness keys)", async () => {
    mockSend
      .mockResolvedValueOnce(["d-1", "d-2", "d-3"]) // SMEMBERS
      .mockResolvedValueOnce(1) // EXISTS d-1 → alive
      .mockResolvedValueOnce(0) // EXISTS d-2 → stale
      .mockResolvedValueOnce(1); // EXISTS d-3 → alive
    // SREM for d-2 (stale cleanup)
    mockSend.mockResolvedValueOnce(1);

    const result = await getActiveDaemons();

    expect(result).toEqual(["d-1", "d-3"]);
  });

  it("prunes stale daemons from active set", async () => {
    mockSend
      .mockResolvedValueOnce(["d-stale"]) // SMEMBERS
      .mockResolvedValueOnce(0); // EXISTS d-stale → expired
    mockSend.mockResolvedValueOnce(1); // SREM

    await getActiveDaemons();

    expect(mockSend).toHaveBeenCalledWith("SREM", ["active_daemons", "d-stale"]);
    expect(mockLoggerDebug).toHaveBeenCalledWith(
      { daemonId: "d-stale" },
      "Pruned stale daemon from active_daemons set",
    );
  });

  it("returns all daemons when all are alive", async () => {
    mockSend
      .mockResolvedValueOnce(["d-a", "d-b"]) // SMEMBERS
      .mockResolvedValueOnce(1) // EXISTS d-a
      .mockResolvedValueOnce(1); // EXISTS d-b

    const result = await getActiveDaemons();

    expect(result).toEqual(["d-a", "d-b"]);
  });
});

describe("getDaemonActiveJobs", () => {
  it("returns 0 when the key does not exist (GET returns null)", async () => {
    mockSend.mockResolvedValueOnce(null);

    const count = await getDaemonActiveJobs("d-new");

    expect(count).toBe(0);
    expect(mockSend).toHaveBeenCalledWith("GET", ["daemon:d-new:active_jobs"]);
  });

  it("parses and returns the integer count from Valkey", async () => {
    mockSend.mockResolvedValueOnce("5");

    const count = await getDaemonActiveJobs("d-busy");

    expect(count).toBe(5);
  });

  it("handles zero as a string correctly", async () => {
    mockSend.mockResolvedValueOnce("0");

    const count = await getDaemonActiveJobs("d-idle");

    expect(count).toBe(0);
  });
});

describe("incrementDaemonActiveJobs", () => {
  it("sends INCR command to Valkey", async () => {
    mockSend.mockResolvedValueOnce(1);

    await incrementDaemonActiveJobs("d-inc");

    expect(mockSend).toHaveBeenCalledWith("INCR", ["daemon:d-inc:active_jobs"]);
  });
});

describe("decrementDaemonActiveJobs", () => {
  it("sends EVAL with Lua script for atomic decrement", async () => {
    mockSend.mockResolvedValueOnce(2); // Lua returns new value after DECR

    await decrementDaemonActiveJobs("d-dec");

    expect(mockSend).toHaveBeenCalledWith("EVAL", [
      expect.stringContaining("redis.call('DECR', KEYS[1])"),
      "1",
      "daemon:d-dec:active_jobs",
    ]);
  });

  it("logs a warning when Lua returns -1 (already at zero)", async () => {
    mockSend.mockResolvedValueOnce(-1);

    await decrementDaemonActiveJobs("d-underflow");

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { daemonId: "d-underflow" },
      "Skipped DECR, active_jobs already at zero or below",
    );
  });

  it("does not warn when Lua returns a positive value", async () => {
    mockSend.mockResolvedValueOnce(3);

    await decrementDaemonActiveJobs("d-ok");

    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it("does not warn when Lua returns 0 (decremented from 1 to 0)", async () => {
    mockSend.mockResolvedValueOnce(0);

    await decrementDaemonActiveJobs("d-zero");

    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });
});
