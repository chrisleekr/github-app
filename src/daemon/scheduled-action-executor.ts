/**
 * Daemon-side executor for `scheduled-action` jobs (the `.github-app.yaml`
 * scheduled-actions feature).
 *
 * Unlike the legacy `runPipeline`, a scheduled action has no PR/issue entity
 * and no tracking comment: it is a single agent session driven entirely by a
 * skill-like prompt resolved upstream by the scheduler. This executor is the
 * thin path: clone the default branch, run the agent, clean up.
 *
 * The agent does all the work the prompt describes (pick an issue, triage,
 * label, open a PR, etc.); the orchestrator stays dumb. When the action's
 * `auto_merge` is effective, the read-only `merge_readiness` MCP tool is
 * exposed so the prompt can gate a merge on the deterministic verdict.
 */

import { Octokit } from "octokit";

import { checkoutRepo } from "../core/checkout";
import { executeAgent } from "../core/executor";
import { logger } from "../logger";
import { resolveMcpServers } from "../mcp/registry";
import type { BotContext } from "../types";

/** Read-only github-state tools, mirrors the set wired in `pipeline.ts`. */
const GITHUB_STATE_TOOLS = [
  "mcp__github_state__get_pr_state_check_rollup",
  "mcp__github_state__get_check_run_output",
  "mcp__github_state__get_workflow_run",
  "mcp__github_state__get_branch_protection",
  "mcp__github_state__get_pr_diff",
  "mcp__github_state__get_pr_files",
  "mcp__github_state__list_pr_comments",
];

const MERGE_READINESS_TOOL = "mcp__merge_readiness__check_merge_readiness";

/** Safe read-only default when an action declares no `allowed_tools`. */
const DEFAULT_ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Bash(git log:*)",
  "Bash(git status:*)",
  "Bash(git diff:*)",
];

export interface ScheduledActionExecutorInput {
  readonly installationToken: string;
  readonly owner: string;
  readonly repo: string;
  readonly actionName: string;
  readonly deliveryId: string;
  readonly promptText: string;
  readonly model?: string;
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  readonly allowedTools?: string[];
  /** Effective auto-merge (per-action flag already AND-ed with the env kill-switch). */
  readonly autoMerge: boolean;
  /** Cancellation signal from the daemon job lifecycle. */
  readonly signal: AbortSignal;
}

export interface ScheduledActionOutcome {
  readonly status: "succeeded" | "failed" | "halted";
  /** Short structured outcome tag for operator logs. */
  readonly outcome?: string;
  readonly reason?: string;
}

/**
 * Run one scheduled action as a single agent session. Errors are caught and
 * mapped to a `failed` outcome: `runScopedJob` reports it to the orchestrator.
 */
export async function executeScheduledAction(
  input: ScheduledActionExecutorInput,
): Promise<ScheduledActionOutcome> {
  const log = logger.child({
    component: "daemon.scheduled-action",
    owner: input.owner,
    repo: input.repo,
    action: input.actionName,
  });

  const octokit = new Octokit({ auth: input.installationToken });

  // Resolve the default branch: the scheduler does not carry it.
  let defaultBranch: string;
  try {
    const repoRes = await octokit.rest.repos.get({ owner: input.owner, repo: input.repo });
    defaultBranch = repoRes.data.default_branch;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error({ event: "scheduler.action.daemon.failed", reason }, "repo lookup failed");
    return { status: "failed", reason: `repo lookup failed: ${reason}` };
  }

  // Synthetic, entity-free BotContext. `eventName` uses the conventional
  // "issue_comment" sentinel for non-comment runs (see execution-row.ts).
  const ctx: BotContext = {
    owner: input.owner,
    repo: input.repo,
    entityNumber: 0,
    isPR: false,
    eventName: "issue_comment",
    triggerUsername: "scheduler",
    triggerTimestamp: new Date().toISOString(),
    triggerBody: "",
    commentId: 0,
    deliveryId: input.deliveryId,
    defaultBranch,
    labels: [],
    skipTrackingComments: true,
    octokit,
    log,
  };

  const { workDir, cleanup } = await checkoutRepo(ctx, input.installationToken);
  try {
    // No tracking comment (trackingCommentId undefined), no repo_memory
    // (workDir omitted), scheduled actions are stateless one-shots.
    // `github_state` is read-only and useful; `merge_readiness` only when
    // auto-merge is effective.
    const mcpServers = resolveMcpServers(ctx, undefined, input.installationToken, {
      enableGithubState: true,
      ...(input.autoMerge ? { enableMergeReadiness: true } : {}),
    });

    // A per-action `allowed_tools` is authoritative: it is NOT widened with
    // the read-only github_state set, so an action declaring a narrow
    // allowlist keeps least privilege. github_state is added only to the
    // implicit default set. `merge_readiness` is provisioned whenever
    // auto-merge is effective, the documented contract for `auto_merge: true`.
    const baseTools = input.allowedTools ?? [...DEFAULT_ALLOWED_TOOLS, ...GITHUB_STATE_TOOLS];
    const allowedTools = [
      ...new Set([...baseTools, ...(input.autoMerge ? [MERGE_READINESS_TOOL] : [])]),
    ];

    // Per-action timeout fires via a combined signal; `executeAgent` also
    // bounds the run by `config.agentTimeoutMs`, so whichever is shorter wins.
    const signal =
      input.timeoutMs !== undefined
        ? AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs)])
        : input.signal;

    log.info(
      { event: "scheduler.action.daemon.started", autoMerge: input.autoMerge, model: input.model },
      "scheduled action started",
    );

    const result = await executeAgent({
      ctx,
      prompt: input.promptText,
      mcpServers,
      workDir,
      allowedTools,
      installationToken: input.installationToken,
      signal,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
    });

    log.info(
      {
        event: "scheduler.action.daemon.completed",
        success: result.success,
        costUsd: result.costUsd,
        numTurns: result.numTurns,
      },
      "scheduled action finished",
    );

    if (result.success) {
      return { status: "succeeded", outcome: "completed" };
    }
    return {
      status: "failed",
      outcome: "agent_error",
      ...(result.errorMessage !== undefined ? { reason: result.errorMessage } : {}),
    };
  } finally {
    try {
      await cleanup();
    } catch (cleanupErr) {
      log.error({ err: cleanupErr }, "scheduled action workspace cleanup failed");
    }
  }
}
