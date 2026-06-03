/**
 * T046b: static FR-009 guard. Refuses to ship code that could
 * push --force, reset --hard, delete branches, rewrite history, or
 * call any merge API from inside the ship workflow.
 *
 * Wired into `bun run check`. Greps every `.ts` file under the
 * ship-relevant subtrees for forbidden literal strings. False positives
 * (test fixtures, JSDoc that mentions the prohibition) are addressed by
 * keeping the patterns specific.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// T046b scope: the NEW ship_intents lifecycle code under
// `src/workflows/ship/`. Legacy handlers under `src/workflows/handlers/`
// embed agent prompt strings that DOCUMENT what the agent must not do
// (e.g., "NEVER call `gh pr merge`"); those documentation lines must
// not trigger the guard. The runtime test in T046a covers the legacy
// handlers via mocked tool-call recorders.
//
// US3 extension (specs/20260429-212559-ship-iteration-wiring T035):
// the daemon-side scoped executors live under `src/daemon/` as
// `scoped-<kind>-executor.ts`, outside the ship-workflow tree but governed by
// the same FR-009 prohibitions. They are DERIVED from the filesystem rather
// than a hardcoded list so a renamed or removed executor cannot leave a stale
// entry that crashes the scan with ENOENT (issue #203). The scan stays narrowed
// to the scoped-executor naming pattern: other `src/daemon/` files embed agent
// prompts that document `--force` semantics legitimately.
const SCAN_ROOTS = ["src/workflows/ship"];
const SCOPED_EXECUTOR_DIR = "src/daemon";
const SCOPED_EXECUTOR_RE = /^scoped-.+-executor\.ts$/;

function scopedExecutorFiles(): string[] {
  // Fail-closed like walk(): let a missing src/daemon dir throw rather than
  // silently scan nothing and report clean. `withFileTypes` + `isFile()` skips
  // a directory that happens to match the regex (it would EISDIR on the later
  // readFileSync otherwise), mirroring walk()'s isFile guard.
  const files = readdirSync(SCOPED_EXECUTOR_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SCOPED_EXECUTOR_RE.test(entry.name))
    .map((entry) => join(SCOPED_EXECUTOR_DIR, entry.name))
    .sort();
  // Fail-closed on convention drift: if the naming pattern ever changes so that
  // NO executor matches, fail loudly instead of silently scanning none, which
  // would re-open the dead-guard hole from a different direction (issue #203).
  if (files.length === 0) {
    throw new Error(
      `check-no-destructive: no files matched ${String(SCOPED_EXECUTOR_RE)} under ${SCOPED_EXECUTOR_DIR}; ` +
        "the scoped-executor naming convention may have drifted. Update SCOPED_EXECUTOR_RE.",
    );
  }
  return files;
}

const FORBIDDEN: { readonly pattern: RegExp; readonly description: string }[] = [
  { pattern: /git\s+push\s+--force(?!-with-lease-if)/i, description: "git push --force" },
  { pattern: /git\s+push\s+--force-with-lease/i, description: "git push --force-with-lease" },
  { pattern: /git\s+push\s+-f\b/i, description: "git push -f" },
  { pattern: /git\s+push\s+\+/, description: "git push with + force-refspec" },
  { pattern: /git\s+push\s+--mirror/i, description: "git push --mirror" },
  { pattern: /git\s+reset\s+--hard\b/i, description: "git reset --hard" },
  { pattern: /git\s+branch\s+-D\b/i, description: "git branch -D" },
  { pattern: /git\s+push\b[^"\n]*\s--delete\b/i, description: "git push --delete" },
  { pattern: /git\s+filter-branch/i, description: "git filter-branch" },
  { pattern: /git\s+filter-repo/i, description: "git filter-repo" },
  { pattern: /git\s+replace\b/i, description: "git replace" },
  { pattern: /\bgh\s+pr\s+merge/i, description: "gh pr merge" },
  { pattern: /mergePullRequest\s*\(/, description: "mergePullRequest GraphQL mutation" },
  { pattern: /mergeBranch\s*\(/, description: "mergeBranch GraphQL mutation" },
];

function* walk(dir: string): Generator<string> {
  // Fail-closed: this is a CI safety guard. Swallowing readdir/stat errors
  // would let a missing or unreadable scan root report `clean` and silently
  // disable the check.
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walk(full);
    } else if (stat.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) {
      yield full;
    }
  }
}

function scan(
  scopedExecutors: readonly string[],
): { file: string; line: number; description: string; text: string }[] {
  const violations: { file: string; line: number; description: string; text: string }[] = [];
  const visited = new Set<string>();
  const fileIterables: Iterable<string>[] = SCAN_ROOTS.map((r) => walk(r));
  fileIterables.push(scopedExecutors);
  for (const iter of fileIterables) {
    for (const file of iter) {
      if (visited.has(file)) continue;
      visited.add(file);
      // Skip self; this guard file documents the patterns it checks for.
      if (file.endsWith("check-no-destructive-actions.ts")) continue;
      const text = readFileSync(file, "utf8");
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        // Skip pure comment lines that document the prohibition: `//` line
        // comments, block-comment bodies (`*`), and single-line block comments
        // (`/* ... */`). A scoped executor's prompt strings legitimately quote
        // the forbidden calls inside such comments.
        const stripped = line.trim();
        if (stripped.startsWith("//") || stripped.startsWith("*") || stripped.startsWith("/*")) {
          continue;
        }
        for (const rule of FORBIDDEN) {
          if (rule.pattern.test(line)) {
            violations.push({
              file,
              line: i + 1,
              description: rule.description,
              text: line.trim(),
            });
          }
        }
      }
    }
  }
  return violations;
}

// Enumerate the scoped executors once so the scan set and the summary count
// are always consistent and src/daemon is read a single time per run.
const scopedExecutors = scopedExecutorFiles();
const violations = scan(scopedExecutors);
if (violations.length > 0) {
  console.error("FR-009 destructive-action guard: violations found");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.description}`);
    console.error(`    ${v.text}`);
  }
  process.exit(1);
}
console.log(
  `FR-009 destructive-action guard: clean (${SCAN_ROOTS.length} roots, ${scopedExecutors.length} scoped executors scanned)`,
);
