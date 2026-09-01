import { afterEach, describe, expect, it } from "bun:test";

import type { LLMClient, LLMCreateParams } from "../../src/ai/llm-client";
import {
  _setLlmScannerClientForTests,
  detectSecretsWithLlm,
  scanForSecretsWithLlm,
} from "../../src/utils/llm-output-scanner";
import { expectToReject } from "./assertions";

const USAGE = { inputTokens: 0, outputTokens: 0 };

/** Records every request the scanner issues so the mode contract is assertable. */
function stubScanner(text: string): LLMCreateParams[] {
  const calls: LLMCreateParams[] = [];
  const client: LLMClient = {
    provider: "anthropic",
    create: (params) => {
      calls.push(params);
      return Promise.resolve({ text, usage: USAGE, model: "stub" });
    },
  };
  _setLlmScannerClientForTests(client);
  return calls;
}

const BIG_BODY = "x".repeat(50_000);

afterEach(() => {
  _setLlmScannerClientForTests(undefined);
});

describe("llm output scanner scan modes", () => {
  it("caps detect-mode output regardless of body size", async () => {
    const calls = stubScanner(JSON.stringify({ contains_secret: false, kinds: [] }));

    const small = await detectSecretsWithLlm("short body", { timeoutMs: 1_000 });
    await detectSecretsWithLlm(BIG_BODY, { timeoutMs: 1_000 });

    expect(small.containsSecret).toBe(false);
    // Flat output budget is the whole point: a fail-closed caller must not have
    // its per-call deadline scale with the payload it is scanning.
    expect(calls.map((c) => c.maxTokens)).toEqual([512, 512]);
  });

  it("omits redacted_body from the detect-mode contract", async () => {
    const calls = stubScanner(JSON.stringify({ contains_secret: true, kinds: ["JWT"] }));

    const result = await detectSecretsWithLlm("body", { timeoutMs: 1_000 });

    expect(result).toEqual({ containsSecret: true, matchCount: 1, kinds: ["JWT"] });
    expect(calls[0]?.system).not.toContain("redacted_body");
  });

  it("still asks redact mode to echo the body, sized to the input", async () => {
    const calls = stubScanner(
      JSON.stringify({ contains_secret: false, kinds: [], redacted_body: "body" }),
    );

    const result = await scanForSecretsWithLlm("body", { timeoutMs: 1_000 });

    expect(result.redactedBody).toBe("body");
    expect(calls[0]?.system).toContain("redacted_body");
    expect(calls[0]?.maxTokens).toBe(512);
  });

  it("scales redact-mode output with the body, which detect mode avoids", async () => {
    const calls = stubScanner(
      JSON.stringify({ contains_secret: false, kinds: [], redacted_body: BIG_BODY }),
    );

    await scanForSecretsWithLlm(BIG_BODY, { timeoutMs: 1_000 });

    expect(calls[0]?.maxTokens).toBe(8_000);
  });

  it("does not retry a timeout", async () => {
    const calls: LLMCreateParams[] = [];
    const client: LLMClient = {
      provider: "anthropic",
      create: (params) => {
        calls.push(params);
        // Never settles, so only the timeout can end the call.
        return new Promise(() => undefined);
      },
    };
    _setLlmScannerClientForTests(client);

    await expectToReject(detectSecretsWithLlm("body", { timeoutMs: 10 }), "timed out");
    expect(calls).toHaveLength(1);
  });
});
