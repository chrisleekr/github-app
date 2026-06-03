# Workflows

Seven workflows are registered today (`src/workflows/registry.ts`). Each has a single label, a single comment-mention verb, and produces one Markdown artifact that becomes the body of the tracking comment.

| Workflow                    | Label           | Surfaces                                       | What it does                                                                             | Detail           |
| --------------------------- | --------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------- |
| [`triage`](triage.md)       | `bot:triage`    | Issue label or comment                         | Decides whether an issue is actionable, with structural or runtime evidence              | `TRIAGE.md`      |
| [`plan`](plan.md)           | `bot:plan`      | Issue label or comment, after `triage`         | Writes an implementation plan                                                            | `PLAN.md`        |
| [`implement`](implement.md) | `bot:implement` | Issue label or comment, after `plan`           | Opens a PR with code, tests, and a filled-out PR template                                | `IMPLEMENT.md`   |
| [`review`](review.md)       | `bot:review`    | PR label or comment                            | Reads the diff in full, posts findings as inline comments                                | `REVIEW.md`      |
| [`resolve`](resolve.md)     | `bot:resolve`   | PR label or comment                            | Fixes failing CI, replies to review threads, pushes new commits                          | `RESOLVE.md`     |
| [`ship`](ship.md)           | `bot:ship`      | PR comment, label, or natural-language mention | Shepherds an open PR to merge-ready: probe → fix → reply → wait, until clean             | tracking comment |
| [`remember`](remember.md)   | `bot:remember`  | Issue or PR (any comment)                      | Captures a maintainer review-policy directive into `review_learnings` for future reviews | tracking comment |

## How they relate

`triage`, `plan`, and `implement` are the issue-side cascade for new work. `review` and `resolve` are the PR-side pair: `review` proactively reads a diff and posts findings; `resolve` reactively answers existing feedback and fixes failing CI. The split is deliberate, conflating "look at this PR" with "fix this PR" was the design mistake the verb-rename corrected.

`ship` is the PR shepherding lifecycle (its own state machine, its own database tables). It does not run the cascade above; it drives an open PR through the merge-readiness probe ladder until a human can hit merge. See [`ship.md`](ship.md).

## Common rules across all workflows

- **The bot never merges.** No workflow calls `pulls.merge` or posts an `APPROVE` / `REQUEST_CHANGES` review. Static guard at `scripts/check-no-destructive-actions.ts`.
- **Always-rebase semantics.** PR-side workflows (`review`, `resolve`, `ship`) rebase the branch onto base before reading the diff if it is behind, then `git push --force-with-lease`. Fork PRs cannot be force-pushed by the bot: it asks the contributor to rebase and proceeds against the stale head.
- **One Markdown artifact, one tracking comment.** Each run captures `<NAME>.md` from the working tree before cleanup and embeds it verbatim in the tracking comment.
- **Tracking comments are idempotent.** Every tracking comment carries a hidden `<!-- workflow-run:{id} -->` marker. `setState()` in `src/workflows/tracking-mirror.ts` scans for the marker before posting, adopts any pre-existing comment found (e.g. after an octokit retry that silently duplicated a `POST`, or a pod restart between create and CAS reservation), and reconciles duplicates after create, keeping a single canonical comment per run regardless of transient API failures.
- **Cost is visible.** Every workflow records `cost_usd`, `turns`, and `wall_clock_ms` on the run row. The shepherding lifecycle exposes cumulative spend in the tracking comment header.

## Maintainer comments steer the workflow

The five structured workflows (`triage`, `plan`, `implement`, `review`, `resolve`) are comment-aware. Before each run, `src/workflows/discussion-digest.ts` distills the issue/PR comment thread into a guidance digest that the workflow prompt consumes in place of the raw thread:

- **Later owner comments override the body.** Comments by `ALLOWED_OWNERS` authors become authoritative directives; where one conflicts with the issue/PR body, the directive wins. So you can run `bot:plan`, comment a correction, run `bot:plan` again, and the second run honours the correction (the issue body alone no longer pins the result).
- **Non-owner comments are context only.** They appear in the digest labelled as untrusted discussion the agent must account for but never obey.
- **The bot's own prior output is context.** A reply to the bot's earlier plan/review is interpretable because that prior output is summarised into the digest.
- **PR review-thread comments count.** On a PR, inline review comments and review summary bodies feed the digest too, with their `path:line` anchors preserved.
- **No comment-count limit.** A large thread is summarised via map-reduce; no comment is dropped. The step is fail-open: any LLM or fetch error falls back to body-only / raw-comment context.

Re-running a workflow also **removes that workflow's previous tracking comment** before posting the new one, so the thread does not pile up stale bot output.

## Trigger-comment intent classifier

A comment that mentions the trigger phrase is routed through `src/workflows/intent-classifier.ts`: a single-turn Haiku call that returns `{ workflow, confidence, rationale }`.

- `confidence < INTENT_CONFIDENCE_THRESHOLD` (default `0.75`) → the dispatcher posts a clarification reply and stops.
- `workflow` not in registry → refusal reply.
- `workflow` in registry → same dispatch as the label path.

The classifier prompt distinguishes `review` (proactive, find bugs, post inline findings) from `resolve` (reactive, fix CI, answer feedback). Tune the threshold per environment with `INTENT_CONFIDENCE_THRESHOLD`.

## Label-path dispatch

Both the label trigger and the in-registry classifier verdict run the same seven-step sequence in `src/workflows/dispatcher.ts`: registry lookup → context check → prior-output requirement → label mutex → idempotency insert → job enqueue → return. Prior-output is checked before the mutex, so refusing a workflow that lacks its prerequisite (e.g. `bot:implement` before any `bot:plan`) does not strip unrelated `bot:*` labels. The idempotency insert is the durable in-flight guard: a redelivered or concurrent label event for the same workflow and target is rejected at the database, not just at the best-effort Valkey claim.

## Conversational `chat-thread` (sub-threshold fallback)

When the intent classifier verdict is below `INTENT_CONFIDENCE_THRESHOLD` AND the conversational backend (`DATABASE_URL`) is configured, the dispatcher routes the comment to `src/workflows/ship/scoped/chat-thread.ts` instead of refusing: a freeform exchange entry point for review threads, PR replies, and issue comments. Output modes the executor can return are validated by Zod (`answer`, `decline`, `execute-workflow`, `propose-workflow`, `propose-action`, `approve-pending`, `decline-pending`, `replace-proposal`).

### Tool surface (PR conversations only)

On PR events, `chat-thread` and the orchestrator-side `triage` engine drive Anthropic's tool-use loop via `src/ai/llm-client.ts runWithTools`. Both share the `github-state` tool set defined in `src/github/state-fetchers.ts`:

| Tool                        | Purpose                                                    |
| --------------------------- | ---------------------------------------------------------- |
| `get_pr_state_check_rollup` | Head-commit CI rollup + per-check rows + `is_required`     |
| `get_check_run_output`      | Single check run summary + truncated text + `html_url`     |
| `get_workflow_run`          | Workflow run conclusion, `logs_url`, `html_url`            |
| `get_branch_protection`     | Required checks list, reviewers, `protected: false` on 404 |
| `get_pr_diff`               | Unified diff (capped ~50 KB)                               |
| `get_pr_files`              | File list with status + per-file additions/deletions       |
| `list_pr_comments`          | Paginated issue comments on the PR (30/page)               |

The same surface is exposed to Agent SDK callers via `src/mcp/servers/github-state.ts` (registered when `enableGithubState` is `true` in the `runPipeline` overrides).

**Caps and operator switches:**

- `runWithTools` enforces a per-turn iteration cap (default 8 for `chat-thread`, **2** for `triage`) and a per-turn fan-out cap (`DEFAULT_MAX_TOOL_USES_PER_TURN` = 4). Excess `tool_use` blocks get `is_error: true` `tool_result` feedback so the model adjusts on the next turn rather than triggering silent truncation.
- `CHAT_THREAD_TOOLS_ENABLED` (default `true`): when `false`, `chat-thread` stays single-turn and answers only from the cached snapshot.
- `TRIAGE_TOOLS_ENABLED` (default `true`): when `false`, `triage` classifies from text alone even on PR events. Hot-path latency escape hatch.

The deterministic merge-readiness path (`src/workflows/ship/probe.ts`, `src/workflows/ship/verdict.ts`) is intentionally NOT tool-driven, its GraphQL probe (`PROBE_QUERY`, now centralised in `src/github/queries.ts`) is correctness-invariant for the merge gate.
