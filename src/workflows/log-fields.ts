/**
 * Canonical pino log-field schema for the `workflow_runs` lifecycle (issue #235).
 *
 * Mirrors `src/core/log-fields.ts` and `src/webhook/idempotency-log-fields.ts`:
 * a strict Zod shape pins the structured `workflow.run.*` event family so the
 * emit sites at every state transition cannot drift on a field name (e.g.
 * `durationMs` vs `duration_ms`, or a target shape change) without the
 * co-located test catching it. Emitters log plain objects via `log.info` /
 * `log.warn` / `log.error`; the schema is the drift-prevention contract, not a
 * runtime validator on the hot path.
 *
 * The mutators in `src/workflows/runs-store.ts` stay log-free (they have no
 * logger and are reused under transactions in `orchestrator.ts` /
 * `ship/iteration.ts`), so the events are emitted at the callers, the same
 * convention as `scheduler.action.claimed`. The existing `reason:` / `outcome:`
 * fields on the legacy log lines are left in place; this adds the `event:`
 * discriminator alongside them.
 *
 * `runId`, `workflowName`, `target`, and `deliveryId` are the established
 * camelCase child-logger bindings reused repo-wide; new metric-style fields
 * (`duration_ms`) are snake_case. `deliveryId` is optional because system-spawned
 * runs (ship iteration, orchestrator cascade children) have no originating
 * webhook delivery. `duration_ms` is carried only on terminal events that own a
 * start timestamp supplied by the execution owner.
 */
import { z } from "zod";

import { type Logger } from "../logger";

export const WORKFLOW_RUN_LOG_EVENTS = {
  queued: "workflow.run.queued",
  running: "workflow.run.running",
  succeeded: "workflow.run.succeeded",
  failed: "workflow.run.failed",
  incomplete: "workflow.run.incomplete",
  handedOff: "workflow.run.handed_off",
  dispatchRefused: "workflow.run.dispatch_refused",
  enqueueFailed: "workflow.run.enqueue_failed",
} as const;

/** Bounded run-target metadata. Mirrors the workflow dispatch envelope. */
const target = z
  .object({
    type: z.enum(["issue", "pr"]),
    owner: z.string().min(1),
    repo: z.string().min(1),
    number: z.number().int().positive(),
  })
  .strict();

const runId = z.string().min(1);
const workflowName = z.string().min(1);
const deliveryId = z.string().min(1).optional();
const durationMs = z.number().int().nonnegative();

export const WorkflowRunLogFieldsSchema = z.union([
  /** Info: a `queued` row was inserted (dispatcher / ship-iteration / cascade). */
  z.strictObject({
    event: z.literal(WORKFLOW_RUN_LOG_EVENTS.queued),
    runId,
    workflowName,
    target,
    deliveryId,
  }),
  /** Info: an execution owner flipped the row to `running`. */
  z.strictObject({
    event: z.literal(WORKFLOW_RUN_LOG_EVENTS.running),
    runId,
    workflowName,
    target,
    deliveryId,
  }),
  /** Info: terminal success. `duration_ms` is the handler wall-clock. */
  z.strictObject({
    event: z.literal(WORKFLOW_RUN_LOG_EVENTS.succeeded),
    runId,
    workflowName,
    target,
    deliveryId,
    duration_ms: durationMs,
  }),
  /** Warn: the agent ran cleanly but a handler gate left work outstanding. */
  z.strictObject({
    event: z.literal(WORKFLOW_RUN_LOG_EVENTS.incomplete),
    runId,
    workflowName,
    target,
    deliveryId,
    duration_ms: durationMs,
    reason: z.string(),
  }),
  /** Warn/Error: terminal failure (handler-reported or uncaught throw). */
  z.strictObject({
    event: z.literal(WORKFLOW_RUN_LOG_EVENTS.failed),
    runId,
    workflowName,
    target,
    deliveryId,
    duration_ms: durationMs,
    reason: z.string(),
  }),
  /** Info: composite parent handed off to a child; row stays `running`. */
  z.strictObject({
    event: z.literal(WORKFLOW_RUN_LOG_EVENTS.handedOff),
    runId,
    workflowName,
    target,
    deliveryId,
    duration_ms: durationMs,
    childRunId: z.string().min(1),
  }),
  /**
   * Info: dispatch refused before any row was inserted (context mismatch,
   * missing prior output, or in-flight collision). No `runId` exists yet.
   */
  z.strictObject({
    event: z.literal(WORKFLOW_RUN_LOG_EVENTS.dispatchRefused),
    workflowName,
    target,
    deliveryId,
    reason: z.string(),
  }),
  /**
   * Error: the first post-commit publication failed. The queued row and its
   * in-flight guard remain durable while the outbox retries. `runId` exists.
   */
  z.strictObject({
    event: z.literal(WORKFLOW_RUN_LOG_EVENTS.enqueueFailed),
    runId,
    workflowName,
    target,
    deliveryId,
    reason: z.string(),
  }),
]);

export type WorkflowRunLogFields = z.infer<typeof WorkflowRunLogFieldsSchema>;

/** Shape of the run target as emit sites already build it. */
export interface WorkflowRunTarget {
  type: "issue" | "pr";
  owner: string;
  repo: string;
  number: number;
}

interface BaseFields {
  runId: string;
  workflowName: string;
  target: WorkflowRunTarget;
  deliveryId?: string | null;
}

/** Drop a null/undefined `deliveryId` so pino does not emit a null key. */
function withDelivery<T extends { deliveryId?: string | null }>(
  fields: T,
): Omit<T, "deliveryId"> & { deliveryId?: string } {
  const { deliveryId, ...rest } = fields;
  return deliveryId === null || deliveryId === undefined ? rest : { ...rest, deliveryId };
}

/** Info: a `queued` row was inserted. */
export function logWorkflowRunQueued(log: Logger, fields: BaseFields): void {
  log.info(
    withDelivery({ event: WORKFLOW_RUN_LOG_EVENTS.queued, ...fields }),
    "Workflow run queued",
  );
}

/** Info: the row flipped to `running`. */
export function logWorkflowRunRunning(log: Logger, fields: BaseFields): void {
  log.info(
    withDelivery({ event: WORKFLOW_RUN_LOG_EVENTS.running, ...fields }),
    "Workflow run running",
  );
}

/** Info: terminal success. */
export function logWorkflowRunSucceeded(
  log: Logger,
  fields: BaseFields & { durationMs: number },
): void {
  const { durationMs, ...base } = fields;
  log.info(
    withDelivery({ event: WORKFLOW_RUN_LOG_EVENTS.succeeded, ...base, duration_ms: durationMs }),
    "Workflow run succeeded",
  );
}

/** Warn: clean run but work outstanding. */
export function logWorkflowRunIncomplete(
  log: Logger,
  fields: BaseFields & { durationMs: number; reason: string },
): void {
  const { durationMs, reason, ...base } = fields;
  log.warn(
    withDelivery({
      event: WORKFLOW_RUN_LOG_EVENTS.incomplete,
      ...base,
      duration_ms: durationMs,
      reason,
    }),
    "Workflow run incomplete",
  );
}

/**
 * Terminal failure. `level` distinguishes a handler-reported failure (`warn`)
 * from an uncaught throw (`error`); the execution owner logs the throw with
 * the standard `err` field, this event mirrors that level.
 */
export function logWorkflowRunFailed(
  log: Logger,
  fields: BaseFields & { durationMs: number; reason: string },
  level: "warn" | "error" = "warn",
): void {
  const { durationMs, reason, ...base } = fields;
  const record = withDelivery({
    event: WORKFLOW_RUN_LOG_EVENTS.failed,
    ...base,
    duration_ms: durationMs,
    reason,
  });
  if (level === "error") {
    log.error(record, "Workflow run failed");
  } else {
    log.warn(record, "Workflow run failed");
  }
}

/** Info: composite parent handed off to a child. */
export function logWorkflowRunHandedOff(
  log: Logger,
  fields: BaseFields & { durationMs: number; childRunId: string },
): void {
  const { durationMs, childRunId, ...base } = fields;
  log.info(
    withDelivery({
      event: WORKFLOW_RUN_LOG_EVENTS.handedOff,
      ...base,
      duration_ms: durationMs,
      childRunId,
    }),
    "Workflow run handed off to child",
  );
}

/** Info: dispatch refused before any row existed. No `runId`. */
export function logWorkflowRunDispatchRefused(
  log: Logger,
  fields: Omit<BaseFields, "runId"> & { reason: string },
): void {
  const { reason, ...base } = fields;
  log.info(
    withDelivery({ event: WORKFLOW_RUN_LOG_EVENTS.dispatchRefused, ...base, reason }),
    "Workflow run dispatch refused",
  );
}

/** Error: initial publication failed; the durable outbox retains the queued run. */
export function logWorkflowRunEnqueueFailed(
  log: Logger,
  fields: BaseFields & { reason: string },
): void {
  const { reason, ...base } = fields;
  log.error(
    withDelivery({ event: WORKFLOW_RUN_LOG_EVENTS.enqueueFailed, ...base, reason }),
    "Workflow run enqueue failed",
  );
}
