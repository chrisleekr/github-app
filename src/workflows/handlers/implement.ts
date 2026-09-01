import { config } from "../../config";
import { runPipeline } from "../../core/pipeline";
import type { BotContext, ExecutionResult } from "../../types";
import { fetchAndBuildDigest, renderDigestSection } from "../discussion-digest";
import type { WorkflowHandler } from "../registry";
import { StaleWorkflowAttemptError } from "../runs-store";

/**
 * `implement` handler (T022): reuses `src/core/pipeline.ts` end-to-end.
 *
 * Contract:
 *   - Requires a prior succeeded `plan` run for this issue (enforced by
 *     dispatcher via `requiresPrior: 'plan'`; re-checked here defensively).
 *   - Passes the plan markdown as the prompt trigger body so the agent
 *     executes the plan step-by-step.
 *   - NEVER pushes to the base branch: enforced by the agent prompt and
 *     pipeline guardrails (FR-016).
 *   - On success, locates the PR the agent opened and records its number,
 *     URL, and head branch in `state`.
 */
export const handler: WorkflowHandler = async (ctx) => {
  const { octokit, target, logger: log, deliveryId, runId } = ctx;
  let daemonActions: ExecutionResult["daemonActions"];

  try {
    if (target.type !== "issue") {
      return { status: "failed", reason: "implement requires issue target" };
    }

    // The controller loads the most recent succeeded plan before it gives the
    // runner a payload. A later failed plan cannot shadow this snapshot.
    const planState = ctx.priorPlanState;
    if (planState === undefined) {
      return { status: "failed", reason: "no succeeded plan row found for target" };
    }
    const planMarkdown = planState.plan;

    const { data: issue } = await octokit.rest.issues.get({
      owner: target.owner,
      repo: target.repo,
      issue_number: target.number,
    });

    // Build the discussion digest BEFORE postStartingComment: the starting
    // setState triggers the re-run cleanup that deletes a prior tracking
    // comment, and the digest must read that comment while it still exists.
    const digestSection = renderDigestSection(
      await fetchAndBuildDigest({
        octokit,
        owner: target.owner,
        repo: target.repo,
        number: target.number,
        title: issue.title,
        body: issue.body ?? "",
        workflowName: ctx.workflowName,
        includeReviewComments: false,
        log,
      }),
    );

    await postStartingComment(ctx, {
      title: issue.title,
      number: target.number,
      author: issue.user?.login ?? null,
    });

    const { data: repoData } = await octokit.rest.repos.get({
      owner: target.owner,
      repo: target.repo,
    });
    const defaultBranch = repoData.default_branch;

    const since = new Date();

    const triggerBody = [
      `Execute the following plan for issue #${String(target.number)}: ${issue.title}`,
      ``,
      `Requirements:`,
      `- Create a new feature branch. NEVER push to ${defaultBranch}.`,
      `- Implement the tasks in order.`,
      `- Commit with conventional-commit messages.`,
      `- Open a pull request targeting ${defaultBranch} using the bot PR template:`,
      `  1. Read \`.github/PULL_REQUEST_TEMPLATE/bot-implement.md\` from the cloned repo.`,
      `  2. Fill in every section based on your actual work, Summary, Changes,`,
      `     Files changed (path · one-line rationale), Commits (sha · subject),`,
      `     Tests run (command · result), Verification, and \`Closes #${String(target.number)}\`.`,
      `     Include a Mermaid diagram in the Diagram section whenever behaviour or flow changes`,
      `     (new code paths, new state, new external calls, new error handling, sequence shifts).`,
      `     Only omit the Diagram section for pure refactors, typo fixes, or test-only changes.`,
      `     Mermaid must follow the GitHub-compat rules listed in the template comment.`,
      `  3. Write the filled template to a temp file (e.g. \`/tmp/pr-body.md\`) and pass it via`,
      `     \`gh pr create --body-file /tmp/pr-body.md\`. Do NOT let \`gh\` auto-pick the`,
      `     human PR template, pass \`--body-file\` explicitly so the bot template wins.`,
      `- Before finishing, write the run summary to \`$BOT_ARTIFACT_DIR/IMPLEMENT.md\`.`,
      `  IMPORTANT: \`$BOT_ARTIFACT_DIR\` is OUTSIDE the cloned repo, never \`git add\` or commit this file.`,
      `  Required sections: ## Summary, ## Files changed (path · one-line rationale),`,
      `  ## Commits (sha · subject), ## Tests run (command · result), ## Verification.`,
      `  This becomes the tracking comment body, be specific, cite files.`,
      ``,
      `--- Plan ---`,
      planMarkdown,
      `--- End plan ---`,
    ].join("\n");

    const botCtx: BotContext = {
      owner: target.owner,
      repo: target.repo,
      entityNumber: target.number,
      isPR: false,
      eventName: "issue_comment",
      triggerUsername: "chrisleekr-bot[bot]",
      triggerTimestamp: since.toISOString(),
      triggerBody,
      commentId: 0,
      deliveryId: deliveryId ?? runId,
      defaultBranch,
      labels: [],
      skipTrackingComments: true,
      ...(ctx.repoMemory !== undefined ? { repoMemory: ctx.repoMemory } : {}),
      octokit,
      log,
    };

    const result = await runPipeline(botCtx, {
      captureFiles: ["IMPLEMENT.md"],
      ...(ctx.policy !== undefined ? { policy: ctx.policy } : {}),
      ...(ctx.maxTurns !== undefined ? { maxTurns: ctx.maxTurns } : {}),
      ...(digestSection.length > 0 ? { discussionDigest: digestSection } : {}),
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    daemonActions = result.daemonActions;
    if (!result.success) {
      // `reason` is internal (DB state.failedReason → orchestrator quota
      // detection + operator logs); `humanMessage` is the public tracking
      // comment text and MUST NOT carry the raw error.
      return {
        status: "failed",
        reason: result.errorMessage ?? "implement pipeline execution failed",
        humanMessage: "implement pipeline execution failed, see server logs for details.",
        ...(daemonActions !== undefined ? { daemonActions } : {}),
      };
    }

    const expectedLogin = await resolveExpectedAuthorLogin(octokit);
    const opened = await findRecentOpenedPr(
      octokit,
      target.owner,
      target.repo,
      since,
      expectedLogin,
    );
    if (opened === null) {
      return {
        status: "failed",
        reason: "implement completed but no PR was found",
        ...(daemonActions !== undefined ? { daemonActions } : {}),
      };
    }

    const report = result.capturedFiles?.["IMPLEMENT.md"]?.trim() ?? "";

    const state = {
      pr_number: opened.number,
      pr_url: opened.url,
      branch: opened.branch,
      report,
      costUsd: result.costUsd ?? 0,
      turns: result.numTurns ?? 0,
    };

    const meta: string[] = [];
    if (result.costUsd !== undefined) meta.push(`cost: $${result.costUsd.toFixed(4)}`);
    if (result.numTurns !== undefined) meta.push(`turns: ${String(result.numTurns)}`);
    if (result.durationMs !== undefined)
      meta.push(`duration: ${String(Math.round(result.durationMs / 1000))}s`);
    const metaLine = meta.length > 0 ? `\n\n_${meta.join(" · ")}_` : "";
    const reportSection =
      report.length > 0
        ? `\n\n${report}`
        : `\n\n_(no IMPLEMENT.md report, agent did not write one)_`;
    const humanMessage = `🛠️ **Implement complete**, opened PR [#${String(opened.number)}](${opened.url}) on branch \`${opened.branch}\`.${reportSection}${metaLine}`;

    log.info(
      { prNumber: opened.number, branch: opened.branch, costUsd: result.costUsd },
      "implement handler succeeded",
    );
    return {
      status: "succeeded",
      state,
      humanMessage,
      ...(daemonActions !== undefined ? { daemonActions } : {}),
    };
  } catch (err) {
    if (err instanceof StaleWorkflowAttemptError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err }, "implement handler caught error");
    return {
      status: "failed",
      reason: `implement failed: ${message}`,
      humanMessage: "implement pipeline execution failed, see server logs for details.",
      ...(daemonActions !== undefined ? { daemonActions } : {}),
    };
  }
};

interface OpenedPr {
  number: number;
  url: string;
  branch: string;
}

/**
 * Locate the PR the agent opened during this pipeline run. Filters on:
 *  - Authorship match keyed off the active GitHub credential:
 *      * App installation token (default): `pr.user.type === "Bot"`. Any
 *        non-bot PR is human work we mustn't claim. We deliberately do NOT
 *        hard-code a slug (e.g. `chrisleekr-bot[bot]`) because dev and prod
 *        installations publish as different slugs (`chrisleekr-bot-dev[bot]`
 *        vs `chrisleekr-bot[bot]`).
 *      * `GITHUB_PERSONAL_ACCESS_TOKEN` mode: `pr.user.login === <PAT owner>`.
 *        A PAT authors PRs as a real user (`type === "User"`), so the bot-type
 *        filter would reject the PR the agent just opened. The expected login
 *        is resolved at runtime via `/user`. If `/user` fails, the handler
 *        fails closed (the outer `catch` reports `failed`): falling back to
 *        the bot-type filter would unsafely match an unrelated bot PR
 *        (Dependabot/Renovate) opened in the same time window.
 *  - `created_at >= since - 5s`: the run's start. The 5s slop absorbs
 *    clock skew between the daemon's `Date.now()` and GitHub's server.
 *
 * `per_page` is bumped to 30 so a burst of unrelated PRs inside the time
 * window doesn't push ours past the page boundary.
 */
async function findRecentOpenedPr(
  octokit: Parameters<WorkflowHandler>[0]["octokit"],
  owner: string,
  repo: string,
  since: Date,
  expectedLogin: string | null,
): Promise<OpenedPr | null> {
  const { data: prs } = await octokit.rest.pulls.list({
    owner,
    repo,
    state: "open",
    sort: "created",
    direction: "desc",
    per_page: 30,
  });
  for (const pr of prs) {
    if (expectedLogin === null) {
      if (pr.user?.type !== "Bot") continue;
    } else if (pr.user?.login !== expectedLogin) {
      continue;
    }
    const created = new Date(pr.created_at).getTime();
    if (created >= since.getTime() - 5_000) {
      return { number: pr.number, url: pr.html_url, branch: pr.head.ref };
    }
  }
  return null;
}

/**
 * Resolve the GitHub login that owns the active credential, but only when the
 * bot is running with `GITHUB_PERSONAL_ACCESS_TOKEN`. App installation tokens
 * cannot call `/user` (it requires user-to-server auth and returns 403), so
 * App mode short-circuits with `null` and the caller uses the bot-type filter.
 *
 * In PAT mode we fail closed: if `/user` errors, this throws and the outer
 * handler `try/catch` reports the run as `failed`. We deliberately do NOT
 * fall back to the bot-type filter: that filter is unsafe in PAT mode
 * because an unrelated bot PR opened during the same time window
 * (Dependabot, Renovate, …) would be incorrectly claimed as ours.
 */
async function resolveExpectedAuthorLogin(
  octokit: Parameters<WorkflowHandler>[0]["octokit"],
): Promise<string | null> {
  if (config.githubPersonalAccessToken === undefined) return null;
  const { data } = await octokit.rest.users.getAuthenticated();
  return data.login;
}

/**
 * Up-front tracking comment so the user sees implement has started before the
 * (5–15 minute) agent run finishes and opens a PR. Best-effort: if the write
 * fails, the handler still proceeds and the terminal setState writes the PR
 * link + IMPLEMENT.md report.
 */
async function postStartingComment(
  ctx: Parameters<WorkflowHandler>[0],
  input: { title: string; number: number; author: string | null },
): Promise<void> {
  const author = input.author === null ? "" : ` (opened by @${input.author})`;
  const body = [
    `🛠️ **Implement starting**, executing plan for issue #${String(input.number)}${author}`,
    ``,
    `> ${input.title}`,
    ``,
    `Cloning the repo, creating a feature branch, and asking the agent to implement`,
    `the plan and open a PR. This typically takes 5–15 minutes. The PR link and`,
    `IMPLEMENT.md summary replace this comment when the agent finishes.`,
  ].join("\n");
  try {
    await ctx.setState({ phase: "starting" }, body);
  } catch (err) {
    if (err instanceof StaleWorkflowAttemptError) throw err;
    ctx.logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "implement starting-comment write failed, continuing without up-front comment",
    );
  }
}
