import type { Octokit } from "octokit";
import type pino from "pino";
import { z } from "zod";

import type { ReviewLearningPayload } from "../mcp/registry";
import { handler as implementHandler } from "./handlers/implement";
import { handler as planHandler } from "./handlers/plan";
import { handler as resolveHandler } from "./handlers/resolve";
import { handler as reviewHandler } from "./handlers/review";
import { handler as shipHandler } from "./handlers/ship";
import { handler as triageHandler } from "./handlers/triage";

export const WorkflowNameSchema = z.enum([
  "triage",
  "plan",
  "implement",
  "review",
  "resolve",
  "ship",
]);
export type WorkflowName = z.infer<typeof WorkflowNameSchema>;

export const WorkflowContextSchema = z.enum(["issue", "pr", "both"]);
export type WorkflowContext = z.infer<typeof WorkflowContextSchema>;

/**
 * `humanMessage` lets the handler supply the exact body the executor should
 * render into the tracking comment alongside the terminal status header.
 * When omitted, the executor falls back to a generic "<workflow> <status>"
 * line. Handlers that already wrote a rich message via `ctx.setState` during
 * execution should repeat it here so the final replace-write preserves it.
 *
 * `handed-off` is the composite-workflow variant: the handler inserted and
 * enqueued a child run and wants the parent row to stay `running` until the
 * last child completes (FR-006, handoff-protocol.md §Parent status). The
 * executor merges `state` into the parent's row but does NOT transition the
 * parent's `status`: the orchestrator's cascade does that on the final
 * child's completion.
 *
 * `incomplete` is the "agent ran cleanly but work remains" terminal state
 * (issue #93). The pipeline returned `success: true`, but a handler-side
 * post-execution gate (e.g., the `resolve` handler's CI re-check) found
 * surviving failures: typically when the agent hit `FIX_ATTEMPTS_CAP=3`
 * with red CI. Distinct from `failed` so downstream surfaces can tell a
 * clean-run-but-blocked outcome from a true pipeline error.
 */
/**
 * Review-learning IDs the review/resolve handler's runPipeline actually
 * applied to the prompt (post file-glob filter). Forwarded by workflow-
 * executor.ts into the `job:result` payload's `appliedReviewLearningIds`
 * field so the orchestrator can bump `use_count` + `last_used_at`. Only
 * `review` and `resolve` populate this; other handlers leave it omitted.
 */
const appliedReviewLearningIdsField = z.array(z.string().max(64)).max(50).optional();

export const HandlerResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("succeeded"),
    state: z.unknown(),
    humanMessage: z.string().min(1).optional(),
    appliedReviewLearningIds: appliedReviewLearningIdsField,
  }),
  z.object({
    status: z.literal("failed"),
    reason: z.string().min(1),
    state: z.unknown().optional(),
    humanMessage: z.string().min(1).optional(),
  }),
  z.object({
    status: z.literal("incomplete"),
    reason: z.string().min(1),
    state: z.unknown().optional(),
    humanMessage: z.string().min(1).optional(),
    appliedReviewLearningIds: appliedReviewLearningIdsField,
  }),
  z.object({
    status: z.literal("handed-off"),
    state: z.unknown().optional(),
    humanMessage: z.string().min(1).optional(),
    childRunId: z.string().min(1),
  }),
]);
export type HandlerResult = z.infer<typeof HandlerResultSchema>;

export interface WorkflowRunContext {
  readonly runId: string;
  readonly workflowName: WorkflowName;
  readonly target: {
    readonly type: "issue" | "pr";
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
  };
  readonly parent?: {
    readonly runId: string;
    readonly stepIndex: number;
  };
  readonly logger: pino.Logger;
  readonly octokit: Octokit;
  readonly deliveryId: string | null;
  /**
   * Identifier of the daemon process executing this run. Handlers writing
   * new `workflow_runs` rows from inside the daemon (e.g., the `ship`
   * composite spawning child runs) must set `owner_kind='daemon',
   * owner_id=daemonId` so the liveness reaper can detect inserter death
   * before the row reaches a downstream handler.
   */
  readonly daemonId: string;
  /**
   * Orchestrator pre-loaded review learnings for this job, when any. Only the
   * `review` and `resolve` handlers read this and forward to `runPipeline`
   * via `enableReviewLearnings: true`. Other workflows ignore. Mirrors the
   * `BotContext.reviewLearnings` shape so the workflow-dispatch path threads
   * through the same data the direct-pipeline path receives. Undefined when
   * the orchestrator's load returned zero rows.
   */
  readonly reviewLearnings?: ReviewLearningPayload[];
  readonly setState: (state: unknown, humanMessage: string) => Promise<void>;
}

export type WorkflowHandler = (ctx: WorkflowRunContext) => Promise<HandlerResult>;

export const RegistryEntrySchema = z.object({
  name: WorkflowNameSchema,
  label: z.string().regex(/^bot:[a-z]+$/),
  context: WorkflowContextSchema,
  requiresPrior: WorkflowNameSchema.nullable(),
  steps: z.array(WorkflowNameSchema),
  handler: z.custom<WorkflowHandler>((v) => typeof v === "function", {
    message: "handler must be a function reference",
  }),
});
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

export const RegistrySchema = z
  .array(RegistryEntrySchema)
  .refine((entries) => new Set(entries.map((e) => e.name)).size === entries.length, {
    message: "workflow names must be unique",
  })
  .refine((entries) => new Set(entries.map((e) => e.label)).size === entries.length, {
    message: "labels must be unique",
  })
  .refine(
    (entries) => {
      const names = new Set(entries.map((e) => e.name));
      return entries.every((e) => e.steps.every((s) => names.has(s)));
    },
    { message: "every step must reference an existing workflow name" },
  )
  .refine((entries) => entries.every((e) => e.steps.length === 0 || e.requiresPrior === null), {
    message: "composite workflows (non-empty steps) must have requiresPrior === null",
  });
export type Registry = z.infer<typeof RegistrySchema>;

/**
 * The sole authoritative list of bot workflows. FR-023: no other module may
 * hard-code workflow names. Adding a workflow is one entry here plus one
 * handler file plus one docs section (FR-024). Parsed at module load so a
 * mistyped entry fails the process at boot, not mid-flight.
 */
const rawRegistry: RegistryEntry[] = [
  {
    name: "triage",
    label: "bot:triage",
    context: "issue",
    requiresPrior: null,
    steps: [],
    handler: triageHandler,
  },
  {
    name: "plan",
    label: "bot:plan",
    context: "issue",
    requiresPrior: "triage",
    steps: [],
    handler: planHandler,
  },
  {
    name: "implement",
    label: "bot:implement",
    context: "issue",
    requiresPrior: "plan",
    steps: [],
    handler: implementHandler,
  },
  {
    name: "review",
    label: "bot:review",
    context: "pr",
    requiresPrior: null,
    steps: [],
    handler: reviewHandler,
  },
  {
    name: "resolve",
    label: "bot:resolve",
    context: "pr",
    requiresPrior: null,
    steps: [],
    handler: resolveHandler,
  },
  {
    name: "ship",
    label: "bot:ship",
    context: "issue",
    requiresPrior: null,
    steps: ["triage", "plan", "implement", "review", "resolve"],
    handler: shipHandler,
  },
];

export const registry: Registry = RegistrySchema.parse(rawRegistry);

export function getByName(name: WorkflowName): RegistryEntry {
  const entry = registry.find((e) => e.name === name);
  if (entry === undefined) {
    throw new Error(`Workflow registry entry not found: ${name}`);
  }
  return entry;
}

export function getByLabel(label: string): RegistryEntry | undefined {
  return registry.find((e) => e.label === label);
}
