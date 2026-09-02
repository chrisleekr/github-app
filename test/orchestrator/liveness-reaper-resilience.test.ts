import type { SQL } from "bun";
import { beforeEach, describe, expect, it, mock } from "bun:test";

import { waitFor } from "../utils/assertions";

const expiredRun = {
  id: crypto.randomUUID(),
  workflow_name: "triage",
  owner_kind: "daemon" as const,
  owner_id: "daemon-expired",
};
const expireWorkflowAttempts = mock(() => Promise.resolve([expiredRun]));
const expireQueuedWorkflowDispatches = mock(() => Promise.resolve([]));
const fakeSql = (() => Promise.resolve([])) as unknown as SQL;

void mock.module("../../src/workflows/runs-store", () => ({
  expireQueuedWorkflowDispatches,
  expireWorkflowAttempts,
}));
void mock.module("../../src/orchestrator/valkey-cleanup", () => ({
  reapOrphanProcessingLists: mock(() => Promise.resolve(0)),
}));
void mock.module("../../src/db", () => ({
  getDb: () => null,
  requireDb: () => fakeSql,
}));
void mock.module("../../src/workflows/completion-reconciler", () => ({
  reconcilePendingWorkflowCascades: mock(() => Promise.resolve(0)),
}));
void mock.module("../../src/workflows/dispatch-outbox", () => ({
  publishPendingWorkflowRuns: mock(() => Promise.resolve(0)),
  publishWorkflowRunById: mock(() => Promise.resolve(true)),
}));
void mock.module("../../src/orchestrator/workflow-expiry-notifier", () => ({
  notifyExpiredWorkflowDispatches: mock(() => Promise.resolve()),
  notifyExpiredWorkflowAttempts: mock(() => Promise.resolve()),
  notifyDisconnectedDaemonWorkflows: mock(() => Promise.resolve()),
}));
void mock.module("../../src/orchestrator/workflow-runner-reconciler", () => ({
  reconcileWorkflowRunners: mock(() => Promise.resolve()),
}));
void mock.module("../../src/db/queries/scheduled-actions-store", () => ({
  clearInFlightByJobId: mock(() => Promise.resolve()),
}));
void mock.module("../../src/orchestrator/valkey", () => ({
  requireValkeyClient: () => {
    throw new Error("Valkey unavailable");
  },
}));

describe("liveness reaper failure isolation", () => {
  beforeEach(() => {
    expireQueuedWorkflowDispatches.mockReset();
    expireQueuedWorkflowDispatches.mockResolvedValue([]);
    expireWorkflowAttempts.mockReset();
    expireWorkflowAttempts.mockResolvedValue([expiredRun]);
  });

  it("expires database leases when Valkey liveness reads fail", async () => {
    const { reapOnce } = await import("../../src/orchestrator/liveness-reaper");

    const result = await reapOnce(fakeSql);

    expect(expireWorkflowAttempts).toHaveBeenCalledWith(fakeSql);
    expect(result.workflowRunsReaped).toEqual([expiredRun]);
    expect(result.daemonsMarkedInactive).toBe(0);
  });

  it("coalesces overlapping ticks and waits for the active pass during stop", async () => {
    let release!: (rows: never[]) => void;
    expireWorkflowAttempts.mockImplementationOnce(
      () =>
        new Promise<never[]>((resolve) => {
          release = resolve;
        }),
    );
    const { config } = await import("../../src/config");
    const { startLivenessReaper, stopLivenessReaper } =
      await import("../../src/orchestrator/liveness-reaper");
    const originalInterval = config.livenessReaperIntervalMs;
    (config as { livenessReaperIntervalMs: number }).livenessReaperIntervalMs = 5;
    try {
      startLivenessReaper();
      await waitFor(() => expireWorkflowAttempts.mock.calls.length === 1);
      await Bun.sleep(25);
      expect(expireWorkflowAttempts).toHaveBeenCalledTimes(1);

      let stopped = false;
      const stopping = stopLivenessReaper().then(() => {
        stopped = true;
      });
      await Bun.sleep(5);
      expect(stopped).toBe(false);

      release([]);
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      release?.([]);
      await stopLivenessReaper();
      (config as { livenessReaperIntervalMs: number }).livenessReaperIntervalMs = originalInterval;
    }
  });
});
