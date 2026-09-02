import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Octokit } from "octokit";
import { z } from "zod";

import { redactErrorMessage } from "../../utils/log-redaction";
import { retryWithBackoff } from "../../utils/retry";
import { redactSecrets, sanitizeContent } from "../../utils/sanitize";
import { createMcpLogger } from "../mcp-logger";
import { type ExistingComment, hasDuplicateAt } from "./inline-comment-dedup";

/**
 * MCP server for creating inline PR review comments.
 * Provides create_inline_comment tool (PRs only).
 *
 * Ported from claude-code-action's src/mcp/github-inline-comment-server.ts
 *
 * Environment variables:
 * - GITHUB_TOKEN, REPO_OWNER, REPO_NAME, PR_NUMBER
 */
// Validate all required env vars at startup for fail-fast behavior.
// Errors here surface immediately in logs rather than on the first tool call.
const REPO_OWNER = process.env["REPO_OWNER"];
const REPO_NAME = process.env["REPO_NAME"];
const PR_NUMBER = process.env["PR_NUMBER"];
const GITHUB_TOKEN = process.env["GITHUB_TOKEN"];
// The login our writes are attributed to. Supplied by `src/mcp/registry.ts`
// rather than resolved here: `GET /user` 403s under an App installation
// token, which is the default mode, so asking would cost one failed request
// per finding and still yield nothing.
const BOT_APP_LOGIN = process.env["BOT_APP_LOGIN"];

const log = createMcpLogger("inline-comment");

if (
  REPO_OWNER === undefined ||
  REPO_OWNER === "" ||
  REPO_NAME === undefined ||
  REPO_NAME === "" ||
  PR_NUMBER === undefined ||
  PR_NUMBER === "" ||
  GITHUB_TOKEN === undefined ||
  GITHUB_TOKEN === "" ||
  BOT_APP_LOGIN === undefined ||
  BOT_APP_LOGIN === ""
) {
  log.error("REPO_OWNER, REPO_NAME, PR_NUMBER, GITHUB_TOKEN, and BOT_APP_LOGIN are required");
  process.exit(1);
}

// Create Octokit once at startup, GITHUB_TOKEN is constant for the server lifetime.
const octokit = new Octokit({ auth: GITHUB_TOKEN });

/**
 * Every review comment on this PR, fetched once per server process.
 *
 * The server is spawned per run and bound to one PR, and the agent posts its
 * findings within that process, so a per-call fetch would re-paginate the whole
 * thread for every finding. On a busy PR that is tens of extra requests against
 * an installation bucket shared with the config fetches, tracking comments, and
 * the ship reactor, and `review` now runs on every push. Instead: fetch once,
 * then keep the cache warm by appending each comment we successfully create, so
 * within-run duplicates are still caught without a refetch.
 *
 * On failure the cache is cleared so the next finding retries.
 */
let existingComments: Promise<ExistingComment[]> | null = null;

// Const arrows, not function declarations: declarations hoist above the startup
// env guard, and TypeScript then loses the narrowing that proves REPO_OWNER /
// REPO_NAME are strings by this point.
const loadExistingComments = (pull_number: number): Promise<ExistingComment[]> => {
  existingComments ??= octokit
    .paginate(octokit.rest.pulls.listReviewComments, {
      owner: REPO_OWNER,
      repo: REPO_NAME,
      pull_number,
      per_page: 100,
    })
    .catch((err: unknown) => {
      existingComments = null;
      throw err;
    });
  return existingComments;
};

/**
 * True when we already have a live comment at this exact location.
 *
 * `review` is auto-triggered on every push (work item #1), so the same unfixed
 * finding would otherwise get a fresh thread per run. GitHub does not mark those
 * outdated, because each anchors to the new head SHA, and ship's merge gate
 * counts unresolved-and-not-outdated threads, so duplicates block merges.
 *
 * Keyed on location rather than body text: the agent rewords the same finding
 * between runs, so a body hash would never match.
 *
 * Fail-open: a lookup error posts the comment.
 */
const hasExistingComment = async (
  pull_number: number,
  path: string,
  line: number,
  side: "LEFT" | "RIGHT",
): Promise<boolean> => {
  try {
    const existing = await loadExistingComments(pull_number);
    return hasDuplicateAt(existing, { path, line, side }, BOT_APP_LOGIN);
  } catch (err) {
    log.warn(
      { err, event: "mcp.inline_comment.dedup_check_failed", pull_number, path, line },
      "dedup lookup failed, posting anyway",
    );
    return false;
  }
};

/**
 * Locations with a create in flight. The MCP SDK does not serialise tool
 * handlers, so without this two parallel `create_inline_comment` calls for one
 * location both pass `hasExistingComment` before either records anything.
 */
const pendingLocations = new Set<string>();

const locationKey = (path: string, line: number, side: string): string =>
  `${path}\u0000${String(line)}\u0000${side}`;

/** Keep the cache warm so two findings on one line collide within a run too. */
const rememberComment = (comment: ExistingComment): void => {
  if (existingComments === null) return;
  void existingComments.then((list) => list.push(comment)).catch(() => undefined);
};

const server = new McpServer({
  name: "GitHub Inline Comment Server",
  version: "1.0.0",
});

// eslint-disable-next-line @typescript-eslint/no-deprecated -- MCP SDK migration to registerTool is tracked separately; out of scope for housekeeping
server.tool(
  "create_inline_comment",
  "Create an inline comment on a specific line or lines in a PR file",
  {
    path: z.string().describe("The file path to comment on (e.g., 'src/index.js')"),
    body: z
      .string()
      .describe(
        "The comment text (supports markdown and GitHub code suggestion blocks). " +
          "For code suggestions, use: ```suggestion\\nreplacement code\\n```. " +
          "IMPORTANT: The suggestion block will REPLACE the ENTIRE line range.",
      ),
    line: z
      .number()
      .min(1)
      .describe("Line number (end line for multi-line comments). Required. Must be >= 1."),
    startLine: z
      .number()
      .min(1)
      .optional()
      .describe("Start line for multi-line comments (use with line as end). Must be >= 1."),
    side: z
      .enum(["LEFT", "RIGHT"])
      .optional()
      .default("RIGHT")
      .describe("Side of the diff to comment on: LEFT (old) or RIGHT (new)"),
    commit_id: z
      .string()
      .optional()
      .describe("Specific commit SHA to comment on (defaults to latest commit)"),
  },
  async ({ path, body, line, startLine, side, commit_id }) => {
    try {
      const pull_number = parseInt(PR_NUMBER, 10);
      const sanitizedBody = sanitizeContent(body);

      // Output-side secret guard (defense layer 2). Silently strip
      // credential-shaped bytes after input sanitization, before the body
      // leaves for GitHub.
      const guarded = redactSecrets(sanitizedBody);
      if (guarded.matchCount > 0) {
        log.warn(
          {
            event: "secret_redacted",
            scanner: "regex",
            callsite: "mcp.inline-comment.create_inline_comment",
            kinds: guarded.kinds,
            matchCount: guarded.matchCount,
            pull_number,
            path,
          },
          "secret redacted from inline comment body",
        );
      }

      const isSingleLine = startLine === undefined;

      const locKey = locationKey(path, line, side);
      const alreadyPosted = await hasExistingComment(pull_number, path, line, side);
      // Re-read `pendingLocations` AFTER the await: a concurrent handler can
      // claim this location while `hasExistingComment` is in flight, and both
      // would otherwise fall through and post.
      if (pendingLocations.has(locKey) || alreadyPosted) {
        log.info(
          { event: "mcp.inline_comment.deduped", pull_number, path, line, side },
          "skipped duplicate inline comment",
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                deduped: true,
                message:
                  `A review comment already exists at ${path}:${String(line)}. ` +
                  "Skipped to avoid duplicating it. Do not retry this finding.",
              }),
            },
          ],
        };
      }

      // Claim before the commit-SHA fetch below, which is another suspension
      // point a concurrent handler could interleave with.
      pendingLocations.add(locKey);

      // Get latest commit SHA if not provided
      let commitSha = commit_id;
      if (commitSha === undefined || commitSha === "") {
        const pr = await retryWithBackoff(
          () =>
            octokit.rest.pulls.get({
              owner: REPO_OWNER,
              repo: REPO_NAME,
              pull_number,
            }),
          { log, op: "mcp.inline_comment.fetch_pr" },
        );
        commitSha = pr.data.head.sha;
      }

      const params: Parameters<typeof octokit.rest.pulls.createReviewComment>[0] = {
        owner: REPO_OWNER,
        repo: REPO_NAME,
        pull_number,
        body: guarded.body,
        path,
        side,
        commit_id: commitSha,
      };

      if (isSingleLine) {
        params.line = line;
      } else {
        params.start_line = startLine;
        params.start_side = side;
        params.line = line;
      }

      let result;
      try {
        result = await retryWithBackoff(() => octokit.rest.pulls.createReviewComment(params), {
          log,
          op: "mcp.inline_comment.create_review_comment",
        });
      } catch (err) {
        // Release on failure: nothing was posted, so a later legitimate retry of
        // this finding must not be mistaken for a duplicate.
        pendingLocations.delete(locKey);
        throw err;
      }

      // Note this runs AFTER retryWithBackoff resolves, so it does not close
      // the pre-existing double-post window (a POST that succeeded but whose
      // response timed out): the retried closure never consults the cache.
      rememberComment({ path, line, side, user: { login: BOT_APP_LOGIN } });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              comment_id: result.data.id,
              html_url: result.data.html_url,
              path: result.data.path,
              line: result.data.line ?? result.data.original_line,
              message: `Inline comment created on ${path}${
                isSingleLine ? ` at line ${line}` : ` from line ${startLine} to ${line}`
              }`,
            }),
          },
        ],
      };
    } catch (error) {
      const errorMessage = redactErrorMessage(error);

      let helpMessage = "";
      if (errorMessage.includes("Validation Failed")) {
        helpMessage =
          "\n\nThe line number doesn't exist in the diff or the file path is incorrect.";
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Error creating inline comment: ${errorMessage}${helpMessage}`,
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
  log.error({ err }, "inline-comment MCP server failed");
  process.exit(1);
});
