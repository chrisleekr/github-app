import { describe, expect, it } from "bun:test";

import { computeDueDecision } from "./due-evaluator";

const GRACE = 600_000; // 10 min

describe("computeDueDecision", () => {
  it("runs a fresh slot inside the grace window", () => {
    const d = computeDueDecision({
      cron: "0 3 * * *",
      timezone: "UTC",
      lastRunAt: null,
      now: new Date("2026-05-17T03:02:00Z"),
      graceMs: GRACE,
    });
    expect(d.action).toBe("run");
    expect(d.slotTime?.toISOString()).toBe("2026-05-17T03:00:00.000Z");
  });

  it("is idle when the slot was already claimed", () => {
    const d = computeDueDecision({
      cron: "0 3 * * *",
      timezone: "UTC",
      lastRunAt: new Date("2026-05-17T03:00:00Z"),
      now: new Date("2026-05-17T03:02:00Z"),
      graceMs: GRACE,
    });
    expect(d.action).toBe("idle");
  });

  it("advances (skips) a slot missed past the grace window", () => {
    const d = computeDueDecision({
      cron: "0 3 * * *",
      timezone: "UTC",
      lastRunAt: null,
      now: new Date("2026-05-17T05:00:00Z"),
      graceMs: GRACE,
    });
    expect(d.action).toBe("advance");
    expect(d.slotTime?.toISOString()).toBe("2026-05-17T03:00:00.000Z");
  });

  it("collapses several missed days into a single advance", () => {
    // Last ran 3 days ago; the most recent slot is today's 03:00.
    const d = computeDueDecision({
      cron: "0 3 * * *",
      timezone: "UTC",
      lastRunAt: new Date("2026-05-14T03:00:00Z"),
      now: new Date("2026-05-17T12:00:00Z"),
      graceMs: GRACE,
    });
    expect(d.action).toBe("advance");
    expect(d.slotTime?.toISOString()).toBe("2026-05-17T03:00:00.000Z");
  });

  it("honours the action timezone", () => {
    // 09:00 Australia/Melbourne on 2026-05-17 is 23:00 UTC on 2026-05-16
    // (AEST, UTC+10, no DST in May).
    const d = computeDueDecision({
      cron: "0 9 * * *",
      timezone: "Australia/Melbourne",
      lastRunAt: null,
      now: new Date("2026-05-16T23:01:00Z"),
      graceMs: GRACE,
    });
    expect(d.action).toBe("run");
    expect(d.slotTime?.toISOString()).toBe("2026-05-16T23:00:00.000Z");
  });

  it("is idle right after a run, before the next slot", () => {
    const d = computeDueDecision({
      cron: "0 3 * * *",
      timezone: "UTC",
      lastRunAt: new Date("2026-05-17T03:00:00Z"),
      now: new Date("2026-05-17T15:00:00Z"),
      graceMs: GRACE,
    });
    expect(d.action).toBe("idle");
  });
});
