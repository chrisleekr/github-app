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
const rendered = `${JSON.stringify(z.toJSONSchema(githubAppConfigSchema, { io: "input" }), null, 2)}\n`;

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
