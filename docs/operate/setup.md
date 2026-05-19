# Local development setup

This page covers running the bot on your laptop against a real GitHub App. For first-time GitHub App creation, see [`github-app.md`](github-app.md). For production deployment, see [`deployment.md`](deployment.md).

## Prerequisites

| Tool                    | Version                                    | Purpose                                                                          |
| ----------------------- | ------------------------------------------ | -------------------------------------------------------------------------------- |
| [Bun](https://bun.sh)   | from `.tool-versions` (currently `1.3.14`) | Runtime and package manager.                                                     |
| Git                     | any                                        | Repository checkout during agent execution.                                      |
| Docker                  | any recent                                 | Local Postgres + Valkey via `docker-compose.dev.yml`.                            |
| GitHub account          | _none_                                     | Admin access to the org or personal account where the App is registered.         |
| Tunnelling tool         | _none_                                     | ngrok or smee.io to expose `localhost:3000` to GitHub.                           |
| AI provider credentials | _none_                                     | One of: Anthropic API key, Claude Code OAuth token, AWS credentials for Bedrock. |

## First run

```bash
git clone https://github.com/chrisleekr/github-app-playground.git
cd github-app-playground
bun install

# Start Postgres + Valkey in the background
bun run dev:deps

# Copy and fill .env
cp .env.example .env
# Edit .env: see configuration.md for every variable.

# Run database migrations
bun run db:migrate

# Run in watch mode
bun run dev
```

The HTTP server binds to `PORT` (default `3000`). Hit `http://localhost:3000/healthz` to confirm it's up; `http://localhost:3000/readyz` confirms the data layer is reachable.

## Expose the local server

GitHub must reach your webhook URL over the internet.

```bash
# Wrapped script: ngrok on port 3000
bun run dev:ngrok
# Copy the https://....ngrok.io URL into the GitHub App's webhook URL field.
```

Alternative, smee.io:

```bash
smee --url https://smee.io/<your-channel> --path /api/github/webhooks --port 3000
```

The local trigger phrase is conventionally `@chrisleekr-bot-dev` (set `TRIGGER_PHRASE` in `.env`) so the dev installation does not collide with the production bot's mention.

## Common dev commands

```bash
bun run dev             # Watch mode
bun run start           # Production binary (after bun run build)
bun run build           # Compile to dist/

bun run check           # Unified gate: typecheck + lint + format + tests + no-destructive
bun run typecheck       # tsc --noEmit
bun run lint            # ESLint
bun run lint:fix        # ESLint auto-fix
bun run format          # Prettier check
bun run format:fix      # Prettier auto-fix

bun test                # Run tests via scripts/test-isolated.sh (Bun mock isolation)
bun run test:fast       # Direct bun test (no isolation)
bun run test:watch      # Watch mode
bun run test:coverage   # With coverage report

bun run audit:ci        # Severity-gated bun audit (used by CI)
bun run db:migrate      # Run migrations against DATABASE_URL
bun run dev:deps        # Up Postgres + Valkey
bun run dev:deps:down   # Tear down
bun run dev:daemon      # Run a daemon locally against the running orchestrator

bun run docs:install    # Install MkDocs Python deps (one-time)
bun run docs:serve      # Live-reload preview at http://localhost:8000
bun run docs:build      # Strict build (CI also runs this)
```

`bun run check` is the single command to run before opening a PR.

## Running a daemon locally

The webhook server embeds an orchestrator that talks to daemons over WebSocket. To exercise the full pipeline locally:

```bash
# Terminal 1: orchestrator (webhook server)
bun run dev

# Terminal 2: local daemon
bun run dev:daemon
```

The daemon connects back to `ws://localhost:3002` (`WS_PORT`) using `DAEMON_AUTH_TOKEN` from `.env`. From there, every `@chrisleekr-bot-dev` mention exercises the full webhook → orchestrator → daemon → pipeline path.

## Testing webhook delivery

1. Open an issue or PR in a repository where your dev App is installed.
2. Comment `@chrisleekr-bot-dev triage this`.
3. The bot creates a tracking comment within ~2 s.

If nothing happens, check:

| Symptom                              | Likely cause                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| 401 / 403 in tunnel logs             | `GITHUB_WEBHOOK_SECRET` mismatch with the App settings (no trailing newline).                                |
| 200 OK but no comment                | `ALLOWED_OWNERS` excludes the repo owner; or `MAX_CONCURRENT_REQUESTS` is saturated.                         |
| `GITHUB_APP_PRIVATE_KEY` parse error | Set the full PEM including `-----BEGIN…` / `-----END…` lines (literal `\n` is normalised).                   |
| `ANTHROPIC_API_KEY is required`      | `CLAUDE_PROVIDER` defaults to `anthropic`; set the key or switch to `bedrock`.                               |
| Bot mention ignored locally          | `TRIGGER_PHRASE` is unchanged from the default `@chrisleekr-bot`; the dev App expects `@chrisleekr-bot-dev`. |
