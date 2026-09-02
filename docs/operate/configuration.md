# Configuration reference

Every environment variable the app reads at startup, grouped by concern. The authoritative source is `src/config.ts`, values are validated via Zod at boot and the process exits if a required variable is missing or malformed.

**Default** is the fallback when the variable is unset (blank means "no default, must be set when required"). **Required when** is the runtime condition under which the variable is mandatory.

## GitHub App credentials

Server mode only. If `ORCHESTRATOR_URL` is set, the process runs in daemon mode and these are not required.

| Variable                       | Default | Required when | Notes                                                                                                              |
| ------------------------------ | ------- | ------------- | ------------------------------------------------------------------------------------------------------------------ |
| `GITHUB_APP_ID`                | _none_  | Server mode   | Numeric App ID from the App settings page.                                                                         |
| `GITHUB_APP_PRIVATE_KEY`       | _none_  | Server mode   | Full PEM. Literal `\n` sequences are normalised to real newlines.                                                  |
| `GITHUB_WEBHOOK_SECRET`        | _none_  | Server mode   | HMAC-SHA256 secret configured in the App settings.                                                                 |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | _none_  | Optional      | Override App installation token with a PAT, bot acts as the PAT owner. **Requires single-owner `ALLOWED_OWNERS`.** |

## AI provider

| Variable                     | Default                                       | Required when                                      | Notes                                                                                                                      |
| ---------------------------- | --------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE_PROVIDER`            | `anthropic`                                   | _none_                                             | `anthropic` or `bedrock`.                                                                                                  |
| `CLAUDE_MODEL`               | `claude-opus-5` (anthropic); _none_ (bedrock) | Bedrock                                            | Bedrock requires an explicit Bedrock model ID.                                                                             |
| `ANTHROPIC_API_KEY`          | _none_                                        | Anthropic, unless `CLAUDE_CODE_OAUTH_TOKEN` is set | Console pay-as-you-go. Safe for multi-tenant deploys.                                                                      |
| `CLAUDE_CODE_OAUTH_TOKEN`    | _none_                                        | Anthropic, unless `ANTHROPIC_API_KEY` is set       | Max/Pro subscription token (`sk-ant-oat…`). Requires `ALLOWED_OWNERS`.                                                     |
| `AWS_REGION`                 | _none_                                        | Bedrock                                            | Resolved by the AWS SDK credential chain.                                                                                  |
| `AWS_PROFILE`                | _none_                                        | Optional (bedrock)                                 | Local SSO profile for dev.                                                                                                 |
| `AWS_ACCESS_KEY_ID`          | _none_                                        | Optional (bedrock)                                 | IAM access key. Isolated runners require temporary credentials for a dedicated Bedrock-only principal.                     |
| `AWS_SECRET_ACCESS_KEY`      | _none_                                        | Optional (bedrock)                                 | Paired with `AWS_ACCESS_KEY_ID`.                                                                                           |
| `AWS_SESSION_TOKEN`          | _none_                                        | Optional (bedrock)                                 | Required when the access-key pair is temporary session authority.                                                          |
| `AWS_BEARER_TOKEN_BEDROCK`   | _none_                                        | Optional (bedrock)                                 | Amazon Bedrock API key, distinct from IAM credentials exported by `aws-actions/configure-aws-credentials`.                 |
| `ANTHROPIC_BEDROCK_BASE_URL` | _none_                                        | Optional (bedrock)                                 | HTTPS Bedrock runtime endpoint or proxy, without URL credentials, query, or fragment.                                      |
| `ALLOWED_OWNERS`             | _none_                                        | OAuth or PAT path                                  | Comma-separated allowlist. Required (single owner) when using `CLAUDE_CODE_OAUTH_TOKEN` or `GITHUB_PERSONAL_ACCESS_TOKEN`. |

## HTTP server

| Variable                      | Default                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                        | `3000`                       | HTTP webhook listener.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `LOG_LEVEL`                   | `info`                       | Pino level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`. `debug` surfaces full webhook payloads.                                                                                                                                                                                                                                                                                                                                                                            |
| `NODE_ENV`                    | `production`                 | `production`, `development`, `test`.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `TRIGGER_PHRASE`              | `@chrisleekr-bot`            | Mention text that triggers the bot. Local dev typically sets `@chrisleekr-bot-dev`.                                                                                                                                                                                                                                                                                                                                                                                                |
| `BOT_APP_LOGIN`               | `chrisleekr-bot[bot]`        | Bot's GitHub login. Used by the loop-prevention check.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `MAX_CONCURRENT_REQUESTS`     | `3`                          | Ceiling on simultaneous Claude executions across the fleet.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `MAX_FETCHED_COMMENTS`        | `500`                        | Per-PR/issue cap on comments merged from the GraphQL fetcher (`src/core/fetcher.ts`). When the cap fires the fetcher emits `log.warn({ connection: "comments", … })` and sets `FetchedData.truncated.comments=true`.                                                                                                                                                                                                                                                               |
| `MAX_FETCHED_REVIEWS`         | `500`                        | Per-PR cap on reviews merged from the fetcher. Sets `FetchedData.truncated.reviews=true` on cap fire.                                                                                                                                                                                                                                                                                                                                                                              |
| `MAX_FETCHED_REVIEW_COMMENTS` | `500`                        | Per-PR cap on inline review comments merged across all reviews (top-level + nested follow-up paginate). Sets `truncated.reviewComments=true`.                                                                                                                                                                                                                                                                                                                                      |
| `MAX_FETCHED_FILES`           | `500`                        | Per-PR cap on changed files merged from the fetcher. Sets `truncated.changedFiles=true` on cap fire.                                                                                                                                                                                                                                                                                                                                                                               |
| `AGENT_TIMEOUT_MS`            | `3600000`                    | Wall-clock budget for one agent execution (60 min). Lower only when the job is bounded.                                                                                                                                                                                                                                                                                                                                                                                            |
| `AGENT_MAX_TURNS`             | unset                        | Optional Claude SDK turn cap. Unset = no cap. Overrides `DEFAULT_MAXTURNS`.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `DEFAULT_MAXTURNS`            | unset                        | Process-wide turn cap. Set only if ops needs a hard ceiling. It reaches the agent as the job payload's `maxTurns`, which the workflow rail previously ignored, so before the Gate-2 wiring this value only took effect on the direct-pipeline rail. It now reaches the `review`, `resolve`, `implement`, and `remember` handlers too. `AGENT_MAX_TURNS` is unchanged: the executor still falls back to it when a job carries no cap (`src/core/executor.ts:366#resolvedMaxTurns`). |
| `CLAUDE_CODE_PATH`            | resolved from `node_modules` | Absolute path to the Claude Code CLI `cli.js`.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `CLONE_BASE_DIR`              | `/tmp/bot-workspaces`        | Parent directory for per-delivery clones.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `CLONE_DEPTH`                 | `50`                         | Shallow-clone depth. Increase for deeply-diverged PRs.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `WORKSPACE_STALE_TTL_MS`      | `3600000`                    | TTL before an orphaned per-job workspace triple (clone dir + `.cred.sh` + `-artifacts`) under `CLONE_BASE_DIR` is swept at startup. Reclaims SIGKILL/OOM/eviction orphans. Lower only if you understand the risk.                                                                                                                                                                                                                                                                  |
| `CONTEXT7_API_KEY`            | unset                        | Lifts Context7 MCP rate limiting. No other effect.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `GITHUB_API_SLOW_REQUEST_MS`  | `3000`                       | Latency floor (ms) above which an octokit request emits a `github.api.slow` warn line (`src/utils/octokit-observability.ts`). `duration_ms` is threaded onto every `github.api.*` line regardless. See [`observability.md`](observability.md).                                                                                                                                                                                                                                     |

## Postgres

Required whenever the orchestrator role is active.

| Variable       | Default | Notes                                                                                                                                                                               |
| -------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` | _none_  | Postgres connection. Backs `executions`, `triage_results`, `workflow_runs`, `ship_intents`, `ship_iterations`, `ship_continuations`, `ship_fix_attempts`, `repo_memory`, `daemons`. |

## Valkey

Required whenever the orchestrator role is active.

| Variable     | Default | Notes                                                                                                                         |
| ------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `VALKEY_URL` | _none_  | Backs the daemon job queue, in-flight set, the ephemeral-spawn cooldown, the `ship:tickle` sorted set, and ship cancel flags. |

## Orchestrator and daemon

| Variable                                     | Default                                    | Notes                                                                                                                                                                                                                                                                          |
| -------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WS_PORT`                                    | `3002`                                     | Orchestrator WebSocket listener. Must differ from `PORT`.                                                                                                                                                                                                                      |
| `ORCHESTRATOR_URL`                           | _none_                                     | Presence flips the process to daemon mode. Use `wss://` in production; `ws://` emits a warning.                                                                                                                                                                                |
| `ORCHESTRATOR_PUBLIC_URL`                    | _none_                                     | WebSocket URL injected into Kubernetes-spawned workers. Must be credential-free. Isolated workflow runners require `wss://`, or `ws://` to a cluster-local `<service>.<namespace>.svc[.cluster.local]:<port>` name so an in-cluster runner can dial the orchestrator directly. |
| `DAEMON_AUTH_TOKEN`                          | _none_                                     | Shared-daemon handshake secret. Required on the controller and shared daemons. It is not used for isolated-runner capabilities.                                                                                                                                                |
| `DAEMON_AUTH_TOKEN_PREVIOUS`                 | _none_                                     | Optional shared-daemon rotation overlap. The controller accepts daemon handshakes from either slot; daemons send only the primary. See [`runbooks/daemon-fleet.md`](runbooks/daemon-fleet.md#rotating-daemon_auth_token).                                                      |
| `WORKFLOW_RUNNER_CAPABILITY_SECRET`          | _none_                                     | Controller-only HMAC root for deadline-bound, per-attempt runner capabilities. Minimum 32 characters. Optional until the capability signer ships, then required on the controller. It must differ from both daemon-auth slots, and setting it on a worker is rejected at boot. |
| `WORKFLOW_RUNNER_CAPABILITY_SECRET_PREVIOUS` | _none_                                     | Optional controller-only rotation predecessor. Accepted only for capabilities whose signed expiry has not elapsed; it must also differ from both daemon-auth slots.                                                                                                            |
| `HEARTBEAT_INTERVAL_MS`                      | `30000`                                    | Daemon → orchestrator ping cadence.                                                                                                                                                                                                                                            |
| `HEARTBEAT_TIMEOUT_MS`                       | `90000`                                    | Eviction threshold. Keep `≥ 2 × HEARTBEAT_INTERVAL_MS`.                                                                                                                                                                                                                        |
| `FLEET_SNAPSHOT_INTERVAL_MS`                 | `30000` (clamp 10000-300000; `0` disables) | Cadence of the periodic `fleet.snapshot` gauge log (queue depth / daemon counts / free + busy slots). `0` disables it (inline-mode local dev). See [Fleet snapshot fields](observability.md#fleet-snapshot-fields).                                                            |
| `SOCKET_HEALTH_INTERVAL_MS`                  | `30000` (clamp 5000-300000; `0` disables)  | Cadence of the CLOSE_WAIT socket-spin watchdog (issue #265). `0` disables it (e.g. no procfs in local dev). Does not fix #264, it detects and structurally logs the signature. See [Socket health watchdog events](observability.md#socket-health-watchdog-events).            |
| `SOCKET_HEALTH_LEAK_SAMPLES`                 | `3` (clamp 2-100)                          | Consecutive samples a CLOSE_WAIT socket must survive before it is logged as a leak. Lower is noisier; the floor of 2 stops a transient socket from being flagged.                                                                                                              |
| `SOCKET_HEALTH_SELF_HEAL_SAMPLES`            | `10` (clamp 2-1000)                        | Consecutive samples a leak must persist, alongside a pinned core, before it is treated as a spin.                                                                                                                                                                              |
| `SOCKET_HEALTH_CPU_PERCENT`                  | `90` (clamp 50-100)                        | CPU floor for a spin, as a percentage of one core. CPU alone is never sufficient: a 13.5s `scheduler.scan` legitimately burns a core. Only persistent CLOSE_WAIT plus this floor escalates to a spin.                                                                          |
| `SOCKET_HEALTH_SELF_HEAL_ENABLED`            | `false`                                    | When `true`, a suspected spin exits the process with code `75` (EX_TEMPFAIL) so k8s restarts the pod and bounds the burn. The distinct code lets `lastState.terminated.exitCode` tell a self-heal from a real crash.                                                           |
| `STALE_EXECUTION_THRESHOLD_MS`               | `3600000`                                  | Startup-recovery age threshold for unfenced legacy `offered` or `running` execution receipts whose `offer_id` is null.                                                                                                                                                         |
| `DAEMON_DRAIN_TIMEOUT_MS`                    | `300000`                                   | Post-`SIGTERM` window to finish in-flight work. Raise to `≥ AGENT_TIMEOUT_MS` for zero mid-run kills.                                                                                                                                                                          |
| `JOB_MAX_RETRIES`                            | `3`                                        | Retries for transient shared-daemon dispatch and structured-workflow publication failures.                                                                                                                                                                                     |
| `WORKFLOW_DISPATCH_TIMEOUT_MS`               | `4200000`                                  | Maximum age of an unclaimed structured-workflow dispatch. Retry-budget or age expiry fails the workflow, releases its in-flight lock, fails its execution receipt, and queues a public failure projection.                                                                     |
| `OFFER_TIMEOUT_MS`                           | `5000`                                     | How long the orchestrator waits for a daemon to claim an offer.                                                                                                                                                                                                                |
| `QUEUE_WORKER_BACKOFF_MAX_MS`                | `5000`                                     | Upper bound on the queue-worker's sleep when no local daemon can take a job.                                                                                                                                                                                                   |
| `LIVENESS_REAPER_INTERVAL_MS`                | `30000` (min `20000`)                      | Cadence of lease/deadline expiry, workflow-runner result/resource reconciliation, outbox publication, orphan processing-list recovery, and shared-daemon receipt/heartbeat reaping.                                                                                            |
| `DAEMON_UPDATE_STRATEGY`                     | `exit`                                     | `exit`, `pull`, or `notify`. Advisory hint reported in the update response.                                                                                                                                                                                                    |
| `DAEMON_UPDATE_DELAY_MS`                     | `0`                                        | Delay before graceful shutdown after an update signal.                                                                                                                                                                                                                         |
| `DAEMON_MEMORY_FLOOR_MB`                     | `512`                                      | Minimum free memory the orchestrator requires before dispatching.                                                                                                                                                                                                              |
| `DAEMON_DISK_FLOOR_MB`                       | `1024`                                     | Minimum free disk the orchestrator requires before dispatching.                                                                                                                                                                                                                |

## Ephemeral daemons

Used when the orchestrator scales daemon capacity on demand.

| Variable                                 | Default           | Notes                                                                                                                                                                        |
| ---------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DAEMON_EPHEMERAL`                       | `false`           | Set to `true` on ephemeral daemon Pods (injected by the spawner). Controls idle-exit.                                                                                        |
| `EPHEMERAL_DAEMON_IDLE_TIMEOUT_MS`       | `120000`          | Ephemeral daemon exits after this idle window.                                                                                                                               |
| `EPHEMERAL_DAEMON_SPAWN_COOLDOWN_MS`     | `30000`           | Minimum time between ephemeral spawns (orchestrator side).                                                                                                                   |
| `EPHEMERAL_DAEMON_SPAWN_QUEUE_THRESHOLD` | `3`               | Queue length that triggers an `ephemeral-daemon-overflow` spawn.                                                                                                             |
| `EPHEMERAL_DAEMON_NAMESPACE`             | `default`         | Kubernetes namespace for spawned ephemeral Pods.                                                                                                                             |
| `EPHEMERAL_DAEMON_SECRET_NAME`           | `daemon-secrets`  | Existing Secret in `EPHEMERAL_DAEMON_NAMESPACE` that spawned Pods mount via `envFrom`. Point it at an existing daemon Secret to avoid a second copy of the same credentials. |
| `DAEMON_IMAGE`                           | auto-detected     | K8s image URI. Isolated workflow runners reject values that do not end in `@sha256:<64 lowercase hex>`. Shared ephemeral daemons retain their existing image handling.       |
| `KUBECONFIG`                             | auto (in-cluster) | Kubernetes client config path. The client auto-detects in-cluster via `KUBERNETES_SERVICE_HOST`.                                                                             |

The orchestrator also expects a pre-existing Kubernetes Secret in `EPHEMERAL_DAEMON_NAMESPACE`, named by `EPHEMERAL_DAEMON_SECRET_NAME` and mounted into the spawned Pod via `envFrom`. Every key in it becomes an env var on a Pod that runs agent-authored code, so its scope is the deployment's blast-radius decision. See [`deployment.md`](deployment.md#kubernetes-worker-requirements).

## Isolated workflow runners

Structured `workflow-run` jobs use one bare Kubernetes Pod per exact attempt.

| Variable                            | Default                                                     | Notes                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WORKFLOW_RUNNER_NAMESPACE`         | `github-app-runners`                                        | Dedicated namespace for runner Pods, per-attempt Secrets, Pod Security Admission, and the runner ValidatingAdmissionPolicy. It must differ from `EPHEMERAL_DAEMON_NAMESPACE`.                                                                                                                                                                                                                                  |
| `WORKFLOW_RUNNER_NODE_LABEL`        | `github-app.node-restriction.kubernetes.io/workflow-runner` | Node label key the runner Pod's `nodeSelector` and its `NoSchedule` toleration are both built from, so one setting targets a node pool the cluster already labels and taints. The default prefix is reserved by the NodeRestriction admission plugin, which stops a kubelet assigning it to itself; an unprefixed key gives that protection up. Must match `runnerNodeLabel` in the runner boundary ConfigMap. |
| `WORKFLOW_RUNNER_NODE_VALUE`        | `true`                                                      | Value paired with `WORKFLOW_RUNNER_NODE_LABEL`. Must match `runnerNodeValue` in the runner boundary ConfigMap.                                                                                                                                                                                                                                                                                                 |
| `WORKFLOW_RUNNER_IMAGE_PULL_SECRET` | _(empty)_                                                   | Name of an existing `kubernetes.io/dockerconfigjson` Secret in `WORKFLOW_RUNNER_NAMESPACE` that runner Pods may reference. Must match `runnerImagePullSecret` in the runner boundary ConfigMap. Empty emits no `imagePullSecrets`, which only works against a registry allowing anonymous pull.                                                                                                                |

The following variables are internal to the Pod and are injected by `src/k8s/workflow-runner-spawner.ts`; operators must not set them on the controller or shared daemon Deployment.

| Variable                     | Default | Notes                                                                                                          |
| ---------------------------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `WORKFLOW_RUNNER`            | `false` | Spawner sets `true`; selects runner startup validation and removes controller/data-layer requirements.         |
| `WORKFLOW_RUNNER_RUN_ID`     | _none_  | Spawner-injected UUID for the workflow row.                                                                    |
| `WORKFLOW_RUNNER_ATTEMPT_ID` | _none_  | Spawner-injected UUID for the exact dispatch generation and Pod/Secret identity.                               |
| `WORKFLOW_RUNNER_TOKEN`      | _none_  | Attempt-bound HMAC capability, read from the per-attempt Secret. It is not the fleet-wide `DAEMON_AUTH_TOKEN`. |

The Pod also receives `ORCHESTRATOR_URL`, derived from `ORCHESTRATOR_PUBLIC_URL`, and `LD_PRELOAD` for the native process-boundary guard. It obtains the target-repository GitHub installation token and its expiry only after its first registration over WSS. That credential payload is recorded and sent at most once; reconnects restore controller access without resending it. The database claim fixes an immutable deadline 4,200 seconds after admission. Heartbeats cannot extend the lease past it, and execution stops at the earlier of that deadline or five minutes before the token expires. The Pod uses `restartPolicy: Never`, so a process failure becomes terminal rather than restarting after the one-time credential delivery. Each Pod has a 10 GiB `emptyDir` workspace and exact ephemeral-storage request/limit values of 2 GiB/10 GiB.

## Triage

| Variable                      | Default      | Notes                                                                                                                 |
| ----------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------- |
| `TRIAGE_ENABLED`              | `true`       | Kill-switch. When `false`, triage returns `heavy=false` and the job routes to `persistent-daemon`.                    |
| `TRIAGE_TOOLS_ENABLED`        | `true`       | Kill-switch for the tool-driven triage classifier. When `false`, triage runs without the on-demand state-fetch tools. |
| `TRIAGE_MODEL`                | `sonnet-4-6` | Alias resolved at runtime.                                                                                            |
| `TRIAGE_CONFIDENCE_THRESHOLD` | `1.0`        | Below this, triage is treated as sub-threshold and the job routes to `persistent-daemon`.                             |
| `TRIAGE_MAX_TOKENS`           | `256`        | Cap on the JSON response. Above ~100 is wasted budget.                                                                |
| `TRIAGE_TIMEOUT_MS`           | `5000`       | Per-call wall clock. Beyond this, the circuit-breaker counter increments.                                             |
| `INTENT_CONFIDENCE_THRESHOLD` | `0.75`       | Range `[0, 1]`. Below this, a mention-driven comment gets a clarification reply instead of a dispatch.                |

## Discussion digest

| Variable                  | Default      | Notes                                                                                                                       |
| ------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `DISCUSSION_DIGEST_MODEL` | `sonnet-4-6` | Alias resolved at runtime. Model for the LLM that distills an issue/PR comment thread into maintainer guidance (see below). |

The discussion-digest step (`src/workflows/discussion-digest.ts`) runs before each
structured workflow: it summarises the comment thread into a guidance digest the
workflow prompt consumes in place of the raw thread. It is fail-open (any LLM or
parse error falls back to body-only / raw-comment context) and has no comment-count
cap, so there is nothing else to tune.

## Chat-thread executor

Tunables for the conversational scoped-intent path (`src/workflows/ship/scoped/chat-thread.ts`).

| Variable                         | Default | Notes                                                                                                                  |
| -------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `CHAT_THREAD_EXECUTE_THRESHOLD`  | `0.8`   | Range `[0, 1]`. Minimum classifier confidence before a chat-thread proposal is auto-executed rather than left pending. |
| `CHAT_THREAD_PROPOSAL_TTL_HOURS` | `24`    | Hours a pending chat-thread proposal stays valid before it expires.                                                    |
| `CHAT_THREAD_MAX_TURNS`          | `8`     | Cap on conversational turns within a single chat-thread session.                                                       |
| `CHAT_THREAD_TOOLS_ENABLED`      | `true`  | Kill-switch for the chat-thread agent's on-demand state-fetch tools.                                                   |

## Ship

| Variable                          | Default            | Notes                                                                                                                                           |
| --------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_WALL_CLOCK_PER_SHIP_RUN`     | `4h`               | Hard ceiling on a single intent's wall-clock budget. Accepts ms or `Nh` / `Nm` / `Ns`. Per-invocation `--deadline` is clamped to this.          |
| `MAX_SHIP_ITERATIONS`             | `50`               | Iteration cap. Firing transitions the intent to terminal `human_took_over` with `terminal_blocker_category='iteration-cap'`.                    |
| `CRON_TICKLE_INTERVAL_MS`         | `30000`            | How often the cron tickle scans `ship:tickle` for due intents.                                                                                  |
| `MERGEABLE_NULL_BACKOFF_MS_LIST`  | `500,1500,4500`    | Comma-separated bounded backoff schedule used by the probe when `mergeable=null`. Exhaustion yields `mergeable_pending` and the session yields. |
| `REVIEW_BARRIER_SAFETY_MARGIN_MS` | `1200000` (20 min) | Minimum elapsed time since the last bot push before the bot may declare `ready` without a non-bot review on the current head SHA.               |
| `FIX_ATTEMPTS_PER_SIGNATURE_CAP`  | `3`                | Max attempts per failure signature within a single intent. Cap firing terminates with `terminal_blocker_category='flake-cap'`.                  |
| `SHIP_FORBIDDEN_TARGET_BRANCHES`  | empty              | Comma-separated branches the bot refuses to shepherd PRs against.                                                                               |
| `REVIEW_RESOLVE_MAX_ITERATIONS`   | `2`                | Range `[1, 5]`. Max review/resolve loop iterations in the composite ship flow before the intent yields.                                         |

## Per-repo config file

Every installed repository may ship a config file at its **default branch**
root. Only that copy is ever applied: a change to the file inside a pull request
does not affect that pull request. Such a pull request does get a read-only
validation comment (see [Checking a file before pushing](../use/repo-config.md#checking-a-file-before-pushing)),
which never feeds the applied policy. The file carries the repo-wide master switch,
per-workflow toggles and agent knobs, pre-dispatch trigger filters, scheduled
actions, and the review-learnings block. See
[Per-repo configuration](../use/repo-config.md) for the schema and the field
reference. Every block is applied today, including the agent knobs on
`workflows.plan.*` and `workflows.triage.*`.

!!! note "`workflows.ship` takes only `enabled`"

    `workflows.ship.model`, `.max_turns`, `.timeout`, and
    `.extra_allowed_tools` are rejected by the schema. They were always a
    no-op, ship's handler only enqueues child workflows and never runs an
    agent, but they used to parse. Validation is whole-document, so one
    rejected key fails the entire file and it falls back to
    `DEFAULT_REPO_POLICY`. Put those knobs on `defaults:` or on the per-child
    entries (`triage`, `plan`, `implement`, `review`, `resolve`), which is
    what ship's steps actually resolve against.

The env vars below are the operator's half of that surface, and the
`ALLOWED_OWNERS` allowlist gates every repo before any of the file is
consulted, so nothing in a repo's YAML can readmit a repo the server rejected.
Two of the rows are cross-references, not settings of their own: they are the
numeric ceilings a repo's `max_turns` and `timeout` are clamped against, and a
repo can only lower them, never raise them.

| Variable                               | Default            | Notes                                                                                                                                                                                 |
| -------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REPO_CONFIG_FILE`                     | `.github-app.yaml` | Filename read from each installed repo's default-branch root. Trimmed at load: a stray space would 404 on every repo and silence the whole surface with nothing logged.               |
| `SCHEDULER_CONFIG_FILE`                | unset              | **Deprecated** former name for `REPO_CONFIG_FILE`. Still honoured as a fallback so an upgrade does not silently change which file is read; logs a one-shot boot warning.              |
| `AGENT_MAX_TURNS` / `DEFAULT_MAXTURNS` | unset              | Ceiling for a repo's `max_turns`, resolved as `AGENT_MAX_TURNS ?? DEFAULT_MAXTURNS`, so with the first unset the second is the ceiling. Documented under [HTTP server](#http-server). |
| `AGENT_TIMEOUT_MS`                     | `3600000`          | Ceiling for a repo's `timeout`, and an independent outer bound on the run. Documented under [HTTP server](#http-server).                                                              |

## Auto review

Runs the `review` workflow automatically when an allowlisted user pushes commits
to an open pull request (`pull_request.synchronize`), with no label and no
mention. Server mode only.

**Two keys must agree.** `AUTO_REVIEW_USERS` is the operator's half and says
_which logins may trigger it_; `workflows.review.auto` in a repo's
`.github-app.yaml` is the maintainer's half and says _whether this repo wants
it_. Neither alone enables anything. The split exists because `AUTO_REVIEW_USERS`
is server-wide across every repo of the owner, so without the per-repo key,
setting it would switch auto-review on everywhere at once.

The repo key defaults to `false`, unlike every other toggle in that file,
because `loadRepoPolicy` fails open: a missing, unreachable, or invalid config
yields the built-in defaults. Defaulting it on would let a GitHub outage start
spending tokens on every push. This mirrors `SCHEDULER_ALLOW_AUTO_MERGE` +
`auto_merge`, the other env-AND-repo automatic action.

| Variable            | Default | Notes                                                                                                                                                                                                                                      |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AUTO_REVIEW_USERS` | unset   | Comma-separated GitHub logins whose pushes may trigger an automatic review, matched case-insensitively. Unset or empty disables the feature outright. Requires a non-empty `ALLOWED_OWNERS` and `workflows.review.auto: true` on the repo. |

Four things narrow it further, all silent:

- The **pusher**, not the commit author, is what is matched. The commit author is
  derived from the commit's author email, which anyone can set; the pusher is
  authenticated by GitHub.
- **Our own pushes are skipped.** `resolve` pushes a commit per fix, and that
  push would otherwise trigger another review.

!!! warning "Under `GITHUB_PERSONAL_ACCESS_TOKEN`, do not list the PAT owner"

    The bot's writes are attributed to the PAT owner, so that login's pushes are
    indistinguishable from the bot's own. Auto-review therefore skips **every**
    push by the PAT owner, logging `auto_review.skipped_self_push`. Listing only
    the PAT owner in `AUTO_REVIEW_USERS` makes the feature look configured while
    doing nothing. List a different collaborator, or run on App auth, where the
    bot's identity is its own account.

- **Content-free pushes are skipped.** A rebase that leaves the pull request's own
  diff unchanged does not trigger a review.
- **A review already in flight wins.** A push landing mid-review is dropped, not
  queued, and nothing is posted to the pull request about it.
- **Fork pull requests are skipped.** Checkout resolves the head _branch name_
  against the base repository, so a fork's ref either fails to clone or silently
  resolves to a same-named base branch and reviews the wrong tree.
- **Pull requests `ship` is driving are skipped.** Ship runs its own
  review → resolve iteration, so a second review would duplicate the spend.

**`ALLOWED_OWNERS` is required.** Setting `AUTO_REVIEW_USERS` without it fails at
startup. Every other allowlist here narrows; this one widens, because it starts
an unattended agent run with no per-event human action, and `isOwnerAllowed`
permits every owner when `ALLOWED_OWNERS` is unset. Unlike
`CLAUDE_CODE_OAUTH_TOKEN` and `GITHUB_PERSONAL_ACCESS_TOKEN`, which demand
exactly one owner, auto-review only needs the list to be non-empty: it carries no
personal identity and no shared rate-limit bucket.

!!! warning "Auto-review removes the human-in-the-loop step"

    Every other way to start a `review` requires a deliberate act: a `bot:review`
    label or an `@chrisleekr-bot` mention. Auto-review starts the same agent
    session (Bash tool, on a clone) from an ordinary push, and the reviewer's
    prompt includes the pull request's comment thread, which on a public
    repository anyone can write to. The spotlighting, input sanitisation, output
    secret-strip, and destructive-Bash denylist all still apply, but the attacker
    no longer needs a maintainer to *choose* to run the agent, only to push.
    Enable `auto: true` only on repositories where you accept that trade-off.

Gate 1 still applies, so `enabled: false`, `workflows.review.enabled: false`, and
every `triggers.*` filter keep their veto. Refusals are logged but never
commented, since nobody asked for the run.

## Scheduled actions

Controls the internal scheduler that runs prompt-based actions declared in a
repo's `.github-app.yaml`. See [Scheduled actions](../use/scheduled-actions.md)
for the file schema. Server mode only; a daemon process ignores these.

| Variable                     | Default          | Notes                                                                                                                                                                    |
| ---------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SCHEDULER_ENABLED`          | `false`          | Master kill-switch. When false the scheduler never starts. It also will not start without `DATABASE_URL` and a non-empty `ALLOWED_OWNERS`.                               |
| `SCHEDULER_SCAN_INTERVAL_MS` | `300000` (5 min) | Cadence of the scan that enumerates installations, fetches each `.github-app.yaml`, and enqueues due actions. A value outside `[60000, 3600000]` is rejected at startup. |
| `SCHEDULER_ALLOW_AUTO_MERGE` | `false`          | Hard kill-switch for unattended auto-merge. Effective auto-merge requires BOTH this AND a per-action `auto_merge: true`; otherwise no merge tool runs.                   |

## Review learnings

Controls the **review-learnings** feature: persistent review-policy directives
extracted from past PR review pushback and injected into future `review` /
`resolve` runs as repo policy. See [Review learnings](../use/review-learnings.md)
for the user-facing model.

| Variable                       | Default | Notes                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REVIEW_LEARNINGS_ENABLED`     | `true`  | Master kill-switch. When false the orchestrator does not load learnings into job payloads and drops any agent-initiated `save_review_learning` / `delete_review_learning` actions in the result path.                                                                                                                                                                                                                               |
| `REVIEW_LEARNINGS_RAG_ENABLED` | `false` | Semantic retrieval via pgvector. When true the orchestrator embeds each directive at save time and each PR's changed-file paths at handleAccept, then runs cosine-distance top-K against `review_learnings.embedding`. Requires migration 015 (the `pgvector` extension). Adds ~80 MB to the orchestrator image (`@huggingface/transformers` + ONNX runtime); the model loads lazily on first embedding call (one-time cold start). |

The feature also requires `DATABASE_URL` (no DB, no learnings table). It is
otherwise additive: an empty `review_learnings` table means no block is
rendered, no footer is posted, and no behaviour changes. The first directive
to surface in a tracking comment is the first one an agent has saved.

**RAG rollout** (Phase 1.5.H) is staged so you can verify K8s feasibility
before committing:

1. Deploy with migration 015 applied + `REVIEW_LEARNINGS_RAG_ENABLED=false`.
   The vector column exists but stays NULL; runtime cost is unchanged.
2. Confirm `pgvector` is available (`SELECT * FROM pg_extension WHERE extname='vector';`).
3. Flip `REVIEW_LEARNINGS_RAG_ENABLED=true` on one orchestrator pod. The
   embedding pipeline loads on first save/search. Watch `kubectl top pod` for
   ~150-250 MB RSS growth and per-embedding latency in the pino logs (look
   for `Embedding pipeline loaded`).
4. Flip across the fleet once satisfied. To roll back, flip the flag off;
   no schema change needed.

## Prompt cache layout

Selects the system/user prompt split the agent executor passes to the Claude Agent SDK. See `src/config.ts:675#promptCacheLayout` for the Zod definition and `src/core/executor.ts:231#useCacheableLayout` for the runtime guard.

| Variable              | Default  | Notes                                                                                                        |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `PROMPT_CACHE_LAYOUT` | `legacy` | `legacy` or `cacheable`. Selects how the prompt is split between `systemPrompt.append` and the user message. |

**Why this exists.** The SDK's default systemPrompt (`{ type: "preset", preset: "claude_code" }`) embeds dynamic sections (cwd, platform, shell, OS) directly in the system-prompt prefix. Because each delivery clones to a unique `cwd` under `CLONE_BASE_DIR`, the system-prompt prefix is unique per job and the Anthropic prompt cache misses on every invocation, paying the 1-hour TTL `ephemeral_1h_input_tokens` cache-write surcharge (2× base price) with zero compensating reads.

**`legacy` (default).** Single user-role string built by `buildPrompt()` in `src/core/prompt-builder.ts:179#buildPrompt`. SystemPrompt is the unmodified `claude_code` preset. Backwards-compatible; safe rollback target.

**`cacheable`.** Static scaffolding (`security_directive`, `freshness_directive`, workflow steps, commit/CAPABILITIES boilerplate) is lifted into `systemPrompt.append`, and `excludeDynamicSections: true` strips cwd / platform / shell / OS from the preset. Built by `buildPromptParts()` in `src/core/prompt-builder.ts:481#buildPromptParts`. The user-role message keeps only the per-call dynamic blocks (`formatted_context`, `untrusted_*` with per-call nonce, per-call metadata). The append is byte-identical across jobs of the same shape (PR vs issue), so the system-prompt prefix becomes a stable cache key.

**Rollout.** Flip the variable to `cacheable`, then verify cache hits by tailing the executor completion log for non-zero `cacheReadInputTokens`:

```text
event: Claude Agent SDK execution completed
cacheReadInputTokens: <non-zero on the second job of the same shape within 1h>
cacheCreationInputTokens: <large on the cold first job, ~0 on warm reads>
promptCacheLayout: cacheable
```

The first job warms the cache (creation tokens dominate); subsequent jobs of the same shape within the 1-hour TTL show large read tokens and minimal creation. Cost arithmetic: cache writes are 2× base input price; cache reads are 0.1× base input price. Break-even is ~3 hits per write; persistent fleets and tight-loop ship sessions exceed this comfortably. To roll back, set `PROMPT_CACHE_LAYOUT=legacy` and restart; the executor falls through to the unmodified preset path.

**Security invariant.** The per-call nonce on `<untrusted_*>` spotlight tags lives ONLY in the user message. The append references those tags by literal `<nonce>` placeholder rather than naming the concrete nonce, so the attacker-unpredictable suffix stays intact while the append remains cacheable across calls. The trust boundary becomes structural: append is trusted scaffolding; the entire user message is attacker-influenceable data. See [architecture.md](../build/architecture.md#systemuser-trust-boundary) for the full picture.

## Mode matrix: what's required when

| Role                                     | Required                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controller (webhook server)              | GitHub App credentials, one AI provider credential, `VALKEY_URL`, `DATABASE_URL`, and `DAEMON_AUTH_TOKEN` (plus `WORKFLOW_RUNNER_CAPABILITY_SECRET` once the signer ships); K8s API access, `DAEMON_IMAGE`, and a WSS `ORCHESTRATOR_PUBLIC_URL` for structured workflows. |
| Ephemeral shared-daemon scale-up         | RBAC on `pods` in `EPHEMERAL_DAEMON_NAMESPACE` and the `EPHEMERAL_DAEMON_SECRET_NAME` Secret.                                                                                                                                                                             |
| Shared daemon (`ORCHESTRATOR_URL` set)   | `DAEMON_AUTH_TOKEN` and one AI provider credential. GitHub App credentials and data-layer URLs are not required.                                                                                                                                                          |
| Isolated workflow runner (spawner-owned) | Named provider-key references from `workflow-runner-secrets`, an injected per-attempt capability, IDs, and WSS URL. It must not receive App, PAT, database, Valkey, Kubernetes, global GitHub, or fleet credentials.                                                      |

Only one controller replica is supported. Queue recovery is durable, but workflow-runner admission does not implement a distributed semaphore or controller-session ownership.

## LLM-based output scanner (defense layer 4)

Per-call LLM scan of every agent-generated GitHub-bound body, after the deterministic regex pass in `redactSecrets()`. Catches encoded / obfuscated secrets the regex misses.

| Variable                        | Default     | Notes                                                                                                                                                                                                                                     |
| ------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LLM_OUTPUT_SCANNER_ENABLED`    | `true`      | Set `false` to disable. General GitHub-bound output keeps the deterministic regex floor and skips the encoded-secret backstop. Structured runner commands are rejected and results become a fixed safe failure while disabled.            |
| `LLM_OUTPUT_SCANNER_MODEL`      | `haiku-4-5` | Operator-friendly alias resolved by `src/ai/llm-client.ts MODEL_MAP`. A Sonnet alias detects more encoded or obfuscated variants; raise the timeout alongside it, because the isolated-runner boundary treats a slow scan as a rejection. |
| `LLM_OUTPUT_SCANNER_TIMEOUT_MS` | `30000`     | Per-call wall-clock cap. General GitHub-bound output fails open to the deterministic regex result. Structured runner RPC fails closed as described above, so the default is sized for that case rather than for comment latency.          |

System messages (router capacity, marker comments, lifecycle pings) skip the LLM pass, they cannot legitimately contain secrets and the scan is wasted spend.

## Subprocess env allowlist (defense layer 1a, issue #102)

The Claude Agent SDK CLI subprocess receives an explicit env allowlist, NOT the full `process.env`. This eliminates the prompt-injection exfiltration path where a successful injection on the agent could `cat /proc/self/environ` and leak `GITHUB_APP_PRIVATE_KEY`, `DATABASE_URL`, `DAEMON_AUTH_TOKEN`, etc.

The allowlist (in `src/core/executor.ts buildProviderEnv()`):

- **Allowed exact keys**: `HOME`, `PATH`, `USER`, `LANG`, `LC_ALL`, `TZ`, `TMPDIR`, `NODE_OPTIONS`, `NODE_PATH`, `NODE_NO_WARNINGS`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (uppercase + lowercase), `NO_COLOR`, `FORCE_COLOR`, `TERM`, `COLORTERM`, `CI`, `GH_TOKEN`, `GITHUB_TOKEN`.
- **Allowed prefixes** (forward-compatible for vendor knobs): `CLAUDE_CODE_*`, `ANTHROPIC_*`, `AWS_*`, `GIT_*`, `GH_*`.
- **Denied exact keys** (override allow): `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_PERSONAL_ACCESS_TOKEN`, `DAEMON_AUTH_TOKEN`, `DAEMON_AUTH_TOKEN_PREVIOUS`, `WORKFLOW_RUNNER_CAPABILITY_SECRET`, `WORKFLOW_RUNNER_CAPABILITY_SECRET_PREVIOUS`, `DATABASE_URL`, `VALKEY_URL`, `REDIS_URL`, `CONTEXT7_API_KEY`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `LD_PRELOAD`, `LD_LIBRARY_PATH`.
- **Denied prefixes**: `GITHUB_APP_*`, `GITHUB_WEBHOOK_*`.

If you add a new env var the agent CLI needs, extend the allowlist in `buildProviderEnv()`. Anything outside the allowlist is silently dropped, verify by running `bun test test/core/build-provider-env.test.ts` after the change.

## K8s Secret split (defense layer 1b, issue #102)

The deployment must keep controller authority out of every worker. The runtime expects these Secret boundaries:

| Secret object                    | Mounted on                       | Contents                                                                                                                                                                                                                                                                |
| -------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orchestrator-secrets`           | Controller Pod only              | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `DATABASE_URL`, `VALKEY_URL`, `CONTEXT7_API_KEY`, `DAEMON_AUTH_TOKEN[_PREVIOUS]`, `WORKFLOW_RUNNER_CAPABILITY_SECRET[_PREVIOUS]`, and the selected provider credential.                             |
| `daemon-secrets`                 | Shared daemon Pods               | Provider configuration/credential, primary `DAEMON_AUTH_TOKEN`, and `GITHUB_PERSONAL_ACCESS_TOKEN` only for legacy PAT deployments. Renameable via `EPHEMERAL_DAEMON_SECRET_NAME`; the name is a reference, the contents are what this row constrains.                  |
| `workflow-runner-secrets`        | Isolated workflow runner Pods    | The spawner references only the named provider keys listed in [`deployment.md`](deployment.md#workflow-runner-secrets-secret). Unexpected keys are not imported. Never place App, PAT, database, Valkey, Kubernetes, Context7, GitHub, or daemon-auth credentials here. |
| `workflow-runner-<attempt UUID>` | One isolated workflow runner Pod | One deadline-bound `capability` derived for that run and attempt. The controller creates the Pod first, then makes this Secret a Kubernetes-owned dependent of that exact Pod UID.                                                                                      |

The controller mints a short-lived token restricted to the target repository and forwards it after runner registration. Shared daemons retain the legacy credential path. Structured workflows refuse PAT mode because the controller cannot mint a repository-bound App token from a PAT.

A shared daemon logs a startup warning if it sees controller-only secrets. An isolated workflow runner fails startup when any controller, fleet, PAT, global GitHub, Kubernetes, or Context7 credential is present, or when a cloud metadata endpoint answers. Kubernetes Secrets still require encryption at rest and least-privilege RBAC; base64 storage alone is not encryption.

## Output secret-stripping behavior (defense layer 2)

Every body posted to GitHub is scanned by `redactSecrets()`, see `src/utils/sanitize.ts` for the patterns. Detections are SILENTLY STRIPPED (no marker, no footer, no count surfaced in the body) so attackers get no probing feedback. Operator-side info is logged via Pino `warn` with `event: "secret_redacted"` carrying `kinds`, `matchCount`, `callsite`, `deliveryId`, but never the matched bytes.

If redaction empties the body entirely, the GitHub call is skipped and `event: "secret_redaction_emptied_body"` is logged at `error`.
