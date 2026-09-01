import { CoreV1Api, KubeConfig, type V1Pod } from "@kubernetes/client-node";

import { config } from "../config";
import { logger } from "../logger";
import { K8S_SPAWN_LOG_EVENTS } from "../orchestrator/k8s-spawn-log-fields";
import { redactErrorMessage } from "../utils/log-redaction";

const DAEMON_PROCESS_GUARD_PATH = "/usr/local/lib/github-app/daemon-process-guard.so";

/**
 * Typed errors the ephemeral-daemon spawner can throw. Distinguishing
 * `infra-absent` from generic K8s API failures lets the router map them
 * to the single `ephemeral-spawn-failed` dispatch reason while keeping
 * enough detail on the log line that an operator can tell whether the
 * problem is "K8s auth is missing" vs "K8s API is down".
 */
export type EphemeralSpawnErrorKind =
  | "infra-absent" // KUBERNETES_SERVICE_HOST + KUBECONFIG both unresolvable
  | "auth-load-failed" // kubeconfig present but unreadable / malformed
  | "api-rejected" // K8s API returned a 4xx (validation, RBAC, etc.)
  | "api-unavailable"; // K8s API unreachable (5xx, network)

export class EphemeralSpawnError extends Error {
  constructor(
    readonly kind: EphemeralSpawnErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "EphemeralSpawnError";
  }
}

let cachedClient: { core: CoreV1Api } | undefined;

export function loadKubernetesClient(): { core: CoreV1Api } {
  if (cachedClient !== undefined) return cachedClient;

  const kc = new KubeConfig();
  const inCluster = (process.env["KUBERNETES_SERVICE_HOST"]?.trim().length ?? 0) > 0;
  const hasKubeconfig = (process.env["KUBECONFIG"]?.trim().length ?? 0) > 0;

  if (!inCluster && !hasKubeconfig) {
    throw new EphemeralSpawnError(
      "infra-absent",
      "Kubernetes auth not configured: neither KUBERNETES_SERVICE_HOST (in-cluster) nor KUBECONFIG (out-of-cluster) is set",
    );
  }

  try {
    if (inCluster) {
      kc.loadFromCluster();
    } else {
      kc.loadFromDefault();
    }
  } catch {
    throw new EphemeralSpawnError(
      "auth-load-failed",
      "Kubernetes authentication configuration could not be loaded",
    );
  }

  cachedClient = { core: kc.makeApiClient(CoreV1Api) };
  return cachedClient;
}

/** Reset the cached client. Test-only. */
export function _resetK8sClientForTests(): void {
  cachedClient = undefined;
}

export interface SpawnEphemeralDaemonInput {
  /**
   * Delivery ID that triggered the spawn. Used only for observability
   * (Pod name suffix + label): ephemeral daemons don't handle only this
   * delivery, they enter the pool and may claim whatever job the
   * orchestrator offers them.
   */
  readonly deliveryId: string;
  /** Image to run. Defaults to the value the orchestrator was deployed with. */
  readonly image: string;
  /**
   * WebSocket URL the ephemeral daemon will connect to. Required because
   * the orchestrator's public URL is not derivable from inside the
   * cluster without external configuration.
   */
  readonly orchestratorUrl: string;
  /**
   * Optional activeDeadlineSeconds: a hard K8s-enforced ceiling on the
   * Pod's wall-clock lifetime. Defaults to 1 hour so a wedged ephemeral
   * daemon can't outlive its installation-token budget.
   */
  readonly activeDeadlineSeconds?: number;
  /**
   * The scaler verdict that drove this spawn. Observability-only: carried on
   * the `k8s.spawn.*` events so an operator can break spawn outcomes down by
   * trigger.
   */
  readonly trigger?: "triage-heavy" | "queue-overflow";
}

/**
 * Build a Pod spec for a single ephemeral daemon.
 *
 * - `restartPolicy: Never`, if the daemon crashes, K8s must not revive it
 *   under the same identity; the orchestrator will spawn a fresh one on
 *   the next heavy signal.
 * - `activeDeadlineSeconds`: belt-and-suspenders: the daemon self-exits
 *   on idle, but a bug in the idle loop must not leak a long-running Pod.
 * - `DAEMON_EPHEMERAL=true`: flips the daemon into idle-exit mode.
 * - `envFrom: secretRef: <EPHEMERAL_DAEMON_SECRET_NAME>`, carries provider and
 *   handshake credentials. The operator provisions this Secret out-of-band and
 *   chooses its scope.
 */
// K8s label values must match `([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]` and
// be ≤63 chars. Strip invalid chars and trim leading/trailing non-alphanum so a
// malformed deliveryId cannot cause the API server to reject the Pod.
function sanitizeLabelValue(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .slice(0, 63)
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");
  return cleaned.length > 0 ? cleaned : "unknown";
}

function buildEphemeralDaemonPodSpec(input: SpawnEphemeralDaemonInput): V1Pod {
  // K8s Pod names are DNS-1123 labels and must be ≤63 chars. Budget:
  //   "ephemeral-daemon-" (17) + suffix + "-" (1) + base36-timestamp (≤11).
  // Clamp `nameSuffix` so the total stays ≤63 even when Date.now() grows
  // to its longest base36 form (~11 chars at year 15000).
  const timestampPart = Date.now().toString(36);
  const PREFIX_LEN = "ephemeral-daemon-".length; // 17
  const maxSuffixLen = Math.max(1, 63 - PREFIX_LEN - 1 - timestampPart.length);
  const nameSuffix =
    input.deliveryId
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-")
      .slice(0, maxSuffixLen)
      // Trim trailing non-alphanumerics so the name doesn't end on '-' before
      // the separator, DNS-1123 requires alphanumeric at both ends of the
      // Pod name, but the joining '-' + timestamp already guarantees the end.
      .replace(/^[^a-z0-9]+/, "") || "unknown";
  const podName = `ephemeral-daemon-${nameSuffix}-${timestampPart}`;
  const namespace = config.ephemeralDaemonNamespace;

  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: podName,
      namespace,
      labels: {
        "app.kubernetes.io/name": "github-app",
        "app.kubernetes.io/component": "ephemeral-daemon",
        "github-app/delivery-id": sanitizeLabelValue(input.deliveryId),
      },
    },
    spec: {
      restartPolicy: "Never",
      activeDeadlineSeconds: input.activeDeadlineSeconds ?? 3_600,
      // The ephemeral daemon never calls the K8s API itself, only the
      // orchestrator does. Refuse the default ServiceAccount token so an
      // agent subprocess running untrusted repo code cannot use it.
      automountServiceAccountToken: false,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "daemon",
          image: input.image,
          command: ["bun", "run", "dist/daemon/main.js"],
          // The Pod mounts exactly one Secret, named by
          // `EPHEMERAL_DAEMON_SECRET_NAME` and provisioned out-of-band. Scoping
          // it to daemon-only credentials is a deployment decision, not one this
          // code can enforce: pointing it at a Secret that also carries GitHub
          // App issuance or data-layer credentials hands those to the Pod. The
          // daemon needs:
          //   - `DAEMON_AUTH_TOKEN` (WS handshake)
          //   - `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` (Claude auth)
          //   - `AWS_*` chain (Bedrock provider)
          //   - `GITHUB_PERSONAL_ACCESS_TOKEN` (PAT mode only; optional)
          // Inlining these env vars here would expose them in
          // `kubectl get pod -o yaml` and the cluster's Pod audit log,
          // hence `envFrom: secretRef`.
          env: [
            { name: "DAEMON_EPHEMERAL", value: "true" },
            { name: "ORCHESTRATOR_URL", value: input.orchestratorUrl },
            // Explicit env entries override envFrom values. Keep the process
            // guard pinned if the mounted Secret contains a stale LD_PRELOAD.
            { name: "LD_PRELOAD", value: DAEMON_PROCESS_GUARD_PATH },
            {
              name: "EPHEMERAL_DAEMON_IDLE_TIMEOUT_MS",
              value: String(config.ephemeralDaemonIdleTimeoutMs),
            },
          ],
          envFrom: [{ secretRef: { name: config.ephemeralDaemonSecretName } }],
          securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: { drop: ["ALL"] },
          },
          resources: {
            requests: { cpu: "500m", memory: "1Gi" },
            limits: { cpu: "2000m", memory: "4Gi" },
          },
        },
      ],
    },
  };
}

/**
 * Submit a Pod spec for a single ephemeral daemon. Fire-and-forget from
 * the orchestrator's perspective: returns once the Pod is created, not
 * when the daemon connects. The daemon announces itself via
 * `daemon:register` when its WebSocket handshake completes.
 *
 * @throws {EphemeralSpawnError} on missing K8s auth, unloadable kubeconfig,
 *         or K8s API failure: the router maps these to the
 *         `ephemeral-spawn-failed` dispatch reason.
 */
export async function spawnEphemeralDaemon(input: SpawnEphemeralDaemonInput): Promise<string> {
  // Both client load failures (infra-absent / auth-load-failed) and API
  // failures (api-rejected / api-unavailable) emit a single k8s.spawn.failed
  // line keyed by kind. `api_call_ms` is attached only when the K8s API was
  // actually called (the load-failure kinds throw before it).
  let client: { core: CoreV1Api };
  try {
    client = loadKubernetesClient();
  } catch (err) {
    emitSpawnFailed(input, err, undefined);
    throw err;
  }

  const pod = buildEphemeralDaemonPodSpec(input);
  const namespace = config.ephemeralDaemonNamespace;

  const t0 = Date.now();
  logger.info(
    {
      event: K8S_SPAWN_LOG_EVENTS.attempted,
      delivery_id: input.deliveryId,
      ...(input.trigger !== undefined && { trigger: input.trigger }),
    },
    "Ephemeral daemon spawn attempted",
  );

  try {
    await client.core.createNamespacedPod({ namespace, body: pod });
  } catch (err) {
    const apiCallMs = Date.now() - t0;
    const message = err instanceof Error ? err.message : String(err);
    const status =
      (err as { statusCode?: number; response?: { statusCode?: number } })?.statusCode ??
      (err as { response?: { statusCode?: number } })?.response?.statusCode;
    const kind: EphemeralSpawnErrorKind =
      typeof status === "number" && status >= 400 && status < 500
        ? "api-rejected"
        : "api-unavailable";
    const spawnErr = new EphemeralSpawnError(
      kind,
      `Failed to create ephemeral-daemon Pod: ${message}`,
    );
    emitSpawnFailed(input, spawnErr, apiCallMs);
    throw spawnErr;
  }

  const apiCallMs = Date.now() - t0;
  const podName = pod.metadata?.name ?? "<unknown>";
  logger.info(
    {
      event: K8S_SPAWN_LOG_EVENTS.succeeded,
      delivery_id: input.deliveryId,
      ...(input.trigger !== undefined && { trigger: input.trigger }),
      pod_name: podName,
      namespace,
      api_call_ms: apiCallMs,
    },
    "Ephemeral daemon Pod created",
  );
  return podName;
}

/**
 * Emit one k8s.spawn.failed line. `kind` falls back to `api-unavailable` for a
 * non-EphemeralSpawnError throw (should not happen, but keeps the field present).
 * Never logs the raw error text: `redactErrorMessage` strips secrets, and the
 * structured line carries only bounded metadata.
 */
function emitSpawnFailed(
  input: SpawnEphemeralDaemonInput,
  err: unknown,
  apiCallMs: number | undefined,
): void {
  const kind: EphemeralSpawnErrorKind =
    err instanceof EphemeralSpawnError ? err.kind : "api-unavailable";
  logger.error(
    {
      event: K8S_SPAWN_LOG_EVENTS.failed,
      delivery_id: input.deliveryId,
      kind,
      ...(input.trigger !== undefined && { trigger: input.trigger }),
      ...(apiCallMs !== undefined && { api_call_ms: apiCallMs }),
      err: redactErrorMessage(err),
    },
    "Ephemeral daemon spawn failed",
  );
}
