import type { V1ContainerStateTerminated, V1Pod } from "@kubernetes/client-node";

import { config } from "../config";
import { redactSecrets } from "../utils/sanitize";
import { loadKubernetesClient } from "./ephemeral-daemon-spawner";
import { workflowRunnerResourceNames } from "./workflow-runner-spawner";

const RUNNER_CONTAINER = "runner";

// The Pod and its logs are deleted on cleanup, seconds after the run is
// terminalized, and nothing outside the cluster is a dependable second copy:
// a log pipeline can retain counts while returning no searchable events. Keep
// enough tail to hold a stack trace, capped so one runaway line cannot bloat
// the `workflow_runs` row or the controller's own log.
const LOG_TAIL_LINES = 200;
const LOG_TAIL_BYTES = 16_384;
// A ceiling on the transfer, not the tail. `limitBytes` stops the server after N
// bytes of a stream that arrives oldest-first, so setting it to LOG_TAIL_BYTES
// would discard the newest lines, which is exactly the crash. Kept well above
// the tail so the local slice is what decides, while one pathological line still
// cannot pull an unbounded body into the controller.
const LOG_READ_CEILING_BYTES = 262_144;
// A Kubernetes error body can be a full HTML page; only the head identifies it.
const LOG_ERROR_CHARS = 200;

/** Why the runner container died, plus the runner's own last output. */
export interface RunnerPodPostMortem {
  readonly podName: string;
  readonly podPhase: string;
  /**
   * Pod-level verdict, set by the node rather than the container runtime.
   * Node-pressure eviction lands here as `Evicted`, never in the container's
   * terminated state, so without these an ephemeral-storage kill records an
   * all-null post-mortem and the failure comment says nothing.
   */
  readonly podReason: string | null;
  readonly podMessage: string | null;
  readonly exitCode: number | null;
  readonly reason: string | null;
  readonly signal: number | null;
  readonly message: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly logTail: string;
  /** Why `logTail` is empty, when it is. Null when the read succeeded. */
  readonly logError: string | null;
}

function terminatedState(pod: V1Pod): V1ContainerStateTerminated | undefined {
  const status = pod.status?.containerStatuses?.find((c) => c.name === RUNNER_CONTAINER);
  // `lastState` holds the exit of a container kubelet already replaced. The
  // runner spec uses restartPolicy Never so it is normally empty, but reading
  // it costs nothing and covers a restart the spec did not intend.
  return status?.state?.terminated ?? status?.lastState?.terminated;
}

/** The client deserializes these to `Date`; raw API JSON yields strings. */
function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

async function readLogTail(
  podName: string,
  namespace: string,
): Promise<{ readonly tail: string; readonly error: string | null }> {
  try {
    const raw = await loadKubernetesClient().core.readNamespacedPodLog({
      name: podName,
      namespace,
      container: RUNNER_CONTAINER,
      tailLines: LOG_TAIL_LINES,
      limitBytes: LOG_READ_CEILING_BYTES,
    });
    // Runner stdout echoes repository content and may carry a token the agent
    // printed, so it is stripped before it reaches the controller log or the
    // run row. Same rule as every other output path (security invariant #2).
    // Sliced from the end: the last lines before the kill are the diagnostic
    // ones. redactSecrets only deletes bytes, so this caps the redacted text.
    return { tail: redactSecrets(raw).body.slice(-LOG_TAIL_BYTES), error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { tail: "", error: message.slice(0, LOG_ERROR_CHARS) };
  }
}

/** Node-level verdict. An eviction appears only here, never on the container. */
function podFields(pod: V1Pod): Pick<RunnerPodPostMortem, "podPhase" | "podReason" | "podMessage"> {
  return {
    podPhase: pod.status?.phase ?? "unknown",
    podReason: pod.status?.reason ?? null,
    podMessage: pod.status?.message ?? null,
  };
}

/** Container-level verdict. All null when the container never ran. */
function containerFields(
  pod: V1Pod,
): Omit<
  RunnerPodPostMortem,
  "podName" | "podPhase" | "podReason" | "podMessage" | "logTail" | "logError"
> {
  const state = terminatedState(pod);
  return {
    exitCode: state?.exitCode ?? null,
    reason: state?.reason ?? null,
    signal: state?.signal ?? null,
    message: state?.message ?? null,
    startedAt: isoOrNull(state?.startedAt),
    finishedAt: isoOrNull(state?.finishedAt),
  };
}

/**
 * Read the runner Pod's cause of death while the Pod still exists.
 *
 * Lease expiry is a symptom: it says the runner stopped renewing, never why.
 * The answer lives in the container's terminated state (an OOMKill and a crash
 * are both "stopped renewing") and in its final log lines, and both are
 * destroyed with the Pod. Returns null when the Pod is already gone, since the
 * caller's failure path does not depend on this.
 */
export async function readWorkflowRunnerPostMortem(attempt: {
  readonly attemptId: string;
}): Promise<RunnerPodPostMortem | null> {
  const namespace = config.workflowRunnerNamespace;
  const { podName } = workflowRunnerResourceNames(attempt.attemptId);
  let pod: V1Pod;
  try {
    pod = await loadKubernetesClient().core.readNamespacedPod({ name: podName, namespace });
  } catch {
    return null;
  }
  const { tail, error } = await readLogTail(podName, namespace);
  return { podName, ...podFields(pod), ...containerFields(pod), logTail: tail, logError: error };
}
