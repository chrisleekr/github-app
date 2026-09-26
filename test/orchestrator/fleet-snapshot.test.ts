import { describe, expect, it } from "bun:test";

import {
  FLEET_SNAPSHOT_EVENT,
  type FleetReaders,
  FleetSnapshotLogSchema,
  sampleFleet,
} from "../../src/orchestrator/fleet-snapshot";

// The root logger writes JSON to stdout (no transport in NODE_ENV=test).
function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  return fn()
    .then(() => chunks.join(""))
    .finally(() => {
      process.stdout.write = original;
    });
}

function findSnapshot(out: string): Record<string, unknown> | undefined {
  for (const line of out.trim().split("\n")) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj["event"] === FLEET_SNAPSHOT_EVENT) return obj;
    } catch {
      // non-JSON line, skip
    }
  }
  return undefined;
}

describe("sampleFleet (#174)", () => {
  it("emits one fleet.snapshot with summed busy slots and the read gauges", async () => {
    // Injected readers, no process-wide mock.module (which would pollute
    // sibling orchestrator tests that use the real job-queue/daemon-registry).
    const readers: FleetReaders = {
      getQueueLength: () => Promise.resolve(5),
      getActiveDaemons: () => Promise.resolve(["d1", "d2"]),
      getDaemonActiveJobs: (id) => Promise.resolve(id === "d1" ? 2 : 1),
      getPersistentPoolFreeSlots: () => Promise.resolve(7),
    };
    const out = await captureStdout(() => sampleFleet(readers));
    const snap = findSnapshot(out);
    expect(snap).toBeDefined();
    expect(snap?.["queue_depth"]).toBe(5);
    expect(snap?.["active_daemons_total"]).toBe(2);
    expect(snap?.["busy_slots_total"]).toBe(3); // d1:2 + d2:1
    expect(snap?.["persistent_free_slots"]).toBe(7);
  });

  it("logs a warn (no snapshot) when a reader throws, without propagating", async () => {
    const readers: FleetReaders = {
      getQueueLength: () => Promise.reject(new Error("valkey down")),
      getActiveDaemons: () => Promise.resolve([]),
      getDaemonActiveJobs: () => Promise.resolve(0),
      getPersistentPoolFreeSlots: () => Promise.resolve(0),
    };
    const out = await captureStdout(() => sampleFleet(readers));
    expect(findSnapshot(out)).toBeUndefined();
    expect(out).toContain("Fleet snapshot sample failed");
  });
});

describe("FleetSnapshotLogSchema (#174)", () => {
  const valid = {
    event: FLEET_SNAPSHOT_EVENT,
    queue_depth: 0,
    active_daemons_total: 0,
    busy_slots_total: 0,
    persistent_free_slots: 0,
  };

  it("accepts a well-formed snapshot", () => {
    expect(FleetSnapshotLogSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an unknown field (strict pins drift)", () => {
    expect(FleetSnapshotLogSchema.safeParse({ ...valid, queue_len: 1 }).success).toBe(false);
  });

  it("rejects a negative gauge and the wrong event literal", () => {
    expect(FleetSnapshotLogSchema.safeParse({ ...valid, queue_depth: -1 }).success).toBe(false);
    expect(FleetSnapshotLogSchema.safeParse({ ...valid, event: "fleet.other" }).success).toBe(
      false,
    );
  });
});
