/**
 * Unit tests for self-login resolution (work item #1).
 *
 * The contract that matters: under an App installation token this resolves
 * WITHOUT an API call. `GET /user` requires user-to-server auth and returns 403
 * for installation tokens, so a version that asked would burn a failed request
 * per push and still resolve to null, silently disabling the self-push guard
 * that stops review -> resolve -> push -> review from looping.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

interface TestConfig {
  botAppLogin: string;
  githubPersonalAccessToken?: string;
}

const testConfig: TestConfig = {
  botAppLogin: "chrisleekr-bot[bot]",
};
void mock.module("../../src/config", () => ({
  config: {
    get botAppLogin() {
      return testConfig.botAppLogin;
    },
    get githubPersonalAccessToken() {
      return testConfig.githubPersonalAccessToken;
    },
  },
}));

// The PAT path builds its own client rather than accepting the caller's, so the
// constructor is what has to be intercepted.
const getAuthenticated = mock(() => Promise.resolve({ data: { login: "chrisleekr" } }));
void mock.module("octokit", () => ({
  Octokit: class {
    rest = { users: { getAuthenticated } };
  },
}));

const { __resetBotIdentityCache, resolveSelfLogin } = await import("../../src/utils/bot-identity");

beforeEach(() => {
  __resetBotIdentityCache();
  testConfig.botAppLogin = "chrisleekr-bot[bot]";
  delete testConfig.githubPersonalAccessToken;
  getAuthenticated.mockClear();
  getAuthenticated.mockImplementation(() => Promise.resolve({ data: { login: "chrisleekr" } }));
});

describe("resolveSelfLogin", () => {
  it("returns the App bot login with no API call under App auth", async () => {
    expect(await resolveSelfLogin()).toBe("chrisleekr-bot[bot]");
    // The load-bearing assertion: installation tokens 403 on `GET /user`, so
    // asking would cost a failed request and yield null.
    expect(getAuthenticated).not.toHaveBeenCalled();
  });

  it("honours a BOT_APP_LOGIN override, since dev and prod App slugs differ", async () => {
    testConfig.botAppLogin = "chrisleekr-bot-dev[bot]";
    expect(await resolveSelfLogin()).toBe("chrisleekr-bot-dev[bot]");
  });

  it("resolves the PAT owner's login when a PAT is configured", async () => {
    testConfig.githubPersonalAccessToken = "ghp_example";
    expect(await resolveSelfLogin()).toBe("chrisleekr");
    expect(getAuthenticated).toHaveBeenCalledTimes(1);
  });

  it("memoises the PAT lookup and collapses concurrent callers onto one request", async () => {
    testConfig.githubPersonalAccessToken = "ghp_example";

    const [a, b, c] = await Promise.all([
      resolveSelfLogin(),
      resolveSelfLogin(),
      resolveSelfLogin(),
    ]);

    expect([a, b, c]).toEqual(["chrisleekr", "chrisleekr", "chrisleekr"]);
    expect(getAuthenticated).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache a failed lookup, so one 500 cannot disable the guard for the process", async () => {
    testConfig.githubPersonalAccessToken = "ghp_example";
    getAuthenticated.mockImplementation(() => Promise.reject(new Error("500")));

    expect(await resolveSelfLogin()).toBeNull();

    getAuthenticated.mockImplementation(() => Promise.resolve({ data: { login: "chrisleekr" } }));
    expect(await resolveSelfLogin()).toBe("chrisleekr");
    expect(getAuthenticated).toHaveBeenCalledTimes(2);
  });
});
