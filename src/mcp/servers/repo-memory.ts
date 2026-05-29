import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createMcpLogger } from "../mcp-logger";
import {
  appendActionToPath,
  buildSaveAction,
  buildSaveReviewLearningAction,
  type DaemonAction,
} from "./repo-memory-actions";

/**
 * MCP server for persistent repo memory.
 * Provides tools for Claude to save, delete, and read learnings about a repository.
 *
 * Two concept families share this server because they share the same scratch-
 * file / orchestrator-persist plumbing:
 *
 *   - repo_memory: setup / architecture / conventions / env / gotchas. Loaded
 *     into every job's prompt as untrusted hints.
 *   - review_learnings: review-policy directives (file-glob-scoped) extracted
 *     from past PR review pushback. Only the `review` and `resolve` workflow
 *     handlers populate the env var, so the save_review_learning /
 *     delete_review_learning / get_review_learnings tools are no-ops for
 *     other workflows (the agent has no learnings to enumerate or update).
 *
 * Actions are accumulated in a JSON file (.daemon-actions.json) in the
 * workDir. After execution, the daemon reads this file and sends actions to
 * the orchestrator via job:result, which persists them to Postgres.
 *
 * Environment variables (passed by the executor):
 * - WORK_DIR: Path to the cloned repo working directory
 * - REPO_MEMORY: JSON string of pre-loaded memory entries from orchestrator
 * - REVIEW_LEARNINGS: JSON string of pre-loaded review-learning entries
 *   (subset filtered by the review/resolve handler to the PR's changed files).
 */

const WORK_DIR = process.env["WORK_DIR"];
const REPO_MEMORY = process.env["REPO_MEMORY"];
const REVIEW_LEARNINGS = process.env["REVIEW_LEARNINGS"];

const log = createMcpLogger("repo-memory");

if (WORK_DIR === undefined || WORK_DIR === "") {
  log.error("WORK_DIR env var is required");
  process.exit(1);
}

const ACTIONS_FILE = join(WORK_DIR, ".daemon-actions.json");

const VALID_CATEGORIES = ["setup", "architecture", "conventions", "env", "gotchas"] as const;

function appendAction(action: DaemonAction): void {
  appendActionToPath(ACTIONS_FILE, action);
}

// MCP Server

const server = new McpServer({
  name: "repo_memory",
  version: "1.0.0",
});

server.registerTool(
  "save_repo_memory",
  {
    description:
      "Save a learning about this repository for future executions. Use this when you discover important information about setup steps, build/test commands, architecture, coding conventions, or common gotchas. Be specific and actionable, future executions will see this in their context.",
    inputSchema: {
      category: z
        .enum(VALID_CATEGORIES)
        .describe(
          "Category: 'setup' (build/test commands), 'architecture' (code structure), 'conventions' (coding style), 'env' (environment requirements), 'gotchas' (common pitfalls)",
        ),
      content: z
        .string()
        .min(1)
        .max(1000)
        .describe("The learning to save. Be specific and actionable."),
    },
  },
  ({ category, content }) => {
    // Untrusted-input boundary: memory rows are surfaced as data on every
    // future run, so strip injection vectors before they reach the daemon
    // scratch file. See issue #112 for the cross-session indirect-injection
    // chain that motivates this guard. The build function does the
    // sanitisation; we just append and reply.
    const result = buildSaveAction({ category, content });
    if (!result.ok) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ saved: false, category, reason: result.reason }),
          },
        ],
      };
    }
    appendAction(result.action);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            saved: true,
            category: result.action.category,
            content: result.action.content,
          }),
        },
      ],
    };
  },
);

server.registerTool(
  "delete_repo_memory",
  {
    description:
      "Remove an outdated or incorrect memory about this repository. Use the ID shown in the <repo_memory> section (e.g., the UUID after 'id:'). Call this when you discover a previous learning is no longer accurate.",
    inputSchema: {
      id: z.string().min(1).describe("The memory ID to delete (UUID from <repo_memory>)."),
    },
  },
  ({ id }) => {
    appendAction({ type: "delete", id });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ deleted: true, id }),
        },
      ],
    };
  },
);

server.registerTool(
  "get_repo_memory",
  {
    description:
      "Retrieve previously saved learnings about this repository. Returns all currently active memory entries including their IDs, categories, and content.",
  },
  () => {
    const memory = REPO_MEMORY ?? "[]";
    return {
      content: [{ type: "text" as const, text: memory }],
    };
  },
);

// Review-learning tools (only meaningful for review / resolve workflows).
// The orchestrator pre-loads matching learnings into REVIEW_LEARNINGS; saves
// go through the same .daemon-actions.json round-trip as repo_memory.

const REVIEW_LEARNING_SCOPES = ["local", "global"] as const;

server.registerTool(
  "save_review_learning",
  {
    description:
      "Save a review-policy directive derived from PR review pushback so future reviews of this repo respect it. Use ONLY when a maintainer explicitly accepted your acknowledgement that a flagged pattern was intentional, or when a thread resolves with a clear 'don't flag this next time' rationale. Be specific about the file pattern and explain WHY. Future review prompts will see this as repo policy.",
    inputSchema: {
      directive: z
        .string()
        .min(1)
        .max(2000)
        .describe(
          "The directive in one or two sentences. Lead with what NOT to do or what to require, e.g. 'Do not flag duplication of SCOPED_JOB_KINDS in mock.module factories.'",
        ),
      rationale: z
        .string()
        .max(2000)
        .optional()
        .describe("The WHY: short rationale explaining the policy. Strongly recommended."),
      file_glob: z
        .string()
        .max(500)
        .optional()
        .describe(
          "Optional picomatch glob limiting the directive to specific files (e.g. 'test/**/*.test.ts'). Omit for repo-wide directives.",
        ),
      scope: z
        .enum(REVIEW_LEARNING_SCOPES)
        .optional()
        .describe(
          "Scope: 'local' (this repo only, default) or 'global' (every repo under this owner). Global is silently downgraded to local in multi-owner deployments.",
        ),
      source_pr: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("PR number the directive was extracted from (provenance)."),
      source_thread: z
        .string()
        .max(200)
        .optional()
        .describe(
          "Source thread identifier, e.g. 'review_comment:12345' or '#issuecomment-67890'.",
        ),
      source_author: z
        .string()
        .max(100)
        .optional()
        .describe("Maintainer login who authored the directive (for provenance)."),
    },
  },
  (input) => {
    const result = buildSaveReviewLearningAction(input);
    if (!result.ok) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ saved: false, reason: result.reason }),
          },
        ],
      };
    }
    appendAction(result.action);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ saved: true, directive: result.action.directive }),
        },
      ],
    };
  },
);

server.registerTool(
  "delete_review_learning",
  {
    description:
      "Remove an outdated or incorrect review-policy directive. Use the ID shown in the <review_learnings> section. Call when a previous directive no longer reflects how this repo should be reviewed.",
    inputSchema: {
      id: z
        .string()
        .min(1)
        .describe("The review-learning ID to delete (UUID from <review_learnings>)."),
    },
  },
  ({ id }) => {
    appendAction({ type: "delete_learning", id });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ deleted: true, id }),
        },
      ],
    };
  },
);

server.registerTool(
  "get_review_learnings",
  {
    description:
      "Retrieve review-policy directives applicable to the current review. Returns the full set the orchestrator loaded for this run, including any rows omitted from the prompt block by the 24KB byte budget (the truncation marker in <review_learnings> points here as its escape hatch). Use it to enumerate every active directive before calling delete_review_learning.",
  },
  () => {
    const payload = REVIEW_LEARNINGS ?? "[]";
    return {
      content: [{ type: "text" as const, text: payload }],
    };
  },
);

// Start

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main();
