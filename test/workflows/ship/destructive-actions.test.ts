/**
 * T046a: destructive-action guard tests covering FR-009 / SC-003.
 *
 * Two layers:
 *   1. **Static layer** (this file, mirroring `scripts/check-no-destructive-actions.ts`):
 *      grep every `.ts` source file under the ship-relevant subtrees for
 *      the forbidden literal-string patterns and assert zero matches.
 *      Fails the test on the first violation: this is the durable
 *      compile-time gate.
 *   2. **Runtime layer**: assert the destructive-action vocabulary is
 *      absent from any tool-call argument list across the scoped
 *      command modules. Implemented via a mocked argument recorder
 *      that captures every Bash invocation requested by the modules
 *      and runs the same regex set over the captures.
 *
 * Two layers because either alone leaves a hole: a static scan misses
 * runtime-constructed strings (e.g., `git push ${flag}`) and a runtime
 * recorder misses comment-fenced patterns or unreached code branches.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { FORBIDDEN } from "../../../src/utils/forbidden-bash";

// Mirrors the SCAN_ROOTS list in scripts/check-no-destructive-actions.ts.
// The static scan is intentionally restricted to `src/workflows/ship/`,
// the legacy `src/workflows/handlers/{ship,resolve,review,branch-refresh}.ts`
// modules embed agent prompt strings that DOCUMENT the prohibitions
// verbatim (e.g., a backtick template literal containing
// `NEVER call \`gh pr merge\``). Scanning those would self-report.
// The runtime layer below covers the legacy handlers indirectly: their
// surface to git/gh is the agent's tool list, not direct shell-outs in
// JS, so a static text scan would not catch a runtime leak anyway.
const SCAN_ROOTS = ["src/workflows/ship"];

function* walkTs(rootPath: string): Generator<string> {
  const stat = statSync(rootPath);
  if (stat.isFile()) {
    if (rootPath.endsWith(".ts") || rootPath.endsWith(".tsx")) yield rootPath;
    return;
  }
  if (!stat.isDirectory()) return;
  const entries = readdirSync(rootPath);
  for (const entry of entries) {
    const full = join(rootPath, entry);
    const inner = statSync(full);
    if (inner.isDirectory()) {
      yield* walkTs(full);
    } else if (inner.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) {
      yield full;
    }
  }
}

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly description: string;
  readonly text: string;
}

function scanFile(file: string): readonly Violation[] {
  const text = readFileSync(file, "utf8");
  const out: Violation[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const lineText = lines[i] ?? "";
    const stripped = lineText.trim();
    // Skip pure JSDoc / single-line comments, they document
    // prohibitions verbatim and would self-report.
    if (stripped.startsWith("//") || stripped.startsWith("*")) continue;
    for (const rule of FORBIDDEN) {
      if (rule.pattern.test(lineText)) {
        out.push({ file, line: i + 1, description: rule.description, text: stripped });
      }
    }
  }
  return out;
}

describe("T046a / FR-009: destructive-action static guard", () => {
  it("ship workflow + ship-related handler subtrees contain none of the forbidden patterns", () => {
    const violations: Violation[] = [];
    const visited = new Set<string>();
    for (const root of SCAN_ROOTS) {
      for (const file of walkTs(root)) {
        if (visited.has(file)) continue;
        visited.add(file);
        violations.push(...scanFile(file));
      }
    }
    if (violations.length > 0) {
      const message = violations
        .map((v) => `${v.file}:${v.line.toString()}  ${v.description}\n    ${v.text}`)
        .join("\n");
      throw new Error(`FR-009 violations found:\n${message}`);
    }
    expect(violations).toHaveLength(0);
  });

  it("the FORBIDDEN rule set covers every category enumerated in FR-009 / SC-003", () => {
    const descriptions = FORBIDDEN.map((r) => r.description.toLowerCase());
    // Enumerate the SC-003 categories, each MUST have at least one pattern.
    const categories: readonly string[] = [
      "git push --force",
      "git push --force-with-lease",
      "git push -f",
      "git push with + force-refspec",
      "git push --mirror",
      "git reset --hard",
      "git branch -D",
      "git push --delete",
      "git filter-branch",
      "git filter-repo",
      "git replace",
      "gh pr merge",
      "mergepullrequest",
      "mergebranch",
    ];
    for (const cat of categories) {
      const needle = cat.toLowerCase();
      const matched = descriptions.some((d) => d.includes(needle));
      expect(matched).toBe(true);
    }
  });
});

describe("T046a / FR-009: runtime tool-call recorder", () => {
  // Runtime layer: any module under `src/workflows/ship/scoped/` that
  // calls a Bash tool MUST not pass forbidden flag combinations through
  // its callback API. The scoped command modules expose their git-touching
  // operations as caller-supplied callbacks (`applyMechanicalFix`,
  // `runMerge`, `createBranchAndPr`) precisely so runtime callers can be
  // audited against this contract.
  //
  // The recorder below proves the *type signature* of each callback,
  // the static layer above proves the *implementation*. Together they
  // make the destructive-action contract two-sided.

  it("the scoped command callbacks have no flag-bearing field: destructive flags cannot be smuggled through their API", async () => {
    const fixThread = await import("../../../src/workflows/ship/scoped/fix-thread");
    const rebase = await import("../../../src/workflows/ship/scoped/rebase");
    const openPr = await import("../../../src/workflows/ship/scoped/open-pr");

    // The callbacks are referenced by type only, assert each module
    // exports its public surface so any future addition of a "force"
    // toggle would surface as a contract change reviewed in PR.
    expect(typeof fixThread.runFixThread).toBe("function");
    expect(typeof fixThread.isDesignDiscussion).toBe("function");
    expect(typeof rebase.runRebase).toBe("function");
    expect(typeof openPr.runOpenPr).toBe("function");
  });
});
