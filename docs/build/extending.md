# Extending

Two extension points in this codebase: workflow handlers and MCP servers. Both follow a consistent registry pattern.

## Adding a workflow

A workflow is a verb the bot performs on a target (issue or PR). Six are registered today; adding a seventh is appending one entry to `src/workflows/registry.ts` plus a handler file.

### Step 1: write the handler

`src/workflows/handlers/<name>.ts` exports a `WorkflowHandler` (`src/workflows/registry.ts`):

```typescript
export type WorkflowHandler = (ctx: WorkflowRunContext) => Promise<HandlerResult>;
```

`WorkflowRunContext` carries:

| Field                           | Type                                           | Notes                                         |
| ------------------------------- | ---------------------------------------------- | --------------------------------------------- |
| `runId`                         | string                                         | Unique run identifier.                        |
| `workflowName`                  | `WorkflowName`                                 | Which workflow is executing.                  |
| `target`                        | `{type: "issue" \| "pr", owner, repo, number}` | GitHub entity.                                |
| `parent`                        | `{runId, stepIndex}` \| undefined              | Set when this is a child step of a composite. |
| `logger`                        | `pino.Logger`                                  | Structured logging.                           |
| `octokit`                       | `Octokit`                                      | API client with installation token.           |
| `deliveryId`                    | string \| null                                 | Webhook delivery id for tracing.              |
| `daemonId`                      | string                                         | Daemon process id.                            |
| `setState(state, humanMessage)` | function                                       | Persist partial state mid-execution.          |

`HandlerResult` is a discriminated union:

```typescript
| { status: "succeeded"; state: unknown; humanMessage?: string }
| { status: "failed"; reason: string; state?: unknown; humanMessage?: string }
| { status: "handed-off"; state?: unknown; humanMessage?: string; childRunId: string }
```

Capture exactly one Markdown artifact (`<NAME>.md`) so the tracking comment is self-documenting; the executor finalises the comment with `state.report` if present.

### Step 2: register

Append one `RegistryEntry` to `rawRegistry` in `src/workflows/registry.ts`:

```typescript
{
  name: "my-verb",
  label: "bot:my-verb",
  context: "pr",            // "issue" | "pr" | "both"
  requiresPrior: null,      // or another WorkflowName
  steps: [],                // composite workflows fill this
  handler: myVerbHandler,
}
```

The Zod schema validates at module load: a mistyped entry fails the process at boot.

| Field           | Type                        | Notes                                    |
| --------------- | --------------------------- | ---------------------------------------- |
| `name`          | `WorkflowName` (enum)       | Add to `WorkflowNameSchema` first.       |
| `label`         | `^bot:[a-z]+$`              | Hyphens allowed.                         |
| `context`       | `"issue" \| "pr" \| "both"` | Where the workflow may run.              |
| `requiresPrior` | `WorkflowName \| null`      | Workflow that must have succeeded first. |
| `steps`         | `WorkflowName[]`            | Empty for leaf; populated for composite. |
| `handler`       | `WorkflowHandler`           | Function reference.                      |

### Step 3: make it discoverable from comments

If the workflow should be reachable via mentions, extend the system prompt in `src/workflows/intent-classifier.ts` with at least three fixture comments and add it to `test/workflows/fixtures/intent-comments.json`. The enum the classifier returns is driven by the registry; the prompt narrative just needs to mention the new verb so the classifier picks it.

### Step 4: document and test

- Add `docs/use/workflows/<name>.md` matching the template used by the six built-ins.
- Add `test/workflows/handlers/<name>.test.ts` covering the happy path and one failure mode. Integration via `test/workflows/dispatcher.test.ts` is automatic: if the registry entry is valid, dispatch works.
- The `check:docs-sync` script in CI fails any PR that touches `src/workflows/**` without updating the workflow docs tree.

## Adding an MCP server

The MCP registry lives at `src/mcp/registry.ts`. `resolveMcpServers()` returns a `Map<name, McpServerDef>` for the current request, conditionally activating servers based on context, options, and config.

### Existing servers

| Name                    | Transport | Purpose                                                                                                                  |
| ----------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------ |
| `comment_update`        | stdio     | Updates the tracking comment owned by the bot. Always on.                                                                |
| `inline_comments`       | stdio     | Posts inline review comments and replies on PR diffs. PR runs only.                                                      |
| `resolve_review_thread` | stdio     | Resolves a single PR review thread, bound to one `(owner, repo, pullNumber)` per server instance. Wired by `resolve.ts`. |
| `daemon_capabilities`   | stdio     | Reports the executing daemon's local environment (CPU, memory, language toolchain) to the agent.                         |
| `repo_memory`           | stdio     | Persistent per-repo memory keyed by `(owner, repo, category)`. Backed by the `repo_memory` Postgres table.               |
| `context7`              | http      | Library documentation snippets via Upstash Context7. Auto-skipped when `CONTEXT7_API_KEY` is unset.                      |

### Transport types

| Type    | When to use                                                      | Example           |
| ------- | ---------------------------------------------------------------- | ----------------- |
| `stdio` | Local process; needs per-request secrets injected via env vars.  | `comment_update`. |
| `http`  | Remote service with a stable URL; no per-request process needed. | `context7`.       |

### Option A: stdio server

`src/mcp/servers/<name>.ts`:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const MY_VAR = process.env["MY_VAR"];
if (!MY_VAR) {
  console.error("Error: MY_VAR is required");
  process.exit(1);
}

const server = new McpServer({ name: "My Server", version: "1.0.0" });

server.tool(
  "my_tool",
  "Description Claude sees when deciding whether to use this tool",
  { input: z.string().describe("Tool input") },
  async ({ input }) => ({ content: [{ type: "text" as const, text: "result" }] }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.on("exit", () => void server.close());
```

Add a helper in `src/mcp/registry.ts`:

```typescript
function myServerDef(sharedEnv: Record<string, string>): McpServerDef {
  return {
    type: "stdio",
    command: "bun",
    args: ["run", "src/mcp/servers/my-server.ts"],
    env: { ...sharedEnv, MY_VAR: "value" },
  };
}
```

Then add the conditional to `resolveMcpServers()`:

```typescript
servers["my_server"] = myServerDef(sharedEnv);
```

`sharedEnv` already carries `GITHUB_TOKEN`, `REPO_OWNER`, `REPO_NAME`, and `GITHUB_EVENT_NAME`.

The Dockerfile copies all of `src/mcp/` to the production image, so new server files are picked up automatically. No Dockerfile change is needed. **Bundling is not automatic**, however, add the new entrypoint to `scripts/build.ts` (Build 2's `entrypoints` array) so `dist/mcp/servers/<name>.js` exists in production.

### Sharing a tool surface between MCP and single-turn callers

The `runWithTools` loop in `src/ai/llm-client.ts` lets single-turn LLM callers (e.g. `chat-thread`, orchestrator `triage`) call tools without going through MCP. To share one tool implementation between Agent SDK callers (which dispatch through the MCP subprocess) and single-turn callers (which dispatch inline), put the tool body in `src/github/state-fetchers.ts`-style fetcher module:

- Export the fetcher functions (pure async, return JSON-serialised strings).
- Export a `LLMTool[]` descriptor array mirroring the MCP server's advertised tools.
- Export a `dispatchXTool(deps, call)` switch that the single-turn caller passes as `onToolCall`.
- The MCP server (e.g. `src/mcp/servers/github-state.ts`) becomes a thin stdio wrapper that calls the same fetchers.

`src/github/state-fetchers.ts` (issue #117) is the reference implementation.

### Option B: HTTP server

```typescript
export function myRemoteServer(): McpServerDef {
  return {
    type: "http",
    url: "https://my-service.example.com/mcp",
    headers: { Authorization: `Bearer ${process.env["MY_API_KEY"]}` },
  };
}
```

Register conditionally on credentials:

```typescript
if (config.myApiKey) {
  servers["my_remote"] = myRemoteServer();
}
```

Add the env var to `src/config.ts` following the existing `context7ApiKey` pattern, document it in [`../operate/configuration.md`](../operate/configuration.md), and you're done.

### Conditionally-registered servers

A server need not be registered on every run. `github-state` is registered
only when `enableGithubState` is set, and `merge_readiness` (the scheduled-
actions auto-merge gate) only when `enableMergeReadiness` is set: the daemon
passes that flag only for a scheduled action whose effective `auto_merge` is
on. Add an `enableX?: boolean` to `ResolveMcpServersOptions` and gate the
`servers["x"] = …` line on it. MCP servers in `src/mcp/servers/` must not
import the daemon `config`; pass everything they need via env (see
`merge-readiness.ts`, which takes `BOT_APP_LOGIN` from env rather than
importing `config`).

## The webhook → workflow boundary

If your extension reacts to a GitHub event the bot does not yet handle (e.g. `push`, `pull_request_target`), the work splits in two:

1. **Subscribe** to the event in the GitHub App settings (Permissions & events).
2. **Add a webhook handler** in `src/webhook/events/<event>.ts` that parses the payload and dispatches via `dispatchByLabel` (label path) or `dispatchByIntent` (comment path). Webhook handlers must return within 10 s, fire `processRequest` with fire-and-forget semantics.
3. **Register the event handler** in `src/app.ts` alongside the existing `app.webhooks.on(...)` calls.

Webhook handlers do **not** run business logic, they parse the event, build a `BotContext`, and dispatch. All bot work happens in workflow handlers, called from the daemon.
