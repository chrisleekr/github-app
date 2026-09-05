import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { WorkflowRunnerAttempt } from "../../src/orchestrator/workflow-runner-store";
import { FORBIDDEN_RUNNER_ENV } from "../../src/runner/process-boundary";
import { expectToReject } from "../utils/assertions";

interface ResourceCall<T> {
  readonly namespace: string;
  readonly body: T;
}

const createNamespacedSecret = mock((_input: ResourceCall<Record<string, unknown>>) =>
  Promise.resolve({}),
);
const readNamespacedSecret = mock((_input: { name: string; namespace: string }) =>
  Promise.resolve({}),
);
const replaceNamespacedSecret = mock(
  (_input: { name: string; namespace: string; body: Record<string, unknown> }) =>
    Promise.resolve({}),
);
const createNamespacedPod = mock((_input: ResourceCall<Record<string, unknown>>) =>
  Promise.resolve({}),
);
const readNamespacedPod = mock((_input: { name: string; namespace: string }) =>
  Promise.resolve({}),
);
const deleteNamespacedPod = mock(() => Promise.resolve({}));
const deleteNamespacedSecret = mock(() => Promise.resolve({}));
const core = {
  createNamespacedSecret,
  readNamespacedSecret,
  replaceNamespacedSecret,
  createNamespacedPod,
  readNamespacedPod,
  deleteNamespacedPod,
  deleteNamespacedSecret,
};

const testConfig = {
  workflowRunnerNamespace: "test-ns",
  // Deliberately not the schema defaults: the Pod assertions below then prove
  // the nodeSelector and toleration follow configuration, not a literal.
  workflowRunnerNodeLabel: "node.homelab/class",
  workflowRunnerNodeValue: "worker",
  provider: "anthropic" as "anthropic" | "bedrock",
  model: "claude-test",
  anthropicApiKey: "configured",
  claudeCodeOauthToken: undefined as string | undefined,
  awsRegion: undefined as string | undefined,
  awsProfile: undefined as string | undefined,
  awsAccessKeyId: undefined as string | undefined,
  awsSecretAccessKey: undefined as string | undefined,
  awsSessionToken: undefined as string | undefined,
  awsBearerTokenBedrock: undefined as string | undefined,
  anthropicBedrockBaseUrl: undefined as string | undefined,
  allowedOwners: ["acme"] as string[] | undefined,
};

void mock.module("../../src/config", () => ({
  config: testConfig,
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

const {
  buildWorkflowRunnerPod,
  classifyPodStartup,
  deleteWorkflowRunnerResources,
  ensureWorkflowRunnerResources,
  WorkflowRunnerResourceError,
} = await import("../../src/k8s/workflow-runner-spawner");

const attempt: WorkflowRunnerAttempt = {
  runId: "11111111-1111-4111-8111-111111111111",
  attemptId: "22222222-2222-4222-8222-222222222222",
  runnerId: "workflow-runner:22222222-2222-4222-8222-222222222222",
  executionDeliveryId: "delivery-16",
  workflowName: "implement",
  attemptDeadlineAt: new Date("2026-08-23T04:10:00Z"),
};

const RUNNER_IMAGE = `registry.example/github-app@sha256:${"a".repeat(64)}`;
const input = {
  attempt,
  capability: "wfr1.test-capability",
  image: RUNNER_IMAGE,
  orchestratorUrl: "wss://controller.example/ws",
} as const;

function apiError(code: number): Error & { code: number } {
  return Object.assign(new Error(`Kubernetes API ${String(code)}`), { code });
}

function createdPod(): Record<string, unknown> {
  const call = createNamespacedPod.mock.calls[0] as [ResourceCall<Record<string, unknown>>];
  return call[0].body;
}

interface MutableAdmissionPod {
  metadata: Record<string, unknown>;
  spec: {
    hostAliases?: unknown;
    resourceClaims?: unknown;
    volumes?: unknown;
    containers: {
      env: {
        name: string;
        valueFrom?: { secretKeyRef?: { optional?: boolean } };
      }[];
      lifecycle?: unknown;
      resources?: Record<string, unknown>;
      securityContext: Record<string, unknown>;
      terminationMessagePolicy?: string;
    }[];
  };
}

function runnerContainer(
  pod: MutableAdmissionPod,
): MutableAdmissionPod["spec"]["containers"][number] {
  const runner = pod.spec.containers[0];
  if (runner === undefined) throw new Error("Expected runner container");
  return runner;
}

async function expectPermanentUrl(orchestratorUrl: string): Promise<void> {
  let caught: unknown;
  try {
    await ensureWorkflowRunnerResources({ ...input, orchestratorUrl });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(WorkflowRunnerResourceError);
  expect((caught as InstanceType<typeof WorkflowRunnerResourceError>).kind).toBe("permanent");
}

function resourceMetadata(
  name: string,
  uid?: string,
  resourceVersion?: string,
): Record<string, unknown> {
  return {
    name,
    namespace: "test-ns",
    labels: {
      "app.kubernetes.io/name": "github-app",
      "app.kubernetes.io/component": "workflow-runner",
      "github-app/workflow-run-id": attempt.runId,
      "github-app/workflow-attempt-id": attempt.attemptId,
    },
    ...(uid === undefined ? {} : { uid }),
    ...(resourceVersion === undefined ? {} : { resourceVersion }),
  };
}

function podOwnerReference(uid = "pod-uid"): Record<string, unknown> {
  return {
    apiVersion: "v1",
    kind: "Pod",
    name: `workflow-runner-${attempt.attemptId}`,
    uid,
    controller: true,
    blockOwnerDeletion: false,
  };
}

function admittedPod(body: Record<string, unknown>): Record<string, unknown> {
  const metadata = body["metadata"] as Record<string, unknown>;
  return { ...body, metadata: { ...metadata, uid: "pod-uid", resourceVersion: "1" } };
}

beforeEach(() => {
  Object.assign(testConfig, {
    provider: "anthropic",
    model: "claude-test",
    anthropicApiKey: "configured",
    claudeCodeOauthToken: undefined,
    awsRegion: undefined,
    awsProfile: undefined,
    awsAccessKeyId: undefined,
    awsSecretAccessKey: undefined,
    awsSessionToken: undefined,
    awsBearerTokenBedrock: undefined,
    anthropicBedrockBaseUrl: undefined,
    allowedOwners: ["acme"],
  });
  createNamespacedSecret.mockReset();
  readNamespacedSecret.mockReset();
  replaceNamespacedSecret.mockReset();
  createNamespacedPod.mockReset();
  readNamespacedPod.mockReset();
  deleteNamespacedPod.mockReset();
  deleteNamespacedSecret.mockReset();
  createNamespacedSecret.mockImplementation(({ body }) => Promise.resolve(body));
  readNamespacedSecret.mockResolvedValue({});
  replaceNamespacedSecret.mockImplementation(({ body }) => Promise.resolve(body));
  createNamespacedPod.mockImplementation(({ body }) => Promise.resolve(admittedPod(body)));
  readNamespacedPod.mockResolvedValue({});
  deleteNamespacedPod.mockResolvedValue({});
  deleteNamespacedSecret.mockResolvedValue({});
});

describe("workflow runner Pod boundary", () => {
  it("rejects mutable image references before creating credentials", async () => {
    for (const image of ["registry.example/github-app", "registry.example/github-app:latest"]) {
      // eslint-disable-next-line no-await-in-loop -- each rejected reference is independent
      await expectToReject(
        ensureWorkflowRunnerResources({ ...input, image }),
        "must end with an immutable sha256 digest",
      );
    }
    expect(createNamespacedSecret).not.toHaveBeenCalled();
    expect(createNamespacedPod).not.toHaveBeenCalled();
  });

  it("creates one isolated runner with only attempt and provider Secret authority", async () => {
    await ensureWorkflowRunnerResources(input);

    const pod = createdPod() as {
      spec: {
        activeDeadlineSeconds: number;
        restartPolicy: string;
        automountServiceAccountToken: boolean;
        schedulerName: string;
        shareProcessNamespace: boolean;
        hostIPC: boolean;
        hostNetwork: boolean;
        hostPID: boolean;
        nodeSelector: Record<string, string>;
        tolerations: Record<string, unknown>[];
        securityContext: Record<string, unknown>;
        volumes: Record<string, unknown>[];
        containers: {
          name: string;
          env: Record<string, unknown>[];
          envFrom?: Record<string, unknown>[];
          securityContext: Record<string, unknown>;
          terminationMessagePath: string;
          terminationMessagePolicy: string;
          volumeMounts: Record<string, unknown>[];
          resources: {
            requests: Record<string, string>;
            limits: Record<string, string>;
          };
        }[];
      };
    };
    expect(pod.spec.containers).toHaveLength(1);
    expect(pod.spec.activeDeadlineSeconds).toBe(4_200);
    expect(pod.spec.restartPolicy).toBe("Never");
    expect(pod.spec.automountServiceAccountToken).toBe(false);
    expect(pod.spec.schedulerName).toBe("default-scheduler");
    expect(pod.spec.nodeSelector).toEqual({ "node.homelab/class": "worker" });
    expect(pod.spec.tolerations).toContainEqual({
      key: "node.homelab/class",
      operator: "Equal",
      value: "worker",
      effect: "NoSchedule",
    });
    expect(pod.spec.shareProcessNamespace).toBe(false);
    expect([pod.spec.hostIPC, pod.spec.hostNetwork, pod.spec.hostPID]).toEqual([
      false,
      false,
      false,
    ]);
    expect(pod.spec.securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(pod.spec.volumes).toEqual([{ name: "workspace", emptyDir: { sizeLimit: "10Gi" } }]);
    const runner = pod.spec.containers[0];
    if (runner === undefined) throw new Error("Expected runner container");
    expect(runner.name).toBe("runner");
    expect(runner.terminationMessagePath).toBe("/dev/termination-log");
    expect(runner.terminationMessagePolicy).toBe("File");
    expect(runner.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
    });
    expect(runner.volumeMounts).toEqual([{ name: "workspace", mountPath: "/tmp/bot-workspaces" }]);
    expect(runner.resources).toEqual({
      requests: { cpu: "500m", memory: "1Gi", "ephemeral-storage": "2Gi" },
      limits: { cpu: "2", memory: "4Gi", "ephemeral-storage": "10Gi" },
    });
    expect(runner.envFrom).toBeUndefined();
    const env = new Map(runner.env.map((entry) => [entry["name"], entry]));
    expect([...env.keys()]).toEqual([
      "WORKFLOW_RUNNER",
      "WORKFLOW_RUNNER_RUN_ID",
      "WORKFLOW_RUNNER_ATTEMPT_ID",
      "WORKFLOW_RUNNER_TOKEN",
      "ORCHESTRATOR_URL",
      "LD_PRELOAD",
      "CLAUDE_PROVIDER",
      "CLAUDE_MODEL",
      "ANTHROPIC_API_KEY",
      "ALLOWED_OWNERS",
    ]);
    expect(env.get("WORKFLOW_RUNNER_RUN_ID")).toEqual({
      name: "WORKFLOW_RUNNER_RUN_ID",
      value: attempt.runId,
    });
    expect(env.get("WORKFLOW_RUNNER_ATTEMPT_ID")).toEqual({
      name: "WORKFLOW_RUNNER_ATTEMPT_ID",
      value: attempt.attemptId,
    });
    expect(env.get("ORCHESTRATOR_URL")).toEqual({
      name: "ORCHESTRATOR_URL",
      value: `wss://controller.example/ws/workflow-runner/${attempt.runId}/${attempt.attemptId}`,
    });
    expect(env.get("WORKFLOW_RUNNER_TOKEN")).toEqual({
      name: "WORKFLOW_RUNNER_TOKEN",
      valueFrom: {
        secretKeyRef: {
          name: `workflow-runner-${attempt.attemptId}`,
          key: "capability",
        },
      },
    });
    expect(env.get("ANTHROPIC_API_KEY")).toEqual({
      name: "ANTHROPIC_API_KEY",
      valueFrom: {
        secretKeyRef: {
          name: "workflow-runner-secrets",
          key: "ANTHROPIC_API_KEY",
          optional: false,
        },
      },
    });
    for (const forbidden of FORBIDDEN_RUNNER_ENV) {
      expect(env.has(forbidden)).toBe(false);
    }
  });

  it("renders only the selected Anthropic credential when both are configured", async () => {
    testConfig.claudeCodeOauthToken = "configured-oauth";

    await ensureWorkflowRunnerResources(input);

    const pod = createdPod() as MutableAdmissionPod;
    const names = runnerContainer(pod).env.map((entry) => entry.name);
    expect(names).toContain("ANTHROPIC_API_KEY");
    expect(names).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(names.some((name) => name.startsWith("AWS_"))).toBe(false);
  });

  it("renders one Bedrock bearer chain without Anthropic or static AWS credentials", async () => {
    Object.assign(testConfig, {
      provider: "bedrock",
      anthropicApiKey: "unselected-controller-key",
      awsRegion: "ap-southeast-2",
      awsAccessKeyId: "unselected-static-key",
      awsSecretAccessKey: "unselected-static-secret",
      awsBearerTokenBedrock: "configured-bearer",
    });

    await ensureWorkflowRunnerResources(input);

    const pod = createdPod() as MutableAdmissionPod;
    const names = runnerContainer(pod).env.map((entry) => entry.name);
    expect(names).toContain("AWS_BEARER_TOKEN_BEDROCK");
    expect(names).toContain("AWS_REGION");
    expect(names).not.toContain("AWS_ACCESS_KEY_ID");
    expect(names).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(names).not.toContain("ANTHROPIC_API_KEY");
  });

  it.each([
    "http://bedrock.example.test",
    "https://user@bedrock.example.test",
    "https://user:secret@bedrock.example.test",
    "https://bedrock.example.test?token=secret",
    "https://bedrock.example.test#fragment",
    " bedrock.example.test ",
  ])("rejects unsafe Bedrock base URL %s before creating credentials", async (baseUrl) => {
    Object.assign(testConfig, {
      provider: "bedrock",
      anthropicApiKey: undefined,
      awsRegion: "ap-southeast-2",
      awsBearerTokenBedrock: "configured-bearer",
      anthropicBedrockBaseUrl: baseUrl,
    });

    await expectToReject(ensureWorkflowRunnerResources(input), "ANTHROPIC_BEDROCK_BASE_URL");
    expect(createNamespacedSecret).not.toHaveBeenCalled();
    expect(createNamespacedPod).not.toHaveBeenCalled();
  });

  it("accepts the exact Pod after create reports an existing name", async () => {
    await ensureWorkflowRunnerResources(input);
    const existing = admittedPod(structuredClone(createdPod()));
    createNamespacedPod.mockRejectedValue(apiError(409));
    readNamespacedPod.mockResolvedValue(existing);

    await ensureWorkflowRunnerResources(input);

    expect(readNamespacedPod).toHaveBeenCalledTimes(1);
  });

  it("accepts Kubernetes omission of false host namespace fields", async () => {
    createNamespacedPod.mockImplementation(({ body }) => {
      const admitted = structuredClone(body) as {
        spec: Record<string, unknown>;
      };
      Reflect.deleteProperty(admitted.spec, "hostIPC");
      Reflect.deleteProperty(admitted.spec, "hostNetwork");
      Reflect.deleteProperty(admitted.spec, "hostPID");
      return Promise.resolve(admittedPod(admitted as unknown as Record<string, unknown>));
    });

    await ensureWorkflowRunnerResources(input);
  });

  it("rejects an admission-mutated Pod returned by create", async () => {
    createNamespacedPod.mockImplementation(({ body }) => {
      const mutated = structuredClone(body) as { spec: { hostNetwork: boolean } };
      mutated.spec.hostNetwork = true;
      return Promise.resolve(mutated);
    });

    await expectToReject(
      ensureWorkflowRunnerResources(input),
      `Existing Pod workflow-runner-${attempt.attemptId} does not match`,
    );
  });

  it("rejects insecure or credential-bearing controller URLs before creating resources", async () => {
    await expectPermanentUrl("ws://controller.example/ws");
    await expectPermanentUrl("wss://user:secret@controller.example/ws");
    await expectPermanentUrl("not-a-url");
    // A ".svc" label anywhere but the third is a public name, not a cluster one.
    await expectPermanentUrl("ws://evil.svc.attacker.example/ws");
    await expectPermanentUrl("ws://github-app.github-app.svc.cluster.local.attacker.example/ws");
    await expectPermanentUrl("ws://user:secret@github-app.github-app.svc.cluster.local:3002/ws");
    expect(createNamespacedSecret).not.toHaveBeenCalled();
    expect(createNamespacedPod).not.toHaveBeenCalled();
  });

  it("accepts a plaintext controller URL on a cluster-local Service name", async () => {
    for (const orchestratorUrl of [
      "ws://github-app.github-app.svc.cluster.local:3002/ws",
      "ws://github-app.github-app.svc/ws",
    ]) {
      await ensureWorkflowRunnerResources({ ...input, orchestratorUrl });
    }
    expect(createNamespacedPod).toHaveBeenCalledTimes(2);
  });

  it("rejects a 409-reconciled Pod with a changed isolation field", async () => {
    await ensureWorkflowRunnerResources(input);
    const existing = structuredClone(createdPod()) as {
      spec: { hostPID: boolean };
    };
    existing.spec.hostPID = true;
    createNamespacedPod.mockRejectedValue(apiError(409));
    readNamespacedPod.mockResolvedValue(existing);

    await expectToReject(
      ensureWorkflowRunnerResources(input),
      `Existing Pod workflow-runner-${attempt.attemptId} does not match`,
    );
  });

  it("treats a terminating Pod as transient", async () => {
    const existing = admittedPod(
      buildWorkflowRunnerPod(attempt, input.image, input.orchestratorUrl) as unknown as Record<
        string,
        unknown
      >,
    );
    (existing["metadata"] as Record<string, unknown>)["deletionTimestamp"] = "2026-08-24T00:00:00Z";
    createNamespacedPod.mockRejectedValue(apiError(409));
    readNamespacedPod.mockResolvedValue(existing);

    let caught: unknown;
    try {
      await ensureWorkflowRunnerResources(input);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkflowRunnerResourceError);
    expect((caught as InstanceType<typeof WorkflowRunnerResourceError>).kind).toBe("transient");
    expect((caught as Error).message).toContain("is terminating");
  });

  for (const [name, mutate] of [
    [
      "container root identity",
      (pod: MutableAdmissionPod): void => {
        runnerContainer(pod).securityContext["runAsNonRoot"] = false;
        runnerContainer(pod).securityContext["runAsUser"] = 0;
      },
    ],
    [
      "unconfined container seccomp",
      (pod: MutableAdmissionPod): void => {
        runnerContainer(pod).securityContext["seccompProfile"] = { type: "Unconfined" };
      },
    ],
    [
      "added Linux capability",
      (pod: MutableAdmissionPod): void => {
        const security = runnerContainer(pod).securityContext;
        const capabilities = security["capabilities"] as Record<string, unknown>;
        capabilities["add"] = ["SYS_ADMIN"];
      },
    ],
    [
      "unmasked proc mount",
      (pod: MutableAdmissionPod): void => {
        runnerContainer(pod).securityContext["procMount"] = "Unmasked";
      },
    ],
    [
      "credential-reading lifecycle hook",
      (pod: MutableAdmissionPod): void => {
        runnerContainer(pod).lifecycle = { postStart: { exec: { command: ["env"] } } };
      },
    ],
    [
      "changed Secret optionality",
      (pod: MutableAdmissionPod): void => {
        const entry = runnerContainer(pod).env.find(
          (candidate) => candidate.name === "ANTHROPIC_API_KEY",
        );
        const secretKeyRef = entry?.valueFrom?.secretKeyRef;
        if (secretKeyRef === undefined) throw new Error("Expected provider Secret reference");
        secretKeyRef.optional = true;
      },
    ],
    [
      "cleanup finalizer",
      (pod: MutableAdmissionPod): void => {
        pod.metadata["finalizers"] = ["example.invalid/hold"];
      },
    ],
    [
      "host alias",
      (pod: MutableAdmissionPod): void => {
        pod.spec.hostAliases = [{ ip: "127.0.0.1", hostnames: ["controller.example"] }];
      },
    ],
    [
      "workspace host path",
      (pod: MutableAdmissionPod): void => {
        pod.spec.volumes = [{ name: "workspace", hostPath: { path: "/" } }];
      },
    ],
    [
      "dynamic resource claim",
      (pod: MutableAdmissionPod): void => {
        pod.spec.resourceClaims = [{ name: "host-device", resourceClaimName: "host-device" }];
      },
    ],
    [
      "resource budget",
      (pod: MutableAdmissionPod): void => {
        const resources = runnerContainer(pod).resources;
        if (resources === undefined) throw new Error("Expected runner resources");
        resources["limits"] = { cpu: "8", memory: "16Gi" };
      },
    ],
    [
      "termination message policy",
      (pod: MutableAdmissionPod): void => {
        runnerContainer(pod).terminationMessagePolicy = "FallbackToLogsOnError";
      },
    ],
  ] as const) {
    it(`rejects admission-mutated ${name}`, async () => {
      createNamespacedPod.mockImplementation(({ body }) => {
        const mutated = structuredClone(body);
        mutate(mutated);
        return Promise.resolve(mutated);
      });

      await expectToReject(
        ensureWorkflowRunnerResources(input),
        `Existing Pod workflow-runner-${attempt.attemptId} does not match`,
      );
    });
  }
});

describe("workflow runner Secret boundary", () => {
  it("rejects a Secret mutated by admission", async () => {
    createNamespacedSecret.mockImplementation(({ body }) => {
      const mutated = structuredClone(body) as { data: Record<string, string> };
      mutated.data["unexpected"] = "value";
      return Promise.resolve(mutated);
    });

    await expectToReject(
      ensureWorkflowRunnerResources(input),
      `Existing Secret workflow-runner-${attempt.attemptId} does not match`,
    );
    expect(createNamespacedPod).toHaveBeenCalledTimes(1);
  });

  it("owns the capability Secret by the exact runner Pod UID", async () => {
    await ensureWorkflowRunnerResources(input);

    const create = createNamespacedSecret.mock.calls[0]?.[0];
    expect(create?.body["metadata"]).toEqual(
      expect.objectContaining({ ownerReferences: [podOwnerReference()] }),
    );
    expect(createNamespacedPod.mock.invocationCallOrder[0]).toBeLessThan(
      createNamespacedSecret.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("preserves the existing Secret object and resourceVersion while rotating capability", async () => {
    class SecretResponse {
      readonly responsePrototype = true;
    }
    const secretName = `workflow-runner-${attempt.attemptId}`;
    const existing = Object.assign(new SecretResponse(), {
      apiVersion: "v1",
      kind: "Secret",
      metadata: resourceMetadata(secretName, "secret-uid", "41"),
      type: "Opaque",
      data: { capability: "stale" },
    });
    existing.metadata["ownerReferences"] = [podOwnerReference()];
    createNamespacedSecret.mockRejectedValue(apiError(409));
    readNamespacedSecret.mockResolvedValue(existing);

    await ensureWorkflowRunnerResources(input);

    const replace = replaceNamespacedSecret.mock.calls[0]?.[0];
    expect(replace?.body).toBe(existing);
    expect(replace?.body).toBeInstanceOf(SecretResponse);
    expect((replace?.body.metadata as { resourceVersion?: string }).resourceVersion).toBe("41");
    expect(replace?.body.data).toEqual({
      capability: Buffer.from(input.capability, "utf8").toString("base64"),
    });
  });

  it("rejects a Secret mutated by admission during replacement", async () => {
    const secretName = `workflow-runner-${attempt.attemptId}`;
    createNamespacedSecret.mockRejectedValue(apiError(409));
    readNamespacedSecret.mockResolvedValue({
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        ...resourceMetadata(secretName, "secret-uid", "41"),
        ownerReferences: [podOwnerReference()],
      },
      type: "Opaque",
      data: { capability: "stale" },
    });
    replaceNamespacedSecret.mockImplementation(({ body }) => {
      const mutated = structuredClone(body);
      mutated.data = { capability: "admission-mutated" };
      return Promise.resolve(mutated);
    });

    await expectToReject(
      ensureWorkflowRunnerResources(input),
      `Replaced Secret ${secretName} was mutated by admission`,
    );
    expect(createNamespacedPod).toHaveBeenCalledTimes(1);
  });

  it("treats a terminating Secret as transient", async () => {
    const secretName = `workflow-runner-${attempt.attemptId}`;
    createNamespacedSecret.mockRejectedValue(apiError(409));
    readNamespacedSecret.mockResolvedValue({
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        ...resourceMetadata(secretName, "secret-uid", "41"),
        ownerReferences: [podOwnerReference()],
        deletionTimestamp: "2026-08-24T00:00:00Z",
      },
      type: "Opaque",
      data: { capability: Buffer.from(input.capability, "utf8").toString("base64") },
    });

    let caught: unknown;
    try {
      await ensureWorkflowRunnerResources(input);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkflowRunnerResourceError);
    expect((caught as InstanceType<typeof WorkflowRunnerResourceError>).kind).toBe("transient");
  });
});

describe("workflow runner owned cleanup", () => {
  it("accepts deletion of exact owned resources with UID preconditions as complete", async () => {
    const podName = `workflow-runner-${attempt.attemptId}`;
    const secretName = podName;
    readNamespacedPod.mockResolvedValue({
      metadata: resourceMetadata(podName, "pod-uid", "17"),
    });
    readNamespacedSecret.mockResolvedValue({
      metadata: resourceMetadata(secretName, "secret-uid", "18"),
    });

    expect(await deleteWorkflowRunnerResources(attempt)).toBe(true);

    expect(deleteNamespacedPod).toHaveBeenCalledWith({
      name: podName,
      namespace: "test-ns",
      body: {
        preconditions: { uid: "pod-uid" },
      },
    });
    expect(deleteNamespacedSecret).toHaveBeenCalledWith({
      name: secretName,
      namespace: "test-ns",
      body: { preconditions: { uid: "secret-uid" } },
    });
  });

  it("treats missing resources as already cleaned", async () => {
    readNamespacedPod.mockRejectedValue(apiError(404));
    readNamespacedSecret.mockRejectedValue(apiError(404));

    expect(await deleteWorkflowRunnerResources(attempt)).toBe(true);

    expect(deleteNamespacedPod).not.toHaveBeenCalled();
    expect(deleteNamespacedSecret).not.toHaveBeenCalled();
  });

  it("fails closed for ownership mismatch or missing deletion identity", async () => {
    const name = `workflow-runner-${attempt.attemptId}`;
    readNamespacedPod.mockResolvedValue({
      metadata: { ...resourceMetadata(name, "pod-uid", "17"), labels: {} },
    });
    await expectToReject(deleteWorkflowRunnerResources(attempt), "does not belong");
    expect(deleteNamespacedPod).not.toHaveBeenCalled();

    readNamespacedPod.mockResolvedValue({ metadata: resourceMetadata(name) });
    await expectToReject(deleteWorkflowRunnerResources(attempt), "missing deletion preconditions");
    expect(deleteNamespacedPod).not.toHaveBeenCalled();
  });

  it("classifies a deletion conflict as transient", async () => {
    const name = `workflow-runner-${attempt.attemptId}`;
    readNamespacedPod.mockResolvedValue({
      metadata: resourceMetadata(name, "pod-uid", "17"),
    });
    deleteNamespacedPod.mockRejectedValue(apiError(409));

    let caught: unknown;
    try {
      await deleteWorkflowRunnerResources(attempt);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkflowRunnerResourceError);
    expect((caught as InstanceType<typeof WorkflowRunnerResourceError>).kind).toBe("transient");
  });
});

describe("workflow runner Kubernetes error classification", () => {
  for (const status of [408, 429, 500, 503]) {
    it(`treats Kubernetes ${String(status)} as transient`, async () => {
      createNamespacedPod.mockRejectedValue(apiError(status));
      let caught: unknown;
      try {
        await ensureWorkflowRunnerResources(input);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(WorkflowRunnerResourceError);
      expect((caught as InstanceType<typeof WorkflowRunnerResourceError>).kind).toBe("transient");
    });
  }

  it("treats a Secret resourceVersion update conflict as transient", async () => {
    createNamespacedSecret.mockRejectedValue(apiError(409));
    readNamespacedSecret.mockResolvedValue({
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        ...resourceMetadata(`workflow-runner-${attempt.attemptId}`, "secret-uid", "1"),
        ownerReferences: [podOwnerReference()],
      },
      type: "Opaque",
      data: { capability: "stale" },
    });
    replaceNamespacedSecret.mockRejectedValue(apiError(409));

    let caught: unknown;
    try {
      await ensureWorkflowRunnerResources(input);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkflowRunnerResourceError);
    expect((caught as InstanceType<typeof WorkflowRunnerResourceError>).kind).toBe("transient");
  });

  for (const status of [400, 401, 403, 422]) {
    it(`treats Kubernetes ${String(status)} as permanent`, async () => {
      createNamespacedPod.mockRejectedValue(apiError(status));
      let caught: unknown;
      try {
        await ensureWorkflowRunnerResources(input);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(WorkflowRunnerResourceError);
      expect((caught as InstanceType<typeof WorkflowRunnerResourceError>).kind).toBe("permanent");
    });
  }
});

// Stands in for V1Toleration and friends: any prototype that is not Object's.
class DeserializedModel {
  // A method, not a field: it lives on the prototype, so it never becomes an own
  // property and never reaches the value comparison. The prototype is the whole
  // point. A field here would make the two sides differ by value instead.
  modelName(): string {
    return "V1Toleration";
  }
}

describe("workflow runner Pod drift check against a real client response", () => {
  it("accepts a response whose nested values are model class instances", async () => {
    // The client deserializes every response through ObjectSerializer, which does
    // `new typeMap[type]()`, so the created Pod never shares a prototype with the
    // desired literal and isDeepStrictEqual compares prototypes. Modelled with a
    // local class rather than importing V1Toleration: the package exposes the
    // model classes only to CJS require, so a named ESM import resolves in a
    // single-file run and throws once another test file shares the process.
    // Guards a regression that failed every attempt permanently with a spurious
    // drift error.
    createNamespacedPod.mockImplementation(({ body }) => {
      // Deep clone first: admittedPod shallow-copies, so mutating its spec in
      // place would also convert the desired object and hide the mismatch.
      const admitted = admittedPod(JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
      const spec = admitted["spec"] as { tolerations: Record<string, unknown>[] };
      const rehomed: Record<string, unknown>[] = [];
      for (const entry of spec.tolerations) {
        rehomed.push(
          Object.assign(new DeserializedModel(), entry) as unknown as Record<string, unknown>,
        );
      }
      spec.tolerations = rehomed;
      return Promise.resolve(admitted);
    });

    await ensureWorkflowRunnerResources(input);

    expect(createNamespacedPod).toHaveBeenCalledTimes(1);
    expect(deleteNamespacedPod).not.toHaveBeenCalled();
  });
});

describe("workflow runner Pod startup classification", () => {
  const waiting = (reason: string) => ({
    status: { phase: "Pending", containerStatuses: [{ state: { waiting: { reason } } }] },
  });

  it("reads an unstarted Pod as starting so the lease is extended, not expired", () => {
    // The lease is claimed before the Pod exists, so the very first read can
    // carry no status at all. Guessing "running" there is what expired a
    // healthy attempt mid image-pull.
    expect(classifyPodStartup({})).toEqual({ phase: "starting" });
    expect(classifyPodStartup({ status: { phase: "Pending" } })).toEqual({ phase: "starting" });
    expect(classifyPodStartup(waiting("ContainerCreating"))).toEqual({ phase: "starting" });
    expect(classifyPodStartup(waiting("PodInitializing"))).toEqual({ phase: "starting" });
  });

  it("reads a started Pod as running", () => {
    expect(classifyPodStartup({ status: { phase: "Running" } })).toEqual({ phase: "running" });
    expect(classifyPodStartup({ status: { phase: "Succeeded" } })).toEqual({ phase: "running" });
  });

  it("reads waiting reasons kubelet never resolves as stalled", () => {
    for (const reason of [
      "ErrImagePull",
      "ImagePullBackOff",
      "InvalidImageName",
      "ErrImageNeverPull",
      "CreateContainerConfigError",
      "CreateContainerError",
    ]) {
      expect(classifyPodStartup(waiting(reason))).toEqual({ phase: "stalled", reason });
    }
    expect(classifyPodStartup({ status: { phase: "Failed" } })).toEqual({
      phase: "stalled",
      reason: "PodFailed",
    });
  });
});
