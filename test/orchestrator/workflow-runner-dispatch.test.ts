import { beforeEach, describe, expect, it, mock } from "bun:test";

class TestEphemeralSpawnError extends Error {
  constructor(readonly kind: string) {
    super(kind);
  }
}

class TestWorkflowRunnerResourceError extends Error {
  constructor(
    readonly kind: "permanent" | "transient",
    message: string,
  ) {
    super(message);
  }
}

const config = {
  githubPersonalAccessToken: undefined as string | undefined,
  daemonImage: `registry.example/runner@sha256:${"a".repeat(64)}` as string | undefined,
  orchestratorPublicUrl: "wss://controller.example/ws" as string | undefined,
  workflowRunnerCapabilitySecret: "runner-capability-root-secret" as string | undefined,
  heartbeatTimeoutMs: 3_000,
  maxConcurrentRequests: 2,
  botAppLogin: "test-bot",
};
const attemptId = crypto.randomUUID();
const attempt = {
  runId: crypto.randomUUID(),
  attemptId,
  runnerId: `workflow-runner:${attemptId}`,
  executionDeliveryId: "delivery-16",
  workflowName: "review" as const,
  attemptDeadlineAt: new Date("2026-08-23T04:10:00Z"),
};
const claimWorkflowRunnerAttempt = mock(() =>
  Promise.resolve({ outcome: "claimed" as const, attempt }),
);
const ensureCurrentWorkflowRunnerResources = mock(() => Promise.resolve("ready" as const));
const failWorkflowRunnerAttempt = mock(() => Promise.resolve({ id: attempt.runId }));
const ensureWorkflowCascadeForOffer = mock(() => Promise.resolve("complete" as const));
const notifyRunnerStartFailures = mock(() => Promise.resolve());
const cleanupCurrentWorkflowRunnerResources = mock(() => Promise.resolve());
const loggerInfo = mock(() => undefined);

void mock.module("../../src/config", () => ({ config }));
void mock.module("../../src/k8s/ephemeral-daemon-spawner", () => ({
  EphemeralSpawnError: TestEphemeralSpawnError,
}));
void mock.module("../../src/k8s/workflow-runner-spawner", () => ({
  WorkflowRunnerResourceError: TestWorkflowRunnerResourceError,
}));
void mock.module("../../src/logger", () => ({
  logger: {
    info: loggerInfo,
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));
void mock.module("../../src/workflows/completion-reconciler", () => ({
  ensureWorkflowCascadeForOffer,
}));
void mock.module("../../src/orchestrator/workflow-expiry-notifier", () => ({
  notifyRunnerStartFailures,
}));
void mock.module("../../src/orchestrator/workflow-runner-capability", () => ({
  deriveWorkflowRunnerCapability: mock(() => "wfr1.capability"),
}));
void mock.module("../../src/orchestrator/workflow-runner-resources", () => ({
  cleanupCurrentWorkflowRunnerResources,
  ensureCurrentWorkflowRunnerResources,
}));
void mock.module("../../src/orchestrator/workflow-runner-store", () => ({
  claimWorkflowRunnerAttempt,
  failWorkflowRunnerAttempt,
}));

const { dispatchWorkflowRunner } = await import("../../src/orchestrator/workflow-runner-dispatch");

const job = {
  kind: "workflow-run" as const,
  deliveryId: "delivery-16",
  repoOwner: "acme",
  repoName: "widgets",
  entityNumber: 16,
  isPR: false,
  eventName: "issues",
  triggerUsername: "maintainer",
  labels: ["bot:review"],
  triggerBodyPreview: "",
  enqueuedAt: Date.now(),
  retryCount: 0,
  workflowRun: { runId: attempt.runId, workflowName: "review" as const },
};

describe("isolated workflow runner dispatch", () => {
  beforeEach(() => {
    config.githubPersonalAccessToken = undefined;
    config.daemonImage = `registry.example/runner@sha256:${"a".repeat(64)}`;
    config.orchestratorPublicUrl = "wss://controller.example/ws";
    config.workflowRunnerCapabilitySecret = "runner-capability-root-secret";
    claimWorkflowRunnerAttempt.mockReset();
    claimWorkflowRunnerAttempt.mockResolvedValue({ outcome: "claimed", attempt });
    ensureCurrentWorkflowRunnerResources.mockReset();
    ensureCurrentWorkflowRunnerResources.mockResolvedValue("ready");
    failWorkflowRunnerAttempt.mockClear();
    ensureWorkflowCascadeForOffer.mockClear();
    notifyRunnerStartFailures.mockClear();
    cleanupCurrentWorkflowRunnerResources.mockClear();
    loggerInfo.mockClear();
  });

  it("does not create Kubernetes resources when admission is at capacity", async () => {
    claimWorkflowRunnerAttempt.mockResolvedValueOnce({ outcome: "capacity" });
    expect(await dispatchWorkflowRunner(job)).toBe("capacity");
    expect(ensureCurrentWorkflowRunnerResources).not.toHaveBeenCalled();
  });

  it("does not create Kubernetes resources when the durable claim is stale", async () => {
    claimWorkflowRunnerAttempt.mockResolvedValueOnce({ outcome: "stale" });
    expect(await dispatchWorkflowRunner(job)).toBe("stale");
    expect(ensureCurrentWorkflowRunnerResources).not.toHaveBeenCalled();
  });

  it("creates the exact claimed attempt with its derived capability", async () => {
    expect(await dispatchWorkflowRunner(job)).toBe("accepted");
    expect(ensureCurrentWorkflowRunnerResources).toHaveBeenCalledWith({
      attempt,
      capability: "wfr1.capability",
      image: `registry.example/runner@sha256:${"a".repeat(64)}`,
      orchestratorUrl: "wss://controller.example/ws",
    });
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "workflow.run.running",
        runId: attempt.runId,
        target: { type: "issue", owner: "acme", repo: "widgets", number: 16 },
      }),
      "Workflow run running",
    );
  });

  it("terminalizes a permanent runner configuration failure", async () => {
    config.githubPersonalAccessToken = "global-pat";
    expect(await dispatchWorkflowRunner(job)).toBe("accepted");
    expect(failWorkflowRunnerAttempt).toHaveBeenCalledWith(
      attempt,
      expect.stringContaining("PAT mode"),
    );
    expect(ensureWorkflowCascadeForOffer).toHaveBeenCalledWith(
      attempt.attemptId,
      expect.anything(),
    );
    expect(notifyRunnerStartFailures).toHaveBeenCalledTimes(1);
    expect(cleanupCurrentWorkflowRunnerResources).toHaveBeenCalledWith(attempt);
  });

  it("terminalizes a missing dedicated capability secret", async () => {
    config.workflowRunnerCapabilitySecret = undefined;
    expect(await dispatchWorkflowRunner(job)).toBe("accepted");
    expect(failWorkflowRunnerAttempt).toHaveBeenCalledWith(
      attempt,
      expect.stringContaining("WORKFLOW_RUNNER_CAPABILITY_SECRET"),
    );
  });

  it("retains a claimed attempt for reconciliation after a transient API failure", async () => {
    ensureCurrentWorkflowRunnerResources.mockRejectedValueOnce(
      new TestWorkflowRunnerResourceError("transient", "Kubernetes unavailable"),
    );
    expect(await dispatchWorkflowRunner(job)).toBe("accepted");
    expect(failWorkflowRunnerAttempt).not.toHaveBeenCalled();
    expect(cleanupCurrentWorkflowRunnerResources).not.toHaveBeenCalled();
  });
});
