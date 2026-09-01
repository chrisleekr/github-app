import { describe, expect, it } from "bun:test";

import {
  createScanCounters,
  SCHEDULER_LOG_EVENTS,
  SchedulerScanCompletedSchema,
  SchedulerScanFailedSchema,
  SchedulerScanSkippedOverlapSchema,
  SchedulerScanStartedSchema,
} from "../../src/scheduler/log-fields";

describe("SCHEDULER_LOG_EVENTS", () => {
  it("pins the four canonical scan event strings", () => {
    expect(SCHEDULER_LOG_EVENTS.scanStarted).toBe("scheduler.scan.started");
    expect(SCHEDULER_LOG_EVENTS.scanCompleted).toBe("scheduler.scan.completed");
    expect(SCHEDULER_LOG_EVENTS.scanSkippedOverlap).toBe("scheduler.scan.skipped_overlap");
    expect(SCHEDULER_LOG_EVENTS.scanFailed).toBe("scheduler.scan.failed");
  });
});

describe("scheduler scan schemas: accept well-formed events", () => {
  it("accepts a started record", () => {
    const result = SchedulerScanStartedSchema.safeParse({
      event: SCHEDULER_LOG_EVENTS.scanStarted,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a completed record with duration and counters", () => {
    const result = SchedulerScanCompletedSchema.safeParse({
      event: SCHEDULER_LOG_EVENTS.scanCompleted,
      duration_ms: 1234,
      repos_enumerated: 5,
      actions_evaluated: 8,
      actions_claimed: 2,
      actions_advanced: 1,
      actions_failed: 0,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a skipped_overlap record", () => {
    const result = SchedulerScanSkippedOverlapSchema.safeParse({
      event: SCHEDULER_LOG_EVENTS.scanSkippedOverlap,
      since_started_ms: 90000,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a failed record with duration", () => {
    const result = SchedulerScanFailedSchema.safeParse({
      event: SCHEDULER_LOG_EVENTS.scanFailed,
      duration_ms: 42,
    });
    expect(result.success).toBe(true);
  });
});

describe("scheduler scan schemas: reject drift and bad input", () => {
  it("rejects an unknown extra field on completed (strict)", () => {
    const result = SchedulerScanCompletedSchema.safeParse({
      event: SCHEDULER_LOG_EVENTS.scanCompleted,
      duration_ms: 1,
      repos_enumerated: 0,
      actions_evaluated: 0,
      actions_claimed: 0,
      actions_advanced: 0,
      actions_failed: 0,
      surprise: "boo",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a completed record missing a counter", () => {
    const result = SchedulerScanCompletedSchema.safeParse({
      event: SCHEDULER_LOG_EVENTS.scanCompleted,
      duration_ms: 1,
      repos_enumerated: 0,
      actions_evaluated: 0,
      actions_claimed: 0,
      actions_advanced: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a camelCase duration field (snake_case drift)", () => {
    const result = SchedulerScanFailedSchema.safeParse({
      event: SCHEDULER_LOG_EVENTS.scanFailed,
      durationMs: 42,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative duration", () => {
    const result = SchedulerScanFailedSchema.safeParse({
      event: SCHEDULER_LOG_EVENTS.scanFailed,
      duration_ms: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer counter", () => {
    const result = SchedulerScanCompletedSchema.safeParse({
      event: SCHEDULER_LOG_EVENTS.scanCompleted,
      duration_ms: 1,
      repos_enumerated: 1.5,
      actions_evaluated: 0,
      actions_claimed: 0,
      actions_advanced: 0,
      actions_failed: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a wrong event literal on the started schema", () => {
    const result = SchedulerScanStartedSchema.safeParse({
      event: "scheduler.scan.bogus",
    });
    expect(result.success).toBe(false);
  });
});

describe("createScanCounters", () => {
  it("zero-initialises every counter and matches the completed schema shape", () => {
    const counters = createScanCounters();
    const result = SchedulerScanCompletedSchema.safeParse({
      event: SCHEDULER_LOG_EVENTS.scanCompleted,
      duration_ms: 0,
      ...counters,
    });
    expect(result.success).toBe(true);
  });
});
