import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

const SCRIPT = resolve(import.meta.dir, "..", "..", "scripts", "check-claude-code-version.ts");
const fixtures: string[] = [];

function makeFixture(opts: {
  sdk: Record<string, unknown>;
  orchestrator: string;
  daemon: string;
}): string {
  const root = mkdtempSync(join(tmpdir(), "check-claude-code-version-"));
  fixtures.push(root);
  const sdkDir = join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  mkdirSync(sdkDir, { recursive: true });
  writeFileSync(join(sdkDir, "package.json"), JSON.stringify(opts.sdk));
  writeFileSync(join(root, "Dockerfile.orchestrator"), opts.orchestrator);
  writeFileSync(join(root, "Dockerfile.daemon"), opts.daemon);
  return root;
}

function runScript(repoRoot: string): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", "run", SCRIPT], {
    env: { ...process.env, CLAUDE_CODE_VERSION_REPO_ROOT: repoRoot },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

const dockerfile = (v: string): string => `FROM x\nARG CLAUDE_CODE_VERSION=${v}\nRUN true\n`;

afterEach(() => {
  for (const f of fixtures.splice(0)) rmSync(f, { recursive: true, force: true });
});

describe("scripts/check-claude-code-version.ts", () => {
  it("passes when both Dockerfiles match the SDK's claudeCodeVersion", () => {
    const root = makeFixture({
      sdk: { version: "0.3.283", claudeCodeVersion: "2.1.283" },
      orchestrator: dockerfile("2.1.283"),
      daemon: dockerfile("2.1.283"),
    });
    const r = runScript(root);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("2.1.283");
  });

  it("fails and names the stale Dockerfile when the SDK was bumped alone", () => {
    const root = makeFixture({
      sdk: { version: "0.3.283", claudeCodeVersion: "2.1.283" },
      orchestrator: dockerfile("2.1.283"),
      daemon: dockerfile("2.1.236"),
    });
    const r = runScript(root);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Dockerfile.daemon: CLAUDE_CODE_VERSION=2.1.236");
    expect(r.stderr).not.toContain("Dockerfile.orchestrator:");
  });

  it("fails when a Dockerfile has no CLAUDE_CODE_VERSION ARG", () => {
    const root = makeFixture({
      sdk: { version: "0.3.283", claudeCodeVersion: "2.1.283" },
      orchestrator: "FROM x\n",
      daemon: dockerfile("2.1.283"),
    });
    const r = runScript(root);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Dockerfile.orchestrator: CLAUDE_CODE_VERSION=<missing>");
  });

  it("fails closed when the SDK drops the claudeCodeVersion field", () => {
    const root = makeFixture({
      sdk: { version: "0.4.0" },
      orchestrator: dockerfile("2.1.283"),
      daemon: dockerfile("2.1.283"),
    });
    const r = runScript(root);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("claudeCodeVersion");
  });

  it("fails closed when the Agent SDK package.json is missing", () => {
    const root = makeFixture({
      sdk: { version: "0.3.283", claudeCodeVersion: "2.1.283" },
      orchestrator: dockerfile("2.1.283"),
      daemon: dockerfile("2.1.283"),
    });
    rmSync(join(root, "node_modules"), { recursive: true, force: true });
    const r = runScript(root);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("claude-agent-sdk");
  });

  it("fails closed when a Dockerfile is missing", () => {
    const root = makeFixture({
      sdk: { version: "0.3.283", claudeCodeVersion: "2.1.283" },
      orchestrator: dockerfile("2.1.283"),
      daemon: dockerfile("2.1.283"),
    });
    rmSync(join(root, "Dockerfile.daemon"));
    const r = runScript(root);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("Dockerfile.daemon");
  });
});
