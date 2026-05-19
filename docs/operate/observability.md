# Observability

Structured JSON logs via [pino](https://getpino.io) are the primary signal. Every dispatch decision and every pipeline step carries a `deliveryId` so you can reconstruct a request end-to-end from a single log query. When `DATABASE_URL` is configured, the same information is persisted to `executions` and `triage_results` for aggregate reporting.

## Log redaction

The exported `logger` in `src/logger.ts` is the canonical chokepoint for secret scrubbing, every child logger inherits its `redact.paths` list and its custom `err` serializer, so individual call sites do not need to remember to scrub. Two layers run on every emitted line:

1. **Path-based redaction**: the exported `REDACT_PATHS` constant in `src/logger.ts` lists every field pino should replace with `[Redacted]` before the JSON is serialised. Paths covered: `authorization` and its `*.authorization` / `headers.authorization` / `*.headers.authorization` / `req.headers.authorization` / `request.headers.authorization` variants; the webhook signature header `x-hub-signature-256` (also wildcard-prefixed); `response.data.token`; and the named credential fields `token`, `installationToken`, `privateKey`, `webhookSecret`, `anthropicApiKey`, `claudeCodeOauthToken`, `daemonAuthToken`, `awsSecretAccessKey`, `awsSessionToken`, `awsBearerTokenBedrock`, `*.password`. The list is `Object.freeze`d so an accidental `push` from another module cannot silently weaken the policy.

2. **`errSerializer` scrubbing**: the exported `errSerializer` in `src/logger.ts` defers to pino's `stdSerializers.err` and then runs the result's `message`, `stack`, `request.headers`, and `response.data` through `redactGitHubTokens` (`src/utils/sanitize.ts`) plus an inline credential-URL scrubber that mirrors `redactValkeyUrl` (`src/orchestrator/valkey.ts`). The walker recurses through nested objects/arrays and replaces any key matching the sensitive-field-name set wholesale, so `err.response.data.meta.token` and `err.request.headers.forwarded.authorization` are caught at any depth: this is necessary because pino's path-based rules cannot match four-or-more segments deep on `err.*`. It also catches `ghs_…` installation tokens and App JWTs echoed inside `err.message` / `err.stack`.

The serializer operates on a copy, so the original Error instance is never mutated.

If you add a new secret-bearing config field to `src/config.ts`, add its property name to `REDACT_PATHS` in the same PR. The point helpers `redactGitHubTokens` and `redactValkeyUrl` remain in place for their non-log call sites (prompt sanitisation and the Valkey startup info log respectively); the logger config is the system-wide default.

## Common log fields

| Field                                | Meaning                                                                                               |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `deliveryId`                         | `X-GitHub-Delivery` header, stable across every log line for a single webhook.                        |
| `event`                              | GitHub event name (`pull_request`, `issue_comment`, …) or canonical event key for ship workflow logs. |
| `repo`                               | `owner/name` of the triggering repo.                                                                  |
| `dispatch_target`                    | Always `daemon` (singleton, kept as a field for DB/log stability).                                    |
| `dispatch_reason`                    | Why the job landed where it did. See [Dispatch reasons](#dispatch-reasons).                           |
| `isEphemeral`                        | Present on daemon-originating log lines. `true` if emitted by an ephemeral daemon.                    |
| `triage_fallback_reason`             | Only present on triage fallbacks, see [`runbooks/triage.md`](runbooks/triage.md).                     |
| `confidence`, `heavy`, `rationale`   | Triage outputs on success.                                                                            |
| `cost_usd`                           | Agent-reported total cost from the SDK.                                                               |
| `workflowRunId`, `workflowName`      | UUID of the `workflow_runs` row + workflow name. Stable per run.                                      |
| `intentWorkflow`, `intentConfidence` | Intent-classifier verdict and confidence for comment triggers.                                        |
| `branch`, `depth`                    | Initial clone target, emitted by `checkout.ts` on the `Cloning repository` line.                      |
| `baseBranch`, `headBranch`           | PR base + head ref, emitted on `Fetching PR base branch` (info) and the matching warn on fetch fail.  |

## Ship workflow log fields

The shepherding lifecycle emits structured pino lines validated against the canonical Zod schema in `src/workflows/ship/log-fields.ts`. Field names and types are pinned so emitters cannot drift.

| Field                       | Type                                                                            | When present                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `event`                     | string (e.g. `ship.intent.transition`, `ship.probe.run`, `ship.reactor.fanout`) | Always.                                                                                       |
| `intent_id`                 | UUID                                                                            | Always.                                                                                       |
| `pr`                        | `{owner, repo, number, installation_id}`                                        | Always.                                                                                       |
| `iteration_n`               | non-negative int                                                                | Always (0 on pre-iteration events).                                                           |
| `phase`                     | `probe` \| `fix` \| `reply` \| `wait` \| `terminal`                             | Iteration events.                                                                             |
| `from_status` / `to_status` | session status                                                                  | Transition events only.                                                                       |
| `terminal_blocker_category` | blocker category                                                                | Terminal `human_took_over` transitions.                                                       |
| `non_readiness_reason`      | enum                                                                            | Probe events with non-ready verdict.                                                          |
| `trigger_surface`           | `literal` \| `nl` \| `label`                                                    | Session-start events only.                                                                    |
| `principal_login`           | string                                                                          | Session-start events only.                                                                    |
| `spent_usd_cents`           | non-negative integer                                                            | Always, cumulative session spend in cents (integer to avoid binary-fp drift in aggregations). |
| `wall_clock_ms`             | non-negative integer                                                            | Always, cumulative session wall-clock.                                                        |
| `delta_usd_cents`           | non-negative integer                                                            | Per-event spend (iteration events only).                                                      |
| `delta_ms`                  | non-negative integer                                                            | Per-event wall-clock duration.                                                                |

The schema is the source of truth. Adding or renaming a field requires updating `src/workflows/ship/log-fields.ts`; the co-located test round-trips a sample through the schema and rejects unknown / mistyped fields.

### Iteration / tickle / scoped event keys

Every shepherding emitter draws its `event` value from the typed `SHIP_LOG_EVENTS` constant in `src/workflows/ship/log-fields.ts`. Operators can grep for these literals deterministically.

| Event key                             | Where it fires                                                                    | What it indicates                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `ship.iteration.enqueued`             | `iteration.runIteration` after `enqueueJob`                                       | A non-ready verdict bridged into the daemon `workflow_runs` pipeline. One row per iteration.  |
| `ship.iteration.terminal_cap`         | `iteration.runIteration` cap check                                                | The intent hit `MAX_SHIP_ITERATIONS`.                                                         |
| `ship.iteration.terminal_deadline`    | `iteration.runIteration` deadline check                                           | The intent's `deadline_at` elapsed.                                                           |
| `ship.tickle.started`                 | `app.ts` boot, after `tickleScheduler.start()`                                    | The cron tickle scheduler is scanning `ship:tickle`.                                          |
| `ship.tickle.due`                     | `orchestrator.onStepComplete` early-wake **or** `session-runner.resumeShipIntent` | An intent is being re-entered. `source` discriminates `workflow_run_completion` vs scheduler. |
| `ship.tickle.skip_terminal`           | `orchestrator.onStepComplete` early-wake                                          | The hook found a `shipIntentId` but the intent is already terminal; the ZADD was skipped.     |
| `ship.scoped.<verb>.enqueued`         | `dispatch-scoped.ts` after `enqueueJob`                                           | A scoped command (`rebase`, `fix_thread`, `explain_thread`, `open_pr`) was enqueued.          |
| `ship.scoped.<verb>.daemon.completed` | `connection-handler.handleScopedJobCompletion` and the executor                   | Daemon reported `succeeded`.                                                                  |
| `ship.scoped.<verb>.daemon.failed`    | Same                                                                              | Daemon reported `halted` or `failed`. `reason` carries the structured halt reason.            |

### Querying example (Datadog / Loki)

```text
event:"ship.intent.transition" to_status:"human_took_over" terminal_blocker_category:"flake-cap"
| count by pr.repo
```

## Dispatch reasons

Canonical source: `src/shared/dispatch-types.ts`. Four values; all land on `dispatch_target=daemon`.

| Reason                      | When the router sets it                                                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `persistent-daemon`         | Routed to an existing persistent daemon. The default, hot path. Also used during cooldown when a scale-up was warranted but blocked by the cooldown window. |
| `ephemeral-daemon-triage`   | Triage returned `heavy=true` and an ephemeral daemon Pod was spawned.                                                                                       |
| `ephemeral-daemon-overflow` | Queue length ≥ `EPHEMERAL_DAEMON_SPAWN_QUEUE_THRESHOLD` **and** the persistent pool has zero free slots; a spawn drains the overflow.                       |
| `ephemeral-spawn-failed`    | A spawn was required but the K8s API call failed. The job is rejected with a tracking-comment infra error.                                                  |

## Scheduled action log fields

Emitted by the scheduler (`src/scheduler/`, component `scheduler`) and the
daemon executor.

| Event                               | Meaning                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `scheduler.action.claimed`          | A due cron slot was claimed and a `scheduled-action` job enqueued.      |
| `scheduler.action.skipped_missed`   | A slot fired while the server was down; advanced over, not run.         |
| `scheduler.action.daemon.started`   | The daemon began running a scheduled action.                            |
| `scheduler.action.daemon.completed` | The action's agent session finished (`success`, `costUsd`, `numTurns`). |
| `scheduler.action.daemon.failed`    | The action failed before the agent ran (e.g. repo lookup).              |

The scheduler logs action metadata (`name`, `cron`, `owner`, `repo`,
`deliveryId`) only, never the resolved prompt text.

## Aggregate reporting

When `DATABASE_URL` is set, helpers in `src/db/queries/dispatch-stats.ts` expose the most operator-relevant aggregates:

| Helper                           | Returns                                                                                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventsPerTarget(days)`          | Count of executions grouped by `dispatch_target`. Post-collapse this is always a single `daemon` row, query `dispatch_reason` directly for the per-reason split. |
| `triageRate(days)`               | Share of events whose `dispatch_reason` is `ephemeral-daemon-triage`.                                                                                            |
| `avgConfidenceAndFallback(days)` | Mean triage confidence plus fallback counts by reason.                                                                                                           |
| `triageSpend(days)`              | Cumulative `cost_usd` for triage-reached executions.                                                                                                             |

Call them from an internal admin endpoint, a scheduled job, or `bun repl`.

## Alerts worth having

- **Triage error rate.** `parse-error` + `llm-error` + `timeout` + `circuit-open` above a sustained threshold (e.g. 10 % over 15 minutes) signals provider trouble or a regression.
- **Ephemeral spawn failures.** Any `dispatch_reason=ephemeral-spawn-failed` points at RBAC, quota, or control-plane issues.
- **Heartbeat drift.** Daemons missing heartbeats past `HEARTBEAT_TIMEOUT_MS` get evicted; sustained eviction points at network or resource-floor issues.
- **OOM / crash loops.** Standard infra alerts. Durable idempotency means a restart will not replay a processed event.
- **Ship terminal-blocker rate.** A spike in `ship.intent.transition` events with `to_status:human_took_over` and `terminal_blocker_category:flake-cap` points at PR-flake regressions, not bot misbehaviour.

## Data fetching safety caps

`src/core/fetcher.ts` walks every `pageInfo { hasNextPage endCursor }` connection it receives via `octokit.graphql.paginate(...)`, so PRs/issues with hundreds of comments, reviews, inline review comments, or changed files are no longer silently truncated to the first 100. The four `MAX_FETCHED_*` env vars (see [`configuration.md`](configuration.md)) bound the **merged result** that reaches the agent prompt, they do not bound how much data is fetched and held in memory during pagination. The fetcher walks every page first, then trims the array to the most recent `cap` items; fetch-time memory is bounded by GitHub API limits (max items per connection), not these caps. Operators tuning for cost/latency should narrow entity selection (e.g. close noisy issues) rather than rely on the cap to cut request volume.

When a cap fires the fetcher emits a single structured warn line per affected connection and flags the connection on the returned `FetchedData` so downstream code can surface it:

```json
{
  "level": "warn",
  "msg": "Fetched comments exceeded MAX_FETCHED cap; truncating to 500",
  "connection": "comments",
  "fetched": 642,
  "cap": 500
}
```

`connection` is one of `comments`, `reviews`, `reviewComments`, `changedFiles`. The matching boolean lands on `FetchedData.truncated.<connection>` (`src/types.ts`).

`buildPrompt` (`src/core/prompt-builder.ts`) reads `data.truncated` and, when at least one flag is set, prepends a `WARNING: pre-fetched context is incomplete…` line to the agent's instructions naming the affected connections and instructing it to reach for the GitHub CLI / API directly when full context matters. Operators reading agent transcripts can grep for that banner to confirm a cap fired without re-querying logs.

Alert rule: any `level=warn msg~"exceeded MAX_FETCHED cap"` occurrence is interesting. A steady stream from the same `repo` over several deliveries usually means the cap should be raised for that tenant; a one-off on a notoriously huge PR is expected and not actionable.

## Health probes

| Path       | Purpose                                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------- |
| `/healthz` | Liveness, returns 200 once the HTTP server is bound.                                                |
| `/readyz`  | Readiness, 200 once config is validated and the data layer is reachable; flips to 503 on `SIGTERM`. |

## Supply-chain attestations

> Note: As SBOM file size is over 16MB, temporary disable SBOM attestations.

`docker-build.yml` publishes two attestation flavours per release tag, same image, different storage and verification surface. Operators investigating a CVE alert or auditing what shipped to production reach for these instead of re-running Trivy from scratch.

| Storage                                                               | Format                                                                                                                                                     | Bound to                                              | How to inspect                                                                                                  |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Registry, OCI subject descriptor on the per-arch leaf manifest        | SLSA v1 provenance + SPDX 2.3 SBOM (per arch)                                                                                                              | Each per-arch image manifest (the BuildKit defaults). | `docker buildx imagetools inspect <ref> --format '{{ json .Provenance }}'` / `{{ json .SBOM }}`                 |
| Registry, Sigstore bundle attached to the merged manifest-list digest | SLSA v1 provenance + CycloneDX 1.5 SBOM (**amd64 packages only**, Syft scans the runner's native arch; arm64 audits must use the per-arch SPDX SBOM above) | The published tag (orchestrator + daemon variants).   | `gh attestation verify oci://<ref> --repo chrisleekr/github-app-playground --predicate-type <slsa\|cyclonedx>`  |
| GitHub Attestations API                                               | Same Sigstore bundles as above                                                                                                                             | Same tag digest.                                      | Repo `Actions ▸ Attestations` tab; surfaces under the GitHub Releases "Verified" badge once a tag is published. |

Docker Hub renders a "Build attestations" badge on the tag page once the Sigstore-signed flavour is detected. The full source/predicate of every signature is replayable via the [Sigstore transparency log (Rekor)](https://search.sigstore.dev/) using the digest from `gh attestation verify`.

The `scan` job in `.github/workflows/docker-build.yml` calls `gh attestation verify` for both predicate types before running Trivy: a regression-gate against silent attestation drops in any future refactor of the build / merge jobs. Consumer-side verification commands live in [`deployment.md`](deployment.md#verifying-image-attestations).
