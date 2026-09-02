import { App, type Octokit } from "octokit";

import { config } from "../config";
import { requireDb } from "../db";
import { logger } from "../logger";
import { redactErrorMessageOrFallback } from "../utils/log-redaction";
import { addReaction } from "../utils/reactions";
import { ensureWorkflowCascadeForOffer } from "../workflows/completion-reconciler";
import {
  logWorkflowRunFailed,
  logWorkflowRunHandedOff,
  logWorkflowRunIncomplete,
  logWorkflowRunSucceeded,
} from "../workflows/log-fields";
import { findById } from "../workflows/runs-store";
import { setState } from "../workflows/tracking-mirror";
import { mintInstallationToken, revokeInstallationToken } from "./installation-token";
import { persistRepoKnowledge } from "./repo-knowledge-persistence";
import { cleanupCurrentWorkflowRunnerResources } from "./workflow-runner-resources";
import {
  findPendingWorkflowRunnerResults,
  getWorkflowRunnerResultProcessingState,
  markWorkflowRunnerResultProcessed,
  type PendingWorkflowRunnerResult,
} from "./workflow-runner-store";

let resultApp: InstanceType<typeof App> | null = null;
const resultChains = new Map<string, Promise<void>>();
const workflowProjectionChains = new Map<string, Promise<void>>();

function getResultApp(): InstanceType<typeof App> {
  if (resultApp !== null) return resultApp;
  if (config.appId === undefined || config.privateKey === undefined) {
    throw new Error("Workflow result reconciliation requires GitHub App credentials");
  }
  resultApp = new App({ appId: config.appId, privateKey: config.privateKey });
  return resultApp;
}

async function getResultOctokit(owner: string, repo: string): Promise<Octokit> {
  const app = getResultApp();
  const { data: installation } = await app.octokit.rest.apps.getRepoInstallation({ owner, repo });
  return (
    await mintInstallationToken({
      app,
      installationId: installation.id,
      repositoryName: repo,
      via: "workflowRunnerResult",
      log: logger,
    })
  ).octokit;
}

function terminalHumanMessage(
  workflowName: string,
  result: PendingWorkflowRunnerResult["payload"]["result"],
): string {
  if (result.humanMessage !== undefined) {
    return redactErrorMessageOrFallback(result.humanMessage, `${workflowName} completed`);
  }
  if (result.status === "succeeded") return `${workflowName} succeeded`;
  if (result.status === "incomplete") {
    return `${workflowName} incomplete, see tracking comment for outstanding items.`;
  }
  return `${workflowName} failed, see server logs for details.`;
}

function githubStatus(err: unknown): number | undefined {
  if (err === null || typeof err !== "object" || !("status" in err)) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

async function findProjectionRootId(
  row: NonNullable<Awaited<ReturnType<typeof findById>>>,
): Promise<string> {
  let current = row;
  const visited = new Set<string>();
  while (current.parent_run_id !== null) {
    if (visited.has(current.id)) {
      throw new Error(`Workflow parent cycle detected at ${current.id}`);
    }
    visited.add(current.id);
    // eslint-disable-next-line no-await-in-loop -- each read follows one durable parent edge
    const parent = await findById(current.parent_run_id);
    if (parent === null) {
      throw new Error(`Workflow parent is missing: ${current.parent_run_id}`);
    }
    current = parent;
  }
  return current.id;
}

async function serializeWorkflowProjection(
  row: NonNullable<Awaited<ReturnType<typeof findById>>>,
  project: () => Promise<void>,
): Promise<void> {
  const key = await findProjectionRootId(row);
  const prior = workflowProjectionChains.get(key) ?? Promise.resolve();
  const current = prior.catch(() => undefined).then(project);
  workflowProjectionChains.set(key, current);
  try {
    await current;
  } finally {
    if (workflowProjectionChains.get(key) === current) workflowProjectionChains.delete(key);
  }
}

async function projectTerminalState(
  row: NonNullable<Awaited<ReturnType<typeof findById>>>,
  pending: PendingWorkflowRunnerResult,
  octokit: Octokit,
): Promise<void> {
  try {
    await setState(
      { octokit, logger },
      {
        runId: pending.runId,
        patch: {},
        humanMessage: terminalHumanMessage(row.workflow_name, pending.payload.result),
      },
    );
  } catch (err) {
    if (githubStatus(err) !== 422) throw err;
    logger.warn(
      {
        event: "workflow_runner_terminal_projection_rejected",
        runId: pending.runId,
        attemptId: pending.attemptId,
        status: 422,
      },
      "GitHub rejected workflow terminal projection; retrying with fixed fallback",
    );
    await setState(
      { octokit, logger },
      {
        runId: pending.runId,
        patch: {},
        humanMessage: `${row.workflow_name} reached a terminal state, but GitHub rejected its detailed status. Inspect controller logs and durable workflow state.`,
      },
    );
  }
}

async function reactToTrigger(
  row: NonNullable<Awaited<ReturnType<typeof findById>>>,
  octokit: Octokit,
  success: boolean,
): Promise<void> {
  if (row.trigger_comment_id === null || row.trigger_event_type === null) return;
  await addReaction({
    octokit,
    logger,
    owner: row.target_owner,
    repo: row.target_repo,
    commentId: row.trigger_comment_id,
    eventType: row.trigger_event_type,
    content: success ? "hooray" : "confused",
  });
}

function logTerminalResult(
  row: NonNullable<Awaited<ReturnType<typeof findById>>>,
  pending: PendingWorkflowRunnerResult,
): void {
  const result = pending.payload.result;
  const fields = {
    runId: pending.runId,
    workflowName: row.workflow_name,
    target: {
      type: row.target_type,
      owner: row.target_owner,
      repo: row.target_repo,
      number: row.target_number,
    },
    deliveryId: pending.executionDeliveryId,
    durationMs: pending.payload.durationMs,
  };
  if (result.status === "succeeded") {
    logWorkflowRunSucceeded(logger, fields);
  } else if (result.status === "incomplete") {
    logWorkflowRunIncomplete(logger, { ...fields, reason: result.reason });
  } else if (result.status === "failed") {
    logWorkflowRunFailed(logger, { ...fields, reason: result.reason });
  } else {
    logWorkflowRunHandedOff(logger, { ...fields, childRunId: result.childRunId });
  }
}

async function projectWorkflowRunnerResult(
  pending: PendingWorkflowRunnerResult,
  suppliedOctokit?: Octokit,
): Promise<void> {
  const state = await getWorkflowRunnerResultProcessingState(pending);
  if (state === "processed") return;
  if (state === "missing") {
    throw new Error(`Workflow result is not durably stored: ${pending.attemptId}`);
  }

  const row = await findById(pending.runId);
  if (row?.attempt_id !== pending.attemptId) {
    throw new Error(`Workflow result row is no longer current: ${pending.attemptId}`);
  }
  const daemonActions =
    "daemonActions" in pending.payload.result ? pending.payload.result.daemonActions : undefined;
  const learningIds =
    "appliedReviewLearningIds" in pending.payload.result
      ? pending.payload.result.appliedReviewLearningIds
      : undefined;
  if (daemonActions !== undefined || (learningIds !== undefined && learningIds.length > 0)) {
    await persistRepoKnowledge({
      deliveryId: pending.executionDeliveryId,
      ...(daemonActions !== undefined ? { daemonActions } : {}),
      ...(learningIds !== undefined ? { appliedReviewLearningIds: learningIds } : {}),
    }).catch((err: unknown) => {
      logger.warn(
        { err, runId: pending.runId, attemptId: pending.attemptId },
        "Failed to persist workflow runner repo knowledge",
      );
    });
  }

  const ownsOctokit = suppliedOctokit === undefined;
  const octokit = suppliedOctokit ?? (await getResultOctokit(row.target_owner, row.target_repo));
  try {
    await serializeWorkflowProjection(row, async () => {
      await ensureWorkflowCascadeForOffer(pending.attemptId, logger, requireDb(), octokit);

      if (pending.payload.result.status === "handed-off") {
        const current = await findById(pending.runId);
        if (current?.attempt_id !== pending.attemptId) {
          throw new Error(`Workflow result row is no longer current: ${pending.attemptId}`);
        }
        if (current.status !== "running") return;
        await projectTerminalState(current, pending, octokit);
        return;
      }

      await projectTerminalState(row, pending, octokit);
    });

    if (pending.payload.result.status !== "handed-off") {
      await reactToTrigger(row, octokit, pending.payload.result.status === "succeeded").catch(
        (err: unknown) => {
          logger.warn({ err, attemptId: pending.attemptId }, "Workflow terminal reaction failed");
        },
      );
    }

    if (!(await markWorkflowRunnerResultProcessed(pending.attemptId))) {
      throw new Error(`Workflow result processing receipt was not current: ${pending.attemptId}`);
    }
    logTerminalResult(row, pending);
  } finally {
    if (ownsOctokit) {
      await revokeInstallationToken(octokit, logger, {
        attemptId: pending.attemptId,
        owner: "result-projection",
      });
    }
  }
}

/**
 * Apply retryable projections before ACK. The in-memory chain prevents concurrent
 * projection within the supported single orchestrator, but a process crash can replay it.
 */
export async function processWorkflowRunnerResult(
  pending: PendingWorkflowRunnerResult,
  suppliedOctokit?: Octokit,
): Promise<void> {
  const key = `${pending.runId}:${pending.attemptId}`;
  const prior = resultChains.get(key) ?? Promise.resolve();
  const current = prior
    .catch(() => undefined)
    .then(() => projectWorkflowRunnerResult(pending, suppliedOctokit));
  resultChains.set(key, current);
  try {
    await current;
  } finally {
    if (resultChains.get(key) === current) resultChains.delete(key);
  }
}

export async function reconcilePendingWorkflowRunnerResults(limit = 100): Promise<number> {
  const pending = await findPendingWorkflowRunnerResults(requireDb(), limit);
  let processed = 0;
  for (const result of pending) {
    try {
      // eslint-disable-next-line no-await-in-loop -- ordered, bounded durable reconciliation
      await processWorkflowRunnerResult(result);
      processed++;
    } catch (err) {
      logger.warn(
        { err, runId: result.runId, attemptId: result.attemptId },
        "Pending workflow runner result reconciliation failed",
      );
    }
  }
  return processed;
}

export async function cleanupWorkflowRunnerAttempt(input: {
  readonly runId: string;
  readonly attemptId: string;
}): Promise<void> {
  await cleanupCurrentWorkflowRunnerResources(input);
}
