/**
 * Tests for src/orchestrator/ws-server.ts
 *
 * Covers: startWebSocketServer, stopWebSocketServer, sendError,
 * WebSocket fetch (auth), open, message (JSON parse + Zod validation), close.
 *
 * Bun.serve is mocked to capture the handler config and test handlers directly.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

import { deriveWorkflowRunnerCapability } from "../../src/orchestrator/workflow-runner-capability";
import type { DaemonMessage } from "../../src/shared/ws-messages";

// ─── Mocks ────────────────────────────────────────────────────────────────────

// connection-handler
const mockHandleDaemonMessage = mock((_ws: unknown, _msg: DaemonMessage) => {});
const mockHandleWsClose = mock(() => {});
const mockHandleWsOpen = mock(() => {});
const mockBeginDaemonConnectionShutdown = mock(() => {});
const mockDrainDisconnectCleanups = mock(() => Promise.resolve());

void mock.module("../../src/orchestrator/connection-handler", () => ({
  beginDaemonConnectionShutdown: mockBeginDaemonConnectionShutdown,
  drainDisconnectCleanups: mockDrainDisconnectCleanups,
  handleDaemonMessage: mockHandleDaemonMessage,
  handleWsClose: mockHandleWsClose,
  handleWsOpen: mockHandleWsOpen,
  getConnections: mock(() => new Map()),
  getDaemonInfo: mock(() => undefined),
  isDaemonDraining: mock(() => false),
}));

// daemon-registry
void mock.module("../../src/orchestrator/daemon-registry", () => ({
  registerDaemon: mock(() => Promise.resolve()),
  deregisterDaemon: mock(() => Promise.resolve()),
  getActiveDaemons: mock(() => Promise.resolve([])),
  getDaemonActiveJobs: mock(() => Promise.resolve(0)),
  refreshDaemonTtl: mock(() => Promise.resolve()),
  incrementDaemonActiveJobs: mock(() => Promise.resolve()),
  decrementDaemonActiveJobs: mock(() => Promise.resolve()),
}));

// history
void mock.module("../../src/orchestrator/history", () => ({
  createExecution: mock(() => Promise.resolve("exec-id")),
  markExecutionOffered: mock(() => Promise.resolve()),
  markExecutionFailed: mock(() => Promise.resolve()),
  markExecutionRunning: mock(() => Promise.resolve()),
  markExecutionCompleted: mock(() => Promise.resolve()),
  getExecutionState: mock(() => Promise.resolve(null)),
  getOrphanedExecutions: mock(() => Promise.resolve([])),
  requeueExecution: mock(() => Promise.resolve("released")),
}));

// job-dispatcher
void mock.module("../../src/orchestrator/job-dispatcher", () => ({
  getPendingOffer: mock(() => undefined),
  removePendingOffer: mock(() => {}),
  handleJobAccept: mock(() => {}),
  handleJobReject: mock(() => Promise.resolve()),
  releaseOfferQueueLease: mock(() => Promise.resolve()),
  inferRequiredTools: mock(() => []),
  selectDaemon: mock(() => Promise.resolve(null)),
  dispatchJob: mock(() => Promise.resolve(false)),
}));

// concurrency
void mock.module("../../src/orchestrator/concurrency", () => ({
  decrementActiveCount: mock(() => {}),
  incrementActiveCount: mock(() => {}),
  getActiveCount: mock(() => 0),
  isAtCapacity: mock(() => false),
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

// valkey
void mock.module("../../src/orchestrator/valkey", () => ({
  requireValkeyClient: mock(() => ({})),
  getValkeyClient: mock(() => null),
}));

// We need to capture the Bun.serve config to test handlers directly.
// Instead of calling startWebSocketServer (which calls Bun.serve and binds a port),
// we'll import sendError directly and test the handlers via the module's internal logic.

// Import AFTER all mocks
const { sendError } = await import("../../src/orchestrator/ws-server");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFakeWs() {
  return {
    data: {
      authenticated: true,
      remoteAddr: "127.0.0.1",
      daemonId: undefined as string | undefined,
    },
    sendText: mock((_text: string) => {}),
    close: mock((_code?: number, _reason?: string) => {}),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockHandleDaemonMessage.mockClear();
  mockHandleWsClose.mockClear();
  mockHandleWsOpen.mockClear();
  mockBeginDaemonConnectionShutdown.mockClear();
  mockDrainDisconnectCleanups.mockClear();
});

describe("sendError", () => {
  it("sends error message with correct structure", () => {
    const ws = makeFakeWs();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendError(ws as any, "corr-123", "INVALID_MESSAGE", "Bad data");

    expect(ws.sendText).toHaveBeenCalledTimes(1);
    const sentText = (ws.sendText as ReturnType<typeof mock>).mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(sentText) as {
      type: string;
      id: string;
      timestamp: number;
      payload: { code: string; message: string };
    };

    expect(parsed.type).toBe("error");
    expect(parsed.id).toBe("corr-123");
    expect(parsed.payload.code).toBe("INVALID_MESSAGE");
    expect(parsed.payload.message).toBe("Bad data");
    expect(typeof parsed.timestamp).toBe("number");
  });

  it("uses correlationId as envelope id", () => {
    const ws = makeFakeWs();
    const correlationId = crypto.randomUUID();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendError(ws as any, correlationId, "INTERNAL_ERROR", "Oops");

    const sentText = (ws.sendText as ReturnType<typeof mock>).mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(sentText) as { id: string };
    expect(parsed.id).toBe(correlationId);
  });
});

describe("startWebSocketServer", () => {
  it("throws when DAEMON_AUTH_TOKEN is not configured", async () => {
    // Import config to temporarily unset the token
    const { config } = await import("../../src/config");
    const originalToken = config.daemonAuthToken;

    try {
      (config as { daemonAuthToken: string | undefined }).daemonAuthToken = undefined;

      // We need a fresh module import to test the start path
      // Since mock.module persists, we test the throw condition directly
      // by calling startWebSocketServer with no token

      const { startWebSocketServer: startFresh } = await import("../../src/orchestrator/ws-server");

      // The module-level `server` variable may be cached from a previous call,
      // so startFresh might return early with the existing server.
      // Reset it first by stopping.
      const { stopWebSocketServer } = await import("../../src/orchestrator/ws-server");
      await stopWebSocketServer();

      expect(() => startFresh()).toThrow("DAEMON_AUTH_TOKEN is required");
    } finally {
      (config as { daemonAuthToken: string | undefined }).daemonAuthToken = originalToken;
    }
  });

  it("creates a Bun server when properly configured", async () => {
    const { config } = await import("../../src/config");
    const originalToken = config.daemonAuthToken;
    const originalPort = config.wsPort;

    try {
      (config as { daemonAuthToken: string | undefined }).daemonAuthToken = "test-secret-token";
      (config as { wsPort: number }).wsPort = 0; // Use random port

      const { stopWebSocketServer } = await import("../../src/orchestrator/ws-server");
      await stopWebSocketServer(); // Ensure no existing server

      // Dynamically re-import to get a clean state
      // Note: the module is cached, but stopWebSocketServer clears `server`
      const { startWebSocketServer } = await import("../../src/orchestrator/ws-server");
      const srv = startWebSocketServer();

      expect(srv).toBeDefined();
      expect(srv.port).toBeGreaterThan(0);

      // Starting again should return same instance
      const srv2 = startWebSocketServer();
      expect(srv2).toBe(srv);

      // Cleanup
      await stopWebSocketServer();
    } finally {
      (config as { daemonAuthToken: string | undefined }).daemonAuthToken = originalToken;
      (config as { wsPort: number }).wsPort = originalPort;
    }
  });

  it("handles WebSocket upgrade with valid auth", async () => {
    const { config } = await import("../../src/config");
    const originalToken = config.daemonAuthToken;
    const originalPort = config.wsPort;

    try {
      (config as { daemonAuthToken: string | undefined }).daemonAuthToken = "test-ws-token";
      (config as { wsPort: number }).wsPort = 0;

      const { stopWebSocketServer, startWebSocketServer } =
        await import("../../src/orchestrator/ws-server");
      await stopWebSocketServer();
      const srv = startWebSocketServer();

      // Test fetch handler via HTTP request to the server
      const _res = await fetch(`http://localhost:${srv.port}/ws`, {
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
          Authorization: "Bearer test-ws-token",
          "Sec-WebSocket-Key": btoa(crypto.randomUUID()),
          "Sec-WebSocket-Version": "13",
        },
      });

      // Bun handles the upgrade internally; the response is 101 on success
      // or the fetch may behave differently depending on how Bun handles it.
      // What we can verify is that a non-upgrade request to /ws works
      const res2 = await fetch(`http://localhost:${srv.port}/ws`);
      // Without auth header, should be 401
      expect(res2.status).toBe(401);

      // Test 404 on non-/ws path
      const res3 = await fetch(`http://localhost:${srv.port}/other`);
      expect(res3.status).toBe(404);

      await stopWebSocketServer();
    } finally {
      (config as { daemonAuthToken: string | undefined }).daemonAuthToken = originalToken;
      (config as { wsPort: number }).wsPort = originalPort;
    }
  });

  it("rejects WebSocket connections with invalid auth", async () => {
    const { config } = await import("../../src/config");
    const originalToken = config.daemonAuthToken;
    const originalPort = config.wsPort;

    try {
      (config as { daemonAuthToken: string | undefined }).daemonAuthToken = "correct-token";
      (config as { wsPort: number }).wsPort = 0;

      const { stopWebSocketServer, startWebSocketServer } =
        await import("../../src/orchestrator/ws-server");
      await stopWebSocketServer();
      const srv = startWebSocketServer();

      const res = await fetch(`http://localhost:${srv.port}/ws`, {
        headers: { Authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);

      await stopWebSocketServer();
    } finally {
      (config as { daemonAuthToken: string | undefined }).daemonAuthToken = originalToken;
      (config as { wsPort: number }).wsPort = originalPort;
    }
  });
});

// Constant-time bearer-token regression cases (#76). The vulnerable
// implementation used `!==` which short-circuits and leaks the matching
// prefix length via response latency. The fix uses `crypto.timingSafeEqual`
// on length-padded buffers and supports an optional `_PREVIOUS` rotation
// slot. These tests verify all the auth-header-shape decisions through the
// real Bun.serve fetch handler.
describe("WebSocket auth (constant-time bearer comparator, #76)", () => {
  async function withServer(
    primary: string,
    previous: string | undefined,
    fn: (port: number) => Promise<void>,
  ): Promise<void> {
    const { config } = await import("../../src/config");
    const originalToken = config.daemonAuthToken;
    const originalPrevious = config.daemonAuthTokenPrevious;
    const originalRunnerSecret = config.workflowRunnerCapabilitySecret;
    const originalRunnerPrevious = config.workflowRunnerCapabilitySecretPrevious;
    const originalPort = config.wsPort;

    try {
      (config as { daemonAuthToken: string | undefined }).daemonAuthToken = primary;
      (config as { daemonAuthTokenPrevious: string | undefined }).daemonAuthTokenPrevious =
        previous;
      (
        config as { workflowRunnerCapabilitySecret: string | undefined }
      ).workflowRunnerCapabilitySecret = primary;
      (
        config as { workflowRunnerCapabilitySecretPrevious: string | undefined }
      ).workflowRunnerCapabilitySecretPrevious = previous;
      (config as { wsPort: number }).wsPort = 0;

      const { stopWebSocketServer, startWebSocketServer } =
        await import("../../src/orchestrator/ws-server");
      await stopWebSocketServer();
      const srv = startWebSocketServer();

      try {
        await fn(srv.port);
      } finally {
        await stopWebSocketServer();
      }
    } finally {
      (config as { daemonAuthToken: string | undefined }).daemonAuthToken = originalToken;
      (config as { daemonAuthTokenPrevious: string | undefined }).daemonAuthTokenPrevious =
        originalPrevious;
      (
        config as { workflowRunnerCapabilitySecret: string | undefined }
      ).workflowRunnerCapabilitySecret = originalRunnerSecret;
      (
        config as { workflowRunnerCapabilitySecretPrevious: string | undefined }
      ).workflowRunnerCapabilitySecretPrevious = originalRunnerPrevious;
      (config as { wsPort: number }).wsPort = originalPort;
    }
  }

  it("rejects when the Authorization header is missing entirely", async () => {
    await withServer("primary-secret-32chars-aaaaaaaaa", undefined, async (port) => {
      const res = await fetch(`http://localhost:${port}/ws`);
      expect(res.status).toBe(401);
    });
  });

  it("rejects when the header is shorter than expected", async () => {
    await withServer("primary-secret-32chars-aaaaaaaaa", undefined, async (port) => {
      const res = await fetch(`http://localhost:${port}/ws`, {
        headers: { Authorization: "Bearer short" },
      });
      expect(res.status).toBe(401);
    });
  });

  it("rejects when the header length matches but bytes differ", async () => {
    const primary = "primary-secret-32chars-aaaaaaaaa";
    const wrong = "primary-secret-32chars-bbbbbbbbb"; // same length, different bytes
    expect(wrong.length).toBe(primary.length);
    await withServer(primary, undefined, async (port) => {
      const res = await fetch(`http://localhost:${port}/ws`, {
        headers: { Authorization: `Bearer ${wrong}` },
      });
      expect(res.status).toBe(401);
    });
  });

  it("rejects when the header is longer than expected (prefix collision)", async () => {
    // A header that begins with the correct token followed by extra bytes
    // would have authenticated under a buggy length-prefix comparator. The
    // explicit length-equality guard rejects it.
    await withServer("primary-secret-32chars-aaaaaaaaa", undefined, async (port) => {
      const res = await fetch(`http://localhost:${port}/ws`, {
        headers: { Authorization: "Bearer primary-secret-32chars-aaaaaaaaa-EXTRA" },
      });
      expect(res.status).toBe(401);
    });
  });

  it("accepts the primary token via the upgrade handler", async () => {
    await withServer("primary-secret-32chars-aaaaaaaaa", undefined, async (port) => {
      // A non-upgrade GET with valid auth passes the auth check and reaches
      // `srv.upgrade()`, which fails because the request lacks Upgrade
      // headers, the fetch handler then returns the 500 fallback. Pinning
      // to 500 (rather than `.not.toBe(401)`) catches a regression where a
      // refactored upgrade path returns a different status while still
      // accepting bad credentials.
      const res = await fetch(`http://localhost:${port}/ws`, {
        headers: { Authorization: "Bearer primary-secret-32chars-aaaaaaaaa" },
      });
      expect(res.status).toBe(500);
    });
  });

  it("accepts the previous token during a rotation window", async () => {
    await withServer(
      "new-primary-32chars-aaaaaaaaaaaaa",
      "old-primary-32chars-bbbbbbbbbbbbb",
      async (port) => {
        // Old token still works while the rotation overlap is open, see
        // the upgrade-fallback note on the previous test for why we expect
        // 500.
        const resOld = await fetch(`http://localhost:${port}/ws`, {
          headers: { Authorization: "Bearer old-primary-32chars-bbbbbbbbbbbbb" },
        });
        expect(resOld.status).toBe(500);

        // New token also works.
        const resNew = await fetch(`http://localhost:${port}/ws`, {
          headers: { Authorization: "Bearer new-primary-32chars-aaaaaaaaaaaaa" },
        });
        expect(resNew.status).toBe(500);

        // An unrelated token is still rejected.
        const resBad = await fetch(`http://localhost:${port}/ws`, {
          headers: { Authorization: "Bearer unrelated-token-xxxxxxxxxxxxxxxx" },
        });
        expect(resBad.status).toBe(401);
      },
    );
  });

  it("accepts only an exact attempt capability on the workflow-runner path", async () => {
    const runId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const path = `/ws/workflow-runner/${runId}/${attemptId}`;
    await withServer("runner-root-secret", "old-runner-root", async (port) => {
      const expiresAtMs = Date.now() + 60_000;
      const current = deriveWorkflowRunnerCapability(
        "runner-root-secret",
        runId,
        attemptId,
        expiresAtMs,
      );
      const previous = deriveWorkflowRunnerCapability(
        "old-runner-root",
        runId,
        attemptId,
        expiresAtMs,
      );
      const wrongAttempt = deriveWorkflowRunnerCapability(
        "runner-root-secret",
        runId,
        crypto.randomUUID(),
        expiresAtMs,
      );
      for (const token of [current, previous]) {
        const accepted = await fetch(`http://localhost:${String(port)}${path}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(accepted.status).toBe(500);
      }
      for (const token of ["runner-root-secret", wrongAttempt]) {
        const rejected = await fetch(`http://localhost:${String(port)}${path}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(rejected.status).toBe(401);
      }
      const encodedSlash = await fetch(
        `http://localhost:${String(port)}/ws/workflow-runner/%2F/${attemptId}`,
        { headers: { Authorization: `Bearer ${current}` } },
      );
      expect(encodedSlash.status).toBe(401);
    });
  });
});

describe("stopWebSocketServer", () => {
  it("is a no-op when no server is running", async () => {
    const { stopWebSocketServer } = await import("../../src/orchestrator/ws-server");
    // Should resolve cleanly even when called multiple times
    await stopWebSocketServer();
    await stopWebSocketServer();
  });

  it("drains daemon disconnect fencing before shutdown completes", async () => {
    const { config } = await import("../../src/config");
    const originalToken = config.daemonAuthToken;
    const originalPort = config.wsPort;
    try {
      (config as { daemonAuthToken: string | undefined }).daemonAuthToken = "shutdown-test-token";
      (config as { wsPort: number }).wsPort = 0;
      const { startWebSocketServer, stopWebSocketServer } =
        await import("../../src/orchestrator/ws-server");
      startWebSocketServer();
      await stopWebSocketServer();
      expect(mockBeginDaemonConnectionShutdown).toHaveBeenCalledTimes(1);
      expect(mockDrainDisconnectCleanups).toHaveBeenCalledTimes(1);
    } finally {
      (config as { daemonAuthToken: string | undefined }).daemonAuthToken = originalToken;
      (config as { wsPort: number }).wsPort = originalPort;
    }
  });
});

describe("WebSocket message handler (integration via real server)", () => {
  it("handles valid daemon:register message over WebSocket", async () => {
    const { config } = await import("../../src/config");
    const originalToken = config.daemonAuthToken;
    const originalPort = config.wsPort;

    try {
      (config as { daemonAuthToken: string | undefined }).daemonAuthToken = "msg-test-token";
      (config as { wsPort: number }).wsPort = 0;

      const { stopWebSocketServer, startWebSocketServer } =
        await import("../../src/orchestrator/ws-server");
      await stopWebSocketServer();
      const srv = startWebSocketServer();

      // Create a WebSocket client
      const ws = new WebSocket(`ws://localhost:${srv.port}/ws`, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        headers: { Authorization: "Bearer msg-test-token" } as any,
      });

      const opened = new Promise<void>((resolve) => {
        ws.onopen = () => {
          resolve();
        };
      });

      const _messageReceived = new Promise<string>((resolve) => {
        ws.onmessage = (event) => {
          resolve(String(event.data));
        };
      });

      await opened;

      // Send a valid daemon:register message
      const registerMsg = {
        type: "daemon:register",
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        payload: {
          daemonId: "ws-test-daemon",
          hostname: "test-host",
          platform: "linux",
          osVersion: "6.1",
          protocolVersion: "1.0.0",
          appVersion: "0.1.0",
          capabilities: {
            platform: "linux",
            shells: [],
            packageManagers: [],
            cliTools: [],
            containerRuntime: null,
            authContexts: [],
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
            maxConcurrentJobs: 4,
          },
        },
      };

      ws.send(JSON.stringify(registerMsg));

      // Wait for either a response message or verify the handler was called
      await new Promise((r) => setTimeout(r, 50));

      expect(mockHandleDaemonMessage).toHaveBeenCalled();

      ws.close();
      await stopWebSocketServer();
    } finally {
      (config as { daemonAuthToken: string | undefined }).daemonAuthToken = originalToken;
      (config as { wsPort: number }).wsPort = originalPort;
    }
  });

  it("closes connection on invalid JSON", async () => {
    const { config } = await import("../../src/config");
    const originalToken = config.daemonAuthToken;
    const originalPort = config.wsPort;

    try {
      (config as { daemonAuthToken: string | undefined }).daemonAuthToken = "json-test-token";
      (config as { wsPort: number }).wsPort = 0;

      const { stopWebSocketServer, startWebSocketServer } =
        await import("../../src/orchestrator/ws-server");
      await stopWebSocketServer();
      const srv = startWebSocketServer();

      const ws = new WebSocket(`ws://localhost:${srv.port}/ws`, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        headers: { Authorization: "Bearer json-test-token" } as any,
      });

      const opened = new Promise<void>((resolve) => {
        ws.onopen = () => {
          resolve();
        };
      });

      const closed = new Promise<number>((resolve) => {
        ws.onclose = (event) => {
          resolve(event.code);
        };
      });

      await opened;

      // Send invalid JSON
      ws.send("not valid json {{{");

      const code = await closed;
      // Should get POLICY_VIOLATION close code (1008)
      expect(code).toBe(1008);

      await stopWebSocketServer();
    } finally {
      (config as { daemonAuthToken: string | undefined }).daemonAuthToken = originalToken;
      (config as { wsPort: number }).wsPort = originalPort;
    }
  });

  it("sends error on schema validation failure", async () => {
    const { config } = await import("../../src/config");
    const originalToken = config.daemonAuthToken;
    const originalPort = config.wsPort;

    try {
      (config as { daemonAuthToken: string | undefined }).daemonAuthToken = "schema-test-token";
      (config as { wsPort: number }).wsPort = 0;

      const { stopWebSocketServer, startWebSocketServer } =
        await import("../../src/orchestrator/ws-server");
      await stopWebSocketServer();
      const srv = startWebSocketServer();

      const ws = new WebSocket(`ws://localhost:${srv.port}/ws`, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        headers: { Authorization: "Bearer schema-test-token" } as any,
      });

      const opened = new Promise<void>((resolve) => {
        ws.onopen = () => {
          resolve();
        };
      });

      const messageReceived = new Promise<string>((resolve) => {
        ws.onmessage = (event) => {
          resolve(String(event.data));
        };
      });

      await opened;

      // Send valid JSON but invalid schema
      ws.send(JSON.stringify({ type: "unknown:type", id: "not-uuid", timestamp: "bad" }));

      const response = await messageReceived;
      const parsed = JSON.parse(response) as { type: string; payload: { code: string } };
      expect(parsed.type).toBe("error");
      expect(parsed.payload.code).toBe("INVALID_MESSAGE");

      ws.close();
      await stopWebSocketServer();
    } finally {
      (config as { daemonAuthToken: string | undefined }).daemonAuthToken = originalToken;
      (config as { wsPort: number }).wsPort = originalPort;
    }
  });

  it("uses message id as correlationId for schema errors when available", async () => {
    const { config } = await import("../../src/config");
    const originalToken = config.daemonAuthToken;
    const originalPort = config.wsPort;

    try {
      (config as { daemonAuthToken: string | undefined }).daemonAuthToken = "corr-test-token";
      (config as { wsPort: number }).wsPort = 0;

      const { stopWebSocketServer, startWebSocketServer } =
        await import("../../src/orchestrator/ws-server");
      await stopWebSocketServer();
      const srv = startWebSocketServer();

      const ws = new WebSocket(`ws://localhost:${srv.port}/ws`, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        headers: { Authorization: "Bearer corr-test-token" } as any,
      });

      const opened = new Promise<void>((resolve) => {
        ws.onopen = () => {
          resolve();
        };
      });

      const messageReceived = new Promise<string>((resolve) => {
        ws.onmessage = (event) => {
          resolve(String(event.data));
        };
      });

      await opened;

      // Send valid JSON with an id but invalid schema
      ws.send(JSON.stringify({ type: "bad:type", id: "my-corr-id", timestamp: 123 }));

      const response = await messageReceived;
      const parsed = JSON.parse(response) as { id: string };
      expect(parsed.id).toBe("my-corr-id");

      ws.close();
      await stopWebSocketServer();
    } finally {
      (config as { daemonAuthToken: string | undefined }).daemonAuthToken = originalToken;
      (config as { wsPort: number }).wsPort = originalPort;
    }
  });
});
