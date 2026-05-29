/**
 * GitHub API rate-limit observability (issue #170).
 *
 * GitHub returns per-installation rate-limit context on every response
 * (`x-ratelimit-*`) and `Retry-After` on 429 / 403 secondary-limit responses.
 * The bot dropped all of it: no `App` constructor installed an
 * `octokit.hook.after("request", ...)` listener, so quota state was invisible.
 *
 * `installRateLimitHooks` wires two hooks onto an Octokit instance; passing
 * `Octokit.plugin(installRateLimitHooks)` as the `App`'s `Octokit` option makes
 * both `app.octokit` (JWT calls) and every `getInstallationOctokit()` inherit
 * them (verified against octokit v5: the `Octokit` option enriches all octokits
 * the App creates).
 *
 * Volume policy: the per-request line is emitted at `debug` so default `info`
 * logging stays quiet (a busy installation issues thousands of calls/hour). A
 * `warn` fires only when `remaining` crosses `RATE_LIMIT_LOW_WATER` or on a
 * rate-limit error, which is the operational signal. `LOG_LEVEL=debug` turns on
 * full per-call visibility without a separate sampling knob.
 */
import { Octokit } from "octokit";
import { z } from "zod";

import { logger } from "../logger";

/** Emit a `rate_limit_low` warn once remaining drops below this floor. */
export const RATE_LIMIT_LOW_WATER = 500;

export const GITHUB_API_LOG_EVENTS = {
  request: "github.api.request",
  rateLimitLow: "github.api.rate_limit_low",
  rateLimitWarning: "github.api.rate_limit_warning",
} as const;

/**
 * `.strict()` shape for the GitHub-API observability lines, so an emitter that
 * adds an unpinned field or mistypes one trips the co-located test.
 */
export const GithubApiLogFieldsSchema = z
  .object({
    event: z.enum([
      GITHUB_API_LOG_EVENTS.request,
      GITHUB_API_LOG_EVENTS.rateLimitLow,
      GITHUB_API_LOG_EVENTS.rateLimitWarning,
    ]),
    route: z.string().min(1),
    status: z.number().int(),
    rate_limit_limit: z.number().int().nonnegative().optional(),
    rate_limit_remaining: z.number().int().nonnegative().optional(),
    rate_limit_reset_in_s: z.number().int().optional(),
    rate_limit_resource: z.string().min(1).optional(),
    retry_after_s: z.number().int().nonnegative().optional(),
  })
  .strict();

export type GithubApiLogFields = z.infer<typeof GithubApiLogFieldsSchema>;

type Headers = Record<string, string | number | undefined>;

function intHeader(headers: Headers, name: string): number | undefined {
  // octokit lowercases response header keys; values arrive as strings.
  // eslint-disable-next-line security/detect-object-injection -- name is a hardcoded header key from this module, not user input
  const raw = headers[name];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/**
 * Build the structured rate-limit fields from a response, or null when the
 * response carried no `x-ratelimit-remaining` header (not all endpoints do).
 * Pure: the hook only logs what this returns, so the decision logic is unit
 * testable without spinning up octokit.
 */
export function rateLimitFields(
  status: number,
  headers: Headers,
  route: string,
  nowSeconds: number,
): GithubApiLogFields | null {
  const remaining = intHeader(headers, "x-ratelimit-remaining");
  if (remaining === undefined) return null;
  const limit = intHeader(headers, "x-ratelimit-limit");
  const reset = intHeader(headers, "x-ratelimit-reset");
  const resource = headers["x-ratelimit-resource"];
  return {
    event:
      remaining < RATE_LIMIT_LOW_WATER
        ? GITHUB_API_LOG_EVENTS.rateLimitLow
        : GITHUB_API_LOG_EVENTS.request,
    route,
    status,
    ...(limit !== undefined ? { rate_limit_limit: limit } : {}),
    rate_limit_remaining: remaining,
    ...(reset !== undefined ? { rate_limit_reset_in_s: reset - nowSeconds } : {}),
    ...(typeof resource === "string" ? { rate_limit_resource: resource } : {}),
  };
}

/**
 * Octokit plugin: log GitHub rate-limit context on every response and warn on
 * rate-limit errors. Use via `Octokit.plugin(installRateLimitHooks)`.
 */
export function installRateLimitHooks(octokit: Pick<Octokit, "hook">): void {
  octokit.hook.after("request", (response, options) => {
    const route = `${options.method} ${options.url}`;
    const fields = rateLimitFields(
      response.status,
      response.headers as Headers,
      route,
      Math.floor(Date.now() / 1000),
    );
    if (fields === null) return;
    if (fields.event === GITHUB_API_LOG_EVENTS.rateLimitLow) {
      logger.warn(fields, "GitHub API rate limit low");
    } else {
      logger.debug(fields, "GitHub API request completed");
    }
  });

  octokit.hook.error("request", (error, options) => {
    const err = error as { status?: number; response?: { headers?: Headers } };
    const status = err.status;
    const retryAfter = intHeader(err.response?.headers ?? {}, "retry-after");
    // 429, or 403 secondary-rate-limit (which carries Retry-After).
    if (status === 429 || (status === 403 && retryAfter !== undefined)) {
      const fields: GithubApiLogFields = {
        event: GITHUB_API_LOG_EVENTS.rateLimitWarning,
        route: `${options.method} ${options.url}`,
        status,
        ...(retryAfter !== undefined ? { retry_after_s: retryAfter } : {}),
      };
      logger.warn(fields, "GitHub API rate limit hit");
    }
    // Preserve behaviour: the hook only observes, the caller still sees the error.
    throw error;
  });
}

/**
 * Octokit subclass with the rate-limit hooks pre-installed. Pass as the `App`'s
 * `Octokit` option so `app.octokit` and every `getInstallationOctokit()` inherit
 * the observability hooks from a single shared class.
 */
export const ObservableOctokit = Octokit.plugin((octokit) => {
  installRateLimitHooks(octokit);
});
