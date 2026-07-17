/**
 * Canonical pino log-field schema for the socket-health watchdog (issue #265).
 *
 * Mirrors `src/scheduler/log-fields.ts`: a `.strict()` Zod shape pins each
 * structured event so the emit sites in `socket-health.ts` cannot drift on a
 * field name without the co-located test catching it. Emitters log plain
 * objects; the schema is the drift-prevention contract, not a runtime
 * validator on the hot path.
 *
 * These lines exist because the #264 occurrence left no trace: the container
 * burned a full core for 14 days and died with `reason=Error` and nothing to
 * read afterwards. Every field here is chosen so the NEXT occurrence is
 * diagnosable from logs alone, without a live shell on the pod.
 *
 * The watchdog is timer-driven with no per-request child logger, so unlike the
 * idempotency / pipeline families these lines carry no `deliveryId` binding.
 * They carry `component: "socket-health"` from the module's child logger.
 */
import { z } from "zod";

export const SOCKET_HEALTH_LOG_EVENTS = {
  closeWaitDetected: "socket.close_wait.detected",
  closeWaitSpinSuspected: "socket.close_wait.spin_suspected",
  closeWaitSelfHealExit: "socket.close_wait.self_heal_exit",
  watchdogSampleFailed: "socket.watchdog.sample_failed",
  watchdogDisabled: "socket.watchdog.disabled",
} as const;

/**
 * Per-socket evidence. `age_ms` and `samples` are what separate a socket
 * passing through CLOSE_WAIT from one wedged there: a healthy socket is gone
 * by the next sample.
 */
const SocketDetailSchema = z
  .object({
    inode: z.string(),
    local: z.string(),
    remote: z.string(),
    age_ms: z.number().int().nonnegative(),
    samples: z.number().int().positive(),
  })
  .strict();

/**
 * The evidence shared by the two CLOSE_WAIT lines. `cpu_cores_used` is a rate
 * (1.0 means one full core), so it is deliberately not an integer.
 * `window_ms` is the wall clock that rate was averaged over, not a socket age.
 */
const closeWaitEvidence = {
  close_wait_sockets: z.number().int().nonnegative(),
  window_ms: z.number().int().nonnegative(),
  cpu_cores_used: z.number().nonnegative(),
  // Capped at 20 by the detector: `close_wait_sockets` carries the true count,
  // this list is a bounded sample so one storm cannot produce a huge log line.
  sockets: z.array(SocketDetailSchema).max(20),
} as const;

/** Warn: CLOSE_WAIT sockets have survived `SOCKET_HEALTH_LEAK_SAMPLES` samples in a row. */
export const SocketCloseWaitDetectedSchema = z
  .object({
    event: z.literal(SOCKET_HEALTH_LOG_EVENTS.closeWaitDetected),
    ...closeWaitEvidence,
  })
  .strict();

/**
 * Warn: the full #264 signature, persistent CLOSE_WAIT plus a pinned core.
 * `self_heal_enabled` tells an operator whether the burn is bounded by a
 * pending restart or will run until someone intervenes.
 */
export const SocketCloseWaitSpinSuspectedSchema = z
  .object({
    event: z.literal(SOCKET_HEALTH_LOG_EVENTS.closeWaitSpinSuspected),
    ...closeWaitEvidence,
    self_heal_enabled: z.boolean(),
  })
  .strict();

/**
 * Error: the last line before a deliberate self-heal exit. Deliberately narrow,
 * the preceding `spin_suspected` line carries the full evidence.
 */
export const SocketCloseWaitSelfHealExitSchema = z
  .object({
    event: z.literal(SOCKET_HEALTH_LOG_EVENTS.closeWaitSelfHealExit),
    close_wait_sockets: z.number().int().nonnegative(),
    cpu_cores_used: z.number().nonnegative(),
  })
  .strict();

/**
 * Warn: a sample could not read the procfs tables. Logged at most once per
 * watchdog lifetime, so a persistent fault cannot out-shout the leak it is
 * meant to report. `err` (the standard pino error field) is not pinned here,
 * same as the other families: this schema fixes only the custom fields.
 */
export const SocketWatchdogSampleFailedSchema = z
  .object({
    event: z.literal(SOCKET_HEALTH_LOG_EVENTS.watchdogSampleFailed),
  })
  .strict();

/** Info: the watchdog armed no timer, either configured off or no procfs to read. */
export const SocketWatchdogDisabledSchema = z
  .object({
    event: z.literal(SOCKET_HEALTH_LOG_EVENTS.watchdogDisabled),
  })
  .strict();

export type SocketCloseWaitDetected = z.infer<typeof SocketCloseWaitDetectedSchema>;
export type SocketCloseWaitSpinSuspected = z.infer<typeof SocketCloseWaitSpinSuspectedSchema>;
export type SocketCloseWaitSelfHealExit = z.infer<typeof SocketCloseWaitSelfHealExitSchema>;
export type SocketWatchdogSampleFailed = z.infer<typeof SocketWatchdogSampleFailedSchema>;
export type SocketWatchdogDisabled = z.infer<typeof SocketWatchdogDisabledSchema>;
