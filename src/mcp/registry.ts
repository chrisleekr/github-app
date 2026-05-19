import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { config } from "../config";
import type { DaemonCapabilities } from "../shared/daemon-types";
import type { BotContext, McpServerConfig, McpServerDef } from "../types";
import { context7Server } from "./servers/context7";

/**
 * Resolve the absolute filesystem path of an MCP server module by name.
 * registry.ts is consumed from three locations: unbundled at src/mcp/ in dev
 * (servers exist only as `.ts` siblings), inlined into dist/app.js (servers
 * live one level up at dist/mcp/servers/), and inlined into dist/daemon/main.js
 * (servers live two levels up). After `Bun.build`, `import.meta.url` points at
 * the bundle, not the original source, so the base directory of `./servers/x`
 * shifts per consumer. The compiled `.js` files are always emitted to
 * dist/mcp/servers/ by scripts/build.ts; try each plausible base relative to
 * `import.meta.url` and return the first `existsSync` hit, with `.ts` last as
 * the dev fallback. existsSync (not heuristics on the URL string) keeps this
 * resilient to WORKDIR shapes that contain a `/src/` segment.
 */
function resolveServerPath(name: string): string {
  const candidates = [
    `./servers/${name}.js`, // bundled `.js` sitting next to the registry (rare, kept for symmetry)
    `./mcp/servers/${name}.js`, // bundled: dist/app.js → dist/mcp/servers/
    `../mcp/servers/${name}.js`, // bundled: dist/daemon/main.js → dist/mcp/servers/
    `./servers/${name}.ts`, // dev: src/mcp/registry.ts → src/mcp/servers/<name>.ts
  ];
  const tried: string[] = [];
  for (const candidate of candidates) {
    const resolved = fileURLToPath(new URL(candidate, import.meta.url));
    tried.push(resolved);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- candidate is a hardcoded relative URL; only `name` is dynamic and is constrained to known server names by callers in this file
    if (existsSync(resolved)) return resolved;
  }
  // Surface a clear, actionable error rather than letting bun fail with a
  // bare ENOENT inside an MCP server subprocess (which only shows up as
  // status:"failed" in the SDK init message). Include the absolute paths so
  // a daemon Pod stack trace points directly at the missing files.
  throw new Error(
    `MCP server module not found for "${name}" (registry consumed from ${import.meta.url}). Checked: ${tried.join(", ")}`,
  );
}

/**
 * Resolve which MCP servers to activate based on the BotContext.
 * Returns a map of server name → server definition for the Agent SDK.
 *
 * Extensible: add new servers by creating a file in src/mcp/servers/
 * and registering it here.
 */
export interface RepoMemoryEntry {
  id: string;
  category: string;
  content: string;
  pinned: boolean;
}

export interface ResolveMcpServersOptions {
  daemonCapabilities?: DaemonCapabilities;
  workDir?: string;
  repoMemory?: RepoMemoryEntry[];
  /**
   * Opt-in for the resolve-review-thread MCP server (T029/T030). Set
   * `true` when the agent is running the `resolve` step and the PR has
   * open review threads: keeps the tool out of contexts where it isn't
   * relevant per Constitution VII single-responsibility.
   */
  enableResolveReviewThread?: boolean;
  /**
   * Opt-in for the read-only `github-state` MCP server (issue #117). Set
   * `true` for executors that benefit from on-demand fetches of CI rollup,
   * check-run output, branch protection, PR diff, or paginated comments.
   * Keeps the tool surface out of contexts where the LLM has no reason to
   * reach for fresh GitHub state.
   */
  enableGithubState?: boolean;
  /**
   * Opt-in for the read-only `merge-readiness` MCP server (scheduled-actions
   * auto-merge gate). Set `true` only when a scheduled action's effective
   * `auto_merge` is on, so the deterministic merge-readiness tool is exposed
   * exclusively to runs allowed to merge.
   */
  enableMergeReadiness?: boolean;
}

export function resolveMcpServers(
  ctx: BotContext,
  trackingCommentId: number | undefined,
  installationToken: string,
  opts?: ResolveMcpServersOptions,
): McpServerConfig {
  const servers: McpServerConfig = {};

  const sharedEnv: Record<string, string> = {
    GITHUB_TOKEN: installationToken,
    REPO_OWNER: ctx.owner,
    REPO_NAME: ctx.repo,
  };

  if (trackingCommentId !== undefined) {
    servers["github_comment"] = commentServerDef(sharedEnv, trackingCommentId, ctx.deliveryId);
  }

  if (ctx.isPR) {
    servers["github_inline_comment"] = inlineCommentServerDef(sharedEnv, ctx.entityNumber);
    if (opts?.enableResolveReviewThread === true) {
      servers["resolve_review_thread"] = resolveReviewThreadServerDef(sharedEnv, ctx.entityNumber);
    }
  }

  if (config.context7ApiKey !== undefined && config.context7ApiKey !== "") {
    servers["context7"] = context7Server();
  }

  if (opts?.enableGithubState === true) {
    servers["github_state"] = githubStateServerDef(sharedEnv);
  }

  if (opts?.enableMergeReadiness === true) {
    servers["merge_readiness"] = mergeReadinessServerDef(sharedEnv);
  }

  // Tier 3, R-011, daemon capabilities MCP server
  if (opts?.daemonCapabilities !== undefined) {
    servers["daemon_capabilities"] = daemonCapabilitiesServerDef(opts.daemonCapabilities);
  }

  // Repo memory MCP server, persistent learnings across executions
  if (opts?.workDir !== undefined) {
    servers["repo_memory"] = repoMemoryServerDef(opts.workDir, opts.repoMemory ?? []);
  }

  return servers;
}

/**
 * Comment server definition (stdio transport).
 * Runs as a child process with env vars for the specific request.
 */
function commentServerDef(
  sharedEnv: Record<string, string>,
  trackingCommentId: number,
  deliveryId: string,
): McpServerDef {
  const serverPath = resolveServerPath("comment");
  return {
    type: "stdio",
    command: "bun",
    args: ["run", serverPath],
    env: {
      ...sharedEnv,
      CLAUDE_COMMENT_ID: trackingCommentId.toString(),
      // Passed so comment.ts can re-prepend the delivery marker after sanitizeContent strips it.
      DELIVERY_ID: deliveryId,
    },
  };
}

/**
 * Inline comment server definition (stdio transport, PRs only).
 */
function inlineCommentServerDef(sharedEnv: Record<string, string>, prNumber: number): McpServerDef {
  const serverPath = resolveServerPath("inline-comment");
  return {
    type: "stdio",
    command: "bun",
    args: ["run", serverPath],
    env: {
      ...sharedEnv,
      PR_NUMBER: prNumber.toString(),
    },
  };
}

/**
 * Resolve-review-thread server definition (stdio transport, PRs only,
 * opt-in via `enableResolveReviewThread`). Bound to a single PR at
 * construction; the server refuses to resolve threads on other PRs
 * (T029 contract §Security).
 */
function resolveReviewThreadServerDef(
  sharedEnv: Record<string, string>,
  prNumber: number,
): McpServerDef {
  const serverPath = resolveServerPath("resolve-review-thread");
  return {
    type: "stdio",
    command: "bun",
    args: ["run", serverPath],
    env: {
      ...sharedEnv,
      PR_NUMBER: prNumber.toString(),
    },
  };
}

/**
 * Read-only github-state server definition (stdio transport, opt-in via
 * `enableGithubState`). Hard-pinned to the current repo via env so the
 * model cannot fan out to arbitrary repos.
 */
function githubStateServerDef(sharedEnv: Record<string, string>): McpServerDef {
  const serverPath = resolveServerPath("github-state");
  return {
    type: "stdio",
    command: "bun",
    args: ["run", serverPath],
    env: { ...sharedEnv },
  };
}

/**
 * Read-only merge-readiness server definition (stdio transport, opt-in via
 * `enableMergeReadiness`). Repo-pinned via env; `BOT_APP_LOGIN` lets
 * `computeVerdict` distinguish bot- from human-authored head commits.
 */
function mergeReadinessServerDef(sharedEnv: Record<string, string>): McpServerDef {
  const serverPath = resolveServerPath("merge-readiness");
  return {
    type: "stdio",
    command: "bun",
    args: ["run", serverPath],
    env: { ...sharedEnv, BOT_APP_LOGIN: config.botAppLogin },
  };
}

/**
 * Daemon capabilities MCP server definition (stdio transport).
 * Passes the full DaemonCapabilities JSON via env var.
 */
function daemonCapabilitiesServerDef(capabilities: DaemonCapabilities): McpServerDef {
  const serverPath = resolveServerPath("daemon-capabilities");

  return {
    type: "stdio",
    command: "bun",
    args: ["run", serverPath],
    env: {
      DAEMON_CAPABILITIES: JSON.stringify(capabilities),
    },
  };
}

/**
 * Repo memory MCP server definition (stdio transport).
 * Passes the workDir and pre-loaded memory via env vars.
 */
function repoMemoryServerDef(workDir: string, memory: RepoMemoryEntry[]): McpServerDef {
  const serverPath = resolveServerPath("repo-memory");

  return {
    type: "stdio",
    command: "bun",
    args: ["run", serverPath],
    env: {
      WORK_DIR: workDir,
      REPO_MEMORY: JSON.stringify(memory),
    },
  };
}
