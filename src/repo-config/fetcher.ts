/**
 * Fetch and validate a repo's `.github-app.yaml`.
 *
 * **Default branch only, load-bearing.** `getContent` below is called with
 * no `ref`, which GitHub resolves to the repository's default branch. That
 * is what makes a config edit inside a pull request inert for that pull
 * request. Adding a `ref` here would silently let a PR grant itself new
 * permissions. `fetcher.test.ts` asserts the absence of the key.
 *
 * Returns a discriminated result rather than `null` so callers can tell
 * "no file" from "broken file": the scheduler treats both as skip, while
 * `effective.ts` falls open to defaults and surfaces a warning only for the
 * broken case.
 *
 * Conditional requests: an in-process ETag cache means an unchanged config
 * costs a 304 with no body re-parse. A short negative cache covers repos
 * with no config file at all, which matters now that the dispatch path
 * calls this per job, not just once per scheduler tick.
 */

import type { Octokit } from "octokit";
import type { Logger } from "pino";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";

import { redactSecrets } from "../utils/sanitize";
import { type GithubAppConfig, githubAppConfigSchema } from "./schema";

/**
 * Outcome of reading one repo's config.
 *
 * - `ok`: parsed and valid.
 * - `absent`: no file, or the read failed transiently. Callers apply their
 *   own defaults silently.
 * - `invalid`: the file exists but is unparseable or fails the schema.
 *   `message` is sanitised and safe to render into a GitHub comment.
 */
export type RepoConfigResult =
  | { readonly kind: "ok"; readonly config: GithubAppConfig; readonly sha: string }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly message: string };

export interface FetchRepoConfigInput {
  readonly octokit: Octokit;
  readonly owner: string;
  readonly repo: string;
  /** Config filename, from `config.repoConfigFile`. */
  readonly path: string;
  readonly log: Logger;
}

interface CacheEntry {
  readonly etag: string;
  readonly value: RepoConfigResult;
}

// Keyed by `${owner}/${repo}/${path}`. Per-process; multi-replica
// deployments each keep their own cache, which is fine: the cache only
// saves a body re-parse, not correctness.
const etagCache = new Map<string, CacheEntry>();

// Bound the cache so a long-lived server with churning installations cannot
// grow it without limit. Map preserves insertion order, so evicting the
// first key is a simple FIFO. One entry per (owner, repo), 1000 is ample.
const MAX_ETAG_CACHE_ENTRIES = 1_000;

// A 404 carries no ETag, so the conditional-request path cannot cover repos
// without a config file. Without this they would pay a full REST call on
// every dispatch. Short enough that adding the file takes effect promptly.
const ABSENT_TTL_MS = 60_000;
const absentCache = new Map<string, number>();

/** Evict the oldest entry when inserting a new key would exceed the cap. */
function evictIfFull(cache: Map<string, unknown>, cacheKey: string): void {
  if (cache.has(cacheKey) || cache.size < MAX_ETAG_CACHE_ENTRIES) return;
  const oldest = cache.keys().next().value;
  if (oldest !== undefined) cache.delete(oldest);
}

function statusOf(err: unknown): number | undefined {
  return typeof err === "object" && err !== null && "status" in err
    ? (err as { status?: number }).status
    : undefined;
}

const MAX_RENDERED_ISSUES = 5;
const MAX_ISSUE_LENGTH = 120;

/**
 * Make one diagnostic line safe to render into a GitHub comment.
 *
 * `redactSecrets`, not `sanitizeContent`: this is an OUTPUT path, and
 * `sanitizeContent` substitutes a `[REDACTED_GITHUB_TOKEN]` marker, which
 * invariant #2 bans outbound because it tells a prober their payload was
 * seen. `redactSecrets` deletes the bytes silently.
 *
 * Scrub BEFORE truncating. Every pattern in `redactSecrets` is minimum-length
 * bounded (`ghp_…{36,}`, `sk-ant-api03-…{80,}`, a PEM needing its END line),
 * so capping first can bisect a token and leave an unmatchable prefix that
 * the scrub then walks straight past. Whitespace collapses because the result
 * is rendered as a single line, and zod echoes the received value.
 */
function safeIssueLine(line: string): string {
  const scrubbed = redactSecrets(line).body.replace(/\s+/g, " ").trim();
  return scrubbed.length > MAX_ISSUE_LENGTH ? `${scrubbed.slice(0, MAX_ISSUE_LENGTH)}…` : scrubbed;
}

/**
 * Render zod issues into a short single-line summary safe for a GitHub
 * comment. Only the default branch's file is ever read, so this is
 * owner-trusted config rather than attacker input, but zod echoes the
 * received value verbatim, so it still gets scrubbed and capped.
 */
export function formatConfigIssues(issues: readonly z.core.$ZodIssue[]): string {
  const rendered = issues.slice(0, MAX_RENDERED_ISSUES).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return safeIssueLine(`${path}: ${issue.message}`);
  });
  const extra = issues.length - rendered.length;
  return extra > 0 ? `${rendered.join("; ")} (+${String(extra)} more)` : rendered.join("; ");
}

/**
 * Fetch + validate `.github-app.yaml` for one repo. Never throws.
 */
export async function fetchRepoConfig(input: FetchRepoConfigInput): Promise<RepoConfigResult> {
  const { octokit, owner, repo, path, log } = input;
  const cacheKey = `${owner}/${repo}/${path}`;

  const absentUntil = absentCache.get(cacheKey);
  if (absentUntil !== undefined) {
    if (absentUntil > Date.now()) return { kind: "absent" };
    absentCache.delete(cacheKey);
  }

  const cached = etagCache.get(cacheKey);

  let res;
  try {
    res = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      // No `ref`: GitHub resolves the default branch. See the module header.
      ...(cached !== undefined ? { headers: { "if-none-match": cached.etag } } : {}),
    });
  } catch (err) {
    const status = statusOf(err);
    if (status === 304 && cached !== undefined) {
      return cached.value; // unchanged since last fetch
    }
    if (status === 404) {
      evictIfFull(absentCache, cacheKey);
      absentCache.set(cacheKey, Date.now() + ABSENT_TTL_MS);
      return { kind: "absent" };
    }
    // A transient GitHub failure degrades to defaults rather than to
    // "bot disabled": not caching it means the next call retries.
    log.warn(
      { event: "repo_config.fetch_failed", err, owner, repo },
      "repo-config: getContent failed",
    );
    return { kind: "absent" };
  }

  const data = res.data;
  if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string") {
    log.warn(
      { event: "repo_config.invalid", owner, repo, kind: "not-a-file" },
      "repo-config: config path is not a file",
    );
    return { kind: "invalid", message: `${path} is not a file` };
  }

  const raw = Buffer.from(data.content, "base64").toString("utf-8");
  const value = parseAndValidate(raw, data.sha, { owner, repo, log });
  cacheResult(cacheKey, res.headers.etag, value);
  return value;
}

/** Parse + schema-check one config body. Never throws. */
function parseAndValidate(
  raw: string,
  sha: string,
  ctx: { readonly owner: string; readonly repo: string; readonly log: Logger },
): RepoConfigResult {
  const { owner, repo, log } = ctx;

  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(raw);
  } catch (err) {
    log.warn(
      { event: "repo_config.invalid", err, owner, repo, kind: "yaml-parse" },
      "repo-config: YAML parse failed",
    );
    return {
      kind: "invalid",
      message: safeIssueLine(err instanceof Error ? err.message : "YAML parse failed"),
    };
  }

  const result = githubAppConfigSchema.safeParse(parsedYaml);
  if (!result.success) {
    log.warn(
      { event: "repo_config.invalid", owner, repo, kind: "schema", issues: result.error.issues },
      "repo-config: validation failed",
    );
    return { kind: "invalid", message: formatConfigIssues(result.error.issues) };
  }
  return { kind: "ok", config: result.data, sha };
}

function cacheResult(cacheKey: string, etag: unknown, value: RepoConfigResult): void {
  if (typeof etag !== "string" || etag.length === 0) return;
  evictIfFull(etagCache, cacheKey);
  etagCache.set(cacheKey, { etag, value });
}

/** Test-only: drop both caches so cases do not leak state into each other. */
export function __resetRepoConfigCaches(): void {
  etagCache.clear();
  absentCache.clear();
}
