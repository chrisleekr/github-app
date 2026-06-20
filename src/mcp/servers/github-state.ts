import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Octokit } from "octokit";
import { z } from "zod";

import {
  getBranchProtection,
  getCheckRunOutput,
  getPrDiff,
  getPrFiles,
  getPrStateCheckRollup,
  getWorkflowRun,
  listPrComments,
} from "../../github/state-fetchers";
import { redactErrorMessage } from "../../utils/log-redaction";
import { createMcpLogger } from "../mcp-logger";

/**
 * Read-only GitHub state MCP server (issue #117).
 *
 * Thin stdio wrapper around `src/github/state-fetchers.ts`. The fetchers
 * are shared with the single-turn `runWithTools` path so MCP and inline
 * dispatch surface identical responses.
 *
 * Repo scope is hard-pinned via env (REPO_OWNER + REPO_NAME): the
 * model cannot fan out queries to arbitrary repos.
 *
 * Required env: GITHUB_TOKEN, REPO_OWNER, REPO_NAME.
 */
const REPO_OWNER = process.env["REPO_OWNER"];
const REPO_NAME = process.env["REPO_NAME"];
const GITHUB_TOKEN = process.env["GITHUB_TOKEN"];

const log = createMcpLogger("github-state");

if (
  REPO_OWNER === undefined ||
  REPO_OWNER === "" ||
  REPO_NAME === undefined ||
  REPO_NAME === "" ||
  GITHUB_TOKEN === undefined ||
  GITHUB_TOKEN === ""
) {
  log.error("REPO_OWNER, REPO_NAME, and GITHUB_TOKEN are required");
  process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });
// `log` carries the deliveryId binding into retryWithBackoff warnings emitted
// by the fetchers on transient-failure retries (issue #199).
const deps = { octokit, owner: REPO_OWNER, repo: REPO_NAME, log } as const;

const server = new McpServer({
  name: "GitHub State Server",
  version: "1.0.0",
});

function ok(text: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text" as const, text }] };
}

function fail(err: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  const message = redactErrorMessage(err);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

// eslint-disable-next-line @typescript-eslint/no-deprecated -- MCP SDK migration to registerTool is out of scope for this server
server.tool(
  "get_pr_state_check_rollup",
  "Fetch the head-commit CI rollup (state + per-check rows + is_required) for a PR in the current repo. Use this when answering questions about CI status, why a PR isn't merging, or which checks failed.",
  { pr_number: z.number().int().positive().describe("The pull request number") },
  async ({ pr_number }) => {
    try {
      return ok(await getPrStateCheckRollup(deps, pr_number));
    } catch (err) {
      return fail(err);
    }
  },
);

// eslint-disable-next-line @typescript-eslint/no-deprecated -- MCP SDK migration to registerTool is out of scope for this server
server.tool(
  "get_check_run_output",
  "Fetch the output (summary + truncated text + html_url) of a single check run.",
  { check_run_id: z.number().int().positive().describe("Check run database ID") },
  async ({ check_run_id }) => {
    try {
      return ok(await getCheckRunOutput(deps, check_run_id));
    } catch (err) {
      return fail(err);
    }
  },
);

// eslint-disable-next-line @typescript-eslint/no-deprecated -- MCP SDK migration to registerTool is out of scope for this server
server.tool(
  "get_workflow_run",
  "Fetch a single GitHub Actions workflow run (conclusion, html_url, logs_url, timestamps).",
  { run_id: z.number().int().positive().describe("Workflow run ID") },
  async ({ run_id }) => {
    try {
      return ok(await getWorkflowRun(deps, run_id));
    } catch (err) {
      return fail(err);
    }
  },
);

// eslint-disable-next-line @typescript-eslint/no-deprecated -- MCP SDK migration to registerTool is out of scope for this server
server.tool(
  "get_branch_protection",
  "Fetch branch protection settings (required status checks, reviewers, etc.). Returns `protected: false` if the branch is unprotected.",
  { branch: z.string().min(1).describe("Branch name (e.g., 'main')") },
  async ({ branch }) => {
    try {
      return ok(await getBranchProtection(deps, branch));
    } catch (err) {
      return fail(err);
    }
  },
);

// eslint-disable-next-line @typescript-eslint/no-deprecated -- MCP SDK migration to registerTool is out of scope for this server
server.tool(
  "get_pr_diff",
  "Fetch the unified diff for a PR (capped at ~50KB).",
  { pr_number: z.number().int().positive().describe("The pull request number") },
  async ({ pr_number }) => {
    try {
      return ok(await getPrDiff(deps, pr_number));
    } catch (err) {
      return fail(err);
    }
  },
);

// eslint-disable-next-line @typescript-eslint/no-deprecated -- MCP SDK migration to registerTool is out of scope for this server
server.tool(
  "get_pr_files",
  "List files changed in a PR with status and per-file additions/deletions/changes. Up to 100 files. Cheaper than get_pr_diff.",
  { pr_number: z.number().int().positive().describe("The pull request number") },
  async ({ pr_number }) => {
    try {
      return ok(await getPrFiles(deps, pr_number));
    } catch (err) {
      return fail(err);
    }
  },
);

// eslint-disable-next-line @typescript-eslint/no-deprecated -- MCP SDK migration to registerTool is out of scope for this server
server.tool(
  "list_pr_comments",
  "List issue comments on a PR (paginated, 30 per page). Returns the requested page plus a next_page cursor when more exist.",
  {
    pr_number: z.number().int().positive().describe("The pull request number"),
    page: z.number().int().positive().optional().describe("1-indexed page number; defaults to 1"),
  },
  async ({ pr_number, page }) => {
    try {
      return ok(await listPrComments(deps, pr_number, page ?? 1));
    } catch (err) {
      return fail(err);
    }
  },
);

async function runServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.on("exit", () => {
    void server.close();
  });
}

void runServer().catch((err: unknown) => {
  // Fail fast so the supervisor sees the dead sidecar instead of dispatching
  // tool calls against an unconnected server (mirrors resolve-review-thread.ts).
  // Route through the redacting logger: a raw Octokit RequestError here can
  // carry a ghs_ token in its message/headers (#172).
  log.error({ err }, "github-state MCP server failed");
  process.exit(1);
});
