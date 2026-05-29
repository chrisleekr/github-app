import { describe, expect, it } from "bun:test";

import { CORE_PIPELINE_LOG_EVENTS, PipelineStageLogSchema } from "../../src/core/log-fields";

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
