import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

let cached: string | undefined;

/**
 * Identifier for one orchestrator process incarnation.
 * A container restart reuses its pod hostname, so every boot needs a new
 * suffix or its heartbeat can make abandoned rows appear live again.
 */
export function getInstanceId(): string {
  if (cached !== undefined) return cached;
  cached = `${hostname()}-${randomUUID()}`;
  return cached;
}
