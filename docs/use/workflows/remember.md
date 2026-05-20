# `bot:remember`

Captures a maintainer-authored review-policy directive and persists it to
`review_learnings` so future PR reviews respect it.

| Field           | Value                                                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Label           | `bot:remember`                                                                                                                                                                   |
| Mention         | `@chrisleekr-bot remember: do not flag fixture duplication in test/**/*.test.ts` · `@chrisleekr-bot remember this` · `@chrisleekr-bot remember the rule above`                   |
| Accepted target | Issue OR pull request                                                                                                                                                            |
| Requires prior  | _none_                                                                                                                                                                           |
| Artifact        | `$BOT_ARTIFACT_DIR/REMEMBER.md` (sibling temp dir, never committed)                                                                                                              |
| Side effects    | One row inserted into the `review_learnings` table via the `save_review_learning` MCP tool. No code edits, no commits, no review-thread changes. Tracking comment carries audit. |
| Source          | `src/workflows/handlers/remember.ts`                                                                                                                                             |

## When to use it

`bot:remember` is the **explicit** complement to the agent's autonomous
capture path (see [`resolve.md`](resolve.md) for the post-rebuttal save).
Reach for it when you want to ensure a review rule lands in the bot's
memory without depending on a `resolve` flow to fire, e.g. you noticed a
recurring false-positive in a different repo, or you want to seed the
policy table proactively before the bot has had a chance to flag the
pattern.

It is intentionally invocable on **any** comment surface: issue
comments, PR comments, and PR review (inline) comments all reach the
same handler. The trigger phrase + the word `remember` is what routes
the intent classifier here.

## Two trigger forms

**Inline**, the directive sits in the trigger comment:

```
@chrisleekr-bot remember: do not flag fixture duplication in test/**/*.test.ts
```

**Referential**, the directive lives upstream in the thread:

```
> [earlier maintainer comment]
> We keep these per-file rather than centralising; the closure needs
> the literal at module-evaluation time.

@chrisleekr-bot remember this
```

The handler always feeds the agent the full discussion digest, so the
referential form has the context it needs to locate and extract the
policy statement.

## Refusal cases

The agent does NOT save anything (and says so in the tracking comment)
when:

- The trigger comment is referential but the upstream thread carries no
  policy-shaped maintainer statement to pin to.
- The proposed directive paraphrases an existing entry in
  `review_learnings` (the agent dedupes via `get_review_learnings`
  before saving).
- The directive collapses to empty after sanitization (HTML / BIDI /
  zero-width strip).

In each refusal case the tracking comment explains which case fired
so the maintainer can rephrase if needed.

## Trust boundary

Trigger classification + the directive extraction both depend on the
`ALLOWED_OWNERS` author-trust set. A non-owner saying
`@chrisleekr-bot remember [...]` reaches the intent classifier, but the
discussion digest splits owner-authoritative directives from
untrusted-context comments before the agent reads them. The handler
does not gate the trigger by author (an owner can ask the bot to capture
a non-owner's stated rule), but the agent's prompt requires a
maintainer-authoritative source for the directive itself.

## Scope and provenance

- `scope` defaults to `'local'` (this repo only). `'global'` requires
  explicit maintainer language ("across all our repos") AND a
  single-tenant deploy; the orchestrator silently downgrades `'global'`
  to `'local'` when `ALLOWED_OWNERS` has more than one owner.
- `file_glob` is captured when the directive cites a path pattern.
  Pathological globs (catastrophic-backtracking shapes) are rejected at
  the durability boundary; the directive saves with `file_glob = null`
  rather than failing.
- `source_pr`, `source_author`, `source_thread` carry the provenance the
  `🧠 Learnings used` footer renders on every future review.

## What it does NOT do

- It does not modify code, commit anything, or push.
- It does not resolve review threads.
- It does not auto-merge.
- It does not run on every comment, only when the intent classifier
  picks `remember` for the trigger comment.
