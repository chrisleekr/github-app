import { describe, expect, it } from "bun:test";

import {
  GITHUB_API_LOG_EVENTS,
  GithubApiLogFieldsSchema,
  ObservableOctokit,
  RATE_LIMIT_LOW_WATER,
  rateLimitFields,
} from "../../src/utils/octokit-observability";

// A fetch stub returning a fixed status/headers/body, so the hooks run against
// a real octokit request pipeline without network. retry+throttle are disabled
// so a 4xx does not trigger real backoff.
function octokitWithFetch(status: number, headers: Record<string, string>, body: unknown) {
  const fetch = (): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      }),
    );
  return new ObservableOctokit({
    auth: "test-token",
    retry: { enabled: false },
    throttle: { enabled: false },
    request: { fetch },
  });
}

const NOW_S = 1_000_000;

describe("rateLimitFields (#170)", () => {
  it("returns a request event with parsed quota when remaining is healthy", () => {
    const f = rateLimitFields(
      200,
      {
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "4800",
        "x-ratelimit-reset": String(NOW_S + 1800),
        "x-ratelimit-resource": "core",
      },
      "GET /repos/{owner}/{repo}/issues",
      NOW_S,
    );
    expect(f).not.toBeNull();
    expect(f?.event).toBe(GITHUB_API_LOG_EVENTS.request);
    expect(f?.rate_limit_limit).toBe(5000);
    expect(f?.rate_limit_remaining).toBe(4800);
    expect(f?.rate_limit_reset_in_s).toBe(1800);
    expect(f?.rate_limit_resource).toBe("core");
  });

  it("flips to rate_limit_low once remaining drops below the floor", () => {
    const f = rateLimitFields(
      200,
      { "x-ratelimit-remaining": String(RATE_LIMIT_LOW_WATER - 1) },
      "GET /x",
      NOW_S,
    );
    expect(f?.event).toBe(GITHUB_API_LOG_EVENTS.rateLimitLow);
    expect(f?.rate_limit_remaining).toBe(RATE_LIMIT_LOW_WATER - 1);
  });

  it("treats exactly the floor as healthy (boundary)", () => {
    const f = rateLimitFields(
      200,
      { "x-ratelimit-remaining": String(RATE_LIMIT_LOW_WATER) },
      "GET /x",
      NOW_S,
    );
    expect(f?.event).toBe(GITHUB_API_LOG_EVENTS.request);
  });

  it("returns null when the response carries no rate-limit headers", () => {
    expect(
      rateLimitFields(200, { "content-type": "application/json" }, "GET /x", NOW_S),
    ).toBeNull();
  });

  it("omits optional fields when their headers are absent", () => {
    const f = rateLimitFields(200, { "x-ratelimit-remaining": "100" }, "GET /x", NOW_S);
    expect(f).not.toBeNull();
    expect(f?.rate_limit_limit).toBeUndefined();
    expect(f?.rate_limit_reset_in_s).toBeUndefined();
    expect(f?.rate_limit_resource).toBeUndefined();
  });
});

describe("GithubApiLogFieldsSchema (#170)", () => {
  it("accepts a request line and a rate-limit-warning line", () => {
    expect(
      GithubApiLogFieldsSchema.safeParse({
        event: GITHUB_API_LOG_EVENTS.request,
        route: "GET /x",
        status: 200,
        rate_limit_remaining: 4800,
      }).success,
    ).toBe(true);
    expect(
      GithubApiLogFieldsSchema.safeParse({
        event: GITHUB_API_LOG_EVENTS.rateLimitWarning,
        route: "POST /x",
        status: 429,
        retry_after_s: 60,
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown field (strict pins drift)", () => {
    expect(
      GithubApiLogFieldsSchema.safeParse({
        event: GITHUB_API_LOG_EVENTS.request,
        route: "GET /x",
        status: 200,
        ratelimit_remaining: 4800, // typo'd field name
      }).success,
    ).toBe(false);
  });
});

describe("installRateLimitHooks contract (#170)", () => {
  it("after-hook preserves the response (handler return value is ignored)", async () => {
    const octokit = octokitWithFetch(
      200,
      { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4999", "x-ratelimit-reset": "0" },
      { login: "octocat" },
    );
    const res = await octokit.request("GET /user");
    // If the after-hook dropped the response, status/data would be undefined.
    expect(res.status).toBe(200);
    expect((res.data as { login: string }).login).toBe("octocat");
  });

  it("error-hook rethrows so the caller still sees the error", async () => {
    const octokit = octokitWithFetch(
      429,
      { "retry-after": "60" },
      { message: "API rate limit exceeded" },
    );
    let caught: { status?: number } | undefined;
    try {
      await octokit.request("GET /user");
    } catch (e) {
      caught = e as { status?: number };
    }
    // If the error-hook had returned instead of rethrowing, the error would be
    // swallowed and `caught` would stay undefined.
    expect(caught?.status).toBe(429);
  });
});
