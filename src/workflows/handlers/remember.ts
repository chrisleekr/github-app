import type { Octokit } from "octokit";

import { runPipeline } from "../../core/pipeline";
import type { BotContext } from "../../types";
import { fetchAndBuildDigest, renderDigestSection } from "../discussion-digest";
import type { WorkflowHandler } from "../registry";
import { findById } from "../runs-store";

/**
 * `remember` handler (issue #160 Option A): explicit `@bot remember [...]`
 * directive capture from any issue, PR, or PR-review comment.
 *
 * The trigger comment may carry the directive inline ("remember: don't flag
 * fixture duplication") or reference upstream thread context ("remember
 * this", "remember the rule above"). The handler always feeds the agent the
 * full discussion-digest so the "remember this" form has the context it
 * needs to extract a directive.
 *
 * Tool surface is deliberately narrow: the agent gets `save_review_learning`
 * (and `get_review_learnings` for deduping) plus `update_claude_comment` for
 * progress. No Bash, no Edit, no commits, this workflow never touches code.
 *
 * Skipped when the agent concludes there is no directive to extract (e.g.,
 * "remember this" on a thread that carries no policy-shaped statement). The
 * handler does not surface that as a failure: a no-op save is the correct
 * outcome and the tracking comment makes it visible.
 */
export const handler: WorkflowHandler = async (ctx) => {
  const { octokit, target, logger: log, deliveryId, runId } = ctx;

  try {
    // Common metadata for both issue + PR targets. The discussion-digest
    // and prompt path do not need the full PR object; reduce to the few
    // fields the BotContext requires.
    const titleAndBody = await fetchTitleAndBody(octokit, target);
    if (titleAndBody === null) {
      return {
        status: "failed",
        reason: `target #${String(target.number)} not found`,
      };
    }

    // Build the discussion digest FIRST so the seed setState below (which
    // can delete a prior tracking comment of the same workflow) does not
    // race the digest's own thread read. Same ordering rule as review /
    // resolve.
    const digestSection = renderDigestSection(
      await fetchAndBuildDigest({
        octokit,
        owner: target.owner,
        repo: target.repo,
        number: target.number,
        title: titleAndBody.title,
        body: titleAndBody.body,
        workflowName: ctx.workflowName,
        // Include PR review comments only when the target is actually a PR;
        // on issues the includeReviewComments flag is a no-op but explicit
        // is clearer than implicit.
        includeReviewComments: target.type === "pr",
        log,
      }),
    );

    await ctx.setState(
      {
        target_type: target.type,
        target_number: target.number,
      },
      "🧠 **Remember starting**, reading the thread and extracting the directive…",
    );
    const seededRow = await findById(runId);
    const trackingCommentId = seededRow?.tracking_comment_id ?? undefined;
    if (trackingCommentId === undefined) {
      log.warn({ runId }, "remember handler: tracking comment id not found after seed setState");
    }

    const triggerBody = buildRememberPrompt({
      targetType: target.type,
      targetNumber: target.number,
      title: titleAndBody.title,
    });

    const botCtx: BotContext = {
      owner: target.owner,
      repo: target.repo,
      entityNumber: target.number,
      isPR: target.type === "pr",
      // Choosing the most specific event we can attribute. The pipeline
      // does not care which of the two values it sees here, but the prompt
      // builder uses isPR (set above) for branch logic, so this is purely
      // a record-keeping field.
      eventName: target.type === "pr" ? "pull_request_review_comment" : "issue_comment",
      triggerUsername: "chrisleekr-bot[bot]",
      triggerTimestamp: new Date().toISOString(),
      triggerBody,
      commentId: 0,
      deliveryId: deliveryId ?? runId,
      defaultBranch: titleAndBody.defaultBranch,
      ...(titleAndBody.headBranch !== null ? { headBranch: titleAndBody.headBranch } : {}),
      ...(titleAndBody.baseBranch !== null ? { baseBranch: titleAndBody.baseBranch } : {}),
      labels: [],
      // The workflow-dispatch path requires this passthrough or
      // ctx.reviewLearnings collapses to undefined and the MCP server sees
      // an empty universe (which is fine for "save" but breaks dedup via
      // get_review_learnings).
      ...(ctx.reviewLearnings !== undefined ? { reviewLearnings: ctx.reviewLearnings } : {}),
      octokit,
      log,
    };

    const result = await runPipeline(botCtx, {
      captureFiles: ["REMEMBER.md"],
      ...(trackingCommentId !== undefined ? { trackingCommentId } : {}),
      ...(digestSection.length > 0 ? { discussionDigest: digestSection } : {}),
      // Narrow the agent's tool surface: the only writes this workflow
      // makes are the save_review_learning round-trip and the tracking
      // comment update. No code edits, no shell, no commits.
      allowedTools: [
        "mcp__repo_memory__save_review_learning",
        "mcp__repo_memory__get_review_learnings",
        "mcp__github_comment__update_claude_comment",
      ],
      // Surface the save_review_learning MCP tool and the REVIEW_LEARNINGS
      // env var (existing universe for dedup). The handler-level gate in
      // pipeline.ts is what keeps this tool out of other workflows.
      enableReviewLearnings: true,
    });

    if (!result.success) {
      return {
        status: "failed",
        reason: result.errorMessage ?? "remember pipeline execution failed",
        humanMessage: "remember pipeline execution failed, see server logs for details.",
      };
    }

    // REMEMBER.md is the agent-authored audit log: what was extracted,
    // what was saved, what was skipped. Surfaced verbatim as the final
    // tracking comment body so the human can re-read the decision later.
    const report = result.capturedFiles?.["REMEMBER.md"]?.trim() ?? "";
    const humanMessage =
      report.length > 0
        ? report
        : "🧠 Remember complete (no audit report produced, see server logs).";

    return {
      status: "succeeded",
      state: { target_number: target.number, target_type: target.type },
      humanMessage,
    };
  } catch (err) {
    log.error({ err, runId, target: target.number }, "remember handler threw");
    return {
      status: "failed",
      reason: err instanceof Error ? err.message : "unknown error",
      humanMessage: "remember pipeline execution failed, see server logs for details.",
    };
  }
};

/**
 * Fetch the title + body the discussion-digest needs. Branch metadata is
 * PR-only; falls back to defaultBranch for issue targets so the BotContext
 * still has the field populated (the prompt path does not read it on
 * issues, but the type requires a value).
 */
async function fetchTitleAndBody(
  octokit: Octokit,
  target: { type: "issue" | "pr"; owner: string; repo: string; number: number },
): Promise<{
  title: string;
  body: string;
  defaultBranch: string;
  headBranch: string | null;
  baseBranch: string | null;
} | null> {
  if (target.type === "pr") {
    const { data: pr } = await octokit.rest.pulls.get({
      owner: target.owner,
      repo: target.repo,
      pull_number: target.number,
    });
    return {
      title: pr.title,
      body: pr.body ?? "",
      defaultBranch: pr.base.repo.default_branch,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
    };
  }
  const { data: issue } = await octokit.rest.issues.get({
    owner: target.owner,
    repo: target.repo,
    issue_number: target.number,
  });
  const { data: repo } = await octokit.rest.repos.get({
    owner: target.owner,
    repo: target.repo,
  });
  return {
    title: issue.title,
    body: issue.body ?? "",
    defaultBranch: repo.default_branch,
    headBranch: null,
    baseBranch: null,
  };
}

function buildRememberPrompt(input: {
  targetType: "issue" | "pr";
  targetNumber: number;
  title: string;
}): string {
  const targetLabel =
    input.targetType === "pr"
      ? `pull request #${String(input.targetNumber)}`
      : `issue #${String(input.targetNumber)}`;
  return [
    `You are the **remember** agent on ${targetLabel}: ${input.title}`,
    ``,
    `The maintainer triggered \`@chrisleekr-bot remember ...\` on this thread. Your job is to extract a single durable repo-policy directive from the thread context and persist it via \`mcp__repo_memory__save_review_learning\`.`,
    ``,
    `## Tools you have (and the ONLY tools you may call)`,
    `- \`mcp__github_comment__update_claude_comment\`, refresh the tracking comment at each checkpoint.`,
    `- \`mcp__repo_memory__get_review_learnings\`, enumerate existing directives so you can avoid saving a duplicate.`,
    `- \`mcp__repo_memory__save_review_learning\`, persist the new directive.`,
    ``,
    `You do NOT have Bash, Edit, Read, or any code-modifying tool. This workflow never touches code.`,
    ``,
    `Do the following in order:`,
    ``,
    `1. **[update tracking comment]** Post: "🧠 Remember, reading the thread."`,
    ``,
    `2. **Locate the trigger comment.** The discussion digest below shows every comment on this ${input.targetType}. Find the most recent comment containing \`@chrisleekr-bot remember\` (or the configured trigger phrase + the word "remember") authored by a maintainer.`,
    ``,
    `3. **Extract the directive.** Two forms to handle:`,
    `   - **Inline:** \`remember: don't flag fixture duplication in test/**/*.test.ts\` -- the directive is the text after \`remember:\` (or \`remember\`).`,
    `   - **Referential:** \`@chrisleekr-bot remember this\` / \`...remember the rule above\` -- the directive lives in the upstream thread. Walk back through prior maintainer comments in the digest (the digest already separates maintainer-authoritative directives from context) and pick the policy statement they're referring to. If the reference is ambiguous (multiple candidates) prefer the most recent maintainer comment before the trigger.`,
    ``,
    `   The extracted \`directive\` MUST be a short imperative-voice rule (≤200 chars), e.g.:`,
    `     - "Do not flag duplication in fixture builders in test/**/*.test.ts"`,
    `     - "Treat 200-line file caps as guidelines, not blockers, in src/core/**"`,
    `     - "Do not require typedoc on internal helpers under src/utils/**"`,
    ``,
    `4. **Decide \`file_glob\`.** If the directive cites a path pattern, capture it. If it's repo-wide, leave \`file_glob\` null (omit the argument). Globs MUST be picomatch-compatible (e.g. \`test/**/*.test.ts\`, not \`test/**/*.{test,spec}.ts\` with nested braces -- the orchestrator rejects pathological globs).`,
    ``,
    `5. **Decide \`scope\`.** Default \`'local'\` (this repo only). Use \`'global'\` ONLY when the maintainer's language explicitly references org-wide policy ("across all our repos", "for any of our services") AND the deploy is single-tenant; the orchestrator silently downgrades \`'global'\` to \`'local'\` when ALLOWED_OWNERS has > 1 owner, so when in doubt go local.`,
    ``,
    `6. **Decide \`rationale\`.** A 1-3 sentence WHY pulled from the maintainer's own words in the thread. If the rationale is not stated, set it to a brief explanation of the directive's intent in your own words.`,
    ``,
    `7. **Capture provenance.** Set \`source_pr\` = ${String(input.targetNumber)} when the target is a PR (omit on issue context), \`source_author\` = the trigger comment's maintainer login (NOT \`chrisleekr-bot\`), \`source_thread\` = the URL fragment for the triggering comment if available (e.g. \`#issuecomment-12345\` or \`#discussion_r12345\`).`,
    ``,
    `8. **Dedup pre-check.** Call \`mcp__repo_memory__get_review_learnings\` and skim the existing directives. If the rule you'd save is a paraphrase of an existing one with the same scope and (sub)set of file_glob, **do not save**. Update the tracking comment to say "🧠 Already remembered as \`<existing_id>\`" with a one-line quote of the matching directive.`,
    ``,
    `9. **Save.** Otherwise call \`mcp__repo_memory__save_review_learning\` with the fields above.`,
    ``,
    `10. **Refusal cases.** If you cannot extract a directive (no inline directive AND no policy statement in the upstream thread), do NOT save anything. Update the tracking comment with: "🧠 Could not extract a directive. The trigger comment did not include an inline rule and the thread above did not contain a maintainer-authoritative policy statement to reference. Please rephrase as \`@chrisleekr-bot remember: <your rule>\` with the rule inline." and exit.`,
    ``,
    `11. **Write \`$BOT_ARTIFACT_DIR/REMEMBER.md\`** as the final audit record. Required sections:`,
    `    ## Trigger, link/quote of the trigger comment.`,
    `    ## Directive, the extracted rule (or "(none extracted)" on refusal).`,
    `    ## Scope, local | global, with a one-line reason for the choice.`,
    `    ## File glob, the glob (or "*" for repo-wide / "(none)" on refusal).`,
    `    ## Rationale, the WHY pulled from the thread.`,
    `    ## Provenance, source_pr, source_author, source_thread, with links.`,
    `    ## Outcome, "saved as <id>" | "deduped against <existing_id>" | "refused (reason)".`,
    `    This file is written outside the cloned repo; do NOT \`git add\` it (you cannot anyway -- no Bash tool).`,
    ``,
    `12. **[update tracking comment]** Final: paste the REMEMBER.md contents verbatim. No emoji prelude, the audit log IS the message.`,
  ].join("\n");
}
