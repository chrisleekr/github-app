# `bot:ship`: PR shepherding to merge-ready

The shepherding lifecycle takes an open pull request from "needs work" to "ready for human merge". The bot drives the probe → fix → reply → wait loop until the merge-readiness probe says the PR is clean. **The bot never merges**; the final action is always a human's.

The lifecycle lives in `src/workflows/ship/` (entry point `runShipFromCommand` in `session-runner.ts`). Each session is a row in `ship_intents`, with iteration history in `ship_iterations` and wake state in `ship_continuations`.

## How to invoke

| Surface     | Example                                              | Notes                                                                                         |
| ----------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Literal** | `bot:ship` · `bot:ship --deadline 2h`                | PR comment. Deterministic regex; never costs an LLM call.                                     |
| **Natural** | `@chrisleekr-bot ship this please`                   | Requires the trigger-phrase mention. Without the mention the comment is skipped at zero cost. |
| **Label**   | Apply `bot:ship` (or `bot:ship/deadline=2h`) to a PR | The bot self-removes the label after acting. Re-applying re-triggers.                         |

The four lifecycle verbs are `ship`, `stop`, `resume`, `abort-ship`. All four are available on all three surfaces.

`--deadline` accepts `Nh` / `Nm` / `Ns`. The session deadline is clamped to `MAX_WALL_CLOCK_PER_SHIP_RUN` (default 4h).

## How to monitor

Each session writes a single canonical tracking comment marked with `<!-- ship-intent:{intent_id} -->`. The body shows current phase, last action, next queued action, iteration count, USD spent, deadline, and (on terminal) the blocker category. One comment is enough to know exactly where the bot is.

## How to pause, resume, abort

| Verb             | Effect                                                                                                             | Recoverable?                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `bot:stop`       | Sets `ship_intents.status = 'paused'`. Deadline keeps counting down.                                               | Yes, `bot:resume`.                                                         |
| `bot:resume`     | Verifies no foreign push since the pause, clears the cancel flag, re-enqueues the continuation.                    | _none_                                                                     |
| `bot:abort-ship` | Sets the Valkey cancel flag, waits ≤2 s for a cooperative checkpoint, then force-transitions to `aborted_by_user`. | No. After abort, the bot performs zero further mutating actions on the PR. |

## What runs each iteration

```mermaid
flowchart LR
    Iter["Iteration N starts"]:::start
    Probe["Probe<br/>GraphQL PR snapshot"]:::work
    Verdict{{"Verdict"}}:::fork
    Behind["Refresh branch<br/>git rebase --force-with-lease"]:::fix
    Failing["Resolve failing checks"]:::fix
    Pending["Wait for pending checks<br/>tickle on check_run.completed"]:::wait
    Threads["Reply to open review threads<br/>resolve thread on success"]:::fix
    ChangesReq["Wait for human action<br/>changes_requested"]:::wait
    Ready["Terminal:ready<br/>tracking comment + status flip"]:::done
    Took["Terminal:human_took_over<br/>foreign push detected"]:::halt

    Iter --> Probe --> Verdict
    Verdict -->|behind base| Behind --> Iter
    Verdict -->|failing checks| Failing --> Iter
    Verdict -->|pending checks| Pending --> Iter
    Verdict -->|open threads| Threads --> Iter
    Verdict -->|changes requested| ChangesReq --> Iter
    Verdict -->|ready| Ready
    Probe -. detects manual push .-> Took

    classDef start fill:#0b5cad,stroke:#083e74,color:#ffffff
    classDef work fill:#164a3a,stroke:#0d2c24,color:#ffffff
    classDef fork fill:#6a2080,stroke:#451454,color:#ffffff
    classDef fix fill:#8a5a00,stroke:#5c3d00,color:#ffffff
    classDef wait fill:#5c3d00,stroke:#3d2900,color:#ffffff
    classDef done fill:#2a6f2a,stroke:#1a4d1a,color:#ffffff
    classDef halt fill:#852020,stroke:#5a1414,color:#ffffff
```

The verdict ladder is ordered: `human_took_over` > `behind_base` > `failing_checks` > `pending_checks` > `mergeable_pending` > `changes_requested` > `open_threads` > `ready`. The first matching rung wins, fixing failing checks always precedes replying to threads, and a manual push always wins outright.

`mergeable=null` is treated specially: the probe backs off through `MERGEABLE_NULL_BACKOFF_MS_LIST` (default `500,1500,4500`); exhausting the list yields a `mergeable_pending` verdict and the session yields rather than spinning.

## Status values

```mermaid
stateDiagram-v2
    [*] --> active : runShipFromCommand
    active --> paused : bot:stop
    paused --> active : bot:resume
    active --> ready_awaiting_human_merge : verdict=ready
    active --> human_took_over : foreign push, iteration cap, or flake cap
    active --> deadline_exceeded : MAX_WALL_CLOCK_PER_SHIP_RUN
    active --> merged_externally : pull_request.closed merged
    active --> pr_closed : pull_request.closed not merged
    active --> aborted_by_user : bot:abort-ship
    paused --> aborted_by_user : bot:abort-ship
    paused --> deadline_exceeded : deadline elapsed while paused
    ready_awaiting_human_merge --> [*]
    human_took_over --> [*]
    deadline_exceeded --> [*]
    merged_externally --> [*]
    pr_closed --> [*]
    aborted_by_user --> [*]
```

## What the bot will and won't do

| Will                                                                | Won't                                                           |
| ------------------------------------------------------------------- | --------------------------------------------------------------- |
| Force-push with `--force-with-lease` after a clean rebase onto base | Force-push without rebasing                                     |
| Push fix commits in response to failing CI                          | Merge the PR (`gh pr merge` is statically guarded)              |
| Reply to review threads with the `resolve-review-thread` MCP        | Post `APPROVE` or `REQUEST_CHANGES` reviews                     |
| Mark a draft PR ready-for-review on terminal `ready`                | Cancel a foreign push, manual push wins; the session terminates |
| Self-remove the `bot:ship` label after acting                       | Take any mutating action after `bot:abort-ship`                 |

If the target branch matches `SHIP_FORBIDDEN_TARGET_BRANCHES` (e.g. `main,production`), the trigger is refused before any session is created.

## Iteration-0 reroute

Some merge-readiness probe verdicts cannot be recovered by ship at iteration 0, no amount of further work would change them. When the first probe returns one of these, the workflow skips intent creation entirely (no `ship_intents` row, no session-tracker tracking comment) and reroutes the trigger:

| Verdict reason    | Why ship can't proceed                        | What happens instead                                                                                                                                         |
| ----------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `human_took_over` | head SHA was authored by a human, not the bot | Comment triggers (NL or literal) hand off to the conversational `chat-thread` executor for a tools-driven reply. Label triggers post a single prose refusal. |

Other non-readiness reasons (`failing_checks`, `behind_base`, `pending_checks`, etc.) are recoverable by the iteration loop and stay on the normal path. The reroute set is defined as `SHIP_REROUTE_REASONS` in `src/workflows/ship/session-runner.ts`.

The `chat-thread` executor's GitHub-state tool calls (CI rollup, check output, branch protection, PR diff/files, comments) go through `dispatchGithubStateTool`, whose fetchers wrap every octokit call in `retryWithBackoff`. A transient GitHub API blip (5xx, 429, or a secondary rate limit) is retried up to three times with exponential backoff and a deliveryId-correlated retry-warning log, instead of surfacing to the model as a tool error it would have to recover from semantically (issue #199).

## Re-triggering

Re-applying the `bot:ship` label or re-commenting `bot:ship` on the same PR while a session is **active** is a no-op. Re-applying after the session is **terminal** starts a fresh session: the prior `ship_intents` row is preserved for audit.

## Tuning knobs

Configured at the process level via [`operate/configuration.md`](../../operate/configuration.md#ship). The two you most often touch:

| Variable                      | Default | Effect                                                                                                   |
| ----------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `MAX_WALL_CLOCK_PER_SHIP_RUN` | `4h`    | Hard ceiling on a session's wall-clock budget. Per-invocation `--deadline` is clamped to this value.     |
| `MAX_SHIP_ITERATIONS`         | `50`    | Iteration cap. Firing transitions to `human_took_over` with `terminal_blocker_category='iteration-cap'`. |

## When a human should step in

The tracking comment puts the answer at the top: any terminal status other than `ready_awaiting_human_merge` and `merged_externally` means human attention is needed. `terminal_blocker_category` names which class:

- `flake-cap`: the same failure signature was retried `FIX_ATTEMPTS_PER_SIGNATURE_CAP` times (default 3); investigate the flake.
- `iteration-cap`: the session ran `MAX_SHIP_ITERATIONS` rounds without resolving; re-scope the work.
- `manual-push-detected`: someone pushed to the PR; the bot stepped back. Re-trigger `bot:ship` if you want the bot to take it from here.
- `merge-conflict-needs-human`: the rebase produced conflicts the bot would not resolve confidently.

For Day-2 SQL and the other terminal categories, see [`operate/runbooks/stuck-ship-intent.md`](../../operate/runbooks/stuck-ship-intent.md).

## Output secret-redaction

Every comment the ship workflow posts to GitHub, tracking-comment create / update, scoped-command marker upserts (`bot:investigate`, `bot:triage`, `bot:summarize`, `bot:open-pr`, `bot:rebase`), lifecycle replies (`bot:stop` / `bot:resume` / `bot:abort-ship`), and the orchestrator's tracking-mirror cascade, flows through `safePostToGitHub` (`src/utils/github-output-guard.ts`). The wrapper runs the regex secret-redactor (and, for `source: "agent"` bodies, the Bedrock LLM scanner) before the body reaches GitHub, so a successful prompt-injection that convinces the agent to echo a token still cannot leak it through the comment surface. See `test/security/SCENARIOS.md` for the threat model.

## Auto-defer on Anthropic usage-limit

A child workflow run that fails because the Claude Agent SDK reported `"You've hit your limit · resets <time> UTC"` (subscription-token quota or per-tier rate limit) is treated as a **transient** failure rather than a permanent one. The orchestrator's `maybeEarlyWakeShipIntent` cascade:

1. Reads `state.failedReason` from the failed `workflow_runs` row.
2. `detectTransientQuotaError` matches the usage-limit signature and parses the `resets …` clock (handles `6pm (UTC)`, `18:30 UTC`, etc.; falls back to a `+1h` deferral when the clock is unparseable).
3. `ZADD ship:tickle <retryAtMs> <intent_id>` so the periodic tickle scanner re-fires the iteration once the quota window resets, instead of leaving the intent stalled until an operator re-arms it.

Non-quota failures still take the original `ship.tickle.skip_failed_child` path: the iteration cap remains the safety net for permanently broken intents.
