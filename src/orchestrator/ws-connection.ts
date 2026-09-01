import type { ServerWebSocket } from "bun";

import { createMessageEnvelope } from "../shared/ws-messages";

/** Per-connection data attached during the HTTP WebSocket upgrade. */
export interface WsConnectionData {
  readonly authenticated: boolean;
  readonly remoteAddr: string;
  daemonId: string | undefined;
  kind?: "daemon" | "workflow-runner";
  runnerRunId?: string;
  runnerAttemptId?: string;
  runnerRegistered?: boolean;
}

/** Send a protocol error on a daemon WebSocket. */
export function sendError(
  ws: ServerWebSocket<WsConnectionData>,
  correlationId: string,
  code: string,
  message: string,
): void {
  ws.sendText(
    JSON.stringify({
      type: "error",
      ...createMessageEnvelope(correlationId),
      payload: { code, message },
    }),
  );
}
