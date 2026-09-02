import type { V1Container, V1EnvVar, V1Pod } from "@kubernetes/client-node";

const NAMESPACE = "github-app-runners";
const POLICY = "github-app-workflow-runner-boundary";
const BOUNDARY_CONFIG_MAP = "workflow-runner-boundary";
const EGRESS_POLICY = "github-app-workflow-runner-egress-boundary";
const IMAGE = `registry.example/github-app@sha256:${"a".repeat(64)}`;
const ORIGIN = "wss://orchestrator.example.internal:3002";
// The one pull secret the boundary pins. Runner Pods carry no ServiceAccount
// token, so the kubelet reads this while the container never can.
const PULL_SECRET = "runner-registry-credentials";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const PROVIDER_ENV_NAMES = new Set([
  "CLAUDE_PROVIDER",
  "CLAUDE_MODEL",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ALLOWED_OWNERS",
]);

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function kubectl(args: readonly string[], input?: string): Promise<CommandResult> {
  const process = Bun.spawn(["kubectl", ...args], {
    stdin: input === undefined ? undefined : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function requireSuccess(result: CommandResult, action: string): void {
  if (result.exitCode === 0) return;
  throw new Error(`${action} failed: ${result.stderr || result.stdout}`);
}

async function requireDenied(pod: V1Pod, caseName: string): Promise<void> {
  const result = await kubectl(
    ["create", "--dry-run=server", "--output=name", "--filename=-"],
    JSON.stringify(pod),
  );
  if (result.exitCode === 0 || !`${result.stdout}\n${result.stderr}`.includes(POLICY)) {
    throw new Error(`${caseName} was not denied by ${POLICY}: ${result.stderr || result.stdout}`);
  }
}

/**
 * Poll until the policy denies `pod`. `configureBoundaryOrigin` patches the
 * ConfigMap and returns immediately, so a plain `requireDenied` right after a
 * patch can be satisfied by the previous parameters rather than the new ones.
 */
async function requireDeniedEventually(pod: V1Pod, caseName: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await kubectl(
      ["create", "--dry-run=server", "--output=name", "--filename=-"],
      JSON.stringify(pod),
    );
    if (result.exitCode !== 0 && `${result.stdout}\n${result.stderr}`.includes(POLICY)) return;
    // eslint-disable-next-line no-await-in-loop -- ConfigMap admission parameters propagate asynchronously
    await Bun.sleep(1_000);
  }
  throw new Error(`${caseName} was never denied by ${POLICY}`);
}

async function requireAdmitted(pod: V1Pod, caseName: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await kubectl(
      ["create", "--dry-run=server", "--output=name", "--filename=-"],
      JSON.stringify(pod),
    );
    if (result.exitCode === 0) return;
    if (!`${result.stdout}\n${result.stderr}`.includes(POLICY)) {
      requireSuccess(result, `admit ${caseName}`);
    }
    // eslint-disable-next-line no-await-in-loop -- ConfigMap admission parameters propagate asynchronously
    await Bun.sleep(100);
  }
  throw new Error(`${caseName} was not admitted after boundary parameter propagation`);
}

async function requireUpdateDenied(pod: V1Pod, caseName: string): Promise<void> {
  const result = await kubectl(
    ["replace", "--dry-run=server", "--output=name", "--filename=-"],
    JSON.stringify(pod),
  );
  if (result.exitCode === 0 || !`${result.stdout}\n${result.stderr}`.includes(POLICY)) {
    throw new Error(`${caseName} was not denied by ${POLICY}: ${result.stderr || result.stdout}`);
  }
}

async function requirePodSecurityDenied(pod: V1Pod): Promise<void> {
  const result = await kubectl(
    ["create", "--dry-run=server", "--output=name", "--filename=-"],
    JSON.stringify(pod),
  );
  if (
    result.exitCode === 0 ||
    !`${result.stdout}\n${result.stderr}`.includes('violates PodSecurity "restricted:v1.30"')
  ) {
    throw new Error(`Restricted Pod Security did not deny host networking: ${result.stderr}`);
  }
}

function runner(pod: V1Pod): V1Container {
  const container = pod.spec?.containers[0];
  if (container === undefined) throw new Error("Rendered Pod has no runner container");
  return container;
}

function providerSetting(name: string, value: string): V1EnvVar {
  return { name, value };
}

function providerCredential(name: string): V1EnvVar {
  return {
    name,
    valueFrom: {
      secretKeyRef: { name: "workflow-runner-secrets", key: name, optional: false },
    },
  };
}

function replaceProviderEnvironment(pod: V1Pod, providerEnv: readonly V1EnvVar[]): void {
  const container = runner(pod);
  container.env = [
    ...(container.env ?? []).filter((entry) => !PROVIDER_ENV_NAMES.has(entry.name)),
    ...providerEnv,
  ];
}

function providerBoundaryData(providerEnv: readonly V1EnvVar[]): Record<string, string> {
  const settings = new Map(
    providerEnv.flatMap((entry) => (entry.value === undefined ? [] : [[entry.name, entry.value]])),
  );
  const credentials = providerEnv
    .filter((entry) => entry.valueFrom?.secretKeyRef !== undefined)
    .map((entry) => entry.name);
  const provider = settings.get("CLAUDE_PROVIDER");
  const model = settings.get("CLAUDE_MODEL");
  if (provider === undefined || model === undefined || credentials.length === 0) {
    throw new Error("Provider environment cannot produce boundary parameters");
  }
  return {
    provider,
    model,
    awsRegion: settings.get("AWS_REGION") ?? "",
    anthropicBedrockBaseUrl: settings.get("ANTHROPIC_BEDROCK_BASE_URL") ?? "",
    allowedOwners: settings.get("ALLOWED_OWNERS") ?? "",
    providerCredential1: credentials[0] ?? "",
    providerCredential2: credentials[1] ?? "",
    providerCredential3: credentials[2] ?? "",
  };
}

async function configureBoundaryProvider(providerEnv: readonly V1EnvVar[]): Promise<void> {
  requireSuccess(
    await kubectl([
      "patch",
      "configmap",
      BOUNDARY_CONFIG_MAP,
      "--namespace",
      NAMESPACE,
      "--type=merge",
      "--patch",
      JSON.stringify({ data: providerBoundaryData(providerEnv) }),
    ]),
    "update provider boundary parameters",
  );
}

async function configureBoundaryOrigin(origin: string): Promise<void> {
  requireSuccess(
    await kubectl([
      "patch",
      "configmap",
      BOUNDARY_CONFIG_MAP,
      "--namespace",
      NAMESPACE,
      "--type=merge",
      "--patch",
      JSON.stringify({ data: { orchestratorOrigin: origin } }),
    ]),
    "update boundary orchestrator origin",
  );
}

function podWithOrigin(pod: V1Pod, origin: string): V1Pod {
  const clone = structuredClone(pod);
  const entry = runner(clone).env?.find((candidate) => candidate.name === "ORCHESTRATOR_URL");
  if (entry?.value === undefined) throw new Error("Pod has no ORCHESTRATOR_URL value");
  entry.value = `${origin}${new URL(entry.value).pathname}`;
  return clone;
}

async function waitForPolicyTypecheck(): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await kubectl(["get", "validatingadmissionpolicy", POLICY, "--output=json"]);
    requireSuccess(result, "read admission policy status");
    const policy = JSON.parse(result.stdout) as {
      metadata?: { generation?: number };
      status?: {
        observedGeneration?: number;
        typeChecking?: { expressionWarnings?: unknown[] };
      };
    };
    if (policy.status?.observedGeneration === policy.metadata?.generation) {
      const warnings = policy.status.typeChecking?.expressionWarnings ?? [];
      if (warnings.length > 0) {
        throw new Error(`Admission policy has CEL warnings: ${JSON.stringify(warnings)}`);
      }
      return;
    }
    // eslint-disable-next-line no-await-in-loop -- bounded API status poll
    await Bun.sleep(1_000);
  }
  throw new Error("Admission policy type checking did not observe the current generation");
}

async function waitForPolicyEnforcement(pod: V1Pod): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await kubectl(
      ["create", "--dry-run=server", "--output=name", "--filename=-"],
      JSON.stringify(pod),
    );
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.exitCode !== 0 && output.includes(POLICY)) return;
    if (result.exitCode !== 0) {
      throw new Error(`Admission readiness probe failed outside ${POLICY}: ${output}`);
    }
    // eslint-disable-next-line no-await-in-loop -- bounded admission propagation poll
    await Bun.sleep(1_000);
  }
  throw new Error(`${POLICY} did not enforce its binding within 30 seconds`);
}

async function main(): Promise<void> {
  process.env["NODE_ENV"] ??= "test";
  process.env["GITHUB_APP_ID"] ??= "1";
  process.env["GITHUB_APP_PRIVATE_KEY"] ??= "admission-test-private-key";
  process.env["GITHUB_WEBHOOK_SECRET"] ??= "admission-test-webhook-secret";
  process.env["CLAUDE_PROVIDER"] = "anthropic";
  process.env["CLAUDE_MODEL"] = "claude-test";
  process.env["ANTHROPIC_API_KEY"] = "admission-test-provider-key";
  Reflect.deleteProperty(process.env, "CLAUDE_CODE_OAUTH_TOKEN");
  process.env["DATABASE_URL"] ??= "postgres://test:test@127.0.0.1/test";
  process.env["VALKEY_URL"] ??= "redis://127.0.0.1:6379";
  process.env["DAEMON_AUTH_TOKEN"] ??= "admission-test-daemon-token";
  process.env["WORKFLOW_RUNNER_CAPABILITY_SECRET"] ??=
    "admission-test-workflow-runner-capability-secret";
  process.env["WORKFLOW_RUNNER_NAMESPACE"] = NAMESPACE;
  process.env["WORKFLOW_RUNNER_IMAGE_PULL_SECRET"] = PULL_SECRET;

  // Imported here, not at module scope: the spawner pulls in src/config, which
  // must not load until the env block above has run. The later import of the
  // same module resolves from cache.
  const {
    WORKFLOW_RUNNER_NODE_LABEL,
    WORKFLOW_RUNNER_NODE_VALUE,
    WORKFLOW_RUNNER_IMAGE_PULL_SECRET,
  } = await import("../src/k8s/workflow-runner-spawner");

  const source = await Bun.file("examples/workflow-runner-admission.yaml").text();
  const manifest = source
    .replace("REPLACE_WITH_EXACT_DAEMON_IMAGE", IMAGE)
    .replace("wss://orchestrator.example.internal:3002", ORIGIN)
    .replace("REPLACE_WITH_CLAUDE_PROVIDER", "anthropic")
    .replace("REPLACE_WITH_CLAUDE_MODEL", "claude-test")
    .replace("REPLACE_WITH_AWS_REGION_OR_EMPTY", "")
    .replace("REPLACE_WITH_BEDROCK_BASE_URL_OR_EMPTY", "")
    .replace("REPLACE_WITH_ALLOWED_OWNERS_OR_EMPTY", "")
    .replace("REPLACE_WITH_PROVIDER_CREDENTIAL_1", "ANTHROPIC_API_KEY")
    .replace("REPLACE_WITH_PROVIDER_CREDENTIAL_2_OR_EMPTY", "")
    .replace("REPLACE_WITH_PROVIDER_CREDENTIAL_3_OR_EMPTY", "")
    // Sourced from the spawner rather than hardcoded, so the boundary params can
    // never drift from the nodeSelector and toleration the Pod actually carries.
    .replace("REPLACE_WITH_WORKFLOW_RUNNER_NODE_LABEL", WORKFLOW_RUNNER_NODE_LABEL)
    .replace("REPLACE_WITH_WORKFLOW_RUNNER_NODE_VALUE", WORKFLOW_RUNNER_NODE_VALUE)
    .replace("REPLACE_WITH_RUNNER_IMAGE_PULL_SECRET_OR_EMPTY", WORKFLOW_RUNNER_IMAGE_PULL_SECRET);
  // A placeholder added to the example without a substitution here installs a
  // boundary that silently denies the exact Pod, which is how the two node
  // placeholders went unnoticed. Fail on the manifest instead of on the assertion.
  const unsubstituted = [...manifest.matchAll(/REPLACE_WITH_[A-Z_0-9]+/g)].map((m) => m[0]);
  if (unsubstituted.length > 0) {
    throw new Error(
      `examples/workflow-runner-admission.yaml has placeholders this harness does not substitute: ${[...new Set(unsubstituted)].join(", ")}`,
    );
  }
  requireSuccess(await kubectl(["apply", "--filename=-"], manifest), "install admission policy");
  const egress = await kubectl([
    "get",
    "networkpolicy",
    EGRESS_POLICY,
    "--namespace",
    NAMESPACE,
    "--output=json",
  ]);
  requireSuccess(egress, "read workflow runner egress policy");
  const egressPolicy = JSON.parse(egress.stdout) as {
    spec?: {
      policyTypes?: string[];
      egress?: Array<{
        to?: Array<{ ipBlock?: { cidr?: string; except?: string[] } }>;
        ports?: Array<{ protocol?: string; port?: number }>;
      }>;
    };
  };
  const publicRule = egressPolicy.spec?.egress?.find((rule) =>
    rule.to?.some((peer) => peer.ipBlock?.cidr === "0.0.0.0/0"),
  );
  const ipv4Public = publicRule?.to?.find((peer) => peer.ipBlock?.cidr === "0.0.0.0/0");
  const ipv6Public = publicRule?.to?.find((peer) => peer.ipBlock?.cidr === "::/0");
  if (
    !egressPolicy.spec?.policyTypes?.includes("Egress") ||
    (egressPolicy.spec.egress?.length ?? 0) !== 3 ||
    publicRule?.ports?.length !== 1 ||
    publicRule.ports[0]?.protocol !== "TCP" ||
    publicRule.ports[0]?.port !== 443 ||
    !ipv4Public?.ipBlock?.except?.includes("10.0.0.0/8") ||
    !ipv4Public.ipBlock.except.includes("169.254.0.0/16") ||
    !ipv6Public?.ipBlock?.except?.includes("fc00::/7") ||
    !ipv6Public.ipBlock.except.includes("fe80::/10")
  ) {
    throw new Error("Workflow runner egress policy is not the expected private-network boundary");
  }
  await waitForPolicyTypecheck();

  const { buildWorkflowRunnerPod } = await import("../src/k8s/workflow-runner-spawner");
  const attempt = {
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    runnerId: `workflow-runner:${ATTEMPT_ID}`,
    executionDeliveryId: "admission-test-delivery",
    workflowName: "implement" as const,
    attemptDeadlineAt: new Date("2026-08-23T04:10:00Z"),
  };
  const desired = buildWorkflowRunnerPod(attempt, IMAGE, ORIGIN);
  const desiredProviderEnv = (runner(desired).env ?? []).filter((entry) =>
    PROVIDER_ENV_NAMES.has(entry.name),
  );
  await configureBoundaryProvider(desiredProviderEnv);
  const readinessProbe = structuredClone(desired);
  readinessProbe.spec?.containers.push({
    ...structuredClone(runner(readinessProbe)),
    name: "binding-readiness-probe",
  });
  await waitForPolicyEnforcement(readinessProbe);
  await requireAdmitted(desired, "exact production-rendered Pod");

  const bedrockBearerProviderEnv = [
    providerSetting("CLAUDE_PROVIDER", "bedrock"),
    providerSetting("CLAUDE_MODEL", "claude-test"),
    providerSetting("AWS_REGION", "ap-southeast-2"),
    providerSetting("ANTHROPIC_BEDROCK_BASE_URL", "https://bedrock.example.test/runtime"),
    providerSetting("ALLOWED_OWNERS", "owner-a,owner-b"),
    providerCredential("AWS_BEARER_TOKEN_BEDROCK"),
  ] as const;
  const supportedProviderCases: readonly [string, readonly V1EnvVar[]][] = [
    [
      "Anthropic OAuth Pod",
      [
        providerSetting("CLAUDE_PROVIDER", "anthropic"),
        providerSetting("CLAUDE_MODEL", "claude-test"),
        providerCredential("CLAUDE_CODE_OAUTH_TOKEN"),
      ],
    ],
    ["Bedrock bearer Pod", bedrockBearerProviderEnv],
    [
      "Bedrock static Pod",
      [
        providerSetting("CLAUDE_PROVIDER", "bedrock"),
        providerSetting("CLAUDE_MODEL", "claude-test"),
        providerSetting("AWS_REGION", "ap-southeast-2"),
        providerCredential("AWS_ACCESS_KEY_ID"),
        providerCredential("AWS_SECRET_ACCESS_KEY"),
      ],
    ],
    [
      "Bedrock static session Pod",
      [
        providerSetting("CLAUDE_PROVIDER", "bedrock"),
        providerSetting("CLAUDE_MODEL", "claude-test"),
        providerSetting("AWS_REGION", "ap-southeast-2"),
        providerCredential("AWS_ACCESS_KEY_ID"),
        providerCredential("AWS_SECRET_ACCESS_KEY"),
        providerCredential("AWS_SESSION_TOKEN"),
      ],
    ],
  ];
  for (const [caseName, providerEnv] of supportedProviderCases) {
    // eslint-disable-next-line no-await-in-loop -- each provider is a separate protected parameter set
    await configureBoundaryProvider(providerEnv);
    const pod = structuredClone(desired);
    replaceProviderEnvironment(pod, providerEnv);
    // eslint-disable-next-line no-await-in-loop -- each provider is a separate server-side policy assertion
    await requireAdmitted(pod, caseName);
  }

  await configureBoundaryProvider(bedrockBearerProviderEnv);
  const exactBedrockPod = structuredClone(desired);
  replaceProviderEnvironment(exactBedrockPod, bedrockBearerProviderEnv);
  await requireAdmitted(exactBedrockPod, "Bedrock bearer mutation baseline");
  const exactSettingMutations: readonly [string, string, string][] = [
    ["Bedrock model mutation", "CLAUDE_MODEL", "changed-model"],
    ["Bedrock region mutation", "AWS_REGION", "us-east-1"],
    [
      "Bedrock base URL mutation",
      "ANTHROPIC_BEDROCK_BASE_URL",
      "https://other.example.test/runtime",
    ],
    ["Bedrock owner mutation", "ALLOWED_OWNERS", "other-owner"],
  ];
  for (const [caseName, name, value] of exactSettingMutations) {
    const pod = structuredClone(exactBedrockPod);
    const setting = runner(pod).env?.find((entry) => entry.name === name);
    if (setting === undefined) throw new Error(`${caseName} setting is missing`);
    setting.value = value;
    // eslint-disable-next-line no-await-in-loop -- each setting is an independent exact-value assertion
    await requireDenied(pod, caseName);
  }

  await configureBoundaryProvider(desiredProviderEnv);
  await requireAdmitted(desired, "restored Anthropic mutation baseline");

  // Plaintext is permitted only to a cluster-local Service name, so an in-cluster
  // runner can dial the orchestrator directly rather than hairpinning out through
  // an ingress VIP. Every other origin must still be wss://.
  const clusterLocalOrigin = "ws://github-app.github-app.svc.cluster.local:3002";
  await configureBoundaryOrigin(clusterLocalOrigin);
  await requireAdmitted(podWithOrigin(desired, clusterLocalOrigin), "cluster-local ws:// origin");
  const publicPlaintextOrigin = "ws://orchestrator.example.com:3002";
  await configureBoundaryOrigin(publicPlaintextOrigin);
  // Prove the patch landed before asserting the denial. The Pod admitted one
  // line above must now be rejected, which can only happen once the params
  // carry the non-cluster-local ws:// origin and fail the scheme rule. Without
  // this the next assertion passes on the stale params via origin equality.
  await requireDeniedEventually(
    podWithOrigin(desired, clusterLocalOrigin),
    "cluster-local Pod under a non-cluster-local ws:// boundary origin",
  );
  await requireDenied(
    podWithOrigin(desired, publicPlaintextOrigin),
    "plaintext origin outside the cluster",
  );
  await configureBoundaryOrigin(ORIGIN);
  await requireAdmitted(desired, "restored wss:// origin baseline");

  const hostNetworkPod = structuredClone(desired);
  if (hostNetworkPod.spec !== undefined) hostNetworkPod.spec.hostNetwork = true;
  await requirePodSecurityDenied(hostNetworkPod);

  // Exercise the custom policy independently after proving the production PSA layer.
  requireSuccess(
    await kubectl([
      "label",
      "namespace",
      NAMESPACE,
      "pod-security.kubernetes.io/enforce=privileged",
      "--overwrite",
    ]),
    "relax disposable namespace Pod Security enforcement",
  );

  const cases: readonly [string, (pod: V1Pod) => void][] = [
    [
      "extra sidecar",
      (pod) => pod.spec?.containers.push({ ...structuredClone(runner(pod)), name: "sidecar" }),
    ],
    [
      "lifecycle hook",
      (pod) => (runner(pod).lifecycle = { postStart: { exec: { command: ["env"] } } }),
    ],
    [
      "envFrom",
      (pod) => (runner(pod).envFrom = [{ secretRef: { name: "workflow-runner-secrets" } }]),
    ],
    [
      "dual Anthropic credential",
      (pod) =>
        runner(pod).env?.push({
          name: "CLAUDE_CODE_OAUTH_TOKEN",
          valueFrom: {
            secretKeyRef: {
              name: "workflow-runner-secrets",
              key: "CLAUDE_CODE_OAUTH_TOKEN",
              optional: false,
            },
          },
        }),
    ],
    [
      "cross-provider credential",
      (pod) =>
        runner(pod).env?.push({
          name: "AWS_BEARER_TOKEN_BEDROCK",
          valueFrom: {
            secretKeyRef: {
              name: "workflow-runner-secrets",
              key: "AWS_BEARER_TOKEN_BEDROCK",
              optional: false,
            },
          },
        }),
    ],
    [
      "optional selected credential",
      (pod) => {
        const selected = runner(pod).env?.find((entry) => entry.name === "ANTHROPIC_API_KEY");
        if (selected?.valueFrom?.secretKeyRef === undefined) {
          throw new Error("Rendered Pod has no selected provider credential");
        }
        selected.valueFrom.secretKeyRef.optional = true;
      },
    ],
    [
      "changed provider model",
      (pod) => {
        const model = runner(pod).env?.find((entry) => entry.name === "CLAUDE_MODEL");
        if (model === undefined) throw new Error("Rendered Pod has no provider model");
        model.value = "changed-model";
      },
    ],
    [
      "switched Anthropic credential",
      (pod) =>
        replaceProviderEnvironment(pod, [
          providerSetting("CLAUDE_PROVIDER", "anthropic"),
          providerSetting("CLAUDE_MODEL", "claude-test"),
          providerCredential("CLAUDE_CODE_OAUTH_TOKEN"),
        ]),
    ],
    [
      "added Bedrock base URL",
      (pod) =>
        runner(pod).env?.push(
          providerSetting("ANTHROPIC_BEDROCK_BASE_URL", "https://bedrock.example.test"),
        ),
    ],
    [
      "added owner setting",
      (pod) => runner(pod).env?.push(providerSetting("ALLOWED_OWNERS", "other-owner")),
    ],
    [
      "incomplete Bedrock static chain",
      (pod) =>
        replaceProviderEnvironment(pod, [
          providerSetting("CLAUDE_PROVIDER", "bedrock"),
          providerSetting("CLAUDE_MODEL", "claude-test"),
          providerSetting("AWS_REGION", "ap-southeast-2"),
          providerCredential("AWS_ACCESS_KEY_ID"),
        ]),
    ],
    [
      "mixed Bedrock credential chains",
      (pod) =>
        replaceProviderEnvironment(pod, [
          providerSetting("CLAUDE_PROVIDER", "bedrock"),
          providerSetting("CLAUDE_MODEL", "claude-test"),
          providerSetting("AWS_REGION", "ap-southeast-2"),
          providerCredential("AWS_BEARER_TOKEN_BEDROCK"),
          providerCredential("AWS_ACCESS_KEY_ID"),
          providerCredential("AWS_SECRET_ACCESS_KEY"),
        ]),
    ],
    [
      "Bedrock session without static chain",
      (pod) =>
        replaceProviderEnvironment(pod, [
          providerSetting("CLAUDE_PROVIDER", "bedrock"),
          providerSetting("CLAUDE_MODEL", "claude-test"),
          providerSetting("AWS_REGION", "ap-southeast-2"),
          providerCredential("AWS_SESSION_TOKEN"),
        ]),
    ],
    [
      "Bedrock bearer without region",
      (pod) =>
        replaceProviderEnvironment(pod, [
          providerSetting("CLAUDE_PROVIDER", "bedrock"),
          providerSetting("CLAUDE_MODEL", "claude-test"),
          providerCredential("AWS_BEARER_TOKEN_BEDROCK"),
        ]),
    ],
    ["changed image", (pod) => (runner(pod).image = "registry.example/attacker:latest")],
    [
      "direct node assignment",
      (pod) => {
        if (pod.spec !== undefined) pod.spec.nodeName = "github-app-admission-control-plane";
      },
    ],
    [
      "node affinity",
      (pod) => {
        if (pod.spec !== undefined) {
          pod.spec.affinity = {
            nodeAffinity: {
              requiredDuringSchedulingIgnoredDuringExecution: {
                nodeSelectorTerms: [
                  { matchExpressions: [{ key: "kubernetes.io/hostname", operator: "Exists" }] },
                ],
              },
            },
          };
        }
      },
    ],
    [
      "critical priority class",
      (pod) => {
        if (pod.spec !== undefined) pod.spec.priorityClassName = "system-node-critical";
      },
    ],
    [
      "scheduling gate",
      (pod) => {
        if (pod.spec !== undefined) {
          pod.spec.schedulingGates = [{ name: "attacker.example/hold" }];
        }
      },
    ],
    [
      "image pull secret naming a Secret the boundary does not pin",
      (pod) => {
        if (pod.spec !== undefined) {
          pod.spec.imagePullSecrets = [{ name: "workflow-runner-secrets" }];
        }
      },
    ],
    [
      // The boundary allows one entry, so the count is the only thing stopping a
      // second Secret riding along with the pinned one.
      "second image pull secret alongside the pinned one",
      (pod) => {
        if (pod.spec !== undefined) {
          pod.spec.imagePullSecrets = [{ name: PULL_SECRET }, { name: "workflow-runner-secrets" }];
        }
      },
    ],
    [
      "node selector",
      (pod) => {
        if (pod.spec !== undefined) pod.spec.nodeSelector = { "attacker.example/node": "true" };
      },
    ],
    [
      "missing dedicated node selector",
      (pod) => {
        if (pod.spec !== undefined) pod.spec.nodeSelector = {};
      },
    ],
    [
      "extra dedicated node selector",
      (pod) => {
        if (pod.spec !== undefined) {
          pod.spec.nodeSelector = { ...pod.spec.nodeSelector, "attacker.example/node": "true" };
        }
      },
    ],
    [
      "missing dedicated node taint toleration",
      (pod) => {
        if (pod.spec !== undefined) {
          // Keep the two built-in node-condition tolerations, drop the
          // dedicated-node one. Derived from the shape rather than a literal
          // key, since WORKFLOW_RUNNER_NODE_LABEL is deployment-configurable.
          pod.spec.tolerations = pod.spec.tolerations?.filter((entry) =>
            (entry.key ?? "").startsWith("node.kubernetes.io/"),
          );
        }
      },
    ],
    [
      "custom toleration",
      (pod) => {
        if (pod.spec !== undefined) {
          pod.spec.tolerations = [
            ...(pod.spec.tolerations ?? []),
            { key: "attacker.example/taint", operator: "Exists" },
          ];
        }
      },
    ],
    [
      "readiness gate",
      (pod) => {
        if (pod.spec !== undefined) {
          pod.spec.readinessGates = [{ conditionType: "attacker.example/ready" }];
        }
      },
    ],
    [
      "host network",
      (pod) => {
        if (pod.spec !== undefined) pod.spec.hostNetwork = true;
      },
    ],
    [
      "hostPath workspace",
      (pod) => {
        if (pod.spec !== undefined) {
          pod.spec.volumes = [{ name: "workspace", hostPath: { path: "/" } }];
        }
      },
    ],
    [
      "resource inflation",
      (pod) => {
        const resources = runner(pod).resources;
        if (resources === undefined) throw new Error("Rendered Pod has no resources");
        resources.limits = { ...resources.limits, cpu: "8" };
      },
    ],
    [
      "extra label",
      (pod) => {
        pod.metadata ??= {};
        pod.metadata.labels = { ...pod.metadata.labels, attacker: "true" };
      },
    ],
  ];
  for (const [caseName, mutate] of cases) {
    const pod = structuredClone(desired);
    mutate(pod);
    // eslint-disable-next-line no-await-in-loop -- each denial is an independent API assertion
    await requireDenied(pod, caseName);
  }

  await requireDenied(
    {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "alternate-name", namespace: NAMESPACE },
      spec: {
        containers: [{ name: "escape", image: "busybox", securityContext: { privileged: true } }],
      },
    },
    "non-runner Pod name",
  );

  requireSuccess(
    await kubectl(["create", "--output=name", "--filename=-"], JSON.stringify(desired)),
    "create exact Pod for ephemeral-container subresource test",
  );
  const podName = desired.metadata?.name ?? "";
  const livePodResult = await kubectl([
    "get",
    "pod",
    podName,
    `--namespace=${NAMESPACE}`,
    "--output=json",
  ]);
  requireSuccess(livePodResult, "read exact Pod for ephemeral-container subresource test");
  const livePod = JSON.parse(livePodResult.stdout) as V1Pod;
  if (livePod.spec === undefined) throw new Error("Live Pod has no spec");
  const imageUpdate = structuredClone(livePod);
  runner(imageUpdate).image = `registry.example/github-app@sha256:${"b".repeat(64)}`;
  await requireUpdateDenied(imageUpdate, "ordinary Pod image update");

  livePod.spec.ephemeralContainers = [
    { name: "debug", image: "busybox", command: ["sh"], stdin: true, tty: true },
  ];
  const ephemeral = await kubectl(
    [
      "replace",
      `--raw=/api/v1/namespaces/${NAMESPACE}/pods/${podName}/ephemeralcontainers?dryRun=All`,
      "--filename=-",
    ],
    JSON.stringify(livePod),
  );
  if (ephemeral.exitCode === 0 || !`${ephemeral.stdout}\n${ephemeral.stderr}`.includes(POLICY)) {
    throw new Error(`ephemeral-container update was not denied: ${ephemeral.stderr}`);
  }

  console.log("workflow runner admission policy passed");
}

await main();
