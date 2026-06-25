/**
 * Canonical pino log-field schema for the daemon's outbound WebSocket connection
 * lifecycle (issue #218).
 *
 * Mirrors `src/orchestrator/log-fields.ts` (the orchestrator-side view of the
 * same connection: `daemon.heartbeat.*`) and `src/core/log-fields.ts`: a
 * `.strict()` Zod discriminated union pins each structured `daemon.connection.*`
 * event so its fields cannot drift, and the co-located test round-trips a sample
 * line through every branch. Emitters log plain objects via the root logger at
 * the call site in `DaemonWsClient`; the schema is the drift-prevention
 * contract, not a runtime validator on the hot path.
 *
 * Naming follows the codebase convention: `event` values are dot.lowercase;
 * snake_case is reserved for numeric-metric fields (`downtime_ms`,
 * `time_to_connect_ms`, `connected_duration_ms`, `backoff_ms`,
 * `previous_backoff_ms`), paralleling `delta_ms` in core/log-fields. `attempt`
 * and `readyState` are bare correlation/state fields, matching the existing
 * `missedPongs` / `readyState` idiom.
 *
 * SECURITY (security invariant 2): the `DAEMON_AUTH_TOKEN`, the `Authorization`
 * header, and the orchestrator URL (which carries no secret today but is the
 * obvious place an embedded credential would land) are NEVER logged here. These
 * events carry only bounded operational metadata: attempt counter, downtime,
 * backoff, close code/reason, readyState. `error` carries a free-text `message`
 * scrubbed via `redactErrorMessage` at the call site.
 */
import { z } from "zod";

export const DAEMON_CONNECTION_LOG_EVENTS = {
  connectAttempt: "daemon.connection.connect_attempt",
  connected: "daemon.connection.connected",
  disconnected: "daemon.connection.disconnected",
  reconnectScheduled: "daemon.connection.reconnect_scheduled",
  error: "daemon.connection.error",
} as const;

/**
 * Daemon-side WebSocket connection lifecycle. Discriminated on `event` so each
 * branch pins exactly the fields its emitter logs:
 *
 * - `connect_attempt`: a `connect()` call is starting. `attempt` is 1 on the
 *   first connect and increments per reconnect; `downtime_ms` is the gap since
 *   the last `onclose` (0 on the very first connect, before any disconnect).
 * - `connected`: `onopen` fired. `time_to_connect_ms` is connect-call->onopen
 *   wall-clock; `downtime_ms` is the gap from the prior `onclose` to this open
 *   (0 on the first connect).
 * - `disconnected`: `onclose` fired. `connected_duration_ms` is the prior
 *   `onopen`->now wall-clock (0 if it never opened); `code` + `reason` are the
 *   close frame Bun surfaces.
 * - `reconnect_scheduled`: backoff timer armed. `attempt` is the upcoming
 *   attempt number; `backoff_ms` is the decorrelated-jitter delay (rounded).
 * - `error`: `onerror` or a `connect()` throw. `readyState` is the socket state
 *   (null if no socket); `message` is the optional scrubbed error text.
 *
 * Each branch is `.strict()` so an emitter that adds an unpinned field, mistypes
 * a metric, or puts a field on the wrong event trips the co-located test.
 */
export const DaemonConnectionLogSchema = z.discriminatedUnion("event", [
  z
    .object({
      event: z.literal(DAEMON_CONNECTION_LOG_EVENTS.connectAttempt),
      attempt: z.number().int().positive(),
      downtime_ms: z.number().int().nonnegative(),
      previous_backoff_ms: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      event: z.literal(DAEMON_CONNECTION_LOG_EVENTS.connected),
      attempt: z.number().int().positive(),
      time_to_connect_ms: z.number().int().nonnegative(),
      downtime_ms: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      event: z.literal(DAEMON_CONNECTION_LOG_EVENTS.disconnected),
      code: z.number().int(),
      reason: z.string(),
      connected_duration_ms: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      event: z.literal(DAEMON_CONNECTION_LOG_EVENTS.reconnectScheduled),
      attempt: z.number().int().positive(),
      backoff_ms: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      event: z.literal(DAEMON_CONNECTION_LOG_EVENTS.error),
      readyState: z.number().int().nullable(),
      // Optional scrubbed error text; pino drops the key when undefined.
      message: z.string().min(1).optional(),
    })
    .strict(),
]);

export type DaemonConnectionLog = z.infer<typeof DaemonConnectionLogSchema>;

export const DAEMON_JOB_LOG_EVENTS = {
  cancelled: "daemon.job.cancelled",
} as const;

/**
 * Daemon job-lifecycle event. Pinned so the cancel line emitted by
 * `handleJobCancel` cannot drift, matching the schema-per-event convention the
 * rest of this PR establishes. `reason` is the operator/system cancel reason
 * (bounded, not attacker-controlled); `offerId` / `deliveryId` are the
 * established correlation bindings.
 */
export const DaemonJobCancelledLogSchema = z
  .object({
    event: z.literal(DAEMON_JOB_LOG_EVENTS.cancelled),
    offerId: z.string().min(1),
    deliveryId: z.string().min(1),
    reason: z.string(),
  })
  .strict();

export type DaemonJobCancelledLog = z.infer<typeof DaemonJobCancelledLogSchema>;
