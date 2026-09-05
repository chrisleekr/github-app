import { isDeepStrictEqual } from "node:util";

import type {
  V1DeleteOptions,
  V1EnvVar,
  V1ObjectMeta,
  V1Pod,
  V1Secret,
} from "@kubernetes/client-node";

import { config } from "../config";
import { logger } from "../logger";
import { workflowRunnerUrl } from "../orchestrator/workflow-runner-capability";
import {
  WORKFLOW_RUNNER_ATTEMPT_DEADLINE_MS,
  type WorkflowRunnerAttempt,
} from "../orchestrator/workflow-runner-store";
import {
  WorkflowRunnerProviderConfigurationError,
  workflowRunnerProviderEnv,
} from "../shared/workflow-runner-provider";
import { loadKubernetesClient } from "./ephemeral-daemon-spawner";

const RUNNER_PROVIDER_SECRET = "workflow-runner-secrets";
const PROCESS_GUARD_PATH = "/usr/local/lib/github-app/daemon-process-guard.so";
const SHA256_IMAGE_DIGEST = /@sha256:[0-9a-f]{64}$/;
export const WORKFLOW_RUNNER_STORAGE_REQUEST = "2Gi";
export const WORKFLOW_RUNNER_STORAGE_LIMIT = "10Gi";
export const WORKFLOW_RUNNER_WORKSPACE_PATH = "/tmp/bot-workspaces";
// Deployment-configurable so a cluster can target a node pool it already
// labels and taints. Drives the nodeSelector AND the NoSchedule toleration.
export const WORKFLOW_RUNNER_NODE_LABEL = config.workflowRunnerNodeLabel;
export const WORKFLOW_RUNNER_NODE_VALUE = config.workflowRunnerNodeValue;
// Pinned by the admission boundary, so a runner may reference this Secret and no
// other. Empty emits no imagePullSecrets at all, which the boundary also allows.
export const WORKFLOW_RUNNER_IMAGE_PULL_SECRET = config.workflowRunnerImagePullSecret;
interface WorkflowRunnerResourceIdentity {
  readonly runId: string;
  readonly attemptId: string;
}

/**
 * What kubelet is doing with the runner Pod at this reconcile tick.
 *
 * The controller cannot tell "the runner died" from "the Pod has not started
 * yet" out of lease renewals alone, because neither renews. This is the missing
 * evidence: `starting` means kubelet is still making progress and the startup
 * lease should be extended rather than expired.
 */
export type RunnerPodStartup =
  | { readonly phase: "starting" }
  | { readonly phase: "running" }
  | { readonly phase: "stalled"; readonly reason: string };

// Waiting reasons kubelet retries indefinitely. Nothing the controller waits for
// resolves them, so they terminalize the attempt instead of burning the lease.
const STALLED_WAITING_REASONS = new Set([
  "CreateContainerConfigError",
  "CreateContainerError",
  "ErrImageNeverPull",
  "ErrImagePull",
  "ImagePullBackOff",
  "InvalidImageName",
]);

export function classifyPodStartup(pod: V1Pod): RunnerPodStartup {
  const reason = pod.status?.containerStatuses?.[0]?.state?.waiting?.reason;
  if (reason !== undefined && STALLED_WAITING_REASONS.has(reason)) {
    return { phase: "stalled", reason };
  }
  const phase = pod.status?.phase;
  if (phase === "Running" || phase === "Succeeded") return { phase: "running" };
  if (phase === "Failed") return { phase: "stalled", reason: "PodFailed" };
  // A Pod read back immediately after creation carries no status yet. Absent
  // status is "starting", so the first tick extends rather than assuming a
  // runner that has not reported in is already up.
  return { phase: "starting" };
}

export class WorkflowRunnerResourceError extends Error {
  constructor(
    readonly kind: "permanent" | "transient",
    message: string,
  ) {
    super(message);
    this.name = "WorkflowRunnerResourceError";
  }
}

function buildProviderEnvironment(): V1EnvVar[] {
  try {
    return workflowRunnerProviderEnv(config).map((entry) => {
      if (entry.secretKey === undefined) {
        if (entry.value === undefined) {
          throw new WorkflowRunnerProviderConfigurationError(
            `Workflow runner provider setting ${entry.name} has no value`,
          );
        }
        return { name: entry.name, value: entry.value };
      }
      return {
        name: entry.name,
        valueFrom: {
          secretKeyRef: {
            name: RUNNER_PROVIDER_SECRET,
            key: entry.secretKey,
            optional: false,
          },
        },
      };
    });
  } catch (err) {
    if (err instanceof WorkflowRunnerProviderConfigurationError) {
      throw new WorkflowRunnerResourceError("permanent", err.message);
    }
    throw err;
  }
}

export function workflowRunnerResourceNames(attemptId: string): {
  readonly podName: string;
  readonly secretName: string;
} {
  const suffix = attemptId.toLowerCase();
  return {
    podName: `workflow-runner-${suffix}`,
    secretName: `workflow-runner-${suffix}`,
  };
}

function labels(attempt: WorkflowRunnerResourceIdentity): Record<string, string> {
  return {
    "app.kubernetes.io/name": "github-app",
    "app.kubernetes.io/component": "workflow-runner",
    "github-app/workflow-run-id": attempt.runId,
    "github-app/workflow-attempt-id": attempt.attemptId,
  };
}

function buildSecret(attempt: WorkflowRunnerAttempt, capability: string, podUid: string): V1Secret {
  const { podName, secretName } = workflowRunnerResourceNames(attempt.attemptId);
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: secretName,
      namespace: config.workflowRunnerNamespace,
      labels: labels(attempt),
      ownerReferences: [
        {
          apiVersion: "v1",
          kind: "Pod",
          name: podName,
          uid: podUid,
          controller: true,
          blockOwnerDeletion: false,
        },
      ],
    },
    type: "Opaque",
    data: { capability: Buffer.from(capability, "utf8").toString("base64") },
  };
}

export function buildWorkflowRunnerPod(
  attempt: WorkflowRunnerAttempt,
  image: string,
  orchestratorUrl: string,
): V1Pod {
  assertDigestPinnedRunnerImage(image);
  const { podName, secretName } = workflowRunnerResourceNames(attempt.attemptId);
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: podName,
      namespace: config.workflowRunnerNamespace,
      labels: labels(attempt),
    },
    spec: {
      restartPolicy: "Never",
      serviceAccountName: "default",
      dnsPolicy: "ClusterFirst",
      schedulerName: "default-scheduler",
      activeDeadlineSeconds: WORKFLOW_RUNNER_ATTEMPT_DEADLINE_MS / 1_000,
      terminationGracePeriodSeconds: 30,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      hostIPC: false,
      hostNetwork: false,
      hostPID: false,
      shareProcessNamespace: false,
      nodeSelector: { [WORKFLOW_RUNNER_NODE_LABEL]: WORKFLOW_RUNNER_NODE_VALUE },
      ...(WORKFLOW_RUNNER_IMAGE_PULL_SECRET === ""
        ? {}
        : { imagePullSecrets: [{ name: WORKFLOW_RUNNER_IMAGE_PULL_SECRET }] }),
      tolerations: [
        {
          key: "node.kubernetes.io/not-ready",
          operator: "Exists",
          effect: "NoExecute",
          tolerationSeconds: 300,
        },
        {
          key: "node.kubernetes.io/unreachable",
          operator: "Exists",
          effect: "NoExecute",
          tolerationSeconds: 300,
        },
        {
          key: WORKFLOW_RUNNER_NODE_LABEL,
          operator: "Equal",
          value: WORKFLOW_RUNNER_NODE_VALUE,
          effect: "NoSchedule",
        },
      ],
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        seccompProfile: { type: "RuntimeDefault" },
      },
      volumes: [
        {
          name: "workspace",
          emptyDir: { sizeLimit: WORKFLOW_RUNNER_STORAGE_LIMIT },
        },
      ],
      containers: [
        {
          name: "runner",
          image,
          imagePullPolicy: "IfNotPresent",
          command: ["bun", "run", "dist/runner/main.js"],
          terminationMessagePath: "/dev/termination-log",
          terminationMessagePolicy: "File",
          env: [
            { name: "WORKFLOW_RUNNER", value: "true" },
            { name: "WORKFLOW_RUNNER_RUN_ID", value: attempt.runId },
            { name: "WORKFLOW_RUNNER_ATTEMPT_ID", value: attempt.attemptId },
            {
              name: "WORKFLOW_RUNNER_TOKEN",
              valueFrom: { secretKeyRef: { name: secretName, key: "capability" } },
            },
            {
              name: "ORCHESTRATOR_URL",
              value: workflowRunnerUrl(orchestratorUrl, attempt.runId, attempt.attemptId),
            },
            { name: "LD_PRELOAD", value: PROCESS_GUARD_PATH },
            ...buildProviderEnvironment(),
          ],
          securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: { drop: ["ALL"] },
          },
          volumeMounts: [
            {
              name: "workspace",
              mountPath: WORKFLOW_RUNNER_WORKSPACE_PATH,
            },
          ],
          resources: {
            requests: {
              cpu: "500m",
              memory: "1Gi",
              "ephemeral-storage": WORKFLOW_RUNNER_STORAGE_REQUEST,
            },
            limits: {
              cpu: "2",
              memory: "4Gi",
              "ephemeral-storage": WORKFLOW_RUNNER_STORAGE_LIMIT,
            },
          },
        },
      ],
    },
  };
}

function statusCode(err: unknown): number | undefined {
  if (err === null || typeof err !== "object") return undefined;
  const value = err as {
    code?: unknown;
    statusCode?: unknown;
    response?: { statusCode?: unknown };
  };
  if (typeof value.code === "number") return value.code;
  if (typeof value.statusCode === "number") return value.statusCode;
  return typeof value.response?.statusCode === "number" ? value.response.statusCode : undefined;
}

function exactResourceMetadata(
  metadata: V1ObjectMeta | undefined,
  name: string,
  attempt: WorkflowRunnerResourceIdentity,
): boolean {
  return (
    metadata?.name === name &&
    metadata.namespace === config.workflowRunnerNamespace &&
    isDeepStrictEqual(metadata.labels, labels(attempt))
  );
}

// The full boundary must reject any security-relevant Secret drift.
// eslint-disable-next-line complexity
function validateSecretIdentity(
  secret: V1Secret,
  desired: V1Secret,
  attempt: WorkflowRunnerAttempt,
): void {
  const name = workflowRunnerResourceNames(attempt.attemptId).secretName;
  if (secret.metadata?.deletionTimestamp !== undefined) {
    throw new WorkflowRunnerResourceError("transient", `Secret ${name} is terminating`);
  }
  if (
    secret.apiVersion !== desired.apiVersion ||
    secret.kind !== desired.kind ||
    !exactResourceMetadata(secret.metadata, name, attempt) ||
    secret.metadata?.annotations !== undefined ||
    secret.metadata?.deletionGracePeriodSeconds !== undefined ||
    secret.metadata?.finalizers !== undefined ||
    secret.metadata?.generateName !== undefined ||
    !isDeepStrictEqual(
      plainData(secret.metadata?.ownerReferences),
      plainData(desired.metadata?.ownerReferences),
    ) ||
    secret.type !== desired.type ||
    secret.immutable !== desired.immutable ||
    secret.stringData !== undefined ||
    Object.keys(secret.data ?? {}).length !== 1 ||
    typeof secret.data?.["capability"] !== "string"
  ) {
    throw new WorkflowRunnerResourceError(
      "permanent",
      `Existing Secret ${name} does not match workflow attempt ${attempt.attemptId}`,
    );
  }
}

// Create, reconcile, and replace each have distinct permanent/transient outcomes.
// eslint-disable-next-line complexity
async function ensureSecret(
  attempt: WorkflowRunnerAttempt,
  capability: string,
  podUid: string,
): Promise<void> {
  const client = loadKubernetesClient().core;
  const namespace = config.workflowRunnerNamespace;
  const desired = buildSecret(attempt, capability, podUid);
  const name = desired.metadata?.name;
  if (name === undefined) throw new WorkflowRunnerResourceError("permanent", "Secret name missing");
  try {
    const created = await client.createNamespacedSecret({ namespace, body: desired });
    validateSecretIdentity(created, desired, attempt);
    if (created.data?.["capability"] !== desired.data?.["capability"]) {
      throw new WorkflowRunnerResourceError(
        "permanent",
        `Created Secret ${name} was mutated by admission`,
      );
    }
    return;
  } catch (err) {
    if (err instanceof WorkflowRunnerResourceError) throw err;
    if (statusCode(err) !== 409) throw classifyResourceError("create runner Secret", err);
  }

  let existing: V1Secret;
  try {
    existing = await client.readNamespacedSecret({ name, namespace });
  } catch (err) {
    throw classifyResourceError("read existing runner Secret", err);
  }
  validateSecretIdentity(existing, desired, attempt);
  if (existing.data?.["capability"] === desired.data?.["capability"]) return;
  const desiredData = desired.data;
  if (desiredData === undefined) {
    throw new WorkflowRunnerResourceError("permanent", "Runner Secret data missing");
  }
  try {
    existing.data = desiredData;
    delete existing.stringData;
    const replaced = await client.replaceNamespacedSecret({
      name,
      namespace,
      body: existing,
    });
    validateSecretIdentity(replaced, desired, attempt);
    if (replaced.data?.["capability"] !== desired.data?.["capability"]) {
      throw new WorkflowRunnerResourceError(
        "permanent",
        `Replaced Secret ${name} was mutated by admission`,
      );
    }
  } catch (err) {
    if (err instanceof WorkflowRunnerResourceError) throw err;
    throw classifyResourceError("rotate runner Secret", err);
  }
}

// The Kubernetes client deserializes responses into model class instances while
// the desired objects are plain literals. isDeepStrictEqual compares prototypes,
// so a server response never matches until both sides are re-homed onto plain
// objects. Values are untouched, so real drift is still rejected.
function plainData(value: unknown): unknown {
  return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
}

// Every checked optional field is intentional. nodeName is server-assigned after create.
// eslint-disable-next-line complexity
function podBoundary(pod: V1Pod): unknown {
  const spec = pod.spec;
  return {
    metadata: {
      name: pod.metadata?.name,
      namespace: pod.metadata?.namespace,
    },
    spec: {
      restartPolicy: spec?.restartPolicy,
      serviceAccountName: spec?.serviceAccountName,
      serviceAccount: spec?.serviceAccount ?? spec?.serviceAccountName,
      dnsPolicy: spec?.dnsPolicy,
      dnsConfig: spec?.dnsConfig,
      schedulerName: spec?.schedulerName,
      activeDeadlineSeconds: spec?.activeDeadlineSeconds,
      terminationGracePeriodSeconds: spec?.terminationGracePeriodSeconds,
      automountServiceAccountToken: spec?.automountServiceAccountToken,
      enableServiceLinks: spec?.enableServiceLinks,
      hostIPC: spec?.hostIPC ?? false,
      hostNetwork: spec?.hostNetwork ?? false,
      hostPID: spec?.hostPID ?? false,
      shareProcessNamespace: spec?.shareProcessNamespace ?? false,
      hostAliases: spec?.hostAliases,
      hostUsers: spec?.hostUsers,
      hostname: spec?.hostname,
      hostnameOverride: spec?.hostnameOverride,
      imagePullSecrets: spec?.imagePullSecrets,
      affinity: spec?.affinity,
      nodeSelector: spec?.nodeSelector,
      os: spec?.os,
      overhead: spec?.overhead,
      preemptionPolicy: spec?.preemptionPolicy ?? "PreemptLowerPriority",
      priority: spec?.priority ?? 0,
      priorityClassName: spec?.priorityClassName,
      readinessGates: spec?.readinessGates,
      resourceClaims: spec?.resourceClaims,
      resources: spec?.resources,
      runtimeClassName: spec?.runtimeClassName,
      schedulingGates: spec?.schedulingGates,
      setHostnameAsFQDN: spec?.setHostnameAsFQDN ?? false,
      subdomain: spec?.subdomain,
      tolerations: spec?.tolerations,
      topologySpreadConstraints: spec?.topologySpreadConstraints,
      initContainerCount: spec?.initContainers?.length ?? 0,
      ephemeralContainerCount: spec?.ephemeralContainers?.length ?? 0,
      volumes: spec?.volumes,
      securityContext: spec?.securityContext,
      containers: spec?.containers.map((container) => ({
        name: container.name,
        image: container.image,
        imagePullPolicy: container.imagePullPolicy,
        command: container.command,
        env: container.env?.map((entry) => ({
          name: entry.name,
          value: entry.value,
          secretName: entry.valueFrom?.secretKeyRef?.name,
          secretKey: entry.valueFrom?.secretKeyRef?.key,
          secretOptional: entry.valueFrom?.secretKeyRef?.optional,
        })),
        envFrom: container.envFrom?.map((entry) => ({
          secretName: entry.secretRef?.name,
          prefix: entry.prefix,
        })),
        volumeMounts: container.volumeMounts,
        args: container.args,
        workingDir: container.workingDir,
        lifecycle: container.lifecycle,
        livenessProbe: container.livenessProbe,
        readinessProbe: container.readinessProbe,
        startupProbe: container.startupProbe,
        stdin: container.stdin,
        stdinOnce: container.stdinOnce,
        tty: container.tty,
        ports: container.ports,
        resizePolicy: container.resizePolicy,
        restartPolicy: container.restartPolicy,
        restartPolicyRules: container.restartPolicyRules,
        securityContext: container.securityContext,
        terminationMessagePath: container.terminationMessagePath,
        terminationMessagePolicy: container.terminationMessagePolicy,
        volumeDevices: container.volumeDevices,
        resources: {
          requests: container.resources?.requests,
          limits: container.resources?.limits,
        },
      })),
    },
  };
}

// Every condition is one independent fail-closed part of the Pod identity.
// eslint-disable-next-line complexity
function validateExistingPod(pod: V1Pod, desired: V1Pod, attempt: WorkflowRunnerAttempt): void {
  const name = workflowRunnerResourceNames(attempt.attemptId).podName;
  if (pod.metadata?.deletionTimestamp !== undefined) {
    throw new WorkflowRunnerResourceError("transient", `Pod ${name} is terminating`);
  }
  if (
    pod.apiVersion !== desired.apiVersion ||
    pod.kind !== desired.kind ||
    !exactResourceMetadata(pod.metadata, name, attempt) ||
    pod.metadata?.annotations !== undefined ||
    pod.metadata?.deletionGracePeriodSeconds !== undefined ||
    pod.metadata?.finalizers !== undefined ||
    pod.metadata?.generateName !== undefined ||
    pod.metadata?.ownerReferences !== undefined ||
    !isDeepStrictEqual(plainData(podBoundary(pod)), plainData(podBoundary(desired)))
  ) {
    throw new WorkflowRunnerResourceError(
      "permanent",
      `Existing Pod ${name} does not match workflow attempt ${attempt.attemptId}`,
    );
  }
}

async function ensurePod(
  attempt: WorkflowRunnerAttempt,
  image: string,
  orchestratorUrl: string,
): Promise<V1Pod> {
  const client = loadKubernetesClient().core;
  const namespace = config.workflowRunnerNamespace;
  const desired = buildWorkflowRunnerPod(attempt, image, orchestratorUrl);
  const name = desired.metadata?.name;
  if (name === undefined) throw new WorkflowRunnerResourceError("permanent", "Pod name missing");
  try {
    const created = await client.createNamespacedPod({ namespace, body: desired });
    validateExistingPod(created, desired, attempt);
    if (created.metadata?.uid === undefined || created.metadata.uid === "") {
      throw new WorkflowRunnerResourceError("transient", `Created Pod ${name} has no UID`);
    }
    return created;
  } catch (err) {
    if (err instanceof WorkflowRunnerResourceError) throw err;
    if (statusCode(err) !== 409) throw classifyResourceError("create runner Pod", err);
  }

  try {
    const existing = await client.readNamespacedPod({ name, namespace });
    validateExistingPod(existing, desired, attempt);
    if (existing.metadata?.uid === undefined || existing.metadata.uid === "") {
      throw new WorkflowRunnerResourceError("transient", `Existing Pod ${name} has no UID`);
    }
    return existing;
  } catch (err) {
    if (err instanceof WorkflowRunnerResourceError) throw err;
    throw classifyResourceError("read existing runner Pod", err);
  }
}

function classifyResourceError(operation: string, err: unknown): WorkflowRunnerResourceError {
  const status = statusCode(err);
  const permanent =
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 409 &&
    status !== 429;
  return new WorkflowRunnerResourceError(
    permanent ? "permanent" : "transient",
    `${operation} failed${status === undefined ? "" : ` (${String(status)})`}`,
  );
}

export async function ensureWorkflowRunnerResources(input: {
  readonly attempt: WorkflowRunnerAttempt;
  readonly capability: string;
  readonly image: string;
  readonly orchestratorUrl: string;
}): Promise<RunnerPodStartup> {
  assertSecureOrchestratorUrl(input.orchestratorUrl);
  assertDigestPinnedRunnerImage(input.image);
  // Reject provider drift before the attempt capability Secret exists.
  buildProviderEnvironment();
  const pod = await ensurePod(input.attempt, input.image, input.orchestratorUrl);
  const podUid = pod.metadata?.uid;
  if (podUid === undefined || podUid === "") {
    throw new WorkflowRunnerResourceError("transient", "Runner Pod UID missing after reconcile");
  }
  await ensureSecret(input.attempt, input.capability, podUid);
  const startup = classifyPodStartup(pod);
  logger.info(
    {
      runId: input.attempt.runId,
      attemptId: input.attempt.attemptId,
      podName: workflowRunnerResourceNames(input.attempt.attemptId).podName,
      startupPhase: startup.phase,
      ...(startup.phase === "stalled" ? { startupReason: startup.reason } : {}),
    },
    "Workflow runner resources reconciled",
  );
  return startup;
}

function assertDigestPinnedRunnerImage(image: string): void {
  if (SHA256_IMAGE_DIGEST.test(image)) return;
  throw new WorkflowRunnerResourceError(
    "permanent",
    "Workflow runner DAEMON_IMAGE must end with an immutable sha256 digest",
  );
}

// A name that cannot resolve outside the cluster. The admission boundary pins the
// same shape on orchestratorOrigin, so the two rules have to stay identical.
const CLUSTER_LOCAL_SERVICE_HOST = /^[a-z0-9-]+\.[a-z0-9-]+\.svc(\.cluster\.local)?$/;

function assertSecureOrchestratorUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WorkflowRunnerResourceError(
      "permanent",
      "ORCHESTRATOR_PUBLIC_URL must be a secure WebSocket URL",
    );
  }
  // A live installation token crosses this socket, so plaintext is confined to a
  // cluster-local Service the runner reaches without leaving the cluster. Dialling
  // an ingress VIP instead is what the CNI may classify as host traffic, which an
  // egress NetworkPolicy cannot match at all.
  const reachableWithoutTls =
    url.protocol === "ws:" && CLUSTER_LOCAL_SERVICE_HOST.test(url.hostname);
  if (
    (url.protocol !== "wss:" && !reachableWithoutTls) ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new WorkflowRunnerResourceError(
      "permanent",
      "ORCHESTRATOR_PUBLIC_URL must be wss://, or ws:// to a cluster-local Service name, and carry no credentials",
    );
  }
}

function ownedDeleteOptions(
  metadata: V1ObjectMeta | undefined,
  kind: "Pod" | "Secret",
): V1DeleteOptions {
  const uid = metadata?.uid;
  if (uid === undefined || uid === "") {
    throw new WorkflowRunnerResourceError(
      "permanent",
      `${kind} identity is missing deletion preconditions`,
    );
  }
  return { preconditions: { uid } };
}

async function readForDelete<T>(
  operation: () => Promise<T>,
  kind: "Pod" | "Secret",
): Promise<T | null> {
  try {
    return await operation();
  } catch (err) {
    if (statusCode(err) === 404) return null;
    throw classifyResourceError(`read runner ${kind} for deletion`, err);
  }
}

async function deleteIgnoringNotFound(
  operation: () => Promise<unknown>,
  kind: "Pod" | "Secret",
): Promise<void> {
  try {
    await operation();
  } catch (err) {
    if (statusCode(err) !== 404) throw classifyResourceError(`delete runner ${kind}`, err);
  }
}

export async function deleteWorkflowRunnerResources(
  attempt: WorkflowRunnerResourceIdentity,
): Promise<boolean> {
  const client = loadKubernetesClient().core;
  const namespace = config.workflowRunnerNamespace;
  const { podName, secretName } = workflowRunnerResourceNames(attempt.attemptId);
  const pod = await readForDelete(
    () => client.readNamespacedPod({ name: podName, namespace }),
    "Pod",
  );
  if (pod !== null) {
    validateResourceOwnership(pod.metadata, podName, attempt, "Pod");
    const body = ownedDeleteOptions(pod.metadata, "Pod");
    await deleteIgnoringNotFound(
      () => client.deleteNamespacedPod({ name: podName, namespace, body }),
      "Pod",
    );
  }

  const secret = await readForDelete(
    () => client.readNamespacedSecret({ name: secretName, namespace }),
    "Secret",
  );
  // Resource presence is not sensitive data.
  // eslint-disable-next-line security/detect-possible-timing-attacks
  if (secret !== null) {
    validateResourceOwnership(secret.metadata, secretName, attempt, "Secret");
    const body = ownedDeleteOptions(secret.metadata, "Secret");
    await deleteIgnoringNotFound(
      () => client.deleteNamespacedSecret({ name: secretName, namespace, body }),
      "Secret",
    );
  }
  return true;
}

function validateResourceOwnership(
  metadata: V1ObjectMeta | undefined,
  name: string,
  attempt: WorkflowRunnerResourceIdentity,
  kind: "Pod" | "Secret",
): void {
  if (!exactResourceMetadata(metadata, name, attempt)) {
    throw new WorkflowRunnerResourceError(
      "permanent",
      `${kind} ${name} does not belong to workflow attempt ${attempt.attemptId}`,
    );
  }
}
