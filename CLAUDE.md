# CLAUDE.md

GitHub App that answers `@chrisleekr-bot` mentions and label triggers on PRs and issues by running the Claude Agent SDK against a clone of the repo. Full docs live in `docs/` (published at <https://chrisleekr.github.io/github-app/>); start with `docs/build/architecture.md`.

## Commands

```bash
bun install             # Install dependencies
bun run dev             # Run in watch mode
bun run test            # Run tests, one Bun process per file (plain `bun test` hangs)
bun run typecheck       # TypeScript type checking
bun run lint            # Oxlint, type-aware (lint:fix to auto-fix)
bun run format          # Prettier check (format:fix to auto-fix)
bun run check           # Every CI gate: typecheck, lint, format, check:*, test
bun run dev:deps        # Start local Valkey + Postgres (dev:deps:down to stop)
bun run docs:build      # Strict MkDocs build, as CI runs it
```

Also run `bun run check:no-em-dashes` and `bun run check:docs-sync` before committing docs or `src/workflows/` changes; they are not part of typecheck/lint/test.

## Layout

- `src/app.ts`: HTTP server. Webhooks are verified, parsed in `src/webhook/events/` (one file per event), then dispatched. The webhook server never runs the agent itself.
- `src/orchestrator/`: WebSocket server, job queue, daemon registry, workflow-runner admission and leases.
- `src/daemon/`: shared daemon worker (persistent or ephemeral). `src/runner/`: one-attempt isolated runner for structured `workflow-run` jobs. `src/k8s/`: Pod spawners for both.
- `src/core/pipeline.ts`: the single agent execution path (fetch, prompt, checkout, execute, finalize).
- `src/workflows/`: triage, plan, implement, review, resolve, ship. `src/repo-config/`: per-repo `.github-app.yaml`. `src/scheduler/`: cron scheduled actions.
- `src/mcp/`: MCP servers given to the agent. `src/db/`: Postgres via `Bun.sql` + migrations.

## Conventions

- Bun runtime (version pinned in `.tool-versions`), Node.js only for the Claude Code CLI. Strict TypeScript, zod-validated config, pino structured logs.
- Tests live only under `test/<mirror path>/*.test.ts`. A test under `src/` is unreachable and fails `check:test-globs`.
- Conventional commits (commitlint). Husky + lint-staged run on commit.
- GitHub Actions are SHA-pinned and runners are pinned to explicit images; CI fails otherwise.
- The Dockerfile `CLAUDE_CODE_VERSION` ARG must equal the installed `@anthropic-ai/claude-agent-sdk`'s `claudeCodeVersion`; bump them together.
- Generated files must be regenerated and committed: `bun run gen-config-schema` after `src/repo-config/schema.ts` changes, `bun run env-contract` after `src/config.ts` env changes.
- `docs/` must stay in sync with the code it describes, in the same PR. `src/<file>:<line>` citations and Bun versions in docs are checked by CI. See `docs/build/conventions.md` § "Documentation discipline" for the file-to-page map.

## Hard rules

Code comments elsewhere refer to these by name. Details in `docs/build/architecture.md` and `docs/use/safety.md`.

1. **Subprocess env allowlist** (`src/core/executor.ts buildProviderEnv`): the agent CLI gets an explicit allowlist, never `...process.env`. App keys, webhook secret, daemon/runner auth tokens, DB/Valkey URLs, Context7 key, and the PAT must never reach it.
2. **Output secret-strip chokepoint** (`src/utils/github-output-guard.ts safePostToGitHub`): route GitHub writes through it. Redaction strips bytes silently (no `[REDACTED]` markers on output). The LLM scanner's substitution is accepted only if deletion-only; do not relax that.
3. **Input sanitization chokepoint** (`src/utils/sanitize.ts sanitizeContent`): every attacker-controllable string reaching `buildPrompt` (titles, bodies, comments, branch names, paths, filenames) is sanitized at its formatter site.
4. **Structured-output chokepoint** (`src/ai/structured-output.ts parseStructuredResponse` + `withStructuredRules`): never `JSON.parse` LLM output directly.
5. **Runtime destructive-Bash gate** (`src/core/hooks/forbidden-bash.ts`, patterns in `src/utils/forbidden-bash.ts`, shared with `check:no-destructive`): no force-push, `reset --hard`, or merges by the agent. Never log the denied command.
6. **Structured-workflow isolation**: a `workflow-run` never enters the shared-daemon protocol. One attempt owns one Pod and capability Secret; every mutation is fenced by run, attempt, owner, lease, and receipt. PAT mode fails closed for these.
7. **Idempotency**: side-effecting webhook handlers call `claimDelivery(deliveryId)` first, before any LLM call, DB insert, or GitHub write. It fails open. Sibling branches on one delivery use suffixed keys (`:config-check`, `:auto-review`).
8. **Repo config is read from the default branch only**: never add a `ref` to `fetchRepoConfig`'s `getContent` call. Gate 1 (`src/repo-config/gate.ts`) can only refuse, never permit past `ALLOWED_OWNERS`; every dispatch path must call it.
9. `triggerUsername` containing whitespace is rejected, not stripped (commit-trailer forgery).

## Auth

Claude: `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` (requires single-owner `ALLOWED_OWNERS`), or Bedrock (`CLAUDE_PROVIDER=bedrock` + explicit `CLAUDE_MODEL`). GitHub: App installation token by default; `GITHUB_PERSONAL_ACCESS_TOKEN` overrides it on legacy/scoped paths and also requires a single owner. See `docs/operate/configuration.md`.
