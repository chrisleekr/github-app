import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";
import type { Logger } from "pino";

import {
  __resetRepoConfigCaches,
  fetchRepoConfig,
  formatConfigIssues,
} from "../../src/repo-config/fetcher";
import { githubAppConfigSchema } from "../../src/repo-config/schema";

const log = {
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  error: () => undefined,
} as unknown as Logger;

const PATH = ".github-app.yaml";
const VALID_YAML = "version: 1\nenabled: true\n";

function b64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

function fileResponse(yaml: string, etag?: string): unknown {
  return {
    data: { type: "file", content: b64(yaml), sha: "abc123" },
    headers: etag !== undefined ? { etag } : {},
  };
}

function httpError(status: number): Error & { status: number } {
  const err = new Error(`HTTP ${String(status)}`) as Error & { status: number };
  err.status = status;
  return err;
}

/** Octokit whose `repos.getContent` is the supplied mock. */
function octokitWith(getContent: unknown): Octokit {
  return { rest: { repos: { getContent } } } as unknown as Octokit;
}

function fetchFrom(getContent: unknown, repo = "widgets"): ReturnType<typeof fetchRepoConfig> {
  return fetchRepoConfig({
    octokit: octokitWith(getContent),
    owner: "acme",
    repo,
    path: PATH,
    log,
  });
}

describe("fetchRepoConfig", () => {
  beforeEach(() => {
    __resetRepoConfigCaches();
  });

  it("never passes a ref, so only the default branch is ever read", async () => {
    // Load-bearing invariant: a `ref` here would let a pull request grant
    // itself new permissions by editing the file on its own head branch.
    const getContent = mock((_args: { ref?: string }) => Promise.resolve(fileResponse(VALID_YAML)));
    const result = await fetchFrom(getContent);

    expect(result.kind).toBe("ok");
    expect(getContent).toHaveBeenCalledTimes(1);
    expect(getContent.mock.calls[0]?.[0]).not.toHaveProperty("ref");
  });

  it("returns absent on 404 and negative-caches it", async () => {
    const getContent = mock(() => Promise.reject(httpError(404)));
    expect((await fetchFrom(getContent)).kind).toBe("absent");
    expect((await fetchFrom(getContent)).kind).toBe("absent");
    expect(getContent).toHaveBeenCalledTimes(1); // second call served from the negative cache
  });

  it("returns absent on a transient non-404 error without caching it", async () => {
    // A GitHub outage must degrade to defaults, not to "bot disabled", and
    // the next dispatch must retry rather than serve a stale absent.
    const getContent = mock(() => Promise.reject(httpError(500)));
    expect((await fetchFrom(getContent)).kind).toBe("absent");
    expect((await fetchFrom(getContent)).kind).toBe("absent");
    expect(getContent).toHaveBeenCalledTimes(2);
  });

  it("sends if-none-match on a repeat fetch and serves the cached result on 304", async () => {
    let call = 0;
    const getContent = mock((args: { headers?: Record<string, string> }) => {
      call += 1;
      if (call === 1) return Promise.resolve(fileResponse(VALID_YAML, 'W/"tag1"'));
      expect(args.headers?.["if-none-match"]).toBe('W/"tag1"');
      return Promise.reject(httpError(304));
    });

    const first = await fetchFrom(getContent);
    const second = await fetchFrom(getContent);
    expect(first).toEqual(second);
    expect(second.kind).toBe("ok");
    expect(getContent).toHaveBeenCalledTimes(2);
  });

  it("caches an invalid result too, so a broken file is not re-parsed on every dispatch", async () => {
    let call = 0;
    const getContent = mock(() => {
      call += 1;
      if (call === 1) return Promise.resolve(fileResponse("version: 2\n", 'W/"bad"'));
      return Promise.reject(httpError(304));
    });

    const first = await fetchFrom(getContent);
    expect(first.kind).toBe("invalid");
    expect((await fetchFrom(getContent)).kind).toBe("invalid");
  });

  it("returns invalid when the path is a directory, not a file", async () => {
    const getContent = mock(() => Promise.resolve({ data: [{ type: "file" }], headers: {} }));
    const result = await fetchFrom(getContent);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.message).toContain("not a file");
  });

  it("returns invalid on a YAML parse failure", async () => {
    const getContent = mock(() => Promise.resolve(fileResponse("version: 1\n  bad: [unclosed")));
    expect((await fetchFrom(getContent)).kind).toBe("invalid");
  });

  it("evicts the oldest entry once the cache is full", async () => {
    // 1001 distinct repos: the first must have been evicted, so its repeat
    // fetch is a full request rather than a conditional one.
    const seen: (string | undefined)[] = [];
    const getContent = mock((args: { headers?: Record<string, string> }) => {
      seen.push(args.headers?.["if-none-match"]);
      return Promise.resolve(fileResponse(VALID_YAML, 'W/"tag"'));
    });
    for (let i = 0; i <= 1000; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- ordering matters for FIFO eviction
      await fetchFrom(getContent, `repo-${String(i)}`);
    }
    seen.length = 0;
    await fetchFrom(getContent, "repo-0");
    expect(seen[0]).toBeUndefined();
  });
});

describe("formatConfigIssues", () => {
  it("renders path and message, capped at five issues", () => {
    const parsed = githubAppConfigSchema.safeParse({
      version: 1,
      workflows: { revue: {} },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const rendered = formatConfigIssues(parsed.error.issues);
    expect(rendered).toContain("workflows");
    expect(rendered.split(";").length).toBeLessThanOrEqual(6); // 5 issues + the "(+N more)" tail
  });
});
