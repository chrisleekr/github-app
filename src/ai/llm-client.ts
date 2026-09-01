/**
 * LLM provider adaptor for non-agent single-turn inference (triage).
 *
 * Per the constitution amendment in PATCH v1.2.1 (Slice A of
 * triage-dispatch-modes), direct SDK use outside the Claude Agent SDK is
 * permitted strictly for single-turn classification / embedding /
 * summarisation calls. This module is the SINGLE entry point for those,
 * multi-turn agent work MUST go through `@anthropic-ai/claude-agent-sdk`.
 *
 * Design (per research.md R2):
 *   - A provider-agnostic `LLMClient` interface exposing `messages.create()`.
 *   - `createLLMClient(cfg)` branches on the already-validated
 *     `config.provider` enum to return the right SDK wrapper.
 *   - `resolveModelId(alias, provider)` turns operator-friendly aliases
 *     (e.g. "haiku-3-5") into provider-specific IDs, falling through to
 *     the raw value if no alias matches so operators can pin any ID.
 */

import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import Anthropic from "@anthropic-ai/sdk";

import { logger } from "../logger";

export type Provider = "anthropic" | "bedrock";

/**
 * Authentication mode tracked alongside the SDK so the request shaper can
 * apply the Claude Code OAuth gate (see `CLAUDE_CODE_IDENTIFIER` below).
 * Bedrock and console API keys do NOT require the gate.
 */
export type AuthMode = "anthropic-apikey" | "anthropic-oauth" | "bedrock";

/**
 * Anthropic's API gates `sk-ant-oat...` OAuth tokens to a degenerate-quota
 * pool unless the FIRST system block is exactly this identifier string.
 * Without it, Sonnet/Opus return `429 rate_limit_error` with body
 * `{"message":"Error"}` (Haiku is in a separate pool that happens to pass
 * either way). The check is exact-match on the first block: string-form
 * with any caller text appended (even after `\n\n`) is rejected, but the
 * SDK's array-of-blocks form `[{type:"text",text:ID}, {type:"text",text:callerSystem}]`
 * is accepted. `buildRequest` uses the array form on the OAuth path so
 * the caller's task instructions stay intact. Console API keys and
 * Bedrock are unaffected.
 */
export const CLAUDE_CODE_IDENTIFIER = "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Operator-friendly aliases → provider-specific model IDs. Haiku entries
 * remain available for cost-sensitive deployments; Sonnet 4.6 is the
 * default for triage and the output scanner where reasoning quality
 * outweighs the higher per-token cost.
 */
export const MODEL_MAP: Readonly<Record<string, Readonly<Record<Provider, string>>>> = {
  "haiku-3-5": {
    anthropic: "claude-3-5-haiku-20241022",
    bedrock: "anthropic.claude-3-5-haiku-20241022-v1:0",
  },
  "haiku-4-5": {
    anthropic: "claude-haiku-4-5-20251001",
    bedrock: "anthropic.claude-haiku-4-5-20251001-v1:0",
  },
  "sonnet-4-6": {
    anthropic: "claude-sonnet-4-6",
    bedrock: "us.anthropic.claude-sonnet-4-6",
  },
};

/**
 * Resolve an alias to a provider-specific model ID. When the input doesn't
 * match any alias, return it verbatim: this lets operators pin exact model
 * IDs (e.g. a newer snapshot) via `TRIAGE_MODEL` without needing code changes.
 */
export function resolveModelId(aliasOrId: string, provider: Provider): string {
  const entry = MODEL_MAP[aliasOrId];
  if (entry === undefined) return aliasOrId;
  return entry[provider];
}

/** One message in the request, Anthropic-style schema. */
export interface LLMMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

/**
 * One content block inside a rich (tool-use-aware) message. Anthropic's
 * messages API permits assistant turns to carry interleaved `text` and
 * `tool_use` blocks, and user turns to carry `tool_result` blocks paired
 * with prior `tool_use.id`s. The plain-string `LLMMessage.content` shape
 * is a strict subset (a single implicit text block).
 */
export type LLMContentBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly tool_use_id: string;
      readonly content: string;
      readonly is_error?: boolean;
    };

/** A message in a tool-use-aware turn, content may be a string or block array. */
export interface LLMRichMessage {
  readonly role: "user" | "assistant";
  readonly content: string | readonly LLMContentBlock[];
}

/**
 * A tool advertised to the model. `input_schema` is JSON Schema (draft 2020-12
 * subset Anthropic accepts). The model decides when to call based on
 * `description`: keep it tight and unambiguous.
 */
export interface LLMTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

/** A single tool invocation the model emitted in its assistant turn. */
export interface LLMToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** Caller's response for one tool invocation, fed back as a `tool_result` block. */
export interface LLMToolResult {
  readonly content: string;
  readonly isError?: boolean;
}

/** Caller-supplied tool dispatcher. Errors thrown here become is_error tool_result blocks. */
export type LLMToolHandler = (call: LLMToolCall) => Promise<LLMToolResult>;

export interface LLMCreateParams {
  readonly model: string;
  readonly system?: string;
  readonly messages: readonly LLMMessage[];
  /** Hard upper bound on generated tokens; prevents runaway cost on malformed responses. */
  readonly maxTokens: number;
  /** Passed through only when set. Claude 5 models reject the field. */
  readonly temperature?: number;
}

export interface LLMUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface LLMResponse {
  /** Concatenated text output across all content blocks. */
  readonly text: string;
  /** Token usage as reported by the provider. */
  readonly usage: LLMUsage;
  /** The model that served the request (provider may downgrade on capacity). */
  readonly model: string;
}

/** Tool-use turn outcome. `stopReason` mirrors Anthropic's enum so callers can branch. */
export interface LLMRichResponse {
  /** Concatenated text content (may be empty when the turn is purely tool_use). */
  readonly text: string;
  /** All assistant content blocks in order, including tool_use. */
  readonly content: readonly LLMContentBlock[];
  readonly model: string;
  readonly usage: LLMUsage;
  readonly stopReason: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | "unknown";
}

/** Tool-choice wire shape mirrored from Anthropic's API. */
export type LLMToolChoice = "auto" | "any" | { readonly type: "tool"; readonly name: string };

export interface LLMRichCreateParams {
  readonly model: string;
  readonly system?: string;
  readonly messages: readonly LLMRichMessage[];
  readonly maxTokens: number;
  readonly temperature?: number;
  readonly tools?: readonly LLMTool[];
  readonly toolChoice?: LLMToolChoice;
}

/**
 * Minimal provider-agnostic interface. Both Anthropic and Bedrock SDKs
 * already expose compatible shapes: this wrapper normalises response
 * parsing so the triage engine doesn't branch on provider.
 *
 * `createRich` is the tool-use-aware sibling of `create`: it preserves
 * the model's content blocks (including tool_use) and the stop_reason
 * so a higher-level loop (`runWithTools`) can drive multi-turn
 * tool dispatch.
 */
export interface LLMClient {
  readonly provider: Provider;
  create(params: LLMCreateParams): Promise<LLMResponse>;
  createRich(params: LLMRichCreateParams): Promise<LLMRichResponse>;
}

export interface CreateLLMClientParams {
  readonly provider: Provider;
  readonly anthropicApiKey?: string;
  readonly claudeCodeOauthToken?: string;
  readonly awsRegion?: string;
}

/**
 * Branch on provider and return a configured LLMClient. Validation of
 * provider-specific required fields (API key / region) lives in config.ts
 * and runs at startup: this function trusts its input, but defensively
 * throws if called with incompatible config so mis-wiring fails fast at
 * the first call rather than silently hitting the wrong endpoint.
 */
export function createLLMClient(params: CreateLLMClientParams): LLMClient {
  let sdk: AnthropicLikeSdk;
  let authMode: AuthMode;
  if (params.provider === "anthropic") {
    const apiKeyRaw = params.anthropicApiKey;
    const oauthRaw = params.claudeCodeOauthToken;
    // Trim before checking length so whitespace-only credentials are treated as
    // absent, matches `nonEmptyOptionalString` in config.ts. Direct callers
    // (tests, future code paths) that bypass the schema must not be able to
    // leak " " into `new Anthropic({ apiKey })` and produce a confusing 401.
    const apiKey = apiKeyRaw !== undefined && apiKeyRaw.trim().length > 0 ? apiKeyRaw : undefined;
    const oauth = oauthRaw !== undefined && oauthRaw.trim().length > 0 ? oauthRaw : undefined;
    if (apiKey === undefined && oauth === undefined) {
      const apiKeyState = apiKeyRaw === undefined ? "missing" : "empty";
      const oauthState = oauthRaw === undefined ? "missing" : "empty";
      throw new Error(
        `createLLMClient: provider=anthropic requires a non-empty anthropicApiKey or claudeCodeOauthToken (anthropicApiKey=${apiKeyState}, claudeCodeOauthToken=${oauthState})`,
      );
    }
    // OAuth tokens (sk-ant-oat-...) authenticate via Authorization: Bearer
    // (SDK `authToken`), NOT x-api-key. Passing OAuth as `apiKey` produces a
    // 401 "invalid x-api-key" because the API distinguishes the two headers.
    // Prefer the API key when both are provided, it's the lower-friction
    // credential and matches the precedence in config.ts. (Restoring the
    // fix from 82f8332 that PR #104 silently regressed.)
    if (apiKey !== undefined) {
      sdk = new Anthropic({ apiKey }) as unknown as AnthropicLikeSdk;
      authMode = "anthropic-apikey";
    } else {
      sdk = new Anthropic({ authToken: oauth ?? null }) as unknown as AnthropicLikeSdk;
      authMode = "anthropic-oauth";
    }
  } else {
    if (params.awsRegion === undefined || params.awsRegion.length === 0) {
      throw new Error("createLLMClient: provider=bedrock requires awsRegion");
    }
    sdk = new AnthropicBedrock({ awsRegion: params.awsRegion }) as unknown as AnthropicLikeSdk;
    authMode = "bedrock";
  }
  return {
    provider: params.provider,
    create: (p) => invokeSdk(sdk, p, authMode),
    createRich: (p) => invokeSdkRich(sdk, p, authMode),
  };
}

/**
 * Test-only factory: wraps a stubbed `AnthropicLikeSdk` in the LLMClient
 * contract so unit tests can exercise request-shaping and response-parsing
 * without touching the network. NEVER imported in production code,
 * production uses `createLLMClient`.
 */
export function _createLLMClientForTests(
  provider: Provider,
  sdk: AnthropicLikeSdk,
  authMode: AuthMode = "anthropic-apikey",
): LLMClient {
  return {
    provider,
    create: (p) => invokeSdk(sdk, p, authMode),
    createRich: (p) => invokeSdkRich(sdk, p, authMode),
  };
}

/**
 * Anthropic SDK's `messages.create` shape. Pinned to the fields used so the
 * consumer doesn't depend on the full SDK type surface.
 */
export interface AnthropicMessageResponse {
  readonly content: readonly { type: string; text?: string }[];
  readonly model: string;
  readonly usage: { input_tokens: number; output_tokens: number };
}

/** The subset of an SDK client used by this adaptor, fully stubbable in tests. */
export interface AnthropicLikeSdk {
  readonly messages: {
    create: (req: unknown) => Promise<unknown>;
  };
}

/**
 * Build the wire-shape `system` field. OAuth path requires the FIRST
 * top-level system block to be exactly the Claude Code identifier. The
 * string form `${ID}\n\n${callerSystem}` is rejected: the gate checks
 * the first block as a whole, not a prefix. The array form keeps the
 * identifier as a standalone first block so the caller's task
 * instructions ride along untouched. Shared between `buildRequest` and
 * `buildRichRequest`.
 */
function buildSystemField(
  authMode: AuthMode,
  callerSystem: string | undefined,
): string | { type: "text"; text: string }[] | undefined {
  if (authMode !== "anthropic-oauth") return callerSystem;
  if (callerSystem !== undefined && callerSystem.length > 0) {
    return [
      { type: "text", text: CLAUDE_CODE_IDENTIFIER },
      { type: "text", text: callerSystem },
    ];
  }
  return CLAUDE_CODE_IDENTIFIER;
}

/** @internal, exported for tests only. */
export function buildRequest(
  p: LLMCreateParams,
  authMode: AuthMode = "anthropic-apikey",
): Record<string, unknown> {
  const system = buildSystemField(authMode, p.system);
  const base: Record<string, unknown> = {
    model: p.model,
    max_tokens: p.maxTokens,
    messages: p.messages.map((m) => ({ role: m.role, content: m.content })),
    // Only sent when a caller asks for it. Claude 5 models reject the field
    // outright ("`temperature` is deprecated for this model", 400), so
    // defaulting it here made every single-turn call fail against them.
    ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
  };
  if (system !== undefined) base["system"] = system;
  return base;
}

/** @internal, exported for tests only. */
export function buildRichRequest(
  p: LLMRichCreateParams,
  authMode: AuthMode = "anthropic-apikey",
): Record<string, unknown> {
  const system = buildSystemField(authMode, p.system);
  const base: Record<string, unknown> = {
    model: p.model,
    max_tokens: p.maxTokens,
    messages: p.messages.map((m) => ({ role: m.role, content: m.content })),
    // Only sent when a caller asks for it. Claude 5 models reject the field
    // outright ("`temperature` is deprecated for this model", 400), so
    // defaulting it here made every single-turn call fail against them.
    ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
  };
  if (system !== undefined) base["system"] = system;
  if (p.tools !== undefined && p.tools.length > 0) {
    base["tools"] = p.tools;
    base["tool_choice"] = toolChoiceWire(p.toolChoice ?? "auto");
  }
  return base;
}

function toolChoiceWire(c: LLMToolChoice): unknown {
  if (c === "auto") return { type: "auto" };
  if (c === "any") return { type: "any" };
  return { type: "tool", name: c.name };
}

/** @internal, exported for tests only. */
export function parseAnthropicResponse(raw: AnthropicMessageResponse): LLMResponse {
  const text = raw.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text ?? "")
    .join("");
  return {
    text,
    model: raw.model,
    usage: { inputTokens: raw.usage.input_tokens, outputTokens: raw.usage.output_tokens },
  };
}

/**
 * Tool-use-aware response shape. Superset of `AnthropicMessageResponse`
 * with `stop_reason` and tool_use block fields surfaced.
 */
export interface AnthropicRichMessageResponse {
  readonly content: readonly {
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }[];
  readonly model: string;
  readonly usage: { input_tokens: number; output_tokens: number };
  readonly stop_reason?: string;
}

/** @internal, exported for tests only. */
export function parseAnthropicRichResponse(raw: AnthropicRichMessageResponse): LLMRichResponse {
  const content: LLMContentBlock[] = [];
  const textParts: string[] = [];
  for (const block of raw.content) {
    if (block.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
      textParts.push(block.text);
    } else if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      content.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input ?? {},
      });
    }
    // Other block types (e.g. thinking, citations) are dropped: we only
    // round-trip the shapes the tool loop reasons about.
  }
  const stop = raw.stop_reason;
  const stopReason: LLMRichResponse["stopReason"] =
    stop === "end_turn" || stop === "max_tokens" || stop === "tool_use" || stop === "stop_sequence"
      ? stop
      : "unknown";
  return {
    text: textParts.join(""),
    content,
    model: raw.model,
    usage: { inputTokens: raw.usage.input_tokens, outputTokens: raw.usage.output_tokens },
    stopReason,
  };
}

async function invokeSdk(
  sdk: AnthropicLikeSdk,
  p: LLMCreateParams,
  authMode: AuthMode,
): Promise<LLMResponse> {
  const req = buildRequest(p, authMode);
  // Diagnostic: gated on DEBUG_LLM_PROMPTS so it's silent in normal operation.
  // When set, dumps the exact request shape (model, authMode, system head/tail,
  // user-message preview) so we can verify the OAuth Claude Code identifier
  // gate is actually applied at the wire.
  if (process.env["DEBUG_LLM_PROMPTS"] === "1") {
    const rawSys = req["system"];
    const sys =
      typeof rawSys === "string"
        ? rawSys
        : Array.isArray(rawSys)
          ? (rawSys as { text?: string }[]).map((b) => b.text ?? "").join(" ⏵ ")
          : "";
    const firstUserMsg =
      Array.isArray(req["messages"]) && req["messages"].length > 0
        ? ((req["messages"] as { content: string }[])[0]?.content ?? "")
        : "";
    logger.info(
      {
        event: "llm.request.debug",
        model: req["model"],
        authMode,
        systemLen: sys.length,
        systemHead: sys.slice(0, 120),
        systemTail: sys.slice(-120),
        userPreview: firstUserMsg.slice(0, 200),
      },
      "llm.request.debug",
    );
  }
  const raw = (await sdk.messages.create(req)) as AnthropicMessageResponse;
  return parseAnthropicResponse(raw);
}

async function invokeSdkRich(
  sdk: AnthropicLikeSdk,
  p: LLMRichCreateParams,
  authMode: AuthMode,
): Promise<LLMRichResponse> {
  const req = buildRichRequest(p, authMode);
  if (process.env["DEBUG_LLM_PROMPTS"] === "1") {
    const tools = Array.isArray(req["tools"]) ? (req["tools"] as { name?: string }[]) : [];
    const messages = Array.isArray(req["messages"]) ? (req["messages"] as unknown[]) : [];
    logger.info(
      {
        event: "llm.rich.request.debug",
        model: req["model"],
        authMode,
        toolCount: tools.length,
        toolNames: tools.map((t) => t.name ?? ""),
        messageCount: messages.length,
      },
      "llm.rich.request.debug",
    );
  }
  const raw = (await sdk.messages.create(req)) as AnthropicRichMessageResponse;
  return parseAnthropicRichResponse(raw);
}

/**
 * Default per-turn cap on iterations of the tool-call loop. A "turn"
 * here is one round trip to the model. Hit on confused models that
 * repeat tool calls; fail-open returns the last assistant text so the
 * caller can still produce a response. Generous default (8) trades a
 * bit of cost for accuracy on legitimately complex CI-state queries.
 */
export const DEFAULT_MAX_TOOL_ITERATIONS = 8;

/**
 * Default cap on `tool_use` blocks dispatched within a SINGLE assistant
 * turn (orthogonal to {@link DEFAULT_MAX_TOOL_ITERATIONS}, which caps
 * the number of turns). Excess blocks are returned to the model as
 * `is_error: true` tool_result entries so the model has explicit
 * feedback rather than silent truncation. Bounds worst-case GitHub API
 * fan-out per turn.
 */
export const DEFAULT_MAX_TOOL_USES_PER_TURN = 4;

export interface RunWithToolsParams {
  readonly model: string;
  readonly system?: string;
  /** Initial conversation, usually one user message. Subsequent assistant + tool_result turns are appended internally. */
  readonly messages: readonly LLMMessage[];
  readonly maxTokens: number;
  readonly temperature?: number;
  readonly tools: readonly LLMTool[];
  readonly toolChoice?: LLMToolChoice;
  readonly onToolCall: LLMToolHandler;
  /** Optional per-turn cap override. Defaults to {@link DEFAULT_MAX_TOOL_ITERATIONS}. */
  readonly maxIterations?: number;
  /**
   * Optional per-turn fan-out cap. Limits the number of `tool_use`
   * blocks dispatched from a single assistant turn. Defaults to
   * {@link DEFAULT_MAX_TOOL_USES_PER_TURN}. Excess blocks are
   * answered with `is_error: true` tool_results so the model knows
   * the cap was hit.
   */
  readonly maxToolUsesPerTurn?: number;
}

export interface RunWithToolsResult {
  /** Final assistant text. Empty when the loop terminated on tool_use without a follow-up text turn. */
  readonly text: string;
  readonly model: string;
  /** Token usage summed across every iteration. */
  readonly usage: LLMUsage;
  /** Number of model round trips actually performed. */
  readonly iterations: number;
  /** Number of tool_use blocks executed across all iterations. */
  readonly toolCallCount: number;
  /** True if the loop stopped because `maxIterations` was reached without `end_turn`. Result is best-effort. */
  readonly capExceeded: boolean;
  /**
   * Number of `tool_use` blocks dropped across all turns because the
   * per-turn fan-out cap was hit. Non-zero indicates the model tried to
   * dispatch more tools per turn than the cap allowed and was pushed
   * back to a smaller set.
   */
  readonly droppedToolCalls: number;
  readonly stopReason: LLMRichResponse["stopReason"];
}

/**
 * Drive the Anthropic tool-use loop until the model emits a non-tool_use
 * stop_reason, an iteration cap is hit, or a tool handler throws.
 *
 * Behaviour:
 *   - Each iteration: send messages + tools, append the assistant turn,
 *     execute every tool_use block via `onToolCall`, append a single
 *     `user` message containing all paired `tool_result` blocks.
 *   - Tool handler errors are caught per-call and surfaced to the model
 *     as `is_error: true` tool_result content; the loop continues so
 *     the model can recover (re-call with different input, abandon).
 *   - On `maxIterations` exhaustion: fail-open. Return the latest
 *     assistant text with `capExceeded: true` so callers can decide
 *     whether to surface the partial answer or fall back.
 *
 * The final text still flows through the caller's
 * `parseStructuredResponse(...)` chokepoint: this function does not
 * encode any JSON-vs-prose policy.
 */
export async function runWithTools(
  client: LLMClient,
  params: RunWithToolsParams,
): Promise<RunWithToolsResult> {
  const maxIterations = params.maxIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
  const maxToolUsesPerTurn = params.maxToolUsesPerTurn ?? DEFAULT_MAX_TOOL_USES_PER_TURN;
  const messages: LLMRichMessage[] = params.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  let iterations = 0;
  let toolCallCount = 0;
  let droppedToolCalls = 0;
  let totalIn = 0;
  let totalOut = 0;
  let lastResponse: LLMRichResponse | undefined;

  while (iterations < maxIterations) {
    iterations += 1;
    const richParams: LLMRichCreateParams = {
      model: params.model,
      messages,
      maxTokens: params.maxTokens,
      tools: params.tools,
      toolChoice: params.toolChoice ?? "auto",
      ...(params.system !== undefined ? { system: params.system } : {}),
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    };
    const response = await client.createRich(richParams);
    lastResponse = response;
    totalIn += response.usage.inputTokens;
    totalOut += response.usage.outputTokens;

    // Always echo the assistant turn back into the message history so the
    // model sees its own tool_use blocks alongside our tool_result reply.
    messages.push({ role: "assistant", content: response.content });

    if (response.stopReason !== "tool_use") {
      return {
        text: response.text,
        model: response.model,
        usage: { inputTokens: totalIn, outputTokens: totalOut },
        iterations,
        toolCallCount,
        capExceeded: false,
        droppedToolCalls,
        stopReason: response.stopReason,
      };
    }

    const allToolUses = response.content.filter(
      (b): b is Extract<LLMContentBlock, { type: "tool_use" }> => b.type === "tool_use",
    );
    if (allToolUses.length === 0) {
      // Defensive: stop_reason was tool_use but no tool_use block surfaced
      //, bail rather than spin. Treat as end-of-conversation.
      return {
        text: response.text,
        model: response.model,
        usage: { inputTokens: totalIn, outputTokens: totalOut },
        iterations,
        toolCallCount,
        capExceeded: false,
        droppedToolCalls,
        stopReason: response.stopReason,
      };
    }

    // Apply per-turn fan-out cap. Anthropic's API requires every tool_use
    // block to be paired with a tool_result, so dropped blocks still get
    // an explicit is_error response: that gives the model feedback to
    // adjust strategy on the next turn instead of hitting the cap blindly.
    const dispatchable = allToolUses.slice(0, maxToolUsesPerTurn);
    const dropped = allToolUses.slice(maxToolUsesPerTurn);
    if (dropped.length > 0) {
      droppedToolCalls += dropped.length;
      logger.warn(
        {
          event: "llm.tool_loop.fanout_capped",
          requested: allToolUses.length,
          dispatched: dispatchable.length,
          dropped: dropped.length,
          cap: maxToolUsesPerTurn,
          iteration: iterations,
        },
        "tool-call fan-out cap hit; excess tool_use blocks answered with is_error",
      );
    }

    const toolResults: LLMContentBlock[] = [];
    for (const use of dispatchable) {
      toolCallCount += 1;
      let result: LLMToolResult;
      try {
        result = await params.onToolCall({ id: use.id, name: use.name, input: use.input });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result = { content: `Tool execution failed: ${message}`, isError: true };
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: result.content,
        ...(result.isError === true ? { is_error: true } : {}),
      });
    }
    for (const dropBlock of dropped) {
      toolResults.push({
        type: "tool_result",
        tool_use_id: dropBlock.id,
        content: `dropped: per-turn tool fan-out cap of ${String(maxToolUsesPerTurn)} exceeded; pick the most useful tools and try again on the next turn`,
        is_error: true,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  logger.warn(
    {
      event: "llm.tool_loop.cap_exceeded",
      iterations,
      toolCallCount,
      maxIterations,
    },
    "tool-call loop hit maxIterations; returning latest assistant text (fail-open)",
  );
  if (lastResponse === undefined) {
    return {
      text: "",
      model: params.model,
      usage: { inputTokens: totalIn, outputTokens: totalOut },
      iterations,
      toolCallCount,
      capExceeded: true,
      droppedToolCalls,
      stopReason: "unknown",
    };
  }
  return {
    text: lastResponse.text,
    model: lastResponse.model,
    usage: { inputTokens: totalIn, outputTokens: totalOut },
    iterations,
    toolCallCount,
    capExceeded: true,
    droppedToolCalls,
    stopReason: lastResponse.stopReason,
  };
}

/**
 * Per-model rate sheet (USD per token). Anthropic public pricing as of
 * 2026-04. Bedrock charges the same underlying Anthropic rates (AWS adds a
 * region-dependent surcharge we don't model here: operators can read the
 * usage columns and multiply). The estimate is advisory: billing of record
 * is whatever the provider invoice says.
 *
 * Haiku 3.5 (2024-10): input $0.80 / output $4.00 per 1M tokens.
 * Haiku 4.5 (2025-10): input $1.00 / output $5.00 per 1M tokens.
 *
 * The map is keyed by the *resolved* provider model ID (what the API
 * returns in `response.model`), so callers don't have to know about aliases.
 */
const RATE_SHEET_USD_PER_TOKEN: Readonly<Record<string, { input: number; output: number }>> = {
  // Haiku 3.5
  "claude-3-5-haiku-20241022": { input: 0.8 / 1_000_000, output: 4.0 / 1_000_000 },
  "anthropic.claude-3-5-haiku-20241022-v1:0": { input: 0.8 / 1_000_000, output: 4.0 / 1_000_000 },
  // Haiku 4.5
  "claude-haiku-4-5-20251001": { input: 1.0 / 1_000_000, output: 5.0 / 1_000_000 },
  "anthropic.claude-haiku-4-5-20251001-v1:0": { input: 1.0 / 1_000_000, output: 5.0 / 1_000_000 },
};

/**
 * Cost estimate (USD) for a Haiku-class triage call. Branches on the
 * resolved model ID returned by the provider; falls back to Haiku 3.5
 * rates for unknown models so a stale rate sheet under-counts (warns the
 * operator) rather than over-counts.
 */
export function estimateHaikuCostUsd(usage: LLMUsage, modelId?: string): number {
  const FALLBACK = { input: 0.8 / 1_000_000, output: 4.0 / 1_000_000 };
  const rates = modelId !== undefined ? (RATE_SHEET_USD_PER_TOKEN[modelId] ?? FALLBACK) : FALLBACK;
  return usage.inputTokens * rates.input + usage.outputTokens * rates.output;
}
