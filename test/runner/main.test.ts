import { beforeEach, describe, expect, it, mock } from "bun:test";

import { expectToReject } from "../utils/assertions";

const executeWorkflowRunnerJob = mock((_job: unknown, _client: unknown, signal: AbortSignal) => {
  signal.throwIfAborted();
  return Promise.resolve({ status: "succeeded" as const, state: {} });
});
const startupEvents: string[] = [];
const assertDaemonEnvironmentPrivate = mock(() => {
  startupEvents.push("daemon-environment");
});
const assertWorkflowRunnerEnvironment = mock(() => {
  startupEvents.push("runner-environment");
});
const assertCloudMetadataUnavailable = mock(() => {
  startupEvents.push("metadata");
  return Promise.resolve();
});
const installFatalHandlers = mock(() => {
  startupEvents.push("fatal-handlers");
});
const constructedClients: unknown[] = [];
const revokeInstallationTokenValue = mock(() => Promise.resolve(true));

void mock.module("../../src/config", () => ({ config: { workflowRunner: true } }));
void mock.module("../../src/daemon/process-boundary", () => ({
  assertDaemonEnvironmentPrivate,
}));
void mock.module("../../src/logger", () => ({
  installFatalHandlers,
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));
void mock.module("../../src/orchestrator/installation-token", () => ({
  revokeInstallationTokenValue,
}));
void mock.module("../../src/utils/log-redaction", () => ({
  redactErrorMessageOrFallback: (_err: unknown, fallback: string): string => fallback,
}));
class StaleWorkflowAttemptError extends Error {}
void mock.module("../../src/workflows/runs-store", () => ({ StaleWorkflowAttemptError }));
void mock.module("../../src/runner/process-boundary", () => ({
  assertCloudMetadataUnavailable,
  assertWorkflowRunnerEnvironment,
}));
void mock.module("../../src/runner/workflow-executor", () => ({ executeWorkflowRunnerJob }));
void mock.module("../../src/runner/ws-client", () => ({
  WorkflowRunnerClient: class TestWorkflowRunnerClient {
    readonly signal = new AbortController().signal;
    readonly attemptId = "test-attempt";

    constructor(options: unknown) {
      startupEvents.push("client-constructed");
      constructedClients.push(options);
    }

    connect(): void {
      startupEvents.push("client-connect");
    }

    waitForJob(): Promise<null> {
      startupEvents.push("client-wait");
      return Promise.resolve(null);
    }

    close(): void {
      startupEvents.push("client-close");
    }

    cancel(): void {
      startupEvents.push("client-cancel");
    }
  },
}));

const { executeAndReportWorkflowRunnerJob, main, resultForWorkflowRunnerExecutionError } =
  await import("../../src/runner/main");

const runId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
const workflowRunnerToken = ["wfr1", "fixture"].join(".");

function installWorkflowRunnerEnvironment(): () => void {
  const original = {
    runId: process.env.WORKFLOW_RUNNER_RUN_ID,
    attemptId: process.env.WORKFLOW_RUNNER_ATTEMPT_ID,
    token: process.env.WORKFLOW_RUNNER_TOKEN,
    orchestratorUrl: process.env.ORCHESTRATOR_URL,
  };
  process.env.WORKFLOW_RUNNER_RUN_ID = runId;
  process.env.WORKFLOW_RUNNER_ATTEMPT_ID = attemptId;
  process.env.WORKFLOW_RUNNER_TOKEN = workflowRunnerToken;
  process.env.ORCHESTRATOR_URL = "wss://controller.example/ws";
  return () => {
    if (original.runId === undefined) Reflect.deleteProperty(process.env, "WORKFLOW_RUNNER_RUN_ID");
    else process.env.WORKFLOW_RUNNER_RUN_ID = original.runId;
    if (original.attemptId === undefined) {
      Reflect.deleteProperty(process.env, "WORKFLOW_RUNNER_ATTEMPT_ID");
    } else process.env.WORKFLOW_RUNNER_ATTEMPT_ID = original.attemptId;
    if (original.token === undefined) Reflect.deleteProperty(process.env, "WORKFLOW_RUNNER_TOKEN");
    else process.env.WORKFLOW_RUNNER_TOKEN = original.token;
    if (original.orchestratorUrl === undefined) {
      Reflect.deleteProperty(process.env, "ORCHESTRATOR_URL");
    } else process.env.ORCHESTRATOR_URL = original.orchestratorUrl;
  };
}

function job(expiresAt: string): Record<string, unknown> {
  return {
    context: {},
    installationToken: "ghs_scoped",
    installationTokenExpiresAt: expiresAt,
    attemptDeadlineAt: new Date(Date.parse(expiresAt) + 10 * 60_000).toISOString(),
    workflowRun: { runId, workflowName: "implement" },
  };
}

function client(signal: AbortSignal): {
  readonly signal: AbortSignal;
  readonly attemptId: string;
  sendResultUntilAck: ReturnType<typeof mock>;
  close: ReturnType<typeof mock>;
} {
  return {
    signal,
    attemptId,
    sendResultUntilAck: mock(() => Promise.resolve()),
    close: mock(() => undefined),
  };
}

describe("workflow runner main result handling", () => {
  beforeEach(() => {
    startupEvents.length = 0;
    constructedClients.length = 0;
    assertDaemonEnvironmentPrivate.mockClear();
    assertWorkflowRunnerEnvironment.mockClear();
    assertCloudMetadataUnavailable.mockReset();
    assertCloudMetadataUnavailable.mockImplementation(() => {
      startupEvents.push("metadata");
      return Promise.resolve();
    });
    installFatalHandlers.mockClear();
    executeWorkflowRunnerJob.mockReset();
    revokeInstallationTokenValue.mockClear();
    executeWorkflowRunnerJob.mockImplementation(
      (_job: unknown, _client: unknown, signal: AbortSignal) => {
        signal.throwIfAborted();
        return Promise.resolve({ status: "succeeded" as const, state: {} });
      },
    );
  });

  it("reports a durable failed result when the token deadline fires", async () => {
    const runner = client(new AbortController().signal);

    await executeAndReportWorkflowRunnerJob({
      job: job(new Date(Date.now() + 60_000).toISOString()) as never,
      client: runner as never,
      runId,
      attemptId,
    });

    expect(runner.sendResultUntilAck).toHaveBeenCalledTimes(1);
    expect(runner.sendResultUntilAck).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        attemptId,
        result: {
          status: "failed",
          reason: "Workflow runner execution deadline reached",
          humanMessage: "Workflow runner stopped at its credential or attempt deadline.",
        },
      }),
    );
    expect(runner.close).toHaveBeenCalledTimes(1);
    expect(revokeInstallationTokenValue).toHaveBeenCalledTimes(1);
  });

  it("keeps client-fence shutdown as a clean exit", async () => {
    const controller = new AbortController();
    controller.abort(new Error("client fence expired"));
    const runner = client(controller.signal);

    await executeAndReportWorkflowRunnerJob({
      job: job(new Date(Date.now() + 60 * 60_000).toISOString()) as never,
      client: runner as never,
      runId,
      attemptId,
    });

    expect(runner.sendResultUntilAck).not.toHaveBeenCalled();
    expect(runner.close).toHaveBeenCalledTimes(1);
    expect(revokeInstallationTokenValue).toHaveBeenCalledTimes(1);
  });

  it("revokes before publishing an ordinary terminal result", async () => {
    const events: string[] = [];
    revokeInstallationTokenValue.mockImplementationOnce(() => {
      events.push("revoke");
      return Promise.resolve(true);
    });
    const runner = client(new AbortController().signal);
    runner.sendResultUntilAck.mockImplementationOnce(() => {
      events.push("result");
      return Promise.resolve();
    });

    await executeAndReportWorkflowRunnerJob({
      job: job(new Date(Date.now() + 60 * 60_000).toISOString()) as never,
      client: runner as never,
      runId,
      attemptId,
    });

    expect(events).toEqual(["revoke", "result"]);
    expect(revokeInstallationTokenValue).toHaveBeenCalledTimes(1);
  });

  it("still reports and closes when token revocation fails", async () => {
    revokeInstallationTokenValue.mockResolvedValueOnce(false);
    const runner = client(new AbortController().signal);

    await executeAndReportWorkflowRunnerJob({
      job: job(new Date(Date.now() + 60 * 60_000).toISOString()) as never,
      client: runner as never,
      runId,
      attemptId,
    });

    expect(runner.sendResultUntilAck).toHaveBeenCalledTimes(1);
    expect(revokeInstallationTokenValue).toHaveBeenCalledTimes(1);
    expect(runner.close).toHaveBeenCalledTimes(1);
  });

  it("revokes after a successful hand-off without sending another result", async () => {
    executeWorkflowRunnerJob.mockResolvedValueOnce({
      status: "handed-off",
      state: { phase: "child-running" },
      childRunId: crypto.randomUUID(),
    });
    const runner = client(new AbortController().signal);

    await executeAndReportWorkflowRunnerJob({
      job: job(new Date(Date.now() + 60 * 60_000).toISOString()) as never,
      client: runner as never,
      runId,
      attemptId,
    });

    expect(runner.sendResultUntilAck).not.toHaveBeenCalled();
    expect(revokeInstallationTokenValue).toHaveBeenCalledTimes(1);
    expect(runner.close).toHaveBeenCalledTimes(1);
  });

  it("gives permanent client fencing precedence over a simultaneous token deadline", () => {
    expect(
      resultForWorkflowRunnerExecutionError({
        err: new Error("deadline"),
        shuttingDown: true,
        tokenDeadlineExpired: true,
      }),
    ).toBeNull();
  });

  it("maps a token deadline to a terminal result and a client signal to no result", () => {
    expect(
      resultForWorkflowRunnerExecutionError({
        err: new Error("deadline"),
        shuttingDown: false,
        tokenDeadlineExpired: true,
      }),
    ).toEqual({
      status: "failed",
      reason: "Workflow runner execution deadline reached",
      humanMessage: "Workflow runner stopped at its credential or attempt deadline.",
    });
    expect(
      resultForWorkflowRunnerExecutionError({
        err: new Error("SIGTERM"),
        shuttingDown: true,
        tokenDeadlineExpired: false,
      }),
    ).toBeNull();
  });

  it("runs both environment guards and metadata validation before connecting", async () => {
    const restoreEnvironment = installWorkflowRunnerEnvironment();
    try {
      await main();
    } finally {
      restoreEnvironment();
    }

    expect(startupEvents).toEqual([
      "runner-environment",
      "daemon-environment",
      "metadata",
      "fatal-handlers",
      "client-constructed",
      "client-connect",
      "client-wait",
      "client-close",
    ]);
    expect(constructedClients).toEqual([
      {
        url: "wss://controller.example/ws",
        token: workflowRunnerToken,
        runId,
        attemptId,
      },
    ]);
  });

  it("does not construct a WebSocket client when metadata validation fails", async () => {
    const restoreEnvironment = installWorkflowRunnerEnvironment();
    assertCloudMetadataUnavailable.mockRejectedValueOnce(new Error("metadata reachable"));

    try {
      await expectToReject(main(), "metadata reachable");
    } finally {
      restoreEnvironment();
    }
    expect(constructedClients).toEqual([]);
  });
});
