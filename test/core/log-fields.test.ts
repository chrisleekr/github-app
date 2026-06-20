import { describe, expect, it } from "bun:test";

import {
  CORE_PIPELINE_LOG_EVENTS,
  createStageTracker,
  PipelineCompletedLogSchema,
  PipelineFailedLogSchema,
  PipelineStageLogSchema,
  timeStage,
} from "../../src/core/log-fields";
import { type Logger } from "../../src/logger";

// No-op pino-like stub: timeStage calls log.info on the success path.
const log = { info: () => {} } as unknown as Logger;

describe("PipelineCompletedLogSchema (#192)", () => {
  it("accepts a full pipeline.completed line carrying token counters", () => {
    const result = PipelineCompletedLogSchema.safeParse({
      event: CORE_PIPELINE_LOG_EVENTS.completed,
      success: true,
      durationMs: 4200,
      costUsd: 0.012,
      numTurns: 3,
      inputTokens: 1500,
      outputTokens: 220,
      cacheReadInputTokens: 9000,
      cacheCreationInputTokens: 0,
      pipeline_wall_clock_ms: 5000,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a minimal line (optional metrics omitted, e.g. dry-run)", () => {
    const result = PipelineCompletedLogSchema.safeParse({
      event: CORE_PIPELINE_LOG_EVENTS.completed,
      success: true,
      pipeline_wall_clock_ms: 12,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown / misnamed token field (strict shape pins drift)", () => {
    const result = PipelineCompletedLogSchema.safeParse({
      event: CORE_PIPELINE_LOG_EVENTS.completed,
      success: true,
      pipeline_wall_clock_ms: 12,
      input_tokens: 1500, // snake_case typo, the field is inputTokens
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative / non-integer token counter", () => {
    const base = {
      event: CORE_PIPELINE_LOG_EVENTS.completed,
      success: true,
      pipeline_wall_clock_ms: 12,
    };
    expect(PipelineCompletedLogSchema.safeParse({ ...base, inputTokens: -1 }).success).toBe(false);
    expect(PipelineCompletedLogSchema.safeParse({ ...base, outputTokens: 1.5 }).success).toBe(
      false,
    );
  });
});

describe("PipelineStageLogSchema (#166)", () => {
  it("accepts a well-formed pipeline.stage line", () => {
    const result = PipelineStageLogSchema.safeParse({
      event: CORE_PIPELINE_LOG_EVENTS.stage,
      stage: "github.fetch",
      delta_ms: 1234,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown field (strict shape pins drift)", () => {
    const result = PipelineStageLogSchema.safeParse({
      event: CORE_PIPELINE_LOG_EVENTS.stage,
      stage: "github.fetch",
      delta_ms: 1234,
      durationMs: 1234, // wrong field name, must be rejected
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer / negative delta_ms", () => {
    expect(
      PipelineStageLogSchema.safeParse({
        event: CORE_PIPELINE_LOG_EVENTS.stage,
        stage: "x",
        delta_ms: 1.5,
      }).success,
    ).toBe(false);
    expect(
      PipelineStageLogSchema.safeParse({
        event: CORE_PIPELINE_LOG_EVENTS.stage,
        stage: "x",
        delta_ms: -1,
      }).success,
    ).toBe(false);
  });

  it("rejects the wrong event literal", () => {
    const result = PipelineStageLogSchema.safeParse({
      event: CORE_PIPELINE_LOG_EVENTS.completed,
      stage: "x",
      delta_ms: 1,
    });
    expect(result.success).toBe(false);
  });

  it("exposes the four canonical event keys", () => {
    expect(CORE_PIPELINE_LOG_EVENTS).toEqual({
      started: "pipeline.started",
      stage: "pipeline.stage",
      completed: "pipeline.completed",
      failed: "pipeline.failed",
    });
  });
});

describe("PipelineFailedLogSchema (#226)", () => {
  it("accepts a well-formed failed record", () => {
    const result = PipelineFailedLogSchema.safeParse({
      event: CORE_PIPELINE_LOG_EVENTS.failed,
      failed_stage: "executor.invoke",
      failed_stage_delta_ms: 240200,
      pipeline_wall_clock_ms: 240630,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a failed record without the optional stage fields", () => {
    const result = PipelineFailedLogSchema.safeParse({
      event: CORE_PIPELINE_LOG_EVENTS.failed,
      pipeline_wall_clock_ms: 12,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a camelCase misnamed field (strict pins drift)", () => {
    const result = PipelineFailedLogSchema.safeParse({
      event: CORE_PIPELINE_LOG_EVENTS.failed,
      failedStage: "x", // camelCase typo, the field is failed_stage
      pipeline_wall_clock_ms: 12,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown extra field (strict)", () => {
    const result = PipelineFailedLogSchema.safeParse({
      event: CORE_PIPELINE_LOG_EVENTS.failed,
      pipeline_wall_clock_ms: 12,
      surprise: "boo",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative failed_stage_delta_ms", () => {
    const result = PipelineFailedLogSchema.safeParse({
      event: CORE_PIPELINE_LOG_EVENTS.failed,
      failed_stage: "x",
      failed_stage_delta_ms: -1,
      pipeline_wall_clock_ms: 5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects the wrong event literal", () => {
    const result = PipelineFailedLogSchema.safeParse({
      event: CORE_PIPELINE_LOG_EVENTS.completed,
      pipeline_wall_clock_ms: 12,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a record missing pipeline_wall_clock_ms", () => {
    const result = PipelineFailedLogSchema.safeParse({
      event: CORE_PIPELINE_LOG_EVENTS.failed,
    });
    expect(result.success).toBe(false);
  });

  it("rejects failed_stage without failed_stage_delta_ms (paired contract)", () => {
    const result = PipelineFailedLogSchema.safeParse({
      event: CORE_PIPELINE_LOG_EVENTS.failed,
      failed_stage: "executor.invoke",
      pipeline_wall_clock_ms: 5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects failed_stage_delta_ms without failed_stage (paired contract)", () => {
    const result = PipelineFailedLogSchema.safeParse({
      event: CORE_PIPELINE_LOG_EVENTS.failed,
      failed_stage_delta_ms: 42,
      pipeline_wall_clock_ms: 5,
    });
    expect(result.success).toBe(false);
  });
});

describe("timeStage tracker (#226)", () => {
  it("clears the tracker after a successful stage", async () => {
    const t = createStageTracker();
    const value = await timeStage(log, "github.fetch", () => Promise.resolve("ok"), t);
    expect(value).toBe("ok");
    expect(t.active).toBeNull();
  });

  it("leaves the tracker pointing at the failed stage on throw", async () => {
    const t = createStageTracker();
    let caught: unknown;
    try {
      await timeStage(log, "executor.invoke", () => Promise.reject(new Error("boom")), t);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("boom");
    expect(t.active?.stage).toBe("executor.invoke");
    expect(typeof t.active?.startedAt).toBe("number");
  });

  it("starts with a null active tracker", () => {
    expect(createStageTracker().active).toBeNull();
  });

  it("works without a tracker (backward compatible)", async () => {
    const value = await timeStage(log, "x", () => Promise.resolve(1));
    expect(value).toBe(1);
  });
});
