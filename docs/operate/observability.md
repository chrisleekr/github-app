# Observability

Structured JSON logs via [pino](https://getpino.io) are the primary signal. Every dispatch decision and every pipeline step carries a `deliveryId` so you can reconstruct a request end-to-end from a single log query, and the webhook event handlers plus the daemon workflow executor additionally carry a canonical `entityNumber` (the issue or PR number) so a request can be reconstructed by entity as well. When `DATABASE_URL` is configured, the same information is persisted to `executions` and `triage_results` for aggregate reporting.

## Log redaction

The exported `logger` in `src/logger.ts` is the canonical chokepoint for secret scrubbing, every child logger inherits its `redact.paths` list and its custom `err` serializer, so individual call sites do not need to remember to scrub. Two layers run on every emitted line:

1. **Path-based redaction**: the exported `REDACT_PATHS` constant in `src/logger.ts` lists every field pino should replace with `[Redacted]` before the JSON is serialised. Paths covered: `authorization` and its `*.authorization` / `headers.authorization` / `*.headers.authorization` / `req.headers.authorization` / `request.headers.authorization` variants; the webhook signature header `x-hub-signature-256` (also wildcard-prefixed); `response.data.token`; and the named credential fields `token`, `installationToken`, `privateKey`, `webhookSecret`, `anthropicApiKey`, `claudeCodeOauthToken`, `daemonAuthToken`, `awsSecretAccessKey`, `awsSessionToken`, `awsBearerTokenBedrock`, `*.password`. The list is `Object.freeze`d so an accidental `push` from another module cannot silently weaken the policy.

2. **`errSerializer` scrubbing**: the exported `errSerializer` in `src/logger.ts` defers to pino's `stdSerializers.err` and then runs the result's `message`, `stack`, `request.headers`, and `response.data` through `redactGitHubTokens` (`src/utils/sanitize.ts`) plus an inline credential-URL scrubber that mirrors `redactValkeyUrl` (`src/orchestrator/valkey.ts`). The walker recurses through nested objects/arrays and replaces any key matching the sensitive-field-name set wholesale, so `err.response.data.meta.token` and `err.request.headers.forwarded.authorization` are caught at any depth: this is necessary because pino's path-based rules cannot match four-or-more segments deep on `err.*`. It also catches `ghs_…` installation tokens and App JWTs echoed inside `err.message` / `err.stack`.

The serializer operates on a copy, so the original Error instance is never mutated.

If you add a new secret-bearing config field to `src/config.ts`, add its property name to `REDACT_PATHS` in the same PR. The point helpers `redactGitHubTokens` and `redactValkeyUrl` remain in place for their non-log call sites (prompt sanitisation and the Valkey startup info log respectively); the logger config is the system-wide default.

The crash path is covered too. `installFatalHandlers(processName)` in `src/logger.ts` registers `uncaughtException` and `unhandledRejection` handlers at both entrypoints (`src/app.ts`, `src/daemon/main.ts`) that log via `logger.fatal({ err })` and then `process.exit(1)`. Without them the runtime's default handler would print a plain `stderr` stack that bypasses `errSerializer`, so a token echoed inside an octokit error would reach the log shipper in cleartext. The default destination flushes synchronously on the process `exit` event, so the fatal line is written before exit; `pino.final` is intentionally not used because it throws when the logger is built with the dev-only `pino-pretty` transport. Crash lines carry `level: 60` (fatal) and a `processName` of `orchestrator` or `daemon`, so an alert on sustained `level:60` flags a crash-looping process.

## Common log fields

| Field                                | Meaning                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deliveryId`                         | `X-GitHub-Delivery` header, stable across every log line for a single webhook.                                                                                                                                                                                                                                                                                                                            |
| `entityNumber`                       | Canonical issue or PR number for the request. Emitted by `createChildLogger` (`src/logger.ts`) across the webhook event handlers and the workflow executor so a request is greppable by entity. Two adjacent layers keep their own names: the job-payload schema uses `prNumber` / `issueNumber`, and the scoped-rail executors use snake_case `pr_number` / `issue_number`.                              |
| `installationId`                     | GitHub App installation id. Emitted by the webhook event handlers (`src/webhook/events/`) and the daemon job executor (`src/daemon/job-executor.ts`) so a per-installation rate-limit (see [GitHub API rate-limit fields](#github-api-rate-limit-fields)) is greppable to its installation. App mode only; absent under a `GITHUB_PERSONAL_ACCESS_TOKEN` (PAT) where there is no per-installation bucket. |
| `event`                              | GitHub event name (`pull_request`, `issue_comment`, …) or canonical event key for ship workflow logs.                                                                                                                                                                                                                                                                                                     |
| `repo`                               | `owner/name` of the triggering repo.                                                                                                                                                                                                                                                                                                                                                                      |
| `dispatch_target`                    | Always `daemon` (singleton, kept as a field for DB/log stability).                                                                                                                                                                                                                                                                                                                                        |
| `dispatch_reason`                    | Why the job landed where it did. See [Dispatch reasons](#dispatch-reasons).                                                                                                                                                                                                                                                                                                                               |
| `isEphemeral`                        | Present on daemon-originating log lines. `true` if emitted by an ephemeral daemon.                                                                                                                                                                                                                                                                                                                        |
| `triage_fallback_reason`             | Only present on triage fallbacks, see [`runbooks/triage.md`](runbooks/triage.md).                                                                                                                                                                                                                                                                                                                         |
| `confidence`, `heavy`, `rationale`   | Triage outputs on success.                                                                                                                                                                                                                                                                                                                                                                                |
| `cost_usd`                           | Agent-reported total cost from the SDK.                                                                                                                                                                                                                                                                                                                                                                   |
| `workflowRunId`, `workflowName`      | UUID of the `workflow_runs` row + workflow name. Stable per run.                                                                                                                                                                                                                                                                                                                                          |
| `intentWorkflow`, `intentConfidence` | Intent-classifier verdict and confidence for comment triggers.                                                                                                                                                                                                                                                                                                                                            |
| `branch`, `depth`                    | Initial clone target, emitted by `checkout.ts` on the `Cloning repository` line.                                                                                                                                                                                                                                                                                                                          |
| `baseBranch`, `headBranch`           | PR base + head ref, emitted on `Fetching PR base branch` (info) and the matching warn on fetch fail.                                                                                                                                                                                                                                                                                                      |
| `stage`                              | Pipeline stage name on a `pipeline.stage` event (e.g. `github.fetch`, `repo.clone`, `executor.invoke`).                                                                                                                                                                                                                                                                                                   |
| `delta_ms`                           | Wall-clock of a single `pipeline.stage` (integer ms).                                                                                                                                                                                                                                                                                                                                                     |
| `pipeline_wall_clock_ms`             | Cumulative pipeline duration, on the terminal `pipeline.completed` / `pipeline.failed` line (integer ms).                                                                                                                                                                                                                                                                                                 |
| `op`                                 | Short dotted identifier on a `retry.*` event identifying the wrapped call site (e.g. `github.fetch`, `mcp.comment.update`). Lowercase-dotted segments with `snake_case` inside each segment, see [Retry log fields](#retry-log-fields) for the naming convention.                                                                                                                                         |
| `attempt`                            | 1-based attempt ordinal on a `retry.*` event. Aligns with the OpenTelemetry `http.request.resend_count` semantic.                                                                                                                                                                                                                                                                                         |
| `max_attempts`                       | Maximum-attempts ceiling for the current `retryWithBackoff` call.                                                                                                                                                                                                                                                                                                                                         |
| `elapsed_ms`                         | Wall-clock since `retryWithBackoff` entry on a `retry.*` event (integer ms). On `retry.exhausted` it carries the full retry-window duration.                                                                                                                                                                                                                                                              |
| `delay_ms`                           | Next backoff that will be slept after a `retry.attempt_failed`. Omitted on the final attempt because no sleep follows.                                                                                                                                                                                                                                                                                    |
| `status`                             | HTTP status code lifted from the raw error. Present on `retry.non_retriable` (always, since the branch only fires for 4xx) and on `retry.attempt_failed` when the failure carried one (e.g. 503, 429); also on `github.api.*` events.                                                                                                                                                                     |

## Core pipeline log fields

`runPipeline` (`src/core/pipeline.ts`) emits structured timing events whose `pipeline.stage` shape is pinned by the `.strict()` Zod schema in `src/core/log-fields.ts` (parallel to the ship schema below; the co-located test rejects field drift). Four event keys:

| `event`              | Meaning                                                                                                                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipeline.started`   | Request entered `runPipeline`. Carries the child-logger bindings (deliveryId, entity).                                                                                                                                                                     |
| `pipeline.stage`     | One stage finished; carries `stage` + `delta_ms`. Stages: trackingComment.create, token.resolve, github.fetch, prompt.build, repo.clone, executor.invoke, trackingComment.finalize, workspace.cleanup.                                                     |
| `pipeline.completed` | Success terminal line; carries `pipeline_wall_clock_ms` alongside `costUsd` / `numTurns` and the token counters `inputTokens` / `outputTokens` / `cacheReadInputTokens` / `cacheCreationInputTokens` (issue #192). Pinned by `PipelineCompletedLogSchema`. |
| `pipeline.failed`    | Failure terminal line; carries `pipeline_wall_clock_ms` + the redacted `err`.                                                                                                                                                                              |

### Token usage and the cache hit-ratio

The executor's `Claude Agent SDK execution completed` line (`src/core/executor.ts`) and the `pipeline.completed` line carry the SDK token counters; the executor line additionally carries a `modelUsage` array (one `{ model, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUsd }` entry per model). The same four scalar counters are persisted to the `executions` table (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) plus a `model_usage` JSONB column (migration `016_executions_tokens.sql`), so per-installation / per-workflow / per-day aggregates can join them.

Cost alone is opaque: a 500 KB-prompt / 2-turn run and a 5 KB-prompt / 50-turn run can bill the same `costUsd`. Tokens disambiguate them, an oversized prompt is an `inputTokens` problem; a runaway tool-loop is an `outputTokens` + `numTurns` problem. The load-bearing metric for prompt-cache stability (#134) is the hit-ratio:

```
cache_read_input_tokens / (input_tokens + cache_read_input_tokens + cache_creation_input_tokens)
```

(The ratio is undefined when the denominator is zero, e.g. a dry-run that never called the model; guard against that in the query.) A high ratio on the second+ run of the same prompt shape confirms `PROMPT_CACHE_LAYOUT=cacheable` is working; a sudden drop in the per-installation cache-read share is the signature of a prompt-cache stability regression. Alert on `sum(cache_read_input_tokens) / sum(input_tokens + cache_read_input_tokens + cache_creation_input_tokens)` falling below its established baseline.

### Workspace sweep

`sweepStaleWorkspaces` (`src/core/workspace-sweep.ts`) emits one line per startup sweep when the daemon and the webhook server reclaim stale per-job workspace triples under `CLONE_BASE_DIR` (orphans left by SIGKILL/OOM/eviction). A `swept` count climbing across restarts means jobs are being killed mid-run before their own cleanup runs.

| `event`           | Level | Fields                                                                                                       |
| ----------------- | ----- | ------------------------------------------------------------------------------------------------------------ |
| `workspace.sweep` | info  | `swept` (entries removed), `retained` (entries kept as fresh), `durationMs` (wall-clock time for the sweep). |

## GitHub API rate-limit fields

The `App` is constructed with `ObservableOctokit` (`src/utils/octokit-observability.ts`), an `Octokit.plugin` subclass shared by `app.octokit` and every installation octokit. It logs GitHub's per-installation rate-limit headers via `octokit.hook.after` / `hook.error`. The `pipeline.stage`-style strict Zod schema (`GithubApiLogFieldsSchema`) pins the field shape.

Volume policy: the per-request line is `debug` (default `info` stays quiet on a fleet issuing thousands of calls/hour); a `warn` fires only when quota runs low or a rate-limit error lands. Set `LOG_LEVEL=debug` for full per-call visibility, no separate sampling knob.

| `event`                         | Level | Fields                                                                                                        |
| ------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------- |
| `github.api.request`            | debug | `route`, `status`, `rate_limit_limit`, `rate_limit_remaining`, `rate_limit_reset_in_s`, `rate_limit_resource` |
| `github.api.rate_limit_low`     | warn  | Same fields; emitted once `rate_limit_remaining` drops below `RATE_LIMIT_LOW_WATER` (500).                    |
| `github.api.rate_limit_warning` | warn  | `route`, `status`, `retry_after_s`; on a 429 or 403 secondary-rate-limit response.                            |

## Retry log fields

`retryWithBackoff` (`src/utils/retry.ts`) is the single chokepoint guarding every transient-failure recovery in the bot, including the GraphQL fetcher, every GitHub-touching MCP server, the orchestrator triage probe, the ship probe, and the pipeline's three GitHub writes. Its four-event family is pinned by a `z.discriminatedUnion` of strict objects in `src/utils/retry-log-fields.ts` so an emitter that adds an unpinned field, mistypes one (e.g. `delayMs` vs `delay_ms`), or attaches a field to the wrong event (e.g. `delay_ms` on `retry.exhausted`, `status` on `retry.succeeded_after_retry`) trips the co-located test. Every event carries `op` (a short dotted identifier from the call site), `attempt`, `max_attempts`, and `elapsed_ms`. See [Common log fields](#common-log-fields) for the scalar field definitions.

**`op` naming convention.** Lowercase-dotted segments with `snake_case` inside each segment, e.g. `mcp.inline_comment.fetch_pr`, `github.state.pr_state_check_rollup`, `tracking_comment.create`. This matches the `pipeline.stage` event-name style already used elsewhere in this doc and keeps `op =~ "mcp\\..*"`-style operator groupings regular as new call sites are threaded. New `retryWithBackoff` call sites should follow it. Empty / whitespace-only `op` is normalised to `"unknown"` at the entry of `retryWithBackoff` so the non-empty `op` contract holds even when a caller threads an unexpected value.

The load-bearing event is `retry.succeeded_after_retry`: it is the only signal in the bot's telemetry today that an upstream is starting to wobble _before_ full failure. A 1% transient-failure rate against GitHub or Bedrock is invisible at the default `info` level otherwise, the only retry telemetry is warn/error, which fires only on the long tail. The `info`-level `succeeded_after_retry` line makes the body of the transient-failure distribution observable; an alert on `count(event = "retry.succeeded_after_retry") by op` over 5-minute windows surfaces the leading indicator without waiting for the warn-level `attempt_failed` count to spike.

| `event`                       | Level | When                                                                                                                                                                                                                                                                                |
| ----------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retry.attempt_failed`        | warn  | An attempt threw a retriable error (5xx, 429, or 403 secondary rate-limit). Carries `delay_ms` when another attempt will follow (omitted on the final attempt) and `status` when the underlying error carried one (HTTP errors; absent for non-HTTP errors like connection resets). |
| `retry.non_retriable`         | warn  | A 4xx (except 429 and 403 secondary rate-limit) bypasses retry. Always carries `status` (the branch only fires when the raw error carried a 4xx) and rethrows.                                                                                                                      |
| `retry.exhausted`             | error | All `max_attempts` attempts failed. Carries the full retry-window `elapsed_ms`; rethrows the last error. Neither `delay_ms` nor `status` are emitted on this event.                                                                                                                 |
| `retry.succeeded_after_retry` | info  | The call succeeded on `attempt > 1`. Weak-flake leading indicator: gated on `attempt > 1` so first-try successes stay silent. Alert on `count(...) by op` over 5-minute windows. Neither `delay_ms` nor `status` are emitted on this event.                                         |

## Output secret-guard log events

`safePostToGitHub` (`src/utils/github-output-guard.ts`) is the output-side chokepoint for every byte sent to GitHub. It emits structured `warn`/`error` events when the regex pass or the optional LLM scanner acts on a body. Per the logging contract, none of these carry the matched bytes, surrounding context, or a hash, only `kinds`, counts, lengths, `callsite`, and `deliveryId`.

| `event`                             | Level | When                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `secret_redacted`                   | warn  | Regex pass (`scanner: "regex"`) or LLM scanner (`scanner: "llm"`) stripped secret bytes from an outgoing body.                                                                                                                                                                         |
| `llm_scanner_emptied_body_fallback` | warn  | LLM scanner emptied a body the regex pass kept; treated as a false positive, regex-only body posted.                                                                                                                                                                                   |
| `llm_scanner_substitution_rejected` | warn  | LLM scanner returned a non-deletion-only body (added/reordered/altered bytes); substitution rejected, regex-only body posted. A prompt-injected scanner is the leading hypothesis. The regex floor still applies, so the body is not guaranteed secret-free beyond it. See issue #198. |
| `llm_scanner_error`                 | warn  | LLM scanner threw (e.g. Bedrock outage); fail-open, body that survived the regex pass is posted.                                                                                                                                                                                       |
| `secret_redaction_emptied_body`     | error | Body was whitespace-only after redaction; the GitHub call is skipped entirely (no blank comment).                                                                                                                                                                                      |

## MCP server log fields

The stdio MCP servers (`src/mcp/servers/*.ts`) run as subprocesses without the daemon `config`, so they cannot import `src/logger.ts` (it reads `config` at module load). Instead they build a pino logger via `createMcpLogger(serverName)` (`src/mcp/mcp-logger.ts`), which writes to **stderr** (stdout carries JSON-RPC) and applies the same `REDACT_PATHS` + `errSerializer` as the main logger, imported from the config-free `src/utils/log-redaction.ts` so redaction has parity without pulling in `config`. This replaced the prior raw `console.error` calls, where a `console.error(err)` on an Octokit `RequestError` could dump a `ghs_…` token verbatim.

| Field        | Meaning                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------- |
| `server`     | MCP server name (e.g. `github-comment`, `github-state`, `merge-readiness`).                     |
| `deliveryId` | Inherited from the parent request via the `DELIVERY_ID` env (set in `registry.ts` `sharedEnv`). |
| `event`      | Structured event key, e.g. `secret_redacted` when the output secret-guard strips bytes.         |

`LOG_LEVEL` is in the executor subprocess env allowlist, so `LOG_LEVEL=debug` on the daemon propagates to the CLI and the MCP subprocesses for incident response.

## Fleet snapshot fields

The orchestrator emits a periodic `fleet.snapshot` info line (`src/orchestrator/fleet-snapshot.ts`, cadence `FLEET_SNAPSHOT_INTERVAL_MS`, default 30s) so backlog and pool saturation stay log-visible even when no webhook is arriving to trigger an on-demand read. Set `FLEET_SNAPSHOT_INTERVAL_MS=0` to disable.

| Field                   | Meaning                                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| `queue_depth`           | `LLEN queue:jobs`, the shared job queue backlog.                          |
| `active_daemons_total`  | Number of live daemons in the `active_daemons` set.                       |
| `busy_slots_total`      | Sum of in-flight jobs across the live daemons.                            |
| `persistent_free_slots` | Spare capacity (`maxConcurrentJobs - active`) across the persistent pool. |

Alerts worth having: `queue_depth` rising while `persistent_free_slots > 0` for several snapshots (suggests broken capability matching, work isn't reaching idle daemons); `active_daemons_total` dropping to 0 while `queue_depth > 0` (no workers).

## Dispatcher log fields

The job dispatcher (`src/orchestrator/job-dispatcher.ts`) and the accept handler in `src/orchestrator/connection-handler.ts` emit the offer lifecycle as structured events. The four `dispatcher.offer.*` keys are pinned per-event by a `z.discriminatedUnion` (`src/orchestrator/log-fields.ts:55#DispatcherOfferLogSchema`), so each event carries exactly its own fields; `dispatcher.no_eligible_daemon` has its own shape. Event-key constants live in `src/orchestrator/log-fields.ts:28#DISPATCHER_LOG_EVENTS`, and the co-located test rejects field drift.

| `event`                         | Level | Meaning                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatcher.offer.sent`         | info  | An offer was sent to a selected daemon. Carries `kind`, `deliveryId`, `daemonId`, `offerId`, plus `fleetSize` + `requiredTools` for capacity/capability diagnostics, plus `queue_wait_ms` (enqueue→offer wait for this attempt; see the per-attempt note below).                                                                                      |
| `dispatcher.offer.accepted`     | info  | The daemon claimed the offer. Carries `deliveryId`, `daemonId`, `offerId` plus `offer_latency_ms`, the offer→accept WebSocket round-trip, measured the instant the accept arrives so it excludes the orchestrator-side context lookup + token mint. `kind` is omitted here; correlate to the `sent` line by `offerId` for the authoritative job kind. |
| `dispatcher.offer.rejected`     | info  | The daemon refused the offer; carries `reason` + `offer_latency_ms`. The job is re-queued for another daemon.                                                                                                                                                                                                                                         |
| `dispatcher.offer.timed_out`    | warn  | No accept or reject arrived within `OFFER_TIMEOUT_MS` (default 5s); carries `offer_latency_ms` (≈ the timeout). The job is re-queued.                                                                                                                                                                                                                 |
| `dispatcher.no_eligible_daemon` | info  | No live daemon matched the job's `requiredTools` or had free capacity. Carries `fleetSize` + `requiredTools` so an operator can separate a capability-match miss from sheer capacity exhaustion, plus `queue_wait_ms` (wait at the moment of the miss), which surfaces a capability-match bounce loop that the `queue_depth` gauge hides.             |

`offer_latency_ms` and `queue_wait_ms` are the snake_case fields, matching the `delta_ms` metric idiom; ids stay camelCase, consistent with the app-wide pino correlation fields.

`queue_wait_ms` is `max(0, Date.now() - job.enqueuedAt)` at the moment of the event. **It is per-attempt, not end-to-end:** `enqueuedAt` is reset to `Date.now()` on every requeue (the `requeueJob` paths in `src/orchestrator/job-queue.ts` and the `reconstructJobFromOffer` paths in `src/orchestrator/job-dispatcher.ts`), so a job that bounces through `no_eligible_daemon` or a daemon reject restarts the clock. Read it as "how long this attempt waited for a dispatch decision," the saturation signal (USE-method "time waiting" / Sidekiq queue latency), not total time in system. Alert: a sustained p99 `queue_wait_ms` over ~30s on `dispatcher.offer.sent` indicates fleet undersizing; cross-check against `offer_latency_ms` (rising there instead points to slow daemons, not too few of them).

## Daemon heartbeat fields

The orchestrator pings each connected daemon every `HEARTBEAT_INTERVAL_MS` (default 30s) and evicts one that misses pongs past `HEARTBEAT_TIMEOUT_MS` (default 90s). The heartbeat lifecycle in `src/orchestrator/connection-handler.ts` emits three structured events pinned per-event by a `z.discriminatedUnion` (`src/orchestrator/log-fields.ts:122#DaemonHeartbeatLogSchema`), so `missedPongs` is pinned to `pong_missed` and `ttl_refresh_failed` carries its `err`; constants live in `src/orchestrator/log-fields.ts:36#DAEMON_HEARTBEAT_LOG_EVENTS`.

| `event`                               | Level | Meaning                                                                                              |
| ------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------- |
| `daemon.heartbeat.pong_missed`        | warn  | A ping was sent while the prior pong was still outstanding; carries the running `missedPongs` count. |
| `daemon.heartbeat.timeout`            | warn  | The pong window elapsed; the connection is closed and the daemon eligible for re-registration.       |
| `daemon.heartbeat.ttl_refresh_failed` | error | A pong arrived but refreshing the daemon's Valkey/Postgres TTL failed; carries the redacted `err`.   |

Alerts worth having: a sustained `daemon.heartbeat.timeout` rate points at network or resource-floor issues (a flapping daemon), distinct from a daemon that is responding slowly (visible as rising p99 `offer_latency_ms`).

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
- **Heartbeat drift.** Daemons missing heartbeats past `HEARTBEAT_TIMEOUT_MS` get evicted; sustained eviction points at network or resource-floor issues. A `daemon.heartbeat.timeout` rate above baseline is the log-side signal.
- **Daemons refusing work.** A sustained `event:"dispatcher.offer.rejected"` rate (group by `reason`) means daemons are bouncing offers, a capacity or capability mismatch, before the queue visibly backs up.
- **Offer round-trip latency.** A p99 regression on `offer_latency_ms` for `event:"dispatcher.offer.accepted"` flags a daemon that is responding but slow (GC pause, capability rescan stall, WebSocket back-pressure), eating dispatch headroom without tripping the heartbeat timeout.
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
