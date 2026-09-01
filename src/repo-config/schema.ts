/**
 * Zod schema for `.github-app.yaml`: the per-repo config file that declares
 * feature toggles, agent overrides, trigger filters, and scheduled actions.
 *
 * **Default branch only.** A repo ships this file at the root of its default
 * branch. `src/repo-config/fetcher.ts` reads it with no git ref, so GitHub
 * resolves the default branch and a copy edited inside a pull request is
 * never applied to that pull request. Do not add a `ref` to that call.
 *
 * Validation is strict at the field level: `strictObject` everywhere, so a
 * misspelled key fails the whole document rather than being silently
 * dropped. Callers decide the failure policy (the scheduler skips the repo
 * for the tick; `effective.ts` falls open to defaults with a warning).
 *
 * Trust note: this file is editable by anyone with push access to the repo,
 * so it is treated as trusted-as-owner config (push access already implies
 * write authority). Every repo is additionally gated through the
 * `ALLOWED_OWNERS` allowlist before any of it runs.
 *
 * Layering: this module must NOT import `../workflows/registry`. That module
 * pulls every handler's transitive dependency graph (git CLI, MCP servers),
 * see the header of `src/shared/workflow-types.ts`. The seven workflow keys
 * are written out literally in `workflowsConfigSchema` below, and
 * `schema.test.ts` asserts they still match the registry.
 */

import { CronExpressionParser } from "cron-parser";
import { z } from "zod";

import { isSafeGlob } from "../utils/review-learnings-filter";

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

/**
 * Per-repo review-learnings policy (1.5.F).
 *
 * - `enabled: false` skips loading any directives for this repo. The
 *   server-side `REVIEW_LEARNINGS_ENABLED` env is the master gate; this is
 *   a finer per-repo opt-out.
 * - `scope: 'local'` keeps the `WHERE … scope='global'` branch out of the
 *   query, so cross-repo owner-wide directives never reach this repo's
 *   reviews. `'global'` lets them through.
 * - `max_age_days` (null = no cap) excludes rows older than the threshold
 *   at load time. Tightens noise on long-lived repos.
 */
export const reviewLearningsConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  scope: z.enum(["local", "global"]).default("local"),
  max_age_days: z.coerce.number().int().positive().nullable().default(null),
});
export type ReviewLearningsConfig = z.infer<typeof reviewLearningsConfigSchema>;

/** Default review-learnings policy when the repo's .github-app.yaml omits
 * the block (or the file is missing entirely). */
export const DEFAULT_REVIEW_LEARNINGS_CONFIG: ReviewLearningsConfig = {
  enabled: true,
  scope: "local",
  max_age_days: null,
};

/**
 * A picomatch glob. `isSafeGlob` rejects structurally pathological patterns
 * (excessive wildcards / nesting) that would make matching quadratic.
 */
const safeGlob = z.string().min(1).max(200).refine(isSafeGlob, "unsafe or overly complex glob");

/**
 * A GitHub login, optionally a `[bot]` suffix. GitHub caps logins at 39
 * chars of `[A-Za-z0-9-]`. Bounded so a typo fails the file loudly instead
 * of silently never matching.
 */
const githubLogin = z
  .string()
  .regex(
    /^[A-Za-z0-9-]{1,39}(\[bot\])?$/,
    "must be a GitHub login, e.g. 'octocat' or 'renovate[bot]'",
  );

/**
 * Agent knobs shared by `defaults:` and every `workflows.<name>:` entry.
 * Field names mirror `scheduledActionSchema` so both blocks read alike.
 *
 * `extra_allowed_tools` is additive, never a replacement. Workflow handlers
 * hardcode the tool lists they need, so replacement semantics would let a
 * typo here silently strip a tool the handler cannot run without. Adding a
 * tool is still bounded by the runtime forbidden-Bash hook.
 */
const agentKnobsShape = {
  model: z.string().min(1).max(128).optional(),
  max_turns: z.coerce.number().int().min(1).max(500).optional(),
  timeout: durationMs.optional(),
  extra_allowed_tools: z.array(z.string().min(1)).max(50).default([]),
};

/** Repo-wide agent defaults, overridden per workflow. */
const repoDefaultsSchema = z.strictObject(agentKnobsShape);
export type RepoDefaults = z.infer<typeof repoDefaultsSchema>;

/** Toggle plus agent knobs, for every workflow except `review`. */
const workflowConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  ...agentKnobsShape,
});

/**
 * `review` additionally accepts reviewer-shaping fields.
 *
 * `path_filters` are exclusions: a changed file matching any glob is hidden
 * from the review prompt. `instructions` is owner-trusted review policy, same
 * trust tier as review learnings: the prompt still spotlights it with the
 * per-call nonce tag (so its boundary against adjacent attacker text is
 * unambiguous), and the `<security_directive>` carves it an explicit
 * follow-this exception. Only the default branch's copy of this file is read,
 * so a pull request cannot inject either field for its own review.
 */
const reviewWorkflowConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  ...agentKnobsShape,
  path_filters: z.array(safeGlob).max(100).default([]),
  instructions: z.string().max(10_000).optional(),
  /**
   * Run `review` automatically when an `AUTO_REVIEW_USERS` login pushes to an
   * open PR. Both keys are required; neither alone enables anything.
   *
   * Defaults to `false`, unlike every other toggle here, because
   * `loadRepoPolicy` fails open to `DEFAULT_REPO_POLICY`: a default of `true`
   * would let a GitHub outage start spending tokens on every push in every
   * repo. Mirrors `scheduled_actions[].auto_merge`, the other env-AND-repo
   * automatic action, which defaults off for the same reason.
   */
  auto: z.boolean().default(false),
});

/**
 * `ship` takes the toggle and nothing else: its handler enqueues child
 * workflows and never invokes an agent, so agent knobs here are a no-op. The
 * children resolve their own `workflows.<child>.*` entries.
 *
 * Structural rather than a `.refine` because zod v4's `toJSONSchema` drops
 * refinements, which would leave the dead knob unflagged in editors.
 */
const shipWorkflowConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
});

/**
 * Per-workflow overrides. Keys are enumerated rather than a `z.record` over
 * the registry enum for two reasons: `strictObject` then rejects a
 * misspelled workflow name loudly, and `review` can carry fields the others
 * cannot. schema.test.ts asserts this key set still equals the registry.
 */
export const workflowsConfigSchema = z.strictObject({
  triage: workflowConfigSchema.optional(),
  plan: workflowConfigSchema.optional(),
  implement: workflowConfigSchema.optional(),
  review: reviewWorkflowConfigSchema.optional(),
  resolve: workflowConfigSchema.optional(),
  ship: shipWorkflowConfigSchema.optional(),
  remember: workflowConfigSchema.optional(),
});

/**
 * Pre-dispatch trigger filters. Every field narrows what the bot responds
 * to; none can widen it. `allowed_users` in particular layers on top of the
 * server's `ALLOWED_OWNERS` env allowlist (which gates the repository
 * owner, not the triggering user) and is applied as an intersection.
 */
export const triggersConfigSchema = z.strictObject({
  ignore_authors: z.array(githubLogin).max(50).default([]),
  ignore_draft_prs: z.boolean().default(false),
  ignore_title_keywords: z.array(z.string().min(1).max(64)).max(20).default([]),
  /** Empty means every base branch. Git refs cap at 244 usable chars. */
  base_branches: z.array(z.string().min(1).max(244)).max(20).default([]),
  /** Empty means anyone the App already permits. */
  allowed_users: z.array(githubLogin).max(100).default([]),
});
export type TriggersConfig = z.infer<typeof triggersConfigSchema>;

/** Defaults applied when the `triggers:` block is omitted entirely. */
export const DEFAULT_TRIGGERS_CONFIG: TriggersConfig = {
  ignore_authors: [],
  ignore_draft_prs: false,
  ignore_title_keywords: [],
  base_branches: [],
  allowed_users: [],
};

/** Defaults applied when the `defaults:` block is omitted entirely. */
export const DEFAULT_REPO_DEFAULTS: RepoDefaults = { extra_allowed_tools: [] };

/**
 * The whole `.github-app.yaml` document.
 *
 * Every field added after `version` is optional with a default, so a file
 * written against an earlier revision of this schema still parses. Bump
 * `version` only for a breaking rename or semantic change.
 */
export const githubAppConfigSchema = z
  .strictObject({
    version: z.literal(1),
    /** Repo-wide master switch. `false` makes the bot ignore the repo entirely. */
    enabled: z.boolean().default(true),
    config: z.strictObject({ timezone: ianaTimezone.default("UTC") }).default({ timezone: "UTC" }),
    defaults: repoDefaultsSchema.default(DEFAULT_REPO_DEFAULTS),
    workflows: workflowsConfigSchema.default({}),
    triggers: triggersConfigSchema.default(DEFAULT_TRIGGERS_CONFIG),
    scheduled_actions: z.array(scheduledActionSchema).max(50).default([]),
    review_learnings: reviewLearningsConfigSchema.default(DEFAULT_REVIEW_LEARNINGS_CONFIG),
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
