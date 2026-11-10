import { describe, expect, it } from "bun:test";

import {
  _createLLMClientForTests,
  type AnthropicLikeSdk,
  buildRichRequest,
  DEFAULT_MAX_TOOL_ITERATIONS,
  DEFAULT_MAX_TOOL_USES_PER_TURN,
  type LLMTool,
  type LLMToolCall,
  type LLMToolResult,
  parseAnthropicRichResponse,
  runWithTools,
} from "../../src/ai/llm-client";

const tools: readonly LLMTool[] = [
  {
    name: "echo",
    description: "Returns the input string verbatim",
    input_schema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
  },
];

interface FakeTurn {
  readonly content: {
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
    thinking?: string;
    signature?: string;
  }[];
  readonly stop_reason: string;
  readonly usage?: { input_tokens: number; output_tokens: number };
}

function fakeSdk(turns: readonly FakeTurn[]): { sdk: AnthropicLikeSdk; calls: unknown[] } {
  const calls: unknown[] = [];
  let i = 0;
  const sdk: AnthropicLikeSdk = {
    messages: {
      create: (req: unknown) => {
        calls.push(req);
        const turn = turns[i] ?? turns[turns.length - 1];
        if (turn === undefined) return Promise.reject(new Error("fakeSdk: no turn configured"));
        i += 1;
        return Promise.resolve({
          content: turn.content,
          model: "claude-test",
          usage: turn.usage ?? { input_tokens: 10, output_tokens: 5 },
          stop_reason: turn.stop_reason,
        });
      },
    },
  };
  return { sdk, calls };
}

describe("buildRichRequest", () => {
  it("emits tools and tool_choice=auto by default", () => {
    const req = buildRichRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
      tools,
    });
    expect(req["tools"]).toBe(tools);
    expect(req["tool_choice"]).toEqual({ type: "auto" });
  });

  it("omits tools field when none supplied", () => {
    const req = buildRichRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
    });
    expect(req["tools"]).toBeUndefined();
    expect(req["tool_choice"]).toBeUndefined();
  });

  it("OAuth path emits the array-form system blocks (Claude Code identifier first)", () => {
    const req = buildRichRequest(
      { model: "m", system: "you are a bot", messages: [], maxTokens: 100, tools },
      "anthropic-oauth",
    );
    const sys = req["system"] as { type: string; text: string }[];
    expect(Array.isArray(sys)).toBe(true);
    expect(sys[0]?.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(sys[1]?.text).toBe("you are a bot");
  });

  it("translates tool_choice forms", () => {
    const auto = buildRichRequest({ model: "m", messages: [], maxTokens: 1, tools });
    expect(auto["tool_choice"]).toEqual({ type: "auto" });
    const any = buildRichRequest({
      model: "m",
      messages: [],
      maxTokens: 1,
      tools,
      toolChoice: "any",
    });
    expect(any["tool_choice"]).toEqual({ type: "any" });
    const named = buildRichRequest({
      model: "m",
      messages: [],
      maxTokens: 1,
      tools,
      toolChoice: { type: "tool", name: "echo" },
    });
    expect(named["tool_choice"]).toEqual({ type: "tool", name: "echo" });
  });
});

describe("parseAnthropicRichResponse", () => {
  it("captures interleaved text + tool_use blocks", () => {
    const r = parseAnthropicRichResponse({
      content: [
        { type: "text", text: "Looking up..." },
        { type: "tool_use", id: "t1", name: "echo", input: { value: "x" } },
      ],
      model: "m",
      usage: { input_tokens: 1, output_tokens: 2 },
      stop_reason: "tool_use",
    });
    expect(r.text).toBe("Looking up...");
    expect(r.content).toHaveLength(2);
    expect(r.stopReason).toBe("tool_use");
  });

  it("keeps signed thinking blocks in order and excludes them from text", () => {
    const r = parseAnthropicRichResponse({
      content: [
        { type: "thinking", thinking: "", signature: "sig1" },
        { type: "tool_use", id: "t1", name: "echo", input: {} },
        { type: "thinking", thinking: "no sig" },
        { type: "text", text: "done" },
      ],
      model: "m",
      usage: { input_tokens: 1, output_tokens: 2 },
      stop_reason: "tool_use",
    });
    expect(r.content.map((b) => b.type)).toEqual(["thinking", "tool_use", "text"]);
    expect(r.content[0]).toEqual({ type: "thinking", thinking: "", signature: "sig1" });
    expect(r.text).toBe("done");
  });

  it("normalises unknown stop_reason to 'unknown'", () => {
    const r = parseAnthropicRichResponse({
      content: [{ type: "text", text: "" }],
      model: "m",
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: "weird-future-reason",
    });
    expect(r.stopReason).toBe("unknown");
  });

  it("drops malformed tool_use blocks (missing id)", () => {
    const r = parseAnthropicRichResponse({
      content: [{ type: "tool_use", name: "echo", input: {} }],
      model: "m",
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: "end_turn",
    });
    expect(r.content).toHaveLength(0);
  });
});

describe("runWithTools", () => {
  const okHandler = (call: LLMToolCall): Promise<LLMToolResult> =>
    Promise.resolve({
      content: JSON.stringify({ echoed: (call.input as { value: string }).value }),
    });

  it("returns immediately when first turn has stop_reason=end_turn", async () => {
    const { sdk, calls } = fakeSdk([
      { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
    ]);
    const client = _createLLMClientForTests("anthropic", sdk);
    const result = await runWithTools(client, {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
      tools,
      onToolCall: okHandler,
    });
    expect(result.text).toBe("done");
    expect(result.iterations).toBe(1);
    expect(result.toolCallCount).toBe(0);
    expect(result.capExceeded).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("echoes thinking blocks back unchanged in the next request", async () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig1" };
    const { sdk, calls } = fakeSdk([
      {
        content: [thinking, { type: "tool_use", id: "t1", name: "echo", input: { value: "hi" } }],
        stop_reason: "tool_use",
      },
      { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
    ]);
    await runWithTools(_createLLMClientForTests("anthropic", sdk), {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
      tools,
      onToolCall: okHandler,
    });
    const msgs = (calls[1] as { messages: { role: string; content: unknown[] }[] }).messages;
    expect(msgs[1]?.role).toBe("assistant");
    expect(msgs[1]?.content[0]).toEqual(thinking);
  });

  it("loops once: tool_use → tool_result → end_turn", async () => {
    const { sdk, calls } = fakeSdk([
      {
        content: [{ type: "tool_use", id: "t1", name: "echo", input: { value: "hi" } }],
        stop_reason: "tool_use",
      },
      { content: [{ type: "text", text: "I echoed: hi" }], stop_reason: "end_turn" },
    ]);
    const client = _createLLMClientForTests("anthropic", sdk);
    const result = await runWithTools(client, {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
      tools,
      onToolCall: okHandler,
    });
    expect(result.text).toBe("I echoed: hi");
    expect(result.iterations).toBe(2);
    expect(result.toolCallCount).toBe(1);
    expect(result.capExceeded).toBe(false);
    // Second call must include the assistant tool_use turn AND a user tool_result turn.
    const second = calls[1] as { messages: { role: string; content: unknown }[] };
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1]?.role).toBe("assistant");
    expect(second.messages[2]?.role).toBe("user");
  });

  it("fail-open: cap exceeded returns last assistant text with capExceeded=true", async () => {
    // Always emit tool_use, simulates a confused model in a loop.
    const looping: FakeTurn = {
      content: [
        { type: "text", text: "calling tool" },
        { type: "tool_use", id: "t-loop", name: "echo", input: { value: "again" } },
      ],
      stop_reason: "tool_use",
    };
    const { sdk } = fakeSdk(Array(20).fill(looping));
    const client = _createLLMClientForTests("anthropic", sdk);
    const result = await runWithTools(client, {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
      tools,
      onToolCall: okHandler,
      maxIterations: 3,
    });
    expect(result.iterations).toBe(3);
    expect(result.capExceeded).toBe(true);
    expect(result.text).toBe("calling tool");
    expect(result.toolCallCount).toBe(3);
  });

  it("uses DEFAULT_MAX_TOOL_ITERATIONS when maxIterations omitted", () => {
    expect(DEFAULT_MAX_TOOL_ITERATIONS).toBe(8);
  });

  it("tool handler errors become is_error tool_result blocks; loop continues", async () => {
    const { sdk, calls } = fakeSdk([
      {
        content: [{ type: "tool_use", id: "t1", name: "echo", input: { value: "x" } }],
        stop_reason: "tool_use",
      },
      { content: [{ type: "text", text: "Recovered" }], stop_reason: "end_turn" },
    ]);
    const client = _createLLMClientForTests("anthropic", sdk);
    const result = await runWithTools(client, {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
      tools,
      onToolCall: () => Promise.reject(new Error("boom")),
    });
    expect(result.text).toBe("Recovered");
    expect(result.iterations).toBe(2);
    expect(result.toolCallCount).toBe(1);
    const second = calls[1] as { messages: { role: string; content: unknown }[] };
    const userTurn = second.messages[2] as {
      role: string;
      content: { type: string; is_error?: boolean; content: string }[];
    };
    expect(userTurn.role).toBe("user");
    expect(userTurn.content[0]?.type).toBe("tool_result");
    expect(userTurn.content[0]?.is_error).toBe(true);
    expect(userTurn.content[0]?.content).toContain("boom");
  });

  it("dispatches all tool_use blocks in a single turn", async () => {
    const { sdk } = fakeSdk([
      {
        content: [
          { type: "tool_use", id: "a", name: "echo", input: { value: "1" } },
          { type: "tool_use", id: "b", name: "echo", input: { value: "2" } },
        ],
        stop_reason: "tool_use",
      },
      { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
    ]);
    const client = _createLLMClientForTests("anthropic", sdk);
    const result = await runWithTools(client, {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
      tools,
      onToolCall: okHandler,
    });
    expect(result.toolCallCount).toBe(2);
  });

  it("DEFAULT_MAX_TOOL_USES_PER_TURN is 4", () => {
    expect(DEFAULT_MAX_TOOL_USES_PER_TURN).toBe(4);
  });

  it("per-turn fan-out cap: dispatches up to maxToolUsesPerTurn, returns is_error for the rest", async () => {
    const dispatched: string[] = [];
    const { sdk, calls } = fakeSdk([
      {
        content: [
          { type: "tool_use", id: "a", name: "echo", input: { value: "1" } },
          { type: "tool_use", id: "b", name: "echo", input: { value: "2" } },
          { type: "tool_use", id: "c", name: "echo", input: { value: "3" } },
          { type: "tool_use", id: "d", name: "echo", input: { value: "4" } },
          { type: "tool_use", id: "e", name: "echo", input: { value: "5" } },
        ],
        stop_reason: "tool_use",
      },
      { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
    ]);
    const client = _createLLMClientForTests("anthropic", sdk);
    const result = await runWithTools(client, {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
      tools,
      maxToolUsesPerTurn: 2,
      onToolCall: (call) => {
        dispatched.push(call.id);
        return Promise.resolve({ content: "ok" });
      },
    });
    expect(dispatched).toEqual(["a", "b"]);
    expect(result.toolCallCount).toBe(2);
    expect(result.droppedToolCalls).toBe(3);
    // Inspect the tool_result turn echoed back to the model.
    const second = calls[1] as {
      messages: {
        role: string;
        content: { type: string; tool_use_id: string; is_error?: boolean }[];
      }[];
    };
    const toolResults = second.messages[2]?.content ?? [];
    expect(toolResults).toHaveLength(5);
    expect(toolResults.filter((t) => t.is_error === true).map((t) => t.tool_use_id)).toEqual([
      "c",
      "d",
      "e",
    ]);
  });

  it("sums usage across iterations", async () => {
    const { sdk } = fakeSdk([
      {
        content: [{ type: "tool_use", id: "t", name: "echo", input: {} }],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 20 },
      },
      {
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 50, output_tokens: 10 },
      },
    ]);
    const client = _createLLMClientForTests("anthropic", sdk);
    const result = await runWithTools(client, {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
      tools,
      onToolCall: okHandler,
    });
    expect(result.usage.inputTokens).toBe(150);
    expect(result.usage.outputTokens).toBe(30);
  });
});
