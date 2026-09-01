/**
 * Unit tests for the auto-review guards (work item #1).
 *
 * These four helpers decide whether the bot spends a full agent run on a push.
 * The handler suite (`pull-request-auto-review.test.ts`) replaces this whole
 * module with `mock.module`, so without this file the real branches never
 * execute. Each one is advisory and MUST fail open: a missing review is a worse
 * failure than a redundant one, and a guard that wrongly returned "already
 * reviewed" would suppress reviews silently and indefinitely.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Logger } from "pino";

// ─── Mocked downstream surfaces ──────────────────────────────────────────

let valkeyClient: { send: ReturnType<typeof mock> } | null = null;
let valkeyHealthy = true;
void mock.module("../../src/orchestrator/valkey", () => ({
  getValkeyClient: () => valkeyClient,
  isValkeyHealthy: () => valkeyHealthy,
}));

let resolvedSelfLogin: string | null = "chrisleekr-bot[bot]";
void mock.module("../../src/utils/bot-identity", () => ({
  resolveSelfLogin: () => Promise.resolve(resolvedSelfLogin),
}));

const { computeDiffFingerprint, isSelfPush, matchesLastReviewed, recordReviewedFingerprint } =
  await import("../../src/webhook/auto-review-guard");

const log = {
  info: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  error: () => undefined,
} as unknown as Logger;

/** `paginate` is the only octokit surface these helpers touch. */
function octokitReturning(files: unknown): OctokitArg {
  return {
    paginate: mock(() => (files instanceof Error ? Promise.reject(files) : Promise.resolve(files))),
    rest: { pulls: { listFiles: () => undefined } },
  } as unknown as OctokitArg;
}

function file(filename: string, sha: string, status = "modified") {
  return { filename, sha, status };
}

beforeEach(() => {
  valkeyClient = null;
  valkeyHealthy = true;
  resolvedSelfLogin = "chrisleekr-bot[bot]";
});

describe("isSelfPush", () => {
  it("recognises our own push by login", async () => {
    // This is the ONLY thing breaking review -> resolve -> push -> review:
    // `resolve` deliberately does not filter review comments by author.
    expect(await isSelfPush({ login: "chrisleekr-bot[bot]", type: "Bot" })).toBe(true);
  });

  it("does not claim a third-party bot's push as ours", async () => {
    expect(await isSelfPush({ login: "renovate[bot]", type: "Bot" })).toBe(false);
  });

  it("does not claim a human's push as ours", async () => {
    expect(await isSelfPush({ login: "chrisleekr", type: "User" })).toBe(false);
  });

  it("fails open to 'not us' when the self-login cannot be resolved", async () => {
    resolvedSelfLogin = null;
    expect(await isSelfPush({ login: "chrisleekr-bot[bot]", type: "Bot" })).toBe(false);
  });
});

describe("computeDiffFingerprint", () => {
  it("is stable regardless of the order listFiles returns", async () => {
    // The `.sort()` is load-bearing: GitHub does not promise an order, and an
    // order-sensitive hash would treat every push as a changed diff.
    const a = await computeDiffFingerprint(
      octokitReturning([file("a.ts", "sha-a"), file("b.ts", "sha-b")]),
      "acme",
      "widgets",
      7,
      log,
    );
    const b = await computeDiffFingerprint(
      octokitReturning([file("b.ts", "sha-b"), file("a.ts", "sha-a")]),
      "acme",
      "widgets",
      7,
      log,
    );
    expect(a).toBe(b);
    expect(a).not.toBeNull();
  });

  it("changes when a blob changes, which is what makes a rebase detectable", async () => {
    const before = await computeDiffFingerprint(
      octokitReturning([file("a.ts", "sha-a")]),
      "acme",
      "widgets",
      7,
      log,
    );
    const after = await computeDiffFingerprint(
      octokitReturning([file("a.ts", "sha-DIFFERENT")]),
      "acme",
      "widgets",
      7,
      log,
    );
    expect(before).not.toBe(after!);
  });

  it("changes when only a file's status changes", async () => {
    const asModified = await computeDiffFingerprint(
      octokitReturning([file("a.ts", "sha-a", "modified")]),
      "acme",
      "widgets",
      7,
      log,
    );
    const asAdded = await computeDiffFingerprint(
      octokitReturning([file("a.ts", "sha-a", "added")]),
      "acme",
      "widgets",
      7,
      log,
    );
    expect(asModified).not.toBe(asAdded!);
  });

  it("returns null for an empty diff", async () => {
    expect(
      await computeDiffFingerprint(octokitReturning([]), "acme", "widgets", 7, log),
    ).toBeNull();
  });

  it("returns null at GitHub's 3000-file listFiles cap, where the list truncates", async () => {
    // Above the cap the response no longer represents the whole diff, so a hash
    // of it would be a hash of an arbitrary prefix.
    const many = Array.from({ length: 3000 }, (_, i) =>
      file(`f${String(i)}.ts`, `sha-${String(i)}`),
    );
    expect(
      await computeDiffFingerprint(octokitReturning(many), "acme", "widgets", 7, log),
    ).toBeNull();
  });

  it("returns null when listFiles throws, rather than propagating", async () => {
    expect(
      await computeDiffFingerprint(octokitReturning(new Error("502")), "acme", "widgets", 7, log),
    ).toBeNull();
  });
});

describe("matchesLastReviewed", () => {
  it("returns false when Valkey is not configured", async () => {
    valkeyClient = null;
    expect(await matchesLastReviewed("acme", "widgets", 7, "fp", log)).toBe(false);
  });

  it("returns false when Valkey is configured but disconnected", async () => {
    // Gated on health for the same reason `claimDelivery` is: Bun's RedisClient
    // queues offline commands, so a GET here would block instead of failing open.
    const send = mock(() => Promise.resolve("fp"));
    valkeyClient = { send };
    valkeyHealthy = false;

    expect(await matchesLastReviewed("acme", "widgets", 7, "fp", log)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("returns true only when the stored fingerprint matches exactly", async () => {
    valkeyClient = { send: mock(() => Promise.resolve("fp-current")) };
    expect(await matchesLastReviewed("acme", "widgets", 7, "fp-current", log)).toBe(true);

    valkeyClient = { send: mock(() => Promise.resolve("fp-older")) };
    expect(await matchesLastReviewed("acme", "widgets", 7, "fp-current", log)).toBe(false);
  });

  it("returns false when the read throws, never true", async () => {
    // The dangerous direction: a spurious `true` suppresses reviews silently.
    valkeyClient = { send: mock(() => Promise.reject(new Error("connection reset"))) };
    expect(await matchesLastReviewed("acme", "widgets", 7, "fp", log)).toBe(false);
  });

  it("keys per pull request, not per repo", async () => {
    const send = mock(() => Promise.resolve(null));
    valkeyClient = { send };
    await matchesLastReviewed("acme", "widgets", 7, "fp", log);

    const key = (send.mock.calls[0] as unknown as [string, string[]])[1][0];
    expect(key).toBe("autoreview:fp:acme/widgets#7");
  });
});

describe("recordReviewedFingerprint", () => {
  it("writes the fingerprint with a TTL", async () => {
    const send = mock(() => Promise.resolve("OK"));
    valkeyClient = { send };

    await recordReviewedFingerprint("acme", "widgets", 7, "fp-current", log);

    const [cmd, args] = send.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe("SET");
    expect(args[0]).toBe("autoreview:fp:acme/widgets#7");
    expect(args[1]).toBe("fp-current");
    expect(args[2]).toBe("EX");
    expect(args[3]).toBe("2592000"); // 30 days
  });

  it("is a no-op when Valkey is unavailable", async () => {
    valkeyClient = null;
    await recordReviewedFingerprint("acme", "widgets", 7, "fp", log);
    // Reaching here without throwing is the assertion.
    expect(true).toBe(true);
  });

  it("swallows a write failure, which only costs one re-review", async () => {
    valkeyClient = { send: mock(() => Promise.reject(new Error("OOM"))) };
    await recordReviewedFingerprint("acme", "widgets", 7, "fp", log);
    expect(true).toBe(true);
  });
});
