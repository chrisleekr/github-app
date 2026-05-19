import { describe, expect, it } from "bun:test";

import { githubAppConfigSchema } from "./config-schema";

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
