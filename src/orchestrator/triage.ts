/**
 * Triage engine: single-turn binary classification of ambiguous events.
 *
 * After the dispatch-to-daemon collapse, triage no longer picks an
 * execution target (there's only one: the daemon fleet). Instead, it
 * answers a single question: *is this request heavy enough that the
 * orchestrator should spawn an ephemeral daemon Pod to absorb it,
 * rather than letting it wait in the persistent-daemon queue?*
 *
 * Contract:
 *   - Wraps one LLM call in a circuit breaker + hard timeout.
 *   - Validates the response against the `{heavy, confidence, rationale}`
 *     zod schema. Any deviation → fallback.
 *   - Gates on `config.triageConfidenceThreshold`. Sub-threshold → fallback
 *     (which the scaler treats as "not heavy").
 *   - Persists a `triage_results` row on clean parse (advisory: survives
 *     sub-threshold gating so ops can observe what the model thought).
 *   - NEVER throws. All failure paths return `{ outcome: "fallback", reason }`
 *     so the router can deterministically carry on.
 *
 * `maxTurns` is deliberately NOT part of the triage output: the LLM
 * mis-sizes complexity often enough that we prefer a static
 * `config.defaultMaxTurns` for every job.
 */

import type { Octokit } from "octokit";
import { z } from "zod";

import {
  estimateHaikuCostUsd,
  type LLMClient,
  resolveModelId,
  runWithTools,
} from "../ai/llm-client";
import { parseStructuredResponse, withStructuredRules } from "../ai/structured-output";
import { config } from "../config";
import { getDb } from "../db";
import { dispatchGithubStateTool, GITHUB_STATE_TOOLS } from "../github/state-fetchers";
import { logger } from "../logger";
import { CircuitBreaker } from "../utils/circuit-breaker";
import { sanitizeContent } from "../utils/sanitize";

/**
 * Zod schema: binary heavy classifier.
 *
 * `.strict()` so legacy pre-collapse fields (`mode`, `complexity`) on a
 * response from a stale provider/proxy are a hard parse error instead of
 * being silently stripped. That forces the `parse-error` fallback branch
 * in `triageRequest`, which is safer than silently absorbing a shape we
 * no longer model.
 */
export const TriageResponseSchema = z
  .object({
    heavy: z.boolean(),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).max(500),
  })
  .strict();
export type TriageResponse = z.infer<typeof TriageResponseSchema>;

export interface TriageResult extends TriageResponse {
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly provider: "anthropic" | "bedrock";
  readonly model: string;
  readonly deliveryId: string;
}

export type TriageFallbackReason =
  | "disabled"
  | "circuit-open"
  | "timeout"
  | "llm-error"
  | "parse-error"
  | "sub-threshold";

export type TriageOutcome =
  | { readonly outcome: "result"; readonly result: TriageResult }
  | {
      readonly outcome: "fallback";
      readonly reason: TriageFallbackReason;
      /**
       * Populated when triage parsed successfully but was gated by the
       * confidence threshold (`reason === "sub-threshold"`). Callers surface
       * this so telemetry still carries the model's opinion even when the
       * scaler ignores it.
       */
      readonly result?: TriageResult;
    };

/**
 * Minimal context the triage prompt needs. Decoupled from `BotContext`
 * so unit tests can drive the engine without constructing Octokit stubs.
 */
export interface TriageInput {
  readonly deliveryId: string;
  readonly owner: string;
  readonly repo: string;
  readonly eventName: string;
  readonly isPR: boolean;
  readonly labels: readonly string[];
  readonly triggerBody: string;
  /**
   * Optional Octokit + PR number for tool-driven classification (issue #117).
   * When BOTH are supplied AND the event is on a PR, triage gains the
   * `github-state` read-only tools so the model can sample CI rollup or
   * file-list signals before classifying. Iteration cap is conservative
   * (2 round trips) to keep the hot-path latency bounded.
   */
  readonly octokit?: Octokit;
  readonly prNumber?: number;
}

/**
 * Hard cap on tool round-trips inside a single triage call. Triage runs
 * on every webhook event with a strict timeout, so we trade some
 * accuracy headroom for predictable latency. Higher than 2 is unlikely
 * to improve triage's binary heavy/not-heavy decision.
 */
const TRIAGE_MAX_TOOL_ITERATIONS = 2;

const SYSTEM_PROMPT = `You are a workload-intensity classifier for a GitHub-integration bot. Every request runs on the same daemon fleet; your only job is to decide whether a request is "heavy" enough that the orchestrator should spawn an extra ephemeral worker Pod to absorb it, instead of queuing it behind existing work.

A request is HEAVY when it is likely to:
- touch many files or require sweeping refactors,
- run long test suites / builds,
- require container tooling (docker build, docker compose, kind, etc.),
- investigate complex multi-service behavior or reproduce non-trivial bugs,
- otherwise consume substantially more CPU / memory / wall-clock than a typical code comment or small patch.

A request is NOT HEAVY when it is a quick question, a tiny patch, a doc tweak, a review comment, or any narrow change a competent agent can finish in a handful of turns.

Respond with ONLY a JSON object, no prose, matching:
{"heavy":true|false,"confidence":0.0-1.0,"rationale":"one sentence, max 500 chars"}

Confidence is your probability that \`heavy\` is correct.

Tools (PR events only, absent on issues):
  - get_pr_state_check_rollup({ pr_number }): CI rollup. Useful when "ship" or
    "make it ready to merge" arrives on a PR with red CI; that's heavy.
  - get_pr_diff({ pr_number }): capped diff. Use ONLY when text alone is
    ambiguous AND a single fetch will resolve heavy vs light (large refactor
    diff = heavy; one-line typo fix = not heavy).

  Triage runs on the hot path with a strict timeout. Call AT MOST ONE tool per
  classification. If text alone is enough, do not call any tool.`;

/**
 * A single shared circuit breaker for the process. Per research.md R7 the
 * breaker is in-process shared-memory; module-level singleton is the
 * idiomatic way to share it across triage calls.
 */
const breaker = new CircuitBreaker({
  maxConsecutiveFailures: 5,
  latencyTripMs: 10_000,
  cooldownMs: 60_000,
  onStateChange: (from, to, reason) => {
    logger.warn({ from, to, reason }, "triage circuit breaker transition");
  },
});

/** Test-only: reset the shared breaker between test files. */
export function _resetTriageBreakerForTests(): void {
  breaker.reset();
}

/** Build the user-role prompt from the event context. */
export function buildTriagePrompt(input: TriageInput): string {
  // Sanitize BEFORE clipping so HTML comments / invisible chars / leaked
  // GitHub tokens cannot ride into the LLM prompt. Mirrors the treatment
  // in src/core/prompt-builder.ts for the main agent prompt.
  const sanitizedLabels = input.labels.map((l) => sanitizeContent(l));
  const labelsLine = sanitizedLabels.length > 0 ? sanitizedLabels.join(", ") : "(none)";
  const sanitizedBody = sanitizeContent(input.triggerBody);
  const body = sanitizedBody.length > 2_000 ? sanitizedBody.slice(0, 2_000) : sanitizedBody;
  // Include PR number when this is a PR event so the model can pass it to
  // tool calls (issue #117: the github-state tools require pr_number).
  const lines = [
    `Repository: ${input.owner}/${input.repo}`,
    `Event: ${input.eventName} on ${input.isPR ? "pull request" : "issue"}`,
  ];
  if (input.isPR && input.prNumber !== undefined) {
    lines.push(`PR number: ${String(input.prNumber)}`);
  }
  lines.push(`Labels: ${labelsLine}`, `Trigger body:`, body);
  return lines.join("\n");
}

/**
 * Extract a JSON object from the model's reply. The system prompt asks for
 * pure JSON, but models occasionally wrap in code fences or add a leading
 * sentence. Rather than rejecting those, try to locate the first top-level
 * JSON object and parse it. Any parse failure returns null and the caller
 * reports `parse-error`.
 */
export function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  return trimmed.slice(firstBrace, lastBrace + 1);
}

/**
 * Persist a `triage_results` row. Called only on a clean parse outcome.
 * Non-fatal: logs and continues on DB write failure so a transient
 * Postgres outage doesn't abort an already-successful triage call.
 */
export async function persistTriageResult(result: TriageResult): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await db`
      INSERT INTO triage_results (
        delivery_id, mode, heavy, confidence, rationale,
        cost_usd, latency_ms, provider, model
      ) VALUES (
        ${result.deliveryId}, 'daemon', ${result.heavy}, ${result.confidence},
        ${result.rationale}, ${result.costUsd}, ${result.latencyMs},
        ${result.provider}, ${result.model}
      )
      ON CONFLICT (delivery_id) DO NOTHING
    `;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), deliveryId: result.deliveryId },
      "Failed to persist triage_results row (non-fatal)",
    );
  }
}

/**
 * Race a promise against a timeout. Resolves with the original promise or
 * rejects with a typed error whose message starts with "triage-timeout".
 */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T>([
      p,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`triage-timeout after ${String(ms)}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

/**
 * Primary triage entry point. Called by the router for every dispatch.
 *
 * @param input Event context: decoupled from BotContext for testability.
 * @param client Injected LLM client. Production callers pass the module-level
 *               singleton from `src/ai/llm-client.ts`; tests pass a stub.
 * @returns `{ outcome: "result", result }` on success above the threshold,
 *          `{ outcome: "fallback", reason }` otherwise. Never throws.
 */
export async function triageRequest(input: TriageInput, client: LLMClient): Promise<TriageOutcome> {
  if (!config.triageEnabled) {
    return { outcome: "fallback", reason: "disabled" };
  }

  const modelId = resolveModelId(config.triageModel, client.provider);
  const prompt = buildTriagePrompt(input);
  const timeoutMs = config.triageTimeoutMs;

  const useTools =
    config.triageToolsEnabled &&
    input.isPR &&
    input.octokit !== undefined &&
    input.prNumber !== undefined;
  const breakerResult = await breaker.execute(async () => {
    if (useTools && input.octokit !== undefined && input.prNumber !== undefined) {
      const octokit = input.octokit;
      // Delivery-correlated logger so the fetchers' retryWithBackoff warnings
      // carry the deliveryId binding (#199).
      const toolLog = logger.child({ deliveryId: input.deliveryId });
      const result = await withTimeout(
        runWithTools(client, {
          model: modelId,
          system: withStructuredRules(SYSTEM_PROMPT),
          messages: [{ role: "user", content: prompt }],
          maxTokens: config.triageMaxTokens,
          tools: GITHUB_STATE_TOOLS,
          maxIterations: TRIAGE_MAX_TOOL_ITERATIONS,
          onToolCall: (call) =>
            dispatchGithubStateTool(
              { octokit, owner: input.owner, repo: input.repo, log: toolLog },
              call,
            ),
        }),
        timeoutMs,
      );
      return {
        text: result.text,
        model: result.model,
        usage: result.usage,
      };
    }
    return withTimeout(
      client.create({
        model: modelId,
        system: withStructuredRules(SYSTEM_PROMPT),
        messages: [{ role: "user", content: prompt }],
        maxTokens: config.triageMaxTokens,
      }),
      timeoutMs,
    );
  });

  if (breakerResult.outcome === "circuit-open") {
    logger.warn({ deliveryId: input.deliveryId }, "triage short-circuited by open breaker");
    return { outcome: "fallback", reason: "circuit-open" };
  }
  if (breakerResult.outcome === "error") {
    const msg = breakerResult.error?.message ?? "unknown";
    const reason: TriageFallbackReason = msg.startsWith("triage-timeout") ? "timeout" : "llm-error";
    logger.warn(
      { deliveryId: input.deliveryId, err: msg, reason },
      "triage LLM call failed; falling back",
    );
    return { outcome: "fallback", reason };
  }

  const response = breakerResult.value;
  if (response === undefined) {
    return { outcome: "fallback", reason: "llm-error" };
  }

  // Defensive prose extraction first, `parseStructuredResponse` only
  // strips code fences. Triage occasionally sees prose-wrapped JSON
  // ("Here's the verdict: { ... }") which we want to recover from.
  const jsonText = extractJsonObject(response.text);
  if (jsonText === null) {
    const rawPreview = sanitizeContent(response.text.slice(0, 200));
    logger.warn(
      { deliveryId: input.deliveryId, rawPreview },
      "triage response did not contain a JSON object; falling back",
    );
    return { outcome: "fallback", reason: "parse-error" };
  }

  const parseResult = parseStructuredResponse(jsonText, TriageResponseSchema);
  if (!parseResult.ok) {
    logger.warn(
      { deliveryId: input.deliveryId, stage: parseResult.stage, error: parseResult.error },
      "triage response rejected by structured-output pipeline; falling back",
    );
    return { outcome: "fallback", reason: "parse-error" };
  }
  if (parseResult.strategy === "tolerant") {
    logger.info({ deliveryId: input.deliveryId }, "triage response recovered via tolerant parser");
  }

  const triage = parseResult.data;
  const result: TriageResult = {
    ...triage,
    costUsd: estimateHaikuCostUsd(response.usage, response.model),
    latencyMs: breakerResult.latencyMs,
    provider: client.provider,
    model: response.model,
    deliveryId: input.deliveryId,
  };

  // Persist BEFORE the confidence gate so observers always see what the
  // model returned, even when the scaler ignores a low-confidence vote.
  await persistTriageResult(result);

  if (triage.confidence < config.triageConfidenceThreshold) {
    logger.info(
      {
        deliveryId: input.deliveryId,
        confidence: triage.confidence,
        threshold: config.triageConfidenceThreshold,
      },
      "triage result below confidence threshold; falling back",
    );
    return { outcome: "fallback", reason: "sub-threshold", result };
  }

  return { outcome: "result", result };
}
