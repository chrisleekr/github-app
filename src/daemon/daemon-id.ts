import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

let cached: string | undefined;

/**
 * Stable identifier for this shared daemon process. The daemon registers and
 * publishes its Valkey heartbeat with this same value.
 */
export function getDaemonId(): string {
  if (cached !== undefined) return cached;
  cached = `daemon-${hostname()}-${randomUUID()}`;
  return cached;
}
