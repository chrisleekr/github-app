/**
 * `scripts/validate-repo-config.ts` (issue #3, deliverable 3).
 *
 * Local pre-flight for `.github-app.yaml` authors: run the real
 * `githubAppConfigSchema` over a file on disk and report the same issue list
 * the bot would, before the config is ever pushed.
 *
 * Exit-code contract (C11-C13): 0 + a success line on stdout for a valid file;
 * non-zero + the issue text on stderr for a YAML or schema failure; non-zero
 * with usage / not-found text for a missing or bogus argument.
 *
 * The stderr assertions are load-bearing: `bun run` itself exits non-zero when
 * the script is absent, so an exit-code-only assertion would pass vacuously.
 * They assert the literal strings the script itself owns, never a loose
 * `/yaml|valid/i` shape: the fixture path is part of every message the script
 * prints, so a regex that the path can satisfy is no assertion at all. The
 * fixture directory prefix is deliberately neutral (`cfgfix-`) for the same
 * reason.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "validate-repo-config.ts");

function run(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", "run", SCRIPT, ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

const fixtures: string[] = [];
function fixtureFile(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), "cfgfix-"));
  fixtures.push(root);
  const file = join(root, ".github-app.yaml");
  writeFileSync(file, contents);
  return file;
}

afterEach(() => {
  while (fixtures.length > 0) {
    const f = fixtures.pop();
    if (f !== undefined) rmSync(f, { recursive: true, force: true });
  }
});

describe("scripts/validate-repo-config.ts", () => {
  it("C11: exits 0 and prints a success line for a valid config", () => {
    const file = fixtureFile(
      [
        "version: 1",
        "enabled: true",
        "triggers:",
        "  ignore_authors:",
        "    - renovate[bot]",
        "",
      ].join("\n"),
    );
    const { exitCode, stdout } = run([file]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`${file}: valid`);
  });

  it("C12: exits non-zero with the parse error for malformed YAML", () => {
    const file = fixtureFile("version: 1\n  bad: [unclosed\n");
    const { exitCode, stderr } = run([file]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(`${file}: YAML parse failed`);
    // The YAML branch must not be satisfied by the schema branch: the two
    // report different failures and only one of them is under test here.
    expect(stderr).not.toContain("validation issue(s)");
  });

  it("C12: exits non-zero with the issue list for a schema-invalid config", () => {
    // A misspelled workflow key, the most common authoring mistake; the strict
    // object schema surfaces it as an `unrecognized_keys` issue.
    const file = fixtureFile("version: 1\nworkflows:\n  revue: {}\n");
    const { exitCode, stderr } = run([file]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(`${file}: 1 validation issue(s)`);
    expect(stderr).toContain("revue");
  });

  it("C13: exits non-zero when the path is a directory rather than a file", () => {
    // `existsSync` is true for a directory, so the read would fail with
    // EISDIR and be misreported as a YAML parse failure.
    const file = fixtureFile("version: 1\n");
    const dir = dirname(file);
    const { exitCode, stderr } = run([dir]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(`${dir}: not found, or not a regular file`);
    expect(stderr).not.toContain("YAML parse failed");
  });

  it("C13: exits non-zero with a usage message when no path is given", () => {
    const { exitCode, stderr } = run([]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/usage/i);
  });

  it("C13: exits non-zero with a not-found message naming the path", () => {
    const missing = join(tmpdir(), "definitely-not-here-9f2a.yaml");
    const { exitCode, stderr } = run([missing]);
    expect(exitCode).not.toBe(0);
    // Naming the path is what distinguishes the script's own not-found message
    // from Bun's module-resolution error, which also reads "not found".
    expect(stderr).toContain(missing);
    expect(stderr).toMatch(/not found|no such file/i);
  });
});
