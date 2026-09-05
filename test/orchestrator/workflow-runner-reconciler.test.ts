import { beforeEach, describe, expect, it, mock } from "bun:test";

const config = {
  githubPersonalAccessToken: undefined as string | undefined,
  daemonImage: `registry.example/runner@sha256:${"a".repeat(64)}` as string | undefined,
  orchestratorPublicUrl: "wss://controller.example/ws" as string | undefined,
  workflowRunnerCapabilitySecret: "runner-capability-root-secret" as string | undefined,
};
const firstAttemptId = crypto.randomUUID();
const firstAttempt = {
  runId: crypto.randomUUID(),
  attemptId: firstAttemptId,
  runnerId: `workflow-runner:${firstAttemptId}`,
  executionDeliveryId: "delivery-first",
  workflowName: "plan" as const,
  attemptDeadlineAt: new Date("2026-08-23T04:10:00Z"),
};
const secondAttemptId = crypto.randomUUID();
const secondAttempt = {
  ...firstAttempt,
  runId: crypto.randomUUID(),
  attemptId: secondAttemptId,
  runnerId: `workflow-runner:${secondAttemptId}`,
  executionDeliveryId: "delivery-second",
};
const events: string[] = [];
const reconcilePendingWorkflowRunnerResults = mock(() => {
  events.push("results");
  return Promise.resolve(0);
});
const reconcilePendingWorkflowFailureNotifications = mock(() => {
  events.push("notifications");
  return Promise.resolve();
});
const ensureCurrentWorkflowRunnerResources = mock((input: { attempt: { attemptId: string } }) => {
  events.push(`ensure:${input.attempt.attemptId}`);
  return Promise.resolve({ state: "ready", startup: { phase: "running" } } as const);
});
const extendWorkflowRunnerStartupLease = mock((input: { attemptId: string }) => {
  events.push(`extend:${input.attemptId}`);
  return Promise.resolve(true);
});
const failWorkflowRunnerResourceAttempt = mock(() => Promise.resolve());
const cleanupWorkflowRunnerAttempt = mock((input: { attemptId: string }) => {
  events.push(`cleanup:${input.attemptId}`);
  return Promise.resolve();
});
const listActiveWorkflowRunnerAttempts = mock(() => Promise.resolve([firstAttempt, secondAttempt]));
const findWorkflowRunnerCleanupCandidates = mock(() =>
  Promise.resolve([
    { runId: firstAttempt.runId, attemptId: firstAttempt.attemptId },
    { runId: secondAttempt.runId, attemptId: secondAttempt.attemptId },
  ]),
);

void mock.module("../../src/config", () => ({ config }));
class TestWorkflowRunnerResourceError extends Error {
  constructor(readonly kind: "permanent" | "transient") {
    super(kind);
  }
}
void mock.module("../../src/k8s/workflow-runner-spawner", () => ({
  WorkflowRunnerResourceError: TestWorkflowRunnerResourceError,
}));
void mock.module("../../src/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));
void mock.module("../../src/orchestrator/workflow-runner-capability", () => ({
  deriveWorkflowRunnerCapability: mock(
    (_secret: string, _runId: string, attemptId: string) => `capability:${attemptId}`,
  ),
}));
void mock.module("../../src/orchestrator/workflow-expiry-notifier", () => ({
  reconcilePendingWorkflowFailureNotifications,
}));
// Mirrors the real validator in `workflow-runner-dispatch.ts`: the reconciler
// now shares it, so both paths reject an empty string the same way.
const requiredRunnerConfig = mock(() => {
  if (
    config.githubPersonalAccessToken !== undefined ||
    config.daemonImage === undefined ||
    config.daemonImage === "" ||
    config.orchestratorPublicUrl === undefined ||
    config.orchestratorPublicUrl === "" ||
    config.workflowRunnerCapabilitySecret === undefined ||
    config.workflowRunnerCapabilitySecret === ""
  ) {
    throw new Error("workflow runner configuration is incomplete");
  }
  return {
    image: config.daemonImage,
    orchestratorUrl: config.orchestratorPublicUrl,
    capabilitySecret: config.workflowRunnerCapabilitySecret,
  };
});
void mock.module("../../src/orchestrator/workflow-runner-dispatch", () => ({
  failWorkflowRunnerResourceAttempt,
  requiredRunnerConfig,
  WORKFLOW_RUNNER_STARTUP_LEASE_MS: 360_000,
}));
void mock.module("../../src/orchestrator/workflow-runner-resources", () => ({
  ensureCurrentWorkflowRunnerResources,
}));
void mock.module("../../src/orchestrator/workflow-runner-result", () => ({
  cleanupWorkflowRunnerAttempt,
  reconcilePendingWorkflowRunnerResults,
}));
void mock.module("../../src/orchestrator/workflow-runner-store", () => ({
  extendWorkflowRunnerStartupLease,
  findWorkflowRunnerCleanupCandidates,
  listActiveWorkflowRunnerAttempts,
}));

const { reconcileWorkflowRunners } =
  await import("../../src/orchestrator/workflow-runner-reconciler");

describe("workflow runner reconciliation", () => {
  beforeEach(() => {
    events.length = 0;
    config.githubPersonalAccessToken = undefined;
    config.daemonImage = `registry.example/runner@sha256:${"a".repeat(64)}`;
    config.orchestratorPublicUrl = "wss://controller.example/ws";
    config.workflowRunnerCapabilitySecret = "runner-capability-root-secret";
    reconcilePendingWorkflowRunnerResults.mockClear();
    reconcilePendingWorkflowFailureNotifications.mockClear();
    ensureCurrentWorkflowRunnerResources.mockReset();
    ensureCurrentWorkflowRunnerResources.mockImplementation((input) => {
      events.push(`ensure:${input.attempt.attemptId}`);
      return Promise.resolve({ state: "ready", startup: { phase: "running" } });
    });
    extendWorkflowRunnerStartupLease.mockClear();
    failWorkflowRunnerResourceAttempt.mockClear();
    cleanupWorkflowRunnerAttempt.mockReset();
    cleanupWorkflowRunnerAttempt.mockImplementation((input) => {
      events.push(`cleanup:${input.attemptId}`);
      return Promise.resolve();
    });
    listActiveWorkflowRunnerAttempts.mockClear();
    findWorkflowRunnerCleanupCandidates.mockClear();
  });

  it("replays results before repairing active resources and terminal cleanup", async () => {
    await reconcileWorkflowRunners();
    expect(events).toEqual([
      "results",
      "notifications",
      `ensure:${firstAttempt.attemptId}`,
      `ensure:${secondAttempt.attemptId}`,
      `cleanup:${firstAttempt.attemptId}`,
      `cleanup:${secondAttempt.attemptId}`,
    ]);
    expect(ensureCurrentWorkflowRunnerResources.mock.calls[0]?.[0]).toEqual({
      attempt: firstAttempt,
      capability: `capability:${firstAttempt.attemptId}`,
      image: `registry.example/runner@sha256:${"a".repeat(64)}`,
      orchestratorUrl: "wss://controller.example/ws",
    });
  });

  it("continues with other attempts after one repair and one cleanup fail", async () => {
    ensureCurrentWorkflowRunnerResources.mockRejectedValueOnce(new Error("API unavailable"));
    cleanupWorkflowRunnerAttempt.mockRejectedValueOnce(new Error("delete pending"));
    await reconcileWorkflowRunners();
    expect(events).toContain(`ensure:${secondAttempt.attemptId}`);
    expect(events).toContain(`cleanup:${secondAttempt.attemptId}`);
  });

  it("fences a permanent resource violation and continues reconciliation", async () => {
    ensureCurrentWorkflowRunnerResources.mockRejectedValueOnce(
      new TestWorkflowRunnerResourceError("permanent"),
    );

    await reconcileWorkflowRunners();

    expect(failWorkflowRunnerResourceAttempt).toHaveBeenCalledWith(firstAttempt, "permanent");
    expect(ensureCurrentWorkflowRunnerResources).toHaveBeenCalledTimes(2);
    expect(ensureCurrentWorkflowRunnerResources.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ attempt: secondAttempt }),
    );
    expect(cleanupWorkflowRunnerAttempt).toHaveBeenCalledTimes(2);
  });

  it("extends the startup lease while the Pod is still coming up", async () => {
    // The regression this guards: the startup lease is claimed before the Pod
    // exists, so a cold image pull slower than the lease killed a healthy
    // attempt that had not run a line.
    ensureCurrentWorkflowRunnerResources.mockImplementation((input) => {
      events.push(`ensure:${input.attempt.attemptId}`);
      return Promise.resolve({ state: "ready", startup: { phase: "starting" } });
    });

    await reconcileWorkflowRunners();

    expect(extendWorkflowRunnerStartupLease).toHaveBeenCalledTimes(2);
    expect(extendWorkflowRunnerStartupLease).toHaveBeenCalledWith(firstAttempt, 360_000);
    expect(failWorkflowRunnerResourceAttempt).not.toHaveBeenCalled();
  });

  it("does not extend once the container is running", async () => {
    await reconcileWorkflowRunners();
    expect(extendWorkflowRunnerStartupLease).not.toHaveBeenCalled();
  });

  it("terminalizes a stalled Pod instead of burning the lease", async () => {
    ensureCurrentWorkflowRunnerResources.mockImplementationOnce((input) => {
      events.push(`ensure:${input.attempt.attemptId}`);
      return Promise.resolve({
        state: "ready",
        startup: { phase: "stalled", reason: "ImagePullBackOff" },
      });
    });

    await reconcileWorkflowRunners();

    expect(failWorkflowRunnerResourceAttempt).toHaveBeenCalledWith(
      firstAttempt,
      "Runner Pod could not start: ImagePullBackOff",
    );
    expect(extendWorkflowRunnerStartupLease).not.toHaveBeenCalledWith(firstAttempt, 360_000);
    // The stalled attempt must not stop the pass.
    expect(events).toContain(`ensure:${secondAttempt.attemptId}`);
  });

  it("skips lease work for an attempt that is no longer ready", async () => {
    ensureCurrentWorkflowRunnerResources.mockImplementation((input) => {
      events.push(`ensure:${input.attempt.attemptId}`);
      return Promise.resolve({ state: "terminal" });
    });

    await reconcileWorkflowRunners();

    expect(extendWorkflowRunnerStartupLease).not.toHaveBeenCalled();
    expect(failWorkflowRunnerResourceAttempt).not.toHaveBeenCalled();
  });

  it("skips active resource creation when runner configuration is unsafe", async () => {
    config.githubPersonalAccessToken = "global-pat";
    await reconcileWorkflowRunners();
    expect(ensureCurrentWorkflowRunnerResources).not.toHaveBeenCalled();
    expect(cleanupWorkflowRunnerAttempt).toHaveBeenCalledTimes(2);
  });

  it("skips active resource creation when a required setting is an empty string", async () => {
    // An empty `DAEMON_IMAGE` must not reach Kubernetes as `image: ""`. The
    // dispatch path terminalizes it permanently; the reconciler skips.
    config.daemonImage = "";
    await reconcileWorkflowRunners();
    expect(ensureCurrentWorkflowRunnerResources).not.toHaveBeenCalled();
    expect(cleanupWorkflowRunnerAttempt).toHaveBeenCalledTimes(2);
  });
});
