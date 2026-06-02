#!/usr/bin/env bun
/**
 * CI guard: every `*.test.ts` file in the repo is reachable by the test
 * runner's glob set. `bun run test` shells out to `scripts/test-isolated.sh`,
 * which runs each match of a hard-coded glob in its own Bun process (per-file
 * isolation is required because `mock.module()` is process-global and bleeds
 * across files). A test file that lives outside the globbed roots is never
 * executed, yet CI stays green because the runner only inspects files it
 * already matched. The scheduler PR (#159) widened that dark spot from 1 to 4
 * colocated test files under src/ without anyone noticing. See issue #201.
 *
 * This guard derives the glob set from `scripts/test-isolated.sh` itself (the
 * single source of truth), enumerates every `*.test.ts` under the repo, and
 * fails if any file is not matched by at least one runner glob. Tying the
 * check to the actual runner line means narrowing the runner glob, or adding a
 * test file under a new root, both trip the guard instead of silently going
 * dark. Same defensive shape as `check-action-pins.ts` / `check-runner-pins.ts`.
 *
 * Exit 0 when every test file is covered, 1 otherwise with a per-file report
 * on stderr.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `TEST_GLOBS_REPO_ROOT` env override exists solely so the test suite can
// point the gate at a fixture tree without copying the script. Production
// invocations leave it unset and resolve `repoRoot` from the script's own
// location.
const repoRoot =
  process.env["TEST_GLOBS_REPO_ROOT"] ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_SCRIPT = join(repoRoot, "scripts", "test-isolated.sh");

// Directories that never hold first-party test suites. `node_modules` and
// `dist` would otherwise flood the scan with vendored / built `.test.ts`.
const EXCLUDED_DIRS = ["node_modules", "dist", ".git", "coverage"];

// Extract the glob patterns from the runner's `tests=( ... )` array literal.
// The runner is the source of truth for what CI actually executes. The match
// is anchored to a line-start assignment and required to be unique, so a
// commented-out or documented `tests=( ... )` example cannot shadow the live
// line and silently become the source of truth.
function runnerGlobs(scriptPath: string): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- constant path under repoRoot
  const src = readFileSync(scriptPath, "utf-8");
  const matches = [...src.matchAll(/^[ \t]*tests=\(([^)]*)\)/gm)];
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one top-level \`tests=( ... )\` glob array in ${scriptPath}, found ${String(matches.length)}. ` +
        "Update this guard if the runner moved or duplicated its glob source of truth.",
    );
  }
  return (matches[0]?.[1] ?? "")
    .split(/\s+/)
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s.length > 0 && !s.startsWith("#"));
}

// Convert a shell glob (`**`, `*`, literal segments) to an anchored RegExp
// matching a POSIX-style relative path. `**/` matches zero or more directories;
// a lone `*` stays within a single path segment.
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? "";
    if (c === "*") {
      if ((glob[i + 1] ?? "") === "*") {
        i++;
        if ((glob[i + 1] ?? "") === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if ("/.+?()[]{}^$|\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

// Enumerate every `*.test.ts` under the repo as forward-slash paths relative to
// `root`, pruning vendored / built directories before descending so the scan
// never materialises the whole of node_modules.
function collectTestFiles(absDir: string, relDir: string): string[] {
  const out: string[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- repoRoot is the script's own tree or a test fixture
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.includes(entry.name)) continue;
      out.push(...collectTestFiles(join(absDir, entry.name), rel));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      out.push(rel);
    }
  }
  return out;
}

function main(): void {
  const matchers = runnerGlobs(RUNNER_SCRIPT).map(globToRegExp);
  const uncovered = collectTestFiles(repoRoot, "").filter(
    (f) => !matchers.some((re) => re.test(f)),
  );

  if (uncovered.length === 0) {
    console.log("OK: every `*.test.ts` file is reachable by the test-runner glob set");
    return;
  }

  console.error(
    `ERROR: ${String(uncovered.length)} test file(s) not matched by any glob in scripts/test-isolated.sh:\n`,
  );
  for (const f of uncovered) {
    console.error(`  - ${f}`);
  }
  console.error(
    "\nThese files never run in CI. Fix: widen the `tests=( ... )` glob in\n" +
      "scripts/test-isolated.sh to cover their root, e.g. add `src/**/*.test.ts`.",
  );
  process.exit(1);
}

main();
