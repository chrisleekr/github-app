/**
 * Unit tests for executeAgent's cancellation surface.
 *
 * Covers the cancellation contract: timeout/cancel must abort the SDK iterator (not just
 * reject a racing promise), and the wall-clock setTimeout must be cleared
 * on the happy path so the Bun test runner exits promptly.
 *
 * The Claude Agent SDK is replaced at module level so we can drive the
 * iterator from the test. mock.module persists for the Bun process: that
 * is acceptable here because no other test file imports the SDK directly
 * (only `src/core/executor.ts` does, and other suites mock executor itself).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { config } from "../../src/config";
import type { McpServerConfig } from "../../src/types";
import { makeBotContext } from "../factories";

interface QueryCall {
  prompt?: string;
  options: {
    abortController?: AbortController;
    stderr?: (chunk: string) => void;
    systemPrompt?: unknown;
    // Security pins asserted by the #196 / #191 regression tests.
    strictMcpConfig?: boolean;
    settingSources?: unknown[];
    mcpServers?: unknown;
  };
}

let lastQueryCall: QueryCall | undefined;

/**
 * Async-iterable factory the mocked `query()` returns. Tests reassign this
 * before calling executeAgent. Default emits no messages (happy path).
 */
type IteratorFactory = () => AsyncIterableIterator<unknown>;

function emptyIterator(): AsyncIterableIterator<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: () => Promise.resolve({ value: undefined, done: true }),
    return: () => Promise.resolve({ value: undefined, done: true }),
  } as AsyncIterableIterator<unknown>;
}

let nextIterator: IteratorFactory = emptyIterator;
const closeQuery = mock(() => {});

void mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: mock(
    (opts: {
      prompt: string;
      options: { abortController?: AbortController; stderr?: (chunk: string) => void };
    }) => {
      lastQueryCall = { prompt: opts.prompt, options: opts.options };
      return Object.assign(nextIterator(), { close: closeQuery });
    },
  ),
}));

const { executeAgent } = await import("../../src/core/executor");

const ORIGINAL_TIMEOUT = config.agentTimeoutMs;

function baseParams(
  extra: Partial<Parameters<typeof executeAgent>[0]> = {},
): Parameters<typeof executeAgent>[0] {
  return {
    ctx: makeBotContext(),
    prompt: "test prompt",
    mcpServers: {} as McpServerConfig,
    workDir: "/tmp/fake-workdir",
    allowedTools: [],
    ...extra,
  };
}

/** Build an iterator that resolves only when the SDK controller fires abort. */
function awaitAbortIterator(
  onAbort: (reason: unknown) => void = () => {},
): AsyncIterableIterator<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: () => {
      const controller = lastQueryCall?.options.abortController;
      if (controller === undefined) {
        return Promise.reject(new Error("controller missing from query options"));
      }
      return new Promise((_, reject) => {
        const fire = (): void => {
          const reason = controller.signal.reason;
          onAbort(reason);
          // Models the real SDK: it discards the abort reason and throws its
          // own AbortError (sdk.mjs v0.3.146).
          reject(new Error("Claude Code process aborted by user"));
        };
        if (controller.signal.aborted) {
          fire();
        } else {
          controller.signal.addEventListener("abort", fire, { once: true });
        }
      });
    },
    return: () => Promise.resolve({ value: undefined, done: true }),
  } as AsyncIterableIterator<unknown>;
}

function closeDrivenIterator(): {
  iterator: AsyncIterableIterator<unknown>;
  closed: Promise<void>;
} {
  let closed = false;
  let rejectNext: ((error: Error) => void) | undefined;
  let resolveClosed: () => void = () => undefined;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  closeQuery.mockImplementation(() => {
    if (closed) return;
    closed = true;
    resolveClosed();
    rejectNext?.(new Error("SDK query closed"));
  });
  return {
    iterator: {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => {
        if (closed) return Promise.reject(new Error("SDK query closed"));
        return new Promise((_, reject) => {
          rejectNext = reject;
        });
      },
      return: () => Promise.resolve({ value: undefined, done: true }),
    } as AsyncIterableIterator<unknown>,
    closed: closedPromise,
  };
}

function closeCompletesIterator(): {
  iterator: AsyncIterableIterator<unknown>;
  closed: Promise<void>;
} {
  let closed = false;
  let resolveNext: ((value: IteratorResult<unknown>) => void) | undefined;
  let resolveClosed: () => void = () => undefined;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  closeQuery.mockImplementation(() => {
    if (closed) return;
    closed = true;
    resolveClosed();
    resolveNext?.({ value: undefined, done: true });
  });
  return {
    iterator: {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => {
        if (closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          resolveNext = resolve;
        });
      },
      return: () => Promise.resolve({ value: undefined, done: true }),
    },
    closed: closedPromise,
  };
}

describe("executeAgent: MCP config hardening (#196)", () => {
  beforeEach(() => {
    lastQueryCall = undefined;
    nextIterator = emptyIterator;
    closeQuery.mockClear();
  });

  it("sets strictMcpConfig so a cloned-PR .mcp.json is not auto-loaded, keeping the injected mcpServers", async () => {
    // settingSources:[] does NOT gate project `.mcp.json` MCP discovery; the
    // SDK maps strictMcpConfig -> the CLI `--strict-mcp-config` flag, which
    // restricts MCP loading to the explicit `mcpServers` (--mcp-config) set.
    const mcpServers = {
      fake: { type: "stdio", command: "node", args: [] },
    } as unknown as McpServerConfig;
    await executeAgent(baseParams({ mcpServers }));

    expect(lastQueryCall?.options.strictMcpConfig).toBe(true);
    // The legitimately-injected servers must still be forwarded (criterion 2).
    expect(lastQueryCall?.options.mcpServers).toBe(mcpServers);
    // The #191 sibling pin stays in place.
    expect(lastQueryCall?.options.settingSources).toEqual([]);
  });
});

describe("executeAgent: cancellation", () => {
  beforeEach(() => {
    lastQueryCall = undefined;
    nextIterator = emptyIterator;
    closeQuery.mockClear();
    closeQuery.mockImplementation(() => {});
  });

  afterEach(() => {
    config.agentTimeoutMs = ORIGINAL_TIMEOUT;
  });

  it("forwards an AbortController into the SDK query options", async () => {
    await executeAgent(baseParams());

    expect(lastQueryCall).toBeDefined();
    expect(lastQueryCall?.options.abortController).toBeInstanceOf(AbortController);
  });

  it("aborts the SDK controller when the wall-clock timeout fires", async () => {
    config.agentTimeoutMs = 25;

    const query = closeDrivenIterator();
    nextIterator = () => query.iterator;
    const execution = executeAgent(baseParams());

    await query.closed;
    expect(closeQuery).toHaveBeenCalledTimes(1);
    const result = await execution;

    expect(result.success).toBe(false);
    expect(lastQueryCall?.options.abortController?.signal.reason).toBeInstanceOf(Error);
    expect((lastQueryCall?.options.abortController?.signal.reason as Error).message).toContain(
      "timed out after 25ms",
    );
    // Handlers return this reason so terminal persistence can populate
    // state.failedReason instead of recording an unexplained failure.
    expect(result.errorMessage).toMatch(/^Agent execution timed out after \d+ms$/);
    expect(closeQuery).toHaveBeenCalledTimes(1);
  });

  it("preserves timeout failure when Query.close ends iteration normally", async () => {
    config.agentTimeoutMs = 25;
    const query = closeCompletesIterator();
    nextIterator = () => query.iterator;

    const execution = executeAgent(baseParams());
    await query.closed;
    const result = await execution;

    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/^Agent execution timed out after \d+ms$/);
    expect(closeQuery).toHaveBeenCalledTimes(1);
  });

  it("clears the wall-clock timer on the happy path", async () => {
    config.agentTimeoutMs = 60_000;

    // Spy on setTimeout/clearTimeout so we can confirm the timer handle is
    // released, leaving it pending is what would otherwise pin the Bun
    // event loop for up to AGENT_TIMEOUT_MS after a successful run.
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const setSpy = mock(realSetTimeout);
    const clearSpy = mock(realClearTimeout);

    globalThis.setTimeout = setSpy as unknown as typeof setTimeout;

    globalThis.clearTimeout = clearSpy as unknown as typeof clearTimeout;
    try {
      await executeAgent(baseParams());
    } finally {
      // eslint-disable-next-line require-atomic-updates -- restore in finally
      globalThis.setTimeout = realSetTimeout;
      // eslint-disable-next-line require-atomic-updates -- restore in finally
      globalThis.clearTimeout = realClearTimeout;
    }

    const wallClockIdx = setSpy.mock.calls.findIndex((call) => call[1] === 60_000);
    expect(wallClockIdx).toBeGreaterThanOrEqual(0);
    const wallClockHandle = setSpy.mock.results[wallClockIdx]?.value;
    expect(wallClockHandle).toBeDefined();
    expect(clearSpy.mock.calls.some((call) => call[0] === wallClockHandle)).toBe(true);
  });

  it("propagates a caller-supplied aborted signal as a failed result", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled by orchestrator"));

    nextIterator = () => awaitAbortIterator();

    const result = await executeAgent(baseParams({ signal: controller.signal }));

    expect(result.success).toBe(false);
    expect(lastQueryCall?.options.abortController?.signal.aborted).toBe(true);
    expect(result.errorMessage).toBe("cancelled by orchestrator");
  });

  it("propagates a caller signal aborted mid-execution", async () => {
    const controller = new AbortController();

    nextIterator = () => {
      // Fire the caller abort one microtask after the iterator starts, the
      // SDK controller must receive it via the listener wired in executeAgent.
      queueMicrotask(() => {
        controller.abort(new Error("daemon cancel"));
      });
      return awaitAbortIterator();
    };

    const result = await executeAgent(baseParams({ signal: controller.signal }));

    expect(result.success).toBe(false);
    expect(lastQueryCall?.options.abortController?.signal.aborted).toBe(true);
    expect(result.errorMessage).toBe("daemon cancel");
  });

  it("force-closes the retained SDK query when the caller aborts", async () => {
    const controller = new AbortController();
    const query = closeDrivenIterator();
    nextIterator = () => query.iterator;

    const execution = executeAgent(baseParams({ signal: controller.signal }));
    await Promise.resolve();
    controller.abort(new Error("workflow attempt fenced"));
    await query.closed;

    expect(closeQuery).toHaveBeenCalledTimes(1);
    await execution;

    expect(closeQuery).toHaveBeenCalledTimes(1);
  });
});

describe("executeAgent: stderr callback", () => {
  beforeEach(() => {
    lastQueryCall = undefined;
    nextIterator = emptyIterator;
  });

  it("forwards a stderr callback into the SDK query options", async () => {
    await executeAgent(baseParams());

    expect(lastQueryCall?.options.stderr).toBeTypeOf("function");
  });

  it("logs non-empty stderr chunks at warn level on the request logger", async () => {
    const params = baseParams();
    await executeAgent(params);

    lastQueryCall?.options.stderr?.("oauth token expired\n");

    const logWarn = params.ctx.log.warn as ReturnType<typeof mock>;
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn.mock.calls[0]).toEqual([{ stderr: "oauth token expired" }, "Claude CLI stderr"]);
  });

  it("preserves leading indentation so multi-line stack traces stay readable", async () => {
    const params = baseParams();
    await executeAgent(params);

    lastQueryCall?.options.stderr?.("Error: boom\n    at foo (file.ts:1:1)\n");

    const logWarn = params.ctx.log.warn as ReturnType<typeof mock>;
    expect(logWarn.mock.calls[0]?.[0]).toEqual({
      stderr: "Error: boom\n    at foo (file.ts:1:1)",
    });
  });

  it("skips whitespace-only chunks to avoid log spam", async () => {
    const params = baseParams();
    await executeAgent(params);

    lastQueryCall?.options.stderr?.("\n");
    lastQueryCall?.options.stderr?.("   \t\n");

    const logWarn = params.ctx.log.warn as ReturnType<typeof mock>;
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("caps stderr at 500 chars and flags truncation", async () => {
    const params = baseParams();
    await executeAgent(params);

    const oversized = "x".repeat(600);
    lastQueryCall?.options.stderr?.(oversized);

    const logWarn = params.ctx.log.warn as ReturnType<typeof mock>;
    expect(logWarn).toHaveBeenCalledTimes(1);
    const [fields] = logWarn.mock.calls[0] ?? [];
    expect(fields).toEqual({ stderr: "x".repeat(500), truncated: true });
  });

  it("redacts secrets from stderr before logging and surfaces the kind", async () => {
    const params = baseParams();
    await executeAgent(params);

    const oauth = `sk-ant-oat01-${"A".repeat(80)}`;
    lastQueryCall?.options.stderr?.(`auth failed: token=${oauth} expired`);

    const logWarn = params.ctx.log.warn as ReturnType<typeof mock>;
    expect(logWarn).toHaveBeenCalledTimes(1);
    const [fields] = logWarn.mock.calls[0] ?? [];
    expect(fields).toEqual({
      stderr: "auth failed: token= expired",
      redactedSecretCount: 1,
      redactedSecretKinds: ["ANTHROPIC_OAUTH"],
    });
  });

  it("skips chunks that become empty after secret redaction", async () => {
    const params = baseParams();
    await executeAgent(params);

    const oauthOnly = `sk-ant-oat01-${"A".repeat(80)}\n`;
    lastQueryCall?.options.stderr?.(oauthOnly);

    const logWarn = params.ctx.log.warn as ReturnType<typeof mock>;
    expect(logWarn).not.toHaveBeenCalled();
  });
});

// ─── prompt cache metrics (issue #134) ──────────────────────────────────────

/**
 * Build an iterator that yields a single fake SDKResultMessage with the
 * supplied usage fields, then terminates. The executor's completion log
 * reads result?.usage?.cache_read_input_tokens / cache_creation_input_tokens.
 */
function singleResultIterator(
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  },
  modelUsage: Record<string, unknown> = {},
): AsyncIterableIterator<unknown> {
  let emitted = false;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: () => {
      if (emitted) {
        return Promise.resolve({ value: undefined, done: true });
      }
      emitted = true;
      return Promise.resolve({
        value: {
          type: "result",
          subtype: "success",
          duration_ms: 100,
          duration_api_ms: 50,
          is_error: false,
          num_turns: 3,
          result: "ok",
          stop_reason: "end_turn",
          total_cost_usd: 0.01,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            ...usage,
          },
          modelUsage,
          permission_denials: [],
          uuid: "test-uuid",
          session_id: "test-session",
        },
        done: false,
      });
    },
    return: () => Promise.resolve({ value: undefined, done: true }),
  } as AsyncIterableIterator<unknown>;
}

describe("executeAgent: prompt cache metrics", () => {
  beforeEach(() => {
    lastQueryCall = undefined;
    nextIterator = emptyIterator;
  });

  it("logs cacheReadInputTokens and cacheCreationInputTokens from SDK usage", async () => {
    nextIterator = (): AsyncIterableIterator<unknown> =>
      singleResultIterator({
        cache_read_input_tokens: 1234,
        cache_creation_input_tokens: 567,
      });

    const params = baseParams();
    const result = await executeAgent(params);

    expect(result.success).toBe(true);

    const logInfo = params.ctx.log.info as ReturnType<typeof mock>;
    // Find the "Claude Agent SDK execution completed" call so we can assert
    // on its structured fields. Earlier info() calls in the executor log
    // unrelated diagnostics ("Starting...", per-message events).
    const completion = logInfo.mock.calls.find(
      (call) => call[1] === "Claude Agent SDK execution completed",
    );
    expect(completion).toBeDefined();
    const fields = (completion as [Record<string, unknown>, string])[0];
    expect(fields.cacheReadInputTokens).toBe(1234);
    expect(fields.cacheCreationInputTokens).toBe(567);
    expect(fields.success).toBe(true);
  });

  it("logs zero cache tokens when the SDK reports a cold cache", async () => {
    nextIterator = (): AsyncIterableIterator<unknown> =>
      singleResultIterator({ cache_read_input_tokens: 0, cache_creation_input_tokens: 8192 });

    const params = baseParams();
    await executeAgent(params);

    const logInfo = params.ctx.log.info as ReturnType<typeof mock>;
    const completion = logInfo.mock.calls.find(
      (call) => call[1] === "Claude Agent SDK execution completed",
    );
    expect(completion).toBeDefined();
    const fields = (completion as [Record<string, unknown>, string])[0];
    expect(fields.cacheReadInputTokens).toBe(0);
    expect(fields.cacheCreationInputTokens).toBe(8192);
    // baseParams() passes no promptParts, so the effective layout is legacy
    // regardless of config.promptCacheLayout.
    expect(fields.promptCacheLayout).toBe("legacy");
  });

  it("threads input/output tokens and a renamed modelUsage onto the result (#192)", async () => {
    nextIterator = (): AsyncIterableIterator<unknown> =>
      singleResultIterator(
        { input_tokens: 1500, output_tokens: 220, cache_read_input_tokens: 9000 },
        {
          "claude-opus-4-7": {
            inputTokens: 1500,
            outputTokens: 220,
            cacheReadInputTokens: 9000,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.012,
            contextWindow: 200000,
            maxOutputTokens: 8192,
          },
        },
      );

    const params = baseParams();
    const result = await executeAgent(params);

    expect(result.inputTokens).toBe(1500);
    expect(result.outputTokens).toBe(220);
    expect(result.cacheReadInputTokens).toBe(9000);
    expect(result.modelUsage?.[0]?.model).toBe("claude-opus-4-7");
    // SDK ModelUsage.costUSD is renamed to costUsd on ModelUsageEntry.
    expect(result.modelUsage?.[0]?.costUsd).toBe(0.012);

    const logInfo = params.ctx.log.info as ReturnType<typeof mock>;
    const completion = logInfo.mock.calls.find(
      (call) => call[1] === "Claude Agent SDK execution completed",
    );
    const fields = (completion as [Record<string, unknown>, string])[0];
    expect(Array.isArray(fields.modelUsage)).toBe(true);
    expect(fields.inputTokens).toBe(1500);
  });
});

// ─── cacheable prompt layout: SDK query shape (issue #134) ──────────────────

describe("executeAgent: cacheable prompt layout", () => {
  const ORIGINAL_LAYOUT = config.promptCacheLayout;
  const PARTS = { append: "STATIC-APPEND-SCAFFOLDING", userMessage: "PER-CALL-USER-MESSAGE" };

  beforeEach(() => {
    lastQueryCall = undefined;
    nextIterator = emptyIterator;
  });
  afterEach(() => {
    config.promptCacheLayout = ORIGINAL_LAYOUT;
  });

  it("splits prompt into systemPrompt.append + userMessage when flag is cacheable", async () => {
    config.promptCacheLayout = "cacheable";
    await executeAgent(baseParams({ promptParts: PARTS }));

    expect(lastQueryCall?.prompt).toBe(PARTS.userMessage);
    const sp = lastQueryCall?.options.systemPrompt as {
      type: string;
      preset: string;
      append?: string;
      excludeDynamicSections?: boolean;
    };
    expect(sp.type).toBe("preset");
    expect(sp.preset).toBe("claude_code");
    expect(sp.append).toBe(PARTS.append);
    expect(sp.excludeDynamicSections).toBe(true);
  });

  it("keeps the legacy prompt and bare preset when the flag is legacy", async () => {
    config.promptCacheLayout = "legacy";
    await executeAgent(baseParams({ promptParts: PARTS }));

    expect(lastQueryCall?.prompt).toBe("test prompt");
    const sp = lastQueryCall?.options.systemPrompt as { append?: string };
    expect(sp.append).toBeUndefined();
  });

  it("falls back to legacy when the flag is cacheable but no promptParts are passed", async () => {
    config.promptCacheLayout = "cacheable";
    await executeAgent(baseParams());

    expect(lastQueryCall?.prompt).toBe("test prompt");
    const sp = lastQueryCall?.options.systemPrompt as { append?: string };
    expect(sp.append).toBeUndefined();
  });
});

// ─── per-tool-call events: agent.tool.* (issue #237) ────────────────────────

/**
 * Drive the SDK message loop with a scripted sequence so the executor pairs
 * tool_use → tool_result by tool_use_id. Each entry is yielded verbatim as one
 * iterator step; the final `result` message ends the run.
 */
function scriptedIterator(messages: unknown[]): AsyncIterableIterator<unknown> {
  let i = 0;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: () => {
      if (i >= messages.length) {
        return Promise.resolve({ value: undefined, done: true });
      }
      const value = messages[i];
      i += 1;
      return Promise.resolve({ value, done: false });
    },
    return: () => Promise.resolve({ value: undefined, done: true }),
  } as AsyncIterableIterator<unknown>;
}

function findToolEvents(
  logCalls: { info: ReturnType<typeof mock>; warn: ReturnType<typeof mock> },
  event: string,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const call of [...logCalls.info.mock.calls, ...logCalls.warn.mock.calls]) {
    const fields = call[0] as Record<string, unknown> | undefined;
    if (fields?.["event"] === event) out.push(fields);
  }
  return out;
}

describe("executeAgent: per-tool-call events (#237)", () => {
  beforeEach(() => {
    lastQueryCall = undefined;
    nextIterator = emptyIterator;
  });

  it("emits started then completed paired by tool_use_id, carrying name + duration + is_error", async () => {
    nextIterator = (): AsyncIterableIterator<unknown> =>
      scriptedIterator([
        {
          type: "assistant",
          message: {
            model: "claude-opus-4-7",
            stop_reason: "tool_use",
            content: [
              { type: "tool_use", id: "toolu_a", name: "Bash", input: { command: "ls" } },
              { type: "tool_use", id: "toolu_b", name: "Read", input: { file_path: "/x" } },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "toolu_a", is_error: false, content: "out" },
              { type: "tool_result", tool_use_id: "toolu_b", is_error: true, content: "boom" },
            ],
          },
        },
        { type: "result", subtype: "success", num_turns: 1 },
      ]);

    const params = baseParams();
    await executeAgent(params);

    const logInfo = params.ctx.log.info as ReturnType<typeof mock>;
    const logWarn = params.ctx.log.warn as ReturnType<typeof mock>;
    const calls = { info: logInfo, warn: logWarn };

    const started = findToolEvents(calls, "agent.tool.started");
    expect(started.map((e) => e["tool_use_id"])).toEqual(["toolu_a", "toolu_b"]);
    expect(started.map((e) => e["tool"])).toEqual(["Bash", "Read"]);
    // No input bodies must leak into the started events.
    for (const e of started)
      expect(Object.keys(e).sort()).toEqual(["event", "tool", "tool_use_id"]);

    const completed = findToolEvents(calls, "agent.tool.completed");
    expect(completed.map((e) => e["tool_use_id"])).toEqual(["toolu_a", "toolu_b"]);
    expect(completed.map((e) => e["tool"])).toEqual(["Bash", "Read"]);
    expect(completed.map((e) => e["is_error"])).toEqual([false, true]);
    for (const e of completed) {
      expect(typeof e["tool_duration_ms"]).toBe("number");
      // No output bodies must leak into the completed events.
      expect(Object.keys(e).sort()).toEqual([
        "event",
        "is_error",
        "tool",
        "tool_duration_ms",
        "tool_use_id",
      ]);
    }

    // No orphans → no timed_out events.
    expect(findToolEvents(calls, "agent.tool.timed_out")).toHaveLength(0);
  });

  it("emits timed_out for a tool_use that never received its tool_result", async () => {
    nextIterator = (): AsyncIterableIterator<unknown> =>
      scriptedIterator([
        {
          type: "assistant",
          message: {
            stop_reason: "tool_use",
            content: [{ type: "tool_use", id: "toolu_hang", name: "Bash", input: {} }],
          },
        },
        // run terminates with the tool still in flight (no user tool_result)
        { type: "result", subtype: "success", num_turns: 1 },
      ]);

    const params = baseParams();
    await executeAgent(params);

    const calls = {
      info: params.ctx.log.info as ReturnType<typeof mock>,
      warn: params.ctx.log.warn as ReturnType<typeof mock>,
    };
    expect(findToolEvents(calls, "agent.tool.completed")).toHaveLength(0);
    const timedOut = findToolEvents(calls, "agent.tool.timed_out");
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0]?.["tool_use_id"]).toBe("toolu_hang");
    expect(timedOut[0]?.["tool"]).toBe("Bash");
    expect(typeof timedOut[0]?.["delta_ms"]).toBe("number");
  });

  it("drains pending tools as timed_out on the wall-clock abort path", async () => {
    config.agentTimeoutMs = 25;

    nextIterator = (): AsyncIterableIterator<unknown> => {
      let started = false;
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next: () => {
          if (!started) {
            started = true;
            return Promise.resolve({
              value: {
                type: "assistant",
                message: {
                  stop_reason: "tool_use",
                  content: [{ type: "tool_use", id: "toolu_slow", name: "Bash", input: {} }],
                },
              },
              done: false,
            });
          }
          // After yielding the tool_use, block until the wall-clock abort fires.
          const controller = lastQueryCall?.options.abortController;
          if (controller === undefined) {
            return Promise.reject(new Error("controller missing from query options"));
          }
          return new Promise((_, reject) => {
            const fire = (): void => {
              const reason = controller.signal.reason;
              reject(reason instanceof Error ? reason : new Error("aborted"));
            };
            if (controller.signal.aborted) {
              fire();
            } else {
              controller.signal.addEventListener("abort", fire, { once: true });
            }
          });
        },
        return: () => Promise.resolve({ value: undefined, done: true }),
      } as AsyncIterableIterator<unknown>;
    };

    const params = baseParams();
    const result = await executeAgent(params);
    config.agentTimeoutMs = ORIGINAL_TIMEOUT;

    expect(result.success).toBe(false);
    const calls = {
      info: params.ctx.log.info as ReturnType<typeof mock>,
      warn: params.ctx.log.warn as ReturnType<typeof mock>,
    };
    const timedOut = findToolEvents(calls, "agent.tool.timed_out");
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0]?.["tool_use_id"]).toBe("toolu_slow");
  });
});

// ─── filesystem settings isolation: settingSources [] (issue #191) ──────────
// cwd is the cloned PR head (checkout.ts), which can carry an attacker's
// .claude/settings.json. Omitting settingSources makes the SDK load
// user/project/local filesystem settings by default, so a SessionStart shell
// hook there would fire in this subprocess with the installation token in env,
// before any tool gate. Deep equality (not just "defined") catches both removal
// and a quiet flip to a permissive value like ["user"].

describe("executeAgent: filesystem settings isolation", () => {
  beforeEach(() => {
    lastQueryCall = undefined;
    nextIterator = emptyIterator;
  });

  it("passes settingSources [] so SDK ignores cwd .claude/settings.json", async () => {
    await executeAgent(baseParams());

    expect(lastQueryCall).toBeDefined();
    const opts = lastQueryCall?.options as { settingSources?: string[] };
    expect(opts.settingSources).toEqual([]);
  });
});
