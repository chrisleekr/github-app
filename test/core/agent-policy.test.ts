/**
 * Covers what the handler tests structurally cannot: they either set no
 * `timeoutMs` or wait for the deadline, so `dispose()` is never exercised
 * there, and a leaked timer holds Bun's event loop open.
 */

import { describe, expect, it } from "bun:test";

import { applyAgentPolicy } from "../../src/core/agent-policy";

/** Real timers, generous margin: no fake-timer shim, no new dependency. */
const DEADLINE_MS = 20;
const PAST_DEADLINE_MS = 200;

async function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("applyAgentPolicy", () => {
  it("dispose() cancels the deadline so a fast run never aborts", async () => {
    const applied = applyAgentPolicy({
      baseAllowedTools: ["Read"],
      policy: { timeoutMs: DEADLINE_MS },
    });
    const { signal } = applied.options;
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);

    applied.dispose();
    await sleep(PAST_DEADLINE_MS);

    expect(signal?.aborted).toBe(false);
  });

  it("dispose() is idempotent", async () => {
    const applied = applyAgentPolicy({
      baseAllowedTools: ["Read"],
      policy: { timeoutMs: DEADLINE_MS },
    });
    applied.dispose();
    applied.dispose();
    await sleep(PAST_DEADLINE_MS);

    expect(applied.options.signal?.aborted).toBe(false);
  });

  it("dispose() is a no-op and no signal is set when there is no timeoutMs", () => {
    const applied = applyAgentPolicy({ baseAllowedTools: ["Read"] });

    // `exactOptionalPropertyTypes`: absent, not `undefined`-valued.
    expect(Object.hasOwn(applied.options, "signal")).toBe(false);
    expect(() => {
      applied.dispose();
    }).not.toThrow();
  });

  it("does not alias the caller's base tool array", () => {
    const base = ["Read", "Bash"];
    const applied = applyAgentPolicy({ baseAllowedTools: base });

    applied.options.allowedTools.push("Write");

    expect(base).toEqual(["Read", "Bash"]);
  });

  it("does not alias the caller's base tool array when extras widen it", () => {
    const base = ["Read", "Bash"];
    const applied = applyAgentPolicy({
      baseAllowedTools: base,
      policy: { extraAllowedTools: ["WebFetch"] },
    });

    expect(applied.options.allowedTools).toEqual(["Read", "Bash", "WebFetch"]);
    applied.options.allowedTools.push("Write");
    expect(base).toEqual(["Read", "Bash"]);
  });

  it("leaves the caller's own cancellation intact after dispose()", async () => {
    const caller = new AbortController();
    const applied = applyAgentPolicy({
      baseAllowedTools: ["Read"],
      policy: { timeoutMs: DEADLINE_MS },
      signal: caller.signal,
    });
    const composed = applied.options.signal;
    expect(composed).toBeDefined();

    applied.dispose();
    await sleep(PAST_DEADLINE_MS);
    expect(composed?.aborted).toBe(false);

    const cancel = new Error("daemon cancelled the run");
    caller.abort(cancel);

    expect(composed?.aborted).toBe(true);
    expect(composed?.reason).toBe(cancel);
  });
});
