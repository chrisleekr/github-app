# `bot:triage`

Decides whether an issue is actionable. For bug-class issues, the agent must establish either a reproduction, a structural defect (with `file:line` citations), or an invariant test before declaring the bug valid.

| Field           | Value                               |
| --------------- | ----------------------------------- |
| Label           | `bot:triage`                        |
| Mention         | `@chrisleekr-bot triage this`       |
| Accepted target | Issue                               |
| Requires prior  | _none_                              |
| Artifact        | `TRIAGE.md` + `TRIAGE_VERDICT.json` |
| Side effects    | None                                |
| Source          | `src/workflows/handlers/triage.ts`  |

## Inputs

- Issue title and body.
- A fresh shallow clone of the repository (`Read`, `Grep`, `Glob`, `Bash`, `Write` available to the agent).

## Method

The agent classifies the issue (bug, feature, refactor, docs, unclear). For bugs it walks the harness ladder, unit → mocked unit → integration with `bun run dev:deps` Postgres+Valkey → multi-process docker-compose, and names the highest rung tried. Three evidence paths are accepted:

1. **Code inspection**, `file:line` citations for a structural defect (module-scoped state, missing constraint, race window across an `await`, unguarded shared resource).
2. **Runtime test**: a command that exercises the claim (`bun test`, `bun run typecheck`, a CLI invocation, a `/tmp` scratch script).
3. **Invariant test**, pins down the property the fix will rely on (e.g. "N concurrent callers → exactly 1 succeeds"). Preferred over synthetic race repros because it survives the fix as a regression guard.

"Race condition we can't trigger" alone is not a valid escape hatch.

## Prompt cache layout

When `PROMPT_CACHE_LAYOUT=cacheable`, the triage prompt is split: the static role intro plus Method and Rules go into `systemPrompt.append` (byte-stable across calls, so the prompt cache hits), and only the per-issue header (repo, issue number, title, body) stays in the user message. Under the default `legacy` layout the prompt is a single user-role string. Both layouts carry identical wording. See [configuration.md](../../operate/configuration.md#prompt-cache-layout).

## Outputs

| Field                   | Type                               | Notes                                                                                                                                                                                           |
| ----------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state.valid`           | boolean                            | Verdict.                                                                                                                                                                                        |
| `state.confidence`      | float `[0, 1]`                     | Agent's self-assessment.                                                                                                                                                                        |
| `state.summary`         | string                             | Verdict rationale; uncapped. Embedded into the failed-cascade reason when `valid = false`.                                                                                                      |
| `state.recommendedNext` | `'plan'` \| `'stop'`               | _none_                                                                                                                                                                                          |
| `state.evidence`        | `Array<{file?, line?, note?}>`     | Each entry must have at least one of `file` or `note`. Prefer `file`+`line` citations; `note`-only is for cross-cutting evidence (e.g. a negative grep result that has no single-file pointer). |
| `state.reproduction`    | `{attempted, reproduced, details}` | `attempted=false` for non-bug class. `reproduced=null` is allowed only after the harness ladder is walked AND an invariant test is ruled out.                                                   |
| `state.report`          | markdown                           | The full `TRIAGE.md`. Embedded verbatim in the tracking comment.                                                                                                                                |

## Stop conditions

- Agent writes both `TRIAGE.md` and `TRIAGE_VERDICT.json`; the JSON validates against the Zod schema.
- `valid = false` → handler returns `failed` and any composite cascade halts here.
- Missing markdown, malformed JSON, or an SDK error → `failed` with a specific reason.

There is no _default_ turn cap on triage: the agent runs until the verdict is honestly defensible. Three sources can bind one, and all three are honoured: the repo's `workflows.triage.max_turns` in `.github-app.yaml`, the operator's `AGENT_MAX_TURNS`, and `DEFAULT_MAXTURNS`. With all three unset, which is the stock deployment, the run is uncapped as before.
