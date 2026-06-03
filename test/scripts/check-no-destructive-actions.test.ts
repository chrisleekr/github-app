import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

const SCRIPT = resolve(import.meta.dir, "..", "..", "scripts", "check-no-destructive-actions.ts");
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

function runScript(cwd: string): { exitCode: number; stdout: string; stderr: string } {
  // The guard resolves its scan roots relative to the working directory, so a
  // fixture tree is exercised by running the real script with cwd pointed at it.
  const proc = Bun.spawnSync(["bun", "run", SCRIPT], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

interface Fixture {
  shipFiles?: Record<string, string>;
  daemonFiles?: Record<string, string>;
}

function makeFixture(f: Fixture): string {
  const root = mkdtempSync(join(tmpdir(), "check-no-destructive-"));
  mkdirSync(join(root, "src", "workflows", "ship"), { recursive: true });
  mkdirSync(join(root, "src", "daemon"), { recursive: true });
  for (const [name, body] of Object.entries(f.shipFiles ?? {})) {
    writeFileSync(join(root, "src", "workflows", "ship", name), body);
  }
  for (const [name, body] of Object.entries(f.daemonFiles ?? {})) {
    writeFileSync(join(root, "src", "daemon", name), body);
  }
  return root;
}

const fixtures: string[] = [];
afterEach(() => {
  while (fixtures.length > 0) {
    const f = fixtures.pop();
    if (f !== undefined) rmSync(f, { recursive: true, force: true });
  }
});

describe("scripts/check-no-destructive-actions.ts", () => {
  it("runs to completion (exit 0) against the real repository", () => {
    // Regression for issue #203: a stale hardcoded SCAN_FILES entry crashed the
    // guard with ENOENT before it validated anything.
    const { exitCode } = runScript(REPO_ROOT);
    expect(exitCode).toBe(0);
  });

  it("passes a clean fixture and does not crash when only some scoped executors exist", () => {
    const root = makeFixture({
      shipFiles: { "ship.ts": "export const x = 1;\n" },
      // Only one scoped executor present. A hardcoded stale list would ENOENT
      // on the missing executors; deriving from the filesystem cannot.
      daemonFiles: { "scoped-rebase-executor.ts": "export const ok = true;\n" },
    });
    fixtures.push(root);
    const { exitCode, stdout } = runScript(root);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("clean");
  });

  it("flags a destructive call in a scoped executor", () => {
    const root = makeFixture({
      daemonFiles: { "scoped-fix-thread-executor.ts": 'await sh("gh pr merge 1");\n' },
    });
    fixtures.push(root);
    const { exitCode, stderr } = runScript(root);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("gh pr merge");
  });

  it("flags a destructive call under src/workflows/ship", () => {
    const root = makeFixture({
      shipFiles: { "rebase.ts": 'run("git push --force");\n' },
      // A clean executor keeps the daemon scan non-empty so the violation under
      // ship is the reason for the failure, not the convention-drift floor.
      daemonFiles: { "scoped-rebase-executor.ts": "export const ok = true;\n" },
    });
    fixtures.push(root);
    const { exitCode, stderr } = runScript(root);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("git push --force");
  });

  it("does not flag a comment line documenting the prohibition", () => {
    const root = makeFixture({
      daemonFiles: { "scoped-open-pr-executor.ts": "// NEVER call gh pr merge here\n" },
    });
    fixtures.push(root);
    const { exitCode } = runScript(root);
    expect(exitCode).toBe(0);
  });

  it("excludes a non-executor daemon file from the scan (narrowing boundary)", () => {
    const root = makeFixture({
      daemonFiles: {
        // Not a scoped executor: legitimately documents a destructive call in
        // an agent prompt; must NOT be scanned.
        "job-executor.ts": 'const prompt = "NEVER run gh pr merge";\nawait sh("gh pr merge 1");\n',
        // A real executor keeps the set non-empty.
        "scoped-rebase-executor.ts": "export const ok = true;\n",
      },
    });
    fixtures.push(root);
    const { exitCode } = runScript(root);
    expect(exitCode).toBe(0);
  });

  it("fails closed when the scoped-executor naming convention drifts to zero matches", () => {
    const root = makeFixture({
      // src/daemon exists but no file matches scoped-*-executor.ts.
      daemonFiles: { "renamed-executor.ts": "export const ok = true;\n" },
    });
    fixtures.push(root);
    const { exitCode, stderr } = runScript(root);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("naming convention may have drifted");
  });

  it("fails closed when src/daemon is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "check-no-destructive-"));
    mkdirSync(join(root, "src", "workflows", "ship"), { recursive: true });
    // Deliberately omit src/daemon.
    fixtures.push(root);
    const { exitCode } = runScript(root);
    expect(exitCode).not.toBe(0);
  });
});
