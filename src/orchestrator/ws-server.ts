import { timingSafeEqual } from "node:crypto";

import type { ServerWebSocket } from "bun";
import { z } from "zod";

import { config } from "../config";
import { logger } from "../logger";
import { workflowRunnerClientMessageSchema } from "../shared/workflow-runner-messages";
import { daemonMessageSchema, WS_CLOSE_CODES, WS_ERROR_CODES } from "../shared/ws-messages";
import {
  beginDaemonConnectionShutdown,
  drainDisconnectCleanups,
  handleDaemonMessage,
  handleWsClose,
  handleWsOpen,
} from "./connection-handler";
import {
  isWorkflowRunnerCapabilityValid,
  parseWorkflowRunnerPath,
} from "./workflow-runner-capability";
import {
  drainRunnerSessionReleases,
  handleWorkflowRunnerClose,
  handleWorkflowRunnerMessage,
  handleWorkflowRunnerOpen,
} from "./workflow-runner-controller";
import { sendError, type WsConnectionData } from "./ws-connection";

export { sendError, type WsConnectionData } from "./ws-connection";

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
  const runnerCapabilitySecret = config.workflowRunnerCapabilitySecret;
  if (runnerCapabilitySecret === undefined) {
    throw new Error("WORKFLOW_RUNNER_CAPABILITY_SECRET is required for WebSocket server");
  }
  const previousRunnerCapabilitySecret = config.workflowRunnerCapabilitySecretPrevious;
  if (previousAuthToken !== undefined && previousAuthToken === authToken) {
    // Misconfiguration: rotation overlap is a no-op when both slots hold the
    // same value. Warn loudly so the operator notices before assuming the
    // rolling-rotation procedure in `runbooks/daemon-fleet.md` is in flight.
    logger.warn(
      "DAEMON_AUTH_TOKEN_PREVIOUS equals DAEMON_AUTH_TOKEN, rotation slot has no effect. Drop _PREVIOUS once rotation completes, or set it to the prior token while rolling daemons.",
    );
  }
  const authExpectations = buildAuthExpectations(authToken, previousAuthToken);
  if (
    previousRunnerCapabilitySecret !== undefined &&
    previousRunnerCapabilitySecret === runnerCapabilitySecret
  ) {
    logger.warn(
      "WORKFLOW_RUNNER_CAPABILITY_SECRET_PREVIOUS equals WORKFLOW_RUNNER_CAPABILITY_SECRET, rotation slot has no effect.",
    );
  }

  server = Bun.serve<WsConnectionData>({
    port: config.wsPort,

    fetch(req, srv) {
      const url = new URL(req.url);
      const runnerIdentity = parseWorkflowRunnerPath(url.pathname);
      if (url.pathname !== "/ws" && runnerIdentity === null) {
        return new Response("Not Found", { status: 404 });
      }

      // Validate Authorization header against the primary token, plus the
      // optional rotation-window `_PREVIOUS` token. Comparison is constant-time
      // to avoid leaking the secret via response-latency side channels (#76).
      const authHeader = req.headers.get("authorization");
      const validRunnerIds =
        runnerIdentity !== null &&
        z.uuid().safeParse(runnerIdentity.runId).success &&
        z.uuid().safeParse(runnerIdentity.attemptId).success;
      const authenticated =
        runnerIdentity === null
          ? isAuthHeaderValid(authHeader, authExpectations)
          : validRunnerIds &&
            isWorkflowRunnerCapabilityValid(
              authHeader,
              runnerIdentity.runId,
              runnerIdentity.attemptId,
              runnerCapabilitySecret,
              previousRunnerCapabilitySecret,
            );
      if (!authenticated) {
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
        kind: runnerIdentity === null ? "daemon" : "workflow-runner",
        ...(runnerIdentity === null
          ? {}
          : {
              runnerRunId: runnerIdentity.runId,
              runnerAttemptId: runnerIdentity.attemptId,
              runnerRegistered: false,
            }),
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
        if (ws.data.kind === "workflow-runner") handleWorkflowRunnerOpen(ws);
        else handleWsOpen(ws);
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

        if (ws.data.kind === "workflow-runner") {
          const result = workflowRunnerClientMessageSchema.safeParse(parsed);
          if (!result.success) {
            ws.close(WS_CLOSE_CODES.POLICY_VIOLATION.code, "invalid workflow runner message");
            return;
          }
          handleWorkflowRunnerMessage(ws, result.data);
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
        if (ws.data.kind === "workflow-runner") handleWorkflowRunnerClose(ws);
        else handleWsClose(ws, code, reason);
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
    beginDaemonConnectionShutdown();
    await Promise.race([
      stopping.stop(true),
      new Promise<void>((resolve) => setTimeout(resolve, STOP_DRAIN_TIMEOUT_MS)),
    ]);
    await drainDisconnectCleanups();
    await drainRunnerSessionReleases();
    logger.info("WebSocket server stopped");
  }
}
