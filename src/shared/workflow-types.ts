/**
 * Dependency-light workflow contract for daemon and orchestrator modules
 * that must stay decoupled from the in-process registry constant.
 *
 * Those modules need the type shapes but MUST NOT import the parsed
 * registry itself, because importing `../workflows/registry` pulls in
 * every handler's transitive dependency graph (git CLI, MCP servers,
 * etc.) and that breaks dependency layering.
 */

import { z } from "zod";

export const WORKFLOW_NAMES = [
  "triage",
  "plan",
  "implement",
  "review",
  "resolve",
  "ship",
  "remember",
] as const;

export const WorkflowNameSchema = z.enum(WORKFLOW_NAMES);
export type WorkflowName = z.infer<typeof WorkflowNameSchema>;

export const RepoMemoryCategorySchema = z.enum([
  "setup",
  "architecture",
  "conventions",
  "env",
  "gotchas",
]);
export const RepoMemoryEntrySchema = z.object({
  id: z.uuid(),
  category: RepoMemoryCategorySchema,
  content: z.string().min(1).max(1000),
  pinned: z.boolean(),
});
export type RepoMemoryEntry = z.infer<typeof RepoMemoryEntrySchema>;

const reviewLearningActionSaveSchema = z.object({
  directive: z.string().min(1).max(2000),
  rationale: z.string().max(2000).optional(),
  fileGlob: z.string().max(500).optional(),
  scope: z.enum(["local", "global"]).optional(),
  sourcePr: z.number().int().positive().optional(),
  sourceThread: z.string().max(200).optional(),
  sourceAuthor: z.string().max(100).optional(),
});

export const DaemonActionsSchema = z.object({
  learnings: z
    .array(
      z.object({
        category: RepoMemoryCategorySchema,
        content: z.string().min(1).max(1000),
      }),
    )
    .max(50),
  deletions: z.array(z.uuid().max(64)).max(50),
  reviewLearningSaves: z.array(reviewLearningActionSaveSchema).max(50).optional(),
  reviewLearningDeletes: z.array(z.uuid().max(64)).max(50).optional(),
});
export type DaemonActions = z.infer<typeof DaemonActionsSchema>;

const appliedReviewLearningIdsField = z.array(z.string().max(64)).max(50).optional();
const daemonActionsField = DaemonActionsSchema.optional();
export const WORKFLOW_RUNNER_HUMAN_MESSAGE_MAX_CHARS = 50_000;
const boundedHumanMessage = z
  .string()
  .min(1)
  .max(WORKFLOW_RUNNER_HUMAN_MESSAGE_MAX_CHARS)
  .optional();
const boundedFailureReason = z.string().min(1).max(WORKFLOW_RUNNER_HUMAN_MESSAGE_MAX_CHARS);

/** Result returned by one workflow handler before controller-side settlement. */
export const HandlerResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("succeeded"),
    state: z.unknown(),
    humanMessage: boundedHumanMessage,
    appliedReviewLearningIds: appliedReviewLearningIdsField,
    daemonActions: daemonActionsField,
  }),
  z.object({
    status: z.literal("failed"),
    reason: boundedFailureReason,
    state: z.unknown().optional(),
    humanMessage: boundedHumanMessage,
    daemonActions: daemonActionsField,
  }),
  z.object({
    status: z.literal("incomplete"),
    reason: boundedFailureReason,
    state: z.unknown().optional(),
    humanMessage: boundedHumanMessage,
    appliedReviewLearningIds: appliedReviewLearningIdsField,
    daemonActions: daemonActionsField,
  }),
  z.object({
    status: z.literal("handed-off"),
    state: z.unknown().optional(),
    humanMessage: boundedHumanMessage,
    childRunId: z.string().min(1),
    daemonActions: z.never().optional(),
  }),
]);
export type HandlerResult = z.infer<typeof HandlerResultSchema>;

export const PriorPlanStateSchema = z.object({
  plan: z.string().min(1).max(100_000),
});
export type PriorPlanState = z.infer<typeof PriorPlanStateSchema>;

const WorkflowRunSnapshotStateSchema = z.object({
  recommendedNext: z.enum(["plan", "stop"]).optional(),
  pr_number: z.number().int().positive().optional(),
});

/** Bounded workflow history projected into a single-attempt runner payload. */
export const WorkflowRunSnapshotSchema = z.object({
  id: z.uuid(),
  status: z.enum(["queued", "running", "succeeded", "failed", "incomplete"]),
  state: WorkflowRunSnapshotStateSchema,
  createdAt: z.iso.datetime(),
});
export type WorkflowRunSnapshot = z.infer<typeof WorkflowRunSnapshotSchema>;

export function workflowRunnerId(attemptId: string): string {
  return `workflow-runner:${attemptId}`;
}

export type {
  Registry,
  RegistryEntry,
  WorkflowContext,
  WorkflowHandler,
  WorkflowRunContext,
} from "../workflows/registry";

/**
 * Reference to a `workflow_runs` row in an isolated runner payload.
 *
 * **`workflow_runs.state.shipIntentId` convention** (ship-iteration-wiring):
 * When a ship-driven iteration inserts a `workflow_runs` row, it MUST embed
 * `{ shipIntentId: <uuid> }` inside the `state` JSONB column (the spec
 * calls this "context_json" generically; the actual column is `state`).
 * This is a JSON convention, not a column: it lets the orchestrator's
 * completion cascade (`onStepComplete` in `src/workflows/orchestrator.ts`)
 * early-wake the originating intent via `ZADD ship:tickle 0 <intent_id>`
 * without growing `WorkflowRunRef` itself. The runner does not need to
 * read `shipIntentId`: only the server-side cascade does.
 */
export const WorkflowRunRefSchema = z.object({
  runId: z.uuid(),
  workflowName: WorkflowNameSchema,
  parentRunId: z.uuid().optional(),
  parentStepIndex: z.number().int().nonnegative().optional(),
});
export type WorkflowRunRef = z.infer<typeof WorkflowRunRefSchema>;
