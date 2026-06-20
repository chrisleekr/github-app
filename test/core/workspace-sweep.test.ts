/**
 * Unit tests for src/core/workspace-sweep.ts (issue #221).
 *
 * RED phase: the module under test does not exist yet, so the import below
 * fails at resolution time and every case errors. Production code is written
 * in the GREEN phase.
 *
 * Covers the two exports the daemon workspace-leak fix introduces:
 *  - removeWorkspaceTripleSync: synchronous best-effort removal of a workDir,
 *    its sibling `<workDir>.cred.sh`, and `<workDir>-artifacts` dir.
 *  - sweepStaleWorkspaces: TTL-based reaper over a clone base dir.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { removeWorkspaceTripleSync, sweepStaleWorkspaces } from "../../src/core/workspace-sweep";

/** No-op logger; the helper only needs `.info`. */
const log = { info: () => {}, warn: () => {}, error: () => {} };

/** Base dirs created per test; torn down in afterEach. */
const createdBases: string[] = [];

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "workspace-sweep-test-"));
  createdBases.push(base);
  return base;
}

/** Create a workspace triple rooted at `wd`: dir + `.cred.sh` + `-artifacts/`. */
function makeTriple(wd: string): void {
  mkdirSync(wd, { recursive: true });
  writeFileSync(join(wd, "file.txt"), "x");
  writeFileSync(`${wd}.cred.sh`, "#!/bin/sh\n");
  mkdirSync(`${wd}-artifacts`, { recursive: true });
  writeFileSync(join(`${wd}-artifacts`, "REVIEW.md"), "y");
}

afterEach(() => {
  while (createdBases.length > 0) {
    const base = createdBases.pop();
    if (base !== undefined) {
      rmSync(base, { recursive: true, force: true });
    }
  }
});

describe("removeWorkspaceTripleSync", () => {
  it("removes workDir, cred.sh, and artifacts", () => {
    const base = makeBase();
    const wd = join(base, "deliv-abc123");
    makeTriple(wd);

    expect(existsSync(wd)).toBe(true);
    expect(existsSync(`${wd}.cred.sh`)).toBe(true);
    expect(existsSync(`${wd}-artifacts`)).toBe(true);

    removeWorkspaceTripleSync(wd);

    expect(existsSync(wd)).toBe(false);
    expect(existsSync(`${wd}.cred.sh`)).toBe(false);
    expect(existsSync(`${wd}-artifacts`)).toBe(false);
  });

  it("is a no-op when paths are absent", () => {
    const base = makeBase();
    const wd = join(base, "does-not-exist");

    expect(() => {
      removeWorkspaceTripleSync(wd);
    }).not.toThrow();
  });

  it("is a no-op for an empty workDir (scoped job invariant)", () => {
    // A "" workDir must never make rmSync target CWD-relative `.cred.sh`.
    const before = existsSync(join(process.cwd(), ".cred.sh"));
    expect(() => {
      removeWorkspaceTripleSync("");
    }).not.toThrow();
    expect(existsSync(join(process.cwd(), ".cred.sh"))).toBe(before);
  });
});

describe("sweepStaleWorkspaces", () => {
  it("removes a stale triple and retains a fresh one", async () => {
    const base = makeBase();
    const aged = join(base, "aged");
    const fresh = join(base, "fresh");
    makeTriple(aged);
    makeTriple(fresh);

    // Backdate the aged triple's three entries to ~2h ago.
    const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(aged, oldDate, oldDate);
    utimesSync(`${aged}.cred.sh`, oldDate, oldDate);
    utimesSync(`${aged}-artifacts`, oldDate, oldDate);

    // Capture the structured log so the observability contract is pinned.
    const calls: { obj: Record<string, unknown>; msg: string }[] = [];
    const recLog = {
      info: (obj: Record<string, unknown>, msg: string) => calls.push({ obj, msg }),
    };

    const result = await sweepStaleWorkspaces(base, 60 * 60 * 1000, recLog);

    expect(existsSync(aged)).toBe(false);
    expect(existsSync(`${aged}.cred.sh`)).toBe(false);
    expect(existsSync(`${aged}-artifacts`)).toBe(false);

    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(`${fresh}.cred.sh`)).toBe(true);
    expect(existsSync(`${fresh}-artifacts`)).toBe(true);

    // Exactly six entries: three aged (swept) + three fresh (retained).
    expect(result.swept).toBe(3);
    expect(result.retained).toBe(3);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.obj).toMatchObject({ event: "workspace.sweep", swept: 3, retained: 3 });
  });

  it("reaps a stale cred.sh independently of a fresh clone dir (partial orphan)", async () => {
    // The token-bearing cred.sh is written once at clone time and never touched,
    // so a long checkout can leave it stale while the clone dir still looks fresh.
    // Each entry must be judged on its own mtime so the token is reclaimed.
    const base = makeBase();
    const wd = join(base, "partial");
    makeTriple(wd);

    const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(`${wd}.cred.sh`, oldDate, oldDate);

    const result = await sweepStaleWorkspaces(base, 60 * 60 * 1000, log);

    expect(existsSync(`${wd}.cred.sh`)).toBe(false); // token reclaimed
    expect(existsSync(wd)).toBe(true); // fresh clone dir retained
    expect(existsSync(`${wd}-artifacts`)).toBe(true); // fresh artifacts retained
    expect(result.swept).toBe(1);
    expect(result.retained).toBe(2);
  });

  it("tolerates a missing base dir", async () => {
    const base = makeBase();
    const missing = join(base, "nope");

    const result = await sweepStaleWorkspaces(missing, 60 * 60 * 1000, log);
    expect(result.swept).toBe(0);
  });
});
