import { describe, expect, it } from "bun:test";
import type { Octokit } from "octokit";
import type { Logger } from "pino";

import { promptRefSchema } from "./config-schema";
import { resolvePrompt } from "./prompt-resolver";

const noopLog = {
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  error: () => undefined,
} as unknown as Logger;

/** Parse a YAML-style prompt object through the schema's preprocess. */
function prompt(raw: unknown): ReturnType<typeof promptRefSchema.parse> {
  return promptRefSchema.parse(raw);
}

function b64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

/**
 * Fake octokit whose `repos.getContent` serves from a path → entry map.
 * A file entry yields `{ type: "file", content }`; a dir entry yields the
 * array of its children.
 */
function fakeOctokit(
  files: Record<string, string>,
  dirs: Record<string, { path: string; type: "file" | "dir" }[]> = {},
): Octokit {
  return {
    rest: {
      repos: {
        // eslint-disable-next-line @typescript-eslint/require-await
        getContent: async ({ path }: { path: string }) => {
          if (dirs[path] !== undefined) {
            return { data: dirs[path].map((e) => ({ ...e, name: e.path })) };
          }
          const content = files[path];
          if (content === undefined) {
            const err = new Error("Not Found") as Error & { status: number };
            err.status = 404;
            throw err;
          }
          return { data: { type: "file", content: b64(content) } };
        },
      },
    },
  } as unknown as Octokit;
}

const ctxRepo = { owner: "acme", repo: "widgets" };

/** Assert an async call rejects. (`expect().rejects` types as void here.) */
async function expectRejects(run: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await run();
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
}

describe("resolvePrompt", () => {
  it("returns inline text verbatim", async () => {
    const text = await resolvePrompt(
      fakeOctokit({}),
      prompt({ inline: "do the research" }),
      ctxRepo,
      noopLog,
    );
    expect(text).toBe("do the research");
  });

  it("fetches a single file ref", async () => {
    const text = await resolvePrompt(
      fakeOctokit({ ".github/skills/research.md": "RESEARCH PROMPT" }),
      prompt({ ref: ".github/skills/research.md" }),
      ctxRepo,
      noopLog,
    );
    expect(text).toBe("RESEARCH PROMPT");
  });

  it("throws when a file ref is missing", async () => {
    await expectRejects(() =>
      resolvePrompt(fakeOctokit({}), prompt({ ref: "missing.md" }), ctxRepo, noopLog),
    );
  });

  it("concatenates a folder bundle, entrypoint first", async () => {
    const octokit = fakeOctokit(
      {
        ".github/skills/research/SKILL.md": "ENTRY",
        ".github/skills/research/extra.md": "EXTRA",
      },
      {
        ".github/skills/research": [
          { path: ".github/skills/research/extra.md", type: "file" },
          { path: ".github/skills/research/SKILL.md", type: "file" },
        ],
      },
    );
    const text = await resolvePrompt(
      octokit,
      prompt({ ref: ".github/skills/research/", entrypoint: "SKILL.md" }),
      ctxRepo,
      noopLog,
    );
    // Entrypoint section comes first regardless of directory order.
    expect(text.indexOf("ENTRY")).toBeLessThan(text.indexOf("EXTRA"));
    expect(text).toContain("=== FILE: .github/skills/research/SKILL.md ===");
  });

  it("throws when the folder entrypoint is absent", async () => {
    const octokit = fakeOctokit(
      { ".github/skills/research/other.md": "x" },
      { ".github/skills/research": [{ path: ".github/skills/research/other.md", type: "file" }] },
    );
    await expectRejects(() =>
      resolvePrompt(
        octokit,
        prompt({ ref: ".github/skills/research/", entrypoint: "SKILL.md" }),
        ctxRepo,
        noopLog,
      ),
    );
  });
});
