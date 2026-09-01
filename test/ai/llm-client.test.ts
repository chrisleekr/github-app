import { describe, expect, it } from "bun:test";

import {
  _createLLMClientForTests,
  type AnthropicLikeSdk,
  type AnthropicMessageResponse,
  buildRequest,
  buildRichRequest,
  createLLMClient,
  estimateHaikuCostUsd,
  MODEL_MAP,
  parseAnthropicResponse,
  resolveModelId,
} from "../../src/ai/llm-client";

describe("resolveModelId", () => {
  it("resolves the haiku-3-5 alias for anthropic", () => {
    expect(resolveModelId("haiku-3-5", "anthropic")).toBe("claude-3-5-haiku-20241022");
  });

  it("resolves the haiku-3-5 alias for bedrock", () => {
    expect(resolveModelId("haiku-3-5", "bedrock")).toBe("anthropic.claude-3-5-haiku-20241022-v1:0");
  });

  it("falls through unchanged for an unknown alias (explicit pinning)", () => {
    expect(resolveModelId("claude-3-7-sonnet-snapshot-20260301", "anthropic")).toBe(
      "claude-3-7-sonnet-snapshot-20260301",
    );
  });

  it("MODEL_MAP is a frozen-shape snapshot (no accidental growth in tests)", () => {
    expect(Object.keys(MODEL_MAP).sort()).toEqual(["haiku-3-5", "haiku-4-5", "sonnet-4-6"]);
  });
});

describe("createLLMClient: validation guards", () => {
  it("throws when provider=anthropic and no credentials supplied", () => {
    expect(() => createLLMClient({ provider: "anthropic" })).toThrow(
      /anthropicApiKey=missing, claudeCodeOauthToken=missing/,
    );
  });

  it("throws when anthropicApiKey is empty string", () => {
    expect(() => createLLMClient({ provider: "anthropic", anthropicApiKey: "" })).toThrow(
      /anthropicApiKey=empty, claudeCodeOauthToken=missing/,
    );
  });

  it("falls through to oauth when anthropicApiKey is empty string and oauth is set", () => {
    // Reproduces the production trap: ANTHROPIC_API_KEY="" must not shadow a
    // real CLAUDE_CODE_OAUTH_TOKEN. Defense in depth, config.ts also coerces
    // empty strings to undefined, but llm-client.ts must not depend on that.
    const c = createLLMClient({
      provider: "anthropic",
      anthropicApiKey: "",
      claudeCodeOauthToken: "sk-ant-oat-test",
    });
    expect(c.provider).toBe("anthropic");
  });

  it("treats whitespace-only anthropicApiKey as empty (matches config.ts trim semantics)", () => {
    // A whitespace-only key would otherwise produce a confusing 401 from the
    // SDK instead of the clear "missing vs empty" error.
    expect(() => createLLMClient({ provider: "anthropic", anthropicApiKey: "   " })).toThrow(
      /anthropicApiKey=empty, claudeCodeOauthToken=missing/,
    );

    const c = createLLMClient({
      provider: "anthropic",
      anthropicApiKey: "   ",
      claudeCodeOauthToken: "sk-ant-oat-test",
    });
    expect(c.provider).toBe("anthropic");
  });

  it("throws when provider=bedrock and no region supplied", () => {
    expect(() => createLLMClient({ provider: "bedrock" })).toThrow(
      /provider=bedrock requires awsRegion/,
    );
  });

  it("builds an anthropic client when apiKey is provided", () => {
    const c = createLLMClient({ provider: "anthropic", anthropicApiKey: "sk-ant-test" });
    expect(c.provider).toBe("anthropic");
    expect(typeof c.create).toBe("function");
  });

  it("builds an anthropic client when only OAuth token is provided", () => {
    const c = createLLMClient({
      provider: "anthropic",
      claudeCodeOauthToken: "sk-ant-oat-test",
    });
    expect(c.provider).toBe("anthropic");
  });

  it("builds a bedrock client when region is provided", () => {
    const c = createLLMClient({ provider: "bedrock", awsRegion: "us-east-1" });
    expect(c.provider).toBe("bedrock");
    expect(typeof c.create).toBe("function");
  });
});

describe("buildRequest: shaping the SDK payload", () => {
  it("omits `system` when not supplied", () => {
    const req = buildRequest({
      model: "haiku",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 256,
    });
    expect(req["system"]).toBeUndefined();
    expect(req["model"]).toBe("haiku");
    expect(req["max_tokens"]).toBe(256);
    expect(req).not.toHaveProperty("temperature");
  });

  // Claude 5 rejects the field outright with 400 "`temperature` is deprecated
  // for this model", so injecting a default here broke every single-turn call:
  // intent classification, triage, discussion digest, and the fail-closed
  // output scanner. It is opt-in now, including an explicit 0.
  it("omits `temperature` unless the caller asks for it", () => {
    const bare = buildRequest({
      model: "haiku",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 256,
    });
    expect(bare).not.toHaveProperty("temperature");

    const explicitZero = buildRequest({
      model: "haiku",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 256,
      temperature: 0,
    });
    expect(explicitZero["temperature"]).toBe(0);

    const rich = buildRichRequest({
      model: "haiku",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 256,
      tools: [],
    });
    expect(rich).not.toHaveProperty("temperature");
  });

  it("includes `system` verbatim when supplied", () => {
    const req = buildRequest({
      model: "haiku",
      system: "you are a classifier",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 256,
      temperature: 0.5,
    });
    expect(req["system"]).toBe("you are a classifier");
    expect(req["temperature"]).toBe(0.5);
  });

  describe("Claude Code OAuth gate", () => {
    const CALLER_SYSTEM = "you are a classifier";
    const IDENTIFIER = "You are Claude Code, Anthropic's official CLI for Claude.";

    it("emits a two-block array system on the OAuth path so the gate's first-block check passes", () => {
      const req = buildRequest(
        {
          model: "claude-sonnet-4-6",
          system: CALLER_SYSTEM,
          messages: [{ role: "user", content: "hi" }],
          maxTokens: 256,
        },
        "anthropic-oauth",
      );
      expect(req["system"]).toEqual([
        { type: "text", text: IDENTIFIER },
        { type: "text", text: CALLER_SYSTEM },
      ]);
    });

    it("uses the Claude Code identifier alone (string form) when no caller system is supplied (OAuth)", () => {
      const req = buildRequest(
        {
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "hi" }],
          maxTokens: 256,
        },
        "anthropic-oauth",
      );
      expect(req["system"]).toBe(IDENTIFIER);
    });

    it("does NOT prepend the identifier on the API-key path", () => {
      const req = buildRequest(
        {
          model: "claude-sonnet-4-6",
          system: CALLER_SYSTEM,
          messages: [{ role: "user", content: "hi" }],
          maxTokens: 256,
        },
        "anthropic-apikey",
      );
      expect(req["system"]).toBe(CALLER_SYSTEM);
    });

    it("does NOT prepend the identifier on the Bedrock path", () => {
      const req = buildRequest(
        {
          model: "us.anthropic.claude-sonnet-4-6",
          system: CALLER_SYSTEM,
          messages: [{ role: "user", content: "hi" }],
          maxTokens: 256,
        },
        "bedrock",
      );
      expect(req["system"]).toBe(CALLER_SYSTEM);
    });

    it("defaults authMode to api-key (no prefix) when called without the parameter", () => {
      const req = buildRequest({
        model: "haiku",
        system: CALLER_SYSTEM,
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 256,
      });
      expect(req["system"]).toBe(CALLER_SYSTEM);
    });
  });
});

describe("parseAnthropicResponse: concatenates text blocks, strips non-text", () => {
  it("joins multiple text blocks", () => {
    const raw: AnthropicMessageResponse = {
      content: [
        { type: "text", text: "hello " },
        { type: "text", text: "world" },
      ],
      model: "claude-3-5-haiku-20241022",
      usage: { input_tokens: 10, output_tokens: 2 },
    };
    const parsed = parseAnthropicResponse(raw);
    expect(parsed.text).toBe("hello world");
    expect(parsed.model).toBe("claude-3-5-haiku-20241022");
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
  });

  it("ignores non-text content blocks (tool_use, etc.)", () => {
    const raw: AnthropicMessageResponse = {
      content: [{ type: "tool_use" }, { type: "text", text: "only-text" }],
      model: "m",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    expect(parseAnthropicResponse(raw).text).toBe("only-text");
  });

  it("handles a text block with an undefined text property (defensive)", () => {
    const raw: AnthropicMessageResponse = {
      content: [{ type: "text" }, { type: "text", text: "kept" }],
      model: "m",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    expect(parseAnthropicResponse(raw).text).toBe("kept");
  });
});

describe("_createLLMClientForTests: end-to-end with a stubbed SDK", () => {
  function makeStub(response: AnthropicMessageResponse): AnthropicLikeSdk & {
    calls: { req: unknown }[];
  } {
    const calls: { req: unknown }[] = [];
    return {
      calls,
      messages: {
        create: async (req) => {
          calls.push({ req });
          return Promise.resolve(response);
        },
      },
    };
  }

  it("wires buildRequest → SDK → parseAnthropicResponse end-to-end", async () => {
    const sdk = makeStub({
      content: [{ type: "text", text: '{"mode":"daemon","confidence":0.9}' }],
      model: "claude-3-5-haiku-20241022",
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const client = _createLLMClientForTests("anthropic", sdk);
    const resp = await client.create({
      model: "claude-3-5-haiku-20241022",
      system: "classify",
      messages: [{ role: "user", content: "ambiguous event" }],
      maxTokens: 256,
    });
    expect(resp.text).toBe('{"mode":"daemon","confidence":0.9}');
    expect(resp.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(sdk.calls).toHaveLength(1);
    // Sanity-check that buildRequest shaped the payload as expected.
    const req = sdk.calls[0]?.req as Record<string, unknown>;
    expect(req["model"]).toBe("claude-3-5-haiku-20241022");
    expect(req["system"]).toBe("classify");
    expect(req["max_tokens"]).toBe(256);
  });

  it("propagates SDK errors without swallowing them", async () => {
    const sdk: AnthropicLikeSdk = {
      messages: { create: () => Promise.reject(new Error("SDK-boom")) },
    };
    const client = _createLLMClientForTests("bedrock", sdk);
    let caught: unknown;
    try {
      await client.create({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        maxTokens: 10,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("SDK-boom");
  });
});

describe("estimateHaikuCostUsd", () => {
  it("returns 0 on zero usage", () => {
    expect(estimateHaikuCostUsd({ inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it("matches the published Haiku 3.5 rate sheet (default when modelId omitted)", () => {
    // 1M input tokens = $0.80; 1M output tokens = $4.00 → total $4.80
    expect(estimateHaikuCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(
      4.8,
      6,
    );
  });

  it("matches the published Haiku 3.5 rate sheet when modelId is the 3.5 ID", () => {
    expect(
      estimateHaikuCostUsd(
        { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        "claude-3-5-haiku-20241022",
      ),
    ).toBeCloseTo(4.8, 6);
  });

  it("matches the published Haiku 4.5 rate sheet ($1 input / $5 output per 1M)", () => {
    // 1M input = $1.00; 1M output = $5.00 → total $6.00
    expect(
      estimateHaikuCostUsd(
        { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        "claude-haiku-4-5-20251001",
      ),
    ).toBeCloseTo(6.0, 6);
  });

  it("uses Bedrock-flavoured Haiku 4.5 ID just like the Anthropic ID", () => {
    expect(
      estimateHaikuCostUsd(
        { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        "anthropic.claude-haiku-4-5-20251001-v1:0",
      ),
    ).toBeCloseTo(6.0, 6);
  });

  it("falls back to Haiku 3.5 rates for an unknown modelId (under-count, never over-count)", () => {
    expect(
      estimateHaikuCostUsd(
        { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        "claude-3-7-sonnet-snapshot-99999999",
      ),
    ).toBeCloseTo(4.8, 6);
  });

  it("scales linearly for a realistic single-turn triage call (Haiku 3.5)", () => {
    // Typical triage: ~500 input tokens (prompt + context), ~100 output tokens (JSON response)
    const cost = estimateHaikuCostUsd({ inputTokens: 500, outputTokens: 100 });
    // 500 * 0.8/1e6 + 100 * 4/1e6 = 0.0004 + 0.0004 = 0.0008
    expect(cost).toBeCloseTo(0.0008, 6);
  });
});
