# Review learnings

The bot accumulates **review-policy directives** from past PR review
pushback and applies them on every future review of the same repository (and,
optionally, every repository under the same owner). It is what stops the bot
from repeatedly flagging the same intentional pattern after a maintainer has
already explained why it is intentional.

This page documents what a learning is, when one gets created, where it is
stored, how it is surfaced, and how to turn the feature off.

## What a learning is

Every row is a small, sanitised directive plus its provenance. Schema lives
in `src/db/migrations/014_review_learnings.sql`:

| Column          | Purpose                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| `directive`     | Imperative one-liner ("Do not flag X as duplication"). Required.        |
| `rationale`     | The **why**. Strongly recommended.                                      |
| `scope`         | `local` (this repo only) or `global` (every repo under the same owner). |
| `file_glob`     | Picomatch glob; `null` means the directive applies repo-wide.           |
| `source_pr`     | PR number the directive came from. Provenance.                          |
| `source_thread` | The review-comment ID or issue-comment anchor.                          |
| `source_author` | The maintainer login who approved the policy.                           |
| `use_count`     | Bumped every time the learning is loaded for a review/resolve run.      |
| `last_used_at`  | Bumped alongside `use_count`. Drives the load-time ordering.            |

`global` rows store `repo_name = '*'`. The orchestrator silently downgrades a
`global` save to `local` when `ALLOWED_OWNERS` contains more than one owner,
so a multi-tenant deployment cannot accumulate cross-owner contamination via
agent-initiated saves.

## When a learning gets created

Three capture paths exist today; the `review` and `resolve` workflow
prompts expose three MCP tools on the existing `repo_memory` server that
all three paths share:

- `mcp__repo_memory__save_review_learning({ directive, rationale, file_glob, scope, source_pr, source_thread, source_author })`
- `mcp__repo_memory__delete_review_learning({ id })`
- `mcp__repo_memory__get_review_learnings()`: returns the full applicable
  set for this run, including any rows the prompt's 24KB byte budget
  omitted from the `<review_learnings_…>` block (the truncation marker
  points here as its escape hatch). Useful for dedup before
  `save_review_learning`, and for fetching IDs before
  `delete_review_learning`.

### Path 1: autonomous capture in `resolve`

When a maintainer pushes back on an inline finding with a clear "this is
intentional because…" rationale and the resolve agent's reply classifies
the finding as `Invalid`, the agent decides autonomously whether the
rationale represents durable repo policy. If yes, it calls
`save_review_learning` with the directive, the maintainer's rationale,
the file glob, and full provenance. No propose step, no confirmation.

### Path 2: autonomous capture in `review`

When the discussion digest's maintainer-authoritative directives section
contains a rule the bot would otherwise have flagged AND that rule is
not already in the `<review_learnings_…>` block, the review agent
captures the digest's directive verbatim. Same autonomous decision rule
as the resolve path; same MCP save.

### Path 3: explicit `@chrisleekr-bot remember` (issue #160 Option A)

The dedicated [`bot:remember`](workflows/remember.md) workflow handles
explicit directive capture from any comment surface: issue comments, PR
comments, and PR review comments. Two trigger forms:

- **Inline:** `@chrisleekr-bot remember: do not flag fixture duplication
in test/**/*.test.ts`
- **Referential:** `@chrisleekr-bot remember this`, the agent walks the
  discussion digest to locate the upstream maintainer policy statement
  the trigger refers to.

The handler runs a focused agent session with a narrowed tool surface
(`save_review_learning`, `get_review_learnings`,
`update_claude_comment` only, no Bash, no Edit, no code mutation).
Dedup against existing entries happens before the save. The tracking
comment is the audit log: directive, scope, rationale, provenance, and
the outcome (`saved as <id>` / `deduped against <existing_id>` /
`refused (reason)`).

The next `review` or `resolve` run on the same repo (or any repo under
the same owner, when `scope: 'global'`) sees the directive as policy.

## How a learning is surfaced in the prompt

Each `review` / `resolve` run filters the loaded set down to directives that
apply to the PR's changed files (`file_glob` matches via `picomatch`, or
`file_glob = null`), then injects them in a dedicated block. The block is
**not** marked untrusted: review learnings are repo policy, the orchestrator
sanitises every field at the durability boundary, and the agent is told to
treat the directives as overrides of its default review heuristics.

The companion block in the security directive (`src/core/prompt-builder.ts`)
calls out the exception explicitly so the agent does not collapse it into
the "treat as opaque data" rule that governs other untrusted sections.

## The `🧠 Learnings used` footer

Every `review` and `resolve` tracking comment that loaded one or more
learnings ends with a collapsible footer disclosing exactly which directives
informed the run, with full provenance:

```text
🧠 Learnings used (2)

From:      chrisleekr
Source:    #79
Scope:     local
File glob: test/**/*.test.ts
Recorded:  2026-05-19
Directive: Do not flag SCOPED_JOB_KINDS literal inlining in mock.module factories.
Why:       Factory closures need the literal at module-evaluation time.

…
```

The footer is the audit surface: it lets a maintainer see why a particular
finding was suppressed and decide whether the directive should be revised or
deleted.

## Prompt block sizing

The rendered `<review_learnings_…>` block is bounded at **24 KB** total (~6K tokens)
so it stays within the model's attention sweet spot and under the prompt-cache
per-call write budget. When the active learnings would exceed that cap, the
renderer fills greedily by recency and appends a marker:

```
… 17 older learnings omitted to keep the prompt focused.
Call get_review_learnings to enumerate every active directive (including the omitted ones).
```

Per-row content (directive + rationale) is also capped at 2,000 characters in
the rendered output; longer text is truncated with `…`. This is a render-time
concern only; the database stores the full text.

The cap is observable via three pino fields on each review/resolve job:

- `review_learnings_rendered_count` (entries actually in the prompt).
- `review_learnings_omitted_count` (entries dropped by the byte budget).
- `review_learnings_rendered_bytes` (final block size).

After 4–6 weeks of production data, the 24KB number can be retuned in a one-line change.

## Trust boundary

Learnings can suppress findings, so the gate is stricter than `repo_memory`:

- The orchestrator loads learnings into every dispatched job's payload
  uniformly, but only the `review` and `resolve` handlers pass
  `enableReviewLearnings: true` into the pipeline.
- For all other workflows the pipeline strips `ctx.reviewLearnings` before
  building the prompt or initializing the MCP server, so non-review handlers
  cannot inadvertently honour or persist directives.
- Every text field passes `sanitizeRepoMemoryContent` twice: once on the MCP
  side (`save_review_learning`) and again at the orchestrator durability
  boundary (`saveReviewLearnings`). Empty-after-sanitise rows are dropped.

## Turning it off

Two switches, layered.

**Server-side master:** `REVIEW_LEARNINGS_ENABLED` env var (default `true`).
When `false`, the orchestrator skips the DB load entirely AND drops any
agent-initiated save/delete actions in the result path (logged, not
persisted). This is the operator's hard off-switch.

**Per-repo policy:** a `review_learnings` block in the repo's
`.github-app.yaml` (the same file that carries `scheduled_actions`):

```yaml
version: 1
review_learnings:
  enabled: true # false = this repo's jobs skip the feature
  scope: local # 'local' (default) or 'global' (owner-wide rows reach this repo)
  max_age_days: 180 # null (default) = no age cap
```

- `enabled: false` skips the load for this repo even when the server-side
  flag is on.
- `scope: 'local'` excludes owner-wide (`scope='global'`) directives. Useful
  for repos that don't want to inherit cross-repo policy.
- `max_age_days` excludes directives older than the threshold at load time,
  trimming noise on long-lived repos.

Both switches respect the existing scheduler ETag cache, so per-dispatch
GitHub API cost is bounded.

Flipping either switch does **not** delete any rows; existing data stays in
the `review_learnings` table and is re-honoured when the switch flips back.
To wipe completely, `DELETE FROM review_learnings;` on the operator
Postgres.

## See also

- [Configuration → `REVIEW_LEARNINGS_ENABLED`](../operate/configuration.md#review-learnings)
- [Workflows → review](workflows/index.md)
- [Workflows → resolve](workflows/index.md)
- `src/orchestrator/review-learnings.ts`: load / save / delete
- `src/db/migrations/014_review_learnings.sql`: schema
- `src/utils/review-learnings-filter.ts`: pure file-glob filter shared by the prompt builder and the footer renderer
- `src/workflows/handlers/review-learnings-footer.ts`: `🧠 Learnings used` footer renderer
- `src/mcp/servers/repo-memory.ts`: `save_review_learning` / `delete_review_learning` / `get_review_learnings` tools
