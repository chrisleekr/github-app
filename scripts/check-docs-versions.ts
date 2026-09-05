#!/usr/bin/env bun
/**
 * CI guard: every Bun version string in docs/ matches the canonical pin
 * in `.tool-versions`. Also asserts that `package.json` (engines.bun +
 * packageManager) and the two Dockerfiles agree, so the canonical pin is
 * authoritative across the repo.
 *
 * Scope: every Markdown file under docs/ plus the root-level README.md,
 * CONTRIBUTING.md and CLAUDE.md, plus the optional root-level `.gitlab-ci.yml`
 * for `oven/bun:<ver>` references. Those Markdown files are read by humans
 * on every repo visit and by the bot on every agent run, so a stale Bun pin
 * there is as damaging as one inside docs/.
 *
 * Detected forms:
 *   - bare semver "1.3.13" inside a Bun context: the line mentions `bun`
 *     (case-insensitive) and the semver is not immediately preceded by a
 *     recognised non-Bun token (e.g. `TypeScript 5.9.3`, `Node 20.x`). An
 *     unrecognised preceding word leaves the semver in scope on purpose,
 *     so a line that names both a Bun version and another version is
 *     handled without silently skipping an unexpected phrasing.
 *   - `oven/bun:<ver>` references. Digest-pinned ones in `.gitlab-ci.yml`
 *     must also agree with each other, since Docker resolves `tag@digest`
 *     by digest and would otherwise run an old image behind a fresh tag.
 *
 * Exit 0 on match, 1 on any mismatch with a per-file diff on stderr.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `DOCS_CHECK_REPO_ROOT` env override exists solely so the test suite can
// point the gate at a fixture tree without copying the script. Production
// invocations leave it unset and resolve `repoRoot` from the script's own
// location.
const repoRoot =
  process.env["DOCS_CHECK_REPO_ROOT"] ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL_VERSIONS = join(repoRoot, ".tool-versions");
const PACKAGE_JSON = join(repoRoot, "package.json");
const DOCKERFILES = [
  join(repoRoot, "Dockerfile.orchestrator"),
  join(repoRoot, "Dockerfile.daemon"),
];
const GITLAB_CI = join(repoRoot, ".gitlab-ci.yml");
const DOCS_ROOT = join(repoRoot, "docs");
// Root-level Markdown that ships outside docs/ but is just as load-bearing.
const ROOT_DOCS = ["README.md", "CONTRIBUTING.md", "CLAUDE.md"];

const SEMVER = /\d+\.\d+\.\d+/;

interface Mismatch {
  file: string;
  line: number;
  found: string;
  context: string;
}

function readBunVersionFromToolVersions(): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- constant path
  const contents = readFileSync(TOOL_VERSIONS, "utf-8");
  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^bun\s+(\d+\.\d+\.\d+)$/.exec(line);
    if (match) return match[1] as string;
  }
  throw new Error(`${TOOL_VERSIONS}: no \`bun <semver>\` line found`);
}

function checkPackageJson(canonical: string): Mismatch[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- constant path
  const raw = readFileSync(PACKAGE_JSON, "utf-8");
  const parsed = JSON.parse(raw) as {
    engines?: { bun?: string };
    packageManager?: string;
  };
  const out: Mismatch[] = [];
  const engines = parsed.engines?.bun;
  if (engines === undefined) {
    out.push({
      file: relative(repoRoot, PACKAGE_JSON),
      line: 0,
      found: "<missing>",
      context: "engines.bun",
    });
  } else {
    const enginesSemver = SEMVER.exec(engines)?.[0];
    if (enginesSemver !== canonical) {
      out.push({
        file: relative(repoRoot, PACKAGE_JSON),
        line: 0,
        found: engines,
        context: "engines.bun",
      });
    }
  }
  const pkgmgr = parsed.packageManager;
  if (pkgmgr === undefined) {
    out.push({
      file: relative(repoRoot, PACKAGE_JSON),
      line: 0,
      found: "<missing>",
      context: "packageManager",
    });
  } else {
    const pmSemver = SEMVER.exec(pkgmgr)?.[0];
    if (!pkgmgr.startsWith("bun@") || pmSemver !== canonical) {
      out.push({
        file: relative(repoRoot, PACKAGE_JSON),
        line: 0,
        found: pkgmgr,
        context: "packageManager",
      });
    }
  }
  return out;
}

function checkDockerfile(path: string, canonical: string): Mismatch[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- constant paths above
  const contents = readFileSync(path, "utf-8");
  const lines = contents.split("\n");
  // Scans every `oven/bun:<ver>` occurrence, not just the FROM line: comments,
  // ENV lines and RUN snippets embed the tag too and rot independently (e.g.
  // `# /root is mode 700 in oven/bun:<ver>` in Dockerfile.daemon).
  const out = ovenTagMismatches(path, scanOvenRefs(lines), canonical);
  const foundBase = lines.some((line) =>
    /^FROM\s+oven\/bun:(\d+\.\d+\.\d+)\s+AS\s+base/.test(line),
  );
  if (!foundBase) {
    out.push({
      file: relative(repoRoot, path),
      line: 0,
      found: "<missing>",
      context: "no `FROM oven/bun:<ver> AS base` line",
    });
  }
  return out;
}

function checkGitlabCi(canonical: string): Mismatch[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- optional repo-root path
  if (!existsSync(GITLAB_CI)) return [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- optional repo-root path
  const contents = readFileSync(GITLAB_CI, "utf-8");
  const refs = scanOvenRefs(contents.split("\n"));
  const out = ovenTagMismatches(GITLAB_CI, refs, canonical);

  // A file that exists but yields nothing to check is indistinguishable from a
  // passing one. A renamed job, an `image: $BUN_IMAGE` variable or a mirror
  // registry prefix would otherwise retire this gate silently.
  if (refs.length === 0) {
    out.push({
      file: relative(repoRoot, GITLAB_CI),
      line: 0,
      found: "<missing>",
      context: "no `oven/bun:<ver>` reference",
    });
    return out;
  }

  // Docker resolves `tag@digest` by digest, so a bumped tag left with a stale
  // digest still runs the old image while the tag check above passes. Every
  // digest-pinned reference in this file is the same image by construction, so
  // disagreement means a half-updated pair. This cannot catch a pair that is
  // consistently stale without a registry call; the tag check covers that.
  const pinned = refs.filter((ref) => ref.digest !== undefined);
  if (new Set(pinned.map((ref) => ref.digest)).size > 1) {
    for (const ref of pinned) {
      out.push({
        file: relative(repoRoot, GITLAB_CI),
        line: ref.line,
        found: ref.digest ?? "",
        context: "digest disagrees with the other digest-pinned oven/bun references",
      });
    }
  }
  return out;
}

function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- traversal of repo-controlled path
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- constructed from repo-controlled name
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkMarkdown(full));
    } else if (st.isFile() && entry.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

// Markdown files in scope: everything under docs/ plus the root-level docs
// listed in `ROOT_DOCS` that actually exist (a missing one is skipped so the
// gate stays portable if a file is later removed).
function collectMarkdownFiles(): string[] {
  const out = walkMarkdown(DOCS_ROOT);
  for (const name of ROOT_DOCS) {
    const full = join(repoRoot, name);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- constant repo-root names
    if (existsSync(full)) out.push(full);
  }
  return out;
}

const OVEN_RE = /oven\/bun:(\d+\.\d+\.\d+)[\w.-]*(?:@(sha256:[0-9a-f]{64}))?/g;

interface OvenRef {
  readonly line: number;
  readonly tag: string;
  readonly digest: string | undefined;
  readonly context: string;
}

// Single scanner for every `oven/bun:<ver>` occurrence, shared by the
// Dockerfile, .gitlab-ci.yml and Markdown checkers. OVEN_RE is stateful
// (`/g`), so centralising the `lastIndex` reset keeps a future change to the
// match rules from landing at two of the three call sites.
function scanOvenRefs(lines: string[]): OvenRef[] {
  const refs: OvenRef[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    OVEN_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = OVEN_RE.exec(line)) !== null) {
      refs.push({ line: i + 1, tag: match[1] ?? "", digest: match[2], context: line.trim() });
    }
  }
  return refs;
}

function ovenTagMismatches(path: string, refs: OvenRef[], canonical: string): Mismatch[] {
  return refs
    .filter((ref) => ref.tag !== canonical)
    .map((ref) => ({
      file: relative(repoRoot, path),
      line: ref.line,
      found: `oven/bun:${ref.tag}`,
      context: ref.context,
    }));
}
const BUN_SEMVER_RE = /(?<![\w.-])(\d+\.\d+\.\d+)(?![\w.-])/g;

// Tokens that own a non-Bun version on a line that also mentions Bun. A
// semver immediately preceded by one of these is not a Bun version. This is
// a denylist on purpose: an unknown preceding word leaves the semver in
// scope, so the gate fails loud on an unflagged stale pin rather than
// silently skipping a phrasing it did not anticipate.
const NON_BUN_OWNERS = new Set([
  "typescript",
  "node",
  "nodejs",
  "postgres",
  "postgresql",
  "redis",
  "valkey",
  "openssl",
]);

// The word, if any, that immediately precedes a semver at `idx`. Only
// version-range decoration (whitespace, `≥ ≤ > < = * ~ ^`) is skipped on the
// way back; any other non-word char (`|`, backtick, `(`, `:` …) is treated
// as a hard boundary and yields "". The word run accepts `.` and `-` so a
// dotted token like `Node.js` is captured whole, then those separators are
// stripped before return so the result matches a flat `NON_BUN_OWNERS` entry
// (`nodejs`). Used to reject semvers owned by a non-Bun token on a line that
// also mentions Bun: the line-level `/bun/i` test alone is too loose for
// prose-dense files like CLAUDE.md where a TypeScript version and a Bun
// version share one line.
function precedingWord(line: string, idx: number): string {
  let j = idx - 1;
  while (j >= 0 && /[\s≥≤><=*~^]/.test(line[j] ?? "")) j--;
  let word = "";
  while (j >= 0 && /[A-Za-z.-]/.test(line[j] ?? "")) {
    word = (line[j] ?? "") + word;
    j--;
  }
  return word.replace(/[.-]/g, "");
}

function checkDocFile(path: string, canonical: string): Mismatch[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- enumerated from docs/ and ROOT_DOCS
  const contents = readFileSync(path, "utf-8");
  const lines = contents.split("\n");
  const out = ovenTagMismatches(path, scanOvenRefs(lines), canonical);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/bun/i.test(line)) continue;
    BUN_SEMVER_RE.lastIndex = 0;
    let semverMatch: RegExpExecArray | null;
    while ((semverMatch = BUN_SEMVER_RE.exec(line)) !== null) {
      const idx = semverMatch.index;
      const before = line.slice(Math.max(0, idx - 12), idx);
      // Skip the `oven/bun:<ver>` matches we already handled above.
      if (/oven\/bun:$/.test(before)) continue;
      // Skip a semver owned by a recognised non-Bun token (e.g. `TypeScript
      // 5.9.3`). An empty or unrecognised preceding word leaves the semver
      // in scope: the gate must fail loud on a stale pin, not skip wording
      // it did not anticipate.
      const owner = precedingWord(line, idx).toLowerCase();
      if (NON_BUN_OWNERS.has(owner)) continue;
      const found = semverMatch[1] as string;
      if (found !== canonical) {
        out.push({
          file: relative(repoRoot, path),
          line: i + 1,
          found,
          context: line.trim(),
        });
      }
    }
  }
  return out;
}

function main(): void {
  const canonical = readBunVersionFromToolVersions();
  const mismatches: Mismatch[] = [];
  mismatches.push(...checkPackageJson(canonical));
  for (const df of DOCKERFILES) mismatches.push(...checkDockerfile(df, canonical));
  mismatches.push(...checkGitlabCi(canonical));
  for (const md of collectMarkdownFiles()) mismatches.push(...checkDocFile(md, canonical));

  if (mismatches.length === 0) {
    console.log(
      `OK: every Bun version reference matches .tool-versions canonical \`${canonical}\``,
    );
    return;
  }

  console.error(
    `ERROR: ${String(mismatches.length)} Bun version reference(s) disagree with .tool-versions canonical \`${canonical}\`:\n`,
  );
  for (const m of mismatches) {
    const loc = m.line > 0 ? `${m.file}:${String(m.line)}` : m.file;
    console.error(`  - ${loc} [${m.context}] found \`${m.found}\`, expected \`${canonical}\``);
  }
  console.error(
    "\nFix: update each above to match `.tool-versions`, or bump `.tool-versions` and rerun.",
  );
  process.exit(1);
}

main();
