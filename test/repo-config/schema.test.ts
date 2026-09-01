import { describe, expect, it } from "bun:test";

import {
  DEFAULT_REVIEW_LEARNINGS_CONFIG,
  DEFAULT_TRIGGERS_CONFIG,
  githubAppConfigSchema,
  workflowsConfigSchema,
} from "../../src/repo-config/schema";
import { WorkflowNameSchema } from "../../src/workflows/registry";

function base(action: Record<string, unknown>): unknown {
  return { version: 1, scheduled_actions: [action] };
}

describe("githubAppConfigSchema", () => {
  it("accepts a minimal valid config with an inline prompt", () => {
    const r = githubAppConfigSchema.safeParse(
      base({ name: "research", cron: "0 3 * * *", prompt: { inline: "do research" } }),
    );
    expect(r.success).toBe(true);
    if (r.success) {
      const a = r.data.scheduled_actions[0];
      expect(a?.enabled).toBe(true); // default
      expect(a?.auto_merge).toBe(false); // default
      expect(a?.prompt.form).toBe("inline");
      expect(r.data.config.timezone).toBe("UTC"); // default
    }
  });

  it("tags a single-file prompt ref", () => {
    const r = githubAppConfigSchema.safeParse(
      base({ name: "a", cron: "0 3 * * *", prompt: { ref: ".github/skills/research.md" } }),
    );
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.scheduled_actions[0]?.prompt.form).toBe("file");
  });

  it("tags a folder prompt ref (trailing slash or entrypoint)", () => {
    const r1 = githubAppConfigSchema.safeParse(
      base({ name: "a", cron: "0 3 * * *", prompt: { ref: ".github/skills/research/" } }),
    );
    const r2 = githubAppConfigSchema.safeParse(
      base({
        name: "a",
        cron: "0 3 * * *",
        prompt: { ref: ".github/skills/research", entrypoint: "SKILL.md" },
      }),
    );
    expect(r1.success && r1.data.scheduled_actions[0]?.prompt.form).toBe("folder");
    expect(r2.success && r2.data.scheduled_actions[0]?.prompt.form).toBe("folder");
  });

  it("rejects path traversal in a prompt ref", () => {
    const r = githubAppConfigSchema.safeParse(
      base({ name: "a", cron: "0 3 * * *", prompt: { ref: "../../etc/passwd" } }),
    );
    expect(r.success).toBe(false);
  });

  it("rejects an absolute prompt ref", () => {
    const r = githubAppConfigSchema.safeParse(
      base({ name: "a", cron: "0 3 * * *", prompt: { ref: "/etc/passwd" } }),
    );
    expect(r.success).toBe(false);
  });

  it("rejects duplicate action names", () => {
    const r = githubAppConfigSchema.safeParse({
      version: 1,
      scheduled_actions: [
        { name: "dup", cron: "0 3 * * *", prompt: { inline: "x" } },
        { name: "dup", cron: "0 4 * * *", prompt: { inline: "y" } },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("rejects an invalid cron expression", () => {
    const r = githubAppConfigSchema.safeParse(
      base({ name: "a", cron: "not a cron", prompt: { inline: "x" } }),
    );
    expect(r.success).toBe(false);
  });

  it("rejects an unknown timezone", () => {
    const r = githubAppConfigSchema.safeParse(
      base({ name: "a", cron: "0 3 * * *", timezone: "Mars/Olympus", prompt: { inline: "x" } }),
    );
    expect(r.success).toBe(false);
  });

  it("rejects max_turns outside 1-500", () => {
    const r = githubAppConfigSchema.safeParse(
      base({ name: "a", cron: "0 3 * * *", max_turns: 600, prompt: { inline: "x" } }),
    );
    expect(r.success).toBe(false);
  });

  it("parses a duration timeout into milliseconds", () => {
    const r = githubAppConfigSchema.safeParse(
      base({ name: "a", cron: "0 3 * * *", timeout: "60m", prompt: { inline: "x" } }),
    );
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.scheduled_actions[0]?.timeout).toBe(3_600_000);
  });

  it("accepts an allowed_tools list and a name regex bound", () => {
    const ok = githubAppConfigSchema.safeParse(
      base({
        name: "research",
        cron: "0 3 * * *",
        allowed_tools: ["WebSearch", "Bash(gh issue create:*)"],
        prompt: { inline: "x" },
      }),
    );
    expect(ok.success).toBe(true);
    const bad = githubAppConfigSchema.safeParse(
      base({ name: "Bad Name", cron: "0 3 * * *", prompt: { inline: "x" } }),
    );
    expect(bad.success).toBe(false);
  });

  it("rejects an unsupported version", () => {
    const r = githubAppConfigSchema.safeParse(
      base({ name: "a", cron: "0 3 * * *", prompt: { inline: "x" } }) as { version: number },
    );
    expect(r.success).toBe(true); // version 1 in base()
    const r2 = githubAppConfigSchema.safeParse({
      version: 2,
      scheduled_actions: [],
    });
    expect(r2.success).toBe(false);
  });
});

describe("githubAppConfigSchema: feature-toggle blocks", () => {
  it("defaults every new block when the document omits them", () => {
    const r = githubAppConfigSchema.safeParse({ version: 1 });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.enabled).toBe(true);
    expect(r.data.defaults).toEqual({ extra_allowed_tools: [] });
    expect(r.data.workflows).toEqual({});
    expect(r.data.triggers).toEqual(DEFAULT_TRIGGERS_CONFIG);
    expect(r.data.scheduled_actions).toEqual([]);
    expect(r.data.review_learnings).toEqual(DEFAULT_REVIEW_LEARNINGS_CONFIG);
  });

  it("accepts the full feature-toggle surface", () => {
    const r = githubAppConfigSchema.safeParse({
      version: 1,
      enabled: true,
      defaults: { model: "claude-opus-5", max_turns: 120, timeout: "45m" },
      workflows: {
        implement: { max_turns: 200, timeout: "60m" },
        review: { path_filters: ["**/*.lock", "dist/**"], instructions: "be strict" },
        ship: { enabled: false },
      },
      triggers: {
        ignore_authors: ["renovate[bot]"],
        ignore_draft_prs: true,
        ignore_title_keywords: ["WIP"],
        base_branches: ["main"],
        allowed_users: ["octocat"],
      },
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.defaults.timeout).toBe(2_700_000); // 45m in ms
    expect(r.data.workflows.implement?.timeout).toBe(3_600_000);
    expect(r.data.workflows.ship?.enabled).toBe(false);
    // Omitted `enabled` defaults to true, so an entry that only tunes the
    // agent does not accidentally read as "disabled".
    expect(r.data.workflows.implement?.enabled).toBe(true);
    expect(r.data.workflows.review?.path_filters).toEqual(["**/*.lock", "dist/**"]);
  });

  it("rejects a misspelled key at every new level", () => {
    const cases: unknown[] = [
      { version: 1, enabld: true },
      { version: 1, defaults: { modle: "x" } },
      { version: 1, workflows: { revue: {} } },
      { version: 1, workflows: { implement: { path_filters: ["*"] } } }, // review-only field
      { version: 1, triggers: { ignore_author: [] } },
    ];
    for (const doc of cases) {
      expect(githubAppConfigSchema.safeParse(doc).success).toBe(false);
    }
  });

  it("rejects a pathological glob in review.path_filters", () => {
    const r = githubAppConfigSchema.safeParse({
      version: 1,
      workflows: { review: { path_filters: ["*".repeat(60)] } },
    });
    expect(r.success).toBe(false);
  });

  it("rejects a non-login in ignore_authors and allowed_users", () => {
    expect(
      githubAppConfigSchema.safeParse({ version: 1, triggers: { ignore_authors: ["not a login"] } })
        .success,
    ).toBe(false);
    expect(
      githubAppConfigSchema.safeParse({ version: 1, triggers: { allowed_users: ["a".repeat(40)] } })
        .success,
    ).toBe(false);
  });

  it("rejects every agent knob under `workflows.ship` (C10)", () => {
    // ship enqueues child workflows and never invokes an agent.
    const knobs: Record<string, unknown> = {
      model: "claude-opus-5",
      max_turns: 50,
      timeout: "10m",
      extra_allowed_tools: ["WebFetch"],
    };
    for (const [knob, value] of Object.entries(knobs)) {
      const r = githubAppConfigSchema.safeParse({
        version: 1,
        workflows: { ship: { [knob]: value } },
      });
      expect(r.success).toBe(false);
      if (r.success) continue;
      const named = r.error.issues.some(
        (i) => i.path.join(".") === "workflows.ship" && JSON.stringify(i).includes(knob),
      );
      expect(named).toBe(true);
    }
  });

  it("keeps `workflows.ship.enabled` parseable (C11)", () => {
    // Gate 1 reads this toggle; narrowing the entry must not remove it.
    const r = githubAppConfigSchema.safeParse({
      version: 1,
      workflows: { ship: { enabled: false } },
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.workflows.ship?.enabled).toBe(false);
  });

  it("keeps the `workflows` key set equal to the registry (FR-023)", () => {
    // The schema cannot import the registry without pulling every handler's
    // dependency graph, so parity is asserted here instead. Adding an eighth
    // workflow fails this until `workflowsConfigSchema` is extended.
    expect(Object.keys(workflowsConfigSchema.shape).sort()).toEqual(
      [...WorkflowNameSchema.options].sort(),
    );
  });
});

describe("workflows.review.auto (work item #1)", () => {
  function parseReview(review: Record<string, unknown>) {
    return githubAppConfigSchema.safeParse({ version: 1, workflows: { review } });
  }

  it("defaults to false when omitted", () => {
    // The one toggle in this file that defaults OFF. `loadRepoPolicy` falls back
    // to the built-in defaults when the file is missing, unreachable, OR
    // invalid, so a default of true would let a GitHub outage start spending
    // tokens on every push in every repo.
    const parsed = githubAppConfigSchema.parse({ version: 1 });
    expect(parsed.workflows.review?.auto).toBeUndefined();
    expect(parseReview({}).success).toBe(true);
    expect(parseReview({}).data?.workflows.review?.auto).toBe(false);
  });

  it("accepts an explicit true", () => {
    expect(parseReview({ auto: true }).data?.workflows.review?.auto).toBe(true);
  });

  it("rejects a non-boolean", () => {
    expect(parseReview({ auto: "yes" }).success).toBe(false);
    expect(parseReview({ auto: 1 }).success).toBe(false);
  });

  it("rejects `auto` on a workflow other than review", () => {
    // Auto-run is review-only; a stray key elsewhere is a typo, not a feature.
    const result = githubAppConfigSchema.safeParse({
      version: 1,
      workflows: { triage: { auto: true } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects `auto` on the defaults block", () => {
    // Widening must be opted into per workflow, never inherited from a block
    // that exists to tune the agent.
    const result = githubAppConfigSchema.safeParse({ version: 1, defaults: { auto: true } });
    expect(result.success).toBe(false);
  });

  it("a typo fails the whole document rather than being ignored", () => {
    // strictObject: the repo then falls back to DEFAULT_REPO_POLICY, where auto
    // is false, so a misspelling cannot silently leave auto-review on.
    expect(parseReview({ autos: true }).success).toBe(false);
  });
});
