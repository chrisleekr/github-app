# What the bot will and won't do

This page enumerates the boundary the bot enforces on itself. The boundary is defended in two places: handler code and a static guard at `scripts/check-no-destructive-actions.ts` that runs in `bun run check`.

## Static guard: destructive actions

`scripts/check-no-destructive-actions.ts` scans `src/workflows/ship/` (recursive) and the scoped daemon executors (`src/daemon/scoped-*-executor.ts`, derived from the filesystem so the set cannot go stale) for the following patterns. The CI gate (`bun run check:no-destructive`, wired into `ci.yml`) fails the build on any match outside of comments.

| Pattern                                                                | Why blocked                                                     |
| ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| `git push --force` / `git push -f`                                     | Always replaced with `--force-with-lease` after a clean rebase. |
| `git reset --hard`                                                     | The bot never discards local work without explicit intent.      |
| `git branch -D` / `git push --delete`                                  | Branch deletion is a human action.                              |
| `git filter-branch` / `git filter-repo`                                | History rewriting is out of scope.                              |
| `gh pr merge` / `mergePullRequest` (GraphQL) / `mergeBranch` (GraphQL) | The bot never merges.                                           |

`src/workflows/handlers/resolve.ts` documents a non-negotiable requirement that `octokit.rest.pulls.merge` must never be called (header comment + a step in the agent's instruction set). It is a documented constraint, not a runtime guard: the static guard above is what fails the build if anyone tries.

## Pause / resume / abort (ship sessions)

| Verb             | Behaviour                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bot:stop`       | Sets `ship_intents.status = 'paused'`. The deadline keeps counting down. The session can be resumed.                                                                                                                     |
| `bot:resume`     | Verifies no foreign push has landed since the pause, clears the Valkey cancel flag, re-enqueues the continuation. Refused if a manual push happened during the pause.                                                    |
| `bot:abort-ship` | Sets the Valkey cancel flag at `ship:cancel:{intent_id}`, waits ≤2 s for the next cooperative checkpoint, force-transitions to `aborted_by_user`. After abort, the bot performs zero further mutating actions on the PR. |

## Foreign-push semantics

The shepherding probe detects when a non-bot principal has pushed to the PR's head branch. The session terminates immediately with `human_took_over` + `terminal_blocker_category='manual-push-detected'`. The bot does not race the human or revert the push.

## Forbidden target branches

`SHIP_FORBIDDEN_TARGET_BRANCHES` (comma-separated) lists branches `bot:ship` will refuse to shepherd into. Typical values: `main`, `production`, `release`. The refusal is delivered as a maintainer-facing reply naming the offending branch; no `ship_intents` row is created.

## Reviews

`bot:review` posts findings as **inline comments**, one MCP call per finding. It never:

- Submits a top-level `APPROVE` or `REQUEST_CHANGES` review (those are human prerogatives).
- Merges the PR.
- Bundles findings into a single wall-of-text review POST.

## Idempotency

A duplicate webhook delivery, same `X-GitHub-Delivery` header or same tracking-comment marker, is dropped before any work runs. The fast in-memory `Map` is lost on restart; the durable check (looking for the bot's hidden delivery marker in existing tracking comments) survives crash loops.

## Fork PRs

The bot's installation token cannot push to a fork branch. PR-side workflows (`review`, `resolve`, `ship`) detect this, post a top-level comment asking the contributor to rebase, and proceed against the stale head, flagging affected findings in the final report.
