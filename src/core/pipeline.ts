import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { config } from "../config";
import { resolveMcpServers } from "../mcp/registry";
import type { BotContext, EnrichedBotContext, ExecutionResult } from "../types";
import { retryWithBackoff } from "../utils/retry";
import {
  pickApplicableLearnings,
  renderReviewLearningsBlock,
} from "../utils/review-learnings-filter";
import { checkoutRepo } from "./checkout";
import { executeAgent } from "./executor";
import { fetchGitHubData } from "./fetcher";
import { resolveGithubToken } from "./github-token";
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
      const result: DaemonActionsResult = { learnings, deletions };
      if (reviewLearningSaves.length > 0) result.reviewLearningSaves = reviewLearningSaves;
      if (reviewLearningDeletes.length > 0) result.reviewLearningDeletes = reviewLearningDeletes;
      return result;
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
function buildFinalOpts(result: ExecutionResult): {
  success: boolean;
  durationMs?: number;
  costUsd?: number;
} {
  const opts: { success: boolean; durationMs?: number; costUsd?: number } = {
    success: result.success,
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
  // caller via the returned `ExecutionResult` for operator-side surfaces
  // (logs, DB `state.failedReason`, orchestrator quota-retry detection).
  return opts;
}

/**
 * Optional overrides for the daemon (via `job:payload`) to honor
 * orchestrator-provided execution limits and to track the workspace path.
 */
export interface RunPipelineOverrides {
  maxTurns?: number;
  allowedTools?: string[];
  /**
   * Fires once the pipeline has cloned the repo and knows the workspace path.
   * Used by the daemon to track workDir for cancellation and SIGKILL cleanup.
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
   * daemon to make `handleJobCancel` actually terminate the agent.
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
 * Claude Agent SDK execution pipeline. Every dispatched job runs through this
 * function: currently only invoked by the daemon job-executor.
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

  try {
    if (callerOwnsTrackingComment) {
      trackingCommentId = overrides.trackingCommentId;
      ctx.log.info(
        { trackingCommentId },
        "Using caller-supplied tracking comment (workflow handler owns lifecycle)",
      );
    } else if (ctx.skipTrackingComments === true) {
      ctx.log.info("Skipping tracking comment (skipTrackingComments)");
    } else {
      trackingCommentId = await retryWithBackoff(() => createTrackingComment(ctx), {
        maxAttempts: 3,
        initialDelayMs: 1000,
        log: ctx.log,
      });
    }
    const resolvedTrackingCommentId = trackingCommentId;

    const installationToken = await resolveGithubToken(ctx.octokit);

    const data = await retryWithBackoff(() => fetchGitHubData(ctx), {
      maxAttempts: 3,
      initialDelayMs: 2000,
      log: ctx.log,
    });

    const enrichedCtx: EnrichedBotContext = {
      ...ctx,
      headBranch: data.headBranch ?? ctx.headBranch ?? ctx.defaultBranch,
      baseBranch: data.baseBranch ?? ctx.baseBranch ?? ctx.defaultBranch,
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
    } else if (enrichedCtx.reviewLearnings !== undefined) {
      // Narrow the orchestrator-loaded universe to directives applicable to
      // this PR's changed files BEFORE downstream consumers see it. Without
      // this, the prompt block (glob-filtered + byte-capped) and the MCP
      // `get_review_learnings` tool (orchestrator-loaded set) disagreed: the
      // prompt's "… N older learnings omitted …" marker promised the tool
      // would return "every active directive (including the omitted ones)"
      // but the tool also returned glob-non-matching rows. Filtering here
      // makes both surfaces enumerate the same applicable universe.
      enrichedCtx.reviewLearnings = pickApplicableLearnings(
        enrichedCtx.reviewLearnings,
        enrichedCtx.isPR ? data.changedFiles.map((f) => f.filename) : [],
      );
    }

    // Build both prompt shapes: the legacy single-string `prompt` keeps the
    // dry-run length log + executor fallback working byte-identical, and
    // `promptParts` is forwarded when cacheable layout is on so the executor
    // can pivot to systemPrompt.append + excludeDynamicSections (issue #134).
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

    if (ctx.dryRun === true) {
      ctx.log.info(
        { promptLength: prompt.length, headBranch: enrichedCtx.headBranch },
        "Dry-run complete, skipping checkout, MCP, and Claude execution",
      );
      return { success: true, durationMs: 0, costUsd: 0, numTurns: 0, dryRun: true };
    }

    const { workDir, cleanup } = await checkoutRepo(
      enrichedCtx,
      installationToken,
      enrichedCtx.baseBranch,
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
      const allowedTools = githubStateEnabled
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

      const result = await executeAgent({
        ctx: enrichedCtx,
        prompt,
        mcpServers,
        workDir,
        artifactsDir,
        allowedTools,
        installationToken,
        ...(overrides.maxTurns !== undefined ? { maxTurns: overrides.maxTurns } : {}),
        ...(overrides.signal !== undefined ? { signal: overrides.signal } : {}),
        ...(promptParts !== undefined ? { promptParts } : {}),
      });

      if (resolvedTrackingCommentId !== undefined && !callerOwnsTrackingComment) {
        try {
          const finalOpts = buildFinalOpts(result);
          await retryWithBackoff(
            () => finalizeTrackingComment(enrichedCtx, resolvedTrackingCommentId, finalOpts),
            {
              maxAttempts: 3,
              initialDelayMs: 1000,
              log: enrichedCtx.log,
            },
          );
        } catch (finalizeError) {
          enrichedCtx.log.error(
            { err: finalizeError },
            "Failed to finalize tracking comment after successful execution",
          );
        }
      }

      enrichedCtx.log.info(
        {
          success: result.success,
          durationMs: result.durationMs,
          costUsd: result.costUsd,
          numTurns: result.numTurns,
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
        await cleanup();
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
    ctx.log.error({ err }, "Request processing failed");

    if (trackingCommentId !== undefined && !callerOwnsTrackingComment) {
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
            }),
          {
            maxAttempts: 3,
            initialDelayMs: 1000,
            log: ctx.log,
          },
        );
      } catch (commentError) {
        ctx.log.error({ err: commentError }, "Failed to update tracking comment with error");
      }
    }

    return { success: false, errorMessage: err.message !== "" ? err.message : err.name };
  }
}
