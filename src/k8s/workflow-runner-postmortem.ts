import type { V1ContainerStateTerminated, V1Pod } from "@kubernetes/client-node";

import { config } from "../config";
import { logger } from "../logger";
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
// the tail so the local slice normally decides, while one pathological line
// still cannot pull an unbounded body into the controller. When the 200-line
// window does exceed it the newest lines are lost, which `logError` reports.
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
  /**
   * Why `logTail` is not the whole story: absent because the read failed, or
   * short at the far end because the transfer ceiling stopped it. Null when the
   * read returned everything the tail window asked for.
   */
  readonly logError: string | null;
}

interface TerminatedSource {
  readonly state: V1ContainerStateTerminated | undefined;
  /**
   * True when the verdict came from a container kubelet already replaced, which
   * means the running container's log belongs to a different process than this
   * exit code. The log read follows this so the two describe one container.
   */
  readonly fromLastState: boolean;
}

function terminatedState(pod: V1Pod): TerminatedSource {
  const status = pod.status?.containerStatuses?.find((c) => c.name === RUNNER_CONTAINER);
  const current = status?.state?.terminated;
  if (current !== undefined) return { state: current, fromLastState: false };
  // `lastState` holds the exit of a container kubelet already replaced. The
  // runner spec uses restartPolicy Never so it is normally empty, but reading
  // it costs nothing and covers a restart the spec did not intend.
  const replaced = status?.lastState?.terminated;
  return { state: replaced, fromLastState: replaced !== undefined };
}

/**
 * The newest bytes of the log, bounded and safe to store.
 *
 * Cut in UTF-8, not in UTF-16 code units. Two reasons, both about what actually
 * lands in the row:
 *
 * Budget. `String.slice` counts code units, and an astral character costs two
 * of them but four bytes, so a slice of emoji-heavy agent output would be about
 * four times this constant once written to `workflow_runs` and echoed into the
 * controller log.
 *
 * Writability. A cut inside a character leaves a lone surrogate, which
 * `JSON.stringify` renders as a `\udXXX` escape that Postgres rejects on the
 * `jsonb` cast. The caller swallows that throw and writes nothing, so the
 * one-shot fence never closes and every later pass re-reads the Pod and fails
 * identically: the post-mortem would be lost on exactly the runs with the most
 * log to show. Starting on a character boundary makes the result well-formed by
 * construction, and skipping the partial character rather than decoding it
 * keeps the budget exact, since each stray byte would otherwise become a
 * three-byte U+FFFD.
 *
 * The first line is left as the fragment it is. Advancing to the next newline
 * would read better, but a run whose window holds one long line and one short
 * one would then store the short one and discard the rest of the context.
 */
function boundedTail(body: string): string {
  const bytes = Buffer.from(body, "utf8");
  if (bytes.length <= LOG_TAIL_BYTES) return bytes.toString("utf8");
  let start = bytes.length - LOG_TAIL_BYTES;
  // 0b10xxxxxx is a UTF-8 continuation byte, so the cut landed mid-character.
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

/** The client deserializes these to `Date`; raw API JSON yields strings. */
function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

async function readLogTail(
  podName: string,
  namespace: string,
  previous: boolean,
): Promise<{ readonly tail: string; readonly error: string | null }> {
  try {
    const raw = await loadKubernetesClient().core.readNamespacedPodLog({
      name: podName,
      namespace,
      container: RUNNER_CONTAINER,
      tailLines: LOG_TAIL_LINES,
      limitBytes: LOG_READ_CEILING_BYTES,
      ...(previous ? { previous: true } : {}),
    });
    // Runner stdout echoes repository content and may carry a token the agent
    // printed, so it is stripped before it reaches the controller log or the
    // run row. Same rule as every other output path (security invariant #2).
    // Sliced from the end: the last lines before the kill are the diagnostic
    // ones. redactSecrets only deletes bytes, so this caps the redacted text.
    //
    // The ceiling applies to the whole 200-line window, which starts at the
    // oldest of those lines, so reaching it means the server stopped sending
    // before the runner's final output. The tail below is then from the middle
    // of the run, and saying nothing would let a reader take its last line for
    // the last line the runner wrote.
    const truncated = Buffer.byteLength(raw, "utf8") >= LOG_READ_CEILING_BYTES;
    return {
      tail: boundedTail(redactSecrets(raw).body),
      error: truncated
        ? `log read hit the ${LOG_READ_CEILING_BYTES}-byte transfer ceiling, so the runner's final lines are missing`
        : null,
    };
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
  state: V1ContainerStateTerminated | undefined,
): Omit<
  RunnerPodPostMortem,
  "podName" | "podPhase" | "podReason" | "podMessage" | "logTail" | "logError"
> {
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
  } catch (err) {
    // A collected Pod is the expected case and not worth a line. A refused or
    // failed read is neither, and it leaves the one-shot fence open, so every
    // later pass repeats it with nothing recorded to say why.
    logger.debug(
      { podName, namespace, err: err instanceof Error ? err.message : String(err) },
      "Workflow runner post-mortem Pod read failed",
    );
    return null;
  }
  // One container, one story: when the verdict comes from a container kubelet
  // already replaced, the running container's log belongs to a different
  // process, so the read follows the verdict rather than pairing an exit code
  // with someone else's output.
  const terminated = terminatedState(pod);
  const { tail, error } = await readLogTail(podName, namespace, terminated.fromLastState);
  return {
    podName,
    ...podFields(pod),
    ...containerFields(terminated.state),
    logTail: tail,
    logError: error,
  };
}
