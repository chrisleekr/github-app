/**
 * Scoped-command fan-out (US5 / T089-T091). Maps a `CanonicalCommand`
 * with a scoped intent (`fix-thread`, `chat-thread`, `summarize`,
 * `rebase`, `investigate`, `triage`, `open-pr`) to the appropriate
 * scoped handler. Each handler is stateless: no `ship_intents` row,
 * no tracking comment, no continuation. Failures are logged and
 * swallowed at the per-intent boundary so a misbehaving handler does
 * not poison the webhook delivery.
 *
 * The dispatcher centralises the LLM-call factory (Bedrock single-turn
 * via `src/ai/llm-client.ts`) so scoped handlers stay pure of
 * provider details.
 *
 * Two of the seven scoped commands: `fix-thread` and `rebase`,
 * require server-side git operations (clone + diff + push). Those are
 * delegated to a daemon-side helper that is NOT wired in v1; until
 * the helper lands, the dispatcher posts a maintainer-facing notice
 * explaining the limitation. The other five commands run in v1.
 */

import type { Octokit } from "octokit";
import type { Logger } from "pino";

import {
  type LLMTool,
  type LLMToolHandler,
  resolveModelId,
  runWithTools,
} from "../../../ai/llm-client";
import { config } from "../../../config";
import { enqueueJob } from "../../../orchestrator/job-queue";
import type { CanonicalCommand } from "../../../shared/ship-types";
import { getTriageLLMClient } from "../../../webhook/triage-client-factory";
import { SHIP_LOG_EVENTS } from "../log-fields";
import { runChatThread } from "./chat-thread";
import { runInvestigate } from "./investigate";
import { runOpenPrPolicy } from "./open-pr";
import { runSummarize } from "./summarize";
import { runTriage } from "./triage";

export interface ScopedCommandDeps {
  readonly octokit: Octokit;
  readonly log?: Logger;
}

/**
 * Build the LLM-call adapter the scoped handlers expect. Reuses the
 * shared triage LLM client (Bedrock when configured, Anthropic otherwise)
 * to avoid spinning up a parallel SDK instance per command. When the
 * caller supplies `tools` + `onToolCall`, dispatch goes through the
 * shared `runWithTools` loop (issue #117); otherwise stays single-turn.
 */
function buildCallLlm(): (input: {
  systemPrompt: string;
  userPrompt: string;
  tools?: readonly LLMTool[];
  onToolCall?: LLMToolHandler;
}) => Promise<string> {
  const llm = getTriageLLMClient();
  const modelId = resolveModelId(config.triageModel, llm.provider);
  return async (params) => {
    if (params.tools !== undefined && params.onToolCall !== undefined) {
      const result = await runWithTools(llm, {
        model: modelId,
        system: params.systemPrompt,
        messages: [{ role: "user", content: params.userPrompt }],
        maxTokens: 800,
        tools: params.tools,
        onToolCall: params.onToolCall,
      });
      return result.text;
    }
    const res = await llm.create({
      model: modelId,
      system: params.systemPrompt,
      messages: [{ role: "user", content: params.userPrompt }],
      maxTokens: 800,
    });
    return res.text;
  };
}

/**
 * Synthesize a `triggerCommentId` for scoped-job offers. CanonicalCommand
 * carries `thread_id` (the REST review-comment id) for review-thread
 * triggers; for non-thread triggers the dispatcher today does not plumb
 * the maintainer's comment id through, so we fall back to a sentinel
 * (`1`) and rely on the daemon-side idempotency check against the
 * tracking-comment durable layer instead.
 *
 * The schema requires a positive integer; downstream consumers MUST treat
 * `1` as "unknown" rather than as a real id.
 */
function deriveTriggerCommentId(command: CanonicalCommand): number {
  if (command.thread_id !== undefined && command.thread_id.length > 0) {
    const parsed = Number(command.thread_id);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 1;
}

/**
 * Build the queue offer for the review-thread-scoped `fix-thread` job.
 * Refuses dispatch when the thread cannot be resolved (no scoped offer
 * is enqueued).
 */
async function enqueueScopedThreadJob(
  deps: ScopedCommandDeps,
  command: CanonicalCommand,
  kind: "scoped-fix-thread",
): Promise<void> {
  const triggerCommentId = deriveTriggerCommentId(command);
  if (triggerCommentId === 1) {
    deps.log?.warn(
      { intent: command.intent },
      `${kind}: missing thread_id on canonical command, refusing dispatch`,
    );
    return;
  }
  const threadRef = await resolveThreadRef(deps, command, triggerCommentId);
  if (threadRef === null) {
    return;
  }
  await enqueueJob({
    kind,
    deliveryId: `${kind}::${command.pr.owner}/${command.pr.repo}#${String(command.pr.number)}::${String(triggerCommentId)}`,
    repoOwner: command.pr.owner,
    repoName: command.pr.repo,
    entityNumber: command.pr.number,
    isPR: true,
    eventName: "pull_request_review_comment",
    triggerUsername: command.principal_login,
    labels: [],
    triggerBodyPreview: "",
    enqueuedAt: Date.now(),
    retryCount: 0,
    installationId: command.pr.installation_id,
    prNumber: command.pr.number,
    threadRef,
    triggerCommentId,
  });
  const eventKey = SHIP_LOG_EVENTS.scoped.fixThread.enqueued;
  deps.log?.info(
    {
      event: eventKey,
      owner: command.pr.owner,
      repo: command.pr.repo,
      pr_number: command.pr.number,
      thread_id: threadRef.threadId,
    },
    `${kind} enqueued`,
  );
}

/**
 * Resolve a review-comment's file/line range so the daemon executor can
 * scope its prompt without re-fetching. Returns null when the lookup
 * fails: caller should refuse the dispatch in that case rather than
 * enqueue a malformed offer.
 */
async function resolveThreadRef(
  deps: ScopedCommandDeps,
  command: CanonicalCommand,
  commentId: number,
): Promise<{
  threadId: string;
  commentId: number;
  filePath: string;
  startLine: number;
  endLine: number;
} | null> {
  try {
    const res = await deps.octokit.rest.pulls.getReviewComment({
      owner: command.pr.owner,
      repo: command.pr.repo,
      comment_id: commentId,
    });
    const c = res.data;
    if (typeof c.path !== "string" || c.path.length === 0) return null;
    const startLine =
      typeof c.start_line === "number" && c.start_line > 0
        ? c.start_line
        : typeof c.line === "number" && c.line > 0
          ? c.line
          : null;
    const endLine = typeof c.line === "number" && c.line > 0 ? c.line : startLine;
    if (startLine === null || endLine === null) return null;
    return {
      threadId: command.thread_id ?? String(commentId),
      commentId,
      filePath: c.path,
      startLine,
      endLine,
    };
  } catch (err) {
    deps.log?.warn(
      { err, commentId, intent: command.intent },
      "resolveThreadRef failed, refusing scoped dispatch",
    );
    return null;
  }
}

/**
 * Run the chat-thread conversational executor against a `CanonicalCommand`.
 * Exported so non-scoped callers (e.g. ship's iteration-0 reroute in
 * `session-runner.ts`) can hand off to chat-thread without rebuilding
 * the LLM caller or surface mapping. Refuses dispatch when the command
 * lacks the comment fields chat-thread needs (label triggers, etc.).
 */
export async function runChatThreadFromCommand(
  command: CanonicalCommand,
  deps: ScopedCommandDeps,
): Promise<void> {
  if (command.comment_body === undefined || command.trigger_comment_id === undefined) {
    deps.log?.warn(
      { intent: command.intent },
      "chat-thread: missing comment_body or trigger_comment_id on canonical command, refusing dispatch",
    );
    return;
  }
  const targetType: "issue" | "pr" = command.event_surface === "issue-comment" ? "issue" : "pr";
  const triggerEventType: "issue_comment" | "pull_request_review_comment" =
    command.event_surface === "review-comment" ? "pull_request_review_comment" : "issue_comment";
  await runChatThread({
    octokit: deps.octokit,
    owner: command.pr.owner,
    repo: command.pr.repo,
    targetType,
    targetNumber: command.pr.number,
    threadId: command.thread_id ?? null,
    triggerCommentId: command.trigger_comment_id,
    triggerCommentBody: command.comment_body,
    triggerEventType,
    principalLogin: command.principal_login,
    callLlm: buildCallLlm(),
    ...(deps.log ? { log: deps.log } : {}),
  });
}

/**
 * Stateless one-shot dispatch. The whole body is wrapped in a top-level
 * try/catch so any Octokit, LLM, or callback error is logged and
 * swallowed at the per-intent boundary: a misbehaving scoped command
 * never rejects up to the webhook delivery loop.
 */
export async function dispatchScopedCommand(
  command: CanonicalCommand,
  deps: ScopedCommandDeps,
): Promise<void> {
  try {
    await runScopedCommand(command, deps);
  } catch (err) {
    deps.log?.error(
      {
        err,
        intent: command.intent,
        owner: command.pr.owner,
        repo: command.pr.repo,
        pr_number: command.pr.number,
      },
      "dispatchScopedCommand: scoped handler threw, swallowed at per-intent boundary",
    );
  }
}

async function runScopedCommand(command: CanonicalCommand, deps: ScopedCommandDeps): Promise<void> {
  const callLlm = buildCallLlm();
  switch (command.intent) {
    case "summarize":
      await runSummarize({
        octokit: deps.octokit,
        owner: command.pr.owner,
        repo: command.pr.repo,
        pr_number: command.pr.number,
        callLlm,
        ...(deps.log ? { log: deps.log } : {}),
      });
      return;
    case "investigate":
      await runInvestigate({
        octokit: deps.octokit,
        owner: command.pr.owner,
        repo: command.pr.repo,
        issue_number: command.pr.number,
        callLlm,
        ...(deps.log ? { log: deps.log } : {}),
      });
      return;
    case "triage":
      await runTriage({
        octokit: deps.octokit,
        owner: command.pr.owner,
        repo: command.pr.repo,
        issue_number: command.pr.number,
        callLlm,
        ...(deps.log ? { log: deps.log } : {}),
      });
      return;
    case "open-pr": {
      // Run the policy-only path of `runOpenPr` (idempotency + classifier +
      // non-actionable refusal). On `actionable`, hand the verdict to the
      // daemon via a `scoped-open-pr` queue offer so the daemon can clone,
      // scaffold a branch via the Agent SDK, push, and open the PR.
      //
      // The legacy approach called `runOpenPr` with a stub `createBranchAndPr`
      // that returned `{ pr_number: 0, ... }`. That caused `runOpenPr` to
      // post a back-link marker `<!-- bot:open-pr:0 -->` BEFORE the daemon
      // had created any PR, `findExistingBackLink` matches by verb prefix,
      // so the bogus marker would permanently block future re-triggers
      // (Copilot review on PR #79). The daemon executor is now solely
      // responsible for posting the back-link marker once it actually
      // creates the PR.
      const policy = await runOpenPrPolicy({
        octokit: deps.octokit,
        owner: command.pr.owner,
        repo: command.pr.repo,
        issue_number: command.pr.number,
        callLlm,
        ...(deps.log ? { log: deps.log } : {}),
      });
      if (policy.kind !== "actionable") return;
      const verdictSummary = `${policy.issue_title}\n\nclassifier: ${policy.verdict.kind} (${policy.verdict.actionable ? "actionable" : "non-actionable"})\n\nreason: ${policy.verdict.reason}`;
      await enqueueJob({
        kind: "scoped-open-pr",
        deliveryId: `scoped-open-pr::${command.pr.owner}/${command.pr.repo}#${String(command.pr.number)}::${String(Date.now())}`,
        repoOwner: command.pr.owner,
        repoName: command.pr.repo,
        entityNumber: command.pr.number,
        isPR: false,
        eventName: "issues",
        triggerUsername: command.principal_login,
        labels: [],
        triggerBodyPreview: verdictSummary.slice(0, 200),
        enqueuedAt: Date.now(),
        retryCount: 0,
        installationId: command.pr.installation_id,
        issueNumber: command.pr.number,
        triggerCommentId: deriveTriggerCommentId(command),
        verdictSummary,
      });
      deps.log?.info(
        {
          event: SHIP_LOG_EVENTS.scoped.openPr.enqueued,
          owner: command.pr.owner,
          repo: command.pr.repo,
          issue_number: command.pr.number,
        },
        "scoped-open-pr enqueued",
      );
      return;
    }
    case "fix-thread": {
      await enqueueScopedThreadJob(deps, command, "scoped-fix-thread");
      return;
    }
    case "chat-thread": {
      // Inline: chat-thread runs the conversational LLM call in-process,
      // replies via Octokit, and (when the user approves) hands off to
      // existing handlers, no daemon enqueue.
      await runChatThreadFromCommand(command, deps);
      return;
    }
    case "rebase": {
      await enqueueJob({
        kind: "scoped-rebase",
        deliveryId: `scoped-rebase::${command.pr.owner}/${command.pr.repo}#${String(command.pr.number)}::${String(Date.now())}`,
        repoOwner: command.pr.owner,
        repoName: command.pr.repo,
        entityNumber: command.pr.number,
        isPR: true,
        eventName: "pull_request",
        triggerUsername: command.principal_login,
        labels: [],
        triggerBodyPreview: "",
        enqueuedAt: Date.now(),
        retryCount: 0,
        installationId: command.pr.installation_id,
        prNumber: command.pr.number,
        triggerCommentId: deriveTriggerCommentId(command),
      });
      deps.log?.info(
        {
          event: SHIP_LOG_EVENTS.scoped.rebase.enqueued,
          owner: command.pr.owner,
          repo: command.pr.repo,
          pr_number: command.pr.number,
        },
        "scoped-rebase enqueued",
      );
      return;
    }
    default: {
      // Defensive, exhaustiveness guard. A new scoped intent added to
      // SCOPED_COMMAND_INTENTS without a case here will fail the type
      // check.
      const _exhaustive: never = command.intent as never;
      void _exhaustive;
      deps.log?.warn({ intent: command.intent }, "dispatchScopedCommand: unhandled scoped intent");
    }
  }
}
