import { release } from "node:os";

import { logger } from "../logger";
import type { DaemonCapabilities } from "../shared/daemon-types";
import {
  createMessageEnvelope,
  PROTOCOL_VERSION,
  type ServerMessage,
  serverMessageSchema,
} from "../shared/ws-messages";
import { redactErrorMessage } from "../utils/log-redaction";
import { DAEMON_CONNECTION_LOG_EVENTS } from "./log-fields";

// Read version from package.json at module load
const APP_VERSION: string = ((): string => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Bun supports require for JSON; dynamic import would be async
    const pkg = require("../../package.json") as { version: string };
    return pkg.version;
  } catch {
    return "0.0.0";
  }
})();

/**
 * Decorrelated jitter backoff for reconnection (R-002).
 * Base: 1s, Cap: 30s. Formula: min(cap, random_between(base, sleep * 3))
 * Per: https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
 */
function nextBackoff(previousMs: number, baseMs: number, capMs: number): number {
  const ceiling = Math.max(baseMs, previousMs * 3);
  return Math.min(capMs, baseMs + Math.random() * (ceiling - baseMs));
}

export interface WsClientOptions {
  orchestratorUrl: string;
  authToken: string;
  daemonId: string;
  capabilities: DaemonCapabilities;
  onMessage: (msg: ServerMessage) => void;
}

/**
 * WebSocket client with auto-reconnection using decorrelated jitter backoff.
 * Connects to the orchestrator, sends daemon:register on open.
 */
export class DaemonWsClient {
  private ws: WebSocket | null = null;
  private reconnecting = false;
  private closed = false;
  private backoffMs = 1000;
  private reconnectTimer: Timer | null = null;

  // Connection-lifecycle observability (issue #218). attempt is 1 on the first
  // connect and increments per reconnect, reset to 0 on a clean onopen.
  // Timestamps drive the downtime / connect-time / connected-duration deltas;
  // 0 means "not yet observed", so the first connect reports downtime_ms: 0.
  private attempt = 0;
  private connectStartedAt = 0;
  private lastOpenedAt = 0;
  private lastClosedAt = 0;

  private readonly BASE_BACKOFF_MS = 1000;
  private readonly CAP_BACKOFF_MS = 30_000;

  constructor(private readonly opts: WsClientOptions) {}

  /** Connect to the orchestrator. */
  connect(): void {
    if (this.closed) return;

    this.attempt += 1;
    this.connectStartedAt = Date.now();
    const downtimeMs = this.lastClosedAt > 0 ? this.connectStartedAt - this.lastClosedAt : 0;
    logger.info(
      {
        event: DAEMON_CONNECTION_LOG_EVENTS.connectAttempt,
        attempt: this.attempt,
        downtime_ms: downtimeMs,
        previous_backoff_ms: Math.round(this.backoffMs),
      },
      "Connecting to orchestrator",
    );

    try {
      this.ws = new WebSocket(this.opts.orchestratorUrl, {
        headers: {
          Authorization: `Bearer ${this.opts.authToken}`,
        },
      });
    } catch (err) {
      // Omit `message` when redaction empties it: the schema pins
      // `message: z.string().min(1).optional()`, and an empty string is both
      // schema-invalid and useless in logs.
      const message = redactErrorMessage(err);
      logger.error(
        {
          event: DAEMON_CONNECTION_LOG_EVENTS.error,
          readyState: this.ws?.readyState ?? null,
          ...(message !== "" ? { message } : {}),
        },
        "Failed to create WebSocket connection",
      );
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = (): void => {
      this.lastOpenedAt = Date.now();
      logger.info(
        {
          event: DAEMON_CONNECTION_LOG_EVENTS.connected,
          attempt: this.attempt,
          time_to_connect_ms: this.lastOpenedAt - this.connectStartedAt,
          downtime_ms: this.lastClosedAt > 0 ? this.lastOpenedAt - this.lastClosedAt : 0,
        },
        "Connected to orchestrator",
      );
      this.backoffMs = this.BASE_BACKOFF_MS;
      this.attempt = 0;
      this.reconnecting = false;
      this.sendRegister();
    };

    this.ws.onmessage = (event: MessageEvent): void => {
      const raw = typeof event.data === "string" ? event.data : String(event.data);

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        logger.warn("Received invalid JSON from orchestrator");
        return;
      }

      const result = serverMessageSchema.safeParse(parsed);
      if (!result.success) {
        logger.warn({ error: result.error.message }, "Received invalid message from orchestrator");
        return;
      }

      this.opts.onMessage(result.data);
    };

    this.ws.onclose = (event: CloseEvent): void => {
      this.lastClosedAt = Date.now();
      logger.info(
        {
          event: DAEMON_CONNECTION_LOG_EVENTS.disconnected,
          code: event.code,
          reason: event.reason,
          connected_duration_ms: this.lastOpenedAt > 0 ? this.lastClosedAt - this.lastOpenedAt : 0,
        },
        "Disconnected from orchestrator",
      );
      if (!this.closed) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (event: Event): void => {
      const maybeMessage = (event as { message?: unknown }).message;
      // Omit `message` when absent or emptied by redaction: the schema pins
      // `message: z.string().min(1).optional()`.
      const message = typeof maybeMessage === "string" ? redactErrorMessage(maybeMessage) : "";
      logger.error(
        {
          event: DAEMON_CONNECTION_LOG_EVENTS.error,
          readyState: this.ws?.readyState ?? null,
          ...(message !== "" ? { message } : {}),
        },
        "WebSocket error",
      );
    };
  }

  /** Send a message to the orchestrator. Returns false if the send was dropped. */
  send(message: unknown): boolean {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return true;
    }
    logger.warn("Cannot send, WebSocket not connected");
    return false;
  }

  /** Send the daemon:register message on connection open. */
  private sendRegister(): void {
    const { hostname } = this.opts.capabilities.network;

    this.send({
      type: "daemon:register",
      ...createMessageEnvelope(),
      payload: {
        daemonId: this.opts.daemonId,
        hostname,
        platform: this.opts.capabilities.platform,
        osVersion: release(),
        protocolVersion: PROTOCOL_VERSION,
        appVersion: APP_VERSION,
        capabilities: this.opts.capabilities,
      },
    });
  }

  /** Schedule a reconnection with decorrelated jitter backoff. */
  private scheduleReconnect(): void {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;

    this.backoffMs = nextBackoff(this.backoffMs, this.BASE_BACKOFF_MS, this.CAP_BACKOFF_MS);
    logger.warn(
      {
        event: DAEMON_CONNECTION_LOG_EVENTS.reconnectScheduled,
        // The upcoming connect() will bump `attempt` to this value.
        attempt: this.attempt + 1,
        backoff_ms: Math.round(this.backoffMs),
      },
      "Reconnecting to orchestrator",
    );

    const timer = setTimeout(() => {
      this.reconnecting = false;
      this.connect();
    }, this.backoffMs);
    // NOTE: Timer is intentionally ref'd so the daemon keeps the event loop
    // alive across reconnect backoff. Graceful shutdown is still clean because
    // close() clears this timer and the setInterval inside
    // initiateGracefulShutdown holds the loop on its own.
    this.reconnectTimer = timer;
  }

  /** Gracefully close the connection. No reconnect. */
  close(code = 1000, reason = "graceful shutdown"): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws !== null) {
      this.ws.close(code, reason);
      this.ws = null;
    }
  }

  /** Check if the client is connected. */
  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
