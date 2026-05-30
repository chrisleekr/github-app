/**
 * Canonical pino log-field schemas for the orchestrator's job-offer and daemon
 * heartbeat lifecycles (issue #187).
 *
 * Mirrors `src/core/log-fields.ts` and `src/orchestrator/fleet-snapshot.ts`: a
 * Zod shape pins each structured event so its fields cannot drift, and the
 * co-located test round-trips a sample line through it. Emitters log plain
 * objects via the root logger at the call site; the schema is the
 * drift-prevention contract, not a runtime validator on the hot path.
 *
 * Each lifecycle is a `z.discriminatedUnion` on `event` so every event variant
 * pins exactly the fields its emitter logs (e.g. `offer_sent` carries
 * `fleetSize`/`requiredTools` but no latency; `offer_accepted` carries
 * `offer_latency_ms` but no `reason`; `ttl_refresh_failed` carries `err`). A
 * flat `.strict()` object with optionals could not express that, so a wrong
 * field on the wrong event would slip through.
 *
 * Naming follows the codebase convention: field keys are camelCase
 * (deliveryId, daemonId, offerId, fleetSize, missedPongs), matching the
 * app-wide pino correlation fields; snake_case is reserved for the
 * numeric-metric idiom, so `offer_latency_ms` parallels `delta_ms`. `event`
 * values are dot.lowercase. `offer_latency_ms` is the offer→accept (or
 * offer→reject / offer→timeout) wall-clock measured against
 * `PendingOffer.offeredAt`, in integer ms.
 */
import { z } from "zod";

export const DISPATCHER_LOG_EVENTS = {
  offer_sent: "dispatcher.offer.sent",
  offer_accepted: "dispatcher.offer.accepted",
  offer_rejected: "dispatcher.offer.rejected",
  offer_timed_out: "dispatcher.offer.timed_out",
  no_eligible_daemon: "dispatcher.no_eligible_daemon",
} as const;

export const DAEMON_HEARTBEAT_LOG_EVENTS = {
  pong_missed: "daemon.heartbeat.pong_missed",
  timeout: "daemon.heartbeat.timeout",
  ttl_refresh_failed: "daemon.heartbeat.ttl_refresh_failed",
} as const;

// Correlation ids carried by every `dispatcher.offer.*` line.
const offerIds = {
  deliveryId: z.string().min(1),
  daemonId: z.string().min(1),
  offerId: z.string().min(1),
};

/**
 * Per-event shapes for the four `dispatcher.offer.*` lines. Discriminated on
 * `event`, each branch `.strict()` so an emitter that adds an unpinned field,
 * mistypes `offer_latency_ms`, or puts `reason` on a non-rejected event trips
 * the test.
 */
export const DispatcherOfferLogSchema = z.discriminatedUnion("event", [
  z
    .object({
      event: z.literal(DISPATCHER_LOG_EVENTS.offer_sent),
      kind: z.string().min(1),
      ...offerIds,
      fleetSize: z.number().int().nonnegative(),
      requiredTools: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      event: z.literal(DISPATCHER_LOG_EVENTS.offer_accepted),
      ...offerIds,
      offer_latency_ms: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      event: z.literal(DISPATCHER_LOG_EVENTS.offer_rejected),
      ...offerIds,
      offer_latency_ms: z.number().int().nonnegative(),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      event: z.literal(DISPATCHER_LOG_EVENTS.offer_timed_out),
      ...offerIds,
      offer_latency_ms: z.number().int().nonnegative(),
    })
    .strict(),
]);

export type DispatcherOfferLog = z.infer<typeof DispatcherOfferLogSchema>;

/**
 * `dispatcher.no_eligible_daemon` has a distinct shape: no offer was sent, so
 * there is no daemon/offer id, but `fleetSize` + `requiredTools` let an
 * operator tell a capability-match miss from sheer capacity exhaustion.
 */
export const DispatcherNoEligibleDaemonLogSchema = z
  .object({
    event: z.literal(DISPATCHER_LOG_EVENTS.no_eligible_daemon),
    kind: z.string().min(1),
    deliveryId: z.string().min(1),
    fleetSize: z.number().int().nonnegative(),
    requiredTools: z.array(z.string()),
  })
  .strict();

export type DispatcherNoEligibleDaemonLog = z.infer<typeof DispatcherNoEligibleDaemonLogSchema>;

/**
 * Daemon heartbeat lifecycle as seen by the orchestrator. Discriminated on
 * `event` so `missedPongs` is pinned to `pong_missed` only, and the
 * `ttl_refresh_failed` line, which logs the caught `err` inline, is modelled
 * with that field rather than rejected by a flat `.strict()` shape.
 */
export const DaemonHeartbeatLogSchema = z.discriminatedUnion("event", [
  z
    .object({
      event: z.literal(DAEMON_HEARTBEAT_LOG_EVENTS.pong_missed),
      daemonId: z.string().min(1),
      missedPongs: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      event: z.literal(DAEMON_HEARTBEAT_LOG_EVENTS.timeout),
      daemonId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      event: z.literal(DAEMON_HEARTBEAT_LOG_EVENTS.ttl_refresh_failed),
      daemonId: z.string().min(1),
      err: z.unknown(),
    })
    .strict(),
]);

export type DaemonHeartbeatLog = z.infer<typeof DaemonHeartbeatLogSchema>;
