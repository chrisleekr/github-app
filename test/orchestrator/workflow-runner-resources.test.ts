import { beforeEach, describe, expect, it, mock } from "bun:test";

import { waitFor } from "../utils/assertions";

const attemptId = crypto.randomUUID();
const attempt = {
  runId: crypto.randomUUID(),
  attemptId,
  runnerId: `workflow-runner:${attemptId}`,
  executionDeliveryId: "delivery-16",
  workflowName: "review" as const,
  attemptDeadlineAt: new Date("2026-08-23T04:10:00Z"),
};
const ensureWorkflowRunnerResources = mock(() => Promise.resolve({ phase: "running" as const }));
const deleteWorkflowRunnerResources = mock(() => Promise.resolve(true));
const getWorkflowRunnerRegistrationState = mock(() =>
  Promise.resolve({ state: "ready" as const, attempt }),
);
const markWorkflowRunnerResourcesCleaned = mock(() => Promise.resolve(true));

void mock.module("../../src/k8s/workflow-runner-spawner", () => ({
  deleteWorkflowRunnerResources,
  ensureWorkflowRunnerResources,
}));
void mock.module("../../src/orchestrator/workflow-runner-store", () => ({
  getWorkflowRunnerRegistrationState,
  markWorkflowRunnerResourcesCleaned,
}));

const {
  cleanupCurrentWorkflowRunnerResources,
  ensureCurrentWorkflowRunnerResources,
  resetWorkflowRunnerResourceChainsForTests,
} = await import("../../src/orchestrator/workflow-runner-resources");

const input = {
  attempt,
  capability: "wfr1.capability",
  image: `registry.example/runner@sha256:${"a".repeat(64)}`,
  orchestratorUrl: "wss://controller.example/ws",
};

describe("workflow runner resource operation ordering", () => {
  beforeEach(() => {
    resetWorkflowRunnerResourceChainsForTests();
    ensureWorkflowRunnerResources.mockReset();
    ensureWorkflowRunnerResources.mockResolvedValue({ phase: "running" });
    deleteWorkflowRunnerResources.mockReset();
    deleteWorkflowRunnerResources.mockResolvedValue(true);
    getWorkflowRunnerRegistrationState.mockReset();
    getWorkflowRunnerRegistrationState.mockResolvedValue({ state: "ready", attempt });
    markWorkflowRunnerResourcesCleaned.mockClear();
  });

  it("does not recreate resources after terminal cleanup won the chain", async () => {
    await cleanupCurrentWorkflowRunnerResources(attempt);
    getWorkflowRunnerRegistrationState.mockResolvedValueOnce({ state: "completed" });

    expect(await ensureCurrentWorkflowRunnerResources(input)).toEqual({ state: "terminal" });
    expect(ensureWorkflowRunnerResources).not.toHaveBeenCalled();
    expect(deleteWorkflowRunnerResources).toHaveBeenCalledTimes(2);
  });

  it("cleans resources when terminalization races an in-progress ensure", async () => {
    let releaseEnsure!: () => void;
    const ensureGate = new Promise<void>((resolve) => {
      releaseEnsure = resolve;
    });
    ensureWorkflowRunnerResources.mockImplementationOnce(() => ensureGate);
    getWorkflowRunnerRegistrationState
      .mockResolvedValueOnce({ state: "ready", attempt })
      .mockResolvedValueOnce({ state: "completed" });

    const ensuring = ensureCurrentWorkflowRunnerResources(input);
    await waitFor(() => ensureWorkflowRunnerResources.mock.calls.length > 0);
    const cleaning = cleanupCurrentWorkflowRunnerResources(attempt);
    releaseEnsure();

    expect(await ensuring).toEqual({ state: "terminal" });
    await cleaning;
    expect(deleteWorkflowRunnerResources).toHaveBeenCalledTimes(2);
    expect(markWorkflowRunnerResourcesCleaned).toHaveBeenCalledTimes(2);
  });

  it("surfaces the Pod startup phase alongside a ready attempt", async () => {
    // The reconciler reads this to tell a Pod that is still pulling its image
    // from a runner that will never report in.
    ensureWorkflowRunnerResources.mockResolvedValueOnce({ phase: "starting" });

    expect(await ensureCurrentWorkflowRunnerResources(input)).toEqual({
      state: "ready",
      startup: { phase: "starting" },
    });
  });

  it("leaves resources intact while a durable result awaits projection", async () => {
    getWorkflowRunnerRegistrationState.mockResolvedValueOnce({
      state: "result-pending",
      executionDeliveryId: attempt.executionDeliveryId,
      payload: {},
    });

    expect(await ensureCurrentWorkflowRunnerResources(input)).toEqual({ state: "result-pending" });
    expect(ensureWorkflowRunnerResources).not.toHaveBeenCalled();
    expect(deleteWorkflowRunnerResources).not.toHaveBeenCalled();
  });
});
