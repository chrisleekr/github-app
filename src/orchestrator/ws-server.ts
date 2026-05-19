import { timingSafeEqual } from "node:crypto";

import type { ServerWebSocket } from "bun";

import { config } from "../config";
import { logger } from "../logger";
import {
  createMessageEnvelope,
  daemonMessageSchema,
  WS_CLOSE_CODES,
  WS_ERROR_CODES,
} from "../shared/ws-messages";
import { handleDaemonMessage, handleWsClose, handleWsOpen } from "./connection-handler";

/**
 * Per-connection data attached to each WebSocket via ws.data.
 * Set during the HTTP upgrade in the fetch handler.
 */
export interface WsConnectionData {
  /** Authenticated after token check in fetch handler. */
  authenticated: boolean;
  /** Remote address for logging. */
  remoteAddr: string;
  /** Daemon ID, set after daemon:register is processed. */
  daemonId: string | undefined;
}

let server: ReturnType<typeof Bun.serve<WsConnectionData>> | null = null;

/**
 * Precomputed expected `Authorization` header values for the comparator.
 * Built once in `startWebSocketServer()` and reused per request so each
 * upgrade attempt does only `O(padLength)` allocation/copy work instead of
 * re-encoding two `Bearer …` strings on every call. Also caps auth-flood
 * amplification: a malicious client with a very long `Authorization`
 * header still triggers only fixed-size work in the comparator.
 */
interface AuthExpectations {
  readonly primaryPadded: Buffer;
  readonly primaryLength: number;
  readonly previousPadded: Buffer;
  /**
   * Original (un-padded) byte length of `Bearer ${previousToken}`, or `-1`
   * when no previous token is configured. The sentinel is chosen so the
   * length-equality guard rejects unconditionally: `Buffer.byteLength` is
   * always non-negative.
   */
  readonly previousLength: number;
  readonly padLength: number;
}

export function buildAuthExpectations(
  primaryToken: string,
  previousToken: string | undefined,
): AuthExpectations {
  const expectedPrimary = Buffer.from(`Bearer ${primaryToken}`, "utf8");
  const expectedPrevious =
    previousToken !== undefined && previousToken.length > 0
      ? Buffer.from(`Bearer ${previousToken}`, "utf8")
      : null;
  const padLength = Math.max(expectedPrimary.length, expectedPrevious?.length ?? 0);

  const primaryPadded = Buffer.alloc(padLength);
  expectedPrimary.copy(primaryPadded);

  // Always allocate `previousPadded` (zero-filled sentinel when no rotation
  // token is configured) and use `previousLength = -1` as a sentinel that
  // can never equal `Buffer.byteLength(headerStr, "utf8")` (which is always
  // ≥ 0). This lets `isAuthHeaderValid` run exactly two `timingSafeEqual`
  // calls per request regardless of whether `_PREVIOUS` is set, eliminating
  // the timing asymmetry between rotation-active and rotation-inactive
  // deployments.
  const previousPadded = Buffer.alloc(padLength);
  let previousLength = -1;
  if (expectedPrevious !== null) {
    expectedPrevious.copy(previousPadded);
    previousLength = expectedPrevious.length;
  }

  return {
    primaryPadded,
    primaryLength: expectedPrimary.length,
    previousPadded,
    previousLength,
    padLength,
  };
}

/**
 * Constant-time bearer-token comparator. JavaScript's `===`/`!==` short-circuits
 * on the first mismatched byte, leaking the matching prefix length through
 * response latency: a known timing-attack surface for bearer-token auth (#76).
 *
 * Per-request copy work is bounded by `padLength`: `actual.write(..., padLength,
 * ...)` truncates input longer than `padLength` and `Buffer.alloc(padLength)`
 * gives a fixed-size comparison buffer. Total work additionally includes one
 * `Buffer.byteLength` walk of the incoming header: bounded in practice by
 * Bun's HTTP header limit, not by `padLength`. The byte-length is used (rather
 * than `actual.length`) so the length-equality guard still rejects
 * longer-with-correct-prefix headers that the truncating `write` would
 * otherwise paper over.
 *
 * Accepts either the primary or the optional rotation-window previous token.
 * Both `timingSafeEqual` calls run unconditionally (the previous slot uses a
 * zero-buffer sentinel + `previousLength = -1` when not configured) so a
 * caller cannot distinguish "rejected by primary" from "rejected by previous"
 * or "rotation active" from "rotation inactive": via timing. The two
 * length-equality checks are combined with bitwise `&` and the per-token
 * results with bitwise `|` to avoid the JS `&&`/`||` short-circuit.
 */
export function isAuthHeaderValid(
  authHeader: string | null | undefined,
  expectations: AuthExpectations,
): boolean {
  const headerStr = authHeader ?? "";
  // Compute the original byte length without allocating a buffer sized to
  // the (potentially attacker-controlled) header. The length-equality
  // checks below use this to reject longer-with-correct-prefix attacks
  // even though we only copy `padLength` bytes into `actual`.
  const headerByteLength = Buffer.byteLength(headerStr, "utf8");

  // Pad to `padLength` so timingSafeEqual never throws on a length
  // mismatch and the wrong-length path does the same amount of work as
  // the equal-length path. `.write(..., padLength, ...)` truncates input
  // longer than `padLength`, bounding per-request work to a constant.
  const actual = Buffer.alloc(expectations.padLength);
  actual.write(headerStr, 0, expectations.padLength, "utf8");

  // Both `timingSafeEqual` calls always run, when no `_PREVIOUS` token is
  // configured, `previousPadded` is a zero-filled sentinel and
  // `previousLength === -1`, so the length-equality guard rejects
  // unconditionally without taking a different code path.
  const primaryEq = timingSafeEqual(actual, expectations.primaryPadded);
  const primaryLenEq = headerByteLength === expectations.primaryLength;
  const previousEq = timingSafeEqual(actual, expectations.previousPadded);
  const previousLenEq = headerByteLength === expectations.previousLength;

  // Bitwise `&`/`|` avoid the JS `&&`/`||` short-circuit so every operand
  // is evaluated regardless of earlier results.
  const matchPrimary = Number(primaryEq) & Number(primaryLenEq);
  const matchPrevious = Number(previousEq) & Number(previousLenEq);
  return (matchPrimary | matchPrevious) === 1;
}

/**
 * Start the WebSocket server on WS_PORT.
 * Validates DAEMON_AUTH_TOKEN in the fetch (upgrade) handler per R-009.
 * Returns the Bun Server instance for shutdown coordination.
 */
export function startWebSocketServer(): ReturnType<typeof Bun.serve<WsConnectionData>> {
  if (server !== null) return server;

  const authToken = config.daemonAuthToken;
  if (authToken === undefined) {
    throw new Error("DAEMON_AUTH_TOKEN is required for WebSocket server");
  }
  const previousAuthToken = config.daemonAuthTokenPrevious;
  if (previousAuthToken !== undefined && previousAuthToken === authToken) {
    // Misconfiguration: rotation overlap is a no-op when both slots hold the
    // same value. Warn loudly so the operator notices before assuming the
    // rolling-rotation procedure in `runbooks/daemon-fleet.md` is in flight.
    logger.warn(
      "DAEMON_AUTH_TOKEN_PREVIOUS equals DAEMON_AUTH_TOKEN, rotation slot has no effect. Drop _PREVIOUS once rotation completes, or set it to the prior token while rolling daemons.",
    );
  }
  const authExpectations = buildAuthExpectations(authToken, previousAuthToken);

  server = Bun.serve<WsConnectionData>({
    port: config.wsPort,

    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname !== "/ws") {
        return new Response("Not Found", { status: 404 });
      }

      // Validate Authorization header against the primary token, plus the
      // optional rotation-window `_PREVIOUS` token. Comparison is constant-time
      // to avoid leaking the secret via response-latency side channels (#76).
      const authHeader = req.headers.get("authorization");
      if (!isAuthHeaderValid(authHeader, authExpectations)) {
        logger.warn(
          { remoteAddr: srv.requestIP(req)?.address },
          "WebSocket auth failed, invalid token",
        );
        return new Response("Unauthorized", { status: 401 });
      }

      const connectionData: WsConnectionData = {
        authenticated: true,
        remoteAddr: srv.requestIP(req)?.address ?? "unknown",
        daemonId: undefined,
      };

      const upgraded = srv.upgrade(req, { data: connectionData });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 500 });
      }
      // Bun handles the 101 response when upgrade succeeds, no explicit return needed.
      return undefined;
    },

    websocket: {
      // Application-level pings are handled in connection-handler.ts (FM-2).
      // Bun's sendPings keeps TCP alive as a backstop for half-open connections.
      sendPings: true,
      idleTimeout: 120,
      maxPayloadLength: 1024 * 1024, // 1 MB

      open(ws: ServerWebSocket<WsConnectionData>) {
        logger.info({ remoteAddr: ws.data.remoteAddr }, "WebSocket connection opened");
        handleWsOpen(ws);
      },

      message(ws: ServerWebSocket<WsConnectionData>, message: string | Buffer) {
        const raw = typeof message === "string" ? message : message.toString("utf-8");

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          sendError(ws, crypto.randomUUID(), WS_ERROR_CODES.INVALID_MESSAGE, "Invalid JSON");
          ws.close(WS_CLOSE_CODES.POLICY_VIOLATION.code, WS_CLOSE_CODES.POLICY_VIOLATION.reason);
          return;
        }

        const result = daemonMessageSchema.safeParse(parsed);
        if (!result.success) {
          const correlationId =
            typeof parsed === "object" && parsed !== null && "id" in parsed
              ? String((parsed as { id: unknown }).id)
              : crypto.randomUUID();
          sendError(
            ws,
            correlationId,
            WS_ERROR_CODES.INVALID_MESSAGE,
            `Schema validation failed: ${result.error.message}`,
          );
          return;
        }

        handleDaemonMessage(ws, result.data);
      },

      close(ws: ServerWebSocket<WsConnectionData>, code: number, reason: string) {
        logger.info({ daemonId: ws.data.daemonId, code, reason }, "WebSocket connection closed");
        handleWsClose(ws, code, reason);
      },
    },
  });

  logger.info({ port: config.wsPort }, "WebSocket server started");
  return server;
}

/**
 * Stop the WebSocket server and wait for in-flight drain.
 * Called during graceful shutdown: the caller must await so that daemon
 * disconnect cleanup paths finish before downstream resources (Valkey, DB)
 * are closed.
 *
 * We race `server.stop(true)` against a 2s timeout because Bun's graceful
 * drain can stall when a client fails to ACK the close frame; letting it
 * block indefinitely would deadlock shutdown and hang tests that rely on
 * server re-creation between cases.
 */
const STOP_DRAIN_TIMEOUT_MS = 2000;

export async function stopWebSocketServer(): Promise<void> {
  if (server !== null) {
    const stopping = server;
    server = null;
    await Promise.race([
      stopping.stop(true),
      new Promise<void>((resolve) => setTimeout(resolve, STOP_DRAIN_TIMEOUT_MS)),
    ]);
    logger.info("WebSocket server stopped");
  }
}

/**
 * Send an error message to a daemon WebSocket connection.
 */
export function sendError(
  ws: ServerWebSocket<WsConnectionData>,
  correlationId: string,
  code: string,
  message: string,
): void {
  const envelope = createMessageEnvelope(correlationId);
  ws.sendText(
    JSON.stringify({
      type: "error",
      ...envelope,
      payload: { code, message },
    }),
  );
}
