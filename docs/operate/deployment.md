# Deployment

The repository ships **two container images**, an orchestrator and a daemon, built from separate Dockerfiles that share a byte-identical base.

## Image topology

| Image          | Dockerfile                | Role                                                                                                                                              | Outbound network                                            |
| -------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `orchestrator` | `Dockerfile.orchestrator` | Webhook server, WebSocket daemon registry, triage classifier, ephemeral-daemon spawner.                                                           | GitHub API, Anthropic / Bedrock, Postgres, Valkey, K8s API. |
| `daemon`       | `Dockerfile.daemon`       | Toolchain image for shared daemons and one-attempt workflow runners (`kubectl`, `helm`, `terraform`, `aws`, `gcloud`, `docker`, `go`, `rust`, …). | Orchestrator WebSocket (outbound), GitHub API, AI provider. |

The `daemon` image additionally bundles `@mermaid-js/mermaid-cli` (`mmdc`) plus a headless Chromium, used by the scheduled `research` action's diagram-validation gate. Agents run in a shared daemon or an isolated workflow runner built from this image, never in the orchestrator.

The two images intentionally diverge after the shared base because their cost and attack surface differ. The shared prefix is enforced byte-identical by `scripts/check-dockerfile-base-sync.ts` (in CI) between the `# --- SHARED-BASE-BEGIN ---` and `# --- SHARED-BASE-END ---` markers.

### Shared base stages

| Stage         | Base              | Purpose                                                                                                                                         |
| ------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `base`        | `oven/bun:1.3.14` | Installs Node.js 20 (for the Claude Code CLI), npm 11, `curl`, `git`, `@anthropic-ai/claude-code` globally, plus targeted openssl CVE upgrades. |
| `development` | `base`            | `bun install` (all deps) + `bun run build` → `dist/` (app, daemon, workflow runner, process-boundary probe, MCP stdio servers).                 |
| `deps`        | `base`            | `bun install --production --ignore-scripts` (runtime deps only).                                                                                |

### Orchestrator-only stage

| Stage        | Base   | Purpose                                                                              |
| ------------ | ------ | ------------------------------------------------------------------------------------ |
| `production` | `base` | Copies `dist/`, production `node_modules/`, and `src/db/migrations/`. Runs as `bun`. |

### Daemon-only stages

| Stage          | Base           | Purpose                                                                                                                                                                                                                             |
| -------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `daemon-tools` | `base`         | Installs the full toolchain, kubectl, helm, terraform, kustomize, k9s, stern, argocd, flux, tflint, yq, aws-cli, gcloud, docker CLI, go, rust, poetry, gh, azure-cli, and bakes `daemon-capabilities.static.json` for fast startup. |
| `production`   | `daemon-tools` | Copies `dist/` and production `node_modules/`. Runs as `bun`.                                                                                                                                                                       |

Tool versions are parameterised by `ARG` (`KUBECTL_VERSION`, `HELM_VERSION`, etc.) and bumped together by Renovate/Dependabot. `trivy-scan.yml` re-scans the published images daily for CVE regressions.

## Build

```bash
bun run docker:build:orchestrator   # → chrisleekr/github-app:local-orchestrator
bun run docker:build:daemon         # → chrisleekr/github-app:local-daemon
bun run docker:build                # both
```

There is no default `Dockerfile`, always pass `-f`.

The daemon image compiles a native preload guard that sets `PR_SET_DUMPABLE=0` before Bun starts. After each architecture-specific digest is pushed, `docker-build.yml` runs the bundled startup probe from that exact digest as UID/GID 1000 with no network, no capabilities, a read-only container root, and `no-new-privileges`. A digest is not published into the merged manifest unless the real child-to-parent `/proc/<pid>/environ` read is denied. The GitLab main-branch publisher builds and loads its amd64 image under a commit-local tag, runs the same restricted probe, then tags and pushes `latest-daemon`.

### Build arguments

| Argument          | Default       | Purpose                                                      |
| ----------------- | ------------- | ------------------------------------------------------------ |
| `PACKAGE_VERSION` | `untagged`    | Stored as Docker label `com.chrisleekr.bot.package-version`. |
| `GIT_HASH`        | `unspecified` | Stored as Docker label `com.chrisleekr.bot.git-hash`.        |

Daemon-only:

| Argument         | Default     | Purpose                                               |
| ---------------- | ----------- | ----------------------------------------------------- |
| `TARGETARCH`     | from buildx | Selects amd64 / arm64 asset URLs.                     |
| `INSTALL_GCLOUD` | `true`      | Skip the ~500 MB Google Cloud SDK install if `false`. |
| `INSTALL_LANGS`  | `go rust`   | Space-separated language toolchains.                  |

```bash
docker build -f Dockerfile.orchestrator \
  --build-arg PACKAGE_VERSION=$(bun -e "console.log(require('./package.json').version)") \
  --build-arg GIT_HASH=$(git rev-parse --short HEAD) \
  -t chrisleekr/github-app:$(git rev-parse --short HEAD)-orchestrator \
  .
```

### Verifying image attestations

> **Attestations are currently disabled.** The `provenance: mode=max` / `sbom: true` inputs, the `attestations: write` permission, and the `gh attestation verify` gate in `.github/workflows/docker-build.yml` are all commented out because the SBOM exceeded GitHub's 16MB attestation limit. The GitLab builds pass `--provenance false`. **No published tag carries an attestation today**, so the `gh attestation verify` commands below will fail until the inputs are restored. The section is retained because the workflow code is retained in place for re-enablement.

Once re-enabled, every published tag, both `-orchestrator` and `-daemon` variants and the bare `<version>` / `latest` aliases, ships with two Sigstore-signed attestations bound to the manifest-list digest:

| Predicate type                   | What it proves                                                                                                                                                                                                              | Source                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `https://slsa.dev/provenance/v1` | The image was built by `.github/workflows/docker-build.yml` from a specific commit, with the recorded BuildKit invocation.                                                                                                  | [`actions/attest`](https://github.com/actions/attest) |
| `https://cyclonedx.org/bom`      | A CycloneDX SBOM of the **amd64 packages** layered into the merged image (orchestrator runtime, daemon toolchain, OS libs). Syft scans the runner's native architecture; for arm64 audits use the per-arch BuildKit SBOM ↓. | [`actions/attest`](https://github.com/actions/attest) |

Verify before pulling into production. `gh attestation verify` checks the attestation against GitHub's transparency log and the Sigstore trust root:

```bash
# Provenance: fails if missing or signed by anything other than this repo's workflow
gh attestation verify \
  oci://chrisleekr/github-app:<version>-orchestrator \
  --repo chrisleekr/github-app \
  --predicate-type https://slsa.dev/provenance/v1

# SBOM: same shape, different predicate
gh attestation verify \
  oci://chrisleekr/github-app:<version>-orchestrator \
  --repo chrisleekr/github-app \
  --predicate-type https://cyclonedx.org/bom
```

The same commands apply to the `-daemon` tags. **No workflow runs these calls today**: the `Verify image attestations` step is commented out in the `scan` job of `.github/workflows/trivy-scan.yml`, alongside the disabled attestation publishing in `docker-build.yml`. Once both are restored, that step re-becomes the regression gate that fails the workflow if a future refactor drops an attestation.

You can also pull the BuildKit-emitted SPDX SBOM and SLSA provenance attached to each per-arch leaf manifest directly via the registry, useful for offline supply-chain audits and the only source for arm64 package coverage (the Sigstore CycloneDX flavour above is amd64-only):

```bash
# Provenance JSON (per platform)
docker buildx imagetools inspect chrisleekr/github-app:<version>-orchestrator \
  --format '{{ json .Provenance }}'

# SBOM JSON (per platform: SPDX 2.3, distinct from the CycloneDX one above)
docker buildx imagetools inspect chrisleekr/github-app:<version>-orchestrator \
  --format '{{ json .SBOM }}'
```

`mode=max` provenance + `sbom: true` are set on the build step in `.github/workflows/docker-build.yml`; the merge job's `imagetools create` walks each per-arch index digest so the descriptors survive the manifest-list assembly.

## Run

### Orchestrator

```bash
docker run \
  --env-file .env \
  -p 3000:3000 \
  -p 3002:3002 \
  chrisleekr/github-app:local-orchestrator
```

- `3000`: HTTP: webhook listener, `/healthz`, `/readyz`.
- `3002`: WebSocket: daemon registry (`WS_PORT`). Expose only on networks the daemons connect from.

Shortcut: `bun run docker:run:orchestrator` (mounts `~/.aws` read-only for local Bedrock testing).

### Daemon

```bash
docker run \
  --env-file .env \
  -e ORCHESTRATOR_URL=ws://orchestrator-host:3002 \
  -e DAEMON_AUTH_TOKEN=... \
  -v $HOME/.aws:/home/bun/.aws:ro \
  chrisleekr/github-app:local-daemon
```

The daemon does **not** expose any HTTP port and does **not** need GitHub App credentials: the orchestrator mints installation tokens and hands them off per job.

Shortcut: `bun run docker:run:daemon` (connects back to `ws://host.docker.internal:3002`).

## Health and readiness probes

Endpoints exist on the **orchestrator image only**. Daemon liveness is tracked via the WebSocket heartbeat in the orchestrator's daemon registry.

| Endpoint   | Method | Success     | Failure         | Purpose                                                                                                                                      |
| ---------- | ------ | ----------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `/healthz` | GET    | `200 ok`    | _none_          | Liveness, process is alive (no external deps).                                                                                               |
| `/readyz`  | GET    | `200 ready` | `503 not ready` | Readiness, config validated and data layer reachable. Returns `503 not ready` during startup, when a dependency is down, or after `SIGTERM`. |

`Dockerfile.orchestrator` ships with a Docker `HEALTHCHECK` invoking `curl -f http://localhost:3000/healthz`. Honoured by Docker Compose, ECS, Nomad, Swarm. Kubernetes ignores Docker `HEALTHCHECK` and uses the probe spec below.

```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /readyz
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 5
```

For the daemon, replace HTTP probes with an `exec` probe that checks the WebSocket connection, see [`runbooks/daemon-fleet.md`](runbooks/daemon-fleet.md).

## Graceful shutdown

The orchestrator handles `SIGTERM` and `SIGINT`:

1. Flips `/readyz` to `503` so the load balancer stops routing.
2. Calls `server.close()`, waits for in-flight HTTP requests.
3. MCP stdio child processes exit via their own `finally` blocks.
4. Force-exits after 290 seconds if shutdown hasn't completed (`src/app.ts`).

Set `terminationGracePeriodSeconds: 300` on the Pod so SIGKILL lands 10 seconds after the force-exit.

The daemon has its own drain contract driven by `DAEMON_DRAIN_TIMEOUT_MS`: it finishes the current job, refuses new offers, then disconnects. Match `terminationGracePeriodSeconds` to `DAEMON_DRAIN_TIMEOUT_MS` on the daemon Pod.

## Resource recommendations

### Orchestrator

I/O-bound, never runs the pipeline itself. 1 GB is typically enough.

| `MAX_CONCURRENT_REQUESTS` | Memory | CPU      |
| ------------------------- | ------ | -------- |
| 1                         | 1 GB   | 1 vCPU   |
| 3 (default)               | 2 GB   | 1–2 vCPU |
| 5                         | 3 GB   | 2 vCPU   |

### Daemon

Dominated by what Claude runs inside it (`kubectl`, `terraform plan`, `docker build`).

| Concurrent jobs     | Memory | CPU      |
| ------------------- | ------ | -------- |
| 1                   | 2 GB   | 1–2 vCPU |
| 3 (typical default) | 4 GB   | 2–4 vCPU |

The daemon image is ~2 GB unpacked. The same sizing applies to ephemeral daemon Pods spawned by the orchestrator (same image).

### Isolated workflow runner

Each structured workflow gets one Pod with fixed per-container resources from `src/k8s/workflow-runner-spawner.ts`:

| Resource          | Request | Limit  |
| ----------------- | ------- | ------ |
| CPU               | 500m    | 2      |
| Memory            | 1 GiB   | 4 GiB  |
| Ephemeral storage | 2 GiB   | 10 GiB |

`MAX_CONCURRENT_REQUESTS` is the controller's database admission ceiling for these Pods. The supported deployment has one controller replica; this is not a distributed cluster-wide semaphore.

### Disk

Each job clones the target repo to `CLONE_BASE_DIR` (default `/tmp/bot-workspaces`) with `git clone --depth=${CLONE_DEPTH}` (default `50`). The directory is removed in the pipeline's `finally` block.

Peak disk = `average_repo_size × concurrent_jobs`. For shared daemons and the orchestrator's local development path, mount a dedicated volume:

```yaml
volumes:
  - name: bot-workspaces
    emptyDir:
      sizeLimit: 5Gi
containers:
  - name: github-app
    env:
      - name: CLONE_BASE_DIR
        value: /workspaces
    volumeMounts:
      - name: bot-workspaces
        mountPath: /workspaces
```

Each isolated runner gets one 10 GiB `emptyDir` mounted at `/tmp/bot-workspaces`. The clone and artifacts disappear with the Pod. Keep both the volume limit and the container's 10 GiB ephemeral-storage limit because they cover different accounting surfaces, but do not treat either as a filesystem quota. Kubernetes enforces local-storage excess through eviction, and its default directory scan misses deleted files that a process keeps open. The fixed runner-node placement below contains that failure mode away from control-plane and application nodes. Kubernetes documents the eviction behavior, deleted-open-file gap, and optional quota-based measurement in [Local ephemeral storage](https://kubernetes.io/docs/concepts/storage/ephemeral-storage/).

## Kubernetes worker requirements

Structured workflows require the controller to create workflow-runner Pods and Secrets in the dedicated `WORKFLOW_RUNNER_NAMESPACE`. Ephemeral shared-daemon scaling creates Pods in `EPHEMERAL_DAEMON_NAMESPACE`. Controller startup rejects equal namespace values because the runner admission policy validates every Pod in its namespace.

### Dedicated runner nodes

Provision a worker pool used only for workflow-runner Pods and required node daemons. Do not place control-plane components, the controller, databases, Valkey, or application workloads on it. Label and taint every node in that pool, and put the same label and taint on replacement-node templates:

```bash
kubectl label node <runner-node> github-app.node-restriction.kubernetes.io/workflow-runner=true
kubectl taint node <runner-node> github-app.node-restriction.kubernetes.io/workflow-runner=true:NoSchedule
```

`WORKFLOW_RUNNER_NODE_LABEL` and `WORKFLOW_RUNNER_NODE_VALUE` change that key/value pair, so a cluster can point runners at a node pool it already labels and taints instead of adding a second pair. One setting drives both the `nodeSelector` and the `NoSchedule` toleration. Whatever pair you configure must also be set as `runnerNodeLabel` / `runnerNodeValue` in the runner boundary ConfigMap, or admission denies every runner Pod.

Enable the Node authorizer and `NodeRestriction` admission plugin before using this pool. Kubernetes prevents kubelets from setting labels in the `node-restriction.kubernetes.io` namespace only when both controls are active. Verify those control-plane settings instead of inferring them from a successful label command. See [Node isolation/restriction](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/#node-isolation-restriction). Overriding `WORKFLOW_RUNNER_NODE_LABEL` to a key outside that reserved namespace gives this protection up: a compromised kubelet could then label its own node and attract runner Pods.

Drain pre-existing non-runner workloads before treating a node as dedicated. The spawner always selects the configured label and carries only the matching `NoSchedule` toleration. The admission policy requires that exact selector and toleration, so a runner stays Pending if the dedicated pool is absent and cannot be mutated onto a shared or control-plane node. Taints affect scheduling, not existing Pods, and another workload with the same toleration could still enter the pool; restrict who can set that toleration and audit the actual node workload set after rollout and node replacement.

### Orchestrator RBAC

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: github-app-ephemeral-daemon-spawner
  namespace: ${EPHEMERAL_DAEMON_NAMESPACE}
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: github-app-ephemeral-daemon-spawner
  namespace: ${EPHEMERAL_DAEMON_NAMESPACE}
subjects:
  - kind: ServiceAccount
    name: github-app
    namespace: ${ORCHESTRATOR_NAMESPACE}
roleRef:
  kind: Role
  name: github-app-ephemeral-daemon-spawner
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: github-app-workflow-runner-manager
  namespace: ${WORKFLOW_RUNNER_NAMESPACE}
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["create", "get", "delete"]
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["create", "get", "update", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: github-app-workflow-runner-manager
  namespace: ${WORKFLOW_RUNNER_NAMESPACE}
subjects:
  - kind: ServiceAccount
    name: github-app
    namespace: ${ORCHESTRATOR_NAMESPACE}
roleRef:
  kind: Role
  name: github-app-workflow-runner-manager
  apiGroup: rbac.authorization.k8s.io
```

The controller uses `get` plus UID deletion preconditions to avoid deleting a replacement resource with the deterministic attempt name. It creates the Pod first and makes the per-attempt Secret an owned dependent of that exact Pod UID. It uses `update` only to rotate an existing owned Secret after an ambiguous create or controller-secret rotation. No worker Pod receives this ServiceAccount token.

### `daemon-secrets` Secret

Spawned ephemeral Pods get their config via `envFrom: secretRef: <EPHEMERAL_DAEMON_SECRET_NAME>`, which defaults to `daemon-secrets`. Create this Secret once in `EPHEMERAL_DAEMON_NAMESPACE` with at minimum:

- `DAEMON_AUTH_TOKEN`: daemon ⇄ orchestrator handshake. **Only source.** The spawner does not inline this into the Pod spec, so it cannot leak via `kubectl get pod -o yaml` or the Pod audit log.
- `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (and `ALLOWED_OWNERS`) or Bedrock `AWS_*` vars.

GitHub App private-key material is **not** placed in this Secret. The orchestrator mints installation tokens and hands them per-job, so blast radius does not need to expand to every ephemeral Pod. `ORCHESTRATOR_URL` is provided inline by the spawner from `ORCHESTRATOR_PUBLIC_URL`.

Never place `DATABASE_URL` or `VALKEY_URL` in `daemon-secrets`; shared daemons reach those services through the controller protocol.

`EPHEMERAL_DAEMON_SECRET_NAME` exists so a deployment whose persistent daemon pools already mount a suitable Secret can point ephemeral daemons at the same object instead of maintaining a second copy of the same credentials, which drift apart on rotation. It does not relax the contents rule above. Reusing a broader Secret gives every ephemeral Pod every key in it, so weigh that against the rotation cost. Reusing the controller's own Secret is the worst case: it hands short-lived agent Pods the GitHub App private key, the webhook secret, and the workflow-runner capability root.

### `workflow-runner-secrets` Secret

Create this provider-only Secret once in `WORKFLOW_RUNNER_NAMESPACE`. Put only the selected credential chain in it:

- Anthropic: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, never both. If both are configured on the controller, the runner deliberately receives only `ANTHROPIC_API_KEY`, matching Claude Code's documented precedence.
- Bedrock API key: `AWS_BEARER_TOKEN_BEDROCK` only.
- Bedrock static credentials: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, plus `AWS_SESSION_TOKEN` only when the credentials are temporary.

For production Bedrock runners, use a dedicated IAM principal with only the inference actions and model or inference-profile resources the selected SDK path needs. Do not grant non-Bedrock actions or `sts:AssumeRole`. AWS identifies `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` as the core inference permissions and documents how to narrow actions and resources in [Prerequisites for running model inference](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-prereq.html). Use temporary IAM credentials, or a short-term Bedrock API key with automated Secret rotation. AWS recommends short-term API keys for production and long-term keys only for exploration in [Amazon Bedrock API keys](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html). `AWS_BEARER_TOKEN_BEDROCK` is a Bedrock API key; `aws-actions/configure-aws-credentials` exports a temporary IAM access-key, secret-key, and session-token chain instead.

The spawner reads `CLAUDE_PROVIDER`, `CLAUDE_MODEL`, `AWS_REGION`, optional `ANTHROPIC_BEDROCK_BASE_URL`, and `ALLOWED_OWNERS` from validated controller configuration and places those non-secret settings inline. A Bedrock base-URL override must be an absolute HTTPS URL with no username, password, query, or fragment; the attempt fails before its capability Secret is created otherwise. `AWS_PROFILE` is unsupported for isolated runners because they mount no AWS profile files. A Bedrock controller configured only with a profile fails the attempt before a Pod is created. Every selected credential reference is required, so a missing Secret key prevents the container from starting instead of silently selecting another chain.

Do not place unused provider chains, GitHub App, PAT, database, Valkey, daemon, Kubernetes, or Context7 credentials in this Secret. The Pod references only the selected keys and never uses `envFrom`. Before connecting, the runner rejects dual Anthropic credentials, dual or incomplete Bedrock chains, cross-provider credentials, and controller credentials. `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` are forbidden because [GitHub CLI treats them as authentication for GitHub Enterprise Server hosts](https://cli.github.com/manual/gh_help_environment).

### Workflow-runner admission boundary

Post-create reconciliation is not early enough to stop a mutated image or lifecycle hook: the kubelet can start the admitted Pod before the controller reads the create response. Install [`examples/workflow-runner-admission.yaml`](https://github.com/chrisleekr/github-app/blob/main/examples/workflow-runner-admission.yaml) before enabling structured workflows. It requires Kubernetes 1.30 or later, where `ValidatingAdmissionPolicy` is generally available.

The [`github-app` Helm chart](https://github.com/chrisleekr/helm-charts/tree/main/charts/github-app) packages this file behind `workflowRunner.enabled`, and is the recommended install path. It derives the boundary parameters below from the same values that render the controller's own config, so `runnerImage` cannot drift from `DAEMON_IMAGE`. This example stays the canonical copy of the policy: the chart carries its `spec` verbatim and a chart-side gate fails when the two differ. Apply the steps below by hand only when installing without the chart.

The example creates a Restricted `github-app-runners` namespace and a fail-closed policy and binding. The binding selects the dedicated namespace and the policy validates every Pod create, Pod update, and ephemeral-container update in it. Before applying it:

1. Set `workflow-runner-boundary.data.runnerImage` to the exact `@sha256:<digest>` image configured as `DAEMON_IMAGE`. Tags, including immutable release tags, are rejected by the controller and policy.
2. Set `workflow-runner-boundary.data.orchestratorOrigin` to the WSS origin used by `ORCHESTRATOR_PUBLIC_URL`, without a path or trailing slash.
   Set `runnerNodeLabel` and `runnerNodeValue` to the controller's `WORKFLOW_RUNNER_NODE_LABEL` / `WORKFLOW_RUNNER_NODE_VALUE` values.
   Set `runnerImagePullSecret` to the controller's `WORKFLOW_RUNNER_IMAGE_PULL_SECRET` value: the name of an existing `kubernetes.io/dockerconfigjson` Secret in the runner namespace, or an empty string to forbid pull secrets entirely. The runner has no ServiceAccount token, so the kubelet reads this Secret and the container never can.
3. Copy the controller's exact `provider`, `model`, optional `awsRegion`, `anthropicBedrockBaseUrl`, and `allowedOwners` values into the boundary ConfigMap. Use an empty string for an omitted optional setting.
4. Set `providerCredential1..3` to the exact selected Secret-key names in spawner order: one Anthropic key; one Bedrock bearer key; or access key, secret key, and optional session token. Leave unused slots empty. The ConfigMap contains names and non-secret settings, never credential values.
5. Provision and verify the dedicated labeled-and-tainted runner nodes described above. Label the controller namespace `github-app.chrislee.kr/workflow-controller=true`, retain the controller Pod labels from the example, and adapt the DNS selectors if the cluster does not label its DNS Pods `k8s-app=kube-dns`.
6. Set `WORKFLOW_RUNNER_NAMESPACE=github-app-runners`, or consistently rename the Namespace, ConfigMap namespace, binding selector, and parameter namespace. Keep `EPHEMERAL_DAEMON_NAMESPACE` different.
7. Apply the Namespace and ConfigMap first, then the policy and binding. Keep `parameterNotFoundAction: Deny`, `failurePolicy: Fail`, and `validationActions: [Deny, Audit]`.
8. Before enabling workflows, require a server-side dry-run canary to be denied by `github-app-workflow-runner-boundary`. Policy `status.typeChecking` proves expression type checking completed; it does not test whether the binding is already enforcing requests. The CI harness polls this negative canary for up to 30 seconds before testing the production renderer.

This canary is compatible with Restricted Pod Security, performs no write, and fails if admission returns an unrelated error:

```bash
RUNNER_NAMESPACE="${WORKFLOW_RUNNER_NAMESPACE:-github-app-runners}"
for attempt in $(seq 1 30); do
  if output="$(
    kubectl create --dry-run=server --output=name \
      --namespace="${RUNNER_NAMESPACE}" --filename=- 2>&1 <<'YAML'
apiVersion: v1
kind: Pod
metadata:
  name: workflow-runner-policy-canary
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: canary
      image: registry.invalid/canary@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop: [ALL]
YAML
  )"; then
    if [ "${attempt}" -eq 30 ]; then
      echo "workflow runner admission policy did not enforce within 30 seconds" >&2
      exit 1
    fi
    sleep 1
  elif printf '%s\n' "${output}" | grep -Fq \
    "ValidatingAdmissionPolicy 'github-app-workflow-runner-boundary'"; then
    echo "workflow runner admission policy is enforcing"
    break
  else
    printf '%s\n' "${output}" >&2
    exit 1
  fi
done
```

The policy validates the final Pod after mutation. It binds the digest, controller URL, provider settings, selected credential-key names, and dedicated-node placement. It rejects changed identity labels, extra containers, volumes, annotations, finalizers, lifecycle hooks, security overrides, capability additions, changed environment names, sources, values, or resource budgets, direct node placement, affinity, altered node selectors, priority classes, scheduling/readiness gates, more than one image-pull Secret or one whose name differs from `runnerImagePullSecret`, altered tolerations, and ephemeral-container updates. The controller repeats the boundary check after create and during reconciliation. Kubernetes recommends final-state validation because mutating admission order is not stable: [Admission Webhook Good Practices](https://kubernetes.io/docs/concepts/cluster-administration/admission-webhooks-good-practices/#validate-mutations-before-admission). The [ValidatingAdmissionPolicy reference](https://kubernetes.io/docs/reference/access-authn-authz/validating-admission-policy/) defines the fail policy, match conditions, parameter, binding, and deny behavior used by the example. The [policy status API](https://kubernetes.io/docs/reference/kubernetes-api/policy-resources/validating-admission-policy-v1/#ValidatingAdmissionPolicyStatus) limits `typeChecking` to expression-checking results, which is why rollout also probes a real admission request.

Treat the boundary ConfigMap, policy, binding, and namespace labels as cluster-security configuration. The controller needs no write access to them. Grant changes only to the deployment administrator, verify the policy status has no `expressionWarnings`, and require the negative canary denial before enabling workflows. Under a chart install these are release-managed, so change them through the values file rather than `kubectl`: a manual edit is reverted on the next sync. `bun run test:admission` installs the production manifest and renderer in a disposable pinned Kubernetes 1.30 cluster, waits for real binding enforcement, then verifies the exact Pod plus prohibited mutations.

The GitHub admission job runs on GitHub-hosted pull-request runners. The current self-managed GitLab project has no dedicated ephemeral privileged runner, so its kind/DinD job is restricted to the protected default branch and uses digest-pinned job, service, and nested images. Do not enable this job on feature branches through the shared instance runner. GitLab states that privileged jobs can gain root access to the runner host and recommends isolated, ephemeral runners restricted to protected branches: [runner security](https://docs.gitlab.com/runner/security/#reduce-the-security-risk-of-using-privileged-containers).

The controller separately creates `workflow-runner-<attempt UUID>` with one deadline-bound HMAC capability. The capability is signed by the controller-only `WORKFLOW_RUNNER_CAPABILITY_SECRET`, not the shared-daemon key, and the Secret has one owner reference to the exact runner Pod UID. The target-repository token is delivered at most once and its GitHub-reported expiry must be no later than the immutable attempt deadline. A transport reconnect carries no job payload or repository credential. Payload preparation attempts best-effort revocation when delivery fails. After delivery, the runner attempts best-effort revocation after its final repository operation. The controller independently attempts revocation for reconnect, notification, and result-projection tokens through GitHub's [token self-revocation endpoint](https://docs.github.com/en/rest/apps/installations#revoke-an-installation-access-token), with a ten-second API timeout. Revocation failure does not block terminal handling. The repository token is not stored in PostgreSQL or Kubernetes, so a failed revocation, process crash, or node loss remains bounded by its single-repository scope and authoritative GitHub expiry. A process crash is terminal for that Pod, so `restartPolicy: Never` lets reconciliation fail the attempt promptly instead of looping a replacement process that cannot safely receive the credential again. Projection retries do not retain runner credentials or compute. Pod deletion uses the normal 30-second grace period. The cleanup receipt means Kubernetes accepted UID-preconditioned deletion, or the exact resource was already absent. A Pod may remain `Terminating` while finalizers run; the owned Secret is also eligible for garbage collection. Do not automate `--force --grace-period=0`: [Kubernetes warns that force deletion does not confirm the Pod processes have stopped](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_delete/). If a node is partitioned, verify the node and process state before an operator force-deletes the exact Pod UID. Enable Kubernetes Secret encryption at rest and restrict Secret RBAC to this controller ServiceAccount.

### ResourceQuota

Each active workflow attempt consumes one Pod, one per-attempt Secret, and bounded ephemeral storage. Quota all three so a cleanup or retry defect cannot exhaust API-server or node capacity. This is an example ceiling, not a sizing recommendation:

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: github-app-runner-objects
  namespace: ${WORKFLOW_RUNNER_NAMESPACE}
spec:
  hard:
    count/pods: "10"
    count/secrets: "12"
    requests.ephemeral-storage: 20Gi
    limits.ephemeral-storage: 100Gi
```

### Runner-node PID boundary

CPU, memory, and ephemeral-storage limits do not bound process IDs. Kubernetes does not support a Pod-spec PID limit, so every dedicated runner node must have a finite positive kubelet `podPidsLimit` and nonzero PID reservations for both the operating system and Kubernetes daemons. Audit the effective kubelet configuration on every runner node before rollout and after node-pool replacement. The default `podPidsLimit: -1` is unbounded and fails this prerequisite.

Size the limit and `systemReserved.pid` / `kubeReserved.pid` from the node's `pid_max`, maximum Pod density, and system-daemon demand. Do not copy the test fixture's value into production. Kubernetes documents why fast PID exhaustion can destabilize kubelet and the container runtime, and why eviction alone is not a hard boundary: [Process ID limits and reservations](https://kubernetes.io/docs/concepts/policy/pid-limiting/) and [KubeletConfiguration `podPidsLimit`](https://kubernetes.io/docs/reference/config-api/kubelet-config.v1beta1/).

### Ephemeral Pod security posture

The spawner hardens every ephemeral Pod (see `src/k8s/ephemeral-daemon-spawner.ts`):

- `automountServiceAccountToken: false`: the daemon never calls the K8s API itself.
- Pod `securityContext`: `runAsNonRoot: true`, `runAsUser: 1000`, `runAsGroup: 1000`, `seccompProfile: RuntimeDefault`.
- Container: `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`.
- `restartPolicy: Never` and `activeDeadlineSeconds: 3600` cap the Pod hard.

Workflow-runner Pods add stricter identity reconciliation (see `src/k8s/workflow-runner-spawner.ts`):

- one container, one size-limited workspace `emptyDir`, no other volumes, no init/sidecar/ephemeral containers, no service-account token, service links, or host PID/IPC/network namespaces;
- `runAsNonRoot: true`, UID/GID 1000, `seccompProfile: RuntimeDefault`, no privilege escalation, and all Linux capabilities dropped;
- `restartPolicy: Never`, `activeDeadlineSeconds: 4200`, and a 30-second termination grace period;
- digest-pinned image, default service account without a token, exact default scheduler and priority, fixed dedicated-node selector and toleration, and no caller-controlled placement or image-pull credentials;
- exact command, environment sources, security context, and resources verified after create and on every reconcile.

Admission or service-mesh mutation that changes this boundary is rejected as a permanent runner-start failure. Exclude these Pods and their per-attempt Secrets from mutation, while preserving the labels the controller uses for ownership checks.

### Workflow-runner egress boundary

Install `github-app-workflow-runner-egress-boundary` from [`examples/workflow-runner-admission.yaml`](https://github.com/chrisleekr/github-app/blob/main/examples/workflow-runner-admission.yaml), or set `workflowRunner.enabled` in the Helm chart, before enabling workflow dispatch. Once it selects a runner Pod for `Egress`, traffic is denied unless one of its three rules allows it:

1. UDP/TCP DNS to the selected cluster DNS Pods on port 53.
2. WSS to the selected controller Pods on port 3002.
3. TCP 443 to public IPv4 and IPv6 addresses, excluding private, loopback, link-local, documentation, benchmark, multicast, and reserved ranges.

Label the controller namespace `github-app.chrislee.kr/workflow-controller=true` and keep the controller Pod labels aligned with the policy. Adapt the DNS selector to the cluster's actual DNS labels. If `ORCHESTRATOR_PUBLIC_URL` uses a public ingress instead of the selected controller Pods, expose it on TCP 443. Verify these paths from the runner namespace before rollout.

Kubernetes NetworkPolicies are additive. Audit every policy selecting runner Pods because another egress rule can widen this boundary. The portable API identifies destinations by Pod, namespace, or CIDR, not DNS name. The example therefore blocks cluster/private-network reachability and non-HTTPS public traffic, but it cannot distinguish GitHub and the selected AI provider from an attacker-controlled public HTTPS host. Deployments requiring exact public-host allowlisting must add a CNI-specific DNS policy or force runner egress through an allowlisted proxy, limited to the GitHub and provider endpoints the selected configuration needs.

Private provider endpoints are denied by the example. If the selected provider uses a private endpoint, add only that endpoint's exact Pod, namespace, or CIDR destination and required port. Do not allow an entire private address range.

The network policy is the primary metadata control. The runner also probes the AWS/Azure IPv4 endpoint and AWS/Google IPv6 endpoints before registration. Any HTTP response, including `401` or `403`, fails startup. A policy drop normally appears as a timeout, so timeouts and connection refusals are accepted as corroborating evidence, not treated as proof by themselves.

For EKS worker nodes, also require IMDSv2 and set the response hop limit to `1`. AWS documents that setting as the Pod-blocking configuration. For AKS, prefer the platform IMDS restriction where its preview limitations are acceptable; existing clusters also require a node reimage after enabling it. These controls are independent of the policy and startup probe.

Primary references: [Kubernetes NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/), [AWS EKS identity guidance](https://docs.aws.amazon.com/eks/latest/best-practices/identity-and-access-management.html), [AWS IRSA credential isolation](https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html), [AWS IMDS endpoints](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instancedata-data-retrieval.html), [Google Cloud metadata endpoints](https://docs.cloud.google.com/compute/docs/metadata/querying-metadata), [Azure AKS cluster security](https://learn.microsoft.com/en-us/azure/aks/operator-best-practices-cluster-security), and [AKS IMDS restriction](https://learn.microsoft.com/en-us/azure/aks/imds-restriction).

## Production tunables worth double-checking

The full schema lives at [`configuration.md`](configuration.md). At minimum:

| Variable                  | Production recommendation                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                | `production`                                                                                                 |
| `LOG_LEVEL`               | `info` (`debug` exposes webhook payloads)                                                                    |
| `MAX_CONCURRENT_REQUESTS` | Start at `3`, tune against memory and LLM budget                                                             |
| `AGENT_TIMEOUT_MS`        | Keep within the runner's effective token window; it aborts five minutes before the one-hour App token expiry |
| `CLONE_BASE_DIR`          | Override if `/tmp` is small or shared                                                                        |
| `PORT`, `WS_PORT`         | `3000`, `3002` (must match probes and the `WS_PORT` env var)                                                 |
