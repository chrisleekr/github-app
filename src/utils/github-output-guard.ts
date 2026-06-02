/**
 * Output-side chokepoint for every byte we send to GitHub.
 *
 * Wraps any body-bearing octokit/GraphQL call so a single audit point covers
 * comments, reviews, replies, PR/issue bodies, and graphql mutations. The
 * helper:
 *
 *   1. Runs `redactSecrets()` (regex pass: silent strip, structured result).
 *   2. (Optional) Runs the LLM-based scanner when `LLM_OUTPUT_SCANNER_ENABLED`
 *      is true and the body originated from the agent. Scanner failures
 *      fail-open with a `warn` log so a Bedrock outage cannot break every
 *      bot reply.
 *   3. Skips the GitHub call entirely if the body is whitespace-only after
 *      redaction (don't post a blank comment) and logs an `error` so an
 *      operator notices.
 *   4. Invokes the caller-supplied `post()` with the cleaned body.
 *
 * Call sites stay narrow: they pass the body, a `source` tag, a `callsite`
 * string, and an async callback that performs the actual API call. This
 * keeps the helper agnostic to the dozens of body-bearing octokit methods.
 *
 * Logging contract: log entries NEVER contain the matched bytes, surrounding
 * context, or a hash. Operators get `kinds`, `matchCount`, and the callsite,
 * enough to investigate without reproducing the leak in log storage.
 */

import type { Logger } from "pino";

import { config } from "../config";
import { scanForSecretsWithLlm } from "./llm-output-scanner";
import { isDeletionOnly, redactSecrets, type RedactSecretsResult } from "./sanitize";

/**
 * Tag for the body's provenance.
 *
 * - `agent`: produced by Claude Agent SDK output (or anything that may have
 *   incorporated agent output, including chained workflow handlers). Subject
 *   to BOTH the regex pass AND the optional LLM scanner.
 * - `system`: hard-coded operator/workflow strings (router capacity messages,
 *   marker comments, lifecycle pings). Regex pass only: the LLM scan is
 *   skipped because these strings cannot legitimately contain secrets and
 *   running the scanner would burn latency / dollars on every webhook.
 */
export type OutputSource = "agent" | "system";

export interface SafePostInput<R> {
  /** Raw body about to be sent to GitHub. */
  body: string;
  source: OutputSource;
  /**
   * Stable identifier for the call site (e.g. `"ship.fix-thread:155"`).
   * Used in log entries so operators can locate the offending writer.
   */
  callsite: string;
  log: Logger;
  /** Optional GitHub delivery ID for cross-log correlation. */
  deliveryId?: string | undefined;
  /**
   * Performs the actual GitHub write with the cleaned body. The helper
   * passes the redacted body string; the callback supplies all other
   * arguments (owner/repo/comment_id/etc.) via closure.
   */
  post: (cleanBody: string) => Promise<R>;
}

export interface SafePostResult<R> {
  /** True if the GitHub call ran. False when the body was emptied by redaction. */
  posted: boolean;
  /** Total number of secret matches removed across both regex and LLM passes. */
  matchCount: number;
  /** Distinct secret kinds detected (deduplicated). */
  kinds: string[];
  /** Result of the underlying `post()` call when `posted === true`. */
  result?: R;
  /** Reason the post was skipped, when `posted === false`. */
  reason?: "empty_after_redaction";
}

/**
 * Wrap a GitHub-bound write. Always run the regex pass; conditionally run
 * the LLM pass for agent-sourced bodies. Skip the post if the body is empty
 * after stripping. The caller's `post()` callback receives the cleaned body.
 */
export async function safePostToGitHub<R>(input: SafePostInput<R>): Promise<SafePostResult<R>> {
  const { source, callsite, log, deliveryId } = input;
  const bodyLengthBefore = input.body.length;

  const regexResult: RedactSecretsResult = redactSecrets(input.body);
  let { body, matchCount } = regexResult;
  const kindSet = new Set<string>(regexResult.kinds);

  if (regexResult.matchCount > 0) {
    log.warn(
      {
        event: "secret_redacted",
        scanner: "regex",
        kinds: regexResult.kinds,
        matchCount: regexResult.matchCount,
        callsite,
        deliveryId,
        bodyLengthBefore,
        bodyLengthAfter: body.length,
      },
      "redacted secret(s) from outgoing GitHub body (regex)",
    );
  }

  if (source === "agent" && config.llmOutputScannerEnabled) {
    try {
      const llmResult = await scanForSecretsWithLlm(body, {
        timeoutMs: config.llmOutputScannerTimeoutMs,
      });
      // Regex is the authoritative floor. If the scanner empties a body
      // that the regex pass already accepted as non-empty, treat it as a
      // false positive and keep the regex body, protects
      // finalizeTrackingComment and scoped-thread replies from a single
      // hallucinated match bricking user-visible output.
      const scannerOverMatched =
        llmResult.containsSecret &&
        llmResult.redactedBody.trim().length === 0 &&
        regexResult.body.trim().length > 0;
      // Integrity gate (issue #198): the scanner's redactedBody MUST be
      // achievable by deletion only from its input (the regex-pass body). A
      // prompt-injected or hallucinating scanner could otherwise emit arbitrary
      // bytes into a public GitHub comment under the bot's identity. Reject any
      // body that adds, reorders, or alters bytes and fall back to the
      // regex-only body, exactly as the empty-body over-match path does. The
      // subsequence check runs only for a non-empty containsSecret verdict, so
      // honest deletions still apply unchanged.
      const scannerSubstituted =
        llmResult.containsSecret &&
        !scannerOverMatched &&
        !isDeletionOnly(regexResult.body, llmResult.redactedBody);
      if (scannerOverMatched) {
        log.warn(
          {
            event: "llm_scanner_emptied_body_fallback",
            callsite,
            deliveryId,
            kinds: llmResult.kinds,
            matchCount: llmResult.matchCount,
            bodyLengthBefore: body.length,
          },
          "llm scanner emptied body that regex pass kept; falling back to regex-only body",
        );
      } else if (scannerSubstituted) {
        log.warn(
          {
            event: "llm_scanner_substitution_rejected",
            callsite,
            deliveryId,
            kinds: llmResult.kinds,
            matchCount: llmResult.matchCount,
            bodyLengthBefore: regexResult.body.length,
            bodyLengthAfter: llmResult.redactedBody.length,
          },
          "llm scanner returned a non-deletion-only body; rejecting substitution, falling back to regex-only body",
        );
      } else if (llmResult.containsSecret) {
        const before = body.length;
        body = llmResult.redactedBody;
        matchCount += llmResult.matchCount;
        for (const kind of llmResult.kinds) kindSet.add(kind);
        log.warn(
          {
            event: "secret_redacted",
            scanner: "llm",
            kinds: llmResult.kinds,
            matchCount: llmResult.matchCount,
            callsite,
            deliveryId,
            bodyLengthBefore: before,
            bodyLengthAfter: body.length,
          },
          "redacted secret(s) from outgoing GitHub body (llm)",
        );
      }
    } catch (err) {
      // Fail-open: a Bedrock outage must not break every bot reply.
      log.warn(
        {
          event: "llm_scanner_error",
          callsite,
          deliveryId,
          err: err instanceof Error ? err.message : String(err),
        },
        "llm output scanner failed; posting body that survived regex pass",
      );
    }
  }

  if (body.trim().length === 0) {
    log.error(
      {
        event: "secret_redaction_emptied_body",
        callsite,
        deliveryId,
        kinds: [...kindSet],
        matchCount,
        bodyLengthBefore,
      },
      "post skipped, body emptied by secret redaction",
    );
    return { posted: false, matchCount, kinds: [...kindSet], reason: "empty_after_redaction" };
  }

  const result = await input.post(body);
  return { posted: true, matchCount, kinds: [...kindSet], result };
}
