import { runPipeline } from "../../core/pipeline";
import type { BotContext } from "../../types";
import { fetchAndBuildDigest, renderDigestSection } from "../discussion-digest";
import type { WorkflowHandler } from "../registry";
import { findById } from "../runs-store";
import { type BranchStaleness, formatRefreshDirective, getBranchStaleness } from "./branch-refresh";
import { evaluateChecks } from "./checks";
import { parseOutstandingSection } from "./resolve-report";
import { renderReviewLearningsFooter } from "./review-learnings-footer";

/**
 * `resolve` handler: runs a resolution pass on an open pull request:
 * fixes failing CI and replies to/fixes reviewer comments. Renamed from
 * `review` because the previous name implied proactive code review,
 * whereas the actual job is responding to existing reviewer feedback.
 *
 * Stop bounds (ported verbatim from the `pr-auto` skill, per FR-005(c)):
 *   - `FIX_ATTEMPTS_CAP = 3`: max CI-fix attempts the agent should make
 *     within a single resolve iteration. Currently surfaced only via prompt
 *     interpolation (the agent self-enforces it); cross-run enforcement
 *     would require persisting `fix_attempts` to `state` and is intentionally
 *     deferred until we see real overrun in production.
 *   - `POLL_WAIT_SECS_CAP = 900`: 15-minute reviewer-patience window after
 *     which the bot stops waiting for a slow reviewer. Advisory here (the
 *     handler itself is not a polling loop: each re-application of
 *     `bot:resolve` does one iteration; ship-composite orchestration handles
 *     multi-iteration waits).
 *
 * Comment-validity taxonomy (also from `pr-auto` review-comments skill):
 *   - **Valid**         : reviewer is right; fix required.
 *   - **Partially Valid**: reviewer is partially right; fix scoped portion.
 *   - **Invalid**       : reviewer is wrong; reply with evidence, no code change.
 *   - **Needs Clarification**: ambiguous; reply asking a specific question.
 *
 * The classification itself is delegated to the multi-turn agent via the
 * prompt: the handler does not call the LLM directly. This keeps the
 * heuristic in one place (the prompt) and lets the agent use repo context.
 *
 * Non-negotiable: this handler MUST NEVER call `octokit.rest.pulls.merge`
 * (FR-017). Merging stays a human action.
 */

export const FIX_ATTEMPTS_CAP = 3;
export const POLL_WAIT_SECS_CAP = 900;

export const handler: WorkflowHandler = async (ctx) => {
  const { octokit, target, logger: log, deliveryId, runId } = ctx;

  try {
    if (target.type !== "pr") {
      return { status: "failed", reason: "resolve requires PR target" };
    }

    const { data: pr } = await octokit.rest.pulls.get({
      owner: target.owner,
      repo: target.repo,
      pull_number: target.number,
    });

    if (pr.state !== "open") {
      return {
        status: "failed",
        reason: `PR #${String(target.number)} is ${pr.state}; resolve requires an open PR`,
      };
    }

    // Paginate, `checks.listForRef` defaults to per_page=30. On busy PRs
    // with large CI matrices, a non-paginated call silently under-reports
    // failing checks and the resolve prompt gets a stale picture. Helper
    // shared with the post-pipeline gate so both apply the same rule.
    const preCheckEvaluation = await evaluateChecks(
      octokit,
      target.owner,
      target.repo,
      pr.head.sha,
    );
    const failingChecks = preCheckEvaluation.failingChecks;

    // Count top-level review comments, GitHub's REST API does not expose
    // thread-level resolution state (only the GraphQL `PullRequestReviewThread`
    // surface does), so this is a conservative upper bound. The agent prompt
    // surfaces it as "open comment threads (some may already be resolved)";
    // resolved threads are over-counted but never under-counted.
    //
    // Paginate, `listReviewComments` defaults to per_page=30 like
    // `listForRef`. Without paginate, large PRs silently undercount.
    const reviewComments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner: target.owner,
      repo: target.repo,
      pull_number: target.number,
      per_page: 100,
    });
    const topLevelComments = reviewComments.filter((c) => c.in_reply_to_id === undefined);

    const staleness = await getBranchStaleness(octokit, target.owner, target.repo, target.number);

    // Build the discussion digest BEFORE the seed setState below: that first
    // setState triggers the re-run cleanup that deletes a prior tracking
    // comment, and the digest must read that comment while it still exists.
    const digestSection = renderDigestSection(
      await fetchAndBuildDigest({
        octokit,
        owner: target.owner,
        repo: target.repo,
        number: target.number,
        title: pr.title,
        body: pr.body ?? "",
        workflowName: ctx.workflowName,
        includeReviewComments: true,
        log,
      }),
    );

    // Seed the tracking comment up front so the agent can post mid-run
    // progress against it. See review.ts for the same pattern + rationale.
    await ctx.setState(
      {
        pr_number: target.number,
        failing_checks: failingChecks,
        top_level_comments: topLevelComments.length,
      },
      `🔎 **Resolve starting**, ${String(failingChecks.length)} failing checks, ${String(topLevelComments.length)} open comment threads. Refreshing branch and classifying feedback…`,
    );
    const seededRow = await findById(runId);
    const trackingCommentId = seededRow?.tracking_comment_id ?? undefined;
    if (trackingCommentId === undefined || trackingCommentId === null) {
      log.warn({ runId }, "resolve handler: tracking comment id not found after seed setState");
    }

    const triggerBody = buildResolvePrompt({
      prNumber: target.number,
      prTitle: pr.title,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      failingChecks,
      topLevelCommentCount: topLevelComments.length,
      staleness,
    });

    const botCtx: BotContext = {
      owner: target.owner,
      repo: target.repo,
      entityNumber: target.number,
      isPR: true,
      eventName: "pull_request_review_comment",
      triggerUsername: "chrisleekr-bot[bot]",
      triggerTimestamp: new Date().toISOString(),
      triggerBody,
      commentId: 0,
      deliveryId: deliveryId ?? runId,
      defaultBranch: pr.base.repo.default_branch,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      labels: [],
      // Mirrors review.ts: workflow-dispatch path needs this thread or the
      // pipeline sees ctx.reviewLearnings=undefined and the feature no-ops.
      ...(ctx.reviewLearnings !== undefined ? { reviewLearnings: ctx.reviewLearnings } : {}),
      octokit,
      log,
    };

    const result = await runPipeline(botCtx, {
      captureFiles: ["RESOLVE.md"],
      ...(trackingCommentId !== undefined && trackingCommentId !== null
        ? { trackingCommentId }
        : {}),
      ...(topLevelComments.length > 0 ? { enableResolveReviewThread: true } : {}),
      ...(digestSection.length > 0 ? { discussionDigest: digestSection } : {}),
      // Resolve handler may persist new review_learnings when a maintainer
      // pushback resolves with "intentional, don't flag next time". See
      // review.ts for the gate's contract.
      enableReviewLearnings: true,
    });
    if (!result.success) {
      // `reason` is internal (DB state.failedReason → orchestrator quota
      // detection + operator logs); `humanMessage` is the public tracking
      // comment text and MUST NOT carry the raw error.
      return {
        status: "failed",
        reason: result.errorMessage ?? "resolve pipeline execution failed",
        humanMessage: "resolve pipeline execution failed, see server logs for details.",
      };
    }

    const report = result.capturedFiles?.["RESOLVE.md"]?.trim() ?? "";

    // Post-pipeline CI re-check (issue #93): the agent's prompt-level guards
    // (`FIX_ATTEMPTS_CAP=3`, `## Outstanding`, "STOP. Do NOT mark the run
    // successful") are agent-self-enforced: a hallucinating agent can still
    // exit on red. Re-fetch the PR's HEAD SHA (the agent may have pushed
    // commits) and re-evaluate against the canonical all-green definition.
    const { data: postPr } = await octokit.rest.pulls.get({
      owner: target.owner,
      repo: target.repo,
      pull_number: target.number,
    });
    const postCheckEvaluation = await evaluateChecks(
      octokit,
      target.owner,
      target.repo,
      postPr.head.sha,
    );
    const outstandingBody = parseOutstandingSection(report);

    const meta: string[] = [];
    if (result.costUsd !== undefined) meta.push(`cost: $${result.costUsd.toFixed(4)}`);
    if (result.numTurns !== undefined) meta.push(`turns: ${String(result.numTurns)}`);
    if (result.durationMs !== undefined)
      meta.push(`duration: ${String(Math.round(result.durationMs / 1000))}s`);
    const metaLine = meta.length > 0 ? `\n\n_${meta.join(" · ")}_` : "";

    const baseState = {
      pr_number: target.number,
      failing_checks: failingChecks,
      top_level_comments: topLevelComments.length,
      branch_state: {
        commits_behind_base: staleness.commitsBehindBase,
        commits_ahead_of_base: staleness.commitsAheadOfBase,
        is_fork: staleness.isFork,
      },
      report,
      costUsd: result.costUsd ?? 0,
      turns: result.numTurns ?? 0,
      post_pipeline: {
        head_sha: postPr.head.sha,
        failing_checks: postCheckEvaluation.failingChecks,
        pending_checks: postCheckEvaluation.pendingChecks,
        all_green: postCheckEvaluation.allGreen,
        outstanding_present: outstandingBody !== null,
      },
    };

    const isClean = postCheckEvaluation.allGreen && outstandingBody === null;
    if (!isClean) {
      const reasonParts: string[] = [];
      if (postCheckEvaluation.failingChecks.length > 0) {
        reasonParts.push(
          `CI still red after FIX_ATTEMPTS_CAP=${String(FIX_ATTEMPTS_CAP)} (failing: ${postCheckEvaluation.failingChecks.join(", ")})`,
        );
      }
      if (postCheckEvaluation.pendingChecks.length > 0) {
        reasonParts.push(
          `CI still in flight (pending: ${postCheckEvaluation.pendingChecks.join(", ")})`,
        );
      }
      if (outstandingBody !== null) {
        reasonParts.push("RESOLVE.md ## Outstanding section is non-empty");
      }
      const reason = `resolve incomplete, ${reasonParts.join("; ")}`;

      const headline =
        postCheckEvaluation.failingChecks.length > 0
          ? `🔎 **Resolve incomplete**, ${String(postCheckEvaluation.failingChecks.length)} failing checks remain after the agent finished.`
          : postCheckEvaluation.pendingChecks.length > 0
            ? `🔎 **Resolve incomplete**, ${String(postCheckEvaluation.pendingChecks.length)} checks still in flight after the agent finished.`
            : `🔎 **Resolve incomplete**, outstanding items remain after the agent finished.`;
      const ciOutstandingLines: string[] = [];
      if (postCheckEvaluation.failingChecks.length > 0) {
        ciOutstandingLines.push(
          `CI still red, failing checks: ${postCheckEvaluation.failingChecks.join(", ")}`,
        );
      }
      if (postCheckEvaluation.pendingChecks.length > 0) {
        ciOutstandingLines.push(
          `CI still in flight, pending checks: ${postCheckEvaluation.pendingChecks.join(", ")}`,
        );
      }
      const outstandingSection =
        outstandingBody !== null
          ? `\n\n## Outstanding\n\n${outstandingBody}`
          : ciOutstandingLines.length > 0
            ? `\n\n## Outstanding\n\n${ciOutstandingLines.join("\n")}`
            : "";
      const reportSection = report.length > 0 && outstandingBody === null ? `\n\n${report}` : "";
      const learningsFooter = renderReviewLearningsFooter(result.appliedReviewLearnings);
      const humanMessage = `${headline}${outstandingSection}${reportSection}${metaLine}${learningsFooter}`;

      const state = { ...baseState, ci_verified: false };
      await ctx.setState(state, humanMessage);
      log.warn(
        {
          failingChecks: postCheckEvaluation.failingChecks,
          pendingChecks: postCheckEvaluation.pendingChecks,
          outstandingPresent: outstandingBody !== null,
          costUsd: result.costUsd,
        },
        "resolve handler returning incomplete, post-pipeline gate caught surviving failures",
      );
      return { status: "incomplete", reason, state, humanMessage };
    }

    const state = { ...baseState, ci_verified: true };
    const headline =
      failingChecks.length === 0 && topLevelComments.length === 0
        ? `🔎 **Resolve passed**, no failing checks, no open review comments.`
        : `🔎 **Resolve iteration complete**, CI is now green; started with ${String(failingChecks.length)} failing checks and ${String(topLevelComments.length)} open comment threads (some may already be resolved).`;
    const reportSection =
      report.length > 0 ? `\n\n${report}` : `\n\n_(no RESOLVE.md report, agent did not write one)_`;
    const learningsFooter = renderReviewLearningsFooter(result.appliedReviewLearnings);
    const humanMessage = `${headline}${reportSection}${metaLine}${learningsFooter}`;

    await ctx.setState(state, humanMessage);
    log.info(
      {
        failingChecks: failingChecks.length,
        topLevelComments: topLevelComments.length,
        costUsd: result.costUsd,
      },
      "resolve handler succeeded",
    );
    // Mirrors review.ts: forward applied-learning IDs so orchestrator can
    // bump use_count. See workflow-executor.ts for the downstream wire.
    const appliedReviewLearningIds = (result.appliedReviewLearnings ?? []).map((l) => l.id);
    return {
      status: "succeeded",
      state,
      humanMessage,
      ...(appliedReviewLearningIds.length > 0 ? { appliedReviewLearningIds } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err }, "resolve handler caught error");
    return {
      status: "failed",
      reason: `resolve failed: ${message}`,
      humanMessage: "resolve pipeline execution failed, see server logs for details.",
    };
  }
};

function buildResolvePrompt(input: {
  prNumber: number;
  prTitle: string;
  headBranch: string;
  baseBranch: string;
  failingChecks: readonly string[];
  topLevelCommentCount: number;
  staleness: BranchStaleness;
}): string {
  return [
    `You are a PR resolve agent for pull request #${String(input.prNumber)}: ${input.prTitle}`,
    `Head: ${input.headBranch} → Base: ${input.baseBranch}`,
    ``,
    `CI status:`,
    input.failingChecks.length === 0
      ? `  - all checks passing`
      : `  - failing checks: ${input.failingChecks.join(", ")}`,
    `Open comment threads (some may already be resolved): ${String(input.topLevelCommentCount)}`,
    ``,
    formatRefreshDirective(input.staleness),
    ``,
    `## Tools you MUST use`,
    `- \`mcp__github_comment__update_claude_comment\`, refresh the tracking comment at every checkpoint marked **[update tracking comment]** so the user sees live progress.`,
    `- \`Bash\` (\`gh\`, \`git\`), \`gh\` and \`git\` are pre-authenticated as the GitHub App installation in this environment, so \`gh pr view\`, \`gh run view --log-failed\`, \`gh api .../pulls/comments/<id>/replies\`, \`git commit\`, \`git push\` all work without further setup.`,
    `- \`Read\`, \`Edit\`, \`Grep\`, \`Glob\`, for code edits and exploration.`,
    ``,
    `Do the following in order:`,
    `0. **[update tracking comment]** Post: "🔎 Resolve, refreshing branch (if needed)."`,
    `1. **Refresh the branch first if needed** (see "Branch state" above). A senior engineer rebases before triaging anything; resolving feedback against a stale branch is wasted work.`,
    `2. **[update tracking comment]** Post: "🔎 Resolve, diagnosing N failing checks." (replace N; skip this step if N=0)`,
    `3. If failing checks exist, fetch their logs (\`gh run view --log-failed\`) and classify the failure. If it's a test / lint / type / build failure with a clear root cause, attempt a fix, diagnose, edit, commit, push. The total fix attempts across this step and step 6 are capped at FIX_ATTEMPTS_CAP=3 per iteration (cross-run enforcement is a planned follow-up).`,
    `4. **[update tracking comment]** Post: "🔎 Resolve, classifying K open comment threads." (replace K; skip if K=0)`,
    `5. For each open comment thread, classify into one of: Valid | Partially Valid | Invalid | Needs Clarification. The count above is an upper bound, some threads may already be resolved, in which case skip them.`,
    `   - **Valid / Partially Valid:** fix the code, commit, push, then reply via \`gh api repos/OWNER/REPO/pulls/${String(input.prNumber)}/comments/<comment_id>/replies -X POST -f body="..."\`. **After replying, ALSO mark the thread resolved** via the \`resolve-review-thread\` MCP tool (a public-API GraphQL mutation; do not skip this step, leaving threads unresolved blocks merge UX even though the fix is in).`,
    `   - **Invalid:** reply with an evidence-backed explanation; no code change. Do NOT resolve the thread (the reviewer should close it themselves once they accept the rebuttal).`,
    `   - **Needs Clarification:** reply with a specific question to unblock. Do NOT resolve.`,
    ``,
    `   ### Reply body format (MANDATORY, same shape for all four classes)`,
    ``,
    `   Use this exact 3-block layout. The format is required so all bot replies look consistent across resolve, review, fix-thread, and explain-thread:`,
    ``,
    `   \`\`\`markdown`,
    `   <STATUS_LINE>`,
    ``,
    `   **<One-line title summarizing what you did or concluded.>**`,
    ``,
    `   <1–3 sentences of reasoning: WHY the fix was applied, WHY the reviewer was right/wrong, or WHAT specifically you need clarified. Cite file:line where relevant. Do NOT include a diff: the commit link covers that.>`,
    `   \`\`\``,
    ``,
    `   STATUS_LINE per classification (copy verbatim, then optionally append commit metadata):`,
    `   - Valid:               \`_✅ Addressed_, commit \\\`<sha>\\\`\``,
    `   - Partially Valid:     \`_⚠️ Partially addressed_, commit \\\`<sha>\\\`\``,
    `   - Invalid:             \`_❌ Not applicable_\``,
    `   - Needs Clarification: \`_❓ Need clarification_\``,
    ``,
    `6. **Wait for CI to be green before exiting.** After your final commit + push for review-thread fixes, you MUST verify CI returns to all-green before declaring this iteration done. Sequence:`,
    `   - Poll \`gh pr checks ${String(input.prNumber)}\` every ~60s until all checks have a terminal status.`,
    `   - If any check fails: fetch logs (\`gh run view --log-failed\`), attempt one root-cause fix, commit, push, and re-poll. The per-iteration cap is FIX_ATTEMPTS_CAP=3 (across both step 3 and this step combined).`,
    `   - If after 3 fix attempts CI is still failing, STOP. Do NOT mark the run successful. Write the unresolved CI failure into RESOLVE.md "Outstanding" so the maintainer sees it.`,
    `   - "All-green" = no \`failure\` / \`cancelled\` / \`timed_out\` / \`action_required\` conclusions. \`skipped\`, \`neutral\`, and \`success\` are all acceptable terminal states.`,
    `7. If all checks pass AND all comments resolved AND reviewDecision is APPROVED, post a one-line "resolve complete, ready to merge" comment via \`update_claude_comment\`.`,
    `8. NEVER call \`gh pr merge\` or \`octokit.pulls.merge\`. Merging is a human action (FR-017).`,
    `9. NEVER push to the base branch ${input.baseBranch}.`,
    `10. **Before finishing**, write the resolve summary to \`$BOT_ARTIFACT_DIR/RESOLVE.md\` (path is OUTSIDE the cloned repo, never \`git add\` it).`,
    `    Required sections:`,
    `    ## Summary, one paragraph: what state the PR is in now and what's left.`,
    `    ## CI status, list each failing check and what you did about it; include the FINAL post-fix CI state from step 6.`,
    `    ## Review comments, for each comment: classification, action taken, commit/reply link, and whether the thread was resolved.`,
    `    ## Commits pushed, sha · subject.`,
    `    ## Outstanding, what still blocks merge (if anything), including any CI failures that survived the 3-attempt cap.`,
    `    This becomes the final tracking comment body, be specific, cite files and links.`,
    `11. **[update tracking comment]** Final: paste the full RESOLVE.md contents.`,
  ].join("\n");
}
