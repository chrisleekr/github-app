import type { Logger } from "pino";

import { getValkeyClient, isValkeyHealthy } from "../orchestrator/valkey";

/**
 * Webhook delivery idempotency (issue #202).
 *
 * GitHub replays a delivery (automatic retry or operator-driven manual
 * redelivery) with the SAME `X-GitHub-Delivery` header for up to 3 days, so
 * webhooks are at-least-once. Without a dedup gate, a redelivery re-runs the
 * full handler, including the triage/intent LLM calls and any chat-thread turn,
 * double-billing and posting duplicate replies. `claimDelivery` is the
 * canonical SET-NX-with-TTL idempotency claim, evaluated at the top of each
 * handler's dispatch path before any side-effect.
 */

// 3 days, matching GitHub's redelivery window.
const TTL_SECONDS = 259_200;
const KEY_PREFIX = "idemp:webhook:";

/**
 * Claim a webhook delivery for processing.
 *
 * Returns `true` exactly once per `deliveryId` within the TTL window (the first
 * caller proceeds); a redelivery gets `false` and must skip.
 *
 * Fail-OPEN: if Valkey is unavailable or errors, returns `true` so an outage
 * degrades to at-least-once processing rather than dropping every webhook. The
 * `idx_workflow_runs_inflight` partial-unique index remains the durable backstop
 * against duplicate work when this best-effort layer is skipped: the dispatcher
 * rejects a second in-flight run for the same workflow+target. (The
 * tracking-comment marker scan via `isAlreadyProcessed` is NOT a backstop here:
 * it runs only on the legacy `router.ts processRequest` path that production
 * handlers bypass, issue #202.)
 */
export async function claimDelivery(deliveryId: string, log: Logger): Promise<boolean> {
  const client = getValkeyClient();
  // `getValkeyClient()` returns a non-null client even while the TCP connection
  // is down (it is null only when VALKEY_URL is unset). Bun's RedisClient
  // defaults to `enableOfflineQueue: true`, so issuing SET against a
  // disconnected client would QUEUE and block (up to the 10s connectionTimeout)
  // instead of failing open. Gate on `isValkeyHealthy()` (the same liveness
  // signal `router.ts` dispatch guards use) so a configured-but-down Valkey
  // takes the immediate fail-open path, leaving the durable backstops
  // (`idx_workflow_runs_inflight` + tracking-comment marker scan) to dedup.
  if (client === null || !isValkeyHealthy()) {
    log.warn({ deliveryId }, "claimDelivery: Valkey unavailable, proceeding (fail-open)");
    return true;
  }
  try {
    // SET key 1 NX EX <ttl>: returns "OK" iff the key did not exist (we won the
    // claim); returns null when it already exists (a redelivery).
    // `RedisClient.send` is typed `Promise<any>`; SET-NX returns "OK" or null.
    const res = (await client.send("SET", [
      `${KEY_PREFIX}${deliveryId}`,
      "1",
      "NX",
      "EX",
      String(TTL_SECONDS),
    ])) as string | null;
    if (res === "OK") return true;
    log.info(
      { deliveryId, event: "dedup-skip" },
      "claimDelivery: duplicate webhook delivery, skipping",
    );
    return false;
  } catch (err) {
    log.warn(
      { deliveryId, err: err instanceof Error ? err.message : String(err) },
      "claimDelivery: Valkey error, proceeding (fail-open)",
    );
    return true;
  }
}
