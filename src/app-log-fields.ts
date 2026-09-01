/**
 * Canonical pino log-field schemas for the inbound HTTP boundary (issue #247).
 *
 * Mirrors `src/webhook/idempotency-log-fields.ts` and `src/core/log-fields.ts`:
 * a strict Zod shape pins the structured `http.*` event family so the emit
 * sites in `src/app.ts` (webhook entry, HMAC failure, readiness probe, operator
 * scheduler endpoint) cannot drift on a field name or status code without the
 * co-located test catching it. Emitters log plain objects via `logger.info` /
 * `logger.warn` / `logger.error`; the schema is the drift-prevention contract,
 * not a runtime validator on the hot path.
 *
 * Security (invariant 2 + issue spec): these lines carry only bounded metadata,
 * method, path/route, HTTP status, the GitHub-bounded `delivery_id` /
 * `event_name`, and a body-free `reason`. They NEVER carry the webhook secret,
 * the `X-Hub-Signature-256` bytes, the provided/expected signature, the raw
 * request body, or `Authorization` headers. On HMAC failure the FACT of failure
 * is logged (`kind: "signature_mismatch"`), never the signature itself.
 *
 * Field-name convention follows the codebase: `deliveryId` stays camelCase (the
 * established child-logger delivery binding); new metric-style fields use
 * snake_case (`event_name`, `duration_ms`, `is_ready`, `valkey_healthy`).
 */
import { z } from "zod";

export const HTTP_LOG_EVENTS = {
  webhookReceived: "http.webhook.received",
  webhookError: "http.webhook.error",
  readyzUnready: "http.readyz.unready",
  schedulerRunRejectedDisabled: "http.scheduler.run.rejected_disabled",
  schedulerRunRejectedUnauth: "http.scheduler.run.rejected_unauth",
  schedulerRunRejectedPayload: "http.scheduler.run.rejected_payload",
  schedulerRunEnqueued: "http.scheduler.run.enqueued",
  schedulerRunFailed: "http.scheduler.run.failed",
  requestFailed: "http.request.failed",
} as const;

/**
 * Discriminator for `http.webhook.error`. `signature_mismatch` is the HMAC
 * verification failure (a stale `GITHUB_WEBHOOK_SECRET` drops 100% of
 * deliveries) and is the alertable signal this family exists for;
 * `handler_threw` is a downstream event-handler exception; `other` is anything
 * else `@octokit/webhooks` surfaces through `onError`.
 */
export const HTTP_WEBHOOK_ERROR_KINDS = ["signature_mismatch", "handler_threw", "other"] as const;

const deliveryId = z.string().min(1);

/**
 * Per-event shapes for the `http.*` family. Discriminated on `event` so each
 * branch pins exactly the fields its emitter logs and a wrong field on the wrong
 * event trips the co-located test. Every branch is `.strict()`.
 */
export const HttpLogFieldsSchema = z.discriminatedUnion("event", [
  /**
   * Info: a verified webhook delivery entered the middleware. `delivery_id` /
   * `event_name` come from the `X-GitHub-Delivery` / `X-GitHub-Event` headers;
   * `duration_ms` is the HTTP-handler wall-clock around the middleware call.
   */
  z
    .object({
      event: z.literal(HTTP_LOG_EVENTS.webhookReceived),
      deliveryId,
      event_name: z.string().min(1),
      duration_ms: z.number().int().nonnegative(),
    })
    .strict(),
  /**
   * Warn: `onError` fired. `kind` distinguishes a signature mismatch from a
   * handler throw. `deliveryId` / `event_name` are optional because a malformed
   * request that fails before the headers parse carries neither. `err` is the
   * caught error serialized by the secret-scrubbing pino errSerializer; it is
   * NEVER the signature bytes.
   */
  z
    .object({
      event: z.literal(HTTP_LOG_EVENTS.webhookError),
      kind: z.enum(HTTP_WEBHOOK_ERROR_KINDS),
      deliveryId: deliveryId.optional(),
      event_name: z.string().min(1).optional(),
      err: z.unknown(),
    })
    .strict(),
  /**
   * Info: `/readyz` returned 503. The two flags name which gate is false during
   * a startup race or Valkey reconnect storm.
   */
  z
    .object({
      event: z.literal(HTTP_LOG_EVENTS.readyzUnready),
      is_ready: z.boolean(),
      valkey_healthy: z.boolean(),
    })
    .strict(),
  /** Warn: scheduler disabled (404). */
  z
    .object({
      event: z.literal(HTTP_LOG_EVENTS.schedulerRunRejectedDisabled),
      status: z.literal(404),
    })
    .strict(),
  /** Warn: bad operator bearer token (401). Never logs the provided token. */
  z
    .object({
      event: z.literal(HTTP_LOG_EVENTS.schedulerRunRejectedUnauth),
      status: z.literal(401),
    })
    .strict(),
  /**
   * Warn: the request payload was rejected before enqueue. `status` is 413
   * (body cap) or 400 (bad JSON / wrong shape / missing field); `reason` is a
   * body-free constant naming which check failed.
   */
  z
    .object({
      event: z.literal(HTTP_LOG_EVENTS.schedulerRunRejectedPayload),
      status: z.union([z.literal(413), z.literal(400)]),
      reason: z.enum(["body_too_large", "invalid_json", "not_object", "missing_field"]),
    })
    .strict(),
  /**
   * Info: the action reached the scheduler. `enqueued` is false on a dedup hit
   * (HTTP 409), true on a fresh enqueue (HTTP 202).
   */
  z
    .object({
      event: z.literal(HTTP_LOG_EVENTS.schedulerRunEnqueued),
      status: z.union([z.literal(202), z.literal(409)]),
      enqueued: z.boolean(),
    })
    .strict(),
  /** Error: the endpoint threw (500). `err` is secret-scrubbed by the serializer. */
  z
    .object({
      event: z.literal(HTTP_LOG_EVENTS.schedulerRunFailed),
      status: z.literal(500),
      err: z.unknown(),
    })
    .strict(),
  /**
   * Error: the request router itself threw, caught by the `Bun.serve` `error`
   * hook. Distinct from `schedulerRunFailed`, which is one endpoint's own catch:
   * this is the last-resort boundary for any route. Carries no request data, an
   * unhandled throw may have been triggered by attacker-shaped input, so only
   * the secret-scrubbed `err` is recorded.
   */
  z
    .object({
      event: z.literal(HTTP_LOG_EVENTS.requestFailed),
      err: z.unknown(),
    })
    .strict(),
]);

export type HttpLogFields = z.infer<typeof HttpLogFieldsSchema>;
