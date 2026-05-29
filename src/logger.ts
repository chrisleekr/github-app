import pino from "pino";

import { config } from "./config";
import { errSerializer, REDACT_PATHS, scrubStructured } from "./utils/log-redaction";

// The redaction primitives moved to the config-free `utils/log-redaction`
// module (issue #172) so the stdio MCP subprocesses can build a pino logger
// with the same scrubbing without importing `config`. Re-exported here so
// existing importers (and tests) can keep importing them from "./logger".
export { errSerializer, REDACT_PATHS } from "./utils/log-redaction";

/**
 * Root logger instance.
 * JSON output in production, pino-pretty in development.
 *
 * Redaction is configured at this level so EVERY child logger and
 * EVERY emitted line passes through the same chokepoint: point
 * helpers like `redactGitHubTokens` (`src/utils/sanitize.ts`) and
 * `redactValkeyUrl` (`src/orchestrator/valkey.ts`) only cover their
 * own call sites. See `docs/operate/observability.md`.
 */
export const logger = pino({
  level: config.logLevel,
  // Pino's `redact.paths` is typed as `string[]` (mutable); spread the
  // frozen exported list into a fresh array so the runtime value pino
  // owns is independent of the canonical export.
  redact: { paths: [...REDACT_PATHS] },
  serializers: { err: errSerializer },
  ...(config.nodeEnv === "development" ? { transport: { target: "pino-pretty" } } : {}),
});

/**
 * Create a child logger scoped to a specific webhook delivery.
 * Consistent fields across all log lines for a single request: every
 * caller emits the entity identifier under the canonical `entityNumber`
 * so an operator can grep one field name to reconstruct a request
 * end-to-end, regardless of whether it originated on an issue or a PR.
 *
 * The required four fields are the correlation contract; arbitrary extra
 * bindings (event, label, senderLogin, ...) are allowed so handlers can
 * route their per-handler context through this single helper instead of
 * hand-rolling `logger.child` and drifting the entity field name.
 */
export function createChildLogger(
  fields: {
    deliveryId: string;
    owner: string;
    repo: string;
    entityNumber: number;
  } & Record<string, unknown>,
): pino.Logger {
  return logger.child(fields);
}

/**
 * Register process-level crash handlers that route `uncaughtException` and
 * `unhandledRejection` through this pino logger before exiting non-zero.
 *
 * Without these, the runtime's default handler prints a plain stderr stack
 * that never passes through `errSerializer`, so a credential echoed in an
 * octokit error message or stack (e.g. a `ghs_…` token) reaches the log
 * shipper in cleartext. Logging via `logger.fatal({ err })` applies the same
 * `REDACT_PATHS` + `errSerializer` scrubbing every other line gets.
 *
 * `processName` distinguishes orchestrator vs daemon crash lines in the shared
 * aggregator. Register once per process, alongside the signal handlers.
 *
 * Flushing: the default (production) destination is a SonicBoom stream that
 * flushes synchronously on the process `exit` event, so the fatal line is
 * written before `process.exit(1)` takes effect (verified empirically under
 * Bun). `pino.final` is deliberately NOT used despite being the textbook
 * exit-logging helper: it throws when the logger is built with a `transport`
 * (the dev-only `pino-pretty` config here), and the on-exit flush already
 * guarantees delivery on the production path.
 */
export function installFatalHandlers(processName: "orchestrator" | "daemon"): void {
  const onFatal =
    (kind: "uncaughtException" | "unhandledRejection") =>
    (reason: unknown): void => {
      // `unhandledRejection` can deliver a non-Error reason (a bare string or
      // object, e.g. `Promise.reject("...ghs_token...")`). `errSerializer`
      // only scrubs Error objects, so coerce first: that puts the reason into
      // an Error message/stack where the secret-strip pass runs on it. Without
      // this, a token in a string/object rejection reaches the log shipper in
      // cleartext, the exact leak #164 set out to close.
      logger.fatal({ err: toFatalError(reason), processName }, kind);
      process.exit(1);
    };
  process.on("uncaughtException", onFatal("uncaughtException"));
  process.on("unhandledRejection", onFatal("unhandledRejection"));
}

/**
 * Coerce an arbitrary crash reason into an Error so `errSerializer` scrubs it.
 * Strings and JSON-serialisable objects are stringified into the message (the
 * token regex still matches there); a value that cannot be stringified (e.g.
 * a circular object) falls back to `String(...)`, which drops detail but never
 * leaks a token.
 */
function toFatalError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === "string") return new Error(reason);
  try {
    // Scrub by field name before flattening: once the object becomes a JSON
    // string the structure is gone, so an opaque secret in a sensitive key
    // (authorization/token/...) could only be caught by the message regex,
    // which misses non-pattern secrets. scrubStructured censors those keys
    // up front; the message-level regex still runs at log time as a backstop.
    return new Error(JSON.stringify(scrubStructured(reason)));
  } catch {
    return new Error(String(reason));
  }
}

export type Logger = pino.Logger;
