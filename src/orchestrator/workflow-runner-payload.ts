import { App, type Octokit } from "octokit";

import { config } from "../config";
import { requireDb } from "../db";
import { logger } from "../logger";
import { loadRepoPolicy, policyForWorkflow, toAgentPolicy } from "../repo-config/effective";
import type { SerializableBotContext } from "../shared/daemon-types";
import type { WorkflowRunnerPayload } from "../shared/workflow-runner-messages";
import {
  RepoMemoryEntrySchema,
  type WorkflowName,
  type WorkflowRunSnapshot,
} from "../shared/workflow-types";
import type { AgentPolicy } from "../shared/ws-messages";
import {
  findLatestForTarget,
  findLatestSucceededForTarget,
  mergeAttemptState,
} from "../workflows/runs-store";
import { CONFIG_NOTICE_KEY } from "../workflows/tracking-mirror";
import { mintInstallationToken, revokeInstallationToken } from "./installation-token";
import { getRepoMemory } from "./repo-knowledge";
import {
  loadReviewLearnings,
  type ReviewLearning,
  searchReviewLearningsByEmbedding,
} from "./review-learnings";
import type { WorkflowRunnerAttempt } from "./workflow-runner-store";

let runnerApp: InstanceType<typeof App> | null = null;
export const GITHUB_INSTALLATION_TOKEN_LIFETIME_MS = 60 * 60 * 1_000;

function getRunnerApp(): InstanceType<typeof App> {
  if (runnerApp !== null) return runnerApp;
  if (config.appId === undefined || config.privateKey === undefined) {
    throw new Error("Workflow runners require GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY");
  }
  runnerApp = new App({ appId: config.appId, privateKey: config.privateKey });
  return runnerApp;
}

function stripInstructionsUnlessReview(
  policy: AgentPolicy | undefined,
  workflowName: WorkflowName,
): AgentPolicy | undefined {
  if (policy?.instructions === undefined || workflowName === "review") return policy;
  const { instructions: _dropped, ...rest } = policy;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

async function loadExecutionContext(
  attempt: WorkflowRunnerAttempt,
): Promise<SerializableBotContext> {
  const db = requireDb();
  const rows: { context_json: Record<string, unknown> | null }[] = await db`
    SELECT context_json
      FROM executions
     WHERE delivery_id = ${attempt.executionDeliveryId}
       AND daemon_id = ${attempt.runnerId}
       AND offer_id = ${attempt.attemptId}
       AND status = 'running'
  `;
  const context = rows[0]?.context_json;
  if (context === null || context === undefined) {
    throw new Error("Workflow runner execution context is missing");
  }
  return context as unknown as SerializableBotContext;
}

async function mintWorkflowRunnerRepositoryToken(attempt: WorkflowRunnerAttempt): Promise<{
  readonly context: SerializableBotContext;
  readonly octokit: Octokit;
  readonly token: string;
  readonly expiresAt: string;
}> {
  const context = await loadExecutionContext(attempt);
  const app = getRunnerApp();
  const { data: installation } = await app.octokit.rest.apps.getRepoInstallation({
    owner: context.owner,
    repo: context.repo,
  });
  const minted = await mintInstallationToken({
    app,
    installationId: installation.id,
    repositoryName: context.repo,
    via: "workflowRunnerPayload",
    log: logger,
  });
  return { context, ...minted };
}

/** Mint controller-only repository authority for a credential-free runner reconnect. */
export async function prepareWorkflowRunnerControllerOctokit(
  attempt: WorkflowRunnerAttempt,
): Promise<Octokit> {
  if (config.githubPersonalAccessToken !== undefined) {
    throw new Error("Workflow runners do not support GITHUB_PERSONAL_ACCESS_TOKEN mode");
  }
  return (await mintWorkflowRunnerRepositoryToken(attempt)).octokit;
}

async function loadRunnerReviewLearnings(
  octokit: Octokit,
  context: SerializableBotContext,
  policy: Awaited<ReturnType<typeof loadRepoPolicy>>,
): Promise<ReviewLearning[]> {
  if (!config.reviewLearningsEnabled || !policy.reviewLearnings.enabled) return [];
  const filter = {
    scope: policy.reviewLearnings.scope,
    maxAgeDays: policy.reviewLearnings.max_age_days,
  } as const;
  if (!config.reviewLearningsRagEnabled || !context.isPR) {
    return loadReviewLearnings(context.owner, context.repo, filter);
  }
  try {
    const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner: context.owner,
      repo: context.repo,
      pull_number: context.entityNumber,
      per_page: 100,
    });
    return await searchReviewLearningsByEmbedding(
      context.owner,
      context.repo,
      files.map((file) => file.filename),
      { filter },
    );
  } catch (err) {
    logger.warn(
      { err, owner: context.owner, repo: context.repo, number: context.entityNumber },
      "Workflow runner RAG load failed; falling back to deterministic review learnings",
    );
    return loadReviewLearnings(context.owner, context.repo, filter);
  }
}

function snapshot(
  workflowName: WorkflowName,
  row: Awaited<ReturnType<typeof findLatestForTarget>>,
): WorkflowRunSnapshot | null {
  if (row === null) return null;
  const state: WorkflowRunSnapshot["state"] = {};
  if (
    workflowName === "triage" &&
    (row.state["recommendedNext"] === "plan" || row.state["recommendedNext"] === "stop")
  ) {
    state.recommendedNext = row.state["recommendedNext"];
  }
  if (
    workflowName === "implement" &&
    typeof row.state["pr_number"] === "number" &&
    Number.isInteger(row.state["pr_number"]) &&
    row.state["pr_number"] > 0
  ) {
    state.pr_number = row.state["pr_number"];
  }
  return {
    id: row.id,
    status: row.status,
    state,
    createdAt: row.created_at.toISOString(),
  };
}

async function loadPriorState(
  workflowName: WorkflowName,
  context: SerializableBotContext,
): Promise<Pick<WorkflowRunnerPayload, "priorPlanState" | "shipStepRuns">> {
  const target = { owner: context.owner, repo: context.repo, number: context.entityNumber };
  if (workflowName === "implement") {
    const plan = await findLatestSucceededForTarget("plan", target);
    const markdown = plan?.state["plan"];
    if (plan === null) return {};
    if (typeof markdown !== "string" || markdown.length === 0 || markdown.length > 100_000) {
      throw new Error("Succeeded plan state is missing or exceeds the runner payload limit");
    }
    return { priorPlanState: { plan: markdown } };
  }
  if (workflowName !== "ship") return {};

  const names = ["triage", "plan", "implement", "review", "resolve"] as const;
  const rows = await Promise.all(names.map((name) => findLatestForTarget(name, target)));
  const shipStepRuns: Partial<Record<WorkflowName, WorkflowRunSnapshot>> = {};
  for (const [index, name] of names.entries()) {
    const row = snapshot(name, rows[index] ?? null);
    if (row !== null) shipStepRuns[name] = row;
  }
  return { shipStepRuns };
}

function configNotice(policy: AgentPolicy | undefined): string | null {
  const lines: string[] = [];
  if (policy?.warning !== undefined && policy.warning.trim() !== "") lines.push(policy.warning);
  if (policy?.pathFilters !== undefined && policy.pathFilters.length > 0) {
    const globs = policy.pathFilters.map((glob) => `\`${glob}\``).join(", ");
    lines.push(
      `Review scope reduced by \`${config.repoConfigFile}\`: files matching ${globs} are excluded.`,
    );
  }
  return lines.length === 0 ? null : lines.join("\n");
}

async function loadRunnerRepoMemory(
  owner: string,
  repo: string,
): Promise<NonNullable<WorkflowRunnerPayload["repoMemory"]>> {
  const rows = await getRepoMemory(owner, repo);
  const valid: NonNullable<WorkflowRunnerPayload["repoMemory"]> = [];
  let dropped = 0;
  let omitted = 0;
  for (const row of rows) {
    const parsed = RepoMemoryEntrySchema.safeParse(row);
    if (!parsed.success) {
      dropped++;
    } else if (valid.length < 50) {
      valid.push(parsed.data);
    } else {
      omitted++;
    }
  }
  if (dropped > 0 || omitted > 0) {
    logger.warn(
      { owner, repo, dropped, omitted },
      "Filtered invalid or excess workflow runner repo memory",
    );
  }
  return valid;
}

/** Build the only payload an isolated workflow runner receives. */
export async function prepareWorkflowRunnerPayload(
  attempt: WorkflowRunnerAttempt,
): Promise<WorkflowRunnerPayload> {
  if (config.githubPersonalAccessToken !== undefined) {
    throw new Error("Workflow runners do not support GITHUB_PERSONAL_ACCESS_TOKEN mode");
  }

  if (attempt.attemptDeadlineAt.getTime() - Date.now() <= GITHUB_INSTALLATION_TOKEN_LIFETIME_MS) {
    throw new Error("Workflow runner attempt has insufficient lifetime for a GitHub token");
  }

  const { context, octokit, token, expiresAt } = await mintWorkflowRunnerRepositoryToken(attempt);
  try {
    if (new Date(expiresAt).getTime() > attempt.attemptDeadlineAt.getTime()) {
      throw new Error("GitHub token expiry exceeds the workflow runner attempt deadline");
    }
    const repoPolicy = await loadRepoPolicy({
      octokit,
      owner: context.owner,
      repo: context.repo,
      log: logger,
    });
    const workflowPolicy = policyForWorkflow(repoPolicy, attempt.workflowName);
    const policy = stripInstructionsUnlessReview(
      toAgentPolicy(workflowPolicy, repoPolicy.warning),
      attempt.workflowName,
    );
    const maxTurns = workflowPolicy.maxTurns ?? config.agentMaxTurns ?? config.defaultMaxTurns;
    if (policy !== undefined || workflowPolicy.maxTurns !== undefined) {
      logger.info(
        {
          event: "repo_config.policy_applied",
          owner: context.owner,
          repo: context.repo,
          deliveryId: attempt.executionDeliveryId,
          workflow: attempt.workflowName,
          runId: attempt.runId,
          attemptId: attempt.attemptId,
          model: policy?.model,
          maxTurns,
          timeoutMs: policy?.timeoutMs,
          extraAllowedToolCount: policy?.extraAllowedTools?.length ?? 0,
          pathFilterCount: policy?.pathFilters?.length ?? 0,
          hasInstructions: policy?.instructions !== undefined,
          warned: policy?.warning !== undefined,
        },
        "Per-repo agent policy applied",
      );
    }
    const [reviewLearnings, repoMemory, priorState] = await Promise.all([
      loadRunnerReviewLearnings(octokit, context, repoPolicy),
      loadRunnerRepoMemory(context.owner, context.repo),
      loadPriorState(attempt.workflowName, context),
    ]);

    const notice = configNotice(policy);
    if (notice !== null) {
      await mergeAttemptState(
        { runId: attempt.runId, attemptId: attempt.attemptId },
        { [CONFIG_NOTICE_KEY]: notice },
      );
    }

    return {
      context: context as unknown as WorkflowRunnerPayload["context"],
      installationToken: token,
      installationTokenExpiresAt: expiresAt,
      attemptDeadlineAt: attempt.attemptDeadlineAt.toISOString(),
      ...(repoMemory.length > 0 ? { repoMemory } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(reviewLearnings.length > 0
        ? {
            reviewLearnings: reviewLearnings.map((learning) => ({
              id: learning.id,
              scope: learning.scope,
              fileGlob: learning.fileGlob,
              directive: learning.directive,
              rationale: learning.rationale,
              sourcePr: learning.sourcePr,
              sourceThread: learning.sourceThread,
              sourceAuthor: learning.sourceAuthor,
              createdAt: learning.createdAt.toISOString(),
            })),
          }
        : {}),
      ...(policy !== undefined ? { policy } : {}),
      workflowRun: {
        runId: attempt.runId,
        workflowName: attempt.workflowName,
      },
      ...priorState,
    };
  } catch (err) {
    await revokeInstallationToken(octokit, logger, {
      attemptId: attempt.attemptId,
      owner: "payload-preparation",
    });
    throw err;
  }
}
