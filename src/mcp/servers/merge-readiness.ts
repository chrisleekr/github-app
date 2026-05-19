import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Octokit } from "octokit";
import { z } from "zod";

import { PROBE_QUERY } from "../../github/queries";
import { computeVerdict, type ProbeResponseShape } from "../../workflows/ship/verdict";

/**
 * Read-only merge-readiness MCP server (scheduled-actions auto-merge gate).
 *
 * Exposes one tool, `check_merge_readiness`, that runs the deterministic
 * `PROBE_QUERY` + `computeVerdict()` pipeline used by the ship workflow and
 * returns a `MergeReadiness` verdict (CI green, no conflicts, no open review
 * threads, no human takeover). A scheduled action's skill prompt calls this
 * before merging so the merge is gated on a deterministic check, not on the
 * LLM's own judgement alone.
 *
 * This server is registered ONLY when a scheduled action's effective
 * `auto_merge` is true (per-action flag AND the `SCHEDULER_ALLOW_AUTO_MERGE`
 * env kill-switch). It imports no daemon `config`: repo scope and the bot
 * login arrive via env, honouring the MCP-server config-import invariant.
 *
 * Required env: GITHUB_TOKEN, REPO_OWNER, REPO_NAME, BOT_APP_LOGIN.
 */
const REPO_OWNER = process.env["REPO_OWNER"];
const REPO_NAME = process.env["REPO_NAME"];
const GITHUB_TOKEN = process.env["GITHUB_TOKEN"];
const BOT_APP_LOGIN = process.env["BOT_APP_LOGIN"];

if (
  REPO_OWNER === undefined ||
  REPO_OWNER === "" ||
  REPO_NAME === undefined ||
  REPO_NAME === "" ||
  GITHUB_TOKEN === undefined ||
  GITHUB_TOKEN === "" ||
  BOT_APP_LOGIN === undefined ||
  BOT_APP_LOGIN === ""
) {
  console.error("Error: REPO_OWNER, REPO_NAME, GITHUB_TOKEN, and BOT_APP_LOGIN are required");
  process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const server = new McpServer({ name: "Merge Readiness Server", version: "1.0.0" });

function ok(text: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text" as const, text }] };
}

function fail(err: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  // Silently strip a token-shaped substring: an octokit GraphQL error can
  // echo the request URL, which carries the installation token. Output-path
  // redaction strips matched bytes rather than leaving a marker (a marker
  // leaks probing signal to an attacker, CLAUDE.md security invariant 2).
  const raw = err instanceof Error ? err.message : String(err);
  const message = raw.replace(/gh[a-z]_[A-Za-z0-9_]{20,}|x-access-token:[^@\s]+/g, "");
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

// eslint-disable-next-line @typescript-eslint/no-deprecated -- MCP SDK migration to registerTool is out of scope here
server.tool(
  "check_merge_readiness",
  "Check whether a pull request in the current repo is deterministically ready to merge: " +
    "CI green, no merge conflicts, no open review threads, no human takeover. Returns a " +
    "verdict object with `ready` (boolean) and, when not ready, a `reason` and `detail`. " +
    "Call this before merging a PR; merge only when `ready` is true.",
  { pr_number: z.number().int().positive().describe("The pull request number") },
  async ({ pr_number }) => {
    try {
      const response = await octokit.graphql<ProbeResponseShape>(PROBE_QUERY, {
        owner: REPO_OWNER,
        repo: REPO_NAME,
        number: pr_number,
      });
      // The probe fetches the first 100 review threads only, sufficient for
      // a scheduled action's own freshly-created PR. botPushedShas is empty:
      // a scheduled action tracks no prior pushes, so head-commit authorship
      // is judged purely against BOT_APP_LOGIN.
      const verdict = computeVerdict({
        response,
        botAppLogin: BOT_APP_LOGIN,
        botPushedShas: new Set<string>(),
      });
      return ok(JSON.stringify(verdict));
    } catch (err) {
      return fail(err);
    }
  },
);

async function runServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void runServer().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
