/**
 * Zod schema for `.github-app.yaml`: the per-repo config file that
 * declares scheduled actions.
 *
 * A repo at the root of its default branch may ship this file; the
 * scheduler (src/scheduler/scheduler.ts) fetches and validates it on each
 * scan. Validation is strict and fail-closed at the field level: a malformed
 * file produces a `safeParse` error and the whole repo is skipped (logged),
 * never partially applied.
 *
 * Trust note: this file is editable by anyone with push access to the repo,
 * so it is treated as trusted-as-owner config (push access already implies
 * write authority). The scheduler additionally gates every repo through the
 * `ALLOWED_OWNERS` allowlist before any action here runs.
 */

import { CronExpressionParser } from "cron-parser";
import { z } from "zod";

/** A relative repo path: no absolute paths, no `..` traversal segments. */
const safeRepoPath = z
  .string()
  .min(1)
  .refine(
    (p) => !p.startsWith("/") && !/^[a-zA-Z]:/.test(p) && !p.split("/").includes(".."),
    "path must be repo-relative with no '..' segments",
  );

/** `owner/repo` slug for a cross-repo prompt source. */
const repoSlug = z.string().regex(/^[\w.-]+\/[\w.-]+$/, "repo must be in 'owner/name' form");

/**
 * IANA timezone string. `cron-parser` accepts unknown `tz` values
 * silently, so the zone is validated here via `Intl.DateTimeFormat`,
 * which throws `RangeError` on an unknown zone.
 */
const ianaTimezone = z
  .string()
  .min(1)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "unknown IANA timezone");

/**
 * Duration → integer milliseconds. Accepts a positive integer (ms) or a
 * `h`/`m`/`s`-suffixed string (`60m`, `1.5h`, `90s`). Mirrors the
 * `durationMs` helper in src/config.ts.
 */
const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(h|m|s)$/;
const durationMs = z.preprocess((v) => {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return v;
  const trimmed = v.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  // eslint-disable-next-line @typescript-eslint/prefer-regexp-exec -- match() reads cleaner here; equivalent to RegExp#exec for capture-group access
  const match = trimmed.match(DURATION_PATTERN);
  if (match === null) return v;
  const n = Number(match[1]);
  const unit = match[2];
  const mult = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000;
  return Math.round(n * mult);
}, z.number().int().positive());

/**
 * The `prompt:` block. The YAML author writes one of three shapes; a
 * preprocess tags each with a `form` discriminator:
 *   prompt: { inline: "text..." }                          → form: "inline"
 *   prompt: { ref: "path/to/file.md" }                     → form: "file"
 *   prompt: { ref: "dir/", entrypoint: "SKILL.md" }         → form: "folder"
 * A `ref` is a folder when it ends with `/` or carries an `entrypoint`.
 * `repo` (optional) sources the prompt from another accessible repo.
 */
export const promptRefSchema = z.preprocess(
  (raw) => {
    if (raw === null || typeof raw !== "object") return raw;
    const obj = raw as Record<string, unknown>;
    // `inline` and `ref` are mutually exclusive: a doc carrying both is
    // ambiguous. Return it untagged so the discriminated union rejects it
    // rather than silently coercing to `inline`.
    if (typeof obj["inline"] === "string" && typeof obj["ref"] === "string") {
      return raw;
    }
    if (typeof obj["inline"] === "string") {
      // An unknown sibling key is a misspelling: return raw so the
      // discriminated union rejects it instead of dropping the typo here.
      if (Object.keys(obj).some((k) => k !== "inline")) return raw;
      return { form: "inline", text: obj["inline"] };
    }
    if (typeof obj["ref"] === "string") {
      const ref = obj["ref"];
      const isFolder = ref.endsWith("/") || typeof obj["entrypoint"] === "string";
      const allowed = new Set(isFolder ? ["ref", "entrypoint", "repo"] : ["ref", "repo"]);
      if (Object.keys(obj).some((k) => !allowed.has(k))) return raw;
      const repo = typeof obj["repo"] === "string" ? { repo: obj["repo"] } : {};
      return isFolder
        ? {
            form: "folder",
            ref,
            entrypoint: typeof obj["entrypoint"] === "string" ? obj["entrypoint"] : "SKILL.md",
            ...repo,
          }
        : { form: "file", ref, ...repo };
    }
    return raw;
  },
  z.discriminatedUnion("form", [
    // `strictObject` rejects unknown keys, so a misspelled prompt field
    // fails the file loudly instead of being silently stripped.
    z.strictObject({ form: z.literal("inline"), text: z.string().min(1).max(50_000) }),
    z.strictObject({ form: z.literal("file"), ref: safeRepoPath, repo: repoSlug.optional() }),
    z.strictObject({
      form: z.literal("folder"),
      ref: safeRepoPath,
      entrypoint: safeRepoPath,
      repo: repoSlug.optional(),
    }),
  ]),
);
export type PromptRef = z.infer<typeof promptRefSchema>;

/** A single scheduled action. `strictObject` rejects unknown keys. */
export const scheduledActionSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9-]{1,64}$/, "name must be 1-64 chars of [a-z0-9-]"),
  cron: z.string().min(1),
  /** Optional per-action override of `config.timezone`. */
  timezone: ianaTimezone.optional(),
  enabled: z.boolean().default(true),
  /** Agent model; defaults to the server's `CLAUDE_MODEL` when omitted. */
  model: z.string().min(1).optional(),
  /** Agent turn cap; 1-500, values outside the range are rejected. */
  max_turns: z.coerce.number().int().min(1).max(500).optional(),
  /** Wall-clock ceiling; clamped to `config.agentTimeoutMs` downstream. */
  timeout: durationMs.optional(),
  auto_merge: z.boolean().default(false),
  /** Agent tool allowlist; defaults to a read-only set when omitted. */
  allowed_tools: z.array(z.string().min(1)).max(100).optional(),
  prompt: promptRefSchema,
});
export type ScheduledAction = z.infer<typeof scheduledActionSchema>;

/** The whole `.github-app.yaml` document. */
export const githubAppConfigSchema = z
  .strictObject({
    version: z.literal(1),
    config: z.strictObject({ timezone: ianaTimezone.default("UTC") }).default({ timezone: "UTC" }),
    scheduled_actions: z.array(scheduledActionSchema).max(50).default([]),
  })
  .superRefine((doc, ctx) => {
    // Reject duplicate action names: the (repo, action_name) identity must
    // be unique for the schedule-state row and the single-flight lock.
    const seen = new Set<string>();
    for (const action of doc.scheduled_actions) {
      if (seen.has(action.name)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate scheduled action name: "${action.name}"`,
          path: ["scheduled_actions"],
        });
      }
      seen.add(action.name);
      // Validate the cron expression against the resolved timezone so a
      // bad cron or unknown IANA zone fails the whole file at parse time.
      const tz = action.timezone ?? doc.config.timezone;
      try {
        CronExpressionParser.parse(action.cron, { tz });
      } catch (err) {
        ctx.addIssue({
          code: "custom",
          message: `action "${action.name}": invalid cron/timezone, ${err instanceof Error ? err.message : String(err)}`,
          path: ["scheduled_actions"],
        });
      }
    }
  });
export type GithubAppConfig = z.infer<typeof githubAppConfigSchema>;
