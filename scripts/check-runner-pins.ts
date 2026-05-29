#!/usr/bin/env bun
/**
 * CI guard: every `runs-on:` in .github/workflows/ targets an explicitly
 * versioned runner image, not a `*-latest` rolling alias. GitHub force-moves
 * the `ubuntu-latest` / `windows-latest` / `macos-latest` aliases to a new
 * image major on its own schedule (the ubuntu-latest alias moved 22.04 -> 24.04
 * in early 2025; 24.04 -> 26.04 is on the runner-images roadmap), so a workflow pinned
 * to the alias can change the OS, preinstalled tool versions, and Docker
 * daemon under it without any commit to this repo. Pinning to `ubuntu-24.04`
 * makes the runner an explicit, reviewable input. See issue #173.
 *
 * GitHub Actions expressions (`runs-on: ${{ matrix.runner }}`) are skipped:
 * the literal value is decided by the matrix, whose entries are themselves
 * `*-XX.YY` literals this scan does not reach (they are `runner:` keys, not
 * `runs-on:` keys). If a matrix ever feeds an alias in, pin it at the matrix
 * entry instead.
 *
 * Scope: scalar `runs-on:` values only (the only form in this repo). The
 * array form (`runs-on: [self-hosted, linux]`) and runner-group mapping form
 * are not parsed; if either is introduced, extend `RUNS_ON_RE` and add a
 * fixture.
 *
 * Exit 0 when every runner is explicitly pinned, 1 otherwise with a per-line
 * report on stderr.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `RUNNER_PINS_REPO_ROOT` env override exists solely so the test suite can
// point the gate at a fixture tree without copying the script. Production
// invocations leave it unset and resolve `repoRoot` from the script's own
// location.
const repoRoot =
  process.env["RUNNER_PINS_REPO_ROOT"] ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = join(repoRoot, ".github", "workflows");

// `runs-on:` line, capturing the runner label as the first whitespace-
// delimited token. `\S+` stops at the first space, so a trailing `# comment`
// is naturally excluded from the capture.
const RUNS_ON_RE = /^\s*runs-on:\s*(\S+)/;
// A rolling alias is any label ending in `-latest` (ubuntu-latest,
// windows-latest, macos-latest, and any future variant).
const LATEST_RE = /-latest$/;

interface Violation {
  file: string;
  line: number;
  label: string;
}

function workflowFiles(): string[] {
  let entries: string[];
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- constant path
    entries = readdirSync(WORKFLOW_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.endsWith(".yml") || e.endsWith(".yaml"))
    .map((e) => join(WORKFLOW_DIR, e));
}

function checkFile(path: string): Violation[] {
  const out: Violation[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- enumerated from .github/workflows/
  const lines = readFileSync(path, "utf-8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Skip fully commented-out lines (e.g. a disabled `#   runs-on: foo`).
    if (line.trimStart().startsWith("#")) continue;
    const match = RUNS_ON_RE.exec(line);
    if (match === null) continue;
    // Strip surrounding quotes: `runs-on: "ubuntu-24.04"` is legal YAML and
    // must not be misread for the quote characters.
    const label = (match[1] as string).replace(/^["']|["']$/g, "");
    // GitHub Actions expression: literal value lives in the matrix, not here.
    if (label.includes("${{")) continue;
    if (LATEST_RE.test(label)) {
      out.push({ file: relative(repoRoot, path), line: i + 1, label });
    }
  }
  return out;
}

function main(): void {
  const violations = workflowFiles().flatMap(checkFile);
  if (violations.length === 0) {
    console.log("OK: every `runs-on:` in .github/workflows/ pins an explicit runner image");
    return;
  }
  console.error(`ERROR: ${String(violations.length)} runner(s) on a \`*-latest\` rolling alias:\n`);
  for (const v of violations) {
    console.error(`  - ${v.file}:${String(v.line)} runs-on \`${v.label}\``);
  }
  console.error(
    "\nFix: replace the alias with the explicit image it currently resolves to, e.g.\n" +
      "  runs-on: ubuntu-24.04\n" +
      "so a future rolling bump of the alias cannot silently change the runner.",
  );
  process.exit(1);
}

main();
