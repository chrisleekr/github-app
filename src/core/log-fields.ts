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
 * emit a misleading "completed" timing.
 */
export async function timeStage<T>(log: Logger, stage: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const value = await fn();
  logPipelineStage(log, stage, startedAt);
  return value;
}
