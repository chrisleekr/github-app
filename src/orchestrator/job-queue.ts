import { z } from "zod";

import { config } from "../config";
import { logger } from "../logger";
import { requireValkeyClient } from "./valkey";

/**
 * Queue-payload schemas. The on-the-wire JSON in `queue:jobs` is parsed via
 * `QueuedJobSchema` at every dequeue boundary so a malformed entry surfaces
 * at the queue edge, not deep in a consumer.
 *
 * Schema layout matches `specs/20260429-212559-ship-iteration-wiring/contracts/job-kinds.md`.
 */

const workflowRunRefSchema = z.object({
  runId: z.string().min(1),
  workflowName: z.enum(["triage", "plan", "implement", "review", "resolve", "ship"]),
  parentRunId: z.string().min(1).optional(),
  parentStepIndex: z.number().int().nonnegative().optional(),
});

const threadRefSchema = z
  .object({
    threadId: z.string().min(1),
    commentId: z.number().int().positive(),
    filePath: z.string().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .refine(({ startLine, endLine }) => endLine >= startLine, {
    message: "endLine must be greater than or equal to startLine",
  });

export type ScopedThreadRef = z.infer<typeof threadRefSchema>;

const baseQueuedJobShape = {
  deliveryId: z.string().min(1),
  repoOwner: z.string().min(1),
  repoName: z.string().min(1),
  entityNumber: z.number().int().nonnegative(),
  isPR: z.boolean(),
  eventName: z.string().min(1),
  triggerUsername: z.string(),
  labels: z.array(z.string()),
  triggerBodyPreview: z.string(),
  enqueuedAt: z.number(),
  retryCount: z.number().int().nonnegative(),
};

const legacyJobSchema = z.object({
  kind: z.literal("legacy"),
  ...baseQueuedJobShape,
});

const workflowRunJobSchema = z.object({
  kind: z.literal("workflow-run"),
  ...baseQueuedJobShape,
  workflowRun: workflowRunRefSchema,
});

const scopedCommonShape = {
  ...baseQueuedJobShape,
  installationId: z.number().int().positive(),
  triggerCommentId: z.number().int().positive(),
};

const scopedRebaseJobSchema = z.object({
  kind: z.literal("scoped-rebase"),
  ...scopedCommonShape,
  prNumber: z.number().int().positive(),
});

const scopedFixThreadJobSchema = z.object({
  kind: z.literal("scoped-fix-thread"),
  ...scopedCommonShape,
  prNumber: z.number().int().positive(),
  threadRef: threadRefSchema,
});

const scopedOpenPrJobSchema = z.object({
  kind: z.literal("scoped-open-pr"),
  ...scopedCommonShape,
  issueNumber: z.number().int().positive(),
  verdictSummary: z.string(),
});

/**
 * Scheduled-action job: an entity-free, cron-fired run of a skill-like
 * prompt (the `.github-app.yaml` feature). It rides the scoped-job rail
 * (offer/accept transport) but carries no PR/issue and no trigger comment;
 * the base fields are filled with sentinels (`entityNumber: 0`,
 * `isPR: false`, `triggerUsername: "scheduler"`, empty `labels` and
 * `triggerBodyPreview`).
 */
const scheduledActionJobSchema = z.object({
  kind: z.literal("scheduled-action"),
  ...baseQueuedJobShape,
  installationId: z.number().int().positive(),
  /** Action name from `.github-app.yaml`; unique per (repo). */
  actionName: z.string().min(1),
  /** ISO timestamp of the cron slot this job is for (observability). */
  cronSlotIso: z.string().min(1),
  /** Fully-resolved prompt (inline / file / folder concatenated). */
  promptText: z.string().min(1),
  /** Agent model override; daemon defaults to `config.model` when absent. */
  model: z.string().min(1).optional(),
  maxTurns: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  allowedTools: z.array(z.string().min(1)).optional(),
  /** Effective auto-merge: per-action flag already AND-ed with the env kill-switch. */
  autoMerge: z.boolean(),
});

/**
 * Discriminated union of every job that can appear on `queue:jobs`. Producers
 * MUST set `kind` explicitly; the daemon-side router and the orchestrator
 * dispatcher both switch on `kind` to choose the execution path.
 */
export const QueuedJobSchema = z.discriminatedUnion("kind", [
  legacyJobSchema,
  workflowRunJobSchema,
  scopedRebaseJobSchema,
  scopedFixThreadJobSchema,
  scopedOpenPrJobSchema,
  scheduledActionJobSchema,
]);

export type QueuedJob = z.infer<typeof QueuedJobSchema>;
export type LegacyQueuedJob = z.infer<typeof legacyJobSchema>;
export type WorkflowRunQueuedJob = z.infer<typeof workflowRunJobSchema>;
export type ScopedRebaseQueuedJob = z.infer<typeof scopedRebaseJobSchema>;
export type ScopedFixThreadQueuedJob = z.infer<typeof scopedFixThreadJobSchema>;
export type ScopedOpenPrQueuedJob = z.infer<typeof scopedOpenPrJobSchema>;
export type ScheduledActionQueuedJob = z.infer<typeof scheduledActionJobSchema>;
export type ScopedQueuedJob =
  | ScopedRebaseQueuedJob
  | ScopedFixThreadQueuedJob
  | ScopedOpenPrQueuedJob
  | ScheduledActionQueuedJob;

export const SCOPED_JOB_KINDS = [
  "scoped-rebase",
  "scoped-fix-thread",
  "scoped-open-pr",
  "scheduled-action",
] as const;

export type ScopedJobKind = (typeof SCOPED_JOB_KINDS)[number];

/** Type-guard: true when `job` is one of the four scoped variants. */
export function isScopedJob(job: QueuedJob): job is ScopedQueuedJob {
  return (SCOPED_JOB_KINDS as readonly string[]).includes(job.kind);
}

const QUEUE_KEY = "queue:jobs";
const PROCESSING_KEY_PREFIX = "queue:processing:";

/** Build the per-instance processing-list key. Exposed for the cross-instance reaper. */
export function processingListKey(instanceId: string): string {
  return `${PROCESSING_KEY_PREFIX}${instanceId}`;
}

/** Pattern to SCAN every orchestrator's processing list (used by the reaper). */
export const PROCESSING_KEY_PATTERN = `${PROCESSING_KEY_PREFIX}*`;

function parseQueuedJob(raw: string): QueuedJob | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = QueuedJobSchema.safeParse(parsed);
  if (!result.success) {
    // `raw` can carry user-authored content (triggerBodyPreview,
    // verdictSummary). Log only metadata so an invalid payload does not
    // leak free-form user text into operator logs.
    logger.error(
      { issues: result.error.issues, rawLength: raw.length },
      "queue:jobs payload failed schema validation",
    );
    return null;
  }
  return result.data;
}

/**
 * Enqueue a job for daemon dispatch. Validates the payload against the
 * discriminated union before LPUSH so producers cannot ship malformed
 * entries onto the shared queue.
 *
 * Uses LPUSH (newest at head): BRPOP dequeues from tail (FIFO).
 */
export async function enqueueJob(job: QueuedJob): Promise<void> {
  const validated = QueuedJobSchema.parse(job);
  const valkey = requireValkeyClient();
  await valkey.send("LPUSH", [QUEUE_KEY, JSON.stringify(validated)]);
  logger.info(
    { kind: validated.kind, deliveryId: validated.deliveryId, retryCount: validated.retryCount },
    "Job enqueued",
  );
}

/**
 * Return the current queue depth. Used by the ephemeral-daemon scaler
 * to detect persistent-pool backpressure. Non-blocking; returns 0 on
 * any Valkey read error so a transient blip falls through to
 * persistent-daemon routing instead of trapping a job.
 */
export async function getQueueLength(): Promise<number> {
  try {
    const valkey = requireValkeyClient();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Valkey LLEN returns number
    const len: number = await valkey.send("LLEN", [QUEUE_KEY]);
    return typeof len === "number" && Number.isFinite(len) ? len : 0;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to read queue length, treating as 0",
    );
    return 0;
  }
}

/**
 * Non-blocking dequeue for use in webhook handlers.
 * Uses RPOP: returns immediately with null if the queue is empty.
 */
export async function tryDequeueJob(): Promise<QueuedJob | null> {
  const valkey = requireValkeyClient();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Valkey RPOP returns string | null
  const result: string | null = await valkey.send("RPOP", [QUEUE_KEY]);
  if (result === null) return null;
  const parsed = parseQueuedJob(result);
  if (parsed === null) {
    logger.error("Failed to parse dequeued job, dropping poison pill");
    return null;
  }
  return parsed;
}

/**
 * Blocking dequeue for background dispatch loops.
 * Uses BRPOP with a 5-second timeout to avoid busy-waiting.
 * Returns null if the queue is empty after timeout.
 */
export async function dequeueJob(): Promise<QueuedJob | null> {
  const valkey = requireValkeyClient();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Valkey BRPOP returns [key, value] | null
  const result: [string, string] | null = await valkey.send("BRPOP", [QUEUE_KEY, "5"]);
  if (result === null) return null;
  const parsed = parseQueuedJob(result[1]);
  if (parsed === null) {
    logger.error("Failed to parse dequeued job, dropping poison pill");
    return null;
  }
  return parsed;
}

/**
 * Re-enqueue a job after rejection or timeout, respecting retry limits.
 * Returns true if re-queued, false if max retries exceeded.
 */
export async function requeueJob(job: QueuedJob): Promise<boolean> {
  if (job.retryCount >= config.jobMaxRetries) {
    logger.warn(
      { kind: job.kind, deliveryId: job.deliveryId, retryCount: job.retryCount },
      "Job exceeded max retries, will not re-queue",
    );
    return false;
  }
  const updated: QueuedJob = {
    ...job,
    retryCount: job.retryCount + 1,
    enqueuedAt: Date.now(),
  };
  await enqueueJob(updated);
  return true;
}

// --- Reliable-queue lease helpers (HA queue worker) -------------------------
//
// A single Bun RedisClient is shared process-wide, so blocking commands like
// BLMOVE would starve every other Valkey caller (heartbeats, registration,
// counters). The worker therefore polls with a non-blocking LMOVE and sleeps
// between empty polls, see `queue-worker.ts`.

/**
 * Atomic lease: pop the oldest job from `queue:jobs` and append it to this
 * instance's processing list. Returns the parsed job and the raw JSON string
 * (the latter is needed verbatim for `LREM`/`LMOVE` element matching).
 *
 * Returns null when the queue is empty.
 */
export async function leaseJob(
  instanceId: string,
): Promise<{ job: QueuedJob; raw: string } | null> {
  const valkey = requireValkeyClient();
  const dest = processingListKey(instanceId);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Valkey LMOVE returns string | null
  const raw: string | null = await valkey.send("LMOVE", [QUEUE_KEY, dest, "RIGHT", "LEFT"]);
  if (raw === null) return null;
  const job = parseQueuedJob(raw);
  if (job === null) {
    logger.error({ rawLength: raw.length }, "Failed to parse leased job, dropping poison pill");
    await valkey.send("LREM", [dest, "1", raw]);
    return null;
  }
  return { job, raw };
}

/**
 * Release a successfully-dispatched job from this instance's processing list.
 * Idempotent: `LREM` is a no-op when the element is already gone.
 */
export async function releaseLeasedJob(instanceId: string, raw: string): Promise<void> {
  const valkey = requireValkeyClient();
  await valkey.send("LREM", [processingListKey(instanceId), "1", raw]);
}

// Atomic re-queue: remove the leased element from the processing list and
// push the updated payload back to the head of the shared queue. Inlining
// this as one EVAL avoids a duplicate-on-crash window between LREM and LPUSH.
const REQUEUE_LUA = `
  redis.call('LREM', KEYS[1], 1, ARGV[1])
  redis.call('LPUSH', KEYS[2], ARGV[2])
  return 1
`;

/**
 * Re-queue a leased job back to `queue:jobs` (head, so another instance picks
 * it up next), bumping `retryCount` and `enqueuedAt`. Returns the new
 * `retryCount` so the caller can apply backoff or give up.
 */
export async function requeueLeasedJob(
  instanceId: string,
  raw: string,
  job: QueuedJob,
): Promise<number> {
  const valkey = requireValkeyClient();
  const updated: QueuedJob = {
    ...job,
    retryCount: job.retryCount + 1,
    enqueuedAt: Date.now(),
  };
  await valkey.send("EVAL", [
    REQUEUE_LUA,
    "2",
    processingListKey(instanceId),
    QUEUE_KEY,
    raw,
    JSON.stringify(QueuedJobSchema.parse(updated)),
  ]);
  return updated.retryCount;
}

/**
 * Drain a (possibly-orphaned) processing list back into `queue:jobs`. Called
 * on this instance's own list at startup, and on dead-instance lists by the
 * cross-instance reaper.
 *
 * Pushes items to the HEAD of the shared queue so they are re-leased before
 * any newer arrivals: preserving the rough FIFO intent of the original queue.
 *
 * Returns the number of items recovered.
 */
export async function recoverProcessingList(instanceId: string): Promise<number> {
  const valkey = requireValkeyClient();
  const src = processingListKey(instanceId);
  let count = 0;
  for (let i = 0; i < 10_000; i++) {
    // eslint-disable-next-line no-await-in-loop, @typescript-eslint/no-unsafe-assignment -- Valkey LMOVE returns string | null
    const moved: string | null = await valkey.send("LMOVE", [src, QUEUE_KEY, "LEFT", "LEFT"]);
    if (moved === null) break;
    count++;
  }
  if (count > 0) {
    logger.info({ instanceId, recovered: count }, "Recovered processing-list jobs to queue:jobs");
  }
  return count;
}
