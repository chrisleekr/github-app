/**
 * Canonical pino log-field schema for ephemeral-daemon spawn observability (issue #234).
 *
 * Mirrors `src/utils/retry-log-fields.ts`: a `.strict()` Zod discriminated union
 * pins the structured `k8s.spawn.*` event family so the emit sites across the
 * scaler (`decideEphemeralSpawn`), the spawner (`spawnEphemeralDaemon`), and the
 * router cannot drift on a field name (e.g. `apiCallMs` vs `api_call_ms`) without
 * the co-located test catching it. Emitters log plain objects via `log.debug` /
 * `log.info` / `log.error`; the schema is the drift-prevention contract, not a
 * runtime validator on the hot path.
 *
 * The schema is a `z.discriminatedUnion` on `event` so per-event field presence
 * is pinned: `decision_skipped` carries the decision-time signals; `attempted`
 * carries only the trigger; `succeeded` carries `pod_name` + `namespace` +
 * `api_call_ms`; `failed` carries `kind` and an *optional* `api_call_ms` (the
 * `infra-absent` / `auth-load-failed` kinds throw before the K8s round-trip, so
 * no API latency exists to report).
 *
 * SECURITY: only bounded metadata is logged, never a K8s service-account token,
 * kubeconfig contents, or the Pod's env. Error free-text is redacted via
 * `redactErrorMessage` (`src/utils/log-redaction.ts`) at the emit site and pino's
 * `err` serializer; this schema does not enumerate `err`.
 *
 * `api_call_ms` is the wall-clock of the single `createNamespacedPod` round-trip
 * (snake_case, forward-compatible with OpenTelemetry duration conventions).
 * `delivery_id` correlates a spawn decision to the webhook delivery that drove it.
 */
import { z } from "zod";

import type { EphemeralSpawnErrorKind } from "../k8s/ephemeral-daemon-spawner";

export const K8S_SPAWN_LOG_EVENTS = {
  decisionSkipped: "k8s.spawn.decision_skipped",
  attempted: "k8s.spawn.attempted",
  succeeded: "k8s.spawn.succeeded",
  failed: "k8s.spawn.failed",
} as const;

/**
 * The spawn trigger, re-stated as a Zod enum. Kept in lockstep with the scaler's
 * `EphemeralSpawnVerdict` trigger union (`src/orchestrator/ephemeral-daemon-scaler.ts`).
 */
const trigger = z.enum(["triage-heavy", "queue-overflow"]);

/**
 * Error-kind enum, kept identical to `EphemeralSpawnErrorKind`
 * (`src/k8s/ephemeral-daemon-spawner.ts`). The `satisfies` below makes a
 * divergence between the source union and this enum a compile error.
 */
const errorKind = z.enum(["infra-absent", "auth-load-failed", "api-rejected", "api-unavailable"]);
const _kindParity = undefined as unknown as z.infer<
  typeof errorKind
> satisfies EphemeralSpawnErrorKind;
const _kindParityReverse = undefined as unknown as EphemeralSpawnErrorKind satisfies z.infer<
  typeof errorKind
>;
// eslint-disable-next-line @typescript-eslint/no-meaningless-void-operator -- reads the locals for noUnusedLocals
void _kindParity;
// eslint-disable-next-line @typescript-eslint/no-meaningless-void-operator -- reads the locals for noUnusedLocals
void _kindParityReverse;

const apiCallMs = z.number().int().nonnegative();
const deliveryId = z.string().min(1);

export const K8sSpawnLogFieldsSchema = z.discriminatedUnion("event", [
  /**
   * Debug (no-signal) / info (cooldown): the scaler declined to spawn. Carries
   * the decision-time signals so an operator can correlate skip rate against
   * `heavy` / queue depth / pool saturation.
   */
  z.strictObject({
    event: z.literal(K8S_SPAWN_LOG_EVENTS.decisionSkipped),
    delivery_id: deliveryId,
    reason: z.enum(["no-signal", "cooldown"]),
    heavy: z.boolean(),
    queue_length: z.number().int().nonnegative(),
    persistent_free_slots: z.number().int(),
  }),
  /** Info: a spawn was decided and the K8s Pod create is about to be attempted. */
  z.strictObject({
    event: z.literal(K8S_SPAWN_LOG_EVENTS.attempted),
    delivery_id: deliveryId,
    trigger,
  }),
  /** Info: the Pod was created. `api_call_ms` times the createNamespacedPod round-trip. */
  z.strictObject({
    event: z.literal(K8S_SPAWN_LOG_EVENTS.succeeded),
    delivery_id: deliveryId,
    trigger,
    pod_name: z.string().min(1),
    namespace: z.string().min(1),
    api_call_ms: apiCallMs,
  }),
  /**
   * Error: the spawn failed. `kind` is the `EphemeralSpawnErrorKind`. `trigger`
   * is omitted on the router's config-incomplete path (no verdict trigger
   * available there). `api_call_ms` is present only for `api-rejected` /
   * `api-unavailable`, the kinds that actually round-tripped the K8s API;
   * `infra-absent` / `auth-load-failed` throw before any call.
   */
  z.strictObject({
    event: z.literal(K8S_SPAWN_LOG_EVENTS.failed),
    delivery_id: deliveryId,
    kind: errorKind,
    trigger: trigger.optional(),
    api_call_ms: apiCallMs.optional(),
  }),
]);

export type K8sSpawnLogFields = z.infer<typeof K8sSpawnLogFieldsSchema>;
