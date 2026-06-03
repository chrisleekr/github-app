# Invoking the bot

The bot reacts to three kinds of input: mentions in a comment, labels applied to an issue or PR, and (for `bot:ship` only) natural-language asks that include the trigger phrase. All three converge on the same workflow registry, only the **surface** differs in logs.

## The three surfaces

| Surface             | Where you put it     | Example                                                                                                                        |
| ------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Mention + verb**  | Issue or PR comment  | `@chrisleekr-bot triage this` · `@chrisleekr-bot ship this please`                                                             |
| **Literal command** | PR comment           | `bot:ship` · `bot:ship --deadline 2h` · `bot:abort-ship`                                                                       |
| **Label**           | Apply to issue or PR | `bot:triage`, `bot:plan`, `bot:implement`, `bot:review`, `bot:resolve`, `bot:ship`, `bot:stop`, `bot:resume`, `bot:abort-ship` |

The trigger phrase that gates mentions is `@chrisleekr-bot` by default and can be overridden with `TRIGGER_PHRASE` (typically `@chrisleekr-bot-dev` for local development).

## How a comment reaches a workflow

```mermaid
flowchart TD
    Cmt["Comment with @chrisleekr-bot or bot:verb"]:::input
    Verify["Webhook verified<br/>HMAC-SHA256"]:::guard
    Idem["Idempotency check<br/>delivery id + tracking comment"]:::guard
    Allow["ALLOWED_OWNERS allowlist"]:::guard
    Router{{"Trigger router"}}:::fork
    Lit["Literal regex<br/>bot:verb"]:::route
    NL["Mention + NL classifier<br/>Bedrock single-turn"]:::route
    LabelEvt["issues.labeled or<br/>pull_request.labeled"]:::input
    LabelMatch["registry.getByLabel"]:::route
    Enqueue["enqueueJob<br/>Valkey queue:jobs"]:::store
    Daemon["Daemon claims offer"]:::work
    Pipe["src/core/pipeline.ts"]:::work
    Track["Tracking comment finalised"]:::done

    Cmt --> Verify --> Idem --> Allow --> Router
    Router --> Lit
    Router --> NL
    LabelEvt --> Allow
    Allow -. label path .-> LabelMatch
    Lit --> Enqueue
    NL --> Enqueue
    LabelMatch --> Enqueue
    Enqueue --> Daemon --> Pipe --> Track

    classDef input fill:#0b5cad,stroke:#083e74,color:#ffffff
    classDef guard fill:#164a3a,stroke:#0d2c24,color:#ffffff
    classDef fork fill:#6a2080,stroke:#451454,color:#ffffff
    classDef route fill:#8a5a00,stroke:#5c3d00,color:#ffffff
    classDef store fill:#5c3d00,stroke:#3d2900,color:#ffffff
    classDef work fill:#114a82,stroke:#0a2f56,color:#ffffff
    classDef done fill:#2a6f2a,stroke:#1a4d1a,color:#ffffff
```

## Idempotency

A duplicate webhook delivery never spawns a duplicate job (issue #202). Two layers:

1. **Best-effort claim**: the side-effecting event handlers call `claimDelivery(deliveryId)` (`src/webhook/idempotency.ts`), a Valkey `SET key 1 NX EX 259200` that returns `true` exactly once per `X-GitHub-Delivery` within GitHub's 3-day redelivery window; a redelivery gets `false` and returns early. Fail-open: a Valkey outage degrades to at-least-once rather than dropping webhooks.
2. **Durable backstop**: the `idx_workflow_runs_inflight` partial-unique index makes the dispatcher reject a second in-flight run for the same workflow+target even if the Valkey claim was skipped.

The legacy in-memory `Map` + tracking-comment marker scan was retired in issue #211.

## What you see while it runs

Comment-driven runs stack four reactions on your trigger comment so the lifecycle is visible at a glance:

| Stage                      | Reaction |
| -------------------------- | -------- |
| Trigger detected           | 👀       |
| Job dispatched to a daemon | 🚀       |
| Workflow succeeded         | 🎉       |
| Workflow failed            | 😕       |

Reactions are additive: the combined set is the audit trail. Label-driven runs skip reactions because there is no comment to react on.

The bot also writes a single **tracking comment** per run. For workflows that take minutes (triage, plan, implement, review, resolve, ship), the comment opens with a "Working…" body and is rewritten in place at major checkpoints and at the terminal state. You only need to watch one comment.

## What gets refused

| Refusal                  | Cause                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Silent skip              | Repository owner is not in `ALLOWED_OWNERS`. No comment is posted.                                                   |
| "Capacity reached" reply | More than `MAX_CONCURRENT_REQUESTS` agent runs are already in flight. Re-invoke later.                               |
| Clarification reply      | Mention-driven request whose intent classifier confidence fell below `INTENT_CONFIDENCE_THRESHOLD` (default `0.75`). |
| "Unsupported" reply      | Mention-driven request whose intent does not map to any registered workflow.                                         |
| `bot:ship` refusal       | Target branch is in `SHIP_FORBIDDEN_TARGET_BRANCHES`, or the PR head is closed / on a fork without push access.      |

See [`use/safety.md`](safety.md) for what the bot will and will not do once a job is accepted.

## Catalog

A complete table of `bot:*` commands lives at [`use/workflows/`](workflows/index.md). The headline shipping workflow is documented at [`use/workflows/ship.md`](workflows/ship.md).
