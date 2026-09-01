#!/usr/bin/env bun
/**
 * Validate a `.github-app.yaml` on disk against the same `githubAppConfigSchema`
 * the bot uses, so an author can catch mistakes before pushing.
 *
 * Unlike the generated JSON Schema (structural only), this runs the real zod
 * pipeline, so `.refine` / `.superRefine` checks (prompt-ref path traversal,
 * IANA timezone validity, glob safety, duplicate action names) are covered too.
 *
 * Usage: bun run scripts/validate-repo-config.ts <path-to-.github-app.yaml>
 *
 * Exit 0 on a valid document; 1 on a missing argument, a path that is not a
 * regular file, a YAML parse failure, or any schema issue.
 */

import { readFileSync, statSync } from "node:fs";

import { parse as parseYaml } from "yaml";

import { githubAppConfigSchema } from "../src/repo-config/schema";

const path = process.argv[2];
if (path === undefined || path === "") {
  console.error("Usage: bun run scripts/validate-repo-config.ts <path-to-.github-app.yaml>");
  process.exit(1);
}

// `statSync().isFile()`, not `existsSync`: a directory exists, so the bare
// existence check would fall through and report the resulting EISDIR as a
// YAML parse failure.
let isFile = false;
try {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-supplied path, this is a local CLI
  isFile = statSync(path).isFile();
} catch {
  isFile = false;
}
if (!isFile) {
  console.error(`${path}: not found, or not a regular file`);
  process.exit(1);
}

let doc: unknown;
try {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-supplied path, this is a local CLI
  doc = parseYaml(readFileSync(path, "utf-8"));
} catch (err) {
  console.error(`${path}: YAML parse failed`);
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const parsed = githubAppConfigSchema.safeParse(doc);
if (!parsed.success) {
  console.error(`${path}: ${String(parsed.error.issues.length)} validation issue(s)`);
  for (const issue of parsed.error.issues) {
    console.error(
      `  - ${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`,
    );
  }
  process.exit(1);
}

console.log(`${path}: valid`);
