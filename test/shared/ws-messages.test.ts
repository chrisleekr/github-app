/**
 * Tests for src/shared/ws-messages.ts.
 *
 * Covers the exported Zod schemas (serverMessageSchema, daemonMessageSchema),
 * constants (PROTOCOL_VERSION, WS_CLOSE_CODES, WS_ERROR_CODES), and the
 * createMessageEnvelope() helper: the only function in the file, currently
 * at 0% function coverage.
 */

import { describe, expect, it } from "bun:test";

import {
  createMessageEnvelope,
  daemonMessageSchema,
  PROTOCOL_VERSION,
  serverMessageSchema,
  WS_CLOSE_CODES,
  WS_ERROR_CODES,
} from "../../src/shared/ws-messages";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal valid envelope fields reusable across tests. */
function envelope(overrides?: { id?: string; timestamp?: number }): {
  id: string;
  timestamp: number;
} {
  return {
    id: overrides?.id ?? crypto.randomUUID(),
    timestamp: overrides?.timestamp ?? Date.now(),
  };
}

// ─── createMessageEnvelope ───────────────────────────────────────────────────

describe("createMessageEnvelope", () => {
  it("returns a UUID id and numeric timestamp when called with no arguments", () => {
    const env = createMessageEnvelope();

    // UUID v4 format: 8-4-4-4-12 hex groups
    expect(env.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(typeof env.timestamp).toBe("number");
    // timestamp should be a recent epoch ms
    expect(env.timestamp).toBeGreaterThan(Date.now() - 5000);
    expect(env.timestamp).toBeLessThanOrEqual(Date.now());
  });

  it("uses the provided overrideId instead of generating a UUID", () => {
    const customId = "my-custom-id-123";
    const env = createMessageEnvelope(customId);

    expect(env.id).toBe(customId);
    expect(typeof env.timestamp).toBe("number");
  });

  it("generates a UUID when overrideId is undefined", () => {
    const env = createMessageEnvelope(undefined);

    expect(env.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

// ─── serverMessageSchema ─────────────────────────────────────────────────────

describe("serverMessageSchema", () => {
  it("parses a valid daemon:registered message", () => {
    const msg = {
      type: "daemon:registered",
      ...envelope(),
      payload: {
        heartbeatIntervalMs: 30000,
        offerTimeoutMs: 10000,
        maxRetries: 3,
      },
    };
    const result = serverMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it("parses a valid heartbeat:ping message", () => {
    const msg = {
      type: "heartbeat:ping",
      ...envelope(),
      payload: {},
    };
    const result = serverMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it("parses a valid job:offer message", () => {
    const msg = {
      type: "job:offer",
      ...envelope(),
      payload: {
        deliveryId: "delivery-123",
        repoOwner: "myorg",
        repoName: "myrepo",
        entityNumber: 42,
        isPR: true,
        eventName: "issue_comment",
        triggerUsername: "alice",
        labels: ["bug"],
        triggerBodyPreview: "@bot fix this",
        requiredTools: [],
      },
    };
    const result = serverMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it("parses a valid job:payload message with optional memory", () => {
    const msg = {
      type: "job:payload",
      ...envelope(),
      payload: {
        context: { owner: "org", repo: "repo" },
        installationToken: "ghs_abc123",
        maxTurns: 25,
        allowedTools: ["Edit", "Read"],
        memory: [
          { id: "m1", category: "architecture", content: "Uses Bun runtime", pinned: false },
        ],
      },
    };
    const result = serverMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it("parses a valid job:payload message without optional fields", () => {
    const msg = {
      type: "job:payload",
      ...envelope(),
      payload: {
        context: {},
        installationToken: "ghs_abc123",
        maxTurns: 10,
        allowedTools: [],
      },
    };
    const result = serverMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it("parses a valid job:payload message carrying installationId (#177)", () => {
    const msg = {
      type: "job:payload",
      ...envelope(),
      payload: {
        context: { owner: "org", repo: "repo" },
        installationToken: "ghs_abc123",
        installationId: 12345,
        allowedTools: [],
      },
    };
    const result = serverMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "job:payload") {
      expect(result.data.payload.installationId).toBe(12345);
    }
  });

  it("rejects job:payload with a non-positive installationId (#177)", () => {
    const msg = {
      type: "job:payload",
      ...envelope(),
      payload: {
        context: {},
        installationToken: "ghs_abc123",
        installationId: 0,
        allowedTools: [],
      },
    };
    expect(serverMessageSchema.safeParse(msg).success).toBe(false);
  });

  it("parses a valid job:cancel message", () => {
    const msg = {
      type: "job:cancel",
      ...envelope(),
      payload: { reason: "timeout exceeded" },
    };
    const result = serverMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it("parses a valid daemon:update-required message", () => {
    const msg = {
      type: "daemon:update-required",
      ...envelope(),
      payload: {
        targetVersion: "2.0.0",
        reason: "security patch",
        urgent: true,
      },
    };
    const result = serverMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it("parses a valid error message", () => {
    const msg = {
      type: "error",
      ...envelope(),
      payload: {
        code: "INVALID_MESSAGE",
        message: "bad format",
      },
    };
    const result = serverMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it("rejects an unknown message type", () => {
    const msg = {
      type: "unknown:type",
      ...envelope(),
      payload: {},
    };
    const result = serverMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it("rejects a message missing required payload fields", () => {
    const msg = {
      type: "daemon:registered",
      ...envelope(),
      payload: {
        heartbeatIntervalMs: 30000,
        // missing offerTimeoutMs, maxRetries
      },
    };
    const result = serverMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it("rejects a message with invalid envelope (missing id)", () => {
    const msg = {
      type: "heartbeat:ping",
      timestamp: Date.now(),
      payload: {},
    };
    const result = serverMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it("rejects a message with invalid envelope (bad UUID format)", () => {
    const msg = {
      type: "heartbeat:ping",
      id: "not-a-uuid",
      timestamp: Date.now(),
      payload: {},
    };
    const result = serverMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });
});

// ─── daemonMessageSchema ─────────────────────────────────────────────────────

describe("daemonMessageSchema", () => {
  const baseDaemonCapabilities = {
    platform: "linux" as const,
    shells: [{ name: "bash", path: "/bin/bash", version: "5.2", functional: true }],
    packageManagers: [{ name: "npm", path: "/usr/bin/npm", version: "10.0", functional: true }],
    cliTools: [],
    containerRuntime: null,
    authContexts: ["github"],
    resources: { cpuCount: 4, memoryTotalMb: 8192, memoryFreeMb: 4096, diskFreeMb: 50000 },
    network: { hostname: "worker-1" },
    cachedRepos: [],
    ephemeral: false,
    maxUptimeMs: null,
    maxConcurrentJobs: 4,
  };

  it("parses a valid daemon:register message", () => {
    const msg = {
      type: "daemon:register",
      ...envelope(),
      payload: {
        daemonId: "d-001",
        hostname: "worker-1",
        platform: "linux",
        osVersion: "Ubuntu 24.04",
        protocolVersion: "1.0.0",
        appVersion: "1.0.0",
        capabilities: baseDaemonCapabilities,
      },
    };
    const result = daemonMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it("parses a valid heartbeat:pong message", () => {
    const msg = {
      type: "heartbeat:pong",
      ...envelope(),
      payload: {
        activeJobs: 2,
        resources: {
          cpuCount: 8,
          memoryTotalMb: 16384,
          memoryFreeMb: 8000,
          diskFreeMb: 100000,
        },
      },
    };
    const result = daemonMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it("parses a valid job:accept message", () => {
    const msg = {
      type: "job:accept",
      ...envelope(),
      payload: {},
    };
    const result = daemonMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it("parses a valid job:reject message", () => {
    const msg = {
      type: "job:reject",
      ...envelope(),
      payload: { reason: "at capacity" },
    };
    const result = daemonMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it("parses a valid job:status message", () => {
    const msg = {
      type: "job:status",
      ...envelope(),
      payload: { status: "running", message: "cloning repo" },
    };
    const result = daemonMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it("parses a valid job:status message without optional message field", () => {
    const msg = {
      type: "job:status",
      ...envelope(),
      payload: { status: "executing" },
    };
    const result = daemonMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it("parses a valid job:result message with all optional fields", () => {
    const msg = {
      type: "job:result",
      ...envelope(),
      payload: {
        success: true,
        deliveryId: "del-123",
        costUsd: 0.05,
        durationMs: 12000,
        numTurns: 5,
        dryRun: false,
        learnings: [{ category: "architecture", content: "Uses monorepo" }],
        deletions: ["old-learning-id-1"],
      },
    };
    const result = daemonMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it("parses a valid job:result message with minimal fields", () => {
    const msg = {
      type: "job:result",
      ...envelope(),
      payload: {
        success: false,
        errorMessage: "timeout",
      },
    };
    const result = daemonMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it("parses a valid daemon:update-acknowledged message", () => {
    const msg = {
      type: "daemon:update-acknowledged",
      ...envelope(),
      payload: {
        strategy: "exit",
        delayMs: 5000,
      },
    };
    const result = daemonMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it("parses a valid daemon:draining message", () => {
    const msg = {
      type: "daemon:draining",
      ...envelope(),
      payload: {
        activeJobs: 1,
        reason: "shutting down",
      },
    };
    const result = daemonMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it("rejects an unknown daemon message type", () => {
    const msg = {
      type: "daemon:unknown",
      ...envelope(),
      payload: {},
    };
    const result = daemonMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it("rejects daemon:register with empty daemonId", () => {
    const msg = {
      type: "daemon:register",
      ...envelope(),
      payload: {
        daemonId: "",
        hostname: "worker-1",
        platform: "linux",
        osVersion: "Ubuntu 24.04",
        protocolVersion: "1.0.0",
        appVersion: "1.0.0",
        capabilities: baseDaemonCapabilities,
      },
    };
    const result = daemonMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it("rejects heartbeat:pong with negative activeJobs", () => {
    const msg = {
      type: "heartbeat:pong",
      ...envelope(),
      payload: {
        activeJobs: -1,
        resources: {
          cpuCount: 4,
          memoryTotalMb: 8192,
          memoryFreeMb: 4096,
          diskFreeMb: 50000,
        },
      },
    };
    const result = daemonMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it("rejects job:status with invalid status enum value", () => {
    const msg = {
      type: "job:status",
      ...envelope(),
      payload: { status: "done" },
    };
    const result = daemonMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });
});

// ─── Constants ───────────────────────────────────────────────────────────────

describe("PROTOCOL_VERSION", () => {
  it("is a semver string", () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("WS_CLOSE_CODES", () => {
  it("contains expected close code entries", () => {
    expect(WS_CLOSE_CODES.GRACEFUL_SHUTDOWN.code).toBe(1000);
    expect(WS_CLOSE_CODES.POLICY_VIOLATION.code).toBe(1008);
    expect(WS_CLOSE_CODES.HEARTBEAT_TIMEOUT.code).toBe(4001);
    expect(WS_CLOSE_CODES.SUPERSEDED.code).toBe(4002);
    expect(WS_CLOSE_CODES.INCOMPATIBLE_PROTOCOL.code).toBe(4003);
  });
});

describe("WS_ERROR_CODES", () => {
  it("contains expected error code strings", () => {
    expect(WS_ERROR_CODES.INVALID_MESSAGE).toBe("INVALID_MESSAGE");
    expect(WS_ERROR_CODES.UNKNOWN_OFFER).toBe("UNKNOWN_OFFER");
    expect(WS_ERROR_CODES.DUPLICATE_REGISTRATION).toBe("DUPLICATE_REGISTRATION");
    expect(WS_ERROR_CODES.EXECUTION_ALREADY_FINALIZED).toBe("EXECUTION_ALREADY_FINALIZED");
    expect(WS_ERROR_CODES.MESSAGE_TOO_LARGE).toBe("MESSAGE_TOO_LARGE");
    expect(WS_ERROR_CODES.INTERNAL_ERROR).toBe("INTERNAL_ERROR");
  });
});
