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
