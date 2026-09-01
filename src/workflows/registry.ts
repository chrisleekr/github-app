import type { Octokit } from "octokit";
import type pino from "pino";
import { z } from "zod";

import type { ReviewLearningPayload } from "../mcp/registry";
import {
  type HandlerResult,
  type PriorPlanState,
  type RepoMemoryEntry,
  type WorkflowName,
  WorkflowNameSchema,
  type WorkflowRunSnapshot,
} from "../shared/workflow-types";
import type { AgentPolicy } from "../shared/ws-messages";
import { handler as implementHandler } from "./handlers/implement";
import { handler as planHandler } from "./handlers/plan";
import { handler as rememberHandler } from "./handlers/remember";
import { handler as resolveHandler } from "./handlers/resolve";
import { handler as reviewHandler } from "./handlers/review";
import { handler as shipHandler } from "./handlers/ship";
import { handler as triageHandler } from "./handlers/triage";

export { WorkflowNameSchema };
export { HandlerResultSchema } from "../shared/workflow-types";
export type { HandlerResult, WorkflowName };

export const WorkflowContextSchema = z.enum(["issue", "pr", "both"]);
export type WorkflowContext = z.infer<typeof WorkflowContextSchema>;

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
  /** Stable isolated-runner identity used for logs and execution context. */
  readonly daemonId: string;
  readonly signal?: AbortSignal;
  /** Commit a composite child and parent hand-off under this attempt's lease. */
  readonly handOffChild?: (input: {
    readonly workflowName: WorkflowName;
    readonly target: WorkflowRunContext["target"];
    readonly parentStepIndex: number;
    readonly state: Record<string, unknown>;
    readonly humanMessage: string;
  }) => Promise<{ childRunId: string }>;
  /**
   * Orchestrator pre-loaded review learnings for this job, when any. Only the
   * `review` and `resolve` handlers read this and forward to `runPipeline`
   * via `enableReviewLearnings: true`. Other workflows ignore. Mirrors the
   * `BotContext.reviewLearnings` shape so the workflow-dispatch path threads
   * through the same data the direct-pipeline path receives. Undefined when
   * the orchestrator's load returned zero rows.
   */
  readonly reviewLearnings?: ReviewLearningPayload[];
  /** Bounded repository hints loaded by the orchestrator. */
  readonly repoMemory?: RepoMemoryEntry[];
  /**
   * Per-repo agent policy from `.github-app.yaml` ("Gate 2"), already clamped
   * against the server ceilings by the orchestrator, and applied via
   * `applyAgentPolicy`. Undefined when the repo ships no config file.
   */
  readonly policy?: AgentPolicy;
  /**
   * Turn cap for this run, already resolved by the orchestrator as
   * `workflows.<name>.max_turns ?? AGENT_MAX_TURNS ?? DEFAULT_MAXTURNS` and
   * clamped against the server ceiling. Separate from `policy` because it
   * rides the isolated runner payload as the single source of truth.
   */
  readonly maxTurns?: number;
  /** Most recent succeeded plan, preloaded for the implement workflow. */
  readonly priorPlanState?: Readonly<PriorPlanState>;
  /** Latest row per ship step, preloaded so the runner never queries PostgreSQL. */
  readonly shipStepRuns?: Readonly<Partial<Record<WorkflowName, WorkflowRunSnapshot>>>;
  readonly setState: (
    state: unknown,
    humanMessage: string,
  ) => Promise<{ trackingCommentId?: number }>;
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
  {
    name: "remember",
    label: "bot:remember",
    context: "both",
    requiresPrior: null,
    steps: [],
    handler: rememberHandler,
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
