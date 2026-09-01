import { z } from "zod";

import { config } from "../config";
import { assertDaemonEnvironmentPrivate } from "../daemon/process-boundary";
import { installFatalHandlers, logger } from "../logger";
import { revokeInstallationTokenValue } from "../orchestrator/installation-token";
import type { WorkflowRunnerPayload } from "../shared/workflow-runner-messages";
import type { HandlerResult } from "../shared/workflow-types";
import { redactErrorMessageOrFallback } from "../utils/log-redaction";
import { StaleWorkflowAttemptError } from "../workflows/runs-store";
import {
  assertCloudMetadataUnavailable,
  assertWorkflowRunnerEnvironment,
} from "./process-boundary";
import { createWorkflowRunnerDeadline } from "./token-deadline";
import { executeWorkflowRunnerJob } from "./workflow-executor";
import { WorkflowRunnerClient } from "./ws-client";

function requiredEnv(value: string | undefined, name: string): string {
  value = value?.trim();
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

export function resultForWorkflowRunnerExecutionError(input: {
  readonly err: unknown;
  readonly shuttingDown: boolean;
  readonly tokenDeadlineExpired: boolean;
}): HandlerResult | null {
  if (input.shuttingDown) return null;
  if (input.tokenDeadlineExpired) {
    return {
      status: "failed",
      reason: "Workflow runner execution deadline reached",
      humanMessage: "Workflow runner stopped at its credential or attempt deadline.",
    };
  }
  return {
    status: "failed",
    reason: redactErrorMessageOrFallback(input.err, "workflow runner failed"),
    humanMessage: "workflow runner failed, see server logs for details.",
  };
}

export async function executeAndReportWorkflowRunnerJob(input: {
  readonly job: WorkflowRunnerPayload;
  readonly client: WorkflowRunnerClient;
  readonly runId: string;
  readonly attemptId: string;
}): Promise<void> {
  const { job, client, runId, attemptId } = input;
  const startedAt = Date.now();
  const tokenDeadline = createWorkflowRunnerDeadline(
    job.installationTokenExpiresAt,
    job.attemptDeadlineAt,
  );
  const executionSignal = AbortSignal.any([client.signal, tokenDeadline.signal]);
  let revocationAttempted = false;
  const revokeRunnerToken = async (): Promise<void> => {
    if (revocationAttempted) return;
    revocationAttempted = true;
    await revokeInstallationTokenValue(job.installationToken, logger, {
      attemptId,
      owner: "workflow-runner",
    });
  };
  try {
    let result: HandlerResult;
    try {
      result = await executeWorkflowRunnerJob(job, client, executionSignal);
    } catch (err) {
      const failure = resultForWorkflowRunnerExecutionError({
        err,
        shuttingDown: client.signal.aborted || err instanceof StaleWorkflowAttemptError,
        tokenDeadlineExpired: tokenDeadline.signal.aborted,
      });
      if (failure === null) {
        logger.warn({ runId, attemptId }, "Workflow runner fenced before completion");
        return;
      }
      result = failure;
    }

    if (result.status === "handed-off") {
      await revokeRunnerToken();
      return;
    }

    await revokeRunnerToken();

    try {
      await client.sendResultUntilAck({
        runId,
        attemptId,
        result,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      if (!client.signal.aborted) throw err;
      logger.warn({ runId, attemptId }, "Workflow runner fenced before result acknowledgement");
    }
  } finally {
    tokenDeadline.cancel();
    await revokeRunnerToken();
    client.close();
  }
}

export async function main(): Promise<void> {
  assertWorkflowRunnerEnvironment();
  assertDaemonEnvironmentPrivate();
  await assertCloudMetadataUnavailable();
  installFatalHandlers("workflow-runner");

  if (!config.workflowRunner) throw new Error("WORKFLOW_RUNNER=true is required");
  const runId = z
    .uuid()
    .parse(requiredEnv(process.env["WORKFLOW_RUNNER_RUN_ID"], "WORKFLOW_RUNNER_RUN_ID"));
  const attemptId = z
    .uuid()
    .parse(requiredEnv(process.env["WORKFLOW_RUNNER_ATTEMPT_ID"], "WORKFLOW_RUNNER_ATTEMPT_ID"));
  const token = requiredEnv(process.env["WORKFLOW_RUNNER_TOKEN"], "WORKFLOW_RUNNER_TOKEN");
  const url = requiredEnv(process.env["ORCHESTRATOR_URL"], "ORCHESTRATOR_URL");

  const client = new WorkflowRunnerClient({ url, token, runId, attemptId });
  const stop = (signal: string): void => {
    logger.warn({ signal, runId, attemptId }, "Workflow runner stopping");
    client.cancel(new Error(`${signal} received`));
  };
  process.on("SIGTERM", () => {
    stop("SIGTERM");
  });
  process.on("SIGINT", () => {
    stop("SIGINT");
  });

  client.connect();
  const job = await client.waitForJob();
  if (job === null) {
    client.close();
    return;
  }
  client.addSensitiveValue(job.installationToken);

  await executeAndReportWorkflowRunnerJob({ job, client, runId, attemptId });
}

if (import.meta.main) {
  void main().catch((err: unknown) => {
    logger.error({ err }, "Workflow runner startup failed");
    process.exit(1);
  });
}
