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

| Variable                     | Default                                         | Required when                                      | Notes                                                                                                                      |
| ---------------------------- | ----------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE_PROVIDER`            | `anthropic`                                     | _none_                                             | `anthropic` or `bedrock`.                                                                                                  |
| `CLAUDE_MODEL`               | `claude-opus-4-7` (anthropic); _none_ (bedrock) | Bedrock                                            | Bedrock requires an explicit Bedrock model ID.                                                                             |
| `ANTHROPIC_API_KEY`          | _none_                                          | Anthropic, unless `CLAUDE_CODE_OAUTH_TOKEN` is set | Console pay-as-you-go. Safe for multi-tenant deploys.                                                                      |
| `CLAUDE_CODE_OAUTH_TOKEN`    | _none_                                          | Anthropic, unless `ANTHROPIC_API_KEY` is set       | Max/Pro subscription token (`sk-ant-oat…`). Requires `ALLOWED_OWNERS`.                                                     |
| `AWS_REGION`                 | _none_                                          | Bedrock                                            | Resolved by the AWS SDK credential chain.                                                                                  |
| `AWS_PROFILE`                | _none_                                          | Optional (bedrock)                                 | Local SSO profile for dev.                                                                                                 |
| `AWS_ACCESS_KEY_ID`          | _none_                                          | Optional (bedrock)                                 | Long-lived credential pair. Prefer profile or OIDC.                                                                        |
| `AWS_SECRET_ACCESS_KEY`      | _none_                                          | Optional (bedrock)                                 | Paired with `AWS_ACCESS_KEY_ID`.                                                                                           |
| `AWS_SESSION_TOKEN`          | _none_                                          | Optional (bedrock)                                 | Temporary credentials.                                                                                                     |
| `AWS_BEARER_TOKEN_BEDROCK`   | _none_                                          | Optional (bedrock, CI)                             | Set automatically by `aws-actions/configure-aws-credentials` OIDC.                                                         |
| `ANTHROPIC_BEDROCK_BASE_URL` | _none_                                          | Optional (bedrock)                                 | Override Bedrock runtime endpoint (VPC endpoint / proxy).                                                                  |
| `ALLOWED_OWNERS`             | _none_                                          | OAuth or PAT path                                  | Comma-separated allowlist. Required (single owner) when using `CLAUDE_CODE_OAUTH_TOKEN` or `GITHUB_PERSONAL_ACCESS_TOKEN`. |

## HTTP server

| Variable                      | Default                      | Notes                                                                                                                                                                                                                |
| ----------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                        | `3000`                       | HTTP webhook listener.                                                                                                                                                                                               |
| `LOG_LEVEL`                   | `info`                       | Pino level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`. `debug` surfaces full webhook payloads.                                                                                                              |
| `NODE_ENV`                    | `production`                 | `production`, `development`, `test`.                                                                                                                                                                                 |
| `TRIGGER_PHRASE`              | `@chrisleekr-bot`            | Mention text that triggers the bot. Local dev typically sets `@chrisleekr-bot-dev`.                                                                                                                                  |
| `BOT_APP_LOGIN`               | `chrisleekr-bot[bot]`        | Bot's GitHub login. Used by the loop-prevention check.                                                                                                                                                               |
| `MAX_CONCURRENT_REQUESTS`     | `3`                          | Ceiling on simultaneous Claude executions across the fleet.                                                                                                                                                          |
| `MAX_FETCHED_COMMENTS`        | `500`                        | Per-PR/issue cap on comments merged from the GraphQL fetcher (`src/core/fetcher.ts`). When the cap fires the fetcher emits `log.warn({ connection: "comments", … })` and sets `FetchedData.truncated.comments=true`. |
| `MAX_FETCHED_REVIEWS`         | `500`                        | Per-PR cap on reviews merged from the fetcher. Sets `FetchedData.truncated.reviews=true` on cap fire.                                                                                                                |
| `MAX_FETCHED_REVIEW_COMMENTS` | `500`                        | Per-PR cap on inline review comments merged across all reviews (top-level + nested follow-up paginate). Sets `truncated.reviewComments=true`.                                                                        |
| `MAX_FETCHED_FILES`           | `500`                        | Per-PR cap on changed files merged from the fetcher. Sets `truncated.changedFiles=true` on cap fire.                                                                                                                 |
| `AGENT_TIMEOUT_MS`            | `3600000`                    | Wall-clock budget for one agent execution (60 min). Lower only when the job is bounded.                                                                                                                              |
| `AGENT_MAX_TURNS`             | unset                        | Optional Claude SDK turn cap. Unset = no cap. Overrides `DEFAULT_MAXTURNS`.                                                                                                                                          |
| `DEFAULT_MAXTURNS`            | unset                        | Process-wide turn cap. Set only if ops needs a hard ceiling.                                                                                                                                                         |
| `CLAUDE_CODE_PATH`            | resolved from `node_modules` | Absolute path to the Claude Code CLI `cli.js`.                                                                                                                                                                       |
| `CLONE_BASE_DIR`              | `/tmp/bot-workspaces`        | Parent directory for per-delivery clones.                                                                                                                                                                            |
| `CLONE_DEPTH`                 | `50`                         | Shallow-clone depth. Increase for deeply-diverged PRs.                                                                                                                                                               |
| `CONTEXT7_API_KEY`            | unset                        | Lifts Context7 MCP rate limiting. No other effect.                                                                                                                                                                   |

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

| Variable                       | Default               | Notes                                                                                                                                                                                                              |
| ------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WS_PORT`                      | `3002`                | Orchestrator WebSocket listener. Must differ from `PORT`.                                                                                                                                                          |
| `ORCHESTRATOR_URL`             | _none_                | Presence flips the process to daemon mode. Use `wss://` in production; `ws://` emits a warning.                                                                                                                    |
| `ORCHESTRATOR_PUBLIC_URL`      | _none_                | Public WebSocket URL the spawner injects into ephemeral Pods.                                                                                                                                                      |
| `DAEMON_AUTH_TOKEN`            | _none_                | Shared secret for the daemon ⇄ orchestrator handshake. Required on both sides. Compared in constant time.                                                                                                          |
| `DAEMON_AUTH_TOKEN_PREVIOUS`   | _none_                | Optional rotation overlap. Orchestrator accepts either the primary or this previous token; daemons always send the primary. See [`runbooks/daemon-fleet.md`](runbooks/daemon-fleet.md#rotating-daemon_auth_token). |
| `HEARTBEAT_INTERVAL_MS`        | `30000`               | Daemon → orchestrator ping cadence.                                                                                                                                                                                |
| `HEARTBEAT_TIMEOUT_MS`         | `90000`               | Eviction threshold. Keep `≥ 2 × HEARTBEAT_INTERVAL_MS`.                                                                                                                                                            |
| `STALE_EXECUTION_THRESHOLD_MS` | `3600000`             | How long a `running` execution may sit before the watcher fails it. Set `≥ AGENT_TIMEOUT_MS`.                                                                                                                      |
| `DAEMON_DRAIN_TIMEOUT_MS`      | `300000`              | Post-`SIGTERM` window to finish in-flight work. Raise to `≥ AGENT_TIMEOUT_MS` for zero mid-run kills.                                                                                                              |
| `JOB_MAX_RETRIES`              | `3`                   | Retries for transient daemon dispatch failures.                                                                                                                                                                    |
| `OFFER_TIMEOUT_MS`             | `5000`                | How long the orchestrator waits for a daemon to claim an offer.                                                                                                                                                    |
| `QUEUE_WORKER_BACKOFF_MAX_MS`  | `5000`                | Upper bound on the queue-worker's sleep when no local daemon can take a job.                                                                                                                                       |
| `LIVENESS_REAPER_INTERVAL_MS`  | `30000` (min `20000`) | Cadence of the heartbeat-based reaper.                                                                                                                                                                             |
| `DAEMON_UPDATE_STRATEGY`       | `exit`                | `exit`, `pull`, or `notify`. Advisory hint reported in the update response.                                                                                                                                        |
| `DAEMON_UPDATE_DELAY_MS`       | `0`                   | Delay before graceful shutdown after an update signal.                                                                                                                                                             |
| `DAEMON_MEMORY_FLOOR_MB`       | `512`                 | Minimum free memory the orchestrator requires before dispatching.                                                                                                                                                  |
| `DAEMON_DISK_FLOOR_MB`         | `1024`                | Minimum free disk the orchestrator requires before dispatching.                                                                                                                                                    |

## Ephemeral daemons

Used when the orchestrator scales daemon capacity on demand.

| Variable                                 | Default           | Notes                                                                                            |
| ---------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------ |
| `DAEMON_EPHEMERAL`                       | `false`           | Set to `true` on ephemeral daemon Pods (injected by the spawner). Controls idle-exit.            |
| `EPHEMERAL_DAEMON_IDLE_TIMEOUT_MS`       | `120000`          | Ephemeral daemon exits after this idle window.                                                   |
| `EPHEMERAL_DAEMON_SPAWN_COOLDOWN_MS`     | `30000`           | Minimum time between ephemeral spawns (orchestrator side).                                       |
| `EPHEMERAL_DAEMON_SPAWN_QUEUE_THRESHOLD` | `3`               | Queue length that triggers an `ephemeral-daemon-overflow` spawn.                                 |
| `EPHEMERAL_DAEMON_NAMESPACE`             | `default`         | Kubernetes namespace for spawned ephemeral Pods.                                                 |
| `DAEMON_IMAGE`                           | auto-detected     | K8s image URI override.                                                                          |
| `KUBECONFIG`                             | auto (in-cluster) | Kubernetes client config path. The client auto-detects in-cluster via `KUBERNETES_SERVICE_HOST`. |

The orchestrator also expects a pre-existing `daemon-secrets` Kubernetes Secret in `EPHEMERAL_DAEMON_NAMESPACE`, mounted into the spawned Pod via `envFrom: secretRef: daemon-secrets`. See [`deployment.md`](deployment.md#ephemeral-daemon-kubernetes-requirements).

## Triage

| Variable                      | Default     | Notes                                                                                                  |
| ----------------------------- | ----------- | ------------------------------------------------------------------------------------------------------ |
| `TRIAGE_ENABLED`              | `true`      | Kill-switch. When `false`, triage returns `heavy=false` and the job routes to `persistent-daemon`.     |
| `TRIAGE_MODEL`                | `haiku-3-5` | Alias resolved at runtime.                                                                             |
| `TRIAGE_CONFIDENCE_THRESHOLD` | `1.0`       | Below this, triage is treated as sub-threshold and the job routes to `persistent-daemon`.              |
| `TRIAGE_MAX_TOKENS`           | `256`       | Cap on the JSON response. Above ~100 is wasted budget.                                                 |
| `TRIAGE_TIMEOUT_MS`           | `5000`      | Per-call wall clock. Beyond this, the circuit-breaker counter increments.                              |
| `INTENT_CONFIDENCE_THRESHOLD` | `0.75`      | Range `[0, 1]`. Below this, a mention-driven comment gets a clarification reply instead of a dispatch. |

## Discussion digest

| Variable                  | Default      | Notes                                                                                                                       |
| ------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `DISCUSSION_DIGEST_MODEL` | `sonnet-4-6` | Alias resolved at runtime. Model for the LLM that distills an issue/PR comment thread into maintainer guidance (see below). |

The discussion-digest step (`src/workflows/discussion-digest.ts`) runs before each
structured workflow: it summarises the comment thread into a guidance digest the
workflow prompt consumes in place of the raw thread. It is fail-open (any LLM or
parse error falls back to body-only / raw-comment context) and has no comment-count
cap, so there is nothing else to tune.

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

## Scheduled actions

Controls the internal scheduler that runs prompt-based actions declared in a
repo's `.github-app.yaml`. See [Scheduled actions](../use/scheduled-actions.md)
for the file schema. Server mode only; a daemon process ignores these.

| Variable                     | Default            | Notes                                                                                                                                                                    |
| ---------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SCHEDULER_ENABLED`          | `false`            | Master kill-switch. When false the scheduler never starts. It also will not start without `DATABASE_URL` and a non-empty `ALLOWED_OWNERS`.                               |
| `SCHEDULER_SCAN_INTERVAL_MS` | `300000` (5 min)   | Cadence of the scan that enumerates installations, fetches each `.github-app.yaml`, and enqueues due actions. A value outside `[60000, 3600000]` is rejected at startup. |
| `SCHEDULER_ALLOW_AUTO_MERGE` | `false`            | Hard kill-switch for unattended auto-merge. Effective auto-merge requires BOTH this AND a per-action `auto_merge: true`; otherwise no merge tool runs.                   |
| `SCHEDULER_CONFIG_FILE`      | `.github-app.yaml` | Filename read from each installed repo's default-branch root.                                                                                                            |

## Prompt cache layout

Selects the system/user prompt split the agent executor passes to the Claude Agent SDK. See `src/config.ts:562` for the Zod definition and `src/core/executor.ts:208` for the runtime guard.

| Variable              | Default  | Notes                                                                                                        |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `PROMPT_CACHE_LAYOUT` | `legacy` | `legacy` or `cacheable`. Selects how the prompt is split between `systemPrompt.append` and the user message. |

**Why this exists.** The SDK's default systemPrompt (`{ type: "preset", preset: "claude_code" }`) embeds dynamic sections (cwd, platform, shell, OS) directly in the system-prompt prefix. Because each delivery clones to a unique `cwd` under `CLONE_BASE_DIR`, the system-prompt prefix is unique per job and the Anthropic prompt cache misses on every invocation, paying the 1-hour TTL `ephemeral_1h_input_tokens` cache-write surcharge (2× base price) with zero compensating reads.

**`legacy` (default).** Single user-role string built by `buildPrompt()` in `src/core/prompt-builder.ts:126`. SystemPrompt is the unmodified `claude_code` preset. Backwards-compatible; safe rollback target.

**`cacheable`.** Static scaffolding (`security_directive`, `freshness_directive`, workflow steps, commit/CAPABILITIES boilerplate) is lifted into `systemPrompt.append`, and `excludeDynamicSections: true` strips cwd / platform / shell / OS from the preset. Built by `buildPromptParts()` in `src/core/prompt-builder.ts:402`. The user-role message keeps only the per-call dynamic blocks (`formatted_context`, `untrusted_*` with per-call nonce, per-call metadata). The append is byte-identical across jobs of the same shape (PR vs issue), so the system-prompt prefix becomes a stable cache key.

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

| Role                                    | Required                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Orchestrator (webhook server)           | GitHub App credentials, one AI provider credential, `VALKEY_URL`, `DATABASE_URL`, `DAEMON_AUTH_TOKEN`.        |
| Ephemeral-daemon scale-up               | K8s API access + RBAC on `pods` in `EPHEMERAL_DAEMON_NAMESPACE`, `daemon-secrets` Secret.                     |
| Daemon process (`ORCHESTRATOR_URL` set) | `DAEMON_AUTH_TOKEN`, one AI provider credential. GitHub App credentials and data-layer URLs are NOT required. |

## LLM-based output scanner (defense layer 4)

Per-call LLM scan of every agent-generated GitHub-bound body, after the deterministic regex pass in `redactSecrets()`. Catches encoded / obfuscated secrets the regex misses.

| Variable                        | Default     | Notes                                                                                                                                     |
| ------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `LLM_OUTPUT_SCANNER_ENABLED`    | `true`      | Set `false` to disable. Skipping the scan saves ~1–2s and ~$0.0002 per agent reply but loses the encoded-secret backstop.                 |
| `LLM_OUTPUT_SCANNER_MODEL`      | `haiku-3-5` | Operator-friendly alias resolved by `src/ai/llm-client.ts MODEL_MAP`. Cheapest Haiku that emits the structured JSON schema is sufficient. |
| `LLM_OUTPUT_SCANNER_TIMEOUT_MS` | `3000`      | Per-call wall-clock cap. On timeout, the helper FAILS OPEN, posts the body that survived the regex pass and emits a `warn` log.           |

System messages (router capacity, marker comments, lifecycle pings) skip the LLM pass, they cannot legitimately contain secrets and the scan is wasted spend.

## Subprocess env allowlist (defense layer 1a, issue #102)

The Claude Agent SDK CLI subprocess receives an explicit env allowlist, NOT the full `process.env`. This eliminates the prompt-injection exfiltration path where a successful injection on the agent could `cat /proc/self/environ` and leak `GITHUB_APP_PRIVATE_KEY`, `DATABASE_URL`, `DAEMON_AUTH_TOKEN`, etc.

The allowlist (in `src/core/executor.ts buildProviderEnv()`):

- **Allowed exact keys**: `HOME`, `PATH`, `USER`, `LANG`, `LC_ALL`, `TZ`, `TMPDIR`, `NODE_OPTIONS`, `NODE_PATH`, `NODE_NO_WARNINGS`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (uppercase + lowercase), `NO_COLOR`, `FORCE_COLOR`, `TERM`, `COLORTERM`, `CI`, `GH_TOKEN`, `GITHUB_TOKEN`.
- **Allowed prefixes** (forward-compatible for vendor knobs): `CLAUDE_CODE_*`, `ANTHROPIC_*`, `AWS_*`, `GIT_*`, `GH_*`.
- **Denied exact keys** (override allow): `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_PERSONAL_ACCESS_TOKEN`, `DAEMON_AUTH_TOKEN`, `DAEMON_AUTH_TOKEN_PREVIOUS`, `DATABASE_URL`, `VALKEY_URL`, `REDIS_URL`, `CONTEXT7_API_KEY`.
- **Denied prefixes**: `GITHUB_APP_*`, `GITHUB_WEBHOOK_*`.

If you add a new env var the agent CLI needs, extend the allowlist in `buildProviderEnv()`. Anything outside the allowlist is silently dropped, verify by running `bun test test/core/build-provider-env.test.ts` after the change.

## K8s Secret split (defense layer 1b, issue #102)

The Helm chart MUST split secrets into two K8s Secret objects so the daemon Pod's filesystem/environment never carries orchestrator-only credentials, even if the env allowlist above develops a future bug:

| Secret object          | Mounted on                   | Contents                                                                                                                                                                             |
| ---------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `orchestrator-secrets` | Orchestrator Pod ONLY        | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `DATABASE_URL`, `VALKEY_URL`, `CONTEXT7_API_KEY`, `DAEMON_AUTH_TOKEN[_PREVIOUS]` (issuance side).                |
| `daemon-secrets`       | Daemon Pod (incl. ephemeral) | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, `AWS_*` chain (Bedrock provider), `DAEMON_AUTH_TOKEN[_PREVIOUS]` (handshake side), `GITHUB_PERSONAL_ACCESS_TOKEN` (PAT mode only). |

The orchestrator mints short-lived GitHub installation tokens and forwards them via the WebSocket, daemons never see the App private key or webhook secret.

A startup warning fires if a daemon process detects orchestrator-only env vars at boot: it does NOT crash (a downed daemon is worse than a degraded posture), but the warning surfaces the misconfiguration in operator logs.

## Output secret-stripping behavior (defense layer 2)

Every body posted to GitHub is scanned by `redactSecrets()`, see `src/utils/sanitize.ts` for the patterns. Detections are SILENTLY STRIPPED (no marker, no footer, no count surfaced in the body) so attackers get no probing feedback. Operator-side info is logged via Pino `warn` with `event: "secret_redacted"` carrying `kinds`, `matchCount`, `callsite`, `deliveryId`, but never the matched bytes.

If redaction empties the body entirely, the GitHub call is skipped and `event: "secret_redaction_emptied_body"` is logged at `error`.
