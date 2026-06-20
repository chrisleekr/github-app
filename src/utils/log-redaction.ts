/**
 * Config-free secret-redaction primitives for pino loggers.
 *
 * Extracted from `src/logger.ts` (issue #172) so the stdio MCP servers, which
 * run as subprocesses without the daemon `config`, can build a pino logger with
 * the SAME `REDACT_PATHS` + `errSerializer` as the main logger instead of raw
 * `console.error`. This module imports neither `src/config` nor the pino
 * instance, so importing it has no side effect and pulls in no config
 * validation. `src/logger.ts` re-exports `REDACT_PATHS` and `errSerializer` for
 * back-compat with existing importers.
 */
import pino, { type SerializedError } from "pino";

import { redactGitHubTokens, redactSecrets } from "./sanitize";

const VALID_PINO_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal", "silent"]);

/**
 * Resolve a pino `level` from a raw env value, config-free.
 *
 * pino 10 throws at construction on a non-core level string (e.g. a typo'd
 * `LOG_LEVEL`), so a logger built straight from `process.env` would crash at
 * module import. The main process is protected by config's zod enum, but the
 * stdio MCP subprocesses and `retryWithBackoff`'s default logger deliberately
 * do NOT load config, so they validate here and fall back to `info` on anything
 * unrecognised. See issue #184.
 */
export function resolveLogLevel(raw: string | undefined): string {
  return raw !== undefined && VALID_PINO_LEVELS.has(raw) ? raw : "info";
}

/**
 * Path-based redaction list for pino loggers.
 *
 * These cover the *named-field* leak surface: any log object whose key path
 * matches a pattern below is replaced with the censor placeholder before
 * the line is emitted. Pino's path syntax supports `*` wildcards at one
 * intermediate level and bracket notation for keys with hyphens.
 *
 * The `err` serializer below handles the *free-text* leak surface
 * (secrets embedded in error messages and stacks).
 */
export const REDACT_PATHS: readonly string[] = Object.freeze([
  // Generic auth tokens, Octokit RequestError carries these on err.request.headers
  "authorization",
  "*.authorization",
  "headers.authorization",
  "*.headers.authorization",
  "req.headers.authorization",
  "request.headers.authorization",
  // Webhook signature header, octokit lowercases incoming header names
  'headers["x-hub-signature-256"]',
  '*.headers["x-hub-signature-256"]',
  'req.headers["x-hub-signature-256"]',
  'request.headers["x-hub-signature-256"]',
  // GitHub 401 bodies sometimes echo a token field
  "response.data.token",
  // Generic credential fields used throughout the codebase
  "token",
  "installationToken",
  "privateKey",
  "webhookSecret",
  "anthropicApiKey",
  "claudeCodeOauthToken",
  "daemonAuthToken",
  "daemonAuthTokenPrevious",
  "awsSecretAccessKey",
  "awsSessionToken",
  "awsBearerTokenBedrock",
  "*.password",
]);

/**
 * Sensitive key names checked by the structural walker that runs inside
 * the `err` serializer (lowercase for case-insensitive comparison).
 *
 * Pino's path-based `redact.paths` cannot match these when they sit
 * nested under `err.request.headers.*` or `err.response.data.*` (and
 * deeper): the walker fills that gap. Keep this list in sync with the
 * bare-name entries in `REDACT_PATHS` above.
 */
const SENSITIVE_FIELD_NAMES_LC: ReadonlySet<string> = new Set([
  "authorization",
  "token",
  "installationtoken",
  "privatekey",
  "webhooksecret",
  "anthropicapikey",
  "claudecodeoauthtoken",
  "daemonauthtoken",
  "daemonauthtokenprevious",
  "awssecretaccesskey",
  "awssessiontoken",
  "awsbearertokenbedrock",
  "password",
  "x-hub-signature-256",
]);

/**
 * Strip user:pass credentials from any URL in free-text. Mirrors the
 * URL-parse approach in `redactValkeyUrl` (`src/orchestrator/valkey.ts`)
 * but as a regex so it can run over arbitrary message/stack strings
 * without having to first locate the URL boundaries.
 */
function redactCredentialUrls(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+\-.]*:\/\/)([^@/\s:]+):([^@/\s]+)@/gi, "$1***:***@");
}

/**
 * Redact secrets from an error before it crosses the trust boundary into the
 * agent's tool-result channel. Strips matched bytes with no marker (security
 * invariant 2: a marker leaks probing signal). Covers every redactSecrets
 * shape plus the x-access-token:<token>@host credential URLs Octokit echoes.
 */
export function redactErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactSecrets(redactCredentialUrls(raw)).body;
}

/** Censor placeholder, matches pino's default so output is uniform. */
const CENSOR = "[Redacted]";

/** Compose all string-scrubbers applied to free-text fields. */
function scrubString(value: string): string {
  return redactCredentialUrls(redactGitHubTokens(value));
}

/**
 * Recursively scrub a structured value (string / array / plain object).
 *
 * - Strings pass through `scrubString` (GitHub-token + credential-URL regex).
 * - Arrays recurse element-wise.
 * - Plain objects recurse: keys whose lower-cased name is in
 *   `SENSITIVE_FIELD_NAMES_LC` are replaced with `CENSOR` wholesale; other
 *   values recurse so a nested `token` / `privateKey` / etc. still gets
 *   caught at any depth.
 *
 * Used by the `err` serializer to scrub `request.headers` and
 * `response.data` because pino's path-based `redact.paths` cannot reach
 * fields four-or-more segments deep on `err.*` (see the surrounding
 * doc-comment on `errSerializer`). Returns fresh objects/arrays so the
 * original Error is never mutated.
 */
export function scrubStructured(value: unknown): unknown {
  if (typeof value === "string") {
    return scrubString(value);
  }
  if (Array.isArray(value)) {
    return value.map(scrubStructured);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      /* eslint-disable security/detect-object-injection -- key originates from Object.entries on an object the pino err serializer just produced; not user-controlled. */
      out[k] = SENSITIVE_FIELD_NAMES_LC.has(k.toLowerCase()) ? CENSOR : scrubStructured(v);
      /* eslint-enable security/detect-object-injection */
    }
    return out;
  }
  return value;
}

/**
 * Custom error serializer.
 *
 * Defers to pino's default `stdSerializers.err` (so the shape stays
 * compatible with downstream tooling) and then runs string-scrubbers
 * over the fields that empirically carry secrets:
 *
 * - `message` and `stack`: Octokit `RequestError` includes the URL
 *   and sometimes the response body in its message; both can echo a
 *   `ghs_…` installation token or an App JWT verbatim.
 * - `request.headers`: `authorization` is covered by the redact path
 *   list above, but other free-text headers may also carry secrets.
 * - `response.data`: when the upstream replies with a JSON-encoded
 *   error body that includes a token.
 *
 * Operates on a copy so the original Error object is never mutated.
 */
function scrubRequest(request: object): Record<string, unknown> {
  const reqObj = request as { headers?: unknown } & Record<string, unknown>;
  const headers = reqObj.headers;
  if (headers !== null && typeof headers === "object") {
    return { ...reqObj, headers: scrubStructured(headers) as Record<string, unknown> };
  }
  return { ...reqObj };
}

function scrubResponse(response: object): Record<string, unknown> {
  const resObj = response as { data?: unknown } & Record<string, unknown>;
  if (typeof resObj.data === "string") {
    return { ...resObj, data: scrubString(resObj.data) };
  }
  if (resObj.data !== null && typeof resObj.data === "object") {
    return { ...resObj, data: scrubStructured(resObj.data) };
  }
  return { ...resObj };
}

export function errSerializer(err: unknown): unknown {
  const serialized = pino.stdSerializers.err(err as Error);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- pino types claim Error in / SerializedError out, but at runtime stdSerializers.err returns the input unchanged for non-error-likes (see pino-std-serializers/lib/err.js). Guard preserves that pass-through and lets callers feed in `unknown`.
  if (serialized === null || typeof serialized !== "object") {
    return serialized;
  }

  const out: Record<string, unknown> = { ...(serialized as unknown as SerializedError) };

  const message = out["message"];
  if (typeof message === "string") {
    out["message"] = scrubString(message);
  }
  const stack = out["stack"];
  if (typeof stack === "string") {
    out["stack"] = scrubString(stack);
  }

  const request = out["request"];
  if (request !== null && typeof request === "object") {
    out["request"] = scrubRequest(request);
  }

  const response = out["response"];
  if (response !== null && typeof response === "object") {
    out["response"] = scrubResponse(response);
  }

  return out;
}
