#!/usr/bin/env bun
/**
 * Generate `schema/github-app.schema.json` from `githubAppConfigSchema`, the
 * same zod schema the runtime validates `.github-app.yaml` against. Authors
 * point their editor at the generated file with a modeline:
 *
 *   # yaml-language-server: $schema=https://raw.githubusercontent.com/chrisleekr/github-app/main/schema/github-app.schema.json
 *
 * STRUCTURAL ONLY. `z.toJSONSchema` cannot express `.refine` / `.superRefine`,
 * so the emitted schema covers key names, types, enums and bounds but NOT the
 * cross-field runtime checks: prompt-ref path traversal, IANA timezone
 * validity, glob safety in `review.path_filters`, and duplicate scheduled-action
 * names. A document the editor calls clean can still be rejected at runtime.
 *
 * `{ io: "input" }` and nothing else: `unrepresentable: "any"` is deliberately
 * NOT passed, so a future schema node that JSON Schema cannot express makes
 * this generator throw and fails the CI gate loudly, instead of silently
 * degrading that field to `{}`.
 *
 * Without a flag: (re)writes schema/github-app.schema.json.
 * --check (CI): exits 1 if the committed file differs by even one byte.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { githubAppConfigSchema } from "../src/repo-config/schema";

// `CONFIG_SCHEMA_REPO_ROOT` override exists solely so the test suite can point
// the generator at a fixture tree. Production invocations leave it unset and
// resolve from the script's own location.
const repoRoot =
  process.env["CONFIG_SCHEMA_REPO_ROOT"] ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_JSON = join(repoRoot, "schema/github-app.schema.json");

// Two spaces + trailing newline. NOT prettier's JSON style: prettier collapses
// short arrays (`"required": ["form", "text"]`) that JSON.stringify always
// expands, so the artifact is listed in .prettierignore rather than being
// double-formatted. One formatter owns the file, which is what makes the
// byte-exact `--check` comparison below meaningful.
const generated = z.toJSONSchema(githubAppConfigSchema, { io: "input" }) as JsonObject;
addPromptShorthands(generated);

const rendered = `${JSON.stringify(generated, null, 2)}\n`;

type JsonObject = Record<string, unknown>;

/**
 * `promptRefSchema` is a `z.preprocess` that folds the authoring shorthands
 * (`{ inline }`, `{ ref }`, `{ ref, entrypoint }`) into the tagged
 * `{ form, ... }` union the runtime works with. `z.toJSONSchema` only ever
 * sees the post-preprocess side, so the emitted `oneOf` requires `form` on
 * every branch and an editor would flag `prompt: { inline: "..." }` as
 * invalid, which is the form the docs and every example actually recommend.
 *
 * This is a false negative, not a missed positive: unlike the dropped
 * `.refine` checks noted above, it rejects documents the runtime accepts. So
 * the authoring shapes are added back here rather than merely documented.
 *
 * Structural match on the emitted union, and it THROWS when the anchor is
 * gone, so a schema change that moves the node fails the CI gate instead of
 * silently shipping a schema that lost the shorthands again.
 */
function addPromptShorthands(root: JsonObject): void {
  const stringMin1 = { type: "string", minLength: 1 };
  const repoPattern = { type: "string", pattern: "^[\\w.-]+\\/[\\w.-]+$" };
  let patched = 0;

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const obj = node as JsonObject;
    const branches = obj["oneOf"];
    if (Array.isArray(branches) && isTaggedPromptUnion(branches)) {
      const inlineText = inlineTextSchema(branches);
      obj["oneOf"] = [
        ...branches,
        // `{ inline: "..." }` -- no sibling keys, matching the preprocess,
        // which returns the raw value untouched when it sees one so the
        // union rejects a misspelling instead of dropping it.
        {
          type: "object",
          properties: { inline: inlineText },
          required: ["inline"],
          additionalProperties: false,
        },
        // `{ ref: "..." }` plus the optional siblings. File and folder form
        // are one branch here: they are told apart by a trailing slash or the
        // presence of `entrypoint`, which JSON Schema cannot express, and the
        // runtime check still applies.
        {
          type: "object",
          properties: { ref: stringMin1, entrypoint: stringMin1, repo: repoPattern },
          required: ["ref"],
          additionalProperties: false,
        },
      ];
      patched += 1;
      return;
    }
    Object.values(obj).forEach(visit);
  };

  visit(root);
  if (patched === 0) {
    throw new Error(
      "gen-config-schema: could not find the tagged prompt union to widen.\n" +
        "If promptRefSchema changed shape, update addPromptShorthands to match, " +
        "or drop it if the preprocess is gone.",
    );
  }
}

/** A `oneOf` whose branches are all `form`-tagged prompt objects. */
function isTaggedPromptUnion(branches: readonly unknown[]): boolean {
  if (branches.length === 0) return false;
  return branches.every((b) => {
    if (typeof b !== "object" || b === null) return false;
    const props = (b as JsonObject)["properties"];
    if (typeof props !== "object" || props === null) return false;
    const form = (props as JsonObject)["form"];
    if (typeof form !== "object" || form === null) return false;
    const constant = (form as JsonObject)["const"];
    return constant === "inline" || constant === "file" || constant === "folder";
  });
}

/** Reuse the bounds the generator already emitted for the inline branch. */
function inlineTextSchema(branches: readonly unknown[]): unknown {
  for (const b of branches) {
    const props = (b as JsonObject)["properties"] as JsonObject | undefined;
    const form = props?.["form"] as JsonObject | undefined;
    if (form?.["const"] === "inline" && props?.["text"] !== undefined) return props["text"];
  }
  throw new Error("gen-config-schema: inline prompt branch has no `text` schema to reuse");
}

if (process.argv.includes("--check")) {
  let committed: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- constant repo-relative path
    committed = readFileSync(SCHEMA_JSON, "utf-8");
  } catch (err) {
    // Only a missing file means "stale, regenerate it". EACCES / EISDIR are
    // environment faults that regenerating will not fix, and reporting them
    // as drift sends the operator down the wrong path.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    committed = "";
  }
  if (committed !== rendered) {
    console.error(
      "schema/github-app.schema.json is stale vs src/repo-config/schema.ts.\n" +
        "Regenerate it with: bun run gen-config-schema",
    );
    process.exit(1);
  }
  console.log("schema/github-app.schema.json is up to date");
} else {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- constant repo-relative path
  mkdirSync(dirname(SCHEMA_JSON), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- constant repo-relative path
  writeFileSync(SCHEMA_JSON, rendered);
  console.log(`Wrote ${SCHEMA_JSON} (${String(rendered.length)} bytes)`);
}
