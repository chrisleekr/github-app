import { App, Octokit } from "octokit";

import { config } from "../config";
import { logger } from "../logger";
import { observableOctokit } from "../utils/octokit-observability";
import { addReaction } from "../utils/reactions";
import {
  findPendingWorkflowFailureNotifications,
  markWorkflowFailureNotified,
  type WorkflowRunRow,
} from "../workflows/runs-store";
import { mintInstallationToken, revokeInstallationToken } from "./installation-token";
import type { TokenMintVia } from "./log-fields";

let cachedApp: InstanceType<typeof App> | null = null;

function getApp(): InstanceType<typeof App> {
  if (cachedApp !== null) return cachedApp;
  if (config.appId === undefined || config.privateKey === undefined) {
    throw new Error("GitHub App credentials are not configured");
  }
  cachedApp = new App({
    appId: config.appId,
    privateKey: config.privateKey,
    Octokit: observableOctokit(),
  });
  return cachedApp;
}

function canNotify(): boolean {
  if (config.nodeEnv === "test") return false;
  return (
    config.githubPersonalAccessToken !== undefined ||
    (config.appId !== undefined && config.privateKey !== undefined)
  );
}

export interface NotificationOctokit {
  readonly octokit: Octokit;
  readonly ownsInstallationToken: boolean;
}

/**
 * An Octokit authorised for one run's target repository.
 *
 * `ownsInstallationToken` says whether the caller must revoke it via
 * `releaseNotificationOctokit`; a PAT is process-wide and is not ours to revoke.
 */
export async function getNotificationOctokit(
  row: WorkflowRunRow,
  via: TokenMintVia,
): Promise<NotificationOctokit> {
  if (config.githubPersonalAccessToken !== undefined) {
    return {
      octokit: new Octokit({ auth: config.githubPersonalAccessToken }),
      ownsInstallationToken: false,
    };
  }
  const app = getApp();
  const { data: installation } = await app.octokit.rest.apps.getRepoInstallation({
    owner: row.target_owner,
    repo: row.target_repo,
  });
  const minted = await mintInstallationToken({
    app,
    installationId: installation.id,
    repositoryName: row.target_repo,
    via,
    log: logger,
  });
  return {
    octokit: minted.octokit as unknown as Octokit,
    ownsInstallationToken: true,
  };
}

/** Revoke a token from `getNotificationOctokit`, if we minted one. */
export async function releaseNotificationOctokit(
  auth: NotificationOctokit,
  runId: string,
  owner: string,
): Promise<void> {
  if (!auth.ownsInstallationToken) return;
  await revokeInstallationToken(auth.octokit, logger, { runId, owner });
}

async function findTopAncestor(row: WorkflowRunRow): Promise<WorkflowRunRow | null> {
  const { findById } = await import("../workflows/runs-store");
  let current: WorkflowRunRow | null = row;
  const visited = new Set<string>();
  while (current !== null) {
    if (visited.has(current.id)) {
      throw new Error(`Workflow parent cycle detected at ${current.id}`);
    }
    visited.add(current.id);
    if (current.parent_run_id === null) return current;
    // eslint-disable-next-line no-await-in-loop
    current = await findById(current.parent_run_id);
  }
  return null;
}

interface WorkflowFailureNotice {
  readonly phase: string | ((row: WorkflowRunRow) => string);
  readonly humanMessage: (row: WorkflowRunRow) => string;
  /**
   * Notice kind, recorded as the token-mint `via`. These five paths are what an
   * operator greps when a user reports a silently-failed workflow, so a dispatch
   * expiry must not look like a daemon disconnect in the audit trail.
   */
  readonly via: TokenMintVia;
}

const disconnectedDaemonNotice: WorkflowFailureNotice = {
  phase: "orphaned",
  via: "notifyDisconnectedDaemonWorkflows",
  humanMessage: () =>
    [
      "❌ **Daemon disconnected during execution**",
      "",
      "The database marked the in-flight workflow failed and released its target lock.",
      "",
      "External GitHub or git operations may have completed before the disconnect. Inspect the repository before re-triggering the workflow.",
    ].join("\n"),
};

const migrationInterruptedNotice: WorkflowFailureNotice = {
  phase: "migration-interrupted",
  via: "notifyMigrationInterruptedWorkflows",
  humanMessage: (row) => {
    const dispatchIncomplete =
      row.state["failedReason"] === "workflow dispatch incomplete during lease migration";
    return [
      dispatchIncomplete
        ? "❌ **Workflow dispatch interrupted during migration**"
        : "❌ **Workflow execution interrupted during migration**",
      "",
      dispatchIncomplete
        ? "The deployment migration found a queued workflow without its matching execution receipt. The database marked the workflow failed and released its target lock."
        : "The deployment could not safely transfer this active shared-daemon workflow to an isolated runner. The database marked the workflow failed and released its target lock.",
      "",
      "Inspect the repository for partial external operations, then re-trigger the workflow.",
    ].join("\n");
  },
};

export async function notifyWorkflowAttemptFailures(
  rows: readonly WorkflowRunRow[],
  notice: WorkflowFailureNotice,
): Promise<void> {
  if (rows.length === 0 || !canNotify()) return;
  const notifiedAncestors = new Set<string>();

  for (const row of rows) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const ancestor = await findTopAncestor(row);
      if (ancestor === null) {
        // A missing parent row is permanent, not transient: `findById` returns
        // null only for a row that is not there, and a DB fault throws instead.
        // Without a receipt `failure_notified_at IS NULL` re-selects this row on
        // every pass forever, so record it as terminally un-notifiable.
        logger.warn(
          { event: "workflow.failure_notice_unresolvable", runId: row.id },
          "Workflow failure notice has no reachable ancestor; marking notified",
        );
        // eslint-disable-next-line no-await-in-loop -- each row needs its own durable receipt
        await markWorkflowFailureNotified({ runId: row.id, attemptId: row.attempt_id });
        continue;
      }
      if (notifiedAncestors.has(ancestor.id)) {
        // eslint-disable-next-line no-await-in-loop -- each row needs its own durable receipt
        await markWorkflowFailureNotified({ runId: row.id, attemptId: row.attempt_id });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const auth = await getNotificationOctokit(ancestor, notice.via);
      try {
        // eslint-disable-next-line no-await-in-loop -- loaded only for rows that need projection
        const { setState } = await import("../workflows/tracking-mirror");
        // eslint-disable-next-line no-await-in-loop
        await setState(
          { octokit: auth.octokit, logger },
          {
            runId: ancestor.id,
            patch: {
              phase: typeof notice.phase === "string" ? notice.phase : notice.phase(row),
            },
            humanMessage: notice.humanMessage(row),
          },
        );

        if (ancestor.trigger_comment_id !== null && ancestor.trigger_event_type !== null) {
          // eslint-disable-next-line no-await-in-loop
          await addReaction({
            octokit: auth.octokit,
            logger,
            owner: ancestor.target_owner,
            repo: ancestor.target_repo,
            commentId: ancestor.trigger_comment_id,
            eventType: ancestor.trigger_event_type,
            content: "confused",
          });
        }
        // eslint-disable-next-line no-await-in-loop -- each row needs its own durable receipt
        await markWorkflowFailureNotified({ runId: row.id, attemptId: row.attempt_id });
        notifiedAncestors.add(ancestor.id);
      } finally {
        // eslint-disable-next-line no-await-in-loop -- release each owned token before the next row
        await releaseNotificationOctokit(auth, row.id, "failure-notification");
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err : new Error(String(err)), runId: row.id },
        "Workflow failure notification failed",
      );
    }
  }
}

export async function notifyExpiredWorkflowAttempts(
  rows: readonly WorkflowRunRow[],
): Promise<void> {
  return notifyWorkflowAttemptFailures(rows, {
    via: "notifyExpiredWorkflowAttempts",
    phase: (row) =>
      row.state["failedReason"] === "workflow execution deadline expired"
        ? "deadline-expired"
        : "lease-expired",
    humanMessage: (row) => {
      const deadlineExpired = row.state["failedReason"] === "workflow execution deadline expired";
      // The payload is the runner's first credential delivery. Until it is
      // issued the attempt has provably cloned nothing and written nothing, so
      // telling the reader to go inspect the repository is false and sends them
      // hunting for damage that cannot exist.
      const ranNothing = row.runner_payload_issued_at === null;
      return [
        deadlineExpired
          ? "❌ **Workflow execution deadline expired**"
          : "❌ **Workflow execution lease expired**",
        "",
        deadlineExpired
          ? "The immutable attempt deadline elapsed before completion was confirmed. The database marked the workflow failed and released its in-flight lock."
          : "The runner stopped renewing this attempt before completion was confirmed. The database marked the workflow failed and released its in-flight lock.",
        "",
        ranNothing
          ? "The runner never started, so no repository or GitHub changes were made. Re-triggering the workflow is safe."
          : `External GitHub or git operations may have completed before the ${deadlineExpired ? "deadline" : "lease"} expired. Inspect the repository before re-triggering the workflow.`,
      ].join("\n");
    },
  });
}

export async function notifyExpiredWorkflowDispatches(
  rows: readonly WorkflowRunRow[],
): Promise<void> {
  return notifyWorkflowAttemptFailures(rows, {
    via: "notifyExpiredWorkflowDispatches",
    phase: "dispatch-expired",
    humanMessage: (row) => {
      const retriesExhausted = row.state["failedReason"] === "workflow dispatch retries exhausted";
      return [
        retriesExhausted
          ? "❌ **Workflow dispatch retries exhausted**"
          : "❌ **Workflow dispatch deadline expired**",
        "",
        retriesExhausted
          ? "The controller could not durably publish this queued workflow within its retry budget. The database marked it failed and released its in-flight lock."
          : "No isolated runner claimed this queued workflow before its dispatch deadline. The database marked it failed and released its in-flight lock.",
        "",
        "Fix the queue or runner capacity issue, then re-trigger the workflow.",
      ].join("\n");
    },
  });
}

export async function notifyRunnerStartFailures(rows: readonly WorkflowRunRow[]): Promise<void> {
  return notifyWorkflowAttemptFailures(rows, {
    via: "notifyRunnerStartFailures",
    phase: "runner-start-failed",
    humanMessage: (row) => {
      const reason = row.state["failedReason"];
      const detail = typeof reason === "string" ? reason : "Workflow runner configuration failed";
      return [
        "❌ **Workflow runner could not start**",
        "",
        `${detail}. The database marked the workflow failed and released its in-flight lock.`,
        "",
        "Fix the runner deployment configuration, then re-trigger the workflow.",
      ].join("\n");
    },
  });
}

export async function notifyDisconnectedDaemonWorkflows(runIds: readonly string[]): Promise<void> {
  const { findById } = await import("../workflows/runs-store");
  const rows = (await Promise.all(runIds.map((runId) => findById(runId)))).filter(
    (row): row is WorkflowRunRow => row !== null,
  );
  return notifyWorkflowAttemptFailures(rows, disconnectedDaemonNotice);
}

/**
 * Dormant on this branch: no scheduler calls this yet. The isolated-runner slice
 * wires it into `workflow-runner-reconciler.ts`. Until both land together, a
 * notice lost to a crash is not retried.
 */
export async function reconcilePendingWorkflowFailureNotifications(limit = 100): Promise<void> {
  const pending = await findPendingWorkflowFailureNotifications(undefined, limit);
  const expired = pending
    .filter((entry) => entry.phase === "deadline-expired" || entry.phase === "lease-expired")
    .map((entry) => entry.row);
  const dispatchExpired = pending
    .filter((entry) => entry.phase === "dispatch-expired")
    .map((entry) => entry.row);
  const startFailed = pending
    .filter((entry) => entry.phase === "runner-start-failed")
    .map((entry) => entry.row);
  const disconnected = pending
    .filter((entry) => entry.phase === "orphaned")
    .map((entry) => entry.row);
  const migrationInterrupted = pending
    .filter((entry) => entry.phase === "migration-interrupted")
    .map((entry) => entry.row);
  await notifyExpiredWorkflowAttempts(expired);
  await notifyExpiredWorkflowDispatches(dispatchExpired);
  await notifyRunnerStartFailures(startFailed);
  await notifyWorkflowAttemptFailures(disconnected, disconnectedDaemonNotice);
  await notifyWorkflowAttemptFailures(migrationInterrupted, migrationInterruptedNotice);
}
