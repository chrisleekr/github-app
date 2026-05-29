/**
 * Structured pino logger for stdio MCP servers (issue #172).
 *
 * MCP servers speak JSON-RPC over stdout, so the logger MUST write to stderr
 * (writing to stdout would corrupt the protocol stream). It applies the same
 * `REDACT_PATHS` + `errSerializer` as the main logger, imported from the
 * config-free `utils/log-redaction` module so this stays importable inside the
 * MCP subprocess (which has no daemon `config`). Binds `server` and the
 * inherited `deliveryId` so a server's lines correlate with the parent request.
 *
 * Replaces the per-server `console.error` calls, which emitted unstructured,
 * unredacted lines (a raw `console.error(err)` on an Octokit RequestError could
 * leak a `ghs_…` token verbatim).
 */
import pino from "pino";

import { errSerializer, REDACT_PATHS } from "../utils/log-redaction";

export function createMcpLogger(serverName: string): pino.Logger {
  const deliveryId = process.env["DELIVERY_ID"];
  return pino(
    {
      level: process.env["LOG_LEVEL"] ?? "info",
      base: {
        server: serverName,
        ...(deliveryId !== undefined && deliveryId !== "" ? { deliveryId } : {}),
      },
      redact: { paths: [...REDACT_PATHS] },
      serializers: { err: errSerializer },
    },
    process.stderr,
  );
}
