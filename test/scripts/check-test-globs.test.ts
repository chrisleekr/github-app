import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

const SCRIPT = resolve(import.meta.dir, "..", "..", "scripts", "check-test-globs.ts");

interface Fixture {
  runnerGlobs: string;
  testFiles: string[];
}

// Build a throwaway repo tree: a `scripts/test-isolated.sh` carrying the given
// `tests=( ... )` glob line, plus empty `*.test.ts` files at the given paths.
function makeFixture({ runnerGlobs, testFiles }: Fixture): string {
  const root = mkdtempSync(join(tmpdir(), "check-test-globs-"));
  const scriptsDir = join(root, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    join(scriptsDir, "test-isolated.sh"),
    `#!/usr/bin/env bash\ntests=(${runnerGlobs})\n`,
  );
  for (const rel of testFiles) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "");
  }
  return root;
}

function runScript(repoRoot: string): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", "run", SCRIPT], {
    env: { ...process.env, TEST_GLOBS_REPO_ROOT: repoRoot },
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
afterEach(() => {
  while (fixtures.length > 0) {
    const f = fixtures.pop();
    if (f !== undefined) rmSync(f, { recursive: true, force: true });
  }
});

describe("scripts/check-test-globs.ts", () => {
  it("exits 0 when every test file is covered by the runner globs", () => {
    const root = makeFixture({
      runnerGlobs: "test/**/*.test.ts src/**/*.test.ts",
      testFiles: ["test/foo.test.ts", "test/nested/bar.test.ts", "src/scheduler/baz.test.ts"],
    });
    fixtures.push(root);
    const { exitCode, stdout } = runScript(root);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OK: every `*.test.ts` file is reachable");
  });

  it("exits 1 and names a test file living outside the globbed roots", () => {
    // This is the issue #201 shape: runner globs only `test/`, a colocated
    // `src/**/*.test.ts` is silently dark.
    const root = makeFixture({
      runnerGlobs: "test/**/*.test.ts",
      testFiles: ["test/foo.test.ts", "src/scheduler/due-evaluator.test.ts"],
    });
    fixtures.push(root);
    const { exitCode, stderr } = runScript(root);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("1 test file(s) not matched");
    expect(stderr).toContain("src/scheduler/due-evaluator.test.ts");
    // A covered file must not be reported.
    expect(stderr).not.toContain("test/foo.test.ts");
  });

  it("ignores test files under excluded dirs at top level and nested", () => {
    const root = makeFixture({
      runnerGlobs: "test/**/*.test.ts",
      testFiles: [
        "test/foo.test.ts",
        // top-level excluded dirs (startsWith branch)
        "node_modules/some-dep/index.test.ts",
        "dist/build-output.test.ts",
        ".git/hooks/x.test.ts",
        "coverage/lcov-report/y.test.ts",
        // nested excluded dir (monorepo-style), pruned at the boundary
        "packages/x/node_modules/dep/z.test.ts",
      ],
    });
    fixtures.push(root);
    const { exitCode, stdout } = runScript(root);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OK: every `*.test.ts` file is reachable");
  });

  it("reports every uncovered file and the plural count", () => {
    const root = makeFixture({
      runnerGlobs: "test/**/*.test.ts",
      testFiles: ["test/foo.test.ts", "src/a.test.ts", "src/scheduler/b.test.ts"],
    });
    fixtures.push(root);
    const { exitCode, stderr } = runScript(root);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("2 test file(s) not matched");
    expect(stderr).toContain("src/a.test.ts");
    expect(stderr).toContain("src/scheduler/b.test.ts");
  });

  it("a lone * does not cross directory boundaries", () => {
    // `test/*.test.ts` must cover only flat files, not nested ones. This locks
    // the `[^/]*` single-segment semantics the guard relies on.
    const root = makeFixture({
      runnerGlobs: "test/*.test.ts",
      testFiles: ["test/flat.test.ts", "test/nested/deep.test.ts"],
    });
    fixtures.push(root);
    const { exitCode, stderr } = runScript(root);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("test/nested/deep.test.ts");
    expect(stderr).not.toContain("test/flat.test.ts");
  });

  it("a bare ** (no trailing slash) spans directories", () => {
    // Exercises the `**` -> `.*` branch (vs `**/` -> `(?:.*/)?`).
    const root = makeFixture({
      runnerGlobs: "src/**",
      testFiles: ["src/scheduler/due-evaluator.test.ts"],
    });
    fixtures.push(root);
    const { exitCode, stdout } = runScript(root);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OK: every `*.test.ts` file is reachable");
  });

  it("errors when the runner script has no tests=( ... ) glob array", () => {
    const root = mkdtempSync(join(tmpdir(), "check-test-globs-"));
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "test-isolated.sh"), "#!/usr/bin/env bash\necho noop\n");
    fixtures.push(root);
    const { exitCode, stderr } = runScript(root);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("found 0");
  });

  it("skips a commented-out example and parses the live glob line", () => {
    // The live line covers src/, a commented narrow example must not win.
    const root = mkdtempSync(join(tmpdir(), "check-test-globs-"));
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "src", "scheduler"), { recursive: true });
    writeFileSync(
      join(root, "scripts", "test-isolated.sh"),
      "#!/usr/bin/env bash\n# tests=(test/**/*.test.ts)\ntests=(test/**/*.test.ts src/**/*.test.ts)\n",
    );
    writeFileSync(join(root, "src", "scheduler", "c.test.ts"), "");
    fixtures.push(root);
    const { exitCode, stdout } = runScript(root);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OK: every `*.test.ts` file is reachable");
  });

  it("errors when more than one tests=( ... ) array is present", () => {
    // A commented/duplicated example must not silently shadow the live line.
    const root = mkdtempSync(join(tmpdir(), "check-test-globs-"));
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(
      join(root, "scripts", "test-isolated.sh"),
      "#!/usr/bin/env bash\ntests=(test/**/*.test.ts)\ntests=(src/**/*.test.ts)\n",
    );
    fixtures.push(root);
    const { exitCode, stderr } = runScript(root);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("found 2");
  });

  it("ignores a bash inline comment inside the tests=( ... ) array", () => {
    // `tests=( ... # note)` is a comment in bash; the words after `#` must not
    // become bogus globs that mark every file uncovered.
    const root = mkdtempSync(join(tmpdir(), "check-test-globs-"));
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(
      join(root, "scripts", "test-isolated.sh"),
      "#!/usr/bin/env bash\ntests=(test/**/*.test.ts # widened for #201)\n",
    );
    writeFileSync(join(root, "test", "foo.test.ts"), "");
    fixtures.push(root);
    const { exitCode, stdout } = runScript(root);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OK: every `*.test.ts` file is reachable");
  });

  it("does not flag test files under dot-paths the runner cannot reach", () => {
    // Bash globs run without dotglob, so a `.test.ts` under a dot-dir or a
    // dot-prefixed filename is never runner-reachable; the guard mirrors that
    // and leaves them out of scope rather than falsely reporting coverage.
    const root = makeFixture({
      runnerGlobs: "test/**/*.test.ts",
      testFiles: ["test/foo.test.ts", "test/.hidden/x.test.ts", "test/.dotfile.test.ts"],
    });
    fixtures.push(root);
    const { exitCode, stdout } = runScript(root);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OK: every `*.test.ts` file is reachable");
  });
});
