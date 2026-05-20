import { runPipeline } from "../../core/pipeline";
import type { BotContext } from "../../types";
import { fetchAndBuildDigest, renderDigestSection } from "../discussion-digest";
import type { WorkflowHandler } from "../registry";
import { findById } from "../runs-store";
import { type BranchStaleness, formatRefreshDirective, getBranchStaleness } from "./branch-refresh";
import { renderReviewLearningsFooter } from "./review-learnings-footer";

/**
 * `review` handler: proactive senior-developer code review on an open PR.
 *
 * Distinct from `resolve`:
 *   - `resolve` reacts to existing reviewer feedback + failing CI.
 *   - `review` reads the diff against base, walks the full files in the
 *     cloned repo, and posts inline findings via
 *     `octokit.rest.pulls.createReview` (event: `COMMENT`).
 *
 * The agent is instructed to operate as a senior engineer: read changed
 * files in their entirety (not just hunks), cross-reference with the rest
 * of the codebase, run tests when uncertain, and only post findings it
 * can defend with evidence. Each finding is severity-tagged
 * (`[blocker]` / `[major]` / `[minor]` / `[nit]`) so the PR author can
 * triage at a glance.
 *
 * No-findings case: the handler still posts a top-level review body
 * documenting WHAT was checked and WHY no issues were flagged: silence
 * looks indistinguishable from "didn't actually look," and reviewers earn
 * trust by showing their work.
 *
 * Cost note: full-context review (clone + per-file Read + diff) is more
 * expensive than diff-only. This is intentional: accuracy beats cost,
 * per FR-005(c) (review must be senior-grade) and explicit project
 * direction (2026-04-25).
 */

export const handler: WorkflowHandler = async (ctx) => {
  const { octokit, target, logger: log, deliveryId, runId } = ctx;

  try {
    if (target.type !== "pr") {
      return { status: "failed", reason: "review requires PR target" };
    }

    const { data: pr } = await octokit.rest.pulls.get({
      owner: target.owner,
      repo: target.repo,
      pull_number: target.number,
    });

    if (pr.state !== "open") {
      return {
        status: "failed",
        reason: `PR #${String(target.number)} is ${pr.state}; review requires an open PR`,
      };
    }

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

    // Seed the tracking comment up front so the agent has a comment id to
    // post mid-run progress against. The orchestrator's setState creates
    // the comment on first call and reserves its id in the workflow row;
    // we read that id back and hand it to the pipeline.
    await ctx.setState(
      {
        pr_number: target.number,
        head_sha: pr.head.sha,
        changed_files: pr.changed_files,
        additions: pr.additions,
        deletions: pr.deletions,
      },
      `🔍 **Code review starting**, ${String(pr.changed_files)} files, +${String(pr.additions)}/-${String(pr.deletions)}. Cloning repo and reading changed files…`,
    );
    const seededRow = await findById(runId);
    const trackingCommentId = seededRow?.tracking_comment_id ?? undefined;
    if (trackingCommentId === undefined || trackingCommentId === null) {
      log.warn({ runId }, "review handler: tracking comment id not found after seed setState");
    }

    const triggerBody = buildReviewPrompt({
      prNumber: target.number,
      prTitle: pr.title,
      prBody: pr.body ?? "",
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      changedFiles: pr.changed_files,
      additions: pr.additions,
      deletions: pr.deletions,
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
      // Forward orchestrator pre-loaded learnings so runPipeline's prompt-
      // builder and MCP server see them. Without this, the workflow-dispatch
      // path silently drops the feature even though the direct-pipeline path
      // works. Wire upstream: src/daemon/workflow-executor.ts.
      ...(ctx.reviewLearnings !== undefined ? { reviewLearnings: ctx.reviewLearnings } : {}),
      octokit,
      log,
    };

    const result = await runPipeline(botCtx, {
      captureFiles: ["REVIEW.md"],
      ...(trackingCommentId !== undefined && trackingCommentId !== null
        ? { trackingCommentId }
        : {}),
      ...(digestSection.length > 0 ? { discussionDigest: digestSection } : {}),
      // Review handler is one of only two workflows authorised to consume
      // review_learnings as repo policy (resolve is the other). The orch-
      // estrator pre-loads them onto ctx for every job; this flag is what
      // lets the pipeline forward them into the prompt + MCP server.
      enableReviewLearnings: true,
    });
    if (!result.success) {
      // `reason` is internal (DB state.failedReason → orchestrator quota
      // detection + operator logs); `humanMessage` is the public tracking
      // comment text and MUST NOT carry the raw error (it can include
      // installation tokens, file paths, or other credentials).
      return {
        status: "failed",
        reason: result.errorMessage ?? "review pipeline execution failed",
        humanMessage: "review pipeline execution failed, see server logs for details.",
      };
    }

    const report = result.capturedFiles?.["REVIEW.md"]?.trim() ?? "";
    const findings = countFindings(report);

    const state = {
      pr_number: target.number,
      head_sha: pr.head.sha,
      changed_files: pr.changed_files,
      additions: pr.additions,
      deletions: pr.deletions,
      branch_state: {
        commits_behind_base: staleness.commitsBehindBase,
        commits_ahead_of_base: staleness.commitsAheadOfBase,
        is_fork: staleness.isFork,
      },
      report,
      findings,
      costUsd: result.costUsd ?? 0,
      turns: result.numTurns ?? 0,
    };

    const meta: string[] = [];
    if (result.costUsd !== undefined) meta.push(`cost: $${result.costUsd.toFixed(4)}`);
    if (result.numTurns !== undefined) meta.push(`turns: ${String(result.numTurns)}`);
    if (result.durationMs !== undefined)
      meta.push(`duration: ${String(Math.round(result.durationMs / 1000))}s`);
    const metaLine = meta.length > 0 ? `\n\n_${meta.join(" · ")}_` : "";

    const headline = `🔍 **Code review complete**, ${String(pr.changed_files)} files, +${String(pr.additions)}/-${String(pr.deletions)}.`;
    const reportSection =
      report.length > 0 ? `\n\n${report}` : `\n\n_(no REVIEW.md report, agent did not write one)_`;
    const learningsFooter = renderReviewLearningsFooter(result.appliedReviewLearnings);
    const humanMessage = `${headline}${reportSection}${metaLine}${learningsFooter}`;

    await ctx.setState(state, humanMessage);
    log.info(
      {
        changedFiles: pr.changed_files,
        additions: pr.additions,
        deletions: pr.deletions,
        costUsd: result.costUsd,
      },
      "review handler succeeded",
    );
    // Forward the IDs of learnings actually applied to the prompt so the
    // orchestrator can bump `use_count` + `last_used_at`. Without this,
    // the workflow-dispatch path silently drops the bump even though the
    // direct-pipeline path forwards it via `appliedReviewLearningIds` in
    // job-executor.ts. workflow-executor.ts reads this field off the
    // HandlerResult and writes it into `job:result`.
    const appliedReviewLearningIds = (result.appliedReviewLearnings ?? []).map((l) => l.id);
    return {
      status: "succeeded",
      state,
      humanMessage,
      ...(appliedReviewLearningIds.length > 0 ? { appliedReviewLearningIds } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err }, "review handler caught error");
    return {
      status: "failed",
      reason: `review failed: ${message}`,
      humanMessage: "review pipeline execution failed, see server logs for details.",
    };
  }
};

function buildReviewPrompt(input: {
  prNumber: number;
  prTitle: string;
  prBody: string;
  headBranch: string;
  baseBranch: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  staleness: BranchStaleness;
}): string {
  return [
    `You are a senior software engineer performing a code review on pull request #${String(input.prNumber)}: ${input.prTitle}`,
    `Head: ${input.headBranch} → Base: ${input.baseBranch}`,
    `Diff size: ${String(input.changedFiles)} files, +${String(input.additions)}/-${String(input.deletions)} lines.`,
    ``,
    `## PR description`,
    input.prBody.trim().length > 0 ? input.prBody : "_(empty)_",
    ``,
    formatRefreshDirective(input.staleness),
    ``,
    `## Your task`,
    `Review this PR as a senior engineer would. The cloned repo is your working tree (\`pwd\`). The base branch is \`origin/${input.baseBranch}\`. Both branches are checked out; the working tree is on \`${input.headBranch}\`.`,
    ``,
    `## Tools you MUST use`,
    `- \`mcp__github_inline_comment__create_inline_comment\`, post each finding as an inline comment on the specific file/line. One call per finding. Do NOT batch findings into a single tracking-comment blob.`,
    `- \`mcp__github_comment__update_claude_comment\`, keep the tracking comment refreshed with your current step. Call it at every checkpoint marked **[update tracking comment]** below so the user can see live progress.`,
    `- \`Read\`, \`Grep\`, \`Glob\`, \`Bash\`, for inspecting code, running tests, running typecheck.`,
    ``,
    `**Do NOT** call \`gh api .../reviews -X POST\` to post a multi-comment review. The MCP inline-comment tool handles authentication and posting; the shell \`gh\` path is reserved for read-only queries.`,
    ``,
    `Do the following IN ORDER:`,
    ``,
    `0. **[update tracking comment]** Post: "🔍 Reviewing, refreshing branch (if needed) and surveying diff."`,
    ``,
    `1. **Refresh the branch first if needed** (see "Branch state" above). Reviewing stale code is worse than not reviewing, your findings would be against an old base. After rebase + push, the head SHA changes; re-fetch any cached diff metadata before continuing.`,
    ``,
    `2. **Survey the diff.** \`git diff origin/${input.baseBranch}...HEAD\` to see every change. Note files, scope, and any obvious red flags.`,
    ``,
    `3. **[update tracking comment]** Post: "🔍 Reviewing, reading N changed files in full and cross-referencing." (replace N with the file count)`,
    ``,
    `4. **Read changed files in full.** Do NOT review from hunks alone, open every changed file with \`Read\` and understand the surrounding code. The diff shows what changed; the file shows whether the change is correct in context.`,
    ``,
    `5. **Cross-reference.** For each changed function/type/symbol, search the rest of the repo for callers, tests, and related code. \`Grep\` and \`Glob\` are your tools. A change that compiles can still be wrong because it broke a contract a caller relied on.`,
    ``,
    `6. **[update tracking comment]** Post: "🔍 Reviewing, running validation (typecheck/lint/tests as needed)."`,
    ``,
    `7. **Validate uncertainty.** When you're not sure if a change is correct, run the relevant tests (\`bun test path/to/test\`), the typechecker (\`bun run typecheck\`), or the linter (\`bun run lint\`). Don't guess, run the code.`,
    ``,
    `8. **Look for these classes of issue specifically:**`,
    `   - **Correctness bugs**, off-by-one, null/undefined paths, wrong return types, broken invariants`,
    `   - **Security issues**, injection, unsanitized inputs, missing auth checks, secrets in logs`,
    `   - **Concurrency**, race conditions, missing locks, double-decrements, unhandled promise rejections`,
    `   - **Error handling**, silent failures, swallowed exceptions, fallbacks that mask bugs`,
    `   - **API contracts**, breaking changes to public surfaces without migration, schema drift`,
    `   - **Test coverage gaps**, new logic without tests, edge cases the new tests miss`,
    `   - **Performance**, N+1 queries, accidentally O(n²), unbounded growth`,
    `   - **Readability/maintainability**, only flag if it would genuinely confuse a future reader`,
    ``,
    `   **Before posting any finding**, cross-check it against (a) the \`<review_learnings_...>\` block (already-persisted repo policy, suppress findings it overrides) and (b) the discussion digest's maintainer-authoritative directives. **When a digest directive suppresses a finding you would otherwise have posted AND it is NOT already represented in the review_learnings block**, decide autonomously whether the directive reads as durable repo policy. If yes, call \`mcp__repo_memory__save_review_learning\` to persist it (with concise \`directive\`, the maintainer's \`rationale\`, a tight \`file_glob\` when path-scoped, and \`source_pr\` / \`source_author\` from the digest's source comment). No propose step, no confirmation, you own the call. Skip when the directive is one-off ("for this specific test only") rather than policy.`,
    ``,
    `9. **[update tracking comment]** Post: "🔍 Reviewing, posting K inline findings." (replace K with the finding count, or "no findings" if none)`,
    ``,
    `10. **Post each finding as an inline comment.** For every issue, call \`mcp__github_inline_comment__create_inline_comment\` with:`,
    `    - \`path\`: the file path relative to repo root`,
    `    - \`line\`: the line number on the **right side** of the diff (the new code)`,
    `    - \`body\`: a 3-block layout (see template below)`,
    ``,
    `    ### Inline comment body format (MANDATORY, same shape as resolve, fix-thread, explain-thread)`,
    ``,
    `    \`\`\`markdown`,
    `    <STATUS_LINE>`,
    ``,
    `    **<One-line title summarizing the issue.>**`,
    ``,
    `    <1–3 sentences of reasoning: WHY this matters, WHAT the consequence is, HOW it manifests. Cite file:line. Do NOT paste a diff.>`,
    ``,
    `    **Suggested fix:** <one or two sentences with a concrete, actionable recommendation.>`,
    `    \`\`\``,
    ``,
    `    STATUS_LINE per severity (copy verbatim: these strings drive inline-comment presentation only; REVIEW.md severity counts come from the bracketed \`[blocker]\` / \`[major]\` / \`[minor]\` / \`[nit]\` tags described later):`,
    `    - Blocker: \`_⚠️ Potential issue_ | _🔴 Blocker_\`, must fix before merge (broken correctness, security)`,
    `    - Major:   \`_⚠️ Potential issue_ | _🟠 Major_\`  , should fix before merge (likely bug, missing test)`,
    `    - Minor:   \`_💭 Suggestion_      | _🟡 Minor_\`  , nice to fix (readability, small inefficiency)`,
    `    - Nit:     \`_💭 Suggestion_      | _🔵 Nit_\`    , taste, optional`,
    ``,
    `    Example body:`,
    `    \`\`\`markdown`,
    `    _⚠️ Potential issue_ | _🟠 Major_`,
    ``,
    `    **\`activeCount\` gauge drifts positive on the early-return path.**`,
    ``,
    `    \`src/orchestrator/dispatcher.ts:142\` decrements \`activeCount\` only on the success path; the \`return\` at line 138 skips the decrement, so a load-shedding burst leaves the gauge permanently above the true value and trips the next concurrency cap incorrectly.`,
    ``,
    `    **Suggested fix:** Move the decrement into a \`finally\` block around the entire await region so every exit path decrements exactly once.`,
    `    \`\`\``,
    ``,
    `    One MCP call per finding. If a finding spans multiple lines, post it on the most relevant single line and reference the range in the reasoning paragraph.`,
    ``,
    `    **REVIEW.md severity tags:** in addition to the inline comments, your REVIEW.md \`## Findings\` section MUST list each finding starting with one of \`[blocker]\` / \`[major]\` / \`[minor]\` / \`[nit]\` (these drive the \`countFindings\` parser; the inline comments use the emoji status line, the REVIEW.md aggregate uses the bracketed tag).`,
    ``,
    `11. **No-findings case.** If you genuinely find nothing to flag, do NOT post any inline comments. Instead make the REVIEW.md (step 13) explicit about WHAT you checked and WHY you concluded no issues. A silent "looks good" is unacceptable, show your work in REVIEW.md.`,
    ``,
    `12. **Push policy.** The ONLY acceptable push from this handler is \`git push --force-with-lease\` after a clean rebase onto base in step 1, same diff, fresh head SHA, no new edits. **NEVER create commits with code changes** (no \`git commit\` of edits, code changes belong to \`implement\` and \`resolve\`). **NEVER call \`gh pr merge\`.** **NEVER call \`gh pr review --approve\` / \`--request-changes\`**: those verdicts belong to humans (FR-017).`,
    ``,
    `13. **Write the review summary to \`$BOT_ARTIFACT_DIR/REVIEW.md\`** (this path is OUTSIDE the cloned repo, never \`git add\` it):`,
    `    ## Summary, one paragraph: scope of the review and overall verdict.`,
    `    ## What was checked, files read in full, cross-references performed, tests/lint/typecheck runs.`,
    `    ## Findings, by severity. For each: file:line, issue, recommended fix. Mirrors the inline comments you posted (or "no findings, see Reasoning").`,
    `    ## Reasoning, non-trivial conclusions you reached and why (especially the "no issue here" calls in changed files that COULD have looked sketchy).`,
    `    This becomes the final tracking-comment body, be specific, cite files and lines.`,
    ``,
    `14. **[update tracking comment]** Final: paste the full REVIEW.md contents (or a link/summary if it exceeds GitHub's comment size limit).`,
    ``,
    `Remember: you are a senior engineer. Your goal is to find real bugs, not perform thoroughness theatre. False positives erode trust as much as missed bugs.`,
  ].join("\n");
}

export interface ReviewFindings {
  blocker: number;
  major: number;
  minor: number;
  nit: number;
  total: number;
}

/**
 * Counts severity-tagged findings in a REVIEW.md body. The agent prompt
 * (step 10) requires every finding to start with one of `[blocker]`,
 * `[major]`, `[minor]`, `[nit]`, so the line-anchored regex below matches
 * tags that appear at the start of a line or list item. This deliberately
 * excludes tags that appear inside prose, code fences, or inline-code
 * spans (e.g., a quoted ``[major]`` example in `## Reasoning` would
 * otherwise over-count by one and mis-trip the loop's early-exit
 * decision). `total` excludes `nit` because nits are taste-level and
 * should not block ship.
 */
export function countFindings(report: string): ReviewFindings {
  const counts: Record<"blocker" | "major" | "minor" | "nit", number> = {
    blocker: 0,
    major: 0,
    minor: 0,
    nit: 0,
  };
  const re = /^\s*(?:[*\-+>]\s+)?\[(blocker|major|minor|nit)\]/gim;
  for (const match of report.matchAll(re)) {
    const severity = match[1]?.toLowerCase() as keyof typeof counts | undefined;
    if (severity !== undefined) counts[severity] += 1;
  }
  return {
    ...counts,
    total: counts.blocker + counts.major + counts.minor,
  };
}
