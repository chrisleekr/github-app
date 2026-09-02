/**
 * Unit tests for the ephemeral-daemon spawner.
 *
 * We never touch a real Kubernetes API. Instead we mock `@kubernetes/client-node`
 * so we can inspect the exact Pod spec the spawner submits and verify the
 * error-kind mapping used by the router when the K8s API rejects or is
 * unreachable.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// ─── Mock @kubernetes/client-node ─────────────────────────────────────────
//
// The mocks are captured by reference so each test can install its own
// `createNamespacedPod` implementation while still sharing a stable
// KubeConfig / CoreV1Api identity.

interface CapturedCall {
  namespace: string;
  body: Record<string, unknown>;
}

const createNamespacedPod = mock((_args: CapturedCall) => Promise.resolve({ body: {} }));
let loadFromDefaultError: Error | null = null;

class MockKubeConfig {
  loadFromCluster() {}
  loadFromDefault() {
    if (loadFromDefaultError !== null) throw loadFromDefaultError;
  }
  makeApiClient(_apiClass: unknown) {
    return { createNamespacedPod };
  }
}

void mock.module("@kubernetes/client-node", () => ({
  KubeConfig: MockKubeConfig,
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  CoreV1Api: class CoreV1Api {},
}));

const { _resetK8sClientForTests, EphemeralSpawnError, spawnEphemeralDaemon } =
  await import("../../src/k8s/ephemeral-daemon-spawner");

// ─── Test helpers ─────────────────────────────────────────────────────────

const origKubernetesServiceHost = process.env["KUBERNETES_SERVICE_HOST"];
const origKubeconfig = process.env["KUBECONFIG"];

beforeEach(() => {
  _resetK8sClientForTests();
  createNamespacedPod.mockClear();
  createNamespacedPod.mockImplementation(() => Promise.resolve({ body: {} }));
  loadFromDefaultError = null;
  process.env["KUBERNETES_SERVICE_HOST"] = "10.0.0.1";
  delete process.env["KUBECONFIG"];
});

afterEach(() => {
  _resetK8sClientForTests();
  if (origKubernetesServiceHost === undefined) {
    delete process.env["KUBERNETES_SERVICE_HOST"];
  } else {
    process.env["KUBERNETES_SERVICE_HOST"] = origKubernetesServiceHost;
  }
  if (origKubeconfig === undefined) {
    delete process.env["KUBECONFIG"];
  } else {
    process.env["KUBECONFIG"] = origKubeconfig;
  }
});

describe("spawnEphemeralDaemon: Pod spec", () => {
  it("submits a Pod to the configured namespace with DAEMON_EPHEMERAL=true", async () => {
    await spawnEphemeralDaemon({
      deliveryId: "del-abc-123",
      image: "ghcr.io/org/daemon:1.0.0",
      orchestratorUrl: "wss://orch.example.com",
    });

    expect(createNamespacedPod).toHaveBeenCalledTimes(1);
    const call = createNamespacedPod.mock.calls[0] as [CapturedCall];
    const { namespace, body } = call[0];
    expect(namespace).toBe("default");

    const container = (
      body as {
        spec: { containers: [{ env: { name: string; value: string }[]; image: string }] };
      }
    ).spec.containers[0];
    expect(container.image).toBe("ghcr.io/org/daemon:1.0.0");
    const envMap = new Map(container.env.map((e) => [e.name, e.value]));
    expect(envMap.get("DAEMON_EPHEMERAL")).toBe("true");
    expect(envMap.get("ORCHESTRATOR_URL")).toBe("wss://orch.example.com");
    expect(envMap.get("LD_PRELOAD")).toBe("/usr/local/lib/github-app/daemon-process-guard.so");
    // Credentials (including DAEMON_AUTH_TOKEN) must come from the
    // `daemon-secrets` Secret via envFrom, never inline in the Pod spec,
    // where they'd be readable via `kubectl get pod -o yaml`.
    expect(envMap.has("DAEMON_AUTH_TOKEN")).toBe(false);
    expect(envMap.get("EPHEMERAL_DAEMON_IDLE_TIMEOUT_MS")).toBeDefined();
  });

  it("refuses to automount the default ServiceAccount token", async () => {
    await spawnEphemeralDaemon({
      deliveryId: "del-sa",
      image: "ghcr.io/org/daemon:1.0.0",
      orchestratorUrl: "wss://orch.example.com",
    });
    const call = createNamespacedPod.mock.calls[0] as [CapturedCall];
    const spec = (call[0].body as { spec: { automountServiceAccountToken: boolean } }).spec;
    expect(spec.automountServiceAccountToken).toBe(false);
  });

  it("runs without CAP_SYS_PTRACE or privilege escalation", async () => {
    await spawnEphemeralDaemon({
      deliveryId: "del-security",
      image: "ghcr.io/org/daemon:1.0.0",
      orchestratorUrl: "wss://orch.example.com",
    });
    const call = createNamespacedPod.mock.calls[0] as [CapturedCall];
    const securityContext = (
      call[0].body as {
        spec: {
          containers: [
            {
              securityContext: {
                allowPrivilegeEscalation: boolean;
                capabilities: { drop: string[] };
              };
            },
          ];
        };
      }
    ).spec.containers[0].securityContext;
    expect(securityContext.allowPrivilegeEscalation).toBe(false);
    expect(securityContext.capabilities.drop).toEqual(["ALL"]);
  });

  it("sanitises an unsafe deliveryId into a valid K8s label value", async () => {
    await spawnEphemeralDaemon({
      deliveryId: "-Weird/Delivery.Id!!",
      image: "ghcr.io/org/daemon:1.0.0",
      orchestratorUrl: "wss://orch.example.com",
    });
    const call = createNamespacedPod.mock.calls[0] as [CapturedCall];
    const labels = (call[0].body as { metadata: { labels: Record<string, string> } }).metadata
      .labels;
    const value = labels["github-app/delivery-id"] ?? "";
    expect(value).toMatch(/^[a-z0-9]([-a-z0-9._]*[a-z0-9])?$/);
    expect(value.length).toBeLessThanOrEqual(63);
  });

  it("sets restartPolicy=Never and an activeDeadlineSeconds ceiling", async () => {
    await spawnEphemeralDaemon({
      deliveryId: "del-xyz",
      image: "ghcr.io/org/daemon:1.0.0",
      orchestratorUrl: "wss://orch.example.com",
    });
    const call = createNamespacedPod.mock.calls[0] as [CapturedCall];
    const spec = (
      call[0].body as { spec: { restartPolicy: string; activeDeadlineSeconds: number } }
    ).spec;
    expect(spec.restartPolicy).toBe("Never");
    expect(spec.activeDeadlineSeconds).toBeGreaterThan(0);
  });

  // Pins the EPHEMERAL_DAEMON_SECRET_NAME default: a deployment that never sets
  // it keeps mounting `daemon-secrets`.
  it("pulls credentials from the configured Secret via envFrom", async () => {
    await spawnEphemeralDaemon({
      deliveryId: "del-sec",
      image: "ghcr.io/org/daemon:1.0.0",
      orchestratorUrl: "wss://orch.example.com",
    });
    const call = createNamespacedPod.mock.calls[0] as [CapturedCall];
    const envFrom = (
      call[0].body as {
        spec: { containers: [{ envFrom: { secretRef: { name: string } }[] }] };
      }
    ).spec.containers[0].envFrom;
    expect(envFrom[0]?.secretRef.name).toBe("daemon-secrets");
  });
});

describe("spawnEphemeralDaemon: error kinds", () => {
  it("throws infra-absent when neither KUBERNETES_SERVICE_HOST nor KUBECONFIG is set", async () => {
    delete process.env["KUBERNETES_SERVICE_HOST"];
    delete process.env["KUBECONFIG"];
    _resetK8sClientForTests();
    let caught: unknown;
    try {
      await spawnEphemeralDaemon({
        deliveryId: "x",
        image: "img",
        orchestratorUrl: "wss://x",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EphemeralSpawnError);
    expect((caught as InstanceType<typeof EphemeralSpawnError>).kind).toBe("infra-absent");
  });

  it("does not expose kubeconfig parser context when authentication loading fails", async () => {
    delete process.env["KUBERNETES_SERVICE_HOST"];
    process.env["KUBECONFIG"] = "/tmp/malformed-kubeconfig";
    loadFromDefaultError = new Error("password: kube-secret\nclient-key-data: private-key");
    _resetK8sClientForTests();

    let caught: unknown;
    try {
      await spawnEphemeralDaemon({
        deliveryId: "x",
        image: "img",
        orchestratorUrl: "wss://x",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(EphemeralSpawnError);
    expect((caught as InstanceType<typeof EphemeralSpawnError>).kind).toBe("auth-load-failed");
    expect((caught as Error).message).toBe(
      "Kubernetes authentication configuration could not be loaded",
    );
    expect((caught as Error).message).not.toContain("kube-secret");
    expect((caught as Error).message).not.toContain("private-key");
  });

  it("maps 4xx to api-rejected", async () => {
    createNamespacedPod.mockImplementation(() => {
      const err = new Error("forbidden") as Error & { statusCode: number };
      err.statusCode = 403;
      return Promise.reject(err);
    });
    let caught: unknown;
    try {
      await spawnEphemeralDaemon({
        deliveryId: "x",
        image: "img",
        orchestratorUrl: "wss://x",
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as InstanceType<typeof EphemeralSpawnError>).kind).toBe("api-rejected");
  });

  it("maps 5xx / network errors to api-unavailable", async () => {
    createNamespacedPod.mockImplementation(() => Promise.reject(new Error("ECONNREFUSED")));
    let caught: unknown;
    try {
      await spawnEphemeralDaemon({
        deliveryId: "x",
        image: "img",
        orchestratorUrl: "wss://x",
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as InstanceType<typeof EphemeralSpawnError>).kind).toBe("api-unavailable");
  });
});
