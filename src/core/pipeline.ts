import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import picomatch from "picomatch";

import { config } from "../config";
import { resolveMcpServers } from "../mcp/registry";
import type { AgentPolicy } from "../shared/ws-messages";
import type { BotContext, EnrichedBotContext, ExecutionResult, FetchedData } from "../types";
import { resolveSelfLogin } from "../utils/bot-identity";
import { retryWithBackoff } from "../utils/retry";
import {
  isSafeGlob,
  pickApplicableLearnings,
  renderReviewLearningsBlock,
} from "../utils/review-learnings-filter";
import { applyAgentPolicy } from "./agent-policy";
import { checkoutRepo } from "./checkout";
import { executeAgent } from "./executor";
import { fetchGitHubData } from "./fetcher";
import { resolveGithubToken } from "./github-token";
import {
  CORE_PIPELINE_LOG_EVENTS,
  createStageTracker,
  logPipelineStage,
  timeStage,
} from "./log-fields";
import { buildPrompt, buildPromptParts, resolveAllowedTools } from "./prompt-builder";
import { createTrackingComment, finalizeTrackingComment } from "./tracking-comment";

type DaemonActionsResult = NonNullable<ExecutionResult["daemonActions"]>;

/** Read .daemon-actions.json written by the repo-memory MCP server during execution. */
function readDaemonActionsFile(
  workDir: string,
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void },
): DaemonActionsResult {
  try {
    const actionsPath = join(workDir, ".daemon-actions.json");
    const exists = existsSync(actionsPath); // eslint-disable-line security/detect-non-literal-fs-filename
    log.info({ actionsPath, exists }, "Checking for daemon actions file");
    if (exists) {
      const raw = JSON.parse(readFileSync(actionsPath, "utf-8")) as Record<string, unknown>[];
      const learnings = raw
        .filter(
          (a): a is { type: "save"; category: string; content: string } =>
            a["type"] === "save" &&
            typeof a["category"] === "string" &&
            typeof a["content"] === "string",
        )
        .map(({ category, content }) => ({ category, content }));
      const deletions = raw
        .filter(
          (a): a is { type: "delete"; id: string } =>
            a["type"] === "delete" && typeof a["id"] === "string",
        )
        .map((a) => a.id);
      const reviewLearningSaves = raw
        .filter((a) => a["type"] === "save_learning" && typeof a["directive"] === "string")
        .map((a) => extractReviewLearningSave(a));
      const reviewLearningDeletes = raw
        .filter(
          (a): a is { type: "delete_learning"; id: string } =>
            a["type"] === "delete_learning" && typeof a["id"] === "string",
        )
        .map((a) => a.id);
      log.info(
        {
          learnings: learnings.length,
          deletions: deletions.length,
          reviewLearningSaves: reviewLearningSaves.length,
          reviewLearningDeletes: reviewLearningDeletes.length,
        },
        "Read daemon actions",
      );
      const result = {
        learnings,
        deletions,
        ...(reviewLearningSaves.length > 0 ? { reviewLearningSaves } : {}),
        ...(reviewLearningDeletes.length > 0 ? { reviewLearningDeletes } : {}),
      };
      return result as DaemonActionsResult;
    }
  } catch (err) {
    log.warn({ err }, "Failed to read daemon actions file");
  }
  return { learnings: [], deletions: [] };
}

/**
 * Narrow a raw `save_learning` action into the orchestrator-facing payload
 * shape. `exactOptionalPropertyTypes` requires omitting keys whose value
 * would be undefined, so build the object key-by-key.
 */
function extractReviewLearningSave(
  a: Record<string, unknown>,
): NonNullable<DaemonActionsResult["reviewLearningSaves"]>[number] {
  const out: NonNullable<DaemonActionsResult["reviewLearningSaves"]>[number] = {
    directive: a["directive"] as string,
  };
  if (typeof a["rationale"] === "string") out.rationale = a["rationale"];
  if (typeof a["fileGlob"] === "string") out.fileGlob = a["fileGlob"];
  if (a["scope"] === "local" || a["scope"] === "global") out.scope = a["scope"];
  if (typeof a["sourcePr"] === "number") out.sourcePr = a["sourcePr"];
  if (typeof a["sourceThread"] === "string") out.sourceThread = a["sourceThread"];
  if (typeof a["sourceAuthor"] === "string") out.sourceAuthor = a["sourceAuthor"];
  return out;
}

/**
 * Read agent-written report files from the sibling artifacts directory
 * (outside the cloned repo checkout) before cleanup runs.
 * Best-effort: missing files are silently dropped from the returned map.
 * Returns undefined when the caller didn't request anything, so the result
 * shape stays clean (no empty `capturedFiles: {}` for default callers).
 */
async function readCapturedFiles(
  artifactsDir: string,
  basenames: readonly string[] | undefined,
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void },
): Promise<Record<string, string> | undefined> {
  if (basenames === undefined || basenames.length === 0) return undefined;
  const { readFile } = await import("node:fs/promises");
  const captured: Record<string, string> = {};
  for (const name of basenames) {
    try {
      const content = await readFile(join(artifactsDir, name), "utf-8");
      if (content.trim().length > 0) captured[name] = content;
    } catch {
      // Missing file is expected when the agent declines to write it.
    }
  }
  log.info({ artifactsDir, captured: Object.keys(captured) }, "Read captured artifact files");
  return Object.keys(captured).length > 0 ? captured : undefined;
}

/**
 * Build the options object passed to `finalizeTrackingComment` on success.
 *
 * `exactOptionalPropertyTypes` forbids assigning `undefined` to optional
 * properties: we must omit them instead. Extracted so the conditional
 * branches don't count against runPipeline's cyclomatic complexity budget.
 */
function buildFinalOpts(
  result: ExecutionResult,
  configWarning: string | undefined,
): {
  success: boolean;
  durationMs?: number;
  costUsd?: number;
  configWarning?: string;
} {
  const opts: {
    success: boolean;
    durationMs?: number;
    costUsd?: number;
    configWarning?: string;
  } = {
    success: result.success,
    // Re-append the invalid-config banner: the agent's update_claude_comment
    // replaces the whole body, so the create-time banner is usually gone.
    ...(configWarning !== undefined ? { configWarning } : {}),
  };
  if (result.durationMs !== undefined) {
    opts.durationMs = result.durationMs;
  }
  if (result.costUsd !== undefined) {
    opts.costUsd = result.costUsd;
  }
  // The raw `result.errorMessage` is intentionally NOT forwarded into the
  // tracking comment: the comment is publicly visible on GitHub and an
  // upstream error string can carry credentials (octokit error stacks
  // include the request URL with the installation token), file paths, or
  // other sensitive context. The error message is still propagated to the
  // caller via the returned `ExecutionResult` for classification. Worker
  // boundaries must redact it before logs, persistence, or transport.
  return opts;
}

/**
 * Optional worker overrides for execution limits and workspace tracking.
 */
export interface RunPipelineOverrides {
  maxTurns?: number;
  allowedTools?: string[];
  /**
   * Fires once the pipeline has cloned the repo and knows the workspace path.
   * Used by a shared daemon to track workDir for cancellation and cleanup.
   */
  onWorkDirReady?: (workDir: string) => void;
  /**
   * Basenames (e.g. "IMPLEMENT.md") for files the agent may have written to
   * the workspace. Read best-effort BEFORE cleanup: content is returned in
   * `ExecutionResult.capturedFiles`. Missing files are not errors. Used so
   * a workflow handler can include a structured agent report in its
   * tracking comment without duplicating the pipeline machinery.
   */
  captureFiles?: string[];
  /**
   * Pre-existing tracking comment id (typically created by a workflow
   * handler via `setState` before invoking the pipeline). When set, the
   * pipeline does NOT call `createTrackingComment`/`finalizeTrackingComment`
   * the orchestrator's tracking-mirror owns the comment lifecycle, and
   * the pipeline only wires the id into the prompt + MCP server so the
   * agent can post mid-run progress via `update_claude_comment`.
   */
  trackingCommentId?: number;
  /**
   * Caller-supplied AbortSignal forwarded to `executeAgent` (and through to
   * the Claude Agent SDK's `query()` via its `abortController` option). When
   * fired, the SDK iterator is torn down, the Claude Code subprocess and MCP
   * servers exit, and the pipeline returns `success: false`. Used by the
   * worker to terminate the agent on a shared-daemon cancel or runner fence.
   */
  signal?: AbortSignal;
  /**
   * Opt-in for the resolve-review-thread MCP server (T029/T030). Set
   * `true` from the `resolve` handler when the PR has open review threads
   * registers the server and adds its tool to the allowed-tools list.
   * Off by default so other workflows don't see the tool.
   */
  enableResolveReviewThread?: boolean;
  /**
   * Opt-in for the read-only `github-state` MCP server (issue #117).
   * Defaults to `true` because the tool surface is additive: the agent
   * can fetch fresh CI rollup, check output, branch protection, PR
   * diff, and paginated comments on demand instead of reasoning from
   * the prompt-stuffed snapshot. Set `false` to suppress (e.g., for a
   * narrowly scoped workflow that should not touch the API).
   */
  enableGithubState?: boolean;
  /**
   * Rendered discussion-digest section (see `src/workflows/discussion-digest.ts`).
   * When a non-empty string, `buildPrompt` replaces the raw issue-comment dump
   * with this distilled, maintainer-authoritative view. Omitted / empty falls
   * back to the legacy raw `formatComments` rendering.
   */
  discussionDigest?: string;
  /**
   * Opt-in for review-learnings prompt injection and MCP tools. Only the
   * `review` and `resolve` handlers set this to `true`. When `false`/omitted,
   * `runPipeline` strips `ctx.reviewLearnings` so the prompt-builder block
   * stays empty and the MCP server receives `REVIEW_LEARNINGS=[]`, even
   * though the orchestrator pre-loads learnings uniformly for every job.
   * The gate lives here (handler-level) so non-review workflows cannot
   * inadvertently suppress findings or persist review-policy directives.
   */
  enableReviewLearnings?: boolean;
  /**
   * When `enableReviewLearnings` is true, the pipeline filters
   * `ctx.reviewLearnings` down to the PR's changed-file matches before
   * forwarding into both the prompt block and the MCP env. That's the right
   * default for review / resolve where the agent only acts on directives
   * applicable to the diff. The `remember` workflow needs the unfiltered
   * universe so its dedup pre-check (`get_review_learnings`) doesn't miss
   * directives sitting outside the current PR's changed files (or every
   * glob-scoped directive on issue-context invocations). Set to `true` to
   * skip the applicability filter; the MCP tool then enumerates the
   * orchestrator's full pre-loaded set.
   */
  unfilteredReviewLearnings?: boolean;
  /**
   * Per-repo agent policy resolved from `.github-app.yaml` ("Gate 2"), shipped
   * on the job payload and already clamped against the server ceilings by
   * `src/repo-config/effective.ts`. Absent for repos with no config file, in
   * which case every knob below keeps its pre-Gate-2 behaviour.
   *
   * `maxTurns` is deliberately not here: it rides the existing top-level
   * `maxTurns` override so the cap keeps one source of truth.
   */
  policy?: AgentPolicy;
}

/**
 * Write orchestrator-provided env vars as `.env` in the agent workspace so the
 * agent subprocess (cwd=workDir) can read them. Values are written verbatim,
 * callers own escaping.
 */
function writeEnvFile(
  workDir: string,
  envVars: Record<string, string> | undefined,
  log: { info: (obj: object, msg: string) => void },
): void {
  if (envVars === undefined || Object.keys(envVars).length === 0) return;
  const envContent = Object.entries(envVars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- workDir is a daemon-owned temp path
  writeFileSync(join(workDir, ".env"), `${envContent}\n`);
  log.info({ keyCount: Object.keys(envVars).length }, "Wrote .env from orchestrator env vars");
}

/**
 * Drop changed files matching any `review.path_filters` glob.
 *
 * Exclusion semantics, matching the schema docs: a file is hidden from the
 * agent when it matches ANY filter. Applied to the fetched data once, so the
 * prompt, the review-learnings applicability filter, and the `🧠 Learnings
 * used` footer all agree on which files this review covers.
 *
 * Only `changedFiles` is filtered. Inline review comments are deliberately
 * left alone: `resolve` answers threads, and hiding a thread would leave the
 * bot unable to reply to a maintainer who asked about a generated file.
 *
 * Callers pass the `isSafeGlob`-accepted list. The filter runs on that same
 * list the prompt's skip instruction is built from, so the file list and the
 * instruction cannot disagree about which globs applied.
 */
function applyPathFilters(
  data: FetchedData,
  pathFilters: readonly string[],
  log: { info: (obj: object, msg: string) => void },
): FetchedData {
  if (pathFilters.length === 0) return data;
  const matchers = pathFilters.map((g) => picomatch(g, { dot: true }));
  const kept = data.changedFiles.filter((f) => !matchers.some((m) => m(f.filename)));
  if (kept.length === data.changedFiles.length) return data;
  log.info(
    {
      event: "repo_config.path_filters_applied",
      filterCount: pathFilters.length,
      excludedCount: data.changedFiles.length - kept.length,
      keptCount: kept.length,
    },
    "Excluded changed files matching review.path_filters",
  );
  return { ...data, changedFiles: kept };
}

/**
 * Claude Agent SDK execution pipeline used by the shared-daemon direct rail
 * and by isolated workflow handlers that need repository execution.
 *
 * Pipeline:
 * 1. Create tracking comment ("Working...")
 * 2. Get installation token
 * 3. Fetch PR/issue data via GraphQL
 * 4. Build prompt with full context
 * 5. Clone repo to temp directory
 * 6. Resolve MCP servers and allowed tools
 * 7. Execute Claude Agent SDK
 * 8. Finalize tracking comment (success/error/cost)
 * 9. Cleanup temp directory
 */
export async function runPipeline(
  ctx: BotContext,
  overrides: RunPipelineOverrides = {},
): Promise<ExecutionResult> {
  let trackingCommentId: number | undefined;
  // When the caller (workflow handler) seeded the tracking comment, the
  // pipeline must NOT finalize it: the handler's terminal `setState` writes
  // the final body via tracking-mirror, and a pipeline finalize would
  // overwrite it with the legacy "completed" template.
  const callerOwnsTrackingComment = overrides.trackingCommentId !== undefined;

  // Stage timing baseline for the pipeline.stage / pipeline.completed events
  // (issue #166); pipeline_wall_clock_ms on the terminal line is measured from
  // here so an operator can see total request cost without a webhook arriving.
  const pipelineStartedAt = Date.now();
  // Cursor of the stage in flight; cleared on each stage's success so the outer
  // catch can attribute which stage threw (issue #226).
  const stageTracker = createStageTracker();

  try {
    ctx.log.info({ event: CORE_PIPELINE_LOG_EVENTS.started }, "Pipeline started");
    overrides.signal?.throwIfAborted();

    if (callerOwnsTrackingComment) {
      trackingCommentId = overrides.trackingCommentId;
      ctx.log.info(
        { trackingCommentId },
        "Using caller-supplied tracking comment (workflow handler owns lifecycle)",
      );
    } else if (ctx.skipTrackingComments === true) {
      ctx.log.info("Skipping tracking comment (skipTrackingComments)");
    } else {
      trackingCommentId = await timeStage(
        ctx.log,
        "trackingComment.create",
        () =>
          retryWithBackoff(() => createTrackingComment(ctx, overrides.policy?.warning), {
            maxAttempts: 3,
            initialDelayMs: 1000,
            log: ctx.log,
            op: "tracking_comment.create",
          }),
        stageTracker,
      );
    }
    const resolvedTrackingCommentId = trackingCommentId;
    overrides.signal?.throwIfAborted();

    const installationToken = await timeStage(
      ctx.log,
      "token.resolve",
      () => resolveGithubToken(ctx.octokit),
      stageTracker,
    );

    // Who our GitHub writes are attributed to, for the inline-comment dedup.
    const selfLogin = await resolveSelfLogin();
    overrides.signal?.throwIfAborted();

    const fetched = await timeStage(
      ctx.log,
      "github.fetch",
      () =>
        retryWithBackoff(() => fetchGitHubData(ctx), {
          maxAttempts: 3,
          initialDelayMs: 2000,
          log: ctx.log,
          op: "github.fetch",
        }),
      stageTracker,
    );
    // One accepted list for both consumers: the changed-file filter and the
    // prompt's skip instruction. A glob `isSafeGlob` rejects filters nothing
    // (config is owner-trusted, and a run showing too many files beats a run
    // that never happens), so it must not reach the prompt either.
    const requestedFilters = overrides.policy?.pathFilters ?? [];
    const acceptedFilters = requestedFilters.filter(isSafeGlob);
    if (acceptedFilters.length < requestedFilters.length) {
      // Count only: a rejected glob is attacker-adjacent repo config and its
      // text buys an operator nothing the count does not.
      ctx.log.warn(
        {
          event: "repo_config.path_filters_rejected",
          rejectedCount: requestedFilters.length - acceptedFilters.length,
        },
        "Ignored review.path_filters globs rejected by the glob-safety guard",
      );
    }
    const data = applyPathFilters(fetched, acceptedFilters, ctx.log);
    overrides.signal?.throwIfAborted();

    const enrichedCtx: EnrichedBotContext = {
      ...ctx,
      headBranch: data.headBranch ?? ctx.headBranch ?? ctx.defaultBranch,
      baseBranch: data.baseBranch ?? ctx.baseBranch ?? ctx.defaultBranch,
      // No review-only gate here, unlike reviewLearnings below. Two upstream
      // layers already own it: the schema only accepts `instructions` under
      // `workflows.review`, and `stripInstructionsUnlessReview` drops it at
      // job accept. reviewLearnings needs its gate here because it is loaded
      // uniformly into every job and has no upstream filter.
      ...(overrides.policy?.instructions !== undefined
        ? { reviewInstructions: overrides.policy.instructions }
        : {}),
      // Dropping the files from `changedFiles` only hides the list. The agent
      // is told to run `git diff`, so the globs have to reach the prompt as an
      // explicit skip instruction or the excluded files come back in full.
      ...(acceptedFilters.length > 0 ? { reviewExcludedPaths: acceptedFilters } : {}),
    };
    // Handler-level gate: review_learnings are owner-loaded into every
    // job's ctx for uniform dispatch, but only the review/resolve handlers
    // are authorised to inject them as repo policy. Strip here for
    // everything else so the prompt block stays empty and the MCP server
    // sees REVIEW_LEARNINGS=[].
    if (overrides.enableReviewLearnings !== true) {
      // `exactOptionalPropertyTypes` forbids assigning undefined; delete to
      // erase the property entirely so downstream `!== undefined` checks
      // remain accurate.
      delete enrichedCtx.reviewLearnings;
    } else if (
      enrichedCtx.reviewLearnings !== undefined &&
      overrides.unfilteredReviewLearnings !== true
    ) {
      // Narrow the orchestrator-loaded universe to directives applicable to
      // this PR's changed files BEFORE downstream consumers see it. Without
      // this, the prompt block (glob-filtered + byte-capped) and the MCP
      // `get_review_learnings` tool (orchestrator-loaded set) disagreed: the
      // prompt's "… N older learnings omitted …" marker promised the tool
      // would return "every active directive (including the omitted ones)"
      // but the tool also returned glob-non-matching rows. Filtering here
      // makes both surfaces enumerate the same applicable universe.
      //
      // The `remember` workflow opts out via `unfilteredReviewLearnings`:
      // its dedup pre-check needs the full set, including directives
      // outside the current PR's changed files.
      enrichedCtx.reviewLearnings = pickApplicableLearnings(
        enrichedCtx.reviewLearnings,
        enrichedCtx.isPR ? data.changedFiles.map((f) => f.filename) : [],
      );
    }

    // Build both prompt shapes: the legacy single-string `prompt` keeps the
    // dry-run length log + executor fallback working byte-identical, and
    // `promptParts` is forwarded when cacheable layout is on so the executor
    // can pivot to systemPrompt.append + excludeDynamicSections (issue #134).
    const promptBuildAt = Date.now();
    stageTracker.active = { stage: "prompt.build", startedAt: promptBuildAt };
    const prompt = buildPrompt(
      enrichedCtx,
      data,
      resolvedTrackingCommentId,
      overrides.discussionDigest,
    );
    const promptParts =
      config.promptCacheLayout === "cacheable"
        ? buildPromptParts(enrichedCtx, data, resolvedTrackingCommentId, overrides.discussionDigest)
        : undefined;
    logPipelineStage(ctx.log, "prompt.build", promptBuildAt);
    stageTracker.active = null;

    if (ctx.dryRun === true) {
      ctx.log.info(
        { promptLength: prompt.length, headBranch: enrichedCtx.headBranch },
        "Dry-run complete, skipping checkout, MCP, and Claude execution",
      );
      return { success: true, durationMs: 0, costUsd: 0, numTurns: 0, dryRun: true };
    }

    overrides.signal?.throwIfAborted();
    const { workDir, cleanup } = await timeStage(
      enrichedCtx.log,
      "repo.clone",
      () => checkoutRepo(enrichedCtx, installationToken, enrichedCtx.baseBranch),
      stageTracker,
    );
    overrides.onWorkDirReady?.(workDir);

    // Sibling scratch dir for agent-authored summary files (IMPLEMENT.md /
    // REVIEW.md / RESOLVE.md). Sibling rather than child so a stray `git add`
    // inside the checkout cannot pick it up. Path is computed *outside* the
    // try block so the finally cleanup can `rm` it unconditionally; mkdirSync
    // runs *inside* the try so `cleanup()` still fires for `workDir` if the
    // mkdir throws (permission denied, disk full, etc.).
    const artifactsDir = `${workDir}-artifacts`;

    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- artifactsDir is a daemon-owned temp path derived from workDir
      mkdirSync(artifactsDir, { recursive: true });
      writeEnvFile(workDir, enrichedCtx.envVars, enrichedCtx.log);

      // Default the github-state MCP server ON for PRs only, most of its
      // tools require a pr_number, and on issue contexts the agent would
      // burn API quota on "PR not found" errors. Issue-side workflows can
      // explicitly opt in via overrides.enableGithubState=true if needed.
      const githubStateEnabled = overrides.enableGithubState ?? enrichedCtx.isPR;

      const mcpServers = resolveMcpServers(
        enrichedCtx,
        resolvedTrackingCommentId,
        installationToken,
        {
          // Resolved here, not inside the registry: the MCP servers authenticate
          // with `installationToken` above, which is the PAT when one is set, so
          // their writes carry the PAT owner's login rather than the App bot's.
          ...(selfLogin !== null ? { selfLogin } : {}),
          workDir,
          ...(enrichedCtx.repoMemory !== undefined ? { repoMemory: enrichedCtx.repoMemory } : {}),
          ...(enrichedCtx.reviewLearnings !== undefined
            ? { reviewLearnings: enrichedCtx.reviewLearnings }
            : {}),
          ...(overrides.enableResolveReviewThread === true
            ? { enableResolveReviewThread: true }
            : {}),
          ...(githubStateEnabled ? { enableGithubState: true } : {}),
        },
      );

      const baseAllowedTools =
        overrides.allowedTools ?? resolveAllowedTools(enrichedCtx, enrichedCtx.daemonCapabilities);
      const withResolveTool =
        overrides.enableResolveReviewThread === true && enrichedCtx.isPR
          ? [...baseAllowedTools, "mcp__resolve_review_thread__resolve_review_thread"]
          : baseAllowedTools;
      const withGithubState = githubStateEnabled
        ? [
            ...withResolveTool,
            "mcp__github_state__get_pr_state_check_rollup",
            "mcp__github_state__get_check_run_output",
            "mcp__github_state__get_workflow_run",
            "mcp__github_state__get_branch_protection",
            "mcp__github_state__get_pr_diff",
            "mcp__github_state__get_pr_files",
            "mcp__github_state__list_pr_comments",
          ]
        : withResolveTool;

      // Shared with `plan` / `triage`, which bypass the pipeline, so they cannot drift.
      const appliedPolicy = applyAgentPolicy({
        baseAllowedTools: withGithubState,
        ...(overrides.policy !== undefined ? { policy: overrides.policy } : {}),
        ...(overrides.maxTurns !== undefined ? { maxTurns: overrides.maxTurns } : {}),
        ...(overrides.signal !== undefined ? { signal: overrides.signal } : {}),
      });

      // `finally`, because a raw setTimeout keeps Bun's event loop alive for
      // the rest of the deadline (AbortSignal.timeout did not).
      let result: ExecutionResult;
      try {
        result = await timeStage(
          enrichedCtx.log,
          "executor.invoke",
          () =>
            executeAgent({
              ctx: enrichedCtx,
              prompt,
              mcpServers,
              workDir,
              artifactsDir,
              installationToken,
              ...appliedPolicy.options,
              ...(promptParts !== undefined ? { promptParts } : {}),
            }),
          stageTracker,
        );
      } finally {
        appliedPolicy.dispose();
      }
      appliedPolicy.options.signal?.throwIfAborted();

      if (resolvedTrackingCommentId !== undefined && !callerOwnsTrackingComment) {
        try {
          const finalOpts = buildFinalOpts(result, overrides.policy?.warning);
          await timeStage(
            enrichedCtx.log,
            "trackingComment.finalize",
            () =>
              retryWithBackoff(
                () => finalizeTrackingComment(enrichedCtx, resolvedTrackingCommentId, finalOpts),
                {
                  maxAttempts: 3,
                  initialDelayMs: 1000,
                  log: enrichedCtx.log,
                  op: "tracking_comment.finalize",
                },
              ),
            stageTracker,
          );
        } catch (finalizeError) {
          // The finalize error is handled here, so no stage is in flight anymore.
          // Clear the tracker so a later throw is not mis-attributed to
          // trackingComment.finalize (timeStage sets active but never clears on throw).
          stageTracker.active = null;
          enrichedCtx.log.error(
            { err: finalizeError },
            "Failed to finalize tracking comment after successful execution",
          );
        }
      }

      enrichedCtx.log.info(
        {
          event: CORE_PIPELINE_LOG_EVENTS.completed,
          success: result.success,
          durationMs: result.durationMs,
          costUsd: result.costUsd,
          numTurns: result.numTurns,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheReadInputTokens: result.cacheReadInputTokens,
          cacheCreationInputTokens: result.cacheCreationInputTokens,
          pipeline_wall_clock_ms: Date.now() - pipelineStartedAt,
        },
        "Request processing completed",
      );

      const daemonActions = readDaemonActionsFile(workDir, enrichedCtx.log);
      const capturedFiles = await readCapturedFiles(
        artifactsDir,
        overrides.captureFiles,
        enrichedCtx.log,
      );

      const hasDaemonActions =
        daemonActions.learnings.length > 0 ||
        daemonActions.deletions.length > 0 ||
        (daemonActions.reviewLearningSaves?.length ?? 0) > 0 ||
        (daemonActions.reviewLearningDeletes?.length ?? 0) > 0;

      // The same filter the prompt-builder ran. Reported back so the
      // workflow handler can render the `🧠 Learnings used` footer over
      // exactly the set the agent saw, without re-running the filter
      // (which would need the PR's changed-file list independently).
      const appliedReviewLearnings =
        enrichedCtx.reviewLearnings !== undefined
          ? pickApplicableLearnings(
              enrichedCtx.reviewLearnings,
              enrichedCtx.isPR ? data.changedFiles.map((f) => f.filename) : [],
            )
          : [];

      // Telemetry for the 1.5.G byte cap. Re-renders against a placeholder
      // tag name to get accurate count/byte stats; the prompt-builder
      // already rendered its own copy with the per-call nonce. The renderer
      // is pure and bounded by LOAD_CAP rows, so the duplicate work is in
      // the microsecond range.
      if (appliedReviewLearnings.length > 0) {
        const renderStats = renderReviewLearningsBlock(
          "review_learnings_telemetry",
          appliedReviewLearnings,
        );
        enrichedCtx.log.info(
          {
            review_learnings_loaded_count: enrichedCtx.reviewLearnings?.length ?? 0,
            review_learnings_applied_count: appliedReviewLearnings.length,
            review_learnings_rendered_count: renderStats.renderedCount,
            review_learnings_omitted_count: renderStats.omittedCount,
            review_learnings_rendered_bytes: renderStats.bytes,
          },
          "Review learnings rendered into prompt",
        );
      }

      return {
        ...result,
        ...(hasDaemonActions ? { daemonActions } : {}),
        ...(capturedFiles !== undefined ? { capturedFiles } : {}),
        ...(appliedReviewLearnings.length > 0 ? { appliedReviewLearnings } : {}),
      };
    } finally {
      try {
        await timeStage(ctx.log, "workspace.cleanup", () => cleanup(), stageTracker);
      } catch (cleanupError) {
        ctx.log.error({ err: cleanupError }, "Failed to cleanup temp directory");
      }
      try {
        await rm(artifactsDir, { recursive: true, force: true });
      } catch (cleanupError) {
        ctx.log.error({ err: cleanupError, artifactsDir }, "Failed to cleanup artifacts directory");
      }
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    // Non-null only if a timed stage was in flight when the throw happened
    // (issue #226); each stage clears it on success.
    const failed = stageTracker.active;
    ctx.log.error(
      {
        event: CORE_PIPELINE_LOG_EVENTS.failed,
        err,
        ...(failed
          ? { failed_stage: failed.stage, failed_stage_delta_ms: Date.now() - failed.startedAt }
          : {}),
        pipeline_wall_clock_ms: Date.now() - pipelineStartedAt,
      },
      "Request processing failed",
    );

    if (
      overrides.signal?.aborted !== true &&
      trackingCommentId !== undefined &&
      !callerOwnsTrackingComment
    ) {
      const commentId = trackingCommentId;
      try {
        await retryWithBackoff(
          () =>
            finalizeTrackingComment(ctx, commentId, {
              success: false,
              // Public-comment safe text. The actual `err.message` flows
              // out via the returned ExecutionResult.errorMessage for
              // operator-side surfaces only.
              error: "An internal error occurred. Check server logs for details.",
              // Mirrors the success path's `buildFinalOpts(result, warning)`:
              // the config banner must survive a failed run too.
              ...(overrides.policy?.warning !== undefined
                ? { configWarning: overrides.policy.warning }
                : {}),
            }),
          {
            maxAttempts: 3,
            initialDelayMs: 1000,
            log: ctx.log,
            op: "tracking_comment.finalize.failure",
          },
        );
      } catch (commentError) {
        ctx.log.error({ err: commentError }, "Failed to update tracking comment with error");
      }
    }

    return { success: false, errorMessage: err.message !== "" ? err.message : err.name };
  }
}
