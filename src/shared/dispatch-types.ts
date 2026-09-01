import { z } from "zod";

/**
 * DispatchTarget records the execution protocol selected for an execution.
 * Shared jobs use the daemon WebSocket; structured workflows use one isolated
 * workflow-runner Pod.
 *
 * The Postgres `executions.dispatch_target` and `triage_results.mode` CHECK
 * constraints mirror this list (see migration `017_workflow_run_leases.sql`).
 */
export const DISPATCH_TARGETS = ["daemon", "workflow-runner"] as const;

export type DispatchTarget = (typeof DISPATCH_TARGETS)[number];

/**
 * TriggerEventType: the GitHub webhook event class for the user comment that
 * started a workflow run. Drives which Octokit reactions endpoint is used
 * downstream (`createForIssueComment` vs `createForPullRequestReviewComment`).
 *
 * Persisted on `workflow_runs.trigger_event_type` and `executions.trigger_event_type`
 * (see migration `007_trigger_comment.sql`). NULL on label-triggered runs.
 *
 * Single source of truth: `dispatcher.ts`, `runs-store.ts`, `execution-row.ts`,
 * and `utils/reactions.ts` import from here so the union can't silently drift.
 */
export type TriggerEventType = "issue_comment" | "pull_request_review_comment";

export const DispatchTargetSchema = z.enum(DISPATCH_TARGETS);

/**
 * Type guard: narrows an unknown value to DispatchTarget.
 */
export function isDispatchTarget(value: unknown): value is DispatchTarget {
  return typeof value === "string" && (DISPATCH_TARGETS as readonly string[]).includes(value);
}

/**
 * DispatchReason: why the orchestrator routed the job the way it did. Answers
 * the operator question "did this job go to an existing persistent daemon, or
 * did we spin up an ephemeral one (and why)?"
 *
 * Meaning of each value:
 *   persistent-daemon        : routed to an existing persistent daemon (default path)
 *   ephemeral-daemon-triage  : triage flagged the request as heavy, ephemeral daemon spawned
 *   ephemeral-daemon-overflow: persistent queue at/above threshold, ephemeral daemon spawned
 *   ephemeral-spawn-failed   : spawn was required but the K8s API call failed
 *   workflow-runner          : structured workflow claimed by an isolated runner Pod
 */
export const DISPATCH_REASONS = [
  "persistent-daemon",
  "ephemeral-daemon-triage",
  "ephemeral-daemon-overflow",
  "ephemeral-spawn-failed",
  "workflow-runner",
] as const;

export type DispatchReason = (typeof DISPATCH_REASONS)[number];

export const DispatchReasonSchema = z.enum(DISPATCH_REASONS);

export function isDispatchReason(value: unknown): value is DispatchReason {
  return typeof value === "string" && (DISPATCH_REASONS as readonly string[]).includes(value);
}
