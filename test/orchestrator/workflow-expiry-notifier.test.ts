import { beforeEach, describe, expect, it, mock } from "bun:test";

const setState = mock(() => Promise.resolve());
const addReaction = mock(() => Promise.resolve());
const findById = mock(() => Promise.resolve(null as unknown));
const markWorkflowFailureNotified = mock(() => Promise.resolve(true));
const findPendingWorkflowFailureNotifications = mock(() => Promise.resolve([]));
const getRepoInstallation = mock(() => Promise.resolve({ data: { id: 123 } }));
const mintedOctokit = {};
const mintInstallationToken = mock(() => Promise.resolve({ octokit: mintedOctokit }));
const revokeInstallationToken = mock(() => Promise.resolve(true));
const testConfig = {
  nodeEnv: "production",
  githubPersonalAccessToken: "test-token" as string | undefined,
  appId: "test-app" as string | undefined,
  privateKey: "test-key" as string | undefined,
};

void mock.module("../../src/config", () => ({
  config: testConfig,
}));
void mock.module("../../src/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
    child: mock(function (this: unknown) {
      return this;
    }),
  },
}));
void mock.module("octokit", () => ({
  Octokit: function MockOctokit(this: unknown): unknown {
    return this;
  },
  App: function MockApp(): unknown {
    return { octokit: { rest: { apps: { getRepoInstallation } } } };
  },
}));
void mock.module("../../src/utils/octokit-observability", () => ({
  observableOctokit: () =>
    function MockOctokit(this: unknown): unknown {
      return this;
    },
}));
void mock.module("../../src/utils/reactions", () => ({ addReaction }));
void mock.module("../../src/workflows/tracking-mirror", () => ({ setState }));
void mock.module("../../src/workflows/runs-store", () => ({
  findById,
  findPendingWorkflowFailureNotifications,
  markWorkflowFailureNotified,
}));
void mock.module("../../src/orchestrator/installation-token", () => ({
  mintInstallationToken,
  revokeInstallationToken,
}));

const {
  notifyExpiredWorkflowAttempts,
  notifyExpiredWorkflowDispatches,
  notifyRunnerStartFailures,
  reconcilePendingWorkflowFailureNotifications,
} = await import("../../src/orchestrator/workflow-expiry-notifier");

function row(
  id: string,
  parentRunId: string | null,
  failedReason: string,
): Record<string, unknown> {
  return {
    id,
    workflow_name: parentRunId === null ? "ship" : "review",
    target_type: "pr",
    target_owner: "acme",
    target_repo: "widgets",
    target_number: 42,
    parent_run_id: parentRunId,
    parent_step_index: parentRunId === null ? null : 3,
    status: "failed",
    state: { failedReason },
    tracking_comment_id: 100,
    delivery_id: "delivery-1",
    owner_kind: "daemon",
    owner_id: "sensitive-daemon-id",
    attempt_id: crypto.randomUUID(),
    lease_expires_at: null,
    runner_payload_issued_at: new Date(),
    attempt_completed_at: new Date(),
    cascade_completed_at: null,
    failure_notified_at: null,
    execution_delivery_id: "delivery-1",
    dispatch_enqueued_at: new Date(),
    trigger_comment_id: parentRunId === null ? 200 : null,
    trigger_event_type: parentRunId === null ? "issue_comment" : null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

describe("workflow expiry notifier", () => {
  beforeEach(() => {
    setState.mockClear();
    addReaction.mockClear();
    findById.mockReset();
    markWorkflowFailureNotified.mockClear();
    findPendingWorkflowFailureNotifications.mockReset();
    findPendingWorkflowFailureNotifications.mockResolvedValue([]);
    testConfig.githubPersonalAccessToken = "test-token";
    getRepoInstallation.mockClear();
    mintInstallationToken.mockReset();
    mintInstallationToken.mockResolvedValue({ octokit: mintedOctokit });
    revokeInstallationToken.mockReset();
    revokeInstallationToken.mockResolvedValue(true);
  });

  it("tells the reader nothing ran when the runner never received its payload", async () => {
    // A lease that expires during Pod startup has provably cloned nothing and
    // written nothing. Sending the reader to inspect the repository for damage
    // that cannot exist is what made this failure unreadable.
    testConfig.githubPersonalAccessToken = undefined;
    const expired = row("solo", null, "workflow execution lease expired");
    expired["runner_payload_issued_at"] = null;
    findById.mockImplementation((id: string) => Promise.resolve(id === "solo" ? expired : null));

    await notifyExpiredWorkflowAttempts([expired] as never);

    const call = setState.mock.calls[0] as unknown as [unknown, { humanMessage: string }];
    expect(call[1].humanMessage).toContain("The runner never started");
    expect(call[1].humanMessage).toContain("Re-triggering the workflow is safe.");
    expect(call[1].humanMessage).not.toContain("Inspect the repository");
  });

  it("keeps the inspect-the-repository warning once the runner held a token", async () => {
    testConfig.githubPersonalAccessToken = undefined;
    const expired = row("solo", null, "workflow execution lease expired");
    expired["runner_payload_issued_at"] = new Date();
    findById.mockImplementation((id: string) => Promise.resolve(id === "solo" ? expired : null));

    await notifyExpiredWorkflowAttempts([expired] as never);

    const call = setState.mock.calls[0] as unknown as [unknown, { humanMessage: string }];
    expect(call[1].humanMessage).toContain("Inspect the repository");
    expect(call[1].humanMessage).not.toContain("The runner never started");
  });

  it("notifies one top-level workflow with fixed text for duplicate expired children", async () => {
    testConfig.githubPersonalAccessToken = undefined;
    const parent = row("parent", null, "parent raw failure");
    const childA = row("child-a", "parent", "secret child A failure");
    const childB = row("child-b", "parent", "secret child B failure");
    findById.mockImplementation((id: string) => Promise.resolve(id === "parent" ? parent : null));

    await notifyExpiredWorkflowAttempts([childA, childB] as never);

    expect(setState).toHaveBeenCalledTimes(1);
    const call = setState.mock.calls[0] as unknown as [
      unknown,
      { runId: string; humanMessage: string; patch: Record<string, unknown> },
    ];
    expect(call[1].runId).toBe("parent");
    expect(call[1].patch).toEqual({ phase: "lease-expired" });
    expect(call[1].humanMessage).toContain("Workflow execution lease expired");
    expect(call[1].humanMessage).not.toContain("sensitive-daemon-id");
    expect(call[1].humanMessage).not.toContain("secret child");
    expect(addReaction).toHaveBeenCalledTimes(1);
    expect(addReaction).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "widgets",
        commentId: 200,
        eventType: "issue_comment",
        content: "confused",
      }),
    );
    expect(markWorkflowFailureNotified).toHaveBeenCalledTimes(2);
    expect(getRepoInstallation).toHaveBeenCalledTimes(1);
    expect(mintInstallationToken).toHaveBeenCalledTimes(1);
    expect(mintInstallationToken).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: 123, repositoryName: "widgets" }),
    );
    expect(revokeInstallationToken).toHaveBeenCalledTimes(1);
  });

  it("reports an immutable deadline without blaming lease renewal", async () => {
    const expired = row("deadline", null, "workflow execution deadline expired");

    await notifyExpiredWorkflowAttempts([expired] as never);

    const call = setState.mock.calls[0] as unknown as [
      unknown,
      { humanMessage: string; patch: Record<string, unknown> },
    ];
    expect(call[1].patch).toEqual({ phase: "deadline-expired" });
    expect(call[1].humanMessage).toContain("Workflow execution deadline expired");
    expect(call[1].humanMessage).toContain("immutable attempt deadline elapsed");
    expect(call[1].humanMessage).not.toContain("stopped renewing");
  });

  it("keeps the durable notification pending when GitHub projection fails", async () => {
    testConfig.githubPersonalAccessToken = undefined;
    const parent = row("parent", null, "failure");
    setState.mockRejectedValueOnce(new Error("GitHub unavailable"));

    await notifyExpiredWorkflowAttempts([parent] as never);

    expect(markWorkflowFailureNotified).not.toHaveBeenCalled();
    expect(revokeInstallationToken).toHaveBeenCalledWith(
      mintedOctokit,
      expect.anything(),
      expect.objectContaining({ runId: "parent", owner: "failure-notification" }),
    );
  });

  it("keeps the durable notification pending when the trigger reaction fails", async () => {
    const parent = row("parent", null, "failure");
    addReaction.mockRejectedValueOnce(new Error("GitHub unavailable"));

    await notifyExpiredWorkflowAttempts([parent] as never);

    expect(setState).toHaveBeenCalledTimes(1);
    expect(markWorkflowFailureNotified).not.toHaveBeenCalled();
  });

  it("projects and receipts a runner-start failure", async () => {
    const failed = row("failed", null, "create runner Pod failed (403)");

    await notifyRunnerStartFailures([failed] as never);

    const call = setState.mock.calls[0] as unknown as [
      unknown,
      { humanMessage: string; patch: Record<string, unknown> },
    ];
    expect(call[1].patch).toEqual({ phase: "runner-start-failed" });
    expect(call[1].humanMessage).toContain("create runner Pod failed (403)");
    expect(markWorkflowFailureNotified).toHaveBeenCalledTimes(1);
  });

  it("projects and receipts a queued dispatch expiry", async () => {
    const failed = row("dispatch-expired", null, "workflow dispatch deadline expired");
    failed.attempt_id = null;
    failed.state = {
      failedReason: "workflow dispatch deadline expired",
      phase: "dispatch-expired",
    };

    await notifyExpiredWorkflowDispatches([failed] as never);

    const call = setState.mock.calls[0] as unknown as [
      unknown,
      { humanMessage: string; patch: Record<string, unknown> },
    ];
    expect(call[1].patch).toEqual({ phase: "dispatch-expired" });
    expect(call[1].humanMessage).toContain("Workflow dispatch deadline expired");
    expect(markWorkflowFailureNotified).toHaveBeenCalledWith({
      runId: "dispatch-expired",
      attemptId: null,
    });
  });

  it("replays a durable missed expiry notification", async () => {
    const expired = row("expired", null, "workflow execution lease expired");
    expired.state = { failedReason: "workflow execution lease expired", phase: "lease-expired" };
    findPendingWorkflowFailureNotifications.mockResolvedValueOnce([
      { phase: "lease-expired", row: expired },
    ]);

    await reconcilePendingWorkflowFailureNotifications();

    expect(setState).toHaveBeenCalledTimes(1);
    expect(markWorkflowFailureNotified).toHaveBeenCalledTimes(1);
  });

  it("replays a durable missed deadline notification", async () => {
    const expired = row("deadline", null, "workflow execution deadline expired");
    expired.state = {
      failedReason: "workflow execution deadline expired",
      phase: "deadline-expired",
    };
    findPendingWorkflowFailureNotifications.mockResolvedValueOnce([
      { phase: "deadline-expired", row: expired },
    ]);

    await reconcilePendingWorkflowFailureNotifications();

    const call = setState.mock.calls[0] as unknown as [unknown, { patch: Record<string, unknown> }];
    expect(call[1].patch).toEqual({ phase: "deadline-expired" });
    expect(markWorkflowFailureNotified).toHaveBeenCalledTimes(1);
  });

  it("replays a durable missed runner-start notification", async () => {
    const failed = row("failed", null, "runner boundary mismatch");
    failed.state = { failedReason: "runner boundary mismatch", phase: "runner-start-failed" };
    findPendingWorkflowFailureNotifications.mockResolvedValueOnce([
      { phase: "runner-start-failed", row: failed },
    ]);

    await reconcilePendingWorkflowFailureNotifications();

    const call = setState.mock.calls[0] as unknown as [
      unknown,
      { humanMessage: string; patch: Record<string, unknown> },
    ];
    expect(call[1].patch).toEqual({ phase: "runner-start-failed" });
    expect(call[1].humanMessage).toContain("runner boundary mismatch");
    expect(markWorkflowFailureNotified).toHaveBeenCalledTimes(1);
  });

  it("replays a durable dispatch-expired notification", async () => {
    const failed = row("dispatch-expired", null, "workflow dispatch retries exhausted");
    failed.attempt_id = null;
    failed.state = {
      failedReason: "workflow dispatch retries exhausted",
      phase: "dispatch-expired",
    };
    findPendingWorkflowFailureNotifications.mockResolvedValueOnce([
      { phase: "dispatch-expired", row: failed },
    ]);

    await reconcilePendingWorkflowFailureNotifications();

    const call = setState.mock.calls[0] as unknown as [
      unknown,
      { humanMessage: string; patch: Record<string, unknown> },
    ];
    expect(call[1].patch).toEqual({ phase: "dispatch-expired" });
    expect(call[1].humanMessage).toContain("retries exhausted");
  });

  it("replays and receipts a durable daemon-disconnect notification", async () => {
    const disconnected = row("disconnected", null, "daemon disconnected during execution");
    disconnected.attempt_id = null;
    disconnected.state = {
      failedReason: "daemon disconnected during execution",
      phase: "orphaned",
    };
    findPendingWorkflowFailureNotifications.mockResolvedValueOnce([
      { phase: "orphaned", row: disconnected },
    ]);

    await reconcilePendingWorkflowFailureNotifications();

    const call = setState.mock.calls[0] as unknown as [
      unknown,
      { humanMessage: string; patch: Record<string, unknown> },
    ];
    expect(call[1].patch).toEqual({ phase: "orphaned" });
    expect(call[1].humanMessage).toContain("Daemon disconnected during execution");
    expect(markWorkflowFailureNotified).toHaveBeenCalledWith({
      runId: "disconnected",
      attemptId: null,
    });
  });

  it("replays a migration interruption with migration-specific guidance", async () => {
    const interrupted = row(
      "migration-interrupted",
      null,
      "workflow execution interrupted during isolated-runner migration",
    );
    interrupted.attempt_id = null;
    interrupted.state = {
      failedReason: "workflow execution interrupted during isolated-runner migration",
      phase: "migration-interrupted",
    };
    findPendingWorkflowFailureNotifications.mockResolvedValueOnce([
      { phase: "migration-interrupted", row: interrupted },
    ]);

    await reconcilePendingWorkflowFailureNotifications();

    const call = setState.mock.calls[0] as unknown as [
      unknown,
      { humanMessage: string; patch: Record<string, unknown> },
    ];
    expect(call[1].patch).toEqual({ phase: "migration-interrupted" });
    expect(call[1].humanMessage).toContain("execution interrupted during migration");
    expect(call[1].humanMessage).toContain("could not safely transfer");
    expect(markWorkflowFailureNotified).toHaveBeenCalledWith({
      runId: "migration-interrupted",
      attemptId: null,
    });
  });
});
