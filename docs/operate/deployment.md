# Deployment

The repository ships **two container images**, an orchestrator and a daemon, built from separate Dockerfiles that share a byte-identical base.

## Image topology

| Image          | Dockerfile                | Role                                                                                                                               | Outbound network                                            |
| -------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `orchestrator` | `Dockerfile.orchestrator` | Webhook server, WebSocket daemon registry, triage classifier, ephemeral-daemon spawner.                                            | GitHub API, Anthropic / Bedrock, Postgres, Valkey, K8s API. |
| `daemon`       | `Dockerfile.daemon`       | Worker image with the toolchain Claude shells out to (`kubectl`, `helm`, `terraform`, `aws`, `gcloud`, `docker`, `go`, `rust`, …). | Orchestrator WebSocket (outbound), GitHub API, Anthropic.   |

The `daemon` image additionally bundles `@mermaid-js/mermaid-cli` (`mmdc`) plus a headless Chromium, used by the scheduled `research` action's diagram-validation gate. It is daemon-only because the agent runs on the daemon, not the orchestrator.

The two images intentionally diverge after the shared base because their cost and attack surface differ. The shared prefix is enforced byte-identical by `scripts/check-dockerfile-base-sync.ts` (in CI) between the `# --- SHARED-BASE-BEGIN ---` and `# --- SHARED-BASE-END ---` markers.

### Shared base stages

| Stage         | Base              | Purpose                                                                                                                                         |
| ------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `base`        | `oven/bun:1.3.14` | Installs Node.js 20 (for the Claude Code CLI), npm 11, `curl`, `git`, `@anthropic-ai/claude-code` globally, plus targeted openssl CVE upgrades. |
| `development` | `base`            | `bun install` (all deps) + `bun run build` → `dist/` (app, daemon main, MCP stdio servers).                                                     |
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

Tool versions are parameterised by `ARG` (`KUBECTL_VERSION`, `HELM_VERSION`, etc.) and bumped together by Renovate/Dependabot. The Trivy scan in CI gates CVE regressions.

## Build

```bash
bun run docker:build:orchestrator   # → chrisleekr/github-app-playground:local-orchestrator
bun run docker:build:daemon         # → chrisleekr/github-app-playground:local-daemon
bun run docker:build                # both
```

There is no default `Dockerfile`, always pass `-f`.

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
  -t chrisleekr/github-app-playground:$(git rev-parse --short HEAD)-orchestrator \
  .
```

### Verifying image attestations

> Note: As SBOM file size is over 16MB, temporary disable SBOM attestations.

Every published tag, both `-orchestrator` and `-daemon` variants and the bare `<version>` / `latest` aliases, ships with two Sigstore-signed attestations bound to the manifest-list digest:

| Predicate type                   | What it proves                                                                                                                                                                                                              | Source                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `https://slsa.dev/provenance/v1` | The image was built by `.github/workflows/docker-build.yml` from a specific commit, with the recorded BuildKit invocation.                                                                                                  | [`actions/attest`](https://github.com/actions/attest) |
| `https://cyclonedx.org/bom`      | A CycloneDX SBOM of the **amd64 packages** layered into the merged image (orchestrator runtime, daemon toolchain, OS libs). Syft scans the runner's native architecture; for arm64 audits use the per-arch BuildKit SBOM ↓. | [`actions/attest`](https://github.com/actions/attest) |

Verify before pulling into production. `gh attestation verify` checks the attestation against GitHub's transparency log and the Sigstore trust root:

```bash
# Provenance: fails if missing or signed by anything other than this repo's workflow
gh attestation verify \
  oci://chrisleekr/github-app-playground:1.3.0-orchestrator \
  --repo chrisleekr/github-app-playground \
  --predicate-type https://slsa.dev/provenance/v1

# SBOM: same shape, different predicate
gh attestation verify \
  oci://chrisleekr/github-app-playground:1.3.0-orchestrator \
  --repo chrisleekr/github-app-playground \
  --predicate-type https://cyclonedx.org/bom
```

The same commands apply to the `-daemon` tags. The `scan` job in `docker-build.yml` runs both calls before Trivy on every release, so any future regression that drops an attestation fails the workflow at the verify step.

You can also pull the BuildKit-emitted SPDX SBOM and SLSA provenance attached to each per-arch leaf manifest directly via the registry, useful for offline supply-chain audits and the only source for arm64 package coverage (the Sigstore CycloneDX flavour above is amd64-only):

```bash
# Provenance JSON (per platform)
docker buildx imagetools inspect chrisleekr/github-app-playground:1.3.0-orchestrator \
  --format '{{ json .Provenance }}'

# SBOM JSON (per platform: SPDX 2.3, distinct from the CycloneDX one above)
docker buildx imagetools inspect chrisleekr/github-app-playground:1.3.0-orchestrator \
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
  chrisleekr/github-app-playground:local-orchestrator
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
  chrisleekr/github-app-playground:local-daemon
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

### Disk

Each job clones the target repo to `CLONE_BASE_DIR` (default `/tmp/bot-workspaces`) with `git clone --depth=${CLONE_DEPTH}` (default `50`). The directory is removed in the pipeline's `finally` block.

Peak disk = `average_repo_size × concurrent_jobs`. For monorepos, mount a dedicated volume:

```yaml
volumes:
  - name: bot-workspaces
    emptyDir:
      sizeLimit: 5Gi
containers:
  - name: github-app-playground
    env:
      - name: CLONE_BASE_DIR
        value: /workspaces
    volumeMounts:
      - name: bot-workspaces
        mountPath: /workspaces
```

## Ephemeral-daemon Kubernetes requirements

If you want the orchestrator to spawn ephemeral daemon Pods on demand, two things must exist in `EPHEMERAL_DAEMON_NAMESPACE`.

### Orchestrator RBAC

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: github-app-playground-ephemeral-spawner
  namespace: ${EPHEMERAL_DAEMON_NAMESPACE}
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["create", "get", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: github-app-playground-ephemeral-spawner
  namespace: ${EPHEMERAL_DAEMON_NAMESPACE}
subjects:
  - kind: ServiceAccount
    name: github-app-playground
    namespace: ${ORCHESTRATOR_NAMESPACE}
roleRef:
  kind: Role
  name: github-app-playground-ephemeral-spawner
  apiGroup: rbac.authorization.k8s.io
```

Without these verbs every spawn yields `dispatch_reason=ephemeral-spawn-failed` and the job is rejected with a tracking-comment infra error.

### `daemon-secrets` Secret

Spawned ephemeral Pods get their config via `envFrom: secretRef: daemon-secrets`. Create this Secret once in `EPHEMERAL_DAEMON_NAMESPACE` with at minimum:

- `DAEMON_AUTH_TOKEN`: daemon ⇄ orchestrator handshake. **Only source.** The spawner does not inline this into the Pod spec, so it cannot leak via `kubectl get pod -o yaml` or the Pod audit log.
- `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (and `ALLOWED_OWNERS`) or Bedrock `AWS_*` vars.
- `VALKEY_URL`, `DATABASE_URL`.

GitHub App private-key material is **not** placed in this Secret. The orchestrator mints installation tokens and hands them per-job, so blast radius does not need to expand to every ephemeral Pod. `ORCHESTRATOR_URL` is provided inline by the spawner from `ORCHESTRATOR_PUBLIC_URL`.

### Ephemeral Pod security posture

The spawner hardens every ephemeral Pod (see `src/k8s/ephemeral-daemon-spawner.ts`):

- `automountServiceAccountToken: false`: the daemon never calls the K8s API itself.
- Pod `securityContext`: `runAsNonRoot: true`, `runAsUser: 1000`, `runAsGroup: 1000`, `seccompProfile: RuntimeDefault`.
- Container: `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`.
- `restartPolicy: Never` and `activeDeadlineSeconds: 3600` cap the Pod hard.

## Production tunables worth double-checking

The full schema lives at [`configuration.md`](configuration.md). At minimum:

| Variable                  | Production recommendation                                    |
| ------------------------- | ------------------------------------------------------------ |
| `NODE_ENV`                | `production`                                                 |
| `LOG_LEVEL`               | `info` (`debug` exposes webhook payloads)                    |
| `MAX_CONCURRENT_REQUESTS` | Start at `3`, tune against memory and LLM budget             |
| `AGENT_TIMEOUT_MS`        | Stay below 3600 s, the GitHub installation-token TTL         |
| `CLONE_BASE_DIR`          | Override if `/tmp` is small or shared                        |
| `PORT`, `WS_PORT`         | `3000`, `3002` (must match probes and the `WS_PORT` env var) |
