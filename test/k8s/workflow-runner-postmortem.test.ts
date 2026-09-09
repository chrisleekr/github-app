import { beforeEach, describe, expect, it, mock } from "bun:test";

const readNamespacedPod = mock(
  (_input: { name: string; namespace: string }): Promise<unknown> => Promise.resolve({}),
);
const readNamespacedPodLog = mock(
  (_input: {
    name: string;
    namespace: string;
    container?: string;
    tailLines?: number;
    limitBytes?: number;
  }): Promise<string> => Promise.resolve(""),
);
const core = { readNamespacedPod, readNamespacedPodLog };

void mock.module("../../src/config", () => ({
  config: { workflowRunnerNamespace: "runner-ns" },
}));

void mock.module("../../src/k8s/ephemeral-daemon-spawner", () => ({
  loadKubernetesClient: (): { core: typeof core } => ({ core }),
}));

void mock.module("../../src/logger", () => ({
  logger: {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  },
}));

const { readWorkflowRunnerPostMortem } = await import("../../src/k8s/workflow-runner-postmortem");
const { workflowRunnerResourceNames } = await import("../../src/k8s/workflow-runner-spawner");

const attemptId = "22222222-2222-4222-8222-222222222222";
const { podName } = workflowRunnerResourceNames(attemptId);

function oomKilledPod(): unknown {
  return {
    status: {
      phase: "Failed",
      containerStatuses: [
        {
          name: "runner",
          state: {
            terminated: {
              exitCode: 137,
              reason: "OOMKilled",
              signal: 9,
              message: null,
              startedAt: new Date("2026-09-06T11:41:28Z"),
              finishedAt: new Date("2026-09-06T11:54:38Z"),
            },
          },
        },
      ],
    },
  };
}

describe("readWorkflowRunnerPostMortem", () => {
  beforeEach(() => {
    readNamespacedPod.mockReset();
    readNamespacedPodLog.mockReset();
    readNamespacedPodLog.mockImplementation(() => Promise.resolve(""));
  });

  it("reports the terminated container state that lease expiry cannot", async () => {
    readNamespacedPod.mockImplementation(() => Promise.resolve(oomKilledPod()));
    readNamespacedPodLog.mockImplementation(() => Promise.resolve("cloning repo\ncrash\n"));

    const postMortem = await readWorkflowRunnerPostMortem({ attemptId });

    expect(postMortem).toEqual({
      podName,
      podPhase: "Failed",
      podReason: null,
      podMessage: null,
      exitCode: 137,
      reason: "OOMKilled",
      signal: 9,
      message: null,
      startedAt: "2026-09-06T11:41:28.000Z",
      finishedAt: "2026-09-06T11:54:38.000Z",
      logTail: "cloning repo\ncrash\n",
      logError: null,
    });
    expect(readNamespacedPodLog.mock.calls[0]?.[0]).toMatchObject({
      name: podName,
      namespace: "runner-ns",
      container: "runner",
      tailLines: 200,
      // Must stay well above the 16 KB tail. `limitBytes` stops the server after
      // N bytes of an oldest-first stream, so a ceiling equal to the tail would
      // drop the newest lines, which are the crash.
      limitBytes: 262_144,
    });
  });

  it("keeps the newest lines when the log exceeds the tail cap", async () => {
    readNamespacedPod.mockImplementation(() => Promise.resolve(oomKilledPod()));
    readNamespacedPodLog.mockImplementation(() =>
      Promise.resolve(`${"o".repeat(20_000)}\nFATAL: out of memory\n`),
    );

    const postMortem = await readWorkflowRunnerPostMortem({ attemptId });

    expect(postMortem?.logTail).toEndWith("FATAL: out of memory\n");
    expect(postMortem?.logTail.length).toBe(16_384);
  });

  // Node-pressure eviction is a Pod-level verdict; the container carries no
  // terminated state at all, so reading only containerStatuses would record an
  // all-null post-mortem and the failure comment would say nothing.
  it("reports a node-pressure eviction from the Pod-level status", async () => {
    readNamespacedPod.mockImplementation(() =>
      Promise.resolve({
        status: {
          phase: "Failed",
          reason: "Evicted",
          message: "The node was low on resource: ephemeral-storage.",
          containerStatuses: [],
        },
      }),
    );

    const postMortem = await readWorkflowRunnerPostMortem({ attemptId });

    expect(postMortem?.podReason).toBe("Evicted");
    expect(postMortem?.podMessage).toContain("ephemeral-storage");
    expect(postMortem?.reason).toBeNull();
  });

  // Every `stalled` startup reason except PodFailed describes a container that
  // never ran, which is the shape the reconciler meets most often.
  it("returns an empty container record when the container never started", async () => {
    readNamespacedPod.mockImplementation(() =>
      Promise.resolve({ status: { phase: "Pending", containerStatuses: [] } }),
    );

    const postMortem = await readWorkflowRunnerPostMortem({ attemptId });

    expect(postMortem).toMatchObject({ podPhase: "Pending", reason: null, exitCode: null });
  });

  // The client deserializes timestamps to Date; raw API JSON yields strings.
  it("passes through timestamps that arrive as strings", async () => {
    readNamespacedPod.mockImplementation(() =>
      Promise.resolve({
        status: {
          phase: "Failed",
          containerStatuses: [
            {
              name: "runner",
              state: {
                terminated: {
                  exitCode: 137,
                  reason: "OOMKilled",
                  startedAt: "2026-09-06T11:41:28Z",
                  finishedAt: "2026-09-06T11:54:38Z",
                },
              },
            },
          ],
        },
      }),
    );

    const postMortem = await readWorkflowRunnerPostMortem({ attemptId });

    expect(postMortem?.startedAt).toBe("2026-09-06T11:41:28Z");
    expect(postMortem?.finishedAt).toBe("2026-09-06T11:54:38Z");
  });

  it("strips secrets out of the captured log tail", async () => {
    readNamespacedPod.mockImplementation(() => Promise.resolve(oomKilledPod()));
    readNamespacedPodLog.mockImplementation(() =>
      Promise.resolve(`token=ghs_${"a".repeat(36)} done`),
    );

    const postMortem = await readWorkflowRunnerPostMortem({ attemptId });

    expect(postMortem?.logTail).toBe("token= done");
  });

  // A missing pods/log RBAC verb must degrade to status-only, not lose the
  // whole post-mortem: the exit code alone still separates OOM from crash.
  it("keeps the container status when the log read is refused", async () => {
    readNamespacedPod.mockImplementation(() => Promise.resolve(oomKilledPod()));
    readNamespacedPodLog.mockImplementation(() =>
      Promise.reject(new Error("HTTP-Code: 403 forbidden: pods/log")),
    );

    const postMortem = await readWorkflowRunnerPostMortem({ attemptId });

    expect(postMortem?.reason).toBe("OOMKilled");
    expect(postMortem?.logTail).toBe("");
    expect(postMortem?.logError).toContain("403");
  });

  it("falls back to lastState for a container kubelet already replaced", async () => {
    readNamespacedPod.mockImplementation(() =>
      Promise.resolve({
        status: {
          phase: "Failed",
          containerStatuses: [
            {
              name: "runner",
              state: {},
              lastState: { terminated: { exitCode: 1, reason: "Error" } },
            },
          ],
        },
      }),
    );

    const postMortem = await readWorkflowRunnerPostMortem({ attemptId });

    expect(postMortem?.exitCode).toBe(1);
    expect(postMortem?.reason).toBe("Error");
  });

  it("returns null once the Pod is gone", async () => {
    readNamespacedPod.mockImplementation(() => Promise.reject(new Error("not found")));

    expect(await readWorkflowRunnerPostMortem({ attemptId })).toBeNull();
    expect(readNamespacedPodLog).not.toHaveBeenCalled();
  });
});
