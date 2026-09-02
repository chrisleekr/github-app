/**
 * Daemon-side `scoped-rebase` executor (T029, US3). Deterministic git only,
 * no Agent SDK invocation. Implements `contracts/job-kinds.md#scoped-rebase`:
 *
 *   1. Fetch PR via Octokit; abort `closed` if PR is closed/merged.
 *   2. Clone head branch to a temp dir.
 *   3. `git fetch origin <base_ref>` + `git merge origin/<base_ref>`,
 *      explicitly NO `--ff-only`, NO `--rebase`, NO `--force`.
 *   4. Push the merge commit if produced; never `-f`/`--force`/`--force-with-lease`.
 *   5. On conflict: collect paths via `git diff --name-only --diff-filter=U`,
 *      abort the merge cleanly, return `conflict` with the path list.
 *   6. Always clean up the temp dir.
 *
 * Idempotency: callers (orchestrator-side) MUST check the existing
 * tracking-comment durable layer before dispatch (per
 * `contracts/job-kinds.md` Idempotency). The executor itself is a single
 * deterministic git operation; re-deliveries with the same `triggerCommentId`
 * MUST produce equivalent outcomes.
 *
 * Static guarantees (FR-009 / SC-003): this file ships in `src/daemon/` so
 * `scripts/check-no-destructive-actions.ts` covers it; any `--force` /
 * `--force-with-lease` literal would be caught at lint time.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";
import { Octokit } from "octokit";

import { config } from "../config";
import { logger } from "../logger";
import { type RebaseOutcome, runRebase } from "../workflows/ship/scoped/rebase";

export interface ScopedRebaseExecutorInput {
  readonly installationToken: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
}

/**
 * Run the scoped-rebase pipeline end-to-end. Returns the policy-layer
 * `RebaseOutcome` so the orchestrator-side completion handler can map it
 * onto the `scoped-job-completion` payload without re-deriving the result.
 *
 * @throws when the temp-dir cannot be created or the policy callback
 *         surfaces an unrecoverable git error other than a conflict.
 */
export async function executeScopedRebase(
  input: ScopedRebaseExecutorInput,
): Promise<RebaseOutcome> {
  const log = logger.child({
    component: "daemon.scoped-rebase",
    owner: input.owner,
    repo: input.repo,
    pr_number: input.prNumber,
  });

  const octokit = new Octokit({ auth: input.installationToken });

  const baseDir = join(tmpdir(), "scoped-rebase");
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(baseDir, { recursive: true });
  const workDir = await mkdtemp(join(baseDir, `${input.owner}-${input.repo}-`));
  // `git clone` refuses to write into a non-empty directory and `mkdtemp`
  // already created `workDir`, so the clone lands in a child path. The
  // surrounding `mkdtemp` dir (with 0700 perms) still gates access; the
  // credential helper sits beside the clone target so a single `rm -rf`
  // of `workDir` cleans everything up. Surfaced by T042 S4 against
  // `@chrisleekr-bot-dev`.
  const cloneDir = join(workDir, "repo");
  // Credential helper lives INSIDE workDir so the 0700 mkdtemp directory
  // gates access (the helper file's own 0700 perms are belt-and-braces).
  const helperPath = join(workDir, ".git-credential-helper.sh");
  // The token never lands on disk: the helper reads `$GIT_TOKEN` from the
  // process env at exec time. Keeps the secret out of the script body so
  // an unusual token byte (`'`, `\`, `$`) cannot break the printf or
  // become a shell-injection sink.
  const gitEnv = { GIT_TOKEN: input.installationToken };

  try {
    return await runRebase({
      octokit,
      owner: input.owner,
      repo: input.repo,
      pr_number: input.prNumber,
      log,
      runMerge: async ({ base_ref, head_ref }) => {
        const repoUrl = `https://github.com/${input.owner}/${input.repo}.git`;
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        await writeFile(
          helperPath,
          `#!/bin/sh\nprintf 'username=x-access-token\\npassword=%s\\n' "$GIT_TOKEN"\n`,
          { mode: 0o700 },
        );

        log.info({ workDir, head_ref, base_ref }, "Cloning head branch for scoped-rebase");
        await $`git clone --branch=${head_ref} --single-branch -c credential.helper=${helperPath} ${repoUrl} ${cloneDir}`.env(
          gitEnv,
        );
        await $`git -C ${cloneDir} config credential.helper ${helperPath}`;
        await $`git -C ${cloneDir} config user.name ${config.botAppLogin}`;
        await $`git -C ${cloneDir} config user.email ${`${config.botAppLogin}@users.noreply.github.com`}`;

        // Bring base into the local clone, then merge it into head. Never
        // `--ff-only` (we want the merge commit), never `--rebase`, never
        // `--force`. The static linter rule guards against regressions.
        //
        // The clone above uses `--single-branch --branch=<head_ref>`, which
        // narrows the remote's fetch refspec to head only. A bare
        // `git fetch origin <base_ref>` then downloads the commits but
        // doesn't update `refs/remotes/origin/<base_ref>`, so the merge
        // can't resolve `origin/<base_ref>` and exits 1 with
        // "not something we can merge". Pass an explicit refspec so the
        // remote-tracking ref lands. Surfaced by T042 S4.
        await $`git -C ${cloneDir} fetch origin ${base_ref}:refs/remotes/origin/${base_ref}`.env(
          gitEnv,
        );
        const mergeResult =
          await $`git -C ${cloneDir} merge origin/${base_ref} --no-edit`.nothrow();

        if (mergeResult.exitCode === 0) {
          const stdout = mergeResult.stdout.toString();
          if (stdout.includes("Already up to date")) {
            return { status: "up-to-date" };
          }
          // Capture the merge commit SHA before pushing so we can report it.
          const headSha = (await $`git -C ${cloneDir} rev-parse HEAD`.text()).trim();
          await $`git -C ${cloneDir} push origin HEAD:${head_ref}`.env(gitEnv);
          return { status: "merged", merge_commit_sha: headSha };
        }

        // Distinguish a real conflict (unmerged index entries) from other
        // merge failures (auth, fs, unrelated histories). Throw on the
        // latter so the executor's catch path returns `halted` with the
        // git error rather than reporting a phantom conflict.
        const unmergedRaw = await $`git -C ${cloneDir} ls-files -u`.text();
        if (unmergedRaw.trim().length === 0) {
          throw new Error(
            `git merge failed (exit ${String(mergeResult.exitCode)}): ${mergeResult.stderr.toString().slice(0, 500).trim()}`,
          );
        }

        // Conflict path. Collect conflicting paths and abort cleanly.
        const conflictsRaw = await $`git -C ${cloneDir} diff --name-only --diff-filter=U`.text();
        const conflict_paths = conflictsRaw
          .split("\n")
          .map((p) => p.trim())
          .filter((p) => p.length > 0);
        const abortResult = await $`git -C ${cloneDir} merge --abort`.nothrow();
        if (abortResult.exitCode !== 0) {
          // The temp dir is rm'd in the finally below so no dirty state
          // persists, but a non-zero abort can still indicate disk pressure
          // or fs corruption, log so it surfaces in operator dashboards.
          log.warn(
            {
              exitCode: abortResult.exitCode,
              stderr: abortResult.stderr.toString().slice(0, 200),
            },
            "git merge --abort returned non-zero (non-fatal, workDir will be removed)",
          );
        }
        return { status: "conflict", conflict_paths };
      },
    });
  } finally {
    // helperPath lives inside workDir, so a single rm covers both.
    await rm(workDir, { recursive: true, force: true });
  }
}
