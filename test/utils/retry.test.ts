import { describe, expect, it, mock } from "bun:test";

import { retryWithBackoff } from "../../src/utils/retry";
import { makeSilentLogger } from "../factories";

const silentLog = makeSilentLogger();

function makeStatusError(status: number): Error & { status: number } {
  const err = new Error(`HTTP ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

/** Assert that a retryWithBackoff call throws the expected message in one attempt. */
async function expectImmedateThrow(
  op: () => Promise<unknown>,
  expectedMsg: string,
  expectedCalls: number,
): Promise<void> {
  let thrownMsg = "";
  try {
    await retryWithBackoff(op, { maxAttempts: 3, initialDelayMs: 1, log: silentLog });
  } catch (e) {
    thrownMsg = e instanceof Error ? e.message : String(e);
  }
  expect(thrownMsg).toContain(expectedMsg);
  expect((op as ReturnType<typeof mock>).mock.calls.length).toBe(expectedCalls);
}

describe("retryWithBackoff: success path", () => {
  it("returns the result on first successful attempt", async () => {
    const op = mock(() => Promise.resolve("ok"));
    const result = await retryWithBackoff(op, { log: silentLog });
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries on a generic error and succeeds on the second attempt", async () => {
    let calls = 0;
    const op = mock(() => {
      calls++;
      if (calls === 1) return Promise.reject(new Error("transient"));
      return Promise.resolve("recovered");
    });
    const result = await retryWithBackoff(op, {
      maxAttempts: 3,
      initialDelayMs: 1,
      log: silentLog,
    });
    expect(result).toBe("recovered");
    expect(op).toHaveBeenCalledTimes(2);
  });
});

describe("retryWithBackoff: 4xx non-retriable errors", () => {
  it("does NOT retry on 400 Bad Request", async () => {
    const op = mock(() => Promise.reject(makeStatusError(400)));
    await expectImmedateThrow(op, "HTTP 400", 1);
  });

  it("does NOT retry on 403 Forbidden", async () => {
    const op = mock(() => Promise.reject(makeStatusError(403)));
    await expectImmedateThrow(op, "HTTP 403", 1);
  });

  it("does NOT retry on 404 Not Found", async () => {
    const op = mock(() => Promise.reject(makeStatusError(404)));
    await expectImmedateThrow(op, "HTTP 404", 1);
  });

  it("does NOT retry on 422 Unprocessable Entity", async () => {
    const op = mock(() => Promise.reject(makeStatusError(422)));
    await expectImmedateThrow(op, "HTTP 422", 1);
  });
});

describe("retryWithBackoff: 429 Too Many Requests (should retry)", () => {
  it("retries on 429 and succeeds on the next attempt", async () => {
    let calls = 0;
    const op = mock(() => {
      calls++;
      if (calls === 1) return Promise.reject(makeStatusError(429));
      return Promise.resolve("after-rate-limit");
    });
    const result = await retryWithBackoff(op, {
      maxAttempts: 3,
      initialDelayMs: 1,
      log: silentLog,
    });
    expect(result).toBe("after-rate-limit");
    expect(op).toHaveBeenCalledTimes(2);
  });
});

describe("retryWithBackoff: secondary rate limit (403, should retry)", () => {
  // GitHub delivers a secondary rate limit as HTTP 403 (not 429) with a
  // "secondary rate limit" body. A status-only 4xx check misclassifies it as
  // a permanent permission error; the helper must inspect the message and
  // retry. See issue #199.
  it("retries a 403 whose message indicates a secondary rate limit", async () => {
    let calls = 0;
    const op = mock(() => {
      calls++;
      if (calls === 1) {
        const err = new Error(
          "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
        ) as Error & { status: number };
        err.status = 403;
        return Promise.reject(err);
      }
      return Promise.resolve("after-secondary-limit");
    });
    const result = await retryWithBackoff(op, {
      maxAttempts: 3,
      initialDelayMs: 1,
      log: silentLog,
    });
    expect(result).toBe("after-secondary-limit");
    expect(op).toHaveBeenCalledTimes(2);
  });

  // The negative case (a plain 403 permission error stays non-retriable) is
  // covered by "does NOT retry on 403 Forbidden" above: its message has no
  // "secondary rate limit" marker, so the message inspection does not fire.

  it("still fails fast on a 403 whose message lacks the secondary-rate-limit marker", () => {
    // A realistic permission error (longer message, no marker) must NOT be
    // retried, locking the substring match against a future over-broad change.
    const err = new Error("Resource not accessible by integration") as Error & { status: number };
    err.status = 403;
    const op = mock(() => Promise.reject(err));
    return expectImmedateThrow(op, "Resource not accessible by integration", 1);
  });
});

describe("retryWithBackoff: 5xx server errors (should retry)", () => {
  it("retries on 500 Internal Server Error", async () => {
    let calls = 0;
    const op = mock(() => {
      calls++;
      if (calls < 3) return Promise.reject(makeStatusError(500));
      return Promise.resolve("ok");
    });
    const result = await retryWithBackoff(op, {
      maxAttempts: 3,
      initialDelayMs: 1,
      log: silentLog,
    });
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(3);
  });

  it("retries on 503 Service Unavailable", async () => {
    let calls = 0;
    const op = mock(() => {
      calls++;
      if (calls === 1) return Promise.reject(makeStatusError(503));
      return Promise.resolve("ok");
    });
    const result = await retryWithBackoff(op, {
      maxAttempts: 3,
      initialDelayMs: 1,
      log: silentLog,
    });
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
  });
});

describe("retryWithBackoff: exhaustion", () => {
  it("throws the last error after all attempts are exhausted", async () => {
    const op = mock(() => Promise.reject(new Error("always fails")));
    let thrownMsg = "";
    try {
      await retryWithBackoff(op, { maxAttempts: 3, initialDelayMs: 1, log: silentLog });
    } catch (e) {
      thrownMsg = e instanceof Error ? e.message : String(e);
    }
    expect(thrownMsg).toBe("always fails");
    expect(op).toHaveBeenCalledTimes(3);
  });
});

describe("retryWithBackoff: input validation", () => {
  /**
   * Helper: invoke retryWithBackoff with an invalid option and capture the
   * rejection. Asserts that the operation was NEVER called (validation must
   * run before any attempt) and returns the caught error message.
   */
  async function expectValidationError(
    options: Parameters<typeof retryWithBackoff>[1],
    expectedSubstring: string,
  ): Promise<void> {
    const op = mock(() => Promise.resolve("should-not-run"));
    let caught: unknown;
    try {
      await retryWithBackoff(op, { log: silentLog, ...options });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(expectedSubstring);
    expect(op).toHaveBeenCalledTimes(0);
  }

  it("rejects maxAttempts: 0 with descriptive error", async () => {
    await expectValidationError({ maxAttempts: 0 }, "maxAttempts must be >= 1");
  });

  it("rejects maxAttempts: -1 with descriptive error", async () => {
    await expectValidationError({ maxAttempts: -1 }, "maxAttempts must be >= 1");
  });

  it("rejects maxAttempts: NaN (bypasses naive < comparison)", async () => {
    await expectValidationError({ maxAttempts: NaN }, "maxAttempts must be a finite number");
  });

  it("rejects maxAttempts: Infinity", async () => {
    await expectValidationError(
      { maxAttempts: Number.POSITIVE_INFINITY },
      "maxAttempts must be a finite number",
    );
  });

  it("rejects maxAttempts: 1.5 (non-integer)", async () => {
    await expectValidationError({ maxAttempts: 1.5 }, "maxAttempts must be an integer");
  });

  it("rejects initialDelayMs: NaN", async () => {
    await expectValidationError({ initialDelayMs: NaN }, "initialDelayMs must be a finite number");
  });

  it("rejects maxDelayMs: NaN", async () => {
    await expectValidationError({ maxDelayMs: NaN }, "maxDelayMs must be a finite number");
  });

  it("rejects backoffFactor: NaN", async () => {
    await expectValidationError({ backoffFactor: NaN }, "backoffFactor must be a finite number");
  });

  it("rejects backoffFactor: 0.5 (below min 1)", async () => {
    await expectValidationError({ backoffFactor: 0.5 }, "backoffFactor must be >= 1");
  });
});
