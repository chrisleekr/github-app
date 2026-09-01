# Per-repo configuration

A repo controls the bot with a single YAML file at its **default-branch root**:
`.github-app.yaml`.

It turns individual workflows on and off, tunes the agent per workflow, filters
which events the bot responds to, and shapes the reviewer.

## The one rule that matters

**Only the copy on the default branch is ever read.**

The bot fetches the file with `octokit.rest.repos.getContent({ owner, repo, path })`
and deliberately passes **no `ref`**, which GitHub resolves to the repository's
default branch (`src/repo-config/fetcher.ts:126#fetchRepoConfig`). A regression
test asserts the call carries no `ref`.

Consequences worth internalising:

- Editing this file inside a pull request changes **nothing** for that pull
  request. The bot still uses the default-branch copy for that PR's runs.
- The change takes effect the moment the PR merges, for every subsequent run.
- Reviewing a config change is therefore reviewing a change to the bot's
  behaviour on the whole repo, not just on that branch.

That property is the security boundary. Without it, a fork PR could grant
itself extra tools or disable the reviewer by editing one file.

## What is wired today

The whole file below is **validated** today: a typo anywhere fails the file and
falls back to defaults. Nearly every block now also changes behaviour.

!!! note "`workflows.ship` takes no agent knobs"

    `ship` accepts `enabled` only, and the schema rejects `model`,
    `max_turns`, `timeout`, or `extra_allowed_tools` under it. Its handler is
    a composite orchestrator that enqueues the child workflows and never
    invokes an agent, so those knobs could only ever be a no-op. Tune the
    agent with `defaults:` or the per-child entries instead: ship's children
    run under their own workflow names (`triage`, `plan`, `implement`,
    `review`, `resolve`) and resolve `workflows.<child>.*` over `defaults:`.

| Block                                             | Status                                                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`                                         | **Parsed and validated. Not yet enforced.** Enforcement is Gate 1, wired with the isolated workflow runner.                    |
| `workflows.<name>.enabled`                        | **Parsed and validated. Not yet enforced.** Same Gate 1 path.                                                                  |
| `triggers.*`                                      | **Parsed and validated. Not yet enforced.** Same Gate 1 path.                                                                  |
| `review_learnings`, `scheduled_actions`, `config` | **Applied.** Pre-existing blocks, unchanged by this change.                                                                    |
| `defaults` + `workflows.<name>` agent knobs       | **Resolved and clamped. Not yet on the wire.** The `policy` key exists on the job payload; its producer lands with the runner. |
| `workflows.review.path_filters` / `.instructions` | **Consumer ready. Not yet reachable**, since no producer sets `policy` yet.                                                    |
| `workflows.review.auto`                           | **Not yet applied.** Dispatch-time knob; lands with the auto-review guard.                                                     |

!!! warning "Status of this page"

    Only `review_learnings`, `scheduled_actions` and `config` take effect today.
    Everything else on this page is parsed, schema-validated, resolved and
    clamped, but has no production call site yet: `checkRepoGate`,
    `loadRepoPolicy` and `runPrConfigCheck` are reachable only from tests. The
    dispatch chokepoints and the `pull_request` config-check handler that call
    them depend on database columns from a later migration, so they ship in the
    isolated-workflow-runner change rather than here. Authoring a config file
    now is safe and its schema is stable, but do not expect a repo-level
    `enabled: false` to stop the bot until that lands.

### How the agent knobs behave

Resolution is owned by the controller: it merges the workflow block over
`defaults`, clamps the result against the server ceilings, and ships it on the
job payload as a `policy` object. `AgentPolicySchema` in
`src/shared/ws-messages.ts` defines that wire shape, and
`src/core/agent-policy.ts` is the consumer that applies it to an agent run.

The producing side is not in place yet, so no `policy` key is sent today and
the table below describes intended behaviour rather than current behaviour. A
repo with no config file produces no `policy` key at all and runs exactly as it
did before this file existed.

| Knob                  | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`               | Replaces the server's `CLAUDE_MODEL` for this run. Unlike `max_turns` and `timeout` it is **not** clamped against a server ceiling, and there is deliberately no operator-side model allowlist: the principal is already inside `ALLOWED_OWNERS`, and the pre-existing scheduled-action `model:` field is unclamped the same way. See the ceilings note below.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `max_turns`           | Caps agent turns. Clamped to `AGENT_MAX_TURNS` when the server sets one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `timeout`             | Bounds the **agent invocation**, not the whole run. The timer is armed immediately before the agent is invoked, so the tracking comment, token resolution, GitHub data fetch, and repo clone all happen outside it. `AGENT_TIMEOUT_MS` stays an independent outer bound over the whole thing, so whichever fires first wins, and a daemon cancel still lands on top of both.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `extra_allowed_tools` | Appended to the tool list the handler resolved, then deduped. Strictly additive: it can never remove a tool a handler requires. It **auto-approves**, it is not a sandbox: the agent already runs with permission prompts bypassed, so this list widens what the agent will reach for without asking, and omitting a tool does not block it. Set under `defaults` it reaches every agent-running workflow (`review`, `resolve`, `implement`, `remember`, `plan`, `triage`), including read-only ones like `remember`; scope it under `workflows.<name>` to limit the blast radius. Destructive shell stays blocked no matter what is listed here, by the runtime forbidden-Bash hook (force-push, `git reset --hard`, `gh pr merge`, merge mutations), which repo config cannot disable. |
| `path_filters`        | **Exclusions.** A changed file matching any glob is dropped from the prompt the reviewer sees, and from the review-learnings applicability check. Inline review comments are left intact, so `resolve` can still answer a thread about an excluded file. **Advisory, not a boundary**: the exclusion is prompt prose only. The agent still has the full clone plus `Read` and `Bash`, so it can open an excluded file on its own initiative. Do not use this to hide secrets or sensitive paths from the model.                                                                                                                                                                                                                                                                          |
| `instructions`        | Injected as owner-trusted review policy that overrides the agent's default review heuristics. Sent in the **per-request** half of the prompt only, never in the cacheable prefix, so one repo's policy can never leak into another repo's cached prompt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Because only the default branch's copy of this file is ever read, a pull
request cannot introduce or alter any of these knobs for its own review.

An invalid file does not stop the run: the bot executes on built-in defaults and
prepends a warning to the tracking comment so the ignored file is visible rather
than silent.

## Trust tier

Everything in this file is **owner-trusted config**, the same tier as a
`.github/workflows/` file: anyone with push access to the default branch can
change it, so treat push access as equivalent to bot-configuration access.

The server's `ALLOWED_OWNERS` allowlist gates every repo before any of this
runs, and nothing in the file can widen what the server already permits. See
[Authorization](#authorization) below.

## Complete example

```yaml
# Per-repo configuration for chrisleekr-bot.
#
# ONLY the copy on this repository's DEFAULT BRANCH is ever applied.

version: 1

# Repo-wide master switch. `false` stops all work: no labels, no mentions, no
# scheduled actions. A deliberate label or mention still gets a one-line
# "disabled here" reply. Default: true.
enabled: true

config:
  timezone: "Australia/Melbourne"

# Covers every agent run in this repo unless a workflow below overrides it.
# Every value is clamped by the server ceilings (AGENT_TIMEOUT_MS, and
# AGENT_MAX_TURNS falling back to DEFAULT_MAXTURNS); the config can lower a
# ceiling, never raise one.
defaults:
  # Omit to inherit the server default (CLAUDE_MODEL, else claude-opus-5).
  model: "claude-opus-5"
  max_turns: 120
  timeout: 45m
  # Additive only. Appended to the tools the workflow already needs, never a
  # replacement, so a typo here cannot strip a handler's required tool. The
  # runtime forbidden-Bash hook still denies force-push / reset --hard /
  # gh pr merge regardless of what is listed.
  extra_allowed_tools:
    - "Bash(bun run typecheck:*)"
    - "Bash(bun run lint:*)"

# Per-workflow toggles and overrides. Keys are the workflow registry names.
# An omitted workflow inherits `enabled: true` plus the `defaults:` block.
workflows:
  triage:
    enabled: true
  plan:
    enabled: true
  implement:
    enabled: true
    max_turns: 200
    timeout: 60m
  review:
    enabled: true
    model: "claude-opus-5"
    # Hides changed files matching any of these globs from the reviewer. Every entry is an exclusion; no leading "!"
    # needed. picomatch, dot: true. Keep this to genuinely generated or
    # vendored output. Docs are NOT filtered: prose drifting from the code is
    # what the reviewer should catch.
    path_filters:
      - "**/*.lock"
      - "bun.lock"
      - "dist/**"
      - "**/__snapshots__/**"
    # Run a review automatically when someone in the server's AUTO_REVIEW_USERS
    # allowlist pushes commits to an open PR. Both keys are required; this one
    # alone does nothing. Defaults to false, see "Auto review" below.
    auto: true
    # Owner-trusted review policy, appended to the review prompt. Same trust tier as review learnings: NOT wrapped in
    # <untrusted_*> tags.
    instructions: |
      Flag any new `process.env` read that bypasses src/config.ts.
      Require a mirrored test/**/*.test.ts for every new file under src/.
      Do not comment on formatting; prettier owns that.
  resolve:
    enabled: true
  ship:
    enabled: false
  remember:
    enabled: true

# Pre-dispatch filters, evaluated before any run row, tracking comment, or
# queue job is created. These only ever narrow what the bot responds to.
triggers:
  # Logins whose issues, PRs, and comments never trigger the bot.
  ignore_authors:
    - "renovate[bot]"
    - "dependabot[bot]"
  # Skip PR-context workflows while the PR is a draft.
  ignore_draft_prs: true
  # Case-insensitive substring match on the issue or PR title.
  ignore_title_keywords:
    - "WIP"
    - "[skip bot]"
  # PR base-branch allowlist. Empty means every base branch.
  base_branches:
    - "main"
    - "beta"
  # Per-actor gate, layered ON TOP of the server's ALLOWED_OWNERS env
  # allowlist. Intersection only: this can narrow who may trigger the bot
  # here, never widen it. Empty (the default) preserves current behaviour.
  allowed_users: []

# See docs/use/review-learnings.md. Server master gate: REVIEW_LEARNINGS_ENABLED.
review_learnings:
  enabled: true
  scope: "local"
  max_age_days: 180

# See docs/use/scheduled-actions.md.
scheduled_actions:
  - name: research
    cron: "0 19 * * *"
    enabled: false
    model: "opus"
    max_turns: 200
    timeout: 60m
    auto_merge: false
    allowed_tools:
      - WebSearch
      - WebFetch
      - Read
      - Glob
      - Grep
      - "Bash(gh issue create:*)"
    prompt:
      ref: ".github/skills/research.md"
```

Every block is optional and every field has a default, so an existing file that
only declares `version: 1` and `scheduled_actions:` stays valid.

## Field reference

### Top level

| Key                 | Type   | Default | Effect                                                   |
| ------------------- | ------ | ------- | -------------------------------------------------------- |
| `version`           | `1`    | none    | Required. The only accepted value.                       |
| `enabled`           | bool   | `true`  | Repo-wide master switch. See the note below the table.   |
| `config.timezone`   | IANA   | `UTC`   | Timezone for scheduled-action cron evaluation.           |
| `defaults`          | object | `{}`    | Agent knobs applied to every workflow unless overridden. |
| `workflows`         | object | `{}`    | Per-workflow toggles and overrides.                      |
| `triggers`          | object | `{}`    | Pre-dispatch filters.                                    |
| `review_learnings`  | object | on      | See [Review learnings](review-learnings.md).             |
| `scheduled_actions` | array  | `[]`    | See [Scheduled actions](scheduled-actions.md).           |

!!! warning "Not enforced yet"

    Gate 1 has no production call site on this change, so `enabled: false` does
    not stop label or mention triggers today. It already silences the scheduler,
    which reads the document directly. The rest of this section describes the
    behaviour once Gate 1 is wired.

`enabled: false` will stop the bot doing any work in the repo: no workflow run,
no queue job, no scheduled action. It is not a vow of silence. A deliberate `bot:*`
label or `@chrisleekr-bot` mention still gets one short reply saying the bot is
disabled here, so a teammate who tries is told why instead of being ignored.
Passive triggers stay silent. If you need the bot to make no writes at all,
uninstall the App from the repo.

Two verbs are exempt: literal `bot:stop` and `bot:abort-ship` still run on a
disabled repo. They only end work that is already in flight, and refusing them
would let `enabled: false` strand the very run the owner set it to stop.
`bot:resume` is not exempt, it starts work. The carve-out is keyed on the
literal verb, so a stop phrased as a plain-English mention is refused like
anything else.

The exemption covers `enabled`, the per-workflow toggles, and the three passive
`triggers.*` filters, not who may drive the bot. `ignore_authors` and
`allowed_users` still apply to `bot:stop` and `bot:abort-ship`, so a login the
repo excluded cannot kill someone else's in-flight run.

### Agent knobs (`defaults` and every `workflows.<name>` except `ship`)

| Key                   | Type       | Default | Effect                                                                                                                    |
| --------------------- | ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| `model`               | string     | server  | Model ID for this repo's runs. Falls back to `CLAUDE_MODEL`, else `claude-opus-5`. Max 128 chars. Not clamped, see below. |
| `max_turns`           | int 1..500 | server  | Agent turn cap. Clamped down by `AGENT_MAX_TURNS ?? DEFAULT_MAXTURNS`, never up.                                          |
| `timeout`             | duration   | server  | Wall-clock cap, e.g. `45m`, `30s`, `2h`. Clamped down by `AGENT_TIMEOUT_MS`.                                              |
| `extra_allowed_tools` | string[]   | `[]`    | **Additive.** Appended to the workflow's own tool list; never a replacement. Max 50 entries.                              |

`workflows.review` accepts three more:

| Key            | Type   | Default | Effect                                                                                                                                                                             |
| -------------- | ------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path_filters` | glob[] | `[]`    | Changed files matching any glob are hidden from the reviewer's prompt. Advisory only, the agent can still `Read` an excluded file from the clone. Max 100 entries, 200 chars each. |
| `instructions` | string | none    | Owner-trusted review policy appended to the review prompt (max 10,000 chars).                                                                                                      |
| `auto`         | bool   | `false` | Let an `AUTO_REVIEW_USERS` login's push trigger `review`. Both keys are required; neither alone enables anything. See [Auto review](#auto-review) for why this one defaults off.   |

`workflows.ship` accepts `enabled` and nothing else. Ship's handler enqueues
child workflows and never runs an agent itself, so the knobs never had an
effect.

!!! note "`workflows.ship` agent knobs are rejected"

    `workflows.ship.model` / `.max_turns` / `.timeout` /
    `.extra_allowed_tools` used to parse and do nothing. They are now
    rejected, and validation is whole-document, so one rejected key fails the
    entire file and the repo falls back to the built-in defaults until it is
    removed. Put the knob on `defaults:` or on the specific child (`triage`,
    `plan`, `implement`, `review`, `resolve`) instead, which is what ship's
    steps resolve against.

Workflow keys are enumerated explicitly, not open-ended, so a misspelled name
(`revue:`) fails the whole file rather than being silently ignored. A test
asserts the key set equals the workflow registry's names, so adding an eighth
workflow fails CI until the schema is extended.

### `triggers`

| Key                     | Type     | Default | Effect                                                                   |
| ----------------------- | -------- | ------- | ------------------------------------------------------------------------ |
| `ignore_authors`        | login[]  | `[]`    | These logins never trigger the bot. Silent.                              |
| `ignore_draft_prs`      | bool     | `false` | Skip PR-context workflows while the PR is a draft. Silent.               |
| `ignore_title_keywords` | string[] | `[]`    | Case-insensitive substring match on the issue/PR title. Silent.          |
| `base_branches`         | string[] | `[]`    | PR base-branch allowlist. Empty means all. Silent. See the caveat below. |
| `allowed_users`         | login[]  | `[]`    | Per-actor gate. Empty means today's behaviour. Refusal is **explained**. |

Every list here is capped: `ignore_authors` 50 entries, `ignore_title_keywords`
20 entries of 64 chars, `base_branches` 20 entries of 244 chars,
`allowed_users` 100 entries. Exceeding a cap fails the whole document, which
means the repo silently reverts to permissive defaults, see
[When the file is invalid](#when-the-file-is-invalid).

"Silent" versus "explained" is deliberate. A filter the owner configured to keep
the bot quiet must stay quiet, or the filter defeats its own purpose. A
deliberate label or mention that is refused earns a one-line reply saying why.
The explained reasons are all static strings; the silent ones are the only rules
that interpolate user-controlled text, so nothing attacker-controlled is ever
posted back.

"Silent" means no comment, not no trace. A mention still gets the 👀
acknowledgement reaction: the webhook handler adds it as soon as it sees the
trigger phrase, before the gate runs. So a filtered mention looks like 👀
followed by nothing, which is the intended shape, the reaction says the event
arrived, not that a run started.

A `bot:*` label filtered by one of the silent rules stays on the issue or PR.
The gate runs before the label mutex, so nothing removes it, and no later event
re-fires it: leaving draft sends `ready_for_review`, which the bot does not
dispatch on, and editing the title sends `edited`. To run after the condition
clears, remove the label and re-apply it.

!!! warning "`base_branches` does not cover comment triggers"

    The rule needs the PR's base ref, and the gate reads trigger facts straight
    off the webhook payload rather than spending an API call. A `bot:*` label
    and an inline review comment both carry the base ref, so the rule applies
    there. A plain issue/PR comment does not: GitHub's `issue_comment` payload
    exposes only URL fields under `issue.pull_request`, no `base`. On that
    surface the rule is skipped, so a mention can still start a run on a PR
    whose base branch you excluded. Use `workflows.<name>.enabled` or
    `triggers.allowed_users` if you need a filter that holds on every surface.

### Auto review

`workflows.review.auto` runs the reviewer automatically when someone pushes
commits to an open pull request, with no label and no mention.

| Field                   | Type      | Default | Effect                                                                   |
| ----------------------- | --------- | ------- | ------------------------------------------------------------------------ |
| `workflows.review.auto` | `boolean` | `false` | Allow pushes to trigger `review`, subject to the server allowlist below. |

**It takes two keys.** This one, and the server's `AUTO_REVIEW_USERS` env
allowlist naming which logins may trigger it. Neither alone does anything. The
env half exists because auto-review is the one setting in this file that
_widens_ what the bot does, and everything under `triggers:` is narrowing-only by
contract; the repo half exists because `AUTO_REVIEW_USERS` is server-wide, so
without it, setting the env var would switch auto-review on for every repository
at once.

!!! note "This is the one toggle that defaults to `false`"

    Every other switch in this file defaults to on, because a missing or broken
    config falls back to "everything enabled". Auto-review cannot follow that
    rule: the fallback also applies when the file is merely *unreachable*, so a
    default of `true` would let a GitHub outage start spending tokens on every
    push in every repo. Defaulting off makes the failure mode "no auto-review".
    `scheduled_actions[].auto_merge` defaults off for the same reason.

Four further narrowings apply, all silent:

- The **pusher** is matched, not the commit author. The commit author comes from
  the commit's author email, which anyone can set with `git config user.email`.
- **The bot's own pushes are skipped**, so a `resolve` run that pushes fixes does
  not trigger a review of its own work.
- **Content-free pushes are skipped.** A rebase that leaves the PR's own diff
  unchanged buys no review.
- **A review already running wins.** A push landing mid-review is dropped rather
  than queued, and nothing is posted about it.

Gate 1 still applies on top, so `enabled: false`, `workflows.review.enabled:
false`, and every `triggers.*` filter keep their veto. Because nobody asked for
the run, a refusal is logged but never commented.

!!! tip "Pair it with `ignore_draft_prs`"

    The reviewer does not treat drafts specially, and `triggers.ignore_draft_prs`
    defaults to `false`, so without it every work-in-progress push gets a full
    review. Set `ignore_draft_prs: true` alongside `auto: true` unless you want
    drafts reviewed.

## Precedence and clamping

```
server env ceiling  ->  defaults:  ->  workflows.<name>:
```

- `model`: the workflow entry wins over `defaults`, which wins over
  `CLAUDE_MODEL`, which falls back to `claude-opus-5`.
- `max_turns`: `min(resolved value, AGENT_MAX_TURNS ?? DEFAULT_MAXTURNS)`. One
  ceiling, picked the same way the runtime picks it: `AGENT_MAX_TURNS` overrides
  `DEFAULT_MAXTURNS` when both are set, so clamping against both would enforce a
  number the runtime has already discarded. If neither is set there is no cap and
  the config value applies as written.
- `timeout`: `min(resolved value, AGENT_TIMEOUT_MS)`.
- `extra_allowed_tools`: the **union** of `defaults` and the workflow entry,
  deduped.

The two numeric ceilings are one-directional. On `max_turns` and `timeout` a
repo owner can spend less of the operator's budget than the server allows,
never more.

`model` is **not** clamped, because models carry no ordering to take a `min()`
of. Leaving it unclamped with no operator-side allowlist is a deliberate
decision, not an oversight: the principal editing this file already holds push
access on a repo inside `ALLOWED_OWNERS`, and the pre-existing scheduled-action
`model:` field has always been unclamped on the same reasoning. A repo can name
any model string and it replaces `CLAUDE_MODEL` verbatim. That is consistent
with the trust tier above,
anyone with push access to the default branch already controls what the agent
runs, but on a multi-tenant deployment it means one repo can raise the
operator's per-run cost. Operators who need a hard cap should keep
`ALLOWED_OWNERS` single-tenant.

## Authorization

`ALLOWED_OWNERS` (server env) and `triggers.allowed_users` (repo YAML) answer
different questions, and the env var is not applied uniformly across surfaces.
The actual behaviour today:

| Surface                                | What `ALLOWED_OWNERS` is matched against | Effect                                                     |
| -------------------------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| `bot:*` label on an issue or PR        | the **labeler** (`sender.login`)         | Only allowlisted people can trigger by label.              |
| `@chrisleekr-bot` mention in a comment | the **repo owner**                       | Anyone who can comment on an allowlisted repo can trigger. |
| `bot:ship` eligibility check           | the **triggering user**                  | Only allowlisted people can ship.                          |
| Scheduled actions                      | the **repo owner**                       | Gates which repos the scheduler serves.                    |

So on a repo that passes the allowlist, **anyone who can comment can trigger
`triage`, `plan`, `implement`, `review`, `resolve`, and `remember` via a
mention.** `triggers.allowed_users` is the first per-actor gate for that
surface.

It is strictly an intersection:

```
ALLOWED_OWNERS  ->  ignore_authors  ->  allowed_users  ->  dispatch
```

`ignore_authors` is evaluated first on purpose: a bot login is normally listed
there and absent from `allowed_users`, so the other order would answer every
Renovate event with a public refusal comment.

It can only narrow. A repo the server rejects is dropped in the webhook handler
before the gate ever runs, so no YAML value can readmit it, and the gate never
treats `allowed_users` as a reason to _allow_ something another rule blocked.
`test/repo-config/gate.test.ts` asserts that property.

Left empty (the default), behaviour is exactly as it is today.

## When the file is invalid

The bot **fails open**. A missing, unreadable, or invalid file yields the
built-in defaults, so a YAML typo never silently disables the bot.

A **missing** file is not an error: having no config is the normal case, and the
bot caches that fact briefly to avoid a lookup on every dispatch.

An invalid file is logged with the failing paths (`repo-config: validation
failed`), and the resolved policy carries a warning string for the tracking
comment to surface. Rendering that warning to the user is not wired yet.

### Fail-open cuts both ways

Failing open means a broken file loses its **deny-side** rules too. If
`enabled: false` or a non-empty `triggers.allowed_users` is sitting in a file
that a later typo invalidates, the whole document is discarded and the bot goes
back to responding to everyone. That is the deliberate tradeoff: a config error
must not take the bot down, and the alternative (fail closed) turns any typo
into a silent outage that looks identical to a broken deployment. Treat the
`repo-config: validation failed` log line as actionable, and prefer removing the
App's installation over relying on `enabled: false` when you want a hard stop.

## Checking a file before pushing

Three tools, in the order you meet them: your editor, a local CLI, and a
pull-request comment. None of them changes what the bot applies, which is still
only the default branch's copy.

### 1. Editor completion via the JSON Schema

`schema/github-app.schema.json` is generated from the same zod schema the
runtime uses. Point your editor at it with a modeline on the first line of your
`.github-app.yaml`:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/chrisleekr/github-app/main/schema/github-app.schema.json
version: 1
```

The [YAML Language Server](https://github.com/redhat-developer/yaml-language-server)
(bundled with the VS Code YAML extension, and available in Neovim, JetBrains and
Helix) then gives key completion, hover docs, and inline errors.

!!! warning "The JSON Schema is structural only"

    `z.toJSONSchema` cannot express zod's `.refine` / `.superRefine` checks, so
    the generated schema covers key names, types, enums and numeric bounds but
    **not** the cross-field rules the runtime still enforces:

    - prompt-ref path traversal (`prompt.ref: ../../etc/passwd`)
    - IANA timezone validity (`timezone: Mars/Olympus`)
    - glob safety in `workflows.review.path_filters`
    - duplicate `scheduled_actions[].name`

    A document your editor calls clean can still be rejected at runtime. Use the
    local validator below for the full check.

The generated file is regenerated with `bun run gen-config-schema` and gated in
CI by `bun run check:config-schema`, which fails the build if the committed copy
drifts from `src/repo-config/schema.ts` by a single byte.

### 2. The local validator

Runs the real zod pipeline, so it covers the `.refine` rules the JSON Schema
cannot express:

```console
$ bun run validate-repo-config .github-app.yaml
.github-app.yaml: valid
```

`bun run validate-repo-config` is a package.json alias for
`bun run scripts/validate-repo-config.ts`; either form works.

Exit code 0 means valid. On a YAML syntax error or a schema violation it exits
non-zero and prints the failing paths to stderr:

```console
$ bun run scripts/validate-repo-config.ts .github-app.yaml
.github-app.yaml: 1 validation issue(s)
  - workflows: Unrecognized key: "revue"
```

### 3. The pull-request validation comment

Open a pull request that touches `.github-app.yaml` and the bot posts a single
sticky comment with the verdict, updated in place on every push rather than
appended:

- **valid**: the head-ref copy parses and matches the schema;
- **not valid**: the failing paths, capped at ten with a count of the remainder;
- **too large to validate**: files over 64 KB are never decoded, and none of the
  file's contents are echoed back.

!!! warning "Not wired yet"

    `runPrConfigCheck` has no production caller on this change, so no verdict
    comment is posted on a pull request today. The handler that invokes it
    ships with the isolated workflow runner. This section describes the
    behaviour once that lands.

Every verdict restates that only the default-branch copy is applied, so the
change takes effect on merge. Reading the branch copy here is strictly
read-only: it never becomes the policy the bot enforces, and it never enters the
config cache the dispatch path reads from.

Two limits worth knowing:

- A pull request that does **not** touch the config file gets no comment at all.
  Silence therefore still is not a pass for anything other than "this PR did not
  change the config".
- If a later push removes the config change from the pull request, the earlier
  verdict comment stays as-is rather than being retracted.
- A repo whose default-branch config sets `enabled: false` gets no verdict
  comment either: the master switch silences this surface too. The passive
  `triggers.*` filters do **not** apply here, so a draft pull request, or one
  whose title matches `ignore_title_keywords`, still gets its comment.

### After the merge

If a file was rejected at runtime, the server logs `repo-config: validation
failed` with the failing paths and the run proceeds on built-in defaults, so a
wrong file looks like a bot that ignored your config rather than one that broke.
