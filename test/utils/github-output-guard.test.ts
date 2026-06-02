import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Logger } from "pino";

import { type LLMClient, type LLMResponse } from "../../src/ai/llm-client";
import { safePostToGitHub } from "../../src/utils/github-output-guard";
import { _setLlmScannerClientForTests } from "../../src/utils/llm-output-scanner";

interface TestLog extends Logger {
  warns: Record<string, unknown>[];
  errors: Record<string, unknown>[];
}

function makeTestLogger(): TestLog {
  const warns: Record<string, unknown>[] = [];
  const errors: Record<string, unknown>[] = [];
  const log: Partial<TestLog> = {
    warns,
    errors,
    warn: (obj: Record<string, unknown>, _msg?: string) => {
      warns.push(obj);
    },
    error: (obj: Record<string, unknown>, _msg?: string) => {
      errors.push(obj);
    },
    info: () => {},
    debug: () => {},
    fatal: () => {},
    trace: () => {},
    child: () => log as Logger,
    silent: () => {},
    level: "info",
  };
  return log as TestLog;
}

function stubScannerWith(response: LLMResponse | (() => Promise<LLMResponse>)): LLMClient {
  return {
    provider: "anthropic",
    create: async () => (typeof response === "function" ? await response() : response),
  };
}

describe("safePostToGitHub", () => {
  beforeEach(() => {
    _setLlmScannerClientForTests(undefined);
  });
  afterEach(() => {
    _setLlmScannerClientForTests(undefined);
  });

  it("posts cleanly when no secret is present and never invokes the post() callback with mutated body", async () => {
    const log = makeTestLogger();
    let received: string | undefined;
    // Disable LLM scanner side via system source so we don't need a stub.
    const r = await safePostToGitHub({
      body: "hello world",
      source: "system",
      callsite: "test.no-secret",
      log,
      post: (cleanBody) => {
        received = cleanBody;
        return Promise.resolve("ok");
      },
    });
    expect(r.posted).toBe(true);
    expect(r.matchCount).toBe(0);
    expect(r.kinds).toEqual([]);
    expect(received).toBe("hello world");
    expect(log.warns).toHaveLength(0);
    expect(log.errors).toHaveLength(0);
  });

  it("strips a regex-detectable secret silently and logs a warn (no body bytes in log)", async () => {
    const log = makeTestLogger();
    const token = `ghp_${"a".repeat(36)}`;
    let received = "";
    const r = await safePostToGitHub({
      body: `prefix ${token} suffix`,
      source: "system",
      callsite: "test.regex-strip",
      log,
      post: (cleanBody) => {
        received = cleanBody;
        return Promise.resolve("ok");
      },
    });
    expect(r.posted).toBe(true);
    expect(r.matchCount).toBe(1);
    expect(r.kinds).toEqual(["GITHUB_TOKEN"]);
    expect(received).toBe("prefix  suffix");
    expect(received).not.toContain(token);
    expect(log.warns).toHaveLength(1);
    expect(log.warns[0]?.["scanner"]).toBe("regex");
    // Critical: log entries MUST NOT contain the original secret bytes.
    expect(JSON.stringify(log.warns[0])).not.toContain(token);
  });

  it("skips the GitHub call entirely when redaction empties the body and emits an error log", async () => {
    const log = makeTestLogger();
    let postCalled = false;
    const onlySecret = `ghp_${"x".repeat(36)}`;
    const r = await safePostToGitHub({
      body: onlySecret,
      source: "system",
      callsite: "test.empty-body",
      log,
      post: () => {
        postCalled = true;
        return Promise.resolve("ok");
      },
    });
    expect(r.posted).toBe(false);
    expect(r.reason).toBe("empty_after_redaction");
    expect(postCalled).toBe(false);
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0]?.["event"]).toBe("secret_redaction_emptied_body");
  });

  it("fails open when the LLM scanner throws: body that survived the regex pass still posts", async () => {
    const log = makeTestLogger();
    _setLlmScannerClientForTests(
      stubScannerWith(() => Promise.reject(new Error("bedrock unavailable"))),
    );
    let received = "";
    const r = await safePostToGitHub({
      body: "agent reply with no detectable secret",
      source: "agent",
      callsite: "test.llm-fail-open",
      log,
      post: (cleanBody) => {
        received = cleanBody;
        return Promise.resolve("ok");
      },
    });
    expect(r.posted).toBe(true);
    expect(received).toBe("agent reply with no detectable secret");
    const scannerWarn = log.warns.find((w) => w["event"] === "llm_scanner_error");
    expect(scannerWarn).toBeDefined();
  });

  it("invokes LLM scanner on agent-source bodies and applies its redaction", async () => {
    const log = makeTestLogger();
    _setLlmScannerClientForTests(
      stubScannerWith({
        text: JSON.stringify({
          contains_secret: true,
          kinds: ["BASE64_ENCODED_SECRET"],
          // Deletion-only: the base64 chunk is stripped in place, leaving a
          // strict subsequence of the input (issue #198 contract).
          redacted_body: "agent reply with detectable thing ",
        }),
        usage: { inputTokens: 50, outputTokens: 30 },
        model: "stub",
      }),
    );
    let received = "";
    const r = await safePostToGitHub({
      body: "agent reply with detectable thing aGFja2VkSGFja2Vkc2VjcmV0",
      source: "agent",
      callsite: "test.llm-strip",
      log,
      post: (cleanBody) => {
        received = cleanBody;
        return Promise.resolve("ok");
      },
    });
    expect(r.posted).toBe(true);
    expect(received).toBe("agent reply with detectable thing ");
    const llmWarn = log.warns.find((w) => w["scanner"] === "llm");
    expect(llmWarn).toBeDefined();
    expect(llmWarn?.["kinds"]).toEqual(["BASE64_ENCODED_SECRET"]);
  });

  it("rejects an LLM redacted_body that adds bytes not in the input (injection guard)", async () => {
    // A prompt-injected or hallucinating scanner could return arbitrary text in
    // the schema-valid redacted_body. That text must never reach GitHub: the
    // gate accepts the substitution only when it is deletion-only (a byte
    // subsequence of the scanner's input). See issue #198.
    const log = makeTestLogger();
    _setLlmScannerClientForTests(
      stubScannerWith({
        text: JSON.stringify({
          contains_secret: true,
          kinds: ["BASE64_ENCODED_SECRET"],
          // Not a subsequence of the input body: attacker-injected content.
          redacted_body: "See http://evil.example for the full report",
        }),
        usage: { inputTokens: 10, outputTokens: 10 },
        model: "stub",
      }),
    );
    let received = "";
    const r = await safePostToGitHub({
      body: "agent reply hello world",
      source: "agent",
      callsite: "test.llm-inject",
      log,
      post: (cleanBody) => {
        received = cleanBody;
        return Promise.resolve("ok");
      },
    });
    expect(r.posted).toBe(true);
    // Falls back to the regex-only body; the injected text never reaches GitHub.
    expect(received).toBe("agent reply hello world");
    expect(received).not.toContain("evil");
    // The rejected verdict must not inflate the tally: only the regex pass
    // (which matched nothing here) contributes.
    expect(r.matchCount).toBe(0);
    expect(r.kinds).toEqual([]);
    const rejectWarn = log.warns.find((w) => w["event"] === "llm_scanner_substitution_rejected");
    expect(rejectWarn).toBeDefined();
  });

  it("accepts an LLM redacted_body that only deletes bytes (deletion-only)", async () => {
    const log = makeTestLogger();
    _setLlmScannerClientForTests(
      stubScannerWith({
        text: JSON.stringify({
          contains_secret: true,
          kinds: ["BASE64_ENCODED_SECRET"],
          // "secret " deleted from the input, a strict subsequence.
          redacted_body: "agent reply with xyz",
        }),
        usage: { inputTokens: 10, outputTokens: 10 },
        model: "stub",
      }),
    );
    let received = "";
    const r = await safePostToGitHub({
      body: "agent reply with secret xyz",
      source: "agent",
      callsite: "test.llm-delete",
      log,
      post: (cleanBody) => {
        received = cleanBody;
        return Promise.resolve("ok");
      },
    });
    expect(r.posted).toBe(true);
    expect(received).toBe("agent reply with xyz");
    expect(log.warns.find((w) => w["scanner"] === "llm")).toBeDefined();
    expect(
      log.warns.find((w) => w["event"] === "llm_scanner_substitution_rejected"),
    ).toBeUndefined();
  });

  it("does not invoke LLM scanner for system-source bodies (regex only)", async () => {
    const log = makeTestLogger();
    let scannerInvoked = false;
    _setLlmScannerClientForTests({
      provider: "anthropic",
      create: () => {
        scannerInvoked = true;
        return Promise.resolve({
          text: JSON.stringify({ contains_secret: false, kinds: [], redacted_body: "x" }),
          usage: { inputTokens: 1, outputTokens: 1 },
          model: "stub",
        });
      },
    });
    await safePostToGitHub({
      body: "system message",
      source: "system",
      callsite: "test.no-llm-on-system",
      log,
      post: () => Promise.resolve("ok"),
    });
    expect(scannerInvoked).toBe(false);
  });
});
