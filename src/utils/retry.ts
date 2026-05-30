import pino from "pino";

import type { Logger } from "../logger";
import { errSerializer, REDACT_PATHS, resolveLogLevel } from "./log-redaction";

// Config-free default logger (issue #184). Importing retry.ts must not pull in
// src/logger.ts -> src/config, so the stdio MCP servers that use retry (e.g.
// resolve-review-thread) stay config-free. `import type { Logger }` above is
// erased at emit, so it adds no runtime coupling. Same REDACT_PATHS +
// errSerializer as the root logger keeps redaction parity. The level reads
// LOG_LEVEL directly (config is intentionally not imported) via resolveLogLevel,
// which falls back to `info` on an invalid value so pino can't throw at import.
// Level visibility matches the root logger because both derive from LOG_LEVEL.
//
// Writes to stderr (like createMcpLogger), NOT pino's default stdout: a stdio
// MCP server speaks JSON-RPC over stdout, so a default-path retry warning on
// stdout would corrupt the protocol. stderr is safe in every context (k8s
// ships both streams; warn/error on stderr is conventional).
const defaultLog: Logger = pino(
  {
    level: resolveLogLevel(process.env["LOG_LEVEL"]),
    redact: { paths: [...REDACT_PATHS] },
    serializers: { err: errSerializer },
  },
  process.stderr,
);

/**
 * Retry configuration options.
 * Ported from claude-code-action's src/utils/retry.ts
 */
export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  /** Optional scoped logger. Defaults to the root logger when omitted. */
  log?: Logger;
}

/**
 * Validate a numeric retry option. Throws a descriptive Error identifying the
 * offending option name and value when the value is not finite, optionally not
 * an integer, or below the allowed minimum.
 *
 * Guards against the NaN/Infinity bypass of a naive `value < min` check:
 * `NaN < 1` is `false`, so a plain comparison would silently accept NaN and
 * later cause `throw undefined` in the exhaustion path.
 *
 * @param name - Option name used in the error message (e.g. "maxAttempts").
 * @param value - The numeric value to validate.
 * @param opts - Validation constraints: `min` (inclusive lower bound) and
 *   optional `requireInteger` flag for options that must be whole numbers.
 * @throws Error when the value is not finite, not an integer (when required),
 *   or below `min`.
 */
function validateNumberOption(
  name: string,
  value: number,
  opts: { min: number; requireInteger?: boolean },
): void {
  if (!Number.isFinite(value)) {
    throw new Error(`retryWithBackoff: ${name} must be a finite number, got ${String(value)}`);
  }
  if (opts.requireInteger === true && !Number.isInteger(value)) {
    throw new Error(`retryWithBackoff: ${name} must be an integer, got ${String(value)}`);
  }
  if (value < opts.min) {
    throw new Error(
      `retryWithBackoff: ${name} must be >= ${String(opts.min)}, got ${String(value)}`,
    );
  }
}

/**
 * Retry an async operation with exponential backoff.
 * Pass the delivery-scoped ctx.log to preserve deliveryId correlation in logs.
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 5000,
    maxDelayMs = 20000,
    backoffFactor = 2,
    log = defaultLog,
  } = options;

  // Fail fast on invalid input. Each check names the offending option and
  // value. Without these guards, NaN/Infinity/below-min values could bypass
  // the loop entirely and cause `throw lastError` to throw literal `undefined`.
  validateNumberOption("maxAttempts", maxAttempts, { min: 1, requireInteger: true });
  validateNumberOption("initialDelayMs", initialDelayMs, { min: 0 });
  validateNumberOption("maxDelayMs", maxDelayMs, { min: 0 });
  validateNumberOption("backoffFactor", backoffFactor, { min: 1 });

  let delayMs = initialDelayMs;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Do not retry permanent client errors (4xx except 429 Too Many Requests).
      // Octokit wraps HTTP errors with a .status property; non-HTTP errors lack it.
      const status = (error as { status?: number }).status;
      if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
        log.warn({ attempt, status, err: lastError }, "Non-retriable error, throwing immediately");
        throw lastError;
      }

      log.warn({ attempt, maxAttempts, err: lastError }, "Operation attempt failed");

      if (attempt < maxAttempts) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * backoffFactor, maxDelayMs);
      }
    }
  }

  log.error({ maxAttempts }, "Operation failed after all attempts");
  // Safe to assert: `maxAttempts >= 1` is enforced above, so the loop ran
  // at least once, meaning `lastError` was assigned in the catch block.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  throw lastError!;
}
