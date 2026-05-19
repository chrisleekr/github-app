import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import { config } from "../config";
import type { BotContext, ExecutionResult, McpServerConfig } from "../types";
import { redactSecrets } from "../utils/sanitize";

function isResultMessage(msg: unknown): msg is SDKResultMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "type" in msg &&
    (msg as { type: unknown }).type === "result"
  );
}

/**
 * Build the subprocess environment for the Claude Code CLI.
 *
 * Spreads the current process.env so all inherited variables (AWS_PROFILE,
 * AWS_WEB_IDENTITY_TOKEN_FILE for IRSA, etc.) flow through automatically.
 * For Bedrock, injects CLAUDE_CODE_USE_BEDROCK=1 which the CLI binary reads
 * to switch from the Anthropic API to the Bedrock runtime endpoint.
 * We avoid mutating process.env directly so the main process stays unaffected.
 *
 * Anthropic credentials (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, etc.) are
 * forwarded as part of the `...process.env` spread: no explicit handling here.
 * The Claude CLI subprocess picks between them via its own documented auth
 * precedence chain (API key at position 3 beats OAuth token at position 5).
 * See https://code.claude.com/docs/en/authentication#authentication-precedence
 *
 * When `installationToken` is supplied, it is exported as both `GH_TOKEN` and
 * `GITHUB_TOKEN` so the agent's shell `gh`/`git` calls authenticate as the
 * GitHub App installation. MCP servers receive the same token via their own
 * env mapping in `src/mcp/registry.ts`.
 */
// Capability minimization for the agent subprocess (issue #102). Default
// behavior used to be `...process.env` spread, which forwarded every secret
// the daemon process holds (App private key, DB URL, daemon auth token, …)
// to the Claude Code CLI subprocess, where a successful prompt injection
// could exfiltrate them. This allowlist + denylist replaces the spread:
// only enumerated keys (or keys matching an allowlisted prefix) reach the
// subprocess; explicit deny-keys/prefixes are stripped even when they would
// otherwise match a prefix.
const ENV_ALLOW_KEYS = new Set<string>([
  // Process basics
  "HOME",
  "PATH",
  "USER",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  // Node/Bun runtime
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_NO_WARNINGS",
  "NODE_EXTRA_CA_CERTS",
  // Custom CA bundles
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // Outbound HTTP proxy (uppercase + lowercase variants honored by curl/Node)
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  // Locale / TTY hints
  "NO_COLOR",
  "FORCE_COLOR",
  "TERM",
  "COLORTERM",
  "CI",
  // GitHub auth surface for `gh`/`git` inside the agent: the actual values
  // are typically injected from `installationToken` below; pass-through here
  // matters only for local dev where the operator pre-sets one.
  "GH_TOKEN",
  "GITHUB_TOKEN",
]);

// Prefix allowlist, forward-compatible coverage for env knobs that vendors
// keep adding (Claude Code CLI flags, Anthropic SDK config, AWS chain extras,
// git config). Sensitive overlaps (GITHUB_APP_*, GITHUB_WEBHOOK_*) are
// stripped by the deny-prefix list below.
const ENV_ALLOW_PREFIXES = ["CLAUDE_CODE_", "ANTHROPIC_", "AWS_", "GIT_", "GH_"];

const ENV_DENY_KEYS = new Set<string>([
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "DAEMON_AUTH_TOKEN",
  "DAEMON_AUTH_TOKEN_PREVIOUS",
  "DATABASE_URL",
  "VALKEY_URL",
  "REDIS_URL",
  "CONTEXT7_API_KEY",
]);

const ENV_DENY_PREFIXES = ["GITHUB_APP_", "GITHUB_WEBHOOK_"];

function isEnvKeyAllowed(key: string): boolean {
  if (ENV_DENY_KEYS.has(key)) return false;
  for (const prefix of ENV_DENY_PREFIXES) {
    if (key.startsWith(prefix)) return false;
  }
  if (ENV_ALLOW_KEYS.has(key)) return true;
  for (const prefix of ENV_ALLOW_PREFIXES) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

export function buildProviderEnv(
  installationToken?: string,
  artifactsDir?: string,
): Record<string, string | undefined> {
  // Strip empty values too: the CLI's auth precedence chain (ANTHROPIC_API_KEY
  // at position 3 beats CLAUDE_CODE_OAUTH_TOKEN at position 5) treats an empty
  // string as a present-but-blank credential and selects it, blocking the real
  // token. Generic blank-stripping protects every credential, not just those
  // two. Common cause: `envFrom: secretRef` over a Secret with a stale empty
  // key.
  const isBlank = (v: string | undefined): boolean => typeof v === "string" && v.trim() === "";
  const baseEnv: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => isEnvKeyAllowed(key) && !isBlank(value)),
  );
  const tokenEnv: Record<string, string> =
    installationToken !== undefined && installationToken !== ""
      ? { GH_TOKEN: installationToken, GITHUB_TOKEN: installationToken }
      : {};
  // Sibling scratch dir for agent-authored summaries. Exposed so the
  // implement/review/resolve prompts can reference $BOT_ARTIFACT_DIR
  // without leaking the path into commits inside the cloned repo.
  const artifactEnv: Record<string, string> =
    artifactsDir !== undefined && artifactsDir !== "" ? { BOT_ARTIFACT_DIR: artifactsDir } : {};
  if (config.provider === "bedrock") {
    return { ...baseEnv, ...tokenEnv, ...artifactEnv, CLAUDE_CODE_USE_BEDROCK: "1" };
  }
  return { ...baseEnv, ...tokenEnv, ...artifactEnv };
}

/**
 * Execute Claude Agent SDK with the built prompt and MCP servers.
 * The SDK streams messages; we collect them for result metadata.
 *
 * Ported from claude-code-action's base-action/src/run-claude-sdk.ts
 * Per Agent SDK docs: https://platform.claude.com/docs/en/agent-sdk/quickstart
 *
 * Key difference: we pass `cwd` pointing to the cloned repo directory
 * so Claude's file tools (Read/Write/Edit/Glob/Grep/LS) operate on real local files.
 */
export interface ExecuteAgentParams {
  ctx: BotContext;
  prompt: string;
  mcpServers: McpServerConfig;
  workDir: string;
  /**
   * Sibling scratch directory for agent-authored summary files (IMPLEMENT.md,
   * REVIEW.md, RESOLVE.md). Exported to the agent subprocess as
   * `BOT_ARTIFACT_DIR`. Lives outside `workDir` so the agent cannot
   * accidentally `git add` these files.
   */
  artifactsDir?: string;
  allowedTools: string[];
  maxTurns?: number;
  installationToken?: string;
  /**
   * Optional caller-supplied abort signal. When aborted, the SDK `query()`
   * iterator is torn down (via the controller plumbed into `queryOptions`),
   * the Claude Code subprocess and MCP servers exit, and `executeAgent`
   * resolves with `success: false`. The wall-clock timeout is implemented
   * by the same mechanism, so an external abort short-circuits the timer.
   */
  signal?: AbortSignal;
  /**
   * When `config.promptCacheLayout === "cacheable"` and this field is set,
   * the executor pivots to the cache-friendly SDK shape:
   *   - systemPrompt = { type: "preset", preset: "claude_code",
   *                      append, excludeDynamicSections: true }
   *   - prompt       = userMessage
   * `append` is a byte-stable scaffolding the prompt cache can hit across
   * invocations; `userMessage` carries every per-call dynamic value. When
   * either condition is unmet, the executor falls back to the legacy single-
   * string path using `prompt` and the bare preset systemPrompt.
   */
  promptParts?: { append: string; userMessage: string };
  /**
   * Per-call model override. Falls back to `config.model` when omitted.
   * Used by the scheduled-actions executor to honour a per-action `model:`
   * declared in `.github-app.yaml`.
   */
  model?: string;
}

export async function executeAgent({
  ctx,
  prompt,
  mcpServers,
  workDir,
  artifactsDir,
  allowedTools,
  maxTurns,
  installationToken,
  signal,
  promptParts,
  model,
}: ExecuteAgentParams): Promise<ExecutionResult> {
  const { log } = ctx;

  // Pivot to the cacheable systemPrompt shape only when both: the operator
  // opted in via PROMPT_CACHE_LAYOUT=cacheable AND the caller threaded a
  // split prompt through `promptParts`. Either condition unmet → legacy path.
  // Callers that haven't migrated yet keep working byte-for-byte.
  const useCacheableLayout = config.promptCacheLayout === "cacheable" && promptParts !== undefined;

  log.info(
    {
      workDir,
      mcpServerCount: Object.keys(mcpServers).length,
      provider: config.provider,
      configModel: config.model,
      configPermissionMode: "bypassPermissions",
      allowedToolsCount: allowedTools.length,
      promptCacheLayout: useCacheableLayout ? "cacheable" : "legacy",
    },
    "Starting Claude Agent SDK execution",
  );

  const startTime = Date.now();
  let result: SDKResultMessage | undefined;

  // Cancellation controller plumbed into the SDK so the wall-clock timer and
  // any caller-supplied AbortSignal actually tear down the `query()` async
  // iterator (and the underlying Claude Code subprocess + MCP servers).
  // Without this, the SDK keeps streaming tokens and writing to the workspace
  // long after `executeAgent` returns, see issue #16.
  const controller = new AbortController();
  const onCallerAbort = (): void => {
    controller.abort(signal?.reason);
  };
  if (signal !== undefined) {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      signal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  // Build query options. model and maxTurns are only included when set
  // (exactOptionalPropertyTypes forbids assigning undefined to optional
  // properties). When maxTurns is omitted entirely, the SDK runs the agent
  // to completion, that's the default we want for end-to-end workflows.
  const queryOptions: Parameters<typeof query>[0]["options"] = {
    cwd: workDir,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    allowedTools,
    // ToolSearch enumerates only deferred (lazily-loaded) tools. Opus 4.7
    // misreads its output as the authoritative tool catalog, then concludes
    // that eagerly-loaded MCP tools (mcp__github_inline_comment__*,
    // mcp__github_comment__*) are unavailable and silently downgrades to a
    // single fat tracking-comment dump. Block it so the model uses the eager
    // tool list delivered in the SDK init message instead.
    disallowedTools: ["ToolSearch"],
    mcpServers,
    systemPrompt:
      useCacheableLayout && promptParts !== undefined
        ? {
            type: "preset",
            preset: "claude_code",
            append: promptParts.append,
            excludeDynamicSections: true,
          }
        : { type: "preset", preset: "claude_code" },
    env: buildProviderEnv(installationToken, artifactsDir),
    abortController: controller,
    // Without this, a non-zero CLI exit surfaces only as
    // `Error("Claude Code process exited with code N")` with no detail. The
    // SDK forwards CLI stderr here in stream chunks (not necessarily one
    // line per call); log so the real failure reason (auth, rate-limit,
    // model rejection, etc.) lands in pino. Pipe through redactSecrets
    // first because CLI errors can echo bearer tokens / connection URLs
    // that buildProviderEnv works hard to keep out of the subprocess,
    // we don't want to undo that by leaking them into pod logs. trimEnd
    // preserves leading indentation in multi-line stack traces; the
    // 500-char cap matches the convention in src/daemon/updater.ts and
    // scoped-rebase-executor.ts so an unexpectedly large chunk can't blow
    // up log ingestion.
    stderr: (chunk: string) => {
      const redacted = redactSecrets(chunk);
      const tail = redacted.body.trimEnd();
      if (tail === "") return;
      const truncated = tail.length > 500;
      log.warn(
        {
          stderr: tail.slice(0, 500),
          ...(truncated ? { truncated: true } : {}),
          ...(redacted.matchCount > 0
            ? { redactedSecretCount: redacted.matchCount, redactedSecretKinds: redacted.kinds }
            : {}),
        },
        "Claude CLI stderr",
      );
    },
  };
  const resolvedMaxTurns = maxTurns ?? config.agentMaxTurns;
  if (resolvedMaxTurns !== undefined) {
    queryOptions.maxTurns = resolvedMaxTurns;
  }
  queryOptions.model = model ?? config.model;
  if (config.claudeCodePath !== undefined) {
    queryOptions.pathToClaudeCodeExecutable = config.claudeCodePath;
  }

  log.info(
    {
      queryModel: queryOptions.model ?? "(not set)",
      queryPermissionMode: queryOptions.permissionMode,
      queryMaxTurns: queryOptions.maxTurns,
      queryCwd: queryOptions.cwd,
      queryAllowedTools: queryOptions.allowedTools,
      queryDisallowedTools: queryOptions.disallowedTools,
    },
    "Agent SDK query options built",
  );

  // Bound wall-clock time to prevent a hung model response or MCP server from
  // holding an activeCount slot and a cloned workspace indefinitely, which would
  // eventually exhaust MAX_CONCURRENT_REQUESTS for all subsequent requests.
  // The timer aborts the SDK controller (rather than just rejecting a racing
  // promise) so the iterator stops consuming tokens and the subprocess exits.
  // The Error is hoisted so the catch block can identify a timer-fired abort
  // by reference (controller.signal.reason === timeoutError) rather than a
  // separate flag, also avoids constructing the same message twice.
  const timeoutError = new Error(`Agent execution timed out after ${config.agentTimeoutMs}ms`);
  const timer = setTimeout(() => {
    controller.abort(timeoutError);
  }, config.agentTimeoutMs);

  try {
    // In cacheable layout the userMessage carries the per-call dynamic blocks;
    // the static scaffolding has already been folded into systemPrompt.append.
    const sdkPrompt =
      useCacheableLayout && promptParts !== undefined ? promptParts.userMessage : prompt;
    const agentLoop = (async (): Promise<void> => {
      for await (const message of query({ prompt: sdkPrompt, options: queryOptions })) {
        const msg = message as Record<string, unknown>;
        const msgType = typeof msg["type"] === "string" ? msg["type"] : "unknown";

        if (msgType === "system") {
          log.info(
            {
              sdkMsgType: msgType,
              subtype: msg["subtype"],
              model: msg["model"],
              tools: msg["tools"],
              mcp_servers: msg["mcp_servers"],
            },
            "SDK system message",
          );
        } else if (msgType === "assistant") {
          const betaMsg = msg["message"] as Record<string, unknown> | undefined;
          const model = betaMsg?.["model"];
          const stopReason = betaMsg?.["stop_reason"];
          const content = betaMsg?.["content"] as Record<string, unknown>[] | undefined;
          const toolUses = content?.filter((b) => b["type"] === "tool_use");
          const textBlocks = content?.filter((b) => b["type"] === "text");
          const textPreview = textBlocks
            ?.map((b) => {
              const t = b["text"];
              return typeof t === "string" ? t.slice(0, 200) : "";
            })
            .join(" | ");
          const toolNames = toolUses?.map((b) => {
            const n = b["name"];
            return typeof n === "string" ? n : "";
          });
          log.info(
            {
              sdkMsgType: msgType,
              model,
              stopReason,
              toolUses: toolNames,
              textPreview:
                textPreview !== undefined && textPreview !== "" ? textPreview : undefined,
            },
            "SDK assistant message",
          );
        } else if (msgType === "result") {
          log.info({ sdkMsgType: msgType, subtype: msg["subtype"] }, "SDK result message");
        }

        // isResultMessage guards against the SDK message union resolving to
        // `any` in ESLint's type graph, ensures safe property access.
        if (isResultMessage(message)) {
          result = message;
        }
      }
    })();

    await agentLoop;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    // Identity comparison on the abort reason gives us the right answer even
    // when a caller-supplied signal fires nanoseconds before the timer (the
    // controller's first abort wins; subsequent calls are no-ops). The SDK
    // rethrows the abort reason, so for timeout/caller-cancel paths `error`
    // is the same instance held in controller.signal.reason.
    const timedOut = controller.signal.reason === timeoutError;
    log.error({ err: error, durationMs, timedOut }, "Claude Agent SDK execution failed");

    return {
      success: false,
      durationMs,
      errorMessage: timedOut
        ? `Agent execution timed out after ${String(durationMs)}ms`
        : error instanceof Error
          ? error.message
          : String(error),
    };
  } finally {
    clearTimeout(timer);
    if (signal !== undefined) {
      signal.removeEventListener("abort", onCallerAbort);
    }
  }

  const durationMs = Date.now() - startTime;

  // Cache hit/write metrics: `cache_read_input_tokens` is what we actually
  // saved on, `cache_creation_input_tokens` is the (2x base price) surcharge
  // paid to populate the 1h ephemeral cache. Operators flipping
  // PROMPT_CACHE_LAYOUT=cacheable watch for non-zero read tokens on the
  // second+ run of the same shape to confirm the cache key stabilized.
  log.info(
    {
      success: result?.subtype === "success",
      durationMs,
      costUsd: result?.total_cost_usd,
      numTurns: result?.num_turns,
      cacheReadInputTokens: result?.usage?.cache_read_input_tokens,
      cacheCreationInputTokens: result?.usage?.cache_creation_input_tokens,
      promptCacheLayout: useCacheableLayout ? "cacheable" : "legacy",
    },
    "Claude Agent SDK execution completed",
  );

  return buildExecutionResult(result, durationMs);
}

/** Build ExecutionResult from SDK output (exactOptionalPropertyTypes-safe). */
function buildExecutionResult(
  result: SDKResultMessage | undefined,
  durationMs: number,
): ExecutionResult {
  const success = result?.subtype === "success";
  const executionResult: ExecutionResult = {
    success,
    durationMs: result?.duration_ms ?? durationMs,
  };
  if (result?.total_cost_usd !== undefined) {
    executionResult.costUsd = result.total_cost_usd;
  }
  if (result?.num_turns !== undefined) {
    executionResult.numTurns = result.num_turns;
  }
  // SDK returned a non-success terminal result (e.g. error_max_turns,
  // error_max_budget_usd) without throwing. Surface the subtype + any
  // structured error strings the SDK emitted; the executor catch path
  // owns the throw case separately.
  if (!success) {
    const subtype = result?.subtype ?? "unknown";
    const errors =
      result !== undefined && "errors" in result && Array.isArray(result.errors)
        ? (result.errors as readonly string[]).filter((s) => typeof s === "string" && s !== "")
        : [];
    executionResult.errorMessage =
      errors.length > 0
        ? `SDK ${subtype}: ${errors.join("; ")}`
        : `SDK terminal subtype: ${subtype}`;
  }
  return executionResult;
}
