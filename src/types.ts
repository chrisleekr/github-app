import type { Octokit } from "octokit";

import type { Logger } from "./logger";
import type { DaemonCapabilities, SerializableBotContext } from "./shared/daemon-types";
import type { DaemonActions } from "./shared/workflow-types";

/**
 * Unified context for processing a webhook event.
 * Parsed from any supported webhook payload into a common shape.
 */
export interface BotContext {
  /** Repository owner (org or user) */
  owner: string;
  /** Repository name */
  repo: string;
  /** PR or issue number */
  entityNumber: number;
  /** Whether this is a pull request (vs. issue) */
  isPR: boolean;
  /** Webhook event name */
  eventName: "issue_comment" | "pull_request_review_comment";
  /** Username of the person who triggered the bot */
  triggerUsername: string;
  /** ISO timestamp when the trigger comment was created */
  triggerTimestamp: string;
  /** Full body of the triggering comment */
  triggerBody: string;
  /** Comment ID for tracking/reply purposes */
  commentId: number;
  /** Unique webhook delivery ID (for idempotency) */
  deliveryId: string;
  /** PR head branch (only for PRs) */
  headBranch?: string;
  /** PR base branch (only for PRs) */
  baseBranch?: string;
  /** Default branch of the repository */
  defaultBranch: string;
  /** GitHub labels on the parent issue/PR at webhook trigger time */
  labels: string[];
  /** When true, skip creating/updating tracking comments on GitHub (dev testing) */
  skipTrackingComments?: boolean;
  /** When true, skip Claude Agent SDK execution and return a synthetic result (dev testing) */
  dryRun?: boolean;
  /** Pre-loaded repo memory from the controller. */
  repoMemory?: { id: string; category: string; content: string; pinned: boolean }[];
  /**
   * Pre-loaded review learnings from the controller.
   * Populated while preparing a worker payload; only the `review` and
   * `resolve` handlers actually render these into the prompt (gated at the
   * handler / runPipeline-override level). Carries directives extracted from
   * past PR review pushback that can suppress findings in future reviews.
   * See src/orchestrator/review-learnings.ts.
   */
  reviewLearnings?: {
    id: string;
    scope: "local" | "global";
    fileGlob: string | null;
    directive: string;
    rationale: string | null;
    sourcePr: number | null;
    sourceThread: string | null;
    sourceAuthor: string | null;
    createdAt?: string | undefined;
  }[];
  /**
   * Per-repo review instructions from `.github-app.yaml`
   * (`workflows.review.instructions`), threaded in by `runPipeline` from the
   * job payload's `policy`. Owner-trusted config, same tier as review
   * learnings, but still spotlighted so its boundary against adjacent
   * attacker text is unambiguous. Rendered only in the per-call half of the
   * prompt: it varies per repo and would poison the cacheable append.
   */
  reviewInstructions?: string;
  /**
   * Per-repo `review.path_filters` globs from `.github-app.yaml`, threaded in
   * by `runPipeline` from the job payload's `policy`. Filtering
   * `data.changedFiles` only hides the file LIST; the agent has Bash and is
   * told to read the diff, so the globs also have to reach the prompt as an
   * explicit skip instruction. Per-call only, never the cacheable append.
   */
  reviewExcludedPaths?: readonly string[];
  /** Daemon capabilities, set when running in daemon mode to enable capability-based tools */
  daemonCapabilities?: DaemonCapabilities;
  /**
   * Orchestrator-provided env vars (daemon mode only). Written as `.env` in
   * the pipeline's workspace after checkout so the agent subprocess can read
   * them. Kept on the context (rather than as a pipeline override) to mirror
   * the existing `repoMemory` threading.
   */
  envVars?: Record<string, string>;
  /** Authenticated Octokit instance for this installation */
  octokit: Octokit;
  /** Child logger scoped to this request */
  log: Logger;
}

/**
 * Per-model token + cost breakdown, derived from SDKResultMessage.modelUsage
 * (issue #192). One entry per model a single execution touched; useful when a
 * path runs more than one model (e.g. Haiku subagents + an Opus main agent).
 */
export interface ModelUsageEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
}

/**
 * Result from a Claude Agent SDK execution.
 */
export interface ExecutionResult {
  /** Whether the execution completed successfully */
  success: boolean;
  /**
   * Human-readable failure detail when `success` is false. Carries the
   * underlying SDK / pipeline error (e.g. "Claude Code returned an error
   * result: You've hit your limit · resets 6pm (UTC)") so callers can
   * surface actionable text instead of a generic stand-in.
   */
  errorMessage?: string;
  /** Total API cost in USD */
  costUsd?: number;
  /** Total execution duration in milliseconds */
  durationMs?: number;
  /** Number of agent turns used */
  numTurns?: number;
  /** Prompt (input) tokens billed for this execution (SDKResultMessage.usage). */
  inputTokens?: number;
  /** Completion (output) tokens billed for this execution. */
  outputTokens?: number;
  /** Tokens served from the prompt cache (the cache-savings numerator). */
  cacheReadInputTokens?: number;
  /** Tokens written to populate the prompt cache (the 2x-price surcharge). */
  cacheCreationInputTokens?: number;
  /** Per-model token + cost breakdown; logged in full and persisted as JSONB. */
  modelUsage?: readonly ModelUsageEntry[];
  /** When true, indicates this was a dry-run (no Claude execution) */
  dryRun?: boolean;
  /** Repository-memory actions collected from .daemon-actions.json. */
  daemonActions?: DaemonActions;
  /**
   * Contents of files the caller asked the pipeline to capture from the
   * workspace before cleanup. Keyed by basename (e.g. "IMPLEMENT.md").
   * Missing files are simply absent from the map: callers must handle
   * undefined, since an agent may legitimately decline to write a report.
   */
  capturedFiles?: Record<string, string>;
  /**
   * Review learnings actually rendered into the prompt this run (after the
   * file-glob filter against PR changed files). Populated only when the
   * caller passed `enableReviewLearnings: true`. The review/resolve handler
   * reads this to render the `🧠 Learnings used` footer on the tracking
   * comment with the same set the agent saw.
   */
  appliedReviewLearnings?: {
    id: string;
    scope: "local" | "global";
    fileGlob: string | null;
    directive: string;
    rationale: string | null;
    sourcePr: number | null;
    sourceThread: string | null;
    sourceAuthor: string | null;
    /** ISO timestamp of when this directive was first recorded. Rendered in
     * the `🧠 Learnings used` footer so a maintainer can spot stale rules. */
    createdAt?: string | undefined;
  }[];
}

/**
 * Data fetched about a PR or issue from GitHub GraphQL API.
 */
export interface FetchedData {
  /** PR/issue title */
  title: string;
  /** PR/issue body (markdown) */
  body: string;
  /** Current state (OPEN, CLOSED, MERGED) */
  state: string;
  /** Author login */
  author: string;
  /** Comments on the PR/issue (filtered by timestamp) */
  comments: CommentData[];
  /** Review comments (PRs only) */
  reviewComments: ReviewCommentData[];
  /** Changed files (PRs only) */
  changedFiles: ChangedFileData[];
  /** Diff text (PRs only) */
  diff?: string;
  /** Head branch (PRs only) */
  headBranch?: string;
  /** Base branch (PRs only) */
  baseBranch?: string;
  /** Head SHA (PRs only) */
  headSha?: string;
  /**
   * Per-connection truncation flags. A flag is set to `true` when the fetcher
   * stopped paginating because the matching `MAX_FETCHED_*` cap was reached
   * (i.e. the underlying connection has more items than what is in this
   * payload). The prompt builder reads these to warn the agent that its
   * pre-fetched context is incomplete.
   */
  truncated?: {
    comments?: boolean;
    reviewComments?: boolean;
    reviews?: boolean;
    changedFiles?: boolean;
  };
}

export interface CommentData {
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewCommentData {
  author: string;
  body: string;
  path: string;
  line?: number;
  createdAt: string;
}

export interface ChangedFileData {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

/**
 * BotContext enriched with branch data resolved from GraphQL.
 * headBranch and baseBranch are required here (vs optional in BotContext)
 * because they are populated by the fetcher before checkout and execution.
 * Using a distinct type avoids mutating the original context object.
 */
export interface EnrichedBotContext extends BotContext {
  headBranch: string;
  baseBranch: string;
}

/**
 * Result from repository checkout.
 */
export interface CheckoutResult {
  /** Absolute path to the cloned repo */
  workDir: string;
  /** Cleanup function -- call in finally block */
  cleanup: () => Promise<void>;
}

/**
 * MCP server definition for the Agent SDK.
 * Supports stdio (local process) and HTTP (remote) transports.
 */
export type McpServerDef =
  | { type: "stdio"; command: string; args: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

/**
 * Map of MCP server name to its definition.
 */
export type McpServerConfig = Record<string, McpServerDef>;

/**
 * Convert a BotContext into a JSON-serializable form for WebSocket transmission.
 * Strips `octokit` (class instance) and `log` (pino logger with streams).
 * The worker reconstructs these from its repository token and delivery ID.
 */
export function serializeBotContext(ctx: BotContext): SerializableBotContext {
  // Destructure to remove non-serializable fields; spread the rest.

  const { octokit: _octokit, log: _log, ...serializable } = ctx;
  return serializable;
}
