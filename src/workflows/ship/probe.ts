/**
 * Merge-readiness probe (FR-021, FR-022). Issues the GraphQL query in
 * `contracts/probe-graphql-query.md`, applies the bounded
 * `mergeable=null` backoff schedule from `MERGEABLE_NULL_BACKOFF_MS_LIST`,
 * and returns a `MergeReadiness` verdict via `verdict.ts`.
 *
 * On schedule exhaustion the verdict is `mergeable_pending`: the
 * session yields per FR-020 and the loop never terminates on a null
 * mergeable status.
 */

import type { SQL } from "bun";
import type { Octokit } from "octokit";

import { config } from "../../config";
import { requireDb } from "../../db";
import { appendIteration } from "../../db/queries/ship";
import { PROBE_QUERY, REVIEW_THREADS_PAGE_QUERY } from "../../github/queries";
import { logger } from "../../logger";
import { retryWithBackoff } from "../../utils/retry";
import {
  type CheckHistoryEntry,
  identifyFlakedRequiredChecks,
  projectHistoryFromProbe,
  triggerTargetedRerun,
} from "./flake-tracker";
import { resyncBaseSha } from "./intent";
import { shouldDeferOnReviewLatency } from "./review-barrier";
import { computeVerdict, type MergeReadiness, type ProbeResponseShape } from "./verdict";

// Probe queries live in src/github/queries.ts so the github-state MCP
// server can reuse them without duplicating the GraphQL.

interface ReviewThreadNode {
  readonly id: string;
  readonly isResolved: boolean;
  readonly isOutdated: boolean;
}

interface ReviewThreadsPageResponse {
  readonly repository: {
    readonly pullRequest: {
      readonly reviewThreads: {
        readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
        readonly nodes: readonly ReviewThreadNode[];
      };
    } | null;
  } | null;
}

export interface RunProbeInput {
  readonly octokit: Pick<Octokit, "graphql">;
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  readonly botAppLogin: string;
  readonly botPushedShas: ReadonlySet<string>;
  /** Override the env-driven backoff list, primarily for tests. */
  readonly mergeableBackoffMs?: readonly number[];
  /** Override the sleep function, required for deterministic tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ProbeResult {
  readonly verdict: MergeReadiness;
  readonly response: ProbeResponseShape;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Paginate `reviewThreads` past the first 100 nodes returned by
 * `PROBE_QUERY`. Early-exits as soon as any unresolved + non-outdated
 * thread is found (the verdict only needs to know whether at least one
 * exists: exact count past the first hit is irrelevant).
 *
 * Network/rate-limit blips during pagination are handled by
 * `retryWithBackoff`; if a page genuinely cannot be fetched the helper
 * throws and the caller treats it as a probe failure (fail-closed).
 */
async function paginateReviewThreads(
  octokit: Pick<Octokit, "graphql">,
  args: { owner: string; repo: string; pr_number: number },
  startCursor: string | null,
): Promise<readonly ReviewThreadNode[]> {
  const merged: ReviewThreadNode[] = [];
  let cursor: string | null = startCursor;
  while (cursor !== null) {
    // eslint-disable-next-line no-await-in-loop -- pagination is inherently sequential
    const page = await retryWithBackoff(
      () =>
        octokit.graphql<ReviewThreadsPageResponse>(REVIEW_THREADS_PAGE_QUERY, {
          owner: args.owner,
          repo: args.repo,
          number: args.pr_number,
          cursor,
        }),
      { op: "ship.probe.review_threads" },
    );
    const rt = page.repository?.pullRequest?.reviewThreads;
    if (rt === undefined) break;
    merged.push(...rt.nodes);
    if (rt.nodes.some((n) => !n.isResolved && !n.isOutdated)) break;
    if (!rt.pageInfo.hasNextPage) break;
    // Pagination is single-threaded by construction (no concurrent
    // callers of this function inside one runProbe), so the
    // require-atomic-updates warning here is a false positive.
    // eslint-disable-next-line require-atomic-updates
    cursor = rt.pageInfo.endCursor;
  }
  return merged;
}

/**
 * Merge any additional review-thread pages into the response so
 * `computeVerdict()` sees the full picture. Mutation-free: returns a
 * shallow-cloned response with the merged nodes when pagination is
 * needed; returns the input unchanged otherwise.
 */
async function ensureFullReviewThreads(
  octokit: Pick<Octokit, "graphql">,
  args: { owner: string; repo: string; pr_number: number },
  response: ProbeResponseShape,
): Promise<ProbeResponseShape> {
  const pr = response.repository?.pullRequest ?? null;
  if (pr === null) return response;
  const rt = pr.reviewThreads;
  if (rt.pageInfo?.hasNextPage !== true) return response;

  const additional = await paginateReviewThreads(octokit, args, rt.pageInfo.endCursor);
  if (additional.length === 0) return response;

  return {
    ...response,
    repository: {
      ...response.repository,
      pullRequest: {
        ...pr,
        reviewThreads: {
          ...rt,
          nodes: [...rt.nodes, ...additional],
        },
      },
    },
  };
}

export async function runProbe(input: RunProbeInput): Promise<ProbeResult> {
  const backoff = input.mergeableBackoffMs ?? config.mergeableNullBackoffMsList;
  const sleep = input.sleep ?? defaultSleep;

  // Each individual GraphQL call is wrapped in retryWithBackoff so a
  // single rate-limit or network blip cannot tear down the whole probe
  //, turning a recoverable yield into a session-aborting error. The
  // outer mergeable=null backoff loop is preserved separately because
  // it has different semantics (waiting for GitHub to finish computing
  // mergeable, not retrying a transient failure).
  let lastResponse: ProbeResponseShape | null = null;
  for (let attempt = 0; attempt <= backoff.length; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- attempts are inherently sequential per FR-021
    const response = await retryWithBackoff(
      () =>
        input.octokit.graphql<ProbeResponseShape>(PROBE_QUERY, {
          owner: input.owner,
          repo: input.repo,
          number: input.pr_number,
        }),
      { op: "ship.probe.main" },
    );
    lastResponse = response;
    const mergeable = response.repository?.pullRequest?.mergeable ?? null;
    if (mergeable !== null && mergeable !== "UNKNOWN") {
      const fullResponse = await ensureFullReviewThreads(
        input.octokit,
        { owner: input.owner, repo: input.repo, pr_number: input.pr_number },
        response,
      );
      const verdict = computeVerdict({
        response: fullResponse,
        botAppLogin: input.botAppLogin,
        botPushedShas: input.botPushedShas,
      });
      return { verdict, response: fullResponse };
    }
    if (attempt < backoff.length) {
      const delay = backoff[attempt];
      // eslint-disable-next-line no-await-in-loop -- bounded backoff schedule per FR-020
      if (delay !== undefined) await sleep(delay);
    }
  }

  // Schedule exhausted, return mergeable_pending; caller yields per FR-020.
  if (lastResponse === null) {
    throw new Error("runProbe: no GraphQL response captured (this is a bug)");
  }
  const fullResponse = await ensureFullReviewThreads(
    input.octokit,
    { owner: input.owner, repo: input.repo, pr_number: input.pr_number },
    lastResponse,
  );
  const verdict = computeVerdict({
    response: fullResponse,
    botAppLogin: input.botAppLogin,
    botPushedShas: input.botPushedShas,
  });
  return { verdict, response: fullResponse };
}

// ─── T044/T052, `runProbeIntegrated`: opt-in wrapper that adds the
// review-barrier, flake-tracker, base-ref resync, and verdict_json
// persistence layers around `runProbe`. Existing callers of `runProbe`
// are unaffected.

export interface RunProbeIntegratedInput extends RunProbeInput {
  /**
   * Intent id whose `target_base_sha` is compared against the probe's
   * observed `baseRefOid` (Q2-round1 cascade). Required for any
   * integration that wants resyncBaseSha + verdict_json persistence.
   */
  readonly intent_id: string;
  /** Iteration number for the audit row (T052). */
  readonly iteration_n: number;
  /** Sequential history of check entries observed across iterations. */
  readonly flakeHistory?: readonly CheckHistoryEntry[];
  /**
   * REST octokit for `POST /check-runs/:id/rerequest` (T041). Optional,
   * when omitted, flake reruns are skipped (the verdict still flips
   * away from `ready`).
   */
  readonly restOctokit?: Pick<Octokit, "rest">;
  /** Bot App login for the review-barrier; defaults to `botAppLogin`. */
  readonly applyReviewBarrier?: { readonly safetyMarginMs: number };
  /** SQL handle for the audit-row write. Defaults to `requireDb()`. */
  readonly sql?: SQL;
}

export interface ProbeIntegratedResult extends ProbeResult {
  readonly history: readonly CheckHistoryEntry[];
  readonly baseShaResynced: boolean;
}

export async function runProbeIntegrated(
  input: RunProbeIntegratedInput,
): Promise<ProbeIntegratedResult> {
  const result = await runProbe(input);
  const sql = input.sql ?? requireDb();

  const pr = result.response.repository?.pullRequest;
  let verdict = result.verdict;

  // T043, base-ref resync (cascade base change).
  let baseShaResynced = false;
  if (pr !== undefined && pr !== null) {
    const observedBase = pr.baseRefOid;
    const intentRow: { target_base_sha: string }[] = await sql`
      SELECT target_base_sha FROM ship_intents WHERE id = ${input.intent_id}
    `;
    const expected = intentRow[0]?.target_base_sha;
    if (expected !== undefined && expected !== observedBase) {
      const updated = await resyncBaseSha(input.intent_id, observedBase, sql);
      baseShaResynced = updated !== null;
    }
  }

  // T044, review-barrier: gate `ready` verdicts.
  if (verdict.ready && input.applyReviewBarrier !== undefined) {
    const defer = shouldDeferOnReviewLatency({
      probeResponse: result.response,
      ourAppLogin: input.botAppLogin,
      safetyMarginMs: input.applyReviewBarrier.safetyMarginMs,
    });
    if (defer) {
      verdict = {
        ready: false,
        reason: "review_barrier_deferred",
        detail:
          "review-barrier deferring: no non-bot review on current head SHA and safety margin not yet elapsed",
        checked_at: verdict.checked_at,
        head_sha: verdict.head_sha,
      };
    }
  }

  // T044, flake tracker: project history; trigger reruns; re-write
  // verdict if flakes observed AND we'd otherwise have said ready.
  const projectedHistory = projectHistoryFromProbe(result.response);
  const fullHistory: readonly CheckHistoryEntry[] = input.flakeHistory
    ? [...input.flakeHistory, ...projectedHistory]
    : projectedHistory;
  if (verdict.ready) {
    const flakes = identifyFlakedRequiredChecks(fullHistory);
    if (flakes.length > 0) {
      if (input.restOctokit !== undefined) {
        await triggerTargetedRerun({
          octokit: input.restOctokit,
          owner: input.owner,
          repo: input.repo,
          checks: flakes,
        });
      }
      verdict = {
        ready: false,
        reason: "failing_checks",
        detail: `flaked required checks awaiting rerun: ${flakes.map((f) => f.check_name).join(", ")}`,
        checked_at: verdict.checked_at,
        head_sha: verdict.head_sha,
      };
    }
  }

  // T052, write verdict_json + full GraphQL response to ship_iterations.
  try {
    await appendIteration(
      {
        intent_id: input.intent_id,
        iteration_n: input.iteration_n,
        kind: "probe",
        verdict_json: { verdict, response: result.response },
      },
      sql,
    );
  } catch (err) {
    // Best-effort, audit-row failure must not abort the iteration.
    // Log so an unexpected persistence failure shows up in observability.
    logger.warn(
      { err, intent_id: input.intent_id, event: "ship.probe.audit_row_failed" },
      "ship probe audit-row write failed (best-effort)",
    );
  }

  return { verdict, response: result.response, history: fullHistory, baseShaResynced };
}
