/**
 * Canonical pino log-field schema for core-pipeline timing events (issue #166).
 *
 * Mirrors `src/workflows/ship/log-fields.ts`: a `.strict()` Zod shape pins the
 * structured `pipeline.stage` event so per-stage timing fields cannot drift,
 * and the co-located test round-trips a sample line through it. Emitters log
 * plain objects via `logPipelineStage` / `timeStage`; the schema is the
 * drift-prevention contract, not a runtime validator on the hot path.
 *
 * `delta_ms` is the wall-clock of a single stage; `pipeline_wall_clock_ms`
 * (carried on the terminal `pipeline.completed` / `pipeline.failed` lines) is
 * the cumulative pipeline duration. Both are integer milliseconds.
 */
import { z } from "zod";

import { type Logger } from "../logger";

export const CORE_PIPELINE_LOG_EVENTS = {
  started: "pipeline.started",
  stage: "pipeline.stage",
  completed: "pipeline.completed",
  failed: "pipeline.failed",
} as const;

/**
 * Shape of the structured per-stage timing event. `.strict()` so an emitter
 * that adds an unpinned field, or mistypes `delta_ms`, trips the test.
 */
export const PipelineStageLogSchema = z
  .object({
    event: z.literal(CORE_PIPELINE_LOG_EVENTS.stage),
    stage: z.string().min(1),
    delta_ms: z.number().int().nonnegative(),
  })
  .strict();

export type PipelineStageLog = z.infer<typeof PipelineStageLogSchema>;

/**
 * Shape of the terminal `pipeline.completed` line. The metric fields are
 * `.optional()` because the SDK can omit them (e.g. a dry-run that never calls
 * the model); pino drops the `undefined` keys. The token counters surface
 * prompt size and the cache hit-ratio `cache_read / (input + cache_read +
 * cache_creation)` (issue #192). `.strict()` so an emitter that adds an
 * unpinned field, or mistypes one, trips the co-located test.
 */
export const PipelineCompletedLogSchema = z
  .object({
    event: z.literal(CORE_PIPELINE_LOG_EVENTS.completed),
    success: z.boolean(),
    durationMs: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
    numTurns: z.number().int().nonnegative().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cacheReadInputTokens: z.number().int().nonnegative().optional(),
    cacheCreationInputTokens: z.number().int().nonnegative().optional(),
    pipeline_wall_clock_ms: z.number().int().nonnegative(),
  })
  .strict();

export type PipelineCompletedLog = z.infer<typeof PipelineCompletedLogSchema>;

/**
 * Shape of the terminal `pipeline.failed` line (issue #226). The two stage
 * fields are `.optional()` because a failure before any timed stage starts
 * (or after all stages cleared) carries neither. `failed_stage` is the stage
 * in flight when the throw happened; `failed_stage_delta_ms` is that stage's
 * wall-clock up to the throw. `err` (the standard pino error field) is not
 * pinned here, same as `PipelineCompletedLogSchema`: this schema fixes only the
 * custom metric fields. `.strict()` so an emitter that adds an unpinned field,
 * or mistypes one, trips the co-located test. The two stage fields are emitted
 * together or not at all (the catch spreads both or neither), so a `.refine`
 * rejects a record that carries only one.
 */
export const PipelineFailedLogSchema = z
  .object({
    event: z.literal(CORE_PIPELINE_LOG_EVENTS.failed),
    failed_stage: z.string().optional(),
    failed_stage_delta_ms: z.number().int().nonnegative().optional(),
    pipeline_wall_clock_ms: z.number().int().nonnegative(),
  })
  .strict()
  .refine((v) => (v.failed_stage === undefined) === (v.failed_stage_delta_ms === undefined), {
    message: "failed_stage and failed_stage_delta_ms must be present together",
  });

export type PipelineFailedLog = z.infer<typeof PipelineFailedLogSchema>;

/**
 * Per-pipeline cursor of the stage currently in flight (issue #226). `timeStage`
 * sets `active` before awaiting and clears it on success, so after a throw it
 * still points at the failed stage, letting the terminal `pipeline.failed` line
 * attribute which stage threw and its wall-clock to that point.
 */
export interface StageTracker {
  active: { stage: string; startedAt: number } | null;
}

export function createStageTracker(): StageTracker {
  return { active: null };
}

/**
 * Emit a `pipeline.stage` event measuring `Date.now() - startedAt`. The child
 * logger's bindings (deliveryId, owner, repo, entityNumber) are prepended by
 * pino, so the structured line is greppable per request and per stage.
 */
export function logPipelineStage(log: Logger, stage: string, startedAt: number): void {
  log.info(
    { event: CORE_PIPELINE_LOG_EVENTS.stage, stage, delta_ms: Date.now() - startedAt },
    "Pipeline stage completed",
  );
}

/**
 * Run an awaited stage, timing it end-to-end and emitting one `pipeline.stage`
 * event on success. Errors propagate unchanged (the failure is logged by the
 * pipeline's terminal `pipeline.failed` line), so a throwing stage does not
 * emit a misleading "completed" timing. When a `tracker` is passed, `active` is
 * set before awaiting and cleared after the success log; a throw skips the clear
 * so `active` still names the failed stage for the failure path to attribute.
 */
export async function timeStage<T>(
  log: Logger,
  stage: string,
  fn: () => Promise<T>,
  tracker?: StageTracker,
): Promise<T> {
  const startedAt = Date.now();
  if (tracker) tracker.active = { stage, startedAt };
  const value = await fn(); // a throw here leaves tracker.active on this stage and propagates unchanged
  logPipelineStage(log, stage, startedAt);
  if (tracker) tracker.active = null;
  return value;
}
