/**
 * PR-side validation comment for `.github-app.yaml`.
 *
 * Authoring feedback only. This module reads the PULL REQUEST's copy of the
 * config so the author learns immediately whether it parses, and it never
 * applies what it reads. That separation is load-bearing and structural:
 * this file imports neither the cached default-branch reader in `fetcher.ts`
 * nor the Gate-2 policy resolver in `effective.ts`, so a head-ref read can
 * never populate the fetcher's `etagCache` / `absentCache` nor influence the
 * policy the bot enforces. `pr-check.test.ts` asserts the absence of both
 * symbols in this source file. Threading a `ref` through the fetcher instead
 * would put an attacker-chosen commit's config one flag-flip away from the
 * applied policy.
 *
 * Flow: `pulls.listFiles` (did this PR touch the config at all?) →
 * `repos.getContent({ref: headSha})` → size gate BEFORE decoding → YAML parse
 * → `githubAppConfigSchema.safeParse` → one marker-keyed sticky comment.
 *
 * Output safety: every attacker-derived substring (a zod message echoes the
 * received value) goes through `sanitizeContent` + `redactSecrets` and is
 * rendered as a literal code span before it is concatenated, and the marker
 * is appended LAST because `sanitizeContent` strips HTML comments and would
 * otherwise eat it. The assembled body is posted through
 * `upsertMarkerComment`, which routes both branches through
 * `safePostToGitHub` with `source: "system"`.
 */

import type { Octokit } from "octokit";
import type { Logger } from "pino";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";

import { config } from "../config";
import { redactSecrets, sanitizeContent } from "../utils/sanitize";
import { buildScopedMarker, upsertMarkerComment } from "../workflows/ship/scoped/marker-comment";
import { githubAppConfigSchema, MAX_CONFIG_BYTES } from "./schema";

/** Rendered issue cap. Beyond this the comment stops being readable. */
const MAX_RENDERED_ISSUES = 10;

/** Per-line cap, mirroring `fetcher.ts safeIssueLine`. zod echoes the received value. */
const MAX_ISSUE_LENGTH = 120;

/**
 * `sanitizeContent` is the INPUT-side sanitizer and substitutes a
 * `[REDACTED_*]` marker for known-format tokens. Security invariant #2 bans
 * that marker on OUTPUT paths, because it confirms to a prober that their
 * payload was seen. Drop the marker bytes after sanitising; the silent
 * output-side `redactSecrets` pass inside `safePostToGitHub` still covers the
 * assembled body.
 */
const REDACTION_MARKER_RE = /\[REDACTED_[A-Z_]+\]/g;

export interface ConfigCheckIssue {
  readonly path: string;
  readonly message: string;
}

export type ConfigCheckOutcome =
  | { readonly kind: "valid" }
  | { readonly kind: "invalid"; readonly issues: readonly ConfigCheckIssue[] }
  | { readonly kind: "too-large"; readonly size: number };

/** Sticky-comment key. Distinct verb, so no other feature can recycle this comment. */
function configCheckMarker(prNumber: number): string {
  return buildScopedMarker({ verb: "config-check", number: prNumber });
}

/**
 * Make one attacker-derived substring safe to render.
 *
 * `sanitizeContent` only redacts the five GitHub token shapes. AWS keys,
 * Anthropic keys, PEM blocks, JWTs and `postgres://user:pass@host` URLs are
 * caught by `redactSecrets` alone, and that pass otherwise runs downstream
 * inside `safePostToGitHub` on the already-truncated text. Every
 * `redactSecrets` pattern is minimum-length bounded, so a cap applied first
 * bisects the credential and leaves an unmatchable prefix the downstream
 * scrub walks straight past. Scrub here, before the cap, exactly as
 * `fetcher.ts safeIssueLine` does.
 *
 * Collapse `\s+`, not `\n`: a lone `\r` also terminates a Markdown list item
 * and would orphan the rest of the line (same reasoning as `collapseWarning`
 * in `core/tracking-comment.ts`).
 *
 * Collapsing runs BEFORE the scrub. The PEM entry is the only `redactSecrets`
 * pattern carrying literal spaces (RFC 7468 §2 spells the boundary
 * `-----BEGIN PRIVATE KEY-----`), so a boundary broken with `\n` or `\t`
 * evades the scrub, and collapsing afterwards would silently re-form it with
 * no second pass, after which the cap strips the `END` line the downstream
 * `safePostToGitHub` pass needs to match. Every other pattern is built from
 * character classes that exclude whitespace, so normalising first cannot lose
 * a match.
 */
function safeText(text: string): string {
  const collapsed = sanitizeContent(text).replace(/\s+/g, " ").trim();
  const clean = redactSecrets(collapsed).body.replace(REDACTION_MARKER_RE, "").trim();
  return clean.length > MAX_ISSUE_LENGTH ? `${clean.slice(0, MAX_ISSUE_LENGTH)}…` : clean;
}

/**
 * Render one untrusted substring as a literal inline code span.
 *
 * Backticks are STRIPPED, not escaped: a surviving run pairs with an
 * equal-length run anywhere later in the document (CommonMark 0.31.2 §6.1),
 * which lets one zod message close its own span and corrupt the following
 * list item. Without the span, a `z.strictObject` message echoing an unknown
 * key renders `[click](https://evil.example)` as a live hyperlink under the
 * bot's identity.
 */
function codeSpan(text: string, fallback: string): string {
  const safe = safeText(text).replace(/`/g, "");
  return `\`${safe.length > 0 ? safe : fallback}\``;
}

// Stated on every verdict: the whole point of the comment is that validating
// here is NOT the same as applying, and authors otherwise assume it is.
const APPLIES_ON_MERGE =
  "> Only the default-branch copy of this file is ever applied, so this change " +
  "takes effect on merge. Until then the bot keeps using the copy already on the " +
  "default branch.";

export interface RenderConfigCheckBodyInput {
  readonly prNumber: number;
  /** Config filename, from `config.repoConfigFile`. Operator-controlled. */
  readonly path: string;
  readonly outcome: ConfigCheckOutcome;
}

/** Pure renderer. The marker is concatenated last, after all sanitisation. */
export function renderConfigCheckBody(input: RenderConfigCheckBodyInput): string {
  const { prNumber, path, outcome } = input;
  const sections: string[] = [];

  switch (outcome.kind) {
    case "valid":
      sections.push(
        `### ✅ \`${path}\` is valid`,
        `This pull request's copy of \`${path}\` parses as YAML and matches the schema.`,
      );
      break;

    case "too-large":
      sections.push(
        `### ⚠️ \`${path}\` is too large to validate`,
        `The file in this pull request is ${String(outcome.size)} bytes, over the ` +
          `${String(MAX_CONFIG_BYTES)} byte limit, so it was neither decoded nor parsed and ` +
          `none of its contents are shown here.`,
      );
      break;

    case "invalid": {
      const shown = outcome.issues.slice(0, MAX_RENDERED_ISSUES);
      const lines = shown.map(
        (issue) =>
          `- ${codeSpan(issue.path, "(root)")}: ${codeSpan(issue.message, "(no message)")}`,
      );
      sections.push(
        `### ❌ \`${path}\` is not valid`,
        `This pull request's copy of \`${path}\` did not pass validation:`,
        lines.join("\n"),
      );
      const hidden = outcome.issues.length - shown.length;
      if (hidden > 0) sections.push(`_…and ${String(hidden)} more not shown._`);
      break;
    }
  }

  sections.push(APPLIES_ON_MERGE, configCheckMarker(prNumber));
  return sections.join("\n\n");
}

export interface RunPrConfigCheckInput {
  readonly octokit: Octokit;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  /** HEAD commit of the PR. The copy validated here, never the copy applied. */
  readonly headSha: string;
  readonly deliveryId: string;
  readonly log: Logger;
}

function statusOf(err: unknown): number | undefined {
  return typeof err === "object" && err !== null && "status" in err
    ? (err as { status?: number }).status
    : undefined;
}

function toIssues(issues: readonly z.core.$ZodIssue[]): ConfigCheckIssue[] {
  return issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

/**
 * Did this pull request touch the config file at all?
 *
 * GitHub caps `pulls.listFiles` at 3000 files per pull request, so on a
 * larger diff this check is best-effort and may miss the config edit. A
 * missed edit costs the author a comment, never a wrong verdict.
 */
async function touchesConfigFile(input: RunPrConfigCheckInput, path: string): Promise<boolean> {
  let files: { filename: string }[];
  try {
    files = (await input.octokit.paginate(input.octokit.rest.pulls.listFiles, {
      owner: input.owner,
      repo: input.repo,
      pull_number: input.prNumber,
      per_page: 100,
    })) as { filename: string }[];
  } catch (err) {
    // Degrade like every other GitHub call on this path: a secondary rate
    // limit, a 5xx, or a revoked `pull_requests: read` must no-op the check,
    // not reject out of `runPrConfigCheck` into the caller. Same trade the
    // 3000-file cap already accepts: a missed edit costs the author a
    // comment, never a wrong verdict.
    input.log.info(
      {
        event: "repo_config.pr_check.list_files_failed",
        err,
        owner: input.owner,
        repo: input.repo,
        prNumber: input.prNumber,
      },
      "repo-config: could not list pull request files, skipping config check",
    );
    return false;
  }
  return files.some((file) => file.filename === path);
}

/**
 * Read + validate the head-ref copy. Returns `null` when there is nothing
 * worth saying (file removed by the PR, path is a directory, transient read
 * failure), so the caller stays silent rather than posting a misleading
 * verdict.
 */
async function readHeadRefOutcome(
  input: RunPrConfigCheckInput,
  path: string,
): Promise<ConfigCheckOutcome | null> {
  const { octokit, owner, repo, headSha, log } = input;

  let res;
  try {
    res = await octokit.rest.repos.getContent({ owner, repo, path, ref: headSha });
  } catch (err) {
    // 404 means the (path, ref) did not resolve. Usually the PR deleted the
    // file, but a 404 alone does not prove that (a renamed default branch or
    // a revoked permission reads the same), hence `head_missing` rather than
    // `removed`. Either way there is nothing to validate, and "invalid" would
    // be a lie.
    const event =
      statusOf(err) === 404
        ? "repo_config.pr_check.head_missing"
        : "repo_config.pr_check.read_failed";
    log.info(
      { event, owner, repo, prNumber: input.prNumber },
      "repo-config PR check: no file read",
    );
    return null;
  }

  const data = res.data;
  if (Array.isArray(data) || data.type !== "file") {
    log.warn(
      {
        event: "repo_config.pr_check.not_a_file",
        owner,
        repo,
        prNumber: input.prNumber,
        reason: "type",
      },
      "repo-config PR check: config path is not a file",
    );
    return null;
  }

  // Size gate BEFORE the base64 decode, so an oversize blob is never
  // materialised, let alone rendered.
  if (data.size > MAX_CONFIG_BYTES) return { kind: "too-large", size: data.size };

  // `type: "file"` with no string `content` is not reachable through today's
  // REST contract, but the response type permits it and staying silent here
  // would be the one abnormal exit with no log line.
  if (typeof data.content !== "string") {
    log.warn(
      {
        event: "repo_config.pr_check.not_a_file",
        owner,
        repo,
        prNumber: input.prNumber,
        reason: "no-content",
      },
      "repo-config PR check: config blob carried no content",
    );
    return null;
  }

  let doc: unknown;
  try {
    doc = parseYaml(Buffer.from(data.content, "base64").toString("utf-8"));
  } catch (err) {
    return {
      kind: "invalid",
      issues: [{ path: "", message: err instanceof Error ? err.message : "YAML parse failed" }],
    };
  }

  const parsed = githubAppConfigSchema.safeParse(doc);
  return parsed.success
    ? { kind: "valid" }
    : { kind: "invalid", issues: toIssues(parsed.error.issues) };
}

/**
 * Validate this pull request's copy of the config and upsert one sticky
 * comment with the verdict. No-ops entirely when the PR does not touch the
 * config file.
 */
export async function runPrConfigCheck(input: RunPrConfigCheckInput): Promise<void> {
  const { octokit, owner, repo, prNumber, deliveryId, log } = input;
  const path = config.repoConfigFile;

  if (!(await touchesConfigFile(input, path))) return;

  const outcome = await readHeadRefOutcome(input, path);
  if (outcome === null) return;

  await upsertMarkerComment({
    octokit,
    owner,
    repo,
    issue_number: prNumber,
    marker: configCheckMarker(prNumber),
    body: renderConfigCheckBody({ prNumber, path, outcome }),
    source: "system",
    log,
    deliveryId,
  });

  log.info(
    { event: "repo_config.pr_check.posted", owner, repo, prNumber, outcome: outcome.kind },
    "repo-config PR check: verdict posted",
  );
}
