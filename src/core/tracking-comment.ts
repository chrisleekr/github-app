import { config } from "../config";
import type { DispatchReason, DispatchTarget } from "../shared/dispatch-types";
import type { BotContext } from "../types";
import { safePostToGitHub } from "../utils/github-output-guard";

/** Spinner HTML used by claude-code-action for "in progress" state */
const SPINNER_HTML = `<img src="https://github.com/user-attachments/assets/5ac382c7-e004-429b-8e35-7feb3e8f9c6f" width="14px" height="14px" style="vertical-align: middle; margin-left: 4px;" />`;

/**
 * Render the one-line "why here?" line required by SC-007. The dispatch
 * target is always `daemon`; the reason distinguishes persistent vs
 * ephemeral routing.
 */
export function renderDispatchReasonLine(reason: DispatchReason, target: DispatchTarget): string {
  switch (reason) {
    case "persistent-daemon":
      return `Routed to \`${target}\`, claimed by the persistent daemon pool.`;
    case "ephemeral-daemon-triage":
      return `Routed to \`${target}\`, triage flagged the request as heavy; spawned an ephemeral daemon Pod.`;
    case "ephemeral-daemon-overflow":
      return `Routed to \`${target}\`, persistent queue at capacity; spawned an ephemeral daemon Pod.`;
    case "ephemeral-spawn-failed":
      return `\`${target}\` scale-up rejected: ephemeral-daemon Pod spawn failed (Kubernetes infrastructure unavailable).`;
  }
}

/**
 * Triage payload surfaced in tracking comments. A narrow shape: decoupled
 * from `TriageResult` so this module has no dependency on the orchestrator.
 */
export interface TriageCommentSection {
  readonly heavy: boolean;
  readonly confidence: number;
  readonly rationale: string;
  readonly provider: "anthropic" | "bedrock";
  readonly model: string;
  readonly costUsd: number;
  readonly latencyMs: number;
}

/**
 * HTML-escape untrusted strings before embedding inside a `<details>` block.
 * `rationale` is model-generated; without escaping, a stray `</details>`
 * (or any `<…>` tag) could break out of the collapsible section or render
 * unintended HTML.
 */
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render the optional triage details block as a collapsible `<details>`
 * section so the tracking comment stays short by default.
 *
 * Markdown inside a `<details>` element requires a blank line after the
 * `<summary>` for GitHub to render tables/lists reliably.
 */
export function renderTriageSection(triage: TriageCommentSection): string {
  const confidencePct = (triage.confidence * 100).toFixed(0);
  const costFmt = triage.costUsd < 0.001 ? "<US$0.001" : `US$${triage.costUsd.toFixed(4)}`;
  const safeRationale = escapeHtml(triage.rationale);
  const heavyLabel = triage.heavy ? "heavy" : "not heavy";
  return [
    "<details>",
    `<summary>Triage details, classification: <code>${heavyLabel}</code>, confidence: ${confidencePct}%</summary>`,
    "",
    `**Rationale:** ${safeRationale}`,
    "",
    `- Provider: \`${triage.provider}\``,
    `- Model: \`${triage.model}\``,
    `- Cost: ${costFmt}`,
    `- Latency: ${String(triage.latencyMs)} ms`,
    "</details>",
  ].join("\n");
}

/**
 * Build the hidden HTML marker embedded in the tracking comment body so the
 * bot's own tracking comment can be located and updated in place (see the
 * `comment` MCP server). Redelivery idempotency lives elsewhere now
 * (`claimDelivery` + `idx_workflow_runs_inflight`, issue #202); the in-memory
 * Map + marker-scan idempotency check were retired in issue #211.
 */
export function deliveryMarker(deliveryId: string): string {
  return `<!-- delivery:${deliveryId} -->`;
}

/**
 * Create the initial tracking comment ("Working...").
 * Returns the comment ID for future updates.
 *
 * Ported from claude-code-action's comment creation logic
 */
export async function createTrackingComment(ctx: BotContext): Promise<number> {
  const { octokit, owner, repo, entityNumber, log } = ctx;

  // Embed the deliveryId marker so the bot can locate and update its own tracking
  // comment in place (see the `comment` MCP server). Not an idempotency mechanism
  // anymore (claimDelivery + idx_workflow_runs_inflight own that, #202; the Map +
  // marker-scan check were retired in #211).
  const body = `${deliveryMarker(ctx.deliveryId)}\n${SPINNER_HTML} **${config.triggerPhrase}** is working on this...\n\n_Analyzing your request..._`;

  const guarded = await safePostToGitHub({
    body,
    source: "system",
    callsite: "core.tracking-comment.create",
    log,
    deliveryId: ctx.deliveryId,
    post: (cleanBody) =>
      octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: entityNumber,
        body: cleanBody,
      }),
  });
  if (!guarded.posted || guarded.result === undefined) {
    throw new Error(
      `core.tracking-comment.create: post skipped after secret redaction (matchCount=${guarded.matchCount})`,
    );
  }

  log.info({ trackingCommentId: guarded.result.data.id }, "Created tracking comment");

  return guarded.result.data.id;
}

/**
 * Update the tracking comment with new content.
 * Used by the MCP comment server and the pipeline itself.
 *
 * Always uses the issues API because the tracking comment is created via
 * issues.createComment (even for review comment events). Issue comment IDs
 * are not valid in the pulls review comments namespace.
 * See: https://docs.github.com/en/rest/issues/comments
 */
export async function updateTrackingComment(
  ctx: BotContext,
  trackingCommentId: number,
  body: string,
): Promise<void> {
  const { octokit, owner, repo, log } = ctx;

  // The body here is composed by `finalizeTrackingComment` from the existing
  // (agent-updated) comment body plus a system header. Tag as `agent` so the
  // LLM scanner runs: the agent's MCP-emitted progress text reaches here.
  const guarded = await safePostToGitHub({
    body,
    source: "agent",
    callsite: "core.tracking-comment.update",
    log,
    deliveryId: ctx.deliveryId,
    post: (cleanBody) =>
      octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: trackingCommentId,
        body: cleanBody,
      }),
  });
  // Symmetric with createTrackingComment / scoped-thread executors: surface
  // a body-emptied skip as a hard error so the finalize path can't silently
  // leave the comment stuck on its previous (in-progress) text. The error
  // log inside the helper records the redaction event without matched bytes.
  if (!guarded.posted) {
    throw new Error(
      `core.tracking-comment.update: post skipped after secret redaction (matchCount=${guarded.matchCount})`,
    );
  }
}

/**
 * Finalize the tracking comment with completion status.
 * Called after Claude finishes or errors.
 */
export async function finalizeTrackingComment(
  ctx: BotContext,
  trackingCommentId: number,
  opts: {
    success: boolean;
    durationMs?: number;
    costUsd?: number;
    error?: string;
  },
): Promise<void> {
  const { success, durationMs, costUsd, error } = opts;

  let header: string;
  if (success) {
    const duration = durationMs !== undefined ? `${(durationMs / 1000).toFixed(1)}s` : "unknown";
    const cost = costUsd !== undefined ? `$${costUsd.toFixed(4)}` : "";
    header = `**${config.triggerPhrase} finished @${ctx.triggerUsername}'s task** (${duration}${cost !== "" ? `, ${cost}` : ""})`;
  } else {
    header = `**${config.triggerPhrase} encountered an error** while processing @${ctx.triggerUsername}'s request`;
  }

  // Read current comment body to preserve progress content.
  // Always use issues API -- tracking comment is created via issues.createComment.
  let existingBody = "";
  try {
    const comment = await ctx.octokit.rest.issues.getComment({
      owner: ctx.owner,
      repo: ctx.repo,
      comment_id: trackingCommentId,
    });
    existingBody = comment.data.body ?? "";
  } catch {
    // If we can't read the comment, just use the header
  }

  // Remove spinner from existing body. SPINNER_HTML is a module constant, not user input;
  // all special regex characters are escaped before constructing the pattern.
  const escapedSpinner = SPINNER_HTML.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // eslint-disable-next-line security/detect-non-literal-regexp
  const spinnerRegex = new RegExp(escapedSpinner, "g");
  const cleanedBody = existingBody.replace(spinnerRegex, "");

  const errorSection = error !== undefined && error !== "" ? `\n\n---\n**Error:** ${error}` : "";

  // Re-prepend the delivery marker so the tracking comment keeps its stable hidden marker
  // even if Claude's update_claude_comment call (which runs sanitizeContent) previously
  // stripped it. The marker locates the bot's comment, not idempotency (#202/#211).
  const finalBody = `${deliveryMarker(ctx.deliveryId)}\n${header}\n\n---\n${cleanedBody}${errorSection}`;

  await updateTrackingComment(ctx, trackingCommentId, finalBody);
}
