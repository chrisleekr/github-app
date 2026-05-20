# `bot:review`

Reads a PR diff in full, cross-references with the rest of the codebase, and posts findings as inline comments.

| Field           | Value                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Label           | `bot:review`                                                                                                                          |
| Mention         | `@chrisleekr-bot review this PR` · `@chrisleekr-bot do a code review` · `@chrisleekr-bot check for issues`                            |
| Accepted target | Pull request                                                                                                                          |
| Requires prior  | _none_                                                                                                                                |
| Artifact        | `$BOT_ARTIFACT_DIR/REVIEW.md` (sibling temp dir, never committed to the repo)                                                         |
| Side effects    | Inline review comments via `mcp__github_inline_comment__create_inline_comment`; force-push of a clean rebase if branch is behind base |
| Source          | `src/workflows/handlers/review.ts`                                                                                                    |

## Method

The agent operates as a senior engineer:

- Reads every changed file in full, not just the diff window.
- Cross-references callers, tests, and related code.
- Runs `bun test`, `bun run typecheck`, `bun run lint` when uncertain.
- Only posts findings it can defend with evidence.

Each finding is posted as an inline comment in a three-block layout (status line, bold one-line title, prose reasoning, then a `**Suggested fix:**` line). The same shape is used by `resolve`, `bot:fix-thread`, and `bot:chat-thread` (which replaced `bot:explain-thread` as the conversational executor for review threads) so all bot output reads consistently.

| Severity | Inline-comment status line             | REVIEW.md tag | Meaning                                            |
| -------- | -------------------------------------- | ------------- | -------------------------------------------------- |
| Blocker  | `_⚠️ Potential issue_ \| _🔴 Blocker_` | `[blocker]`   | Must fix before merge, correctness or security.    |
| Major    | `_⚠️ Potential issue_ \| _🟠 Major_`   | `[major]`     | Should fix before merge, likely bug, missing test. |
| Minor    | `_💭 Suggestion_      \| _🟡 Minor_`   | `[minor]`     | Nice to fix, readability.                          |
| Nit      | `_💭 Suggestion_      \| _🔵 Nit_`     | `[nit]`       | Taste, optional. Not counted in `findings.total`.  |

The bracketed REVIEW.md tags drive the `countFindings` parser (see `src/workflows/handlers/review.ts`); the inline status-line emojis drive presentation. Both are required.

Findings are posted **one MCP call per finding**, never as a single bundled review. This guarantees each finding lands on the right line with its own resolvable thread.

## No-findings case

The agent must still post a top-level review body listing exactly what was checked (files read, classes of issue scanned, tests run) and why no issues were flagged. Silence is indistinguishable from "didn't actually look".

## Branch refresh

If the PR head is behind base **and** the branch is not on a fork, the agent rebases onto base, resolves conflicts honestly (reads the surrounding code, runs typecheck and tests, never blindly takes ours/theirs), and force-pushes with `--force-with-lease`. Fork PRs get a comment asking the contributor to rebase, then the review proceeds against the stale head with affected findings flagged.

## Outputs

| Field                                                       | Type                                                    | Notes                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| `state.head_sha`                                            | string                                                  | The SHA the review ran against (post-rebase if applicable). |
| `state.changed_files`, `state.additions`, `state.deletions` | numbers                                                 | Diff stats.                                                 |
| `state.branch_state`                                        | `{commits_behind_base, commits_ahead_of_base, is_fork}` | Pre-refresh snapshot.                                       |
| `state.findings`                                            | `{blocker, major, minor, nit, total}`                   | Counted from the severity tags; `total` excludes `nit`.     |
| `state.report`                                              | markdown                                                | Full `REVIEW.md`.                                           |
| `state.costUsd`, `state.turns`                              | metrics                                                 | _none_                                                      |

## Push policy

The only push acceptable from `review` is `git push --force-with-lease` after a clean rebase onto base (same diff, fresh head SHA). The handler never creates code commits, never calls `pulls.merge`, never posts an `APPROVE` or `REQUEST_CHANGES` review.

## Failure handling

Every failure path (`runPipeline` failure, the outer handler catch, or any sync/async throw before the pipeline runs) returns `status: "failed"` with two distinct outputs:

- **Public tracking comment**: a safe constant: `"review pipeline execution failed, see server logs for details."` Never carries the raw error string, since octokit error stacks include the request URL with the installation token (`https://x-access-token:GHS_xxx@…`).
- **Operator surfaces (DB + logs)**: `state.failedReason` on the `workflow_runs` row, `pino` log line on the daemon, and `ExecutionResult.errorMessage` returned to the caller. These carry the full SDK message so an operator can diagnose without tailing daemon stderr.

## Review learnings

`review` is one of two workflows (with `resolve`) that loads persisted review-policy directives from the `review_learnings` table and renders them into the prompt. Loaded directives whose `file_glob` matches at least one changed file are surfaced verbatim in a `<review_learnings_…>` block ahead of the diff, and their IDs flow back through `appliedReviewLearningIds` on the handler result so the orchestrator can bump `use_count` precisely. The tracking comment ends with a `🧠 Learnings used` collapsible footer when at least one directive applied. See `docs/use/review-learnings.md` for the full feature, gating (`REVIEW_LEARNINGS_ENABLED`, per-repo `.github-app.yaml` opt-out), and operator notes.
