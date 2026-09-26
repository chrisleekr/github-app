#!/usr/bin/env bun
/**
 * CI guard: the Claude Code CLI baked into both images must be the exact
 * version the installed @anthropic-ai/claude-agent-sdk was built against
 * (its package.json `claudeCodeVersion`).
 *
 * Both images set CLAUDE_CODE_PATH=/usr/bin/claude, so the SDK drives the
 * globally installed CLI from the Dockerfile ARG, never the one it bundles.
 * Bumping the SDK in package.json therefore changes nothing at runtime until
 * the ARG moves too. The 0.3.283 SDK bump shipped with CLI 2.1.236 and the
 * API rejected claude-opus-5-5 ("version 2.1.280 or newer is required").
 *
 * Exit 0 when every Dockerfile matches, 1 otherwise.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Override exists so the test suite can point the gate at a fixture tree.
const repoRoot =
  process.env["CLAUDE_CODE_VERSION_REPO_ROOT"] ??
  resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SDK_PACKAGE_JSON = join(
  repoRoot,
  "node_modules",
  "@anthropic-ai",
  "claude-agent-sdk",
  "package.json",
);
const DOCKERFILES = ["Dockerfile.orchestrator", "Dockerfile.daemon"];
const ARG_RE = /^ARG CLAUDE_CODE_VERSION=(\S+)\s*$/m;

function sdkClaudeCodeVersion(): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- constant path
  const pkg = JSON.parse(readFileSync(SDK_PACKAGE_JSON, "utf-8")) as {
    claudeCodeVersion?: unknown;
  };
  // Fail closed: a missing field means the SDK changed its metadata shape and
  // the pairing can no longer be checked.
  if (typeof pkg.claudeCodeVersion !== "string" || pkg.claudeCodeVersion === "") {
    throw new Error(`${SDK_PACKAGE_JSON}: no "claudeCodeVersion" field`);
  }
  return pkg.claudeCodeVersion;
}

function main(): void {
  const expected = sdkClaudeCodeVersion();
  const mismatches: string[] = [];
  for (const name of DOCKERFILES) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- constant list above
    const match = ARG_RE.exec(readFileSync(join(repoRoot, name), "utf-8"));
    const actual = match?.[1];
    if (actual !== expected) {
      mismatches.push(`  - ${name}: CLAUDE_CODE_VERSION=${actual ?? "<missing>"}`);
    }
  }
  if (mismatches.length === 0) {
    console.log(`OK: both Dockerfiles pin Claude Code ${expected}, matching the Agent SDK`);
    return;
  }
  console.error(
    `ERROR: @anthropic-ai/claude-agent-sdk expects Claude Code ${expected}, but:\n` +
      `${mismatches.join("\n")}\n\n` +
      `Fix: set \`ARG CLAUDE_CODE_VERSION=${expected}\` in both Dockerfiles.`,
  );
  process.exit(1);
}

main();
