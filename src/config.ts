import { z } from "zod";

/**
 * Optional string that treats empty / whitespace-only input as absent.
 *
 * Why: `envFrom: secretRef` injects every Secret key as an env var, even
 * keys whose decrypted value is "". Plain `z.string().optional()` would
 * keep that "" alive and let it shadow a real credential downstream
 * (e.g. `apiKey ?? oauthToken` returns "" instead of falling through).
 * Coercing here makes the invariant uniform: if the field is defined
 * on `Config`, the value is non-empty.
 */
const nonEmptyOptionalString = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().optional(),
);

/**
 * Duration field that accepts either a positive integer (ms) or a
 * duration string with `h`/`m`/`s` suffix (e.g. `4h`, `30m`, `1.5h`,
 * `90s`). The output is always integer milliseconds. Used by ship-loop
 * env vars where operators naturally express ceilings as durations.
 *
 * `.default()` on the wrapping field bypasses preprocess (Zod applies
 * defaults when input is `undefined`, before preprocess runs), so
 * downstream `.default(N)` callers can pass a raw integer.
 */
const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(h|m|s)$/;
const durationMs = z.preprocess((v) => {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return v;
  const trimmed = v.trim();
  if (trimmed === "") return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  // eslint-disable-next-line @typescript-eslint/prefer-regexp-exec -- match() reads cleaner here; equivalent to RegExp#exec for capture-group access
  const match = trimmed.match(DURATION_PATTERN);
  if (match === null) return v;
  const numericPart = match[1];
  const unit = match[2];
  if (numericPart === undefined || unit === undefined) return v;
  const n = Number(numericPart);
  const mult = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000;
  return Math.round(n * mult);
}, z.number().int().positive());

/**
 * Comma-separated list of positive integers (ms). Empty input is
 * rejected: the list MUST contain at least one value because the
 * shepherding loop iterates until exhaustion. Used by
 * `MERGEABLE_NULL_BACKOFF_MS_LIST`.
 */
const mergeableBackoffList = z
  .string()
  .default("5000,10000,30000,60000,60000")
  .transform((raw, ctx): number[] => {
    const parts = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "MERGEABLE_NULL_BACKOFF_MS_LIST must contain at least one positive integer",
      });
      return z.NEVER;
    }
    const out: number[] = [];
    for (const part of parts) {
      const n = Number(part);
      if (!Number.isInteger(n) || n <= 0) {
        ctx.addIssue({
          code: "custom",
          message: `MERGEABLE_NULL_BACKOFF_MS_LIST entries must be positive integers (ms); got "${part}"`,
        });
        return z.NEVER;
      }
      out.push(n);
    }
    return out;
  });

/**
 * Comma-separated list of branch names. Empty/unset → empty array
 * (no branch restriction). Used by `SHIP_FORBIDDEN_TARGET_BRANCHES`.
 */
const shipForbiddenTargetBranchesField = z
  .string()
  .optional()
  .transform((v): string[] => {
    if (v === undefined || v.trim() === "") return [];
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  });

/**
 * Zod-validated environment variables.
 * Fails fast at startup if required vars are missing.
 */
const configSchema = z
  .object({
    // --- 1. GitHub App credentials (server mode) ---

    // GitHub App credentials, required for server mode, optional for daemon-only mode.
    // Daemon mode (ORCHESTRATOR_URL set) does not need these; validated in superRefine.
    appId: z.string().optional(),
    privateKey: z.string().optional(),
    webhookSecret: z.string().optional(),

    // --- 2. AI provider selection ---

    // AI provider selection: "anthropic" (default) or "bedrock".
    // "bedrock" additionally requires `awsRegion` + `model`, enforced in validateProviderCredentials.
    provider: z.enum(["anthropic", "bedrock"]).default("anthropic"),

    // Model override, required when provider=bedrock (Bedrock uses different model ID format),
    // optional input for anthropic. The schema-level .transform below defaults the
    // anthropic path to "claude-opus-4-7", so the inferred Config.model is `string`
    // (not `string | undefined`), consumers do not need to handle the undefined case.
    model: z.string().min(1).optional(),

    // --- 3. Anthropic direct-API credentials ---

    // Claude API credentials, when provider=anthropic, at least one of these is required
    // (both may be set; the Claude CLI's own auth precedence chain picks one at runtime:
    // ANTHROPIC_API_KEY at position 3 beats CLAUDE_CODE_OAUTH_TOKEN at position 5).
    // Either Console API key (pay-as-you-go) or Max/Pro subscription OAuth token
    // (generated via `claude setup-token`, sk-ant-oat... prefix).
    // See https://code.claude.com/docs/en/authentication#authentication-precedence
    //
    // `preprocess` coerces empty / whitespace-only strings to `undefined` so a
    // Secret key whose decrypted value is "" (e.g. `envFrom: secretRef` over a
    // SealedSecret with a stale empty entry) cannot shadow a real OAuth token
    // via downstream `??` short-circuits. Callers can rely on the invariant:
    // if defined, the value is non-empty after trim.
    anthropicApiKey: nonEmptyOptionalString,
    claudeCodeOauthToken: nonEmptyOptionalString,

    // Optional: replace the GitHub App installation token with a personal access
    // token for every GitHub API call and `git push`. When set,
    // `resolveGithubToken()` short-circuits the App-token mint and uses this
    // value instead. Affects API actions (PR comments, reviews, GraphQL) and
    // push-side identity, but NOT commit author/committer metadata: that is
    // pinned to `chrisleekr-bot[bot]` in src/core/checkout.ts via `git config
    // user.name/user.email` and stays the same regardless of which token mints
    // the request. Single-tenant only, must be paired with a single-owner
    // ALLOWED_OWNERS, mirroring the CLAUDE_CODE_OAUTH_TOKEN constraint, because
    // a PAT carries a real human identity and per-user rate-limit bucket.
    // Set via GITHUB_PERSONAL_ACCESS_TOKEN env var.
    githubPersonalAccessToken: nonEmptyOptionalString,

    // --- 4. AWS Bedrock credentials ---

    // Target AWS region for Bedrock. Required when provider=bedrock.
    awsRegion: z.string().optional(),
    // Local dev: AWS SSO profile (after: le aws login -e dev).
    // Passed to the Claude Code subprocess env so the AWS SDK credential chain resolves it.
    awsProfile: z.string().optional(),
    // Explicit key credentials, use in CI/CD or non-SSO environments. Prefer
    // `awsProfile` locally and `awsBearerTokenBedrock` (OIDC) in GitHub Actions.
    awsAccessKeyId: z.string().optional(),
    awsSecretAccessKey: z.string().optional(),
    awsSessionToken: z.string().optional(),
    // OIDC bearer token, set automatically by aws-actions/configure-aws-credentials
    // in GitHub Actions. Do not hand-set in long-running environments.
    awsBearerTokenBedrock: z.string().optional(),
    // Overrides the Bedrock runtime endpoint. Leave unset unless fronting Bedrock
    // with a VPC endpoint or proxy, otherwise the SDK picks the correct regional URL.
    anthropicBedrockBaseUrl: z.string().optional(),

    // --- 5. App runtime / behaviour ---

    // Context7 MCP API key, optional. Unset works but is rate-limited; setting it
    // only lifts the rate limit. Does not change auth mode or tool availability.
    context7ApiKey: z.string().optional(),

    // Parent directory for per-delivery repo clones. Created on boot via
    // mkdir(..., { recursive: true }) in src/core/checkout.ts. Each delivery gets
    // a unique subdir under this path and the subdir is deleted after the run.
    cloneBaseDir: z.string().default("/tmp/bot-workspaces"),

    // Git clone depth for repo checkout. Increase for PRs with deeply diverged branches.
    // Set via CLONE_DEPTH env var (default: 50).
    cloneDepth: z.coerce.number().int().positive().default(50),

    // Mention string that triggers the bot. MUST match the GitHub App's bot login
    // exactly; a mismatch silently drops every webhook event because the trigger
    // matcher returns no hit.
    triggerPhrase: z.string().default("@chrisleekr-bot"),

    // GitHub App bot author login as it appears in commit/push payloads,
    // distinct from `triggerPhrase` (which is the @-mention). Used by the ship
    // workflow's foreign-push detection: pushes whose head author equals
    // `botAppLogin` are treated as bot-authored and don't terminate active
    // sessions. Default matches the production app login (`chrisleekr-bot[bot]`).
    // Override per-environment via `BOT_APP_LOGIN`.
    botAppLogin: z.string().default("chrisleekr-bot[bot]"),

    // HTTP port for the webhook listener. Independent of `wsPort` (orchestrator WS).
    port: z.coerce.number().int().positive().default(3000),

    // pino log level. Raise to "debug" or "trace" only for short investigations;
    // "debug" surfaces full webhook payloads (contains owner/repo data).
    logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

    // Runtime environment tag. "production" additionally enables the ws:// warning
    // on `orchestratorUrl` (installation tokens + DAEMON_AUTH_TOKEN transit in
    // cleartext on ws://).
    nodeEnv: z.enum(["production", "development", "test"]).default("production"),

    // Limits concurrent Claude agent executions to prevent API budget exhaustion
    // and resource saturation. Set via MAX_CONCURRENT_REQUESTS env var.
    maxConcurrentRequests: z.coerce.number().int().positive().default(3),

    // Per-connection safety caps applied during PR/issue GraphQL fetches in
    // src/core/fetcher.ts. The fetcher walks every page via cursor-based
    // pagination (octokit graphql.paginate) and then trims the merged result
    // to the most recent `cap` items, newest survives, oldest drops. When
    // truncation fires the matching flag on `FetchedData.truncated` is set
    // and a structured `log.warn({ connection, fetched, cap })` is emitted.
    // Defaults are sized so a 99th-percentile PR/issue still fits without
    // truncation; raise only when the prompt budget can absorb the larger
    // context. NOTE: pagination is bounded by GitHub API limits, not by
    // these caps, operators tuning for cost should prefer narrower entity
    // selection over a smaller cap.
    maxFetchedComments: z.coerce.number().int().positive().default(500),
    maxFetchedReviews: z.coerce.number().int().positive().default(500),
    maxFetchedReviewComments: z.coerce.number().int().positive().default(500),
    maxFetchedFiles: z.coerce.number().int().positive().default(500),

    // Wall-clock timeout for a single Claude agent execution in milliseconds.
    // Guards against resource exhaustion from hung model responses or MCP servers.
    // Default 60 minutes, implement / review steps on non-trivial issues
    // routinely take 30-50 min of real work; capping shorter cuts the agent
    // off mid-task and loses progress. Hung-process risk is bounded by
    // container resource limits, not this number. Set AGENT_TIMEOUT_MS lower
    // for testing or smaller-scope deployments.
    agentTimeoutMs: z.coerce.number().int().positive().default(3_600_000),

    // Override max turns for the Claude Agent SDK, used as a FALLBACK ONLY on
    // src/core/executor.ts when invoked without an explicit `maxTurns`
    // argument. Since the dispatch-collapse, the orchestrator always passes
    // `config.defaultMaxTurns` to the daemon, so this knob only affects
    // non-dispatched internal callers.
    agentMaxTurns: z.coerce.number().int().positive().optional(),

    // Absolute path to the Claude Code CLI entry point (cli.js).
    // Required when claude-code is installed globally (e.g. Docker) rather than as a
    // local node_modules dependency, because the SDK defaults to {cwd}/dist/cli.js.
    // Set via CLAUDE_CODE_PATH env var (e.g. /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js).
    claudeCodePath: z.string().optional(),

    // Owner allowlist, when set, the bot only processes events from repositories
    // owned by one of these GitHub accounts (case-insensitive). Empty/unset means
    // no restriction. REQUIRED for single-tenant deployments using
    // CLAUDE_CODE_OAUTH_TOKEN, because the Agent SDK Note prohibits serving other
    // users' repos from a personal subscription quota.
    // See https://code.claude.com/docs/en/agent-sdk/overview
    // Set via ALLOWED_OWNERS env var (comma-separated list, e.g. "chrisleekr,acme").
    allowedOwners: z
      .string()
      .optional()
      .transform((v): string[] | undefined => {
        if (v === undefined || v === "") return undefined;
        const parsed = v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        return parsed.length === 0 ? undefined : parsed;
      }),

    // --- 6. Data layer (mandatory in server mode) ---

    // `valkeyUrl` backs the daemon job queue. `databaseUrl` backs the
    // `executions` + `triage_results` tables. Both are required in server
    // mode (no ORCHESTRATOR_URL) and optional in daemon mode (the daemon
    // talks to the orchestrator over WebSocket, not to the data layer).
    valkeyUrl: z.string().optional(),
    databaseUrl: z.string().optional(),

    // --- 7. Orchestrator ---

    // Orchestrator WebSocket listener port. Bound ONLY in server mode
    // (src/orchestrator/ws-server.ts). Daemons connect OUT to this port; they do
    // not bind. Must differ from `port` to avoid a collision in single-process mode.
    wsPort: z.coerce.number().int().positive().default(3002),

    // --- 8. Daemon / Orchestrator WebSocket ---

    // Shared secret for the daemon ⇄ orchestrator WebSocket handshake. A mismatch
    // on either side rejects the connection. Required on both sides.
    daemonAuthToken: z.string().optional(),

    // Optional rotation-window predecessor of `daemonAuthToken`. When set, the
    // orchestrator accepts daemons whose Bearer header matches EITHER the
    // primary or the previous token (still constant-time). Operators set this
    // to the old value during a rolling rotation, then drop it once every
    // daemon has restarted with the new primary. Daemon-side this value is
    // ignored, daemons always send the primary `daemonAuthToken`.
    //
    // Uses `nonEmptyOptionalString` so a whitespace-only env value (e.g. a
    // Secret key whose decrypted value is "" or "   ") is coerced to
    // `undefined` rather than surviving as a "valid" but empty Bearer
    // credential after `Bearer ` is prepended.
    daemonAuthTokenPrevious: nonEmptyOptionalString,

    // Presence of ORCHESTRATOR_URL flips the process from SERVER mode to
    // DAEMON mode: the webhook HTTP server does NOT start and GitHub App
    // credentials are not required. Must be ws:// or wss:// (validated below).
    orchestratorUrl: z
      .string()
      .optional()
      .refine((value) => {
        if (value === undefined || value === "") return true;
        try {
          const url = new URL(value);
          return url.protocol === "ws:" || url.protocol === "wss:";
        } catch {
          return false;
        }
      }, "ORCHESTRATOR_URL must be a valid ws:// or wss:// URL"),

    // Daemon ping cadence. Paired with heartbeatTimeoutMs, orchestrator evicts
    // a daemon that misses heartbeats past the timeout. Keep `timeoutMs ≥ 2 ×
    // intervalMs` to tolerate one dropped packet.
    heartbeatIntervalMs: z.coerce.number().int().positive().default(30_000),
    heartbeatTimeoutMs: z.coerce.number().int().positive().default(90_000),

    // How long an execution may sit in status="running" before the watcher treats
    // it as abandoned and marks it failed. Should generally be ≥ agentTimeoutMs
    // so a legitimate long run isn't reaped mid-flight; the built-in default
    // equals agentTimeoutMs (both 3_600_000ms / 60 min), which is the minimum
    // safe setting.
    staleExecutionThresholdMs: z.coerce.number().int().positive().default(3_600_000),

    // Post-SIGTERM window the daemon uses to finish in-flight work before
    // force-exit. The default (300_000ms) is intentionally shorter than
    // agentTimeoutMs, operators who want to guarantee no mid-run kills on
    // graceful shutdown should raise this to ≥ agentTimeoutMs.
    daemonDrainTimeoutMs: z.coerce.number().int().positive().default(300_000),

    // Retries for TRANSIENT daemon dispatch failures only.
    jobMaxRetries: z.coerce.number().int().nonnegative().default(3),

    // How long the orchestrator waits for a daemon in the fleet to claim a
    // job offer before re-queueing it for another daemon to pick up.
    offerTimeoutMs: z.coerce.number().int().positive().default(5_000),

    // Maximum sleep between queue-worker iterations when a leased job has no
    // locally-connected capable daemon and is re-pushed for another instance
    // to claim. Backoff doubles per retry attempt; this caps it.
    queueWorkerBackoffMaxMs: z.coerce.number().int().positive().default(5_000),

    // Cadence of the heartbeat-based liveness reaper (src/orchestrator/
    // liveness-reaper.ts). On each tick the reaper scans Valkey for live
    // orchestrator + daemon heartbeats and fails any in-flight workflow_runs
    // row whose owner heartbeat is missing. Replaces the prior
    // time-threshold daemons reaper (5-minute blind window).
    //
    // Min sane value is the orchestrator heartbeat refresh interval (20s);
    // below that, a heartbeat momentarily not yet republished could trigger
    // a false reap.
    livenessReaperIntervalMs: z.coerce.number().int().min(20_000).default(30_000),

    // Advisory hint REPORTED to the orchestrator after an update signal. The
    // daemon itself always calls initiateGracefulShutdown() regardless of value
    // (src/daemon/main.ts): the orchestrator is the actual consumer.
    daemonUpdateStrategy: z.enum(["exit", "pull", "notify"]).default("exit"),

    // Delay before the daemon initiates shutdown after receiving an update signal.
    // Gives the orchestrator room to drain in-flight offers before the daemon disconnects.
    daemonUpdateDelayMs: z.coerce.number().int().nonnegative().default(0),

    // Minimum free resource gates published in the daemon's heartbeat. The
    // orchestrator refuses to dispatch to a daemon that reports below either floor.
    daemonMemoryFloorMb: z.coerce.number().int().nonnegative().default(512),
    daemonDiskFloorMb: z.coerce.number().int().nonnegative().default(1024),

    // --- 9. Ephemeral daemon (K8s-spawned scale-up) ---

    // When true, this daemon process treats itself as ephemeral: it exits
    // cleanly after `ephemeralDaemonIdleTimeoutMs` of idleness. Set on
    // orchestrator-spawned Pods via `DAEMON_EPHEMERAL=true`; leave unset on
    // persistent daemons.
    daemonEphemeral: z.boolean().default(false),

    // Idle-exit timeout for ephemeral daemons. After this much wall-clock time
    // with zero active jobs, the ephemeral daemon shuts down and the Pod is
    // reclaimed by K8s. Capped below the Pod's default
    // `activeDeadlineSeconds` (3600s = 3_600_000ms, see
    // `src/k8s/ephemeral-daemon-spawner.ts`) minus a 10-minute safety
    // margin so a still-running job cannot be killed by K8s before the
    // idle loop gets a chance to exit gracefully.
    ephemeralDaemonIdleTimeoutMs: z.coerce
      .number()
      .int()
      .positive()
      .max(3_000_000, "EPHEMERAL_DAEMON_IDLE_TIMEOUT_MS must be < 3_000_000 (50 min)")
      .default(120_000),

    // Minimum interval between ephemeral-daemon spawns (orchestrator side).
    // Prevents a burst of events from launching a burst of Pods.
    ephemeralDaemonSpawnCooldownMs: z.coerce.number().int().nonnegative().default(30_000),

    // Queue depth that, when combined with a saturated persistent pool, triggers
    // an overflow spawn. Scaled down for dev / scaled up for fleets with large
    // burst headroom.
    ephemeralDaemonSpawnQueueThreshold: z.coerce.number().int().positive().default(3),

    // K8s namespace into which the orchestrator spawns ephemeral-daemon Pods.
    // The orchestrator's ServiceAccount must hold `create/get/delete` on pods
    // in this namespace.
    ephemeralDaemonNamespace: z.string().default("default"),

    // Container image the orchestrator launches for ephemeral daemons. Should
    // match the tag the persistent daemon Deployment is running. Optional at
    // startup, only required when an ephemeral spawn is actually triggered;
    // the router reports `ephemeral-spawn-failed` if unset.
    daemonImage: z.string().optional(),

    // Public ws:// / wss:// URL the ephemeral daemon uses to reach this
    // orchestrator. Distinct from `orchestratorUrl` (which is the daemon-side
    // dial target when this process is itself a daemon). Optional at startup
    // for the same reason as `daemonImage`.
    orchestratorPublicUrl: z
      .string()
      .optional()
      .refine((value) => {
        if (value === undefined || value === "") return true;
        try {
          const url = new URL(value);
          return url.protocol === "ws:" || url.protocol === "wss:";
        } catch {
          return false;
        }
      }, "ORCHESTRATOR_PUBLIC_URL must be a valid ws:// or wss:// URL"),

    // --- 10. Triage (binary heavy classifier) ---

    // Kill-switch for the triage LLM call. When false, the router skips the call
    // and the scaler sees `heavy === false`.
    triageEnabled: z.boolean().default(true),

    // Model ID for the single-turn triage call via src/ai/llm-client.ts. Affects
    // triage latency/cost only, does NOT change the main agent's model.
    triageModel: z.string().default("sonnet-4-6"),

    // Model ID for the discussion-digest LLM call (src/workflows/discussion-digest.ts).
    // The digest distills the issue/PR comment thread into a guidance summary the
    // structured workflows consume. Sonnet by default: low-hallucination extraction
    // and the reduce-merge precedence logic need the reasoning headroom.
    digestModel: z.string().default("sonnet-4-6"),

    // Strict (1.0) on day 1 so only perfectly confident triage decisions are
    // accepted; below threshold, the scaler falls back to persistent-daemon routing.
    triageConfidenceThreshold: z.coerce.number().min(0).max(1).default(1.0),

    // Cap on the triage JSON response. The response schema is small (~60 tokens),
    // so values much above 100 are waste and only risk letting a malformed
    // response chew budget.
    triageMaxTokens: z.coerce.number().int().positive().default(256),

    // Hard cap per triage LLM call. Beyond this, the call is treated as a
    // failure and the circuit breaker's consecutive-failure counter increments.
    triageTimeoutMs: z.coerce.number().int().positive().default(5_000),

    // Kill-switch for triage's tool-call path (issue #117). When false, triage
    // stays single-turn even on PR events with octokit available: the model
    // classifies from text alone. Operator escape hatch when GitHub API quota
    // pressure or per-event latency tips the cost/benefit. The triage LLM
    // call itself still runs; only the github-state tool surface is suppressed.
    triageToolsEnabled: z.boolean().default(true),

    // Minimum model confidence to accept an intent-classifier verdict. Below
    // this threshold the dispatcher treats the comment as ambiguous and posts
    // a clarification request instead of dispatching (FR-009). 0.75 matches
    // the SC-005 target accuracy band.
    intentConfidenceThreshold: z.coerce.number().min(0).max(1).default(0.75),

    // --- 10a. chat-thread executor (conversational scoped intent) ---

    // Minimum LLM-reported confidence required to dispatch a workflow
    // directly from chat-thread without going through the human-confirm
    // proposal gate. Slightly stricter than intentConfidenceThreshold
    // because chat-thread runs after a second pass with full PR context
    // and is expected to be more sure of itself.
    chatThreadExecuteThreshold: z.coerce.number().min(0).max(1).default(0.8),

    // TTL for awaiting chat-thread proposals. After this point the
    // proposal-poller transitions the row to `expired` and any
    // subsequent reaction is logged-but-ignored.
    chatThreadProposalTtlHours: z.coerce.number().int().positive().default(24),

    // Per-AWAITING-PROPOSAL cap on conversational turns. While a chat
    // proposal is in `awaiting` status, every chat-thread tick on that
    // thread bumps the proposal-row's `turn_count`; once this cap is
    // hit, chat-thread declines further LLM work and tells the user
    // they need to take an explicit action (👍 reaction, decline, or
    // re-ask in a fresh comment). The counter freezes when the
    // proposal exits `awaiting`, so unrelated future chat in the same
    // thread is NOT capped here. This is intentional: the cap exists
    // to bound run-away back-and-forth on a contentious propose-loop,
    // not to limit casual conversation.
    chatThreadMaxTurns: z.coerce.number().int().positive().default(8),

    // Kill-switch for chat-thread's tool-call path (issue #117). When false,
    // chat-thread stays single-turn: the model answers from the cached
    // <conversation> snapshot only and cannot fetch fresh CI rollup,
    // check output, branch protection, diff, file list, or paginated
    // comments. Operator escape hatch for cost containment or when the
    // github-state subprocess is misbehaving. The chat-thread LLM call
    // itself still runs.
    chatThreadToolsEnabled: z.boolean().default(true),

    // --- 10b. LLM-based output scanner (defense layer 4) ---

    // When true, run a second-pass LLM scan on every agent-generated body
    // about to be posted to GitHub (after the regex pass in
    // `src/utils/sanitize.ts redactSecrets`). Catches encoded/obfuscated
    // secrets that escape the deterministic patterns. Default ON; flip OFF
    // if Bedrock latency or cost is unacceptable for the deployment.
    llmOutputScannerEnabled: z.boolean().default(true),

    // Model alias for the scanner call. Sonnet 4.6 by default, the
    // higher-reasoning model materially reduces false-negatives on
    // obfuscated/encoded secrets vs. Haiku, at the cost of per-call latency.
    // Operators can downgrade to a Haiku alias if budget pressure dominates.
    llmOutputScannerModel: z.string().default("sonnet-4-6"),

    // Hard cap per scanner call. Treated as a fail-open failure (post body
    // that survived the regex pass, log a warn) when exceeded.
    llmOutputScannerTimeoutMs: z.coerce.number().int().positive().default(3_000),

    // --- 11. Agent maxTurns ---

    // Optional turn cap. Unset by default so workflows run end-to-end without
    // losing progress to a mid-run cap. Set DEFAULT_MAXTURNS only when ops
    // needs a hard ceiling. AGENT_MAX_TURNS overrides this when both are set.
    defaultMaxTurns: z.coerce.number().int().positive().optional(),

    // --- 12. Composite ship review/resolve loop ---

    // Maximum review iterations inside ship's review/resolve cycle. Each
    // iteration is one review run; a clean review (findings == 0) after at
    // least 2 iterations short-circuits the loop. When the cap is reached
    // with non-zero findings still flagged by the most recent review, the
    // ship parent terminates with status=succeeded but its tracking comment
    // recommends a manual re-review. Range: 1–5; default 2.
    reviewResolveMaxIterations: z.coerce.number().int().min(1).max(5).default(2),

    // --- 12a. Prompt cache layout (issue #134) ---

    // Selects the system/user prompt split passed to the Claude Agent SDK.
    // `legacy` (default): single user-role string; system prompt is the
    //   `claude_code` preset with dynamic sections (cwd, platform, shell, OS)
    //   embedded. Because `cwd` is unique per delivery (per-event mkdtemp), the
    //   system-prompt prefix is unique per job and the Anthropic prompt cache
    //   misses on every invocation.
    // `cacheable`: lifts the static scaffolding (security_directive,
    //   freshness_directive, workflow steps, commit/CAPABILITIES boilerplate)
    //   into `systemPrompt.append` and sets `excludeDynamicSections: true`, so
    //   the system-prompt prefix is byte-identical across jobs of the same
    //   shape and is reused via the prompt cache. The user-role message keeps
    //   only the per-call dynamic blocks (formatted_context, untrusted_*,
    //   per-call metadata). Flip after verifying non-zero
    //   `cacheReadInputTokens` in the executor completion log.
    promptCacheLayout: z.enum(["legacy", "cacheable"]).default("legacy"),

    // --- 13. Ship workflow (PR shepherding to merge-ready, feature 20260427-201332) ---

    // Wall-clock ceiling for a single `bot:ship` session: the maximum the
    // shepherding loop may run end-to-end (across continuations and waits)
    // before transitioning the intent to `deadline_exceeded`. Accepts either
    // a plain integer (milliseconds) or a duration string with `h`/`m`/`s`
    // suffix (e.g., `4h`, `30m`, `90s`, fractional `1.5h`). Default 4h.
    // Per-invocation `--deadline` overrides on the literal `bot:ship` command
    // are validated against this ceiling by `src/workflows/ship/literal-command.ts`.
    maxWallClockPerShipRun: durationMs.default(14_400_000),

    // Iteration-count cap (FR-012). The shepherding loop checks this at the
    // start of each iteration BEFORE the probe runs; on hit, the intent
    // transitions to `human_took_over` with `BlockerCategory='iteration-cap'`.
    // Pairs with `MAX_WALL_CLOCK_PER_SHIP_RUN`, whichever fires first wins.
    maxShipIterations: z.coerce.number().int().positive().default(50),

    // Cron tickle cadence, how often `src/workflows/ship/tickle-scheduler.ts`
    // scans Valkey `ship:tickle` for due continuations and re-enqueues them
    // as daemon jobs. Lower values reduce wake latency at the cost of
    // background CPU. Default 15s.
    cronTickleIntervalMs: z.coerce.number().int().positive().default(15_000),

    // Bounded backoff schedule for GitHub `mergeable=null` (FR-021). When
    // the GraphQL `mergeable` field returns null (GitHub still computing
    // mergeability), the probe re-polls with intervals from this list.
    // On schedule exhaustion the verdict is `mergeable_pending` and the
    // session yields per FR-020: it MUST NOT terminate. Default
    // `5000,10000,30000,60000,60000` (≈ 2m45s total).
    mergeableNullBackoffMsList: mergeableBackoffList,

    // Single global safety margin for the reviewer-latency barrier
    // (FR-023). When no non-bot review has been observed on the current
    // head SHA, the barrier defers `ready` until at least this much time
    // has elapsed since the most recent push. The system MUST NOT carry a
    // reviewer-login list anywhere: this single-knob design is intentional
    // (research.md R3). Default 20 minutes.
    reviewBarrierSafetyMarginMs: z.coerce.number().int().positive().default(1_200_000),

    // Per-(intent, signature) cap on resolve/review fix attempts
    // (FR-013). Once the count reaches this value for a derived
    // signature, the next attempt halts with `BlockerCategory='flake-cap'`.
    // Backed by the `ship_fix_attempts` table (T039).
    fixAttemptsPerSignatureCap: z.coerce.number().int().positive().default(3),

    // Comma-separated list of branch names the bot must refuse to shepherd
    // against (FR-015 eligibility gate). Empty list (default) imposes no
    // branch restriction beyond the standard owner/fork/state checks.
    // Example: `main,master,release` blocks `bot:ship` against any of
    // those target branches; the maintainer-facing rejection message
    // surfaces the offending branch name.
    shipForbiddenTargetBranches: shipForbiddenTargetBranchesField,

    // --- 14. Scheduled actions (.github-app.yaml) ---

    // Master kill-switch for the scheduled-actions scheduler
    // (src/scheduler/). When false (default) the scheduler never starts:
    // no installation enumeration, no config fetch, no jobs enqueued.
    // Server mode only; a daemon process ignores it.
    schedulerEnabled: z.boolean().default(false),

    // Cadence of the scheduler scan. On each tick the scheduler
    // enumerates installations, fetches each repo's `.github-app.yaml`,
    // and enqueues any action whose cron slot is due. A value outside
    // [60s, 1h] is rejected at startup: below 60s the per-tick GitHub API
    // cost is not worth it; above 1h cron precision degrades. Default 5m.
    schedulerScanIntervalMs: z.coerce.number().int().min(60_000).max(3_600_000).default(300_000),

    // Gate for the bot-provided `merge_readiness` MCP tool. The tool is
    // exposed to a scheduled action only when this is true AND the action
    // sets `auto_merge: true`. NOTE: this does not sandbox the agent from
    // merging by other means: `allowed_tools` is owner-trusted config, so an
    // action granted a merge-capable tool (e.g. `Bash(gh pr merge:*)`) can
    // still merge. This switch governs the deterministic readiness tool, not
    // every possible merge path.
    schedulerAllowAutoMerge: z.boolean().default(false),

    // Filename the scheduler reads from each installed repo's default
    // branch root. Default `.github-app.yaml`.
    schedulerConfigFile: z.string().default(".github-app.yaml"),
  })
  .superRefine((data, ctx) => {
    validateServerModeCredentials(data, ctx);
    validateProviderCredentials(data, ctx);
    validateDataLayerConfig(data, ctx);
  })
  // Runs only if .superRefine added no issues, so by this point:
  //   - provider=bedrock guarantees data.model is defined
  //     (validateProviderCredentials errors otherwise)
  //   - provider=anthropic falls through with data.model possibly undefined
  // We default the anthropic branch to Opus 4.7 here. Doing it in .transform
  // narrows the inferred Config type: `model` becomes `string`, not
  // `string | undefined`, so downstream code drops the defensive `?.` / `??`.
  // Override via CLAUDE_MODEL when cost-sensitive.
  .transform((data) => ({
    ...data,
    model: data.model ?? "claude-opus-4-7",
  }));

/**
 * Validate GitHub App credentials are present in server mode.
 * Daemon mode (ORCHESTRATOR_URL set) does not require these.
 */
function validateServerModeCredentials(
  data: {
    orchestratorUrl?: string | undefined;
    appId?: string | undefined;
    privateKey?: string | undefined;
    webhookSecret?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const isDaemonMode = (data.orchestratorUrl?.trim().length ?? 0) > 0;
  if (isDaemonMode) return;

  if ((data.appId?.trim().length ?? 0) === 0) {
    ctx.addIssue({
      code: "custom",
      message: "GITHUB_APP_ID is required in server mode (when ORCHESTRATOR_URL is not set)",
      path: ["appId"],
    });
  }
  if ((data.privateKey?.trim().length ?? 0) === 0) {
    ctx.addIssue({
      code: "custom",
      message:
        "GITHUB_APP_PRIVATE_KEY is required in server mode (when ORCHESTRATOR_URL is not set)",
      path: ["privateKey"],
    });
  }
  if ((data.webhookSecret?.trim().length ?? 0) === 0) {
    ctx.addIssue({
      code: "custom",
      message:
        "GITHUB_WEBHOOK_SECRET is required in server mode (when ORCHESTRATOR_URL is not set)",
      path: ["webhookSecret"],
    });
  }
}

/**
 * Validate provider-specific credentials.
 * Anthropic requires API key or OAuth token; Bedrock requires region and model.
 */
function validateProviderCredentials(
  data: {
    provider: string;
    anthropicApiKey?: string | undefined;
    claudeCodeOauthToken?: string | undefined;
    awsRegion?: string | undefined;
    model?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (data.provider === "anthropic") {
    const hasApiKey = (data.anthropicApiKey?.trim().length ?? 0) > 0;
    const hasOauthToken = (data.claudeCodeOauthToken?.trim().length ?? 0) > 0;
    if (!hasApiKey && !hasOauthToken) {
      ctx.addIssue({
        code: "custom",
        message:
          "When CLAUDE_PROVIDER=anthropic, either ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is required.",
        path: ["anthropicApiKey"],
      });
    }
  } else {
    if (data.awsRegion === undefined || data.awsRegion === "") {
      ctx.addIssue({
        code: "custom",
        message: "AWS_REGION is required when CLAUDE_PROVIDER=bedrock",
        path: ["awsRegion"],
      });
    }
    if (data.model === undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "CLAUDE_MODEL is required when CLAUDE_PROVIDER=bedrock (e.g. us.anthropic.claude-sonnet-4-6)",
        path: ["model"],
      });
    }
  }
}

/**
 * After the dispatch-to-daemon collapse, every server-mode process needs
 * the data layer (DB + Valkey + DAEMON_AUTH_TOKEN) to orchestrate the
 * daemon fleet. Daemon-mode processes only need DAEMON_AUTH_TOKEN for the
 * WebSocket handshake.
 */
function validateDataLayerConfig(
  data: {
    orchestratorUrl?: string | undefined;
    databaseUrl?: string | undefined;
    valkeyUrl?: string | undefined;
    daemonAuthToken?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const isDaemonMode = (data.orchestratorUrl?.trim().length ?? 0) > 0;

  if ((data.daemonAuthToken?.trim().length ?? 0) === 0) {
    ctx.addIssue({
      code: "custom",
      message: "DAEMON_AUTH_TOKEN is required (set on both orchestrator and daemon)",
      path: ["daemonAuthToken"],
    });
  }

  if (isDaemonMode) return;

  if ((data.databaseUrl?.trim().length ?? 0) === 0) {
    ctx.addIssue({
      code: "custom",
      message: "DATABASE_URL is required in server mode",
      path: ["databaseUrl"],
    });
  }
  if ((data.valkeyUrl?.trim().length ?? 0) === 0) {
    ctx.addIssue({
      code: "custom",
      message: "VALKEY_URL is required in server mode",
      path: ["valkeyUrl"],
    });
  }
}

export type Config = z.infer<typeof configSchema>;

// Export schema for use in tests (avoids importing the singleton which runs loadConfig())
export { configSchema };

/**
 * ToS guard: CLAUDE_CODE_OAUTH_TOKEN is a personal Max/Pro subscription credential.
 * The Agent SDK Note prohibits serving other users' repos from that quota, so OAuth
 * mode requires an owner allowlist as a hard startup precondition: not just a
 * documentation warning. API-key deployments remain unrestricted (in-policy for
 * pay-as-you-go). See https://code.claude.com/docs/en/agent-sdk/overview
 *
 * Lives outside `.superRefine` so the schema stays lean and the policy rule is
 * expressed as one clear assertion: exported so tests can exercise it directly
 * against a parsed `Config` without round-tripping env vars.
 */
export function assertOauthRequiresAllowlist(cfg: Config): void {
  if (
    cfg.provider === "anthropic" &&
    (cfg.claudeCodeOauthToken?.trim().length ?? 0) > 0 &&
    cfg.allowedOwners?.length !== 1
  ) {
    throw new Error(
      "ALLOWED_OWNERS must contain exactly one owner when CLAUDE_CODE_OAUTH_TOKEN is set. " +
        "See https://code.claude.com/docs/en/agent-sdk/overview",
    );
  }
}

/**
 * Single-tenant guard for GITHUB_PERSONAL_ACCESS_TOKEN. A PAT inherits the
 * full identity of one human and their rate-limit bucket: exposing it across
 * multiple owners' webhooks would impersonate that human on every install.
 * Hard-fail at startup so the misconfiguration cannot reach a webhook handler.
 */
export function assertPatRequiresAllowlist(cfg: Config): void {
  if ((cfg.githubPersonalAccessToken?.trim().length ?? 0) > 0 && cfg.allowedOwners?.length !== 1) {
    throw new Error(
      "ALLOWED_OWNERS must contain exactly one owner when GITHUB_PERSONAL_ACCESS_TOKEN is set.",
    );
  }
}

/**
 * Parse a boolean environment variable strictly.
 * Accepts: true/false, 1/0, yes/no (case-insensitive).
 * Throws on unrecognized values to prevent silent misconfiguration.
 */
export function parseBooleanEnv(name: string, raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();

  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;

  throw new Error(`${name} must be one of: true, false, 1, 0, yes, no. Got: ${raw}`);
}

/**
 * Parse and validate config from environment variables.
 * Throws on invalid/missing required values -- fail fast at startup.
 */
function loadConfig(): Config {
  const cfg = configSchema.parse({
    // Group 1, GitHub App credentials
    appId: process.env["GITHUB_APP_ID"],
    // Normalize literal "\n" escape sequences to real newlines. K8s Secrets
    // populated from SETUP.md's single-line `"---BEGIN---\n...\n---END---"`
    // pattern decode to bytes that contain backslash+n, not 0x0a, which
    // trips Node's createPrivateKey with ERR_OSSL_BAD_END_LINE (issue #7).
    // Idempotent: real newlines do not match /\\n/.
    privateKey: process.env["GITHUB_APP_PRIVATE_KEY"]?.replace(/\\n/g, "\n"),
    webhookSecret: process.env["GITHUB_WEBHOOK_SECRET"],

    // Group 2, AI provider selection
    provider: process.env["CLAUDE_PROVIDER"],
    model: process.env["CLAUDE_MODEL"],

    // Group 3, Anthropic direct-API credentials
    anthropicApiKey: process.env["ANTHROPIC_API_KEY"],
    claudeCodeOauthToken: process.env["CLAUDE_CODE_OAUTH_TOKEN"],
    githubPersonalAccessToken: process.env["GITHUB_PERSONAL_ACCESS_TOKEN"],

    // Group 4, AWS Bedrock credentials
    awsRegion: process.env["AWS_REGION"],
    awsProfile: process.env["AWS_PROFILE"],
    awsAccessKeyId: process.env["AWS_ACCESS_KEY_ID"],
    awsSecretAccessKey: process.env["AWS_SECRET_ACCESS_KEY"],
    awsSessionToken: process.env["AWS_SESSION_TOKEN"],
    awsBearerTokenBedrock: process.env["AWS_BEARER_TOKEN_BEDROCK"],
    anthropicBedrockBaseUrl: process.env["ANTHROPIC_BEDROCK_BASE_URL"],

    // Group 5, App runtime / behaviour
    context7ApiKey: process.env["CONTEXT7_API_KEY"],
    cloneBaseDir: process.env["CLONE_BASE_DIR"],
    cloneDepth: process.env["CLONE_DEPTH"],
    triggerPhrase: process.env["TRIGGER_PHRASE"],
    botAppLogin: process.env["BOT_APP_LOGIN"],
    port: process.env["PORT"],
    logLevel: process.env["LOG_LEVEL"],
    nodeEnv: process.env.NODE_ENV,
    maxConcurrentRequests: process.env["MAX_CONCURRENT_REQUESTS"],
    maxFetchedComments: process.env["MAX_FETCHED_COMMENTS"],
    maxFetchedReviews: process.env["MAX_FETCHED_REVIEWS"],
    maxFetchedReviewComments: process.env["MAX_FETCHED_REVIEW_COMMENTS"],
    maxFetchedFiles: process.env["MAX_FETCHED_FILES"],
    agentTimeoutMs: process.env["AGENT_TIMEOUT_MS"],
    agentMaxTurns: process.env["AGENT_MAX_TURNS"],
    claudeCodePath: process.env["CLAUDE_CODE_PATH"],
    allowedOwners: process.env["ALLOWED_OWNERS"],

    // Group 6, Data layer
    valkeyUrl: process.env["VALKEY_URL"],
    databaseUrl: process.env["DATABASE_URL"],

    // Group 7, Orchestrator
    wsPort: process.env["WS_PORT"],

    // Group 8, Daemon / Orchestrator WebSocket
    daemonAuthToken: process.env["DAEMON_AUTH_TOKEN"],
    daemonAuthTokenPrevious: process.env["DAEMON_AUTH_TOKEN_PREVIOUS"],
    orchestratorUrl: process.env["ORCHESTRATOR_URL"],
    heartbeatIntervalMs: process.env["HEARTBEAT_INTERVAL_MS"],
    heartbeatTimeoutMs: process.env["HEARTBEAT_TIMEOUT_MS"],
    staleExecutionThresholdMs: process.env["STALE_EXECUTION_THRESHOLD_MS"],
    daemonDrainTimeoutMs: process.env["DAEMON_DRAIN_TIMEOUT_MS"],
    jobMaxRetries: process.env["JOB_MAX_RETRIES"],
    offerTimeoutMs: process.env["OFFER_TIMEOUT_MS"],
    queueWorkerBackoffMaxMs: process.env["QUEUE_WORKER_BACKOFF_MAX_MS"],
    livenessReaperIntervalMs: process.env["LIVENESS_REAPER_INTERVAL_MS"],
    daemonUpdateStrategy: process.env["DAEMON_UPDATE_STRATEGY"],
    daemonUpdateDelayMs: process.env["DAEMON_UPDATE_DELAY_MS"],
    daemonMemoryFloorMb: process.env["DAEMON_MEMORY_FLOOR_MB"],
    daemonDiskFloorMb: process.env["DAEMON_DISK_FLOOR_MB"],

    // Group 9, Ephemeral daemon (K8s-spawned scale-up)
    daemonEphemeral: parseBooleanEnv("DAEMON_EPHEMERAL", process.env["DAEMON_EPHEMERAL"]),
    ephemeralDaemonIdleTimeoutMs: process.env["EPHEMERAL_DAEMON_IDLE_TIMEOUT_MS"],
    ephemeralDaemonSpawnCooldownMs: process.env["EPHEMERAL_DAEMON_SPAWN_COOLDOWN_MS"],
    ephemeralDaemonSpawnQueueThreshold: process.env["EPHEMERAL_DAEMON_SPAWN_QUEUE_THRESHOLD"],
    ephemeralDaemonNamespace: process.env["EPHEMERAL_DAEMON_NAMESPACE"],
    daemonImage: process.env["DAEMON_IMAGE"],
    orchestratorPublicUrl: process.env["ORCHESTRATOR_PUBLIC_URL"],

    // Group 10, Triage, strict boolean parsing; rejects unrecognized values at startup.
    triageEnabled: parseBooleanEnv("TRIAGE_ENABLED", process.env["TRIAGE_ENABLED"]),
    triageToolsEnabled: parseBooleanEnv(
      "TRIAGE_TOOLS_ENABLED",
      process.env["TRIAGE_TOOLS_ENABLED"],
    ),
    triageModel: process.env["TRIAGE_MODEL"],
    digestModel: process.env["DISCUSSION_DIGEST_MODEL"],
    triageConfidenceThreshold: process.env["TRIAGE_CONFIDENCE_THRESHOLD"],
    triageMaxTokens: process.env["TRIAGE_MAX_TOKENS"],
    triageTimeoutMs: process.env["TRIAGE_TIMEOUT_MS"],
    intentConfidenceThreshold: process.env["INTENT_CONFIDENCE_THRESHOLD"],

    // Group 10a, chat-thread executor
    chatThreadExecuteThreshold: process.env["CHAT_THREAD_EXECUTE_THRESHOLD"],
    chatThreadProposalTtlHours: process.env["CHAT_THREAD_PROPOSAL_TTL_HOURS"],
    chatThreadMaxTurns: process.env["CHAT_THREAD_MAX_TURNS"],
    chatThreadToolsEnabled: parseBooleanEnv(
      "CHAT_THREAD_TOOLS_ENABLED",
      process.env["CHAT_THREAD_TOOLS_ENABLED"],
    ),

    // Group 10b, LLM-based output scanner
    llmOutputScannerEnabled: parseBooleanEnv(
      "LLM_OUTPUT_SCANNER_ENABLED",
      process.env["LLM_OUTPUT_SCANNER_ENABLED"],
    ),
    llmOutputScannerModel: process.env["LLM_OUTPUT_SCANNER_MODEL"],
    llmOutputScannerTimeoutMs: process.env["LLM_OUTPUT_SCANNER_TIMEOUT_MS"],

    // Group 11, Agent maxTurns
    defaultMaxTurns: process.env["DEFAULT_MAXTURNS"],

    // Group 12, Composite ship review/resolve loop
    reviewResolveMaxIterations: process.env["REVIEW_RESOLVE_MAX_ITERATIONS"],

    // Group 12a, Prompt cache layout
    promptCacheLayout: process.env["PROMPT_CACHE_LAYOUT"],

    // Group 13, Ship workflow (PR shepherding to merge-ready)
    maxWallClockPerShipRun: process.env["MAX_WALL_CLOCK_PER_SHIP_RUN"],
    maxShipIterations: process.env["MAX_SHIP_ITERATIONS"],
    cronTickleIntervalMs: process.env["CRON_TICKLE_INTERVAL_MS"],
    mergeableNullBackoffMsList: process.env["MERGEABLE_NULL_BACKOFF_MS_LIST"],
    reviewBarrierSafetyMarginMs: process.env["REVIEW_BARRIER_SAFETY_MARGIN_MS"],
    fixAttemptsPerSignatureCap: process.env["FIX_ATTEMPTS_PER_SIGNATURE_CAP"],
    shipForbiddenTargetBranches: process.env["SHIP_FORBIDDEN_TARGET_BRANCHES"],

    // Group 14, Scheduled actions
    schedulerEnabled: parseBooleanEnv("SCHEDULER_ENABLED", process.env["SCHEDULER_ENABLED"]),
    schedulerScanIntervalMs: process.env["SCHEDULER_SCAN_INTERVAL_MS"],
    schedulerAllowAutoMerge: parseBooleanEnv(
      "SCHEDULER_ALLOW_AUTO_MERGE",
      process.env["SCHEDULER_ALLOW_AUTO_MERGE"],
    ),
    schedulerConfigFile: process.env["SCHEDULER_CONFIG_FILE"],
  });

  assertOauthRequiresAllowlist(cfg);
  assertPatRequiresAllowlist(cfg);

  if ((cfg.githubPersonalAccessToken?.trim().length ?? 0) > 0) {
    console.warn(
      "[config] GITHUB_PERSONAL_ACCESS_TOKEN is set, bypassing GitHub App installation token. " +
        "All GitHub API and git operations will run as the PAT owner. " +
        "Single-tenant only (ALLOWED_OWNERS enforced).",
    );
  }

  // H6: Warn when WebSocket URLs use unencrypted ws:// in production.
  // Installation tokens and DAEMON_AUTH_TOKEN are transmitted over this connection.
  if (cfg.nodeEnv === "production") {
    if (cfg.orchestratorUrl?.startsWith("ws://") === true) {
      console.warn(
        "[config] WARNING: ORCHESTRATOR_URL uses ws:// (unencrypted) in production. " +
          "Installation tokens and DAEMON_AUTH_TOKEN are transmitted in cleartext. Use wss:// for production.",
      );
    }
  }

  // H7 (issue #102, defense layer 1b): warn when orchestrator-only secrets
  // are present in a daemon process. The Helm chart should mount only
  // `daemon-secrets` on daemon Pods; `orchestrator-secrets` (App private
  // key, webhook secret, DB / Valkey URLs) belong on the orchestrator Pod
  // alone. A misconfigured deployment that mounts both bundles wouldn't
  // crash, the daemon doesn't read these keys, but it weakens the
  // capability-minimization gate in `buildProviderEnv()` (the agent
  // subprocess can no longer leak them simply because they aren't there).
  // Warn only, never refuse to start, since a downed daemon is worse than
  // a degraded security posture.
  //
  // Detection heuristic: only daemons set `ORCHESTRATOR_URL` (they connect
  // TO the orchestrator) or `DAEMON_EPHEMERAL`. The orchestrator/webhook
  // server has neither set so the warn won't fire there. Local-dev setups
  // that share a single `.env` between both processes will fire spuriously
  //, accepted noise; split the file to silence.
  //
  // `console.warn` (not pino) on purpose: config loads before the logger is
  // built, so this is the only available channel at this point.
  const isDaemonProcess = (cfg.orchestratorUrl?.trim().length ?? 0) > 0 || cfg.daemonEphemeral;
  if (isDaemonProcess) {
    const leakedKeys: string[] = [];
    if ((process.env["GITHUB_APP_PRIVATE_KEY"]?.trim().length ?? 0) > 0)
      leakedKeys.push("GITHUB_APP_PRIVATE_KEY");
    if ((process.env["GITHUB_WEBHOOK_SECRET"]?.trim().length ?? 0) > 0)
      leakedKeys.push("GITHUB_WEBHOOK_SECRET");
    if ((process.env["DATABASE_URL"]?.trim().length ?? 0) > 0) leakedKeys.push("DATABASE_URL");
    if ((process.env["VALKEY_URL"]?.trim().length ?? 0) > 0) leakedKeys.push("VALKEY_URL");
    if ((process.env["REDIS_URL"]?.trim().length ?? 0) > 0) leakedKeys.push("REDIS_URL");
    if (leakedKeys.length > 0) {
      console.warn(
        `[config] WARNING: orchestrator-only secret(s) present on daemon process: ${leakedKeys.join(", ")}. ` +
          "Mount these only via `orchestrator-secrets` on the orchestrator Pod; the daemon does not need them. " +
          "See docs/operate/configuration.md for the K8s Secret split contract.",
      );
    }
  }

  return cfg;
}

export const config = loadConfig();
