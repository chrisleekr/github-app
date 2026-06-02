/**
 * Read-only GitHub state fetchers shared between the github-state MCP
 * subprocess server (Agent SDK callers) and the single-turn `runWithTools`
 * loop (chat-thread, triage). One source of truth for the tool surface
 * adding a new GitHub-state tool means editing one file, and every
 * consumer inherits.
 *
 * Each fetcher returns a JSON-serialised string suitable for an MCP
 * `text` content block or an `LLMToolResult.content` field. Truncation
 * is applied per-tool to bound the conversation budget.
 */

import type { Octokit } from "octokit";

import type { LLMTool, LLMToolCall, LLMToolResult } from "../ai/llm-client";
import type { Logger } from "../logger";
import { retryWithBackoff } from "../utils/retry";
import { PROBE_QUERY } from "./queries";

export interface GithubStateDeps {
  readonly octokit: Octokit;
  readonly owner: string;
  readonly repo: string;
  /**
   * Optional delivery-scoped logger. When provided it is passed to
   * retryWithBackoff so transient-failure retry warnings carry the
   * deliveryId binding; when omitted the retry helper logs via its
   * config-free default. `import type` keeps this module config-free for
   * the github-state MCP subprocess. See issue #199.
   */
  readonly log?: Logger;
}

const MAX_TEXT_BYTES = 60_000;
const MAX_DIFF_BYTES = 50_000;
const MAX_CHECK_OUTPUT_BYTES = 30_000;

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

// Serialise a value to JSON. If the serialised payload exceeds `max`,
// REPLACE it with a small valid-JSON envelope describing the overflow.
// The previous behaviour of slicing and appending a non-JSON suffix
// produced invalid JSON that callers running JSON.parse could not read.
// Per-tool truncation of large inner fields (diff text, check run output)
// happens before serialisation, so this envelope is a defence-in-depth fallback.
function serialize(value: unknown, max = MAX_TEXT_BYTES): string {
  const raw = JSON.stringify(value);
  if (raw.length <= max) return raw;
  return JSON.stringify({
    truncated: true,
    reason: "serialised payload exceeded the per-tool byte cap",
    original_byte_length: raw.length,
    cap_bytes: max,
  });
}

interface CheckRollupRow {
  readonly type: "check_run" | "status";
  readonly name: string;
  readonly state: string;
  readonly conclusion?: string;
  readonly is_required: boolean;
  readonly database_id?: number;
  readonly completed_at?: string;
}

interface ProbeQueryShape {
  readonly repository: {
    readonly pullRequest: {
      readonly number: number;
      readonly isDraft: boolean;
      readonly state: string;
      readonly merged: boolean;
      readonly mergeable: string;
      readonly mergeStateStatus: string;
      readonly reviewDecision: string | null;
      readonly baseRefName: string;
      readonly headRefName: string;
      readonly headRefOid: string;
      readonly commits: {
        readonly nodes: readonly {
          readonly commit: {
            readonly oid: string;
            readonly statusCheckRollup: {
              readonly state: string;
              readonly contexts: {
                readonly nodes: readonly {
                  readonly __typename: string;
                  readonly name?: string;
                  readonly databaseId?: number;
                  readonly conclusion?: string | null;
                  readonly status?: string;
                  readonly completedAt?: string | null;
                  readonly context?: string;
                  readonly state?: string;
                  readonly isRequired?: boolean;
                }[];
              };
            } | null;
          };
        }[];
      };
    } | null;
  } | null;
}

export async function getPrStateCheckRollup(
  deps: GithubStateDeps,
  prNumber: number,
): Promise<string> {
  const data = await retryWithBackoff(
    () =>
      deps.octokit.graphql<ProbeQueryShape>(PROBE_QUERY, {
        owner: deps.owner,
        repo: deps.repo,
        number: prNumber,
      }),
    { log: deps.log },
  );
  const pr = data.repository?.pullRequest;
  if (pr === null || pr === undefined) {
    return serialize({ error: `PR #${prNumber} not found` });
  }
  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup ?? null;
  const rows: CheckRollupRow[] =
    rollup === null
      ? []
      : rollup.contexts.nodes.map((node): CheckRollupRow => {
          if (node.__typename === "CheckRun") {
            return {
              type: "check_run",
              name: node.name ?? "(unnamed)",
              state: node.status ?? "unknown",
              is_required: node.isRequired ?? false,
              ...(node.conclusion !== null && node.conclusion !== undefined
                ? { conclusion: node.conclusion }
                : {}),
              ...(node.databaseId !== undefined ? { database_id: node.databaseId } : {}),
              ...(node.completedAt !== null && node.completedAt !== undefined
                ? { completed_at: node.completedAt }
                : {}),
            };
          }
          return {
            type: "status",
            name: node.context ?? "(unnamed)",
            state: node.state ?? "unknown",
            is_required: node.isRequired ?? false,
          };
        });
  // Surface failing+required first so a model that truncates can still answer the common question.
  rows.sort((a, b) => {
    const aFailed = a.conclusion === "FAILURE" || a.state === "FAILURE" ? 1 : 0;
    const bFailed = b.conclusion === "FAILURE" || b.state === "FAILURE" ? 1 : 0;
    if (aFailed !== bFailed) return bFailed - aFailed;
    const aReq = a.is_required ? 1 : 0;
    const bReq = b.is_required ? 1 : 0;
    return bReq - aReq;
  });
  return serialize({
    pr_number: pr.number,
    state: pr.state,
    is_draft: pr.isDraft,
    merged: pr.merged,
    mergeable: pr.mergeable,
    merge_state_status: pr.mergeStateStatus,
    review_decision: pr.reviewDecision,
    base_ref: pr.baseRefName,
    head_ref: pr.headRefName,
    head_oid: pr.headRefOid,
    rollup_state: rollup?.state ?? null,
    checks: rows,
  });
}

export async function getCheckRunOutput(
  deps: GithubStateDeps,
  checkRunId: number,
): Promise<string> {
  const result = await retryWithBackoff(
    () =>
      deps.octokit.rest.checks.get({
        owner: deps.owner,
        repo: deps.repo,
        check_run_id: checkRunId,
      }),
    { log: deps.log },
  );
  const text = result.data.output.text ?? "";
  const truncated = truncate(text, MAX_CHECK_OUTPUT_BYTES);
  return serialize({
    id: result.data.id,
    name: result.data.name,
    status: result.data.status,
    conclusion: result.data.conclusion,
    html_url: result.data.html_url,
    started_at: result.data.started_at,
    completed_at: result.data.completed_at,
    output: {
      title: result.data.output.title,
      summary: result.data.output.summary,
      text: truncated.text,
      text_truncated: truncated.truncated,
    },
  });
}

export async function getWorkflowRun(deps: GithubStateDeps, runId: number): Promise<string> {
  const result = await retryWithBackoff(
    () =>
      deps.octokit.rest.actions.getWorkflowRun({
        owner: deps.owner,
        repo: deps.repo,
        run_id: runId,
      }),
    { log: deps.log },
  );
  return serialize({
    id: result.data.id,
    name: result.data.name,
    status: result.data.status,
    conclusion: result.data.conclusion,
    html_url: result.data.html_url,
    logs_url: result.data.logs_url,
    run_attempt: result.data.run_attempt,
    run_started_at: result.data.run_started_at,
    updated_at: result.data.updated_at,
    head_sha: result.data.head_sha,
    head_branch: result.data.head_branch,
    event: result.data.event,
  });
}

export async function getBranchProtection(deps: GithubStateDeps, branch: string): Promise<string> {
  // A 404 means the branch is unprotected, an expected outcome, not a failure.
  // Convert it to a `null` sentinel INSIDE the retried operation so the retry
  // helper never sees it as an error: no spurious "non-retriable" warn log and
  // no wasted attempt. Octokit RequestError carries `status` directly; that's
  // more reliable than matching the message string (which varies by SDK version
  // and locale). Genuine transient failures still propagate and retry.
  const result = await retryWithBackoff(
    async () => {
      try {
        return await deps.octokit.rest.repos.getBranchProtection({
          owner: deps.owner,
          repo: deps.repo,
          branch,
        });
      } catch (err) {
        if (
          err !== null &&
          typeof err === "object" &&
          "status" in err &&
          (err as { status: unknown }).status === 404
        ) {
          return null;
        }
        throw err;
      }
    },
    { log: deps.log },
  );
  if (result === null) {
    return serialize({ branch, protected: false });
  }
  return serialize({
    branch,
    protected: true,
    required_status_checks: result.data.required_status_checks ?? null,
    required_pull_request_reviews: result.data.required_pull_request_reviews ?? null,
    enforce_admins: result.data.enforce_admins?.enabled ?? false,
    restrictions: result.data.restrictions ?? null,
  });
}

export async function getPrDiff(deps: GithubStateDeps, prNumber: number): Promise<string> {
  const result = await retryWithBackoff(
    () =>
      deps.octokit.rest.pulls.get({
        owner: deps.owner,
        repo: deps.repo,
        pull_number: prNumber,
        mediaType: { format: "diff" },
      }),
    { log: deps.log },
  );
  const diff = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
  const { text, truncated } = truncate(diff, MAX_DIFF_BYTES);
  return serialize(
    {
      pr_number: prNumber,
      diff: text,
      truncated,
      original_byte_length: diff.length,
    },
    MAX_DIFF_BYTES + 4_000,
  );
}

export async function getPrFiles(deps: GithubStateDeps, prNumber: number): Promise<string> {
  const result = await retryWithBackoff(
    () =>
      deps.octokit.rest.pulls.listFiles({
        owner: deps.owner,
        repo: deps.repo,
        pull_number: prNumber,
        per_page: 100,
      }),
    { log: deps.log },
  );
  return serialize({
    pr_number: prNumber,
    file_count: result.data.length,
    page_size_capped_at: 100,
    files: result.data.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      ...(f.previous_filename !== undefined ? { previous_filename: f.previous_filename } : {}),
    })),
  });
}

export async function listPrComments(
  deps: GithubStateDeps,
  prNumber: number,
  page = 1,
): Promise<string> {
  const result = await retryWithBackoff(
    () =>
      deps.octokit.rest.issues.listComments({
        owner: deps.owner,
        repo: deps.repo,
        issue_number: prNumber,
        per_page: 30,
        page,
      }),
    { log: deps.log },
  );
  const comments = result.data.map((c) => ({
    id: c.id,
    author: c.user?.login ?? "(unknown)",
    created_at: c.created_at,
    updated_at: c.updated_at,
    body: truncate(c.body ?? "", 4_000).text,
    html_url: c.html_url,
  }));
  const linkHeader = result.headers.link ?? "";
  const hasNext = linkHeader.includes('rel="next"');
  return serialize({
    pr_number: prNumber,
    page,
    comments,
    next_page: hasNext ? page + 1 : null,
  });
}

/**
 * Tool descriptors for the Anthropic tools API. Mirrors the MCP server's
 * advertised surface 1:1 so the LLM sees the same tools regardless of
 * which dispatch path (MCP subprocess vs. inline runWithTools) the caller
 * is using.
 */
export const GITHUB_STATE_TOOLS: readonly LLMTool[] = [
  {
    name: "get_pr_state_check_rollup",
    description:
      "Fetch the head-commit CI rollup (state + per-check rows + is_required) for a PR in the current repo. Use this when answering questions about CI status, why a PR isn't merging, or which checks failed. Returns one JSON object, call once and reason from the result.",
    input_schema: {
      type: "object",
      properties: {
        pr_number: { type: "integer", minimum: 1, description: "The pull request number" },
      },
      required: ["pr_number"],
    },
  },
  {
    name: "get_check_run_output",
    description:
      "Fetch the output (summary + truncated text + html_url) of a single check run. Use after get_pr_state_check_rollup identifies a failing check whose log you need to read.",
    input_schema: {
      type: "object",
      properties: {
        check_run_id: { type: "integer", minimum: 1, description: "Check run database ID" },
      },
      required: ["check_run_id"],
    },
  },
  {
    name: "get_workflow_run",
    description:
      "Fetch a single GitHub Actions workflow run (conclusion, html_url, logs_url, timestamps). Use to confirm a CI failure's pipeline before drilling into check runs.",
    input_schema: {
      type: "object",
      properties: {
        run_id: { type: "integer", minimum: 1, description: "Workflow run ID" },
      },
      required: ["run_id"],
    },
  },
  {
    name: "get_branch_protection",
    description:
      "Fetch branch protection settings (required status checks, reviewers, etc.). Returns `protected: false` if the branch is unprotected. Use to determine whether a CI check is gating merge.",
    input_schema: {
      type: "object",
      properties: {
        branch: { type: "string", minLength: 1, description: "Branch name (e.g., 'main')" },
      },
      required: ["branch"],
    },
  },
  {
    name: "get_pr_diff",
    description:
      "Fetch the unified diff for a PR (capped at ~50KB). Use sparingly, diffs are token-expensive; prefer the file list and inline reviews where possible.",
    input_schema: {
      type: "object",
      properties: {
        pr_number: { type: "integer", minimum: 1, description: "The pull request number" },
      },
      required: ["pr_number"],
    },
  },
  {
    name: "get_pr_files",
    description:
      "List the files changed in a PR with status (added/modified/removed/renamed) and per-file additions/deletions/changes. Up to 100 files. Use to size a PR (file count, breadth of change), reason about scope, or check whether a specific path was touched. Cheaper than get_pr_diff.",
    input_schema: {
      type: "object",
      properties: {
        pr_number: { type: "integer", minimum: 1, description: "The pull request number" },
      },
      required: ["pr_number"],
    },
  },
  {
    name: "list_pr_comments",
    description:
      "List issue comments on a PR (paginated, 30 per page). Returns the requested page plus a next_page cursor when more exist.",
    input_schema: {
      type: "object",
      properties: {
        pr_number: { type: "integer", minimum: 1, description: "The pull request number" },
        page: {
          type: "integer",
          minimum: 1,
          description: "1-indexed page number; defaults to 1",
        },
      },
      required: ["pr_number"],
    },
  },
];

/**
 * Dispatch a tool invocation from `runWithTools` to the matching fetcher.
 * Errors are surfaced as `is_error: true` tool results so the model can
 * recover (re-call with different input, abandon).
 */
export async function dispatchGithubStateTool(
  deps: GithubStateDeps,
  call: LLMToolCall,
): Promise<LLMToolResult> {
  try {
    switch (call.name) {
      case "get_pr_state_check_rollup": {
        const input = call.input as { pr_number?: unknown };
        if (typeof input.pr_number !== "number") {
          return { content: JSON.stringify({ error: "pr_number required" }), isError: true };
        }
        return { content: await getPrStateCheckRollup(deps, input.pr_number) };
      }
      case "get_check_run_output": {
        const input = call.input as { check_run_id?: unknown };
        if (typeof input.check_run_id !== "number") {
          return { content: JSON.stringify({ error: "check_run_id required" }), isError: true };
        }
        return { content: await getCheckRunOutput(deps, input.check_run_id) };
      }
      case "get_workflow_run": {
        const input = call.input as { run_id?: unknown };
        if (typeof input.run_id !== "number") {
          return { content: JSON.stringify({ error: "run_id required" }), isError: true };
        }
        return { content: await getWorkflowRun(deps, input.run_id) };
      }
      case "get_branch_protection": {
        const input = call.input as { branch?: unknown };
        if (typeof input.branch !== "string" || input.branch.length === 0) {
          return { content: JSON.stringify({ error: "branch required" }), isError: true };
        }
        return { content: await getBranchProtection(deps, input.branch) };
      }
      case "get_pr_diff": {
        const input = call.input as { pr_number?: unknown };
        if (typeof input.pr_number !== "number") {
          return { content: JSON.stringify({ error: "pr_number required" }), isError: true };
        }
        return { content: await getPrDiff(deps, input.pr_number) };
      }
      case "get_pr_files": {
        const input = call.input as { pr_number?: unknown };
        if (typeof input.pr_number !== "number") {
          return { content: JSON.stringify({ error: "pr_number required" }), isError: true };
        }
        return { content: await getPrFiles(deps, input.pr_number) };
      }
      case "list_pr_comments": {
        const input = call.input as { pr_number?: unknown; page?: unknown };
        if (typeof input.pr_number !== "number") {
          return { content: JSON.stringify({ error: "pr_number required" }), isError: true };
        }
        let page = 1;
        if (input.page !== undefined) {
          if (typeof input.page !== "number" || !Number.isInteger(input.page) || input.page < 1) {
            return {
              content: JSON.stringify({ error: "page must be a positive integer >= 1" }),
              isError: true,
            };
          }
          page = input.page;
        }
        return { content: await listPrComments(deps, input.pr_number, page) };
      }
      default:
        return {
          content: JSON.stringify({ error: `unknown tool: ${call.name}` }),
          isError: true,
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: JSON.stringify({ error: message }), isError: true };
  }
}
