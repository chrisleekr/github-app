/**
 * Per-job workspace cleanup helpers (issue #221).
 *
 * A daemon job owns a "workspace triple" rooted at its workDir:
 *   - `<workDir>`            the cloned repo
 *   - `<workDir>.cred.sh`    the git credential helper holding the install token
 *   - `<workDir>-artifacts`  the sibling summary dir (IMPLEMENT.md / REVIEW.md / ...)
 *
 * The pipeline removes all three on a clean run. A SIGKILL / OOM / eviction
 * skips that path and orphans the triple, leaking disk and a short-lived token.
 * `removeWorkspaceTripleSync` is the synchronous last-resort path used by the
 * daemon's exit and cancel handlers; `sweepStaleWorkspaces` is the TTL reaper
 * run once at daemon startup to reclaim orphans from a prior lifetime.
 */

import { rmSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** Minimal structural logger; only `.info(obj, msg)` is used. */
interface Logger {
  info: (obj: object, msg: string) => void;
}

/**
 * Synchronously remove a workspace triple, best-effort. Each removal is
 * isolated so one failure (e.g. a busy file) does not skip the others. Safe
 * to call when paths are absent (`force: true`). Used on the process-exit and
 * cancel paths where async cleanup is not an option.
 */
export function removeWorkspaceTripleSync(workDir: string): void {
  // Self-enforce the scoped-job invariant: an empty workDir would make the
  // calls below target CWD-relative `.cred.sh` / `-artifacts`. Callers also
  // guard, but a force-rm helper must not depend on every caller remembering.
  if (workDir === "") return;
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // Best effort: leak is acceptable, blocking exit is not.
  }
  try {
    rmSync(`${workDir}.cred.sh`, { force: true });
  } catch {
    // Best effort.
  }
  try {
    rmSync(`${workDir}-artifacts`, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
}

/**
 * Sweep stale workspace entries under `cloneBaseDir` older than `ttlMs`,
 * by entry mtime. Tolerant of a missing base dir and of concurrent removal
 * (a live job deleting its own workspace mid-sweep). Emits one structured
 * log line and returns counts for observability.
 *
 * Each entry is removed via `rm(..., { recursive: true })`, so a stale clone
 * dir, its sibling `.cred.sh`, and its `-artifacts` dir are reaped as three
 * independent entries (each carries its own mtime). This per-entry signal is
 * safe because the sweep runs once at process startup, before any job of this
 * lifetime exists, over a process-local `cloneBaseDir` (pod-local ephemeral
 * storage, never a shared volume), so no in-flight job's workspace is reaped.
 */
export async function sweepStaleWorkspaces(
  cloneBaseDir: string,
  ttlMs: number,
  log: Logger,
): Promise<{ swept: number; retained: number; durationMs: number }> {
  const startedAt = Date.now();
  let swept = 0;
  let retained = 0;

  let entries: string[];
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- cloneBaseDir is config, not user input
    await mkdir(cloneBaseDir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- cloneBaseDir is config, not user input
    entries = await readdir(cloneBaseDir);
  } catch {
    // Base dir unreadable / uncreatable: nothing to sweep.
    return { swept: 0, retained: 0, durationMs: Date.now() - startedAt };
  }

  const cutoff = Date.now() - ttlMs;

  for (const entry of entries) {
    const full = join(cloneBaseDir, entry);
    try {
      // eslint-disable-next-line no-await-in-loop, security/detect-non-literal-fs-filename -- full is join()-constructed
      const { mtimeMs } = await stat(full);
      if (mtimeMs < cutoff) {
        // eslint-disable-next-line no-await-in-loop -- sequential rm bounds peak fd/IO; full is join()-constructed
        await rm(full, { recursive: true, force: true });
        swept++;
      } else {
        retained++;
      }
    } catch {
      // Concurrent removal or transient stat/rm error: skip this entry.
    }
  }

  const durationMs = Date.now() - startedAt;
  log.info({ event: "workspace.sweep", swept, retained, durationMs }, "Swept stale workspaces");
  return { swept, retained, durationMs };
}
