# Runbook: triage

Triage is a binary `heavy` classifier. It runs on every event (subject to the kill-switch and circuit breaker) and answers one question: should this job prefer an ephemeral daemon? `heavy=true` is one of the two triggers that can spawn an ephemeral daemon Pod (the other is queue overflow).

## What a call returns

```json
{ "heavy": true, "confidence": 0.92, "rationale": "..." }
```

There is no `complexity` field and no `maxTurns` mapping, `maxTurns` always comes from `config.defaultMaxTurns` regardless of the triage outcome.

## Confidence threshold

At or above `TRIAGE_CONFIDENCE_THRESHOLD`, `heavy` is accepted as-is. Below it, the router treats the signal as `heavy=false`: the job routes to `persistent-daemon` and the log line carries `triage_fallback_reason=sub-threshold`. Day-one default is `1.0` so only perfectly confident results route an ephemeral spawn.

## Circuit breaker

Triage wraps the LLM call in a circuit breaker (`src/orchestrator/triage.ts`). Consecutive failures trip the breaker; while open, the function short-circuits to `heavy=false` and emits `triage_fallback_reason=circuit-open`. The breaker re-closes after a cooldown.

## Six fallback reasons

All emitted as `triage_fallback_reason` in pino logs.

| Reason          | Trigger                                                             |
| --------------- | ------------------------------------------------------------------- |
| `disabled`      | `TRIAGE_ENABLED=false`, short-circuits without calling the LLM.     |
| `circuit-open`  | Breaker tripped after consecutive failures.                         |
| `timeout`       | The call exceeded `TRIAGE_TIMEOUT_MS`.                              |
| `llm-error`     | The provider returned an error.                                     |
| `parse-error`   | The JSON response failed schema validation.                         |
| `sub-threshold` | Parsed successfully but `confidence < TRIAGE_CONFIDENCE_THRESHOLD`. |

## Cost implications

Every event attempts triage. When `TRIAGE_ENABLED=false` or the breaker is open the call short-circuits **before** hitting Haiku, so those paths are free. When the call proceeds, one Haiku invocation is the dominant marginal cost on a busy install.

Mitigations:

- `TRIAGE_CONFIDENCE_THRESHOLD` defaults to `1.0` (strictest). Lower toward `0.8`–`0.9` to accept more heavy verdicts; raising above `1.0` is unsupported and gates out every response. The compute cost is unchanged either way: the knob only controls whether the result routes an ephemeral spawn.
- Flip `TRIAGE_ENABLED=false` during a provider incident to suppress spend without redeploying.
- Keep `TRIAGE_MAX_TOKENS` low (the response schema is ~40 tokens).

## Tuning knobs

| Variable                      | Default      | When to change                                          |
| ----------------------------- | ------------ | ------------------------------------------------------- |
| `TRIAGE_ENABLED`              | `true`       | Incident kill-switch.                                   |
| `TRIAGE_MODEL`                | `sonnet-5-5` | Try `haiku-5-5` for lower latency.                      |
| `TRIAGE_CONFIDENCE_THRESHOLD` | `1.0`        | Relax to `0.8`–`0.9` once the classifier is calibrated. |
| `TRIAGE_MAX_TOKENS`           | `256`        | Only raise if rationale is being truncated.             |
| `TRIAGE_TIMEOUT_MS`           | `5000`       | Raise if provider latency is consistently > 5 s.        |

Full schema: [`../configuration.md`](../configuration.md#triage).

## Querying

| Question                  | Approach                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Triage accuracy this week | Sample log lines with `heavy:true` or `heavy:false` and grade against the actual job duration / cost.                                  |
| Spend on triage calls     | `triageSpend(days)` helper in `src/db/queries/dispatch-stats.ts`.                                                                      |
| Fallback rate             | Log query: `triage_fallback_reason:*` grouped by reason.                                                                               |
| Sub-threshold tail        | Histogram of `confidence` for non-fallback events; if the 90th percentile is below `TRIAGE_CONFIDENCE_THRESHOLD`, lower the threshold. |
