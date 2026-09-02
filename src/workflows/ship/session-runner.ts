/**
 * `runShipFromCommand` (T028): entry point for the v2 ship lifecycle
 * driven by a `CanonicalCommand` from `trigger-router.routeTrigger(...)`.
 * Distinct from the legacy `WorkflowHandler` exported by
 * `src/workflows/handlers/ship.ts`, which drives the workflow_runs
 * composite (triage → plan → implement → review → resolve) lifecycle.
 *
 * Re-exported from `ship.ts` for spec-locator parity with T028 path
 * descriptions.
 *
 * Implements:
 *   (a) accept `CanonicalCommand`
 *   (b) `eligibility.checkEligibility` BEFORE any DB write
 *   (c) `intent.createIntent` with already-in-progress reply
 *   (e) terminal action when probe verdict is `ready`:
 *        (1) `markPullRequestReadyForReview` (gated on `isDraft`)
 *        (2) update tracking comment to terminal state
 *        (3) transition `ship_intents.status` to `ready_awaiting_human_merge`
 *
 * Deferred to follow-ups (intentionally scoped out of this slice):
 *   (d) continuation loop swap (US2: fix iteration lives there)
 *   - label self-removal after acting (FR-026a; needs `label_name` carried
 *     in CanonicalCommand)
 *   - reply-as-thread (currently posts a fresh issue comment)
 */

import type { Octokit } from "octokit";
import type { Logger } from "pino";

import { config } from "../../config";
import { requireDb } from "../../db";
import { logger as rootLogger } from "../../logger";
import type { CanonicalCommand } from "../../shared/ship-types";
import { safePostToGitHub } from "../../utils/github-output-guard";
import { checkpointCancelled } from "./abort";
import { checkEligibility } from "./eligibility";
import { createIntent, getIntentById, transitionToTerminal } from "./intent";
import { runIteration } from "./iteration";
import { runProbe } from "./probe";
import { runChatThreadFromCommand } from "./scoped/dispatch-scoped";
import {
  buildIntentMarker,
  createTrackingComment,
  persistTrackingCommentId,
  renderTrackingComment,
  updateTrackingComment,
} from "./tracking-comment";
import type { NonReadinessReason } from "./verdict";

/**
 * Probe verdict reasons that ship cannot make progress on at iteration 0
 * the workflow would post a tracking comment that immediately
 * terminates with the same verdict it started with (issue #119). For
 * these we skip intent creation entirely and either reroute the trigger
 * to chat-thread (when the trigger carries a comment body) or post a
 * single human-readable refusal (label triggers).
 *
 * Currently scoped to `human_took_over`: a human-authored head SHA
 * means the bot must not push, so no amount of iteration helps. Other
 * non-readiness reasons are recoverable by ship (rebase, fix CI, wait
 * for checks, etc.) and stay on the iteration path.
 */
const SHIP_REROUTE_REASONS: ReadonlySet<NonReadinessReason> = new Set<NonReadinessReason>([
  "human_took_over",
]);

const MARK_READY_FOR_REVIEW_MUTATION = `
  mutation MarkReady($pullRequestId: ID!) {
    markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
      pullRequest { id isDraft }
    }
  }
`;

interface MarkReadyResponse {
  readonly markPullRequestReadyForReview: {
    readonly pullRequest: { readonly id: string; readonly isDraft: boolean };
  };
}

export interface RunShipFromCommandInput {
  readonly command: CanonicalCommand;
  readonly octokit: Octokit;
  readonly log?: Logger;
}

export async function runShipFromCommand(input: RunShipFromCommandInput): Promise<void> {
  const { command, octokit } = input;
  const log = (input.log ?? rootLogger).child({
    component: "ship.session-runner",
    intent: command.intent,
    surface: command.surface,
    owner: command.pr.owner,
    repo: command.pr.repo,
    pr_number: command.pr.number,
    principal_login: command.principal_login,
  });

  // (b) Eligibility first, never create state for ineligible PRs.
  const verdict = await checkEligibility({
    octokit,
    owner: command.pr.owner,
    repo: command.pr.repo,
    pr_number: command.pr.number,
    triggeringUserLogin: command.principal_login,
  });
  if (!verdict.eligible) {
    log.info(
      { event: "ship.ineligible", reason: verdict.reason, surface: command.surface },
      "ship trigger rejected, eligibility failed",
    );
    await postRefusal(octokit, command, verdict.message, log);
    return;
  }

  // Probe BEFORE creating the intent so we can carry the canonical
  // base/head SHAs into the row (avoids a second GraphQL call). The
  // probe also gives us the merge-readiness verdict for the terminal
  // shortcut below.
  const probe = await runProbe({
    octokit,
    owner: command.pr.owner,
    repo: command.pr.repo,
    pr_number: command.pr.number,
    botAppLogin: config.botAppLogin,
    botPushedShas: new Set<string>(),
  });
  const pr = probe.response.repository?.pullRequest;
  if (pr === undefined || pr === null) {
    log.warn(
      { event: "ship.probe_pr_missing" },
      "probe returned no pullRequest, aborting (eligibility verified moments ago)",
    );
    return;
  }

  // Iteration-0 reroute (issue #119). Probe verdicts ship cannot recover
  // from at iteration 0 (currently `human_took_over`) skip intent
  // creation: a tracking comment that opens and immediately closes on
  // the same verdict is JSON-dump noise, not a useful answer.
  if (!probe.verdict.ready && SHIP_REROUTE_REASONS.has(probe.verdict.reason)) {
    const verdictReason = probe.verdict.reason;
    const verdictDetail = probe.verdict.detail;
    log.info(
      {
        event: "ship.reroute_iteration_zero",
        verdict_reason: verdictReason,
        verdict_detail: verdictDetail,
      },
      "ship: probe verdict is unrecoverable at iteration 0, handing off to chat-thread",
    );
    if (command.comment_body !== undefined && command.trigger_comment_id !== undefined) {
      await runChatThreadFromCommand(command, { octokit, log });
      return;
    }
    // Label trigger (no comment surface to converse on). Post a single
    // prose refusal that names the blocker, then exit without state.
    // Marker-based dedup: re-applying the label triggers a fresh delivery,
    // so the ingress dedup map doesn't catch repeats. Skip if a prior
    // refusal with the same marker already exists on this PR.
    const refusalMarker = `<!-- ship-reroute-refusal:${command.pr.owner}/${command.pr.repo}#${String(command.pr.number)}:${verdictReason} -->`;
    if (await refusalAlreadyPosted(octokit, command, refusalMarker, log)) {
      log.info(
        { event: "ship.reroute_refusal_already_posted", verdict_reason: verdictReason },
        "ship: prior reroute refusal already on PR, skipping duplicate",
      );
      return;
    }
    await postRefusal(
      octokit,
      command,
      `${refusalMarker}\nthe ship workflow can't take over this PR, ${verdictDetail}. Comment \`${config.triggerPhrase}\` to discuss next steps.`,
      log,
    );
    return;
  }

  const deadlineMs = clampDeadline(command.deadline_ms);
  const deadlineAt = new Date(Date.now() + deadlineMs);

  // (c) Create intent, partial unique index rejects re-trigger.
  const result = await createIntent({
    installation_id: command.pr.installation_id,
    owner: command.pr.owner,
    repo: command.pr.repo,
    pr_number: command.pr.number,
    target_base_sha: pr.baseRefOid,
    target_head_sha: pr.headRefOid,
    deadline_at: deadlineAt,
    created_by_user: command.principal_login,
    tracking_comment_marker: buildIntentMarker(""), // patched below once intent_id is known
  });
  if (!result.ok) {
    log.info(
      { event: "ship.already_in_progress", existing_intent_id: result.existing.id },
      "ship trigger rejected, session already in progress",
    );
    await postReply(
      octokit,
      command,
      `\`bot:ship\` is already in progress for this PR (intent \`${result.existing.id}\`). ` +
        `To stop it, comment \`${config.triggerPhrase} bot:abort-ship\`.`,
      log,
    );
    return;
  }

  const intent = result.intent;
  const sql = requireDb();

  // Patch the marker now that the intent_id is known. The placeholder is
  // never consumed by code in-flight (it only matters for marker-based
  // recovery scans), but persisting the canonical value keeps the row
  // schema-honest for any future re-discovery logic.
  const canonicalMarker = buildIntentMarker(intent.id);
  await sql`UPDATE ship_intents SET tracking_comment_marker = ${canonicalMarker}, updated_at = now() WHERE id = ${intent.id}`;

  // T059 checkpoint: between intent creation and the first user-visible
  // mutation. If the maintainer issued bot:abort/stop in the milliseconds
  // since createIntent landed, bail before posting the tracking comment.
  if (await checkpointCancelled(intent.id)) {
    log.info(
      { event: "ship.checkpoint.cancelled", intent_id: intent.id, where: "post_create_intent" },
      "ship session cancelled at post-create checkpoint",
    );
    return;
  }

  // Create the tracking comment with the real intent id in the marker
  // so post-restart marker scans can re-discover it.
  const initialBody = renderTrackingComment({
    intent_id: intent.id,
    trigger_login: command.principal_login,
    deadline_at: deadlineAt,
    phase: "probing",
    last_action: `Probed merge-readiness, verdict: ${verdictLabel(probe.verdict)}`,
    iteration_n: 0,
    spent_usd: 0,
  });
  const trackingCommentId = await createTrackingComment({
    octokit,
    owner: command.pr.owner,
    repo: command.pr.repo,
    issue_number: command.pr.number,
    body: initialBody,
    log,
  });
  await persistTrackingCommentId(intent.id, trackingCommentId, sql);

  // T059 checkpoint: before any GraphQL mutation (markPullRequestReadyForReview).
  if (await checkpointCancelled(intent.id)) {
    log.info(
      { event: "ship.checkpoint.cancelled", intent_id: intent.id, where: "pre_terminal" },
      "ship session cancelled at pre-terminal checkpoint",
    );
    return;
  }

  // (e) Terminal shortcut, verdict is `ready`.
  if (probe.verdict.ready) {
    await terminalReady({
      octokit,
      command,
      intentId: intent.id,
      trackingCommentId,
      deadlineAt,
      isDraft: pr.isDraft,
      pullRequestNodeId: await getPullRequestNodeId(
        octokit,
        command.pr.owner,
        command.pr.repo,
        command.pr.number,
      ),
      log,
    });
    return;
  }

  // Non-ready verdict: bridge to the isolated `workflow_runs` runner pipeline
  // via runIteration (US1). The orchestrator's completion cascade
  // (`onStepComplete`) ZADDs `ship:tickle` on the run's terminal write
  // so the next iteration re-enters via the tickle scheduler (US2).
  log.info(
    { event: "ship.session_started", intent_id: intent.id, verdict: verdictLabel(probe.verdict) },
    "ship session created, bridging non-ready verdict to iteration handler",
  );

  await runIteration({
    intent,
    probeVerdict: probe.verdict,
    log,
  });
}

/**
 * Resume a paused (or active-but-tickled) intent by re-running the probe
 * and bridging the verdict back to the iteration handler. Idempotent,
 * terminal intents are no-ops; cap/deadline are re-checked inside
 * `runIteration` at every resume so a slow PR cannot accidentally exceed
 * its budget.
 *
 * Used by the tickle scheduler's `onDue` callback (US2 wiring in
 * `src/app.ts`). The `octokitFactory` is injected so the scheduler can
 * mint installation tokens without this module needing to import the
 * orchestrator's cached `App` singleton.
 */
export interface ResumeShipIntentInput {
  readonly intentId: string;
  readonly octokitFactory: (installationId: number) => Promise<Octokit>;
  readonly log?: Logger;
}

export async function resumeShipIntent(input: ResumeShipIntentInput): Promise<void> {
  const log = (input.log ?? rootLogger).child({
    component: "ship.session-runner.resume",
    intent_id: input.intentId,
  });
  const intent = await getIntentById(input.intentId);
  if (intent === null) {
    log.warn(
      { event: "ship.tickle.skip_terminal", reason: "intent_not_found" },
      "resumeShipIntent: intent not found, tickle entry stale, skipping",
    );
    return;
  }
  if (intent.status !== "active" && intent.status !== "paused") {
    log.info(
      { event: "ship.tickle.skip_terminal", status: intent.status },
      "resumeShipIntent: intent already terminal, tickle entry obsolete, skipping",
    );
    return;
  }

  const octokit = await input.octokitFactory(intent.installation_id);
  const probe = await runProbe({
    octokit,
    owner: intent.owner,
    repo: intent.repo,
    pr_number: intent.pr_number,
    botAppLogin: config.botAppLogin,
    botPushedShas: new Set<string>(),
  });

  log.info(
    {
      event: "ship.tickle.due",
      source: "scheduler",
      status: intent.status,
      verdict: verdictLabel(probe.verdict),
    },
    "ship intent resumed by tickle, bridging verdict to iteration handler",
  );

  if (probe.verdict.ready) {
    // Resume sees a now-ready PR. Terminal-shortcut behavior matches
    // `runShipFromCommand`'s ready path, but without the trigger-time
    // `markPullRequestReadyForReview` since the resume context lacks the
    // command + tracking-comment id. Defer the GraphQL flip to the
    // operator path; here we simply terminate the intent.
    await transitionToTerminal(intent.id, "ready_awaiting_human_merge", null);
    log.info(
      { event: "ship.session.terminal_ready_on_resume" },
      "ship intent terminal-ready on resume",
    );
    return;
  }

  await runIteration({ intent, probeVerdict: probe.verdict, log });
}

function verdictLabel(
  v: { readonly ready: true } | { readonly ready: false; readonly reason: string },
): string {
  return v.ready ? "ready" : v.reason;
}

function clampDeadline(requested: number | undefined): number {
  const max = config.maxWallClockPerShipRun;
  if (requested === undefined) return max;
  if (!Number.isFinite(requested) || requested <= 0) return max;
  return Math.min(requested, max);
}

async function postRefusal(
  octokit: Octokit,
  command: CanonicalCommand,
  reason: string,
  log: Logger,
): Promise<void> {
  const body = `\`bot:ship\` declined, ${reason}`;
  try {
    await safePostToGitHub({
      body,
      source: "system",
      callsite: "ship.session-runner.postRefusal",
      log,
      post: (cleanBody) =>
        octokit.rest.issues.createComment({
          owner: command.pr.owner,
          repo: command.pr.repo,
          issue_number: command.pr.number,
          body: cleanBody,
        }),
    });
  } catch (err) {
    log.warn({ err }, "ship refusal reply failed (best-effort)");
  }
}

/**
 * Returns true when a prior reroute-refusal carrying the same marker is
 * already present on the PR. Used to dedup label-trigger reroute refusals
 * against repeat label applies (each apply is a fresh webhook delivery).
 * Best-effort: on listComments failure we fall through and post (the
 * dup-comment cost is small; missing the refusal would be worse).
 */
async function refusalAlreadyPosted(
  octokit: Octokit,
  command: CanonicalCommand,
  marker: string,
  log: Logger,
): Promise<boolean> {
  try {
    const iterator = octokit.paginate.iterator(octokit.rest.issues.listComments, {
      owner: command.pr.owner,
      repo: command.pr.repo,
      issue_number: command.pr.number,
      per_page: 100,
    });
    for await (const page of iterator) {
      for (const c of page.data) {
        if (typeof c.body === "string" && c.body.includes(marker)) return true;
      }
    }
    return false;
  } catch (err) {
    log.warn({ err }, "ship reroute refusal dedup check failed (best-effort)");
    return false;
  }
}

async function postReply(
  octokit: Octokit,
  command: CanonicalCommand,
  body: string,
  log: Logger,
): Promise<void> {
  try {
    await safePostToGitHub({
      body,
      source: "system",
      callsite: "ship.session-runner.postReply",
      log,
      post: (cleanBody) =>
        octokit.rest.issues.createComment({
          owner: command.pr.owner,
          repo: command.pr.repo,
          issue_number: command.pr.number,
          body: cleanBody,
        }),
    });
  } catch (err) {
    log.warn({ err }, "ship reply failed (best-effort)");
  }
}

async function getPullRequestNodeId(
  octokit: Pick<Octokit, "graphql">,
  owner: string,
  repo: string,
  number: number,
): Promise<string | null> {
  try {
    const data = await octokit.graphql<{
      repository: { pullRequest: { id: string } | null } | null;
    }>(
      `query GetPrId($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) { id }
        }
      }`,
      { owner, repo, number },
    );
    return data.repository?.pullRequest?.id ?? null;
  } catch {
    return null;
  }
}

interface TerminalReadyInput {
  readonly octokit: Octokit;
  readonly command: CanonicalCommand;
  readonly intentId: string;
  readonly trackingCommentId: number;
  readonly deadlineAt: Date;
  readonly isDraft: boolean;
  readonly pullRequestNodeId: string | null;
  readonly log: Logger;
}

async function terminalReady(input: TerminalReadyInput): Promise<void> {
  const {
    octokit,
    command,
    intentId,
    trackingCommentId,
    deadlineAt,
    isDraft,
    pullRequestNodeId,
    log,
  } = input;

  // T059 checkpoint immediately before the GraphQL mutation.
  if (await checkpointCancelled(intentId)) {
    log.info(
      { event: "ship.checkpoint.cancelled", intent_id: intentId, where: "pre_mark_ready" },
      "terminalReady cancelled before markPullRequestReadyForReview",
    );
    return;
  }

  // (e)(1) markPullRequestReadyForReview, gated on isDraft. Failure
  // MUST NOT block (2)/(3) but MUST be surfaced.
  let markReadyError: string | null = null;
  if (isDraft && pullRequestNodeId !== null) {
    try {
      await octokit.graphql<MarkReadyResponse>(MARK_READY_FOR_REVIEW_MUTATION, {
        pullRequestId: pullRequestNodeId,
      });
      log.info(
        { event: "ship.ready_for_review", intent_id: intentId },
        "PR transitioned to ready-for-review",
      );
    } catch (err) {
      markReadyError = err instanceof Error ? err.message : String(err);
      log.error(
        { err, event: "ship.ready_for_review_failed", intent_id: intentId },
        "markPullRequestReadyForReview failed, proceeding with terminal transition",
      );
    }
  } else if (isDraft && pullRequestNodeId === null) {
    markReadyError = "could not resolve pull request node id";
    log.warn(
      { event: "ship.ready_for_review_skipped", intent_id: intentId },
      "skipped markPullRequestReadyForReview, node id unavailable",
    );
  }

  // (e)(2) update tracking comment to terminal state.
  const terminalBody = renderTrackingComment({
    intent_id: intentId,
    trigger_login: command.principal_login,
    deadline_at: deadlineAt,
    phase: "terminal",
    last_action:
      markReadyError === null
        ? "PR is merge-ready, handed back for human merge"
        : `PR is merge-ready, handed back for human merge (markReadyForReview failed: ${markReadyError})`,
    iteration_n: 0,
    spent_usd: 0,
    terminal_state: "ready_awaiting_human_merge",
  });
  try {
    await updateTrackingComment({
      octokit,
      owner: command.pr.owner,
      repo: command.pr.repo,
      comment_id: trackingCommentId,
      body: terminalBody,
      log,
    });
  } catch (err) {
    log.warn({ err }, "terminal tracking-comment update failed (best-effort)");
  }

  // (e)(3) transition to terminal state.
  await transitionToTerminal(intentId, "ready_awaiting_human_merge", null);
}
