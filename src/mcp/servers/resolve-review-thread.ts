/**
 * MCP server exposing the GraphQL `resolveReviewThread` mutation as a
 * single tool consumable by the Claude Agent SDK during `resolve` handler
 * execution. Per `contracts/mcp-resolve-thread-server.md` (T029).
 *
 * Single tool: `resolve_review_thread(thread_id)`.
 * Bound to one `(owner, repo, pull_number)` at startup via env vars; the
 * server refuses to resolve a thread belonging to a different PR.
 *
 * Environment variables (validated at startup, fail-fast):
 *   GITHUB_TOKEN  : installation token
 *   REPO_OWNER    : repo owner login
 *   REPO_NAME     : repo name
 *   PR_NUMBER     : pull request number this server is bound to
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Octokit } from "octokit";
import { z } from "zod";

import { redactErrorMessage } from "../../utils/log-redaction";
import { retryWithBackoff } from "../../utils/retry";
import { createMcpLogger } from "../mcp-logger";

// MCP servers communicate JSON-RPC over stdout, so the logger writes to stderr
// (createMcpLogger handles that). Shared helper (#172) gives this server the
// same REDACT_PATHS + errSerializer scrubbing as the main logger plus a
// `deliveryId` binding, without pulling in the config-bound `src/logger.ts`.
const log = createMcpLogger("resolve-review-thread");

const REPO_OWNER = process.env["REPO_OWNER"];
const REPO_NAME = process.env["REPO_NAME"];
const PR_NUMBER = process.env["PR_NUMBER"];
const GITHUB_TOKEN = process.env["GITHUB_TOKEN"];

if (
  REPO_OWNER === undefined ||
  REPO_OWNER === "" ||
  REPO_NAME === undefined ||
  REPO_NAME === "" ||
  PR_NUMBER === undefined ||
  PR_NUMBER === "" ||
  GITHUB_TOKEN === undefined ||
  GITHUB_TOKEN === ""
) {
  log.error(
    {
      hasRepoOwner: REPO_OWNER !== undefined && REPO_OWNER !== "",
      hasRepoName: REPO_NAME !== undefined && REPO_NAME !== "",
      hasPrNumber: PR_NUMBER !== undefined && PR_NUMBER !== "",
      hasGithubToken: GITHUB_TOKEN !== undefined && GITHUB_TOKEN !== "",
    },
    "REPO_OWNER, REPO_NAME, PR_NUMBER, and GITHUB_TOKEN are required",
  );
  process.exit(1);
}

const BOUND_PR_NUMBER = parseInt(PR_NUMBER, 10);
if (!Number.isInteger(BOUND_PR_NUMBER) || BOUND_PR_NUMBER <= 0) {
  log.error({ prNumber: PR_NUMBER }, "PR_NUMBER must be a positive integer");
  process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const server = new McpServer({
  name: "GitHub Resolve Review Thread Server",
  version: "1.0.0",
});

const GET_THREAD_QUERY = `
  query GetReviewThread($threadId: ID!) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        id
        pullRequest {
          number
          repository {
            name
            owner { login }
          }
        }
      }
    }
  }
`;

const RESOLVE_MUTATION = `
  mutation ResolveReviewThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread {
        id
        isResolved
        pullRequest {
          number
        }
      }
    }
  }
`;

interface PreflightResponse {
  node: {
    id: string;
    pullRequest: {
      number: number;
      repository: { name: string; owner: { login: string } };
    };
  } | null;
}

interface ResolveResponse {
  resolveReviewThread: {
    thread: {
      id: string;
      isResolved: boolean;
      pullRequest: { number: number };
    };
  };
}

type ErrorCode =
  | "thread_not_found"
  | "permission_denied"
  | "rate_limited"
  | "network_error"
  | "graphql_error";

function classifyError(err: unknown): ErrorCode {
  // Inspect the message before the status branch: GitHub secondary
  // rate-limits return HTTP 403 with an explicit "secondary rate limit"
  // message, so a status-only check would misclassify them as
  // `permission_denied`. Normalise the message once up front and let it
  // pre-empt the 403 branch.
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  const status = (err as { status?: number }).status;
  if (status === 404) return "thread_not_found";
  if (status === 429) return "rate_limited";
  if (message.includes("rate limit") || message.includes("secondary rate")) return "rate_limited";
  if (status === 403) return "permission_denied";
  if (message.includes("not found")) return "thread_not_found";
  if (message.includes("forbidden") || message.includes("permission")) return "permission_denied";
  if (
    message.includes("etimedout") ||
    message.includes("econnreset") ||
    message.includes("network") ||
    message.includes("fetch failed")
  ) {
    return "network_error";
  }
  return "graphql_error";
}

// eslint-disable-next-line @typescript-eslint/no-deprecated -- MCP SDK migration to registerTool is tracked separately; out of scope for this feature
server.tool(
  "resolve_review_thread",
  "Mark a GitHub PR review thread as resolved. Use after replying to the thread with a comment summarising the change.",
  {
    thread_id: z
      .string()
      .min(1)
      .describe(
        "The PullRequestReviewThread node ID (from probe response reviewThreads.nodes[].id).",
      ),
  },
  async ({ thread_id }) => {
    try {
      // Both GraphQL calls are wrapped in the shared retry helper so the
      // documented contract (rate-limit retry, network-failure retry up
      // to 3 attempts) is actually honoured. The helper short-circuits
      // on non-retriable 4xx (e.g. 404 thread_not_found) so callers
      // still see prompt failures.
      const preflight = await retryWithBackoff(
        () => octokit.graphql<PreflightResponse>(GET_THREAD_QUERY, { threadId: thread_id }),
        { log, op: "mcp.resolve_review_thread.preflight" },
      );
      const preflightPr = preflight.node?.pullRequest.number;
      const preflightRepo = preflight.node?.pullRequest.repository;
      // Per-repo PR numbers, `(owner, repo, number)` identifies the
      // bound PR, not `number` alone. Reject any thread whose repository
      // identity drifts from the bound `(REPO_OWNER, REPO_NAME)` pair.
      const repoMismatch =
        preflightRepo !== undefined &&
        (preflightRepo.owner.login !== REPO_OWNER || preflightRepo.name !== REPO_NAME);
      if (preflightPr !== BOUND_PR_NUMBER || repoMismatch) {
        const code: ErrorCode = preflight.node === null ? "thread_not_found" : "graphql_error";
        const message =
          preflight.node === null
            ? `thread ${thread_id} not found or not a PullRequestReviewThread`
            : repoMismatch
              ? `thread belongs to ${preflightRepo?.owner.login}/${preflightRepo?.name} but this server is bound to ${REPO_OWNER}/${REPO_NAME}`
              : `thread belongs to PR #${String(preflightPr)} but this server is bound to PR #${String(BOUND_PR_NUMBER)}`;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                code,
                message,
                thread_id,
                pr_number: BOUND_PR_NUMBER,
              }),
            },
          ],
          isError: true,
        };
      }

      const result = await retryWithBackoff(
        () => octokit.graphql<ResolveResponse>(RESOLVE_MUTATION, { threadId: thread_id }),
        { log, op: "mcp.resolve_review_thread.mutate" },
      );
      const thread = result.resolveReviewThread.thread;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              thread_id: thread.id,
              is_resolved: thread.isResolved,
              pr_number: thread.pullRequest.number,
            }),
          },
        ],
      };
    } catch (err) {
      const code = classifyError(err);
      const message = redactErrorMessage(err);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ code, message, thread_id, pr_number: BOUND_PR_NUMBER }),
          },
        ],
        isError: true,
      };
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
  // Fail-fast on transport bind failure: an MCP sidecar that exits 0
  // after a connect rejection looks healthy to its supervisor, which
  // then dispatches tool calls into a dead process.
  log.error({ err }, "MCP server transport bind failed");
  process.exit(1);
});
