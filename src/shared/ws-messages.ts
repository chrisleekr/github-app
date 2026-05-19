import { z } from "zod";

import { daemonCapabilitiesSchema } from "./daemon-types";

// Message envelope -- every WS message follows this shape

const messageEnvelopeBase = {
  id: z.uuid(),
  timestamp: z.number(),
};

// Server -> Daemon messages

const daemonRegisteredSchema = z.object({
  type: z.literal("daemon:registered"),
  ...messageEnvelopeBase,
  payload: z.object({
    heartbeatIntervalMs: z.number().int().positive(),
    offerTimeoutMs: z.number().int().positive(),
    maxRetries: z.number().int().nonnegative(),
  }),
});

const heartbeatPingSchema = z.object({
  type: z.literal("heartbeat:ping"),
  ...messageEnvelopeBase,
  payload: z.object({}),
});

const jobOfferSchema = z.object({
  type: z.literal("job:offer"),
  ...messageEnvelopeBase,
  payload: z.object({
    deliveryId: z.string(),
    repoOwner: z.string(),
    repoName: z.string(),
    entityNumber: z.number().int(),
    isPR: z.boolean(),
    eventName: z.string(),
    triggerUsername: z.string(),
    labels: z.array(z.string()),
    triggerBodyPreview: z.string(),
    requiredTools: z.array(z.string()),
  }),
});

const repoMemoryEntrySchema = z.object({
  id: z.string(),
  category: z.string(),
  content: z.string(),
  pinned: z.boolean(),
});

/**
 * Workflow run reference piggybacking on the existing job payload. Presence
 * of this field signals the daemon to route the job through
 * `src/daemon/workflow-executor.ts` instead of the legacy pipeline. Kept as
 * a pure literal z.enum here to avoid importing the registry module from the
 * shared schema layer (registry import pulls handler transitive deps).
 */
const workflowRunRefSchema = z.object({
  runId: z.string().min(1),
  workflowName: z.enum(["triage", "plan", "implement", "review", "resolve", "ship"]),
  parentRunId: z.string().min(1).optional(),
  parentStepIndex: z.number().int().nonnegative().optional(),
});

/**
 * Per-kind context passed alongside `job:payload` for scoped jobs. Mirrors
 * the discriminator in `scoped-job-offer` so the daemon's executor can route
 * via the same Zod parse: discriminator at the schema level, not via runtime
 * presence checks (per contracts/ws-messages.md validation requirement).
 */
const scopedThreadRefSchema = z
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

const scopedJobContextSchema = z.discriminatedUnion("jobKind", [
  z.object({
    jobKind: z.literal("scoped-rebase"),
    deliveryId: z.string().min(1),
    installationId: z.number().int().positive(),
    owner: z.string().min(1),
    repo: z.string().min(1),
    prNumber: z.number().int().positive(),
    triggerCommentId: z.number().int().positive(),
    enqueuedAt: z.number(),
  }),
  z.object({
    jobKind: z.literal("scoped-fix-thread"),
    deliveryId: z.string().min(1),
    installationId: z.number().int().positive(),
    owner: z.string().min(1),
    repo: z.string().min(1),
    prNumber: z.number().int().positive(),
    threadRef: scopedThreadRefSchema,
    triggerCommentId: z.number().int().positive(),
    enqueuedAt: z.number(),
  }),
  z.object({
    jobKind: z.literal("scoped-open-pr"),
    deliveryId: z.string().min(1),
    installationId: z.number().int().positive(),
    owner: z.string().min(1),
    repo: z.string().min(1),
    issueNumber: z.number().int().positive(),
    triggerCommentId: z.number().int().positive(),
    enqueuedAt: z.number(),
    verdictSummary: z.string(),
  }),
  z.object({
    // Entity-free, cron-fired prompt run (`.github-app.yaml` feature).
    // Carries no PR/issue and no trigger comment, see job-queue.ts.
    jobKind: z.literal("scheduled-action"),
    deliveryId: z.string().min(1),
    installationId: z.number().int().positive(),
    owner: z.string().min(1),
    repo: z.string().min(1),
    actionName: z.string().min(1),
    cronSlotIso: z.string().min(1),
    promptText: z.string().min(1),
    model: z.string().min(1).optional(),
    maxTurns: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    allowedTools: z.array(z.string().min(1)).optional(),
    autoMerge: z.boolean(),
    enqueuedAt: z.number(),
  }),
]);

export type ScopedJobContext = z.infer<typeof scopedJobContextSchema>;
export type ScopedJobKind = ScopedJobContext["jobKind"];

const jobPayloadSchema = z.object({
  type: z.literal("job:payload"),
  ...messageEnvelopeBase,
  payload: z.object({
    context: z.record(z.string(), z.unknown()),
    installationToken: z.string(),
    maxTurns: z.number().int().positive().optional(),
    allowedTools: z.array(z.string()),
    envVars: z.record(z.string(), z.string()).optional(),
    memory: z.array(repoMemoryEntrySchema).optional(),
    workflowRun: workflowRunRefSchema.optional(),
    /** Present only when the originating offer was a `scoped-job-offer`.
     * The daemon's job-executor routes on this field's presence and on the
     * inner `jobKind` discriminator. */
    scoped: scopedJobContextSchema.optional(),
  }),
});

/** Server-to-daemon scoped job offer (parallel to `job:offer`). */
const scopedJobOfferSchema = z.object({
  type: z.literal("scoped-job-offer"),
  ...messageEnvelopeBase,
  payload: scopedJobContextSchema,
});

/** Daemon-to-server scoped job completion. Per-kind result fields are
 * carried under `result` and validated by a discriminator on `jobKind`. */
const scopedJobResultSchema = z.discriminatedUnion("jobKind", [
  z
    .object({
      jobKind: z.literal("scoped-rebase"),
      status: z.enum(["succeeded", "failed", "halted"]),
      rebaseOutcome: z
        .discriminatedUnion("result", [
          z.object({ result: z.literal("up-to-date"), commentId: z.number().int().positive() }),
          z.object({
            result: z.literal("merged"),
            commentId: z.number().int().positive(),
            mergeCommitSha: z.string().min(1),
          }),
          z.object({
            result: z.literal("conflict"),
            commentId: z.number().int().positive(),
            conflictPaths: z.array(z.string()),
          }),
          z.object({ result: z.literal("closed"), commentId: z.number().int().positive() }),
        ])
        .optional(),
      reason: z.string().optional(),
    })
    .refine((v) => v.status !== "succeeded" || v.rebaseOutcome !== undefined, {
      message: "rebaseOutcome is required when scoped-rebase status is succeeded",
      path: ["rebaseOutcome"],
    }),
  z.object({
    jobKind: z.literal("scoped-fix-thread"),
    status: z.enum(["succeeded", "failed", "halted"]),
    pushedCommitSha: z.string().optional(),
    threadReplyId: z.number().int().positive().optional(),
    reason: z.string().optional(),
  }),
  z.object({
    jobKind: z.literal("scoped-open-pr"),
    status: z.enum(["succeeded", "failed", "halted"]),
    pushedCommitSha: z.string().optional(),
    newPrNumber: z.number().int().positive().optional(),
    reason: z.string().optional(),
  }),
  z.object({
    jobKind: z.literal("scheduled-action"),
    status: z.enum(["succeeded", "failed", "halted"]),
    /** A PR the action opened, if any (free-form prompt, best effort). */
    prNumber: z.number().int().positive().optional(),
    /** True when the action merged a PR. */
    merged: z.boolean().optional(),
    /** Short structured outcome for operator logs (e.g. "issue_created"). */
    outcome: z.string().optional(),
    reason: z.string().optional(),
  }),
]);

const scopedJobCompletionSchema = z.object({
  type: z.literal("scoped-job-completion"),
  ...messageEnvelopeBase,
  payload: z
    .object({
      offerId: z.string().min(1),
      deliveryId: z.string().min(1),
      costUsd: z.number().nonnegative().optional(),
      durationMs: z.number().int().nonnegative().optional(),
    })
    .and(scopedJobResultSchema),
});

const jobCancelSchema = z.object({
  type: z.literal("job:cancel"),
  ...messageEnvelopeBase,
  payload: z.object({
    reason: z.string(),
  }),
});

const daemonUpdateRequiredSchema = z.object({
  type: z.literal("daemon:update-required"),
  ...messageEnvelopeBase,
  payload: z.object({
    targetVersion: z.string(),
    reason: z.string(),
    urgent: z.boolean(),
  }),
});

const errorSchema = z.object({
  type: z.literal("error"),
  ...messageEnvelopeBase,
  payload: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

/** Discriminated union of all messages the server can send to a daemon. */
export const serverMessageSchema = z.discriminatedUnion("type", [
  daemonRegisteredSchema,
  heartbeatPingSchema,
  jobOfferSchema,
  scopedJobOfferSchema,
  jobPayloadSchema,
  jobCancelSchema,
  daemonUpdateRequiredSchema,
  errorSchema,
]);

// Daemon -> Server messages

const daemonRegisterSchema = z.object({
  type: z.literal("daemon:register"),
  ...messageEnvelopeBase,
  payload: z.object({
    daemonId: z.string().min(1),
    hostname: z.string(),
    platform: z.enum(["linux", "darwin", "win32"]),
    osVersion: z.string(),
    protocolVersion: z.string(),
    appVersion: z.string(),
    capabilities: daemonCapabilitiesSchema,
  }),
});

const heartbeatPongSchema = z.object({
  type: z.literal("heartbeat:pong"),
  ...messageEnvelopeBase,
  payload: z.object({
    activeJobs: z.number().int().nonnegative(),
    resources: z.object({
      cpuCount: z.number().positive(),
      memoryTotalMb: z.number().positive(),
      memoryFreeMb: z.number().nonnegative(),
      diskFreeMb: z.number().nonnegative(),
    }),
  }),
});

const jobAcceptSchema = z.object({
  type: z.literal("job:accept"),
  ...messageEnvelopeBase,
  payload: z.object({}),
});

const jobRejectSchema = z.object({
  type: z.literal("job:reject"),
  ...messageEnvelopeBase,
  payload: z.object({
    reason: z.string(),
  }),
});

const jobStatusSchema = z.object({
  type: z.literal("job:status"),
  ...messageEnvelopeBase,
  payload: z.object({
    status: z.enum(["running", "cloning", "executing"]),
    message: z.string().optional(),
  }),
});

const jobResultSchema = z.object({
  type: z.literal("job:result"),
  ...messageEnvelopeBase,
  payload: z.object({
    success: z.boolean(),
    /** Daemon includes deliveryId so orchestrator can finalize the execution
     * even if the in-memory pending offer map was cleared (e.g. after restart). */
    deliveryId: z.string().optional(),
    costUsd: z.number().nonnegative().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    numTurns: z.number().int().nonnegative().optional(),
    errorMessage: z.string().optional(),
    dryRun: z.boolean().optional(),
    learnings: z.array(z.object({ category: z.string(), content: z.string() })).optional(),
    deletions: z.array(z.string()).optional(),
  }),
});

const daemonUpdateAcknowledgedSchema = z.object({
  type: z.literal("daemon:update-acknowledged"),
  ...messageEnvelopeBase,
  payload: z.object({
    strategy: z.enum(["exit", "pull", "notify"]),
    delayMs: z.number().int().nonnegative(),
  }),
});

const daemonDrainingSchema = z.object({
  type: z.literal("daemon:draining"),
  ...messageEnvelopeBase,
  payload: z.object({
    activeJobs: z.number().int().nonnegative(),
    reason: z.string(),
  }),
});

/** Discriminated union of all messages a daemon can send to the server. */
export const daemonMessageSchema = z.discriminatedUnion("type", [
  daemonRegisterSchema,
  heartbeatPongSchema,
  jobAcceptSchema,
  jobRejectSchema,
  jobStatusSchema,
  jobResultSchema,
  scopedJobCompletionSchema,
  daemonUpdateAcknowledgedSchema,
  daemonDrainingSchema,
]);

// Inferred TypeScript types

export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type DaemonMessage = z.infer<typeof daemonMessageSchema>;

// Individual message types for narrowed handling
export type DaemonRegisteredMessage = z.infer<typeof daemonRegisteredSchema>;
export type HeartbeatPingMessage = z.infer<typeof heartbeatPingSchema>;
export type JobOfferMessage = z.infer<typeof jobOfferSchema>;
export type ScopedJobOfferMessage = z.infer<typeof scopedJobOfferSchema>;
export type JobPayloadMessage = z.infer<typeof jobPayloadSchema>;
export type JobCancelMessage = z.infer<typeof jobCancelSchema>;
export type DaemonUpdateRequiredMessage = z.infer<typeof daemonUpdateRequiredSchema>;
export type ErrorMessage = z.infer<typeof errorSchema>;

export type DaemonRegisterMessage = z.infer<typeof daemonRegisterSchema>;
export type HeartbeatPongMessage = z.infer<typeof heartbeatPongSchema>;
export type JobAcceptMessage = z.infer<typeof jobAcceptSchema>;
export type JobRejectMessage = z.infer<typeof jobRejectSchema>;
export type JobStatusMessage = z.infer<typeof jobStatusSchema>;
export type JobResultMessage = z.infer<typeof jobResultSchema>;
export type ScopedJobCompletionMessage = z.infer<typeof scopedJobCompletionSchema>;
export type DaemonUpdateAcknowledgedMessage = z.infer<typeof daemonUpdateAcknowledgedSchema>;
export type DaemonDrainingMessage = z.infer<typeof daemonDrainingSchema>;

// WebSocket protocol version

/** Current protocol version. Major bump = breaking change = reject connection. */
export const PROTOCOL_VERSION = "1.0.0";

// Custom WebSocket close codes

export const WS_CLOSE_CODES = {
  GRACEFUL_SHUTDOWN: { code: 1000, reason: "graceful shutdown" },
  POLICY_VIOLATION: { code: 1008, reason: "policy violation" },
  HEARTBEAT_TIMEOUT: { code: 4001, reason: "heartbeat timeout" },
  SUPERSEDED: { code: 4002, reason: "superseded by new connection" },
  INCOMPATIBLE_PROTOCOL: { code: 4003, reason: "incompatible protocol version" },
} as const;

// Reject taxonomy, canonical reason strings the daemon may emit on
// `job:reject`. The wire-level type stays `z.string()` for forward-compat;
// these constants are the contract for callers that branch on reason.
export const WS_REJECT_REASONS = {
  BUSY: "busy",
  INCOMPATIBLE: "incompatible",
  SHUTTING_DOWN: "shutting-down",
  /** Daemon image does not understand this scoped `jobKind`. Allows the
   * orchestrator to re-offer the job to a capable daemon. */
  SCOPED_KIND_UNSUPPORTED: "scoped-kind-unsupported",
} as const;

// Error codes

export const WS_ERROR_CODES = {
  INVALID_MESSAGE: "INVALID_MESSAGE",
  UNKNOWN_OFFER: "UNKNOWN_OFFER",
  DUPLICATE_REGISTRATION: "DUPLICATE_REGISTRATION",
  EXECUTION_ALREADY_FINALIZED: "EXECUTION_ALREADY_FINALIZED",
  MESSAGE_TOO_LARGE: "MESSAGE_TOO_LARGE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

// Helpers

/** Create a message envelope with a fresh UUID and current timestamp. */
export function createMessageEnvelope(overrideId?: string): { id: string; timestamp: number } {
  return {
    id: overrideId ?? crypto.randomUUID(),
    timestamp: Date.now(),
  };
}
