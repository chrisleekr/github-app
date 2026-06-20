import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Octokit } from "octokit";
import { z } from "zod";

import { redactErrorMessage } from "../../utils/log-redaction";
import { retryWithBackoff } from "../../utils/retry";
import { redactSecrets, sanitizeContent } from "../../utils/sanitize";
import { createMcpLogger } from "../mcp-logger";

/**
 * MCP server for tracking comment updates.
 * Provides update_claude_comment tool used by Claude to communicate progress.
 *
 * Ported from claude-code-action's src/mcp/github-comment-server.ts
 *
 * The tracking comment is always created via issues.createComment, so updates
 * always use the issues API regardless of event type. Issue comment IDs are
 * not valid in the pulls review comments namespace.
 * See: https://docs.github.com/en/rest/issues/comments
 *
 * Environment variables (passed by the executor):
 * - GITHUB_TOKEN: Installation access token
 * - REPO_OWNER: Repository owner
 * - REPO_NAME: Repository name
 * - CLAUDE_COMMENT_ID: The tracking comment ID to update
 */
// Validate all required env vars at startup for fail-fast behavior.
// Errors here surface immediately in logs rather than on the first tool call.
const REPO_OWNER = process.env["REPO_OWNER"];
const REPO_NAME = process.env["REPO_NAME"];
const GITHUB_TOKEN = process.env["GITHUB_TOKEN"];
const CLAUDE_COMMENT_ID = process.env["CLAUDE_COMMENT_ID"];
const DELIVERY_ID = process.env["DELIVERY_ID"];

const log = createMcpLogger("github-comment");

if (
  REPO_OWNER === undefined ||
  REPO_OWNER === "" ||
  REPO_NAME === undefined ||
  REPO_NAME === "" ||
  GITHUB_TOKEN === undefined ||
  GITHUB_TOKEN === "" ||
  CLAUDE_COMMENT_ID === undefined ||
  CLAUDE_COMMENT_ID === "" ||
  DELIVERY_ID === undefined ||
  DELIVERY_ID === ""
) {
  log.error("REPO_OWNER, REPO_NAME, GITHUB_TOKEN, CLAUDE_COMMENT_ID, and DELIVERY_ID are required");
  process.exit(1);
}

// Create Octokit once at startup, GITHUB_TOKEN is constant for the server lifetime.
const octokit = new Octokit({ auth: GITHUB_TOKEN });
const commentId = parseInt(CLAUDE_COMMENT_ID, 10);

// Guard against non-numeric CLAUDE_COMMENT_ID (parseInt returns NaN for non-integer strings).
if (isNaN(commentId)) {
  log.error(`CLAUDE_COMMENT_ID must be a valid integer, got: ${CLAUDE_COMMENT_ID}`);
  process.exit(1);
}

const server = new McpServer({
  name: "GitHub Comment Server",
  version: "1.0.0",
});

// eslint-disable-next-line @typescript-eslint/no-deprecated -- MCP SDK migration to registerTool is tracked separately; out of scope for housekeeping
server.tool(
  "update_claude_comment",
  "Update the Claude comment with progress and results (automatically handles both issue and PR comments)",
  {
    body: z.string().describe("The updated comment content"),
  },
  async ({ body }) => {
    try {
      const sanitizedBody = sanitizeContent(body);

      // Output-side secret guard (defense layer 2). Silently strip any
      // credential-shaped bytes the agent may have included before they
      // leave for GitHub. Run on the post-sanitize body so we operate on
      // exactly what would otherwise reach the comment.
      const guarded = redactSecrets(sanitizedBody);
      if (guarded.matchCount > 0) {
        log.warn(
          {
            event: "secret_redacted",
            scanner: "regex",
            callsite: "mcp.comment.update_claude_comment",
            kinds: guarded.kinds,
            matchCount: guarded.matchCount,
            commentId,
          },
          "secret redacted from comment body",
        );
      }
      // Re-prepend the delivery marker after sanitizeContent strips it (stripHtmlComments)
      // so the tracking comment keeps the stable hidden marker createTrackingComment wrote
      // (see `deliveryMarker`). The idempotency check that used to read it was retired in
      // issue #211; the marker is preserved for tracking-comment format consistency.
      // DELIVERY_ID is validated non-empty at process startup so the cast is safe.
      const markerPrefix = `<!-- delivery:${DELIVERY_ID} -->`;
      const bodyWithMarker = `${markerPrefix}\n${guarded.body}`;

      // Always use issues API -- tracking comment is created via issues.createComment.
      // Wrapped in retryWithBackoff so a transient 5xx/429/secondary-rate-limit
      // does not drop a status update and leave a stale "Working..." comment (#199).
      const result = await retryWithBackoff(
        () =>
          octokit.rest.issues.updateComment({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            comment_id: commentId,
            body: bodyWithMarker,
          }),
        { log, op: "mcp.comment.update" },
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ success: true, id: result.data.id }),
          },
        ],
      };
    } catch (error) {
      const errorMessage = redactErrorMessage(error);
      return {
        content: [{ type: "text" as const, text: `Error: ${errorMessage}` }],
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
  log.error({ err }, "comment MCP server failed");
  process.exit(1);
});
