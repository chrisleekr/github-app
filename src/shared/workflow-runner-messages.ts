import { z } from "zod";

import {
  HandlerResultSchema,
  PriorPlanStateSchema,
  RepoMemoryEntrySchema,
  WORKFLOW_RUNNER_HUMAN_MESSAGE_MAX_CHARS,
  WorkflowNameSchema,
  WorkflowRunRefSchema,
  WorkflowRunSnapshotSchema,
} from "./workflow-types";
import { AgentPolicySchema, ReviewLearningPayloadSchema } from "./ws-messages";

const envelope = {
  id: z.uuid(),
  timestamp: z.number(),
};

const attemptIdentity = {
  runId: z.uuid(),
  attemptId: z.uuid(),
};

const CONTROLLER_RESERVED_STATE_KEYS = ["_configNotice", "_lastHumanMessage"] as const;

function containsControllerReservedState(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    CONTROLLER_RESERVED_STATE_KEYS.some((key) => Object.hasOwn(value, key))
  );
}

const runnerStatePatchSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => !containsControllerReservedState(value),
    "workflow runner state contains a controller-reserved key",
  );

export const WORKFLOW_RUNNER_MESSAGE_MAX_BYTES = 900_000;

function fitsWorkflowRunnerMessageBudget(value: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= WORKFLOW_RUNNER_MESSAGE_MAX_BYTES;
  } catch {
    return false;
  }
}

const targetSchema = z.object({
  type: z.enum(["issue", "pr"]),
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
});

// The runner casts `context` to `SerializableBotContext` and reads these five
// fields before anything else. `z.record` alone accepts `{}`, which would put
// `undefined` into `runContext.target` behind a typed cast. `catchall` keeps the
// remaining BotContext fields passing through untouched.
const workflowRunnerContextSchema = z
  .object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    entityNumber: z.number().int().positive(),
    isPR: z.boolean(),
    deliveryId: z.string().min(1),
  })
  .catchall(z.unknown());

export const WorkflowRunnerPayloadSchema = z.object({
  context: workflowRunnerContextSchema,
  installationToken: z.string().min(1),
  installationTokenExpiresAt: z.iso.datetime(),
  attemptDeadlineAt: z.iso.datetime(),
  repoMemory: z.array(RepoMemoryEntrySchema).max(50).optional(),
  maxTurns: z.number().int().positive().optional(),
  reviewLearnings: z.array(ReviewLearningPayloadSchema).max(50).optional(),
  policy: AgentPolicySchema.optional(),
  workflowRun: WorkflowRunRefSchema,
  priorPlanState: PriorPlanStateSchema.optional(),
  shipStepRuns: z.partialRecord(WorkflowNameSchema, WorkflowRunSnapshotSchema).optional(),
});
export type WorkflowRunnerPayload = z.infer<typeof WorkflowRunnerPayloadSchema>;

const runnerRegisteredSchema = z.object({
  type: z.literal("workflow-runner:registered"),
  ...envelope,
  payload: z.discriminatedUnion("state", [
    z.object({
      state: z.literal("ready"),
      heartbeatIntervalMs: z.number().int().positive(),
      clientFenceMs: z.number().int().positive(),
      dbLeaseMs: z.number().int().positive(),
      job: WorkflowRunnerPayloadSchema.optional(),
    }),
    z.object({ state: z.literal("completed") }),
  ]),
});

const runnerHeartbeatAckSchema = z.object({
  type: z.literal("workflow-runner:heartbeat-ack"),
  ...envelope,
  payload: z.object({ renewed: z.boolean() }),
});

const runnerCommandResultSchema = z.object({
  type: z.literal("workflow-runner:command-result"),
  ...envelope,
  payload: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      result: z.object({
        trackingCommentId: z.number().int().positive().optional(),
        childRunId: z.uuid().optional(),
      }),
    }),
    z.object({
      ok: z.literal(false),
      code: z.enum(["STALE_ATTEMPT", "INVALID_COMMAND", "INTERNAL_ERROR"]),
      message: z.string().min(1).max(500),
    }),
  ]),
});

const runnerResultAckSchema = z.object({
  type: z.literal("workflow-runner:result-ack"),
  ...envelope,
  payload: z.object({}),
});

const runnerCancelSchema = z.object({
  type: z.literal("workflow-runner:cancel"),
  ...envelope,
  payload: z.object({ reason: z.string().min(1).max(500) }),
});

const runnerErrorSchema = z.object({
  type: z.literal("workflow-runner:error"),
  ...envelope,
  payload: z.object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(500),
  }),
});

export const workflowRunnerServerMessageSchema = z.discriminatedUnion("type", [
  runnerRegisteredSchema,
  runnerHeartbeatAckSchema,
  runnerCommandResultSchema,
  runnerResultAckSchema,
  runnerCancelSchema,
  runnerErrorSchema,
]);
export type WorkflowRunnerServerMessage = z.infer<typeof workflowRunnerServerMessageSchema>;

const runnerRegisterSchema = z.object({
  type: z.literal("workflow-runner:register"),
  ...envelope,
  payload: z.object({
    ...attemptIdentity,
    protocolVersion: z.string().min(1),
    appVersion: z.string().min(1),
    needsJob: z.boolean(),
  }),
});

const runnerHeartbeatSchema = z.object({
  type: z.literal("workflow-runner:heartbeat"),
  ...envelope,
  payload: z.object(attemptIdentity),
});

const setStateCommandSchema = z.object({
  type: z.literal("set-state"),
  patch: runnerStatePatchSchema,
  humanMessage: z.string().min(1).max(WORKFLOW_RUNNER_HUMAN_MESSAGE_MAX_CHARS),
});

const handOffChildCommandSchema = z.object({
  type: z.literal("hand-off-child"),
  workflowName: WorkflowNameSchema,
  target: targetSchema,
  parentStepIndex: z.number().int().nonnegative(),
  state: runnerStatePatchSchema,
  humanMessage: z.string().min(1).max(WORKFLOW_RUNNER_HUMAN_MESSAGE_MAX_CHARS),
});

export const WorkflowRunnerCommandSchema = z
  .discriminatedUnion("type", [setStateCommandSchema, handOffChildCommandSchema])
  .refine(fitsWorkflowRunnerMessageBudget, "workflow runner command exceeds byte budget");
export type WorkflowRunnerCommand = z.infer<typeof WorkflowRunnerCommandSchema>;

const runnerCommandSchema = z.object({
  type: z.literal("workflow-runner:command"),
  ...envelope,
  payload: z.object({
    ...attemptIdentity,
    command: WorkflowRunnerCommandSchema,
  }),
});

export const WorkflowRunnerResultPayloadSchema = z
  .object({
    ...attemptIdentity,
    result: HandlerResultSchema,
    durationMs: z.number().int().nonnegative(),
  })
  .refine(
    (value) => !containsControllerReservedState(value.result.state),
    "workflow runner result state contains a controller-reserved key",
  )
  .refine(fitsWorkflowRunnerMessageBudget, "workflow runner result exceeds byte budget");
export type WorkflowRunnerResultPayload = z.infer<typeof WorkflowRunnerResultPayloadSchema>;

const runnerResultSchema = z.object({
  type: z.literal("workflow-runner:result"),
  ...envelope,
  payload: WorkflowRunnerResultPayloadSchema,
});

export const workflowRunnerClientMessageSchema = z.discriminatedUnion("type", [
  runnerRegisterSchema,
  runnerHeartbeatSchema,
  runnerCommandSchema,
  runnerResultSchema,
]);
export type WorkflowRunnerClientMessage = z.infer<typeof workflowRunnerClientMessageSchema>;

export type WorkflowRunnerRegisteredMessage = z.infer<typeof runnerRegisteredSchema>;
export type WorkflowRunnerCommandResultMessage = z.infer<typeof runnerCommandResultSchema>;
export type WorkflowRunnerResultMessage = z.infer<typeof runnerResultSchema>;

export const WORKFLOW_RUNNER_PROTOCOL_VERSION = "1.1.0";
