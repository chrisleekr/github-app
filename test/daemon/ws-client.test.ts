/**
 * Regression test for src/daemon/ws-client.ts.
 *
 * Covers: the reconnect timer is scheduled ref'd (keeps the event loop
 * alive across backoff) and is cleared by close(). Prior to the fix, the
 * timer was .unref()'d, which caused the daemon process to exit silently
 * on the first disconnect instead of reconnecting.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

void mock.module("../../src/logger", () => ({
  logger: {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  },
}));

import { DaemonWsClient } from "../../src/daemon/ws-client";
import type { DaemonCapabilities } from "../../src/shared/daemon-types";
import { WS_CLOSE_CODES } from "../../src/shared/ws-messages";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static last: FakeWebSocket | null = null;

  readyState: number = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(public readonly url: string) {
    FakeWebSocket.last = this;
  }

  send(_data: unknown): void {}

  close(_code?: number, _reason?: string): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  fireClose(code: number, reason: string): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: false } as unknown as CloseEvent);
  }
}

const capabilitiesStub = {
  platform: "linux",
  ephemeral: false,
  network: { hostname: "test-host" },
} as unknown as DaemonCapabilities;

function makeClient(): DaemonWsClient {
  return new DaemonWsClient({
    orchestratorUrl: "ws://localhost:9999/ws",
    authToken: "test-token",
    daemonId: "test-daemon",
    capabilities: capabilitiesStub,
    onMessage: (): void => {},
  });
}

interface InternalState {
  reconnectTimer: { hasRef(): boolean } | null;
}

describe("DaemonWsClient reconnect-timer lifecycle", () => {
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    FakeWebSocket.last = null;
  });

  afterEach(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
  });

  it("schedules a ref'd reconnect timer so the event loop stays alive across backoff", () => {
    const client = makeClient();
    client.connect();
    expect(FakeWebSocket.last).not.toBeNull();

    // Simulate the failed-handshake path that surfaced the original bug.
    FakeWebSocket.last?.fireClose(1002, "Expected 101 status code");

    const timer = (client as unknown as InternalState).reconnectTimer;
    expect(timer).not.toBeNull();
    expect(timer?.hasRef()).toBe(true);

    // Cleanup: cancel pending timer so the test runner is not held alive.
    client.close();
  });

  it("close() clears the pending reconnect timer", () => {
    const client = makeClient();
    client.connect();
    FakeWebSocket.last?.fireClose(1006, "abnormal closure");

    expect((client as unknown as InternalState).reconnectTimer).not.toBeNull();

    client.close();

    expect((client as unknown as InternalState).reconnectTimer).toBeNull();
  });

  it("does not reconnect after an incompatible-protocol close", () => {
    const client = makeClient();
    client.connect();

    FakeWebSocket.last?.fireClose(
      WS_CLOSE_CODES.INCOMPATIBLE_PROTOCOL.code,
      WS_CLOSE_CODES.INCOMPATIBLE_PROTOCOL.reason,
    );

    expect((client as unknown as InternalState).reconnectTimer).toBeNull();
  });
});
