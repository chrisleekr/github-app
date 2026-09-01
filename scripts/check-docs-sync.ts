#!/usr/bin/env bun
/**
 * Fails CI when a PR touches `src/workflows/**` without also updating
 * any page under `docs/use/workflows/`.
 *
 * Reads the diff between `BASE_SHA...HEAD_SHA` (env vars set by CI;
 * three-dot range, so commits unique to the PR head relative to the
 * merge base) and compares the two path sets. Tests and markdown
 * files under `src/workflows/` are exempt.
 */
import { spawnSync } from "node:child_process";
import { exit } from "node:process";

const WORKFLOW_PATH = /^src\/workflows\//;
const WORKFLOW_EXEMPT = /^src\/workflows\/.*\.(test\.ts|md)$/;
const DOC_PATH = /^docs\/use\/workflows\/.*\.md$/;

function diffFiles(base: string, head: string): string[] {
  const res = spawnSync("git", ["diff", "--name-only", `${base}...${head}`], {
    encoding: "utf8",
  });
  if (res.status !== 0) {
    console.error("git diff failed:", res.stderr);
    exit(2);
  }
  return res.stdout.split("\n").filter((l) => l.length > 0);
}

const base = process.env["BASE_SHA"] ?? "origin/main";
const head = process.env["HEAD_SHA"] ?? "HEAD";

const files = diffFiles(base, head);

const touchedWorkflows = files.filter((f) => WORKFLOW_PATH.test(f) && !WORKFLOW_EXEMPT.test(f));
const touchedDoc = files.some((f) => DOC_PATH.test(f));

if (touchedWorkflows.length > 0 && !touchedDoc) {
  console.error(
    [
      "❌ Doc-sync check failed.",
      "",
      "The following src/workflows/ files changed without a matching",
      "update under docs/use/workflows/:",
      ...touchedWorkflows.map((f) => `  - ${f}`),
      "",
      "Update the relevant docs/use/workflows/*.md page in this PR, or",
      "mark the change as test/docs-only by moving it under",
      "test/workflows/**/*.test.ts or src/workflows/**/*.md.",
    ].join("\n"),
  );
  exit(1);
}

console.log(
  `✓ Doc-sync check passed (${String(touchedWorkflows.length)} workflow files changed, doc updated: ${String(touchedDoc)})`,
);
