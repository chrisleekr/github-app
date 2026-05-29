import pino, { type SerializedError } from "pino";

import { config } from "./config";
import { redactGitHubTokens } from "./utils/sanitize";

/**
 * Path-based redaction list for the root pino logger.
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
function scrubStructured(value: unknown): unknown {
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

export type Logger = pino.Logger;
