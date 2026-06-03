#!/usr/bin/env bun
/**
 * Em-dash sweep + CI gate.
 *
 * Modes:
 *   bun scripts/em-dash-sweep.ts <path> [<path> ...]   # rewrite files in place
 *   bun scripts/em-dash-sweep.ts --check               # exit 1 if any in-scope file contains U+2014
 *
 * Rules, applied per line in this priority order:
 *   1.  Markdown table empty cell  |  —  |   ->  | _none_ |
 *   2.  Heading line (^#+ ...)              ->  first ` — ` becomes ': '
 *   3a. Bullet definition  ^\s*[-*+]\s+TERM — EXPL  ->  TERM: EXPL
 *       (TERM excludes ':' so it never re-fires on a term that already has a
 *       colon; also skipped when TERM has unbalanced backticks so we don't
 *       mutate a markdown inline-code span.)
 *   3b. Inline aside `X — Y — Z` (≤60 chars between em dashes) -> `, X, `
 *   3c. JSDoc continuation `^\s*\* — ` -> drop the em dash
 *   3d. Test-name string `describe|it|test("X — Y")` -> `:`
 *   4.  Default ` — ` substitution. Outside a Markdown table row, when the
 *       right side begins with an article/pronoun (the/this/that/these/those/
 *       it/we/you/a/an), use `: `; otherwise `, `. Inside a `|...|` table
 *       row always use `, ` so cells stay compact.
 *   5.  No-space `a—b` -> `a, b`. The em dash without surrounding spaces
 *       is the emphatic-correction idiom in American English (`tasks—not
 *       dilution`), NOT a hyphen — collapsing to `a-b` would manufacture
 *       non-words like `tasks-not`.
 *   6.  End-of-line continuation ` —` -> `,`
 *
 * Fenced code blocks ` ``` ` are NOT processed: lines between fences are
 * passed through verbatim, since em dashes inside code samples are usually
 * load-bearing.
 *
 * After all rules, any remaining U+2014 is reported per file and the file
 * is left untouched at that line; the human resolves it.
 *
 * Skip list (hard-coded so the gate stays trustworthy):
 *   src/db/migrations/**, CHANGELOG.md,
 *   test/**\/fixtures/**, node_modules/**, .git/**,
 *   build outputs (dist/, coverage/, site/),
 *   this script itself.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const EM = "—";
const SCRIPT_REL = relative(REPO_ROOT, import.meta.path);

const SKIP_PATTERNS: RegExp[] = [
  /^src\/db\/migrations\//,
  /^CHANGELOG\.md$/,
  /^test\/.*\/fixtures\//,
  /(^|\/)node_modules\//,
  /^\.git\//,
  /^dist\//,
  /^coverage\//,
  /^site\//,
  new RegExp(`^${SCRIPT_REL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
];

const TEXT_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".md",
  ".mdx",
  ".yml",
  ".yaml",
  ".json",
  ".jsonc",
  ".sql",
  ".sh",
  ".fish",
  ".bash",
  ".html",
  ".css",
  ".toml",
  ".env",
]);

type Result = {
  path: string;
  before: number;
  after: number;
  /** Em dashes the heuristic could NOT auto-resolve (file still contains them). */
  unresolved: { line: number; text: string }[];
  /** Em dashes present in the original (post-skip), even if the heuristic
   *  would clean them. Used by --check to report file/line pointers when
   *  someone slips an em dash into a file the rules would otherwise
   *  silently rewrite. */
  offending: { line: number; text: string }[];
};

function isSkipped(rel: string): boolean {
  return SKIP_PATTERNS.some((re) => re.test(rel));
}

function isTextFile(path: string): boolean {
  const ext = extname(path).toLowerCase();
  if (TEXT_EXT.has(ext)) return true;
  const base = path.split("/").pop() ?? "";
  // Filenames where the prefix (not the extension) is the load-bearing
  // identifier: `Dockerfile`, `Dockerfile.daemon`, `Makefile.in`, `README`,
  // `CONTRIBUTING.md` (already covered by .md), `LICENSE`. Match by prefix
  // so multi-segment names like `Dockerfile.orchestrator` are included.
  if (/^(Dockerfile|Makefile|README|CONTRIBUTING|LICENSE)/i.test(base)) return true;
  // Dotfiles: `.env`, `.env.example`, `.gitleaks.toml`, `.trivyignore.yaml`.
  // `extname` returns '' for `.env` and `.example` for `.env.example`, so
  // neither matches TEXT_EXT directly. Include any dotfile whose name
  // contains a known text token.
  if (base.startsWith(".")) {
    if (/^\.env(\.|$)/i.test(base)) return true;
    if (/\.(toml|ya?ml|json|jsonc|md|sh|fish|bash)$/i.test(base)) return true;
  }
  return false;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(REPO_ROOT, full);
    if (isSkipped(rel)) continue;
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else if (st.isFile() && isTextFile(full)) yield full;
  }
}

function transformLine(line: string): string {
  // Rule 1: markdown table empty cell  |  —  |  -> | _none_ |
  // Apply to every cell on the line (the table row may have multiple).
  line = line.replace(/\|\s*—\s*\|/g, "| _none_ |");
  // The above only catches non-overlapping matches. A row like `| — | — |`
  // leaves the middle pipe shared, so re-run once.
  line = line.replace(/\|\s*—\s*\|/g, "| _none_ |");

  // Rule 2: heading line  -> first ` — ` becomes ': '
  if (/^\s*#{1,6}\s/.test(line) && line.includes(` ${EM} `)) {
    line = line.replace(` ${EM} `, ": ");
  }

  // Rule 3a: bullet/list term definition
  //   ^\s*[-*+]\s+TERM — EXPL  ->  TERM: EXPL
  // TERM is restricted to non-colon text so the rule does NOT re-fire on a
  // bullet whose term already ends in `:` (e.g. `- **Foo:** body — note`),
  // which would produce a double colon. We also require TERM to have a
  // balanced backtick count so we don't fire on a bullet whose ` — `
  // sits inside a markdown inline-code span (which would mutate the code
  // sample). Runs BEFORE the parenthetical rule (3b) so a bullet's leading
  // em dash is consumed as a definition colon rather than misread as half
  // of an inline aside.
  {
    const m = line.match(/^(\s*[-*+]\s+)([^:\n]*?) — (.*)$/);
    if (m && (m[2].match(/`/g)?.length ?? 0) % 2 === 0) {
      line = `${m[1]}${m[2]}: ${m[3]}`;
    }
  }

  // Rule 3b: parenthetical double em dash `X — Y — Z` (inline aside).
  // Content between the em dashes is capped at 60 chars so this only fires
  // for true inline asides. Long stretches of prose between em dashes are
  // almost always two separate clause-introducers, each of which deserves
  // its own ': ' or ', ' decision from rule 4 below.
  line = line.replace(/(?<!^)\s—\s([^—\n]{1,60})\s—\s/g, ", $1, ");

  // Rule 3c: JSDoc/block-comment continuation `^\s*\* — ` (em dash carries
  // a clause from the previous JSDoc line). Drop the em dash; the line still
  // reads as a JSDoc continuation. Mirrors the line-end rule 6 from the
  // other side of the wrap.
  line = line.replace(/^(\s*\*)\s+—\s+/, "$1 ");

  // Rule 3d: test-name strings `describe("X — Y"` / `it("X — Y"` /
  // `test("X — Y"`. Em dash inside a test label introduces a sub-context,
  // which reads as ': ' not ', '. Left side excludes `:` so this does not
  // re-fire on a name that already contains a colon (would double-colon).
  line = line.replace(
    /\b(describe|it|test)\((['"`])([^'"`\n:]*?) — ([^'"`\n]*?)\2/g,
    "$1($2$3: $4$2",
  );

  // Rule 4: default ` — ` substitution.
  //
  // In Markdown table rows (line starts with `|`), use `, ` so cell content
  // stays compact. In prose lines, when the right-hand side begins with an
  // article/pronoun/demonstrative ("the", "this", "that", "these", "those",
  // "it", "we", "you", "a", "an"), use `: ` because the right side is a
  // clarifying clause (en-dash idiom) and `, ` would produce a comma splice.
  // Otherwise default to `, ` (mid-sentence pause).
  if (/^\s*\|/.test(line)) {
    line = line.replaceAll(` ${EM} `, ", ");
  } else {
    line = line.replace(/ — (the |this |that |these |those |it |we |you |a |an )/g, ": $1");
    line = line.replaceAll(` ${EM} `, ", ");
  }

  // Rule 5: no-space `a—b` -> `a, b`. The space-less em dash is the
  // emphatic-correction idiom in American English (`tasks—not dilution`
  // means "tasks, NOT dilution"), not a hyphen. Collapsing to `a-b` would
  // manufacture non-words like `tasks-not`, `detected-are`, `yet-explicitly`.
  line = line.replace(/(\w)—(\w)/g, "$1, $2");

  // Rule 6: end-of-line continuation ` —` (clause carries to next line) -> `,`
  line = line.replace(/ —\s*$/, ",");

  return line;
}

function processFile(path: string, write: boolean): Result {
  const original = readFileSync(path, "utf8");
  if (!original.includes(EM)) {
    return { path, before: 0, after: 0, unresolved: [], offending: [] };
  }
  const lines = original.split("\n");
  const out: string[] = [];
  // Track Markdown fenced-code-block state across lines. Em dashes inside
  // ``` blocks are usually load-bearing (code samples, verbatim output,
  // diagrams), so leave them verbatim AND exclude them from both the sweep
  // count and the --check gate count. Only matters for .md / .mdx; other
  // extensions never use ```-as-fence semantics, but the toggle is harmless.
  let inFence = false;
  let beforeCount = 0;
  const offending: Result["offending"] = [];
  lines.forEach((line, i) => {
    if (/^\s{0,3}```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      return;
    }
    if (inFence) {
      out.push(line);
      return;
    }
    const hits = (line.match(/—/g) ?? []).length;
    if (hits > 0) {
      beforeCount += hits;
      offending.push({ line: i + 1, text: line });
    }
    out.push(transformLine(line));
  });
  if (beforeCount === 0) {
    // All em dashes were inside fences. Treat as a no-op for both write
    // mode and --check (the gate intentionally ignores fenced code).
    return { path, before: 0, after: 0, unresolved: [], offending: [] };
  }
  const next = out.join("\n");
  // Count residual em dashes the same way as the pre-pass: only outside
  // fenced code blocks. Otherwise the gate would report a regression for
  // a verbatim em dash a contributor put inside a code sample.
  let afterCount = 0;
  const unresolved: Result["unresolved"] = [];
  let resInFence = false;
  out.forEach((l, i) => {
    if (/^\s{0,3}```/.test(l)) {
      resInFence = !resInFence;
      return;
    }
    if (resInFence) return;
    const hits = (l.match(/—/g) ?? []).length;
    if (hits > 0) {
      afterCount += hits;
      unresolved.push({ line: i + 1, text: l });
    }
  });
  if (write && next !== original) writeFileSync(path, next);
  return { path, before: beforeCount, after: afterCount, unresolved, offending };
}

function main() {
  const args = process.argv.slice(2);
  const checkMode = args.includes("--check");
  const targets = args.filter((a) => !a.startsWith("--"));

  const files: string[] = [];
  if (checkMode || targets.length === 0) {
    for (const f of walk(REPO_ROOT)) files.push(f);
  } else {
    for (const t of targets) {
      const abs = resolve(t);
      const st = statSync(abs);
      if (st.isDirectory()) {
        for (const f of walk(abs)) files.push(f);
      } else if (isTextFile(abs) && !isSkipped(relative(REPO_ROOT, abs))) {
        files.push(abs);
      }
    }
  }

  let totalBefore = 0;
  let totalAfter = 0;
  let touched = 0;
  const offendingFiles: Result[] = [];
  const unresolvedFiles: Result[] = [];

  for (const f of files) {
    const r = processFile(f, !checkMode);
    if (r.before > 0) {
      totalBefore += r.before;
      totalAfter += r.after;
      if (!checkMode && r.before !== r.after) touched++;
      offendingFiles.push(r);
      if (r.after > 0) unresolvedFiles.push(r);
    }
  }

  if (checkMode) {
    if (totalBefore > 0) {
      console.error(
        `em-dash check: FAIL (${totalBefore} occurrences across ${offendingFiles.length} files)`,
      );
      for (const f of offendingFiles) {
        console.error(`  ${relative(REPO_ROOT, f.path)}: ${f.before}`);
        for (const u of f.offending.slice(0, 3)) {
          console.error(`    L${u.line}: ${u.text.trim().slice(0, 120)}`);
        }
      }
      if (unresolvedFiles.length > 0) {
        console.error(
          `\nNote: ${unresolvedFiles.length} file(s) above contain em dashes the heuristic could not auto-resolve. Hand-edit those lines.`,
        );
      }
      process.exit(1);
    }
    console.log("em-dash check: OK (zero occurrences in scope)");
    return;
  }

  console.log(`em-dash sweep: rewrote ${totalBefore - totalAfter} occurrences in ${touched} files`);
  if (unresolvedFiles.length > 0) {
    console.log(`unresolved (heuristic could not handle, ${totalAfter} total):`);
    for (const f of unresolvedFiles) {
      console.log(`  ${relative(REPO_ROOT, f.path)}: ${f.after}`);
      for (const u of f.unresolved.slice(0, 5)) {
        console.log(`    L${u.line}: ${u.text.trim().slice(0, 140)}`);
      }
    }
  }
}

main();
