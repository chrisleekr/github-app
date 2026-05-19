# Contributing

Thank you for contributing to `@chrisleekr-bot`. This guide covers local setup,
the development workflow, and the conventions enforced by the tooling.

---

## Prerequisites

| Tool                          | Version  | Purpose                                    |
| ----------------------------- | -------- | ------------------------------------------ |
| [Bun](https://bun.sh)         | ≥ 1.3.14 | Runtime and package manager                |
| [Git](https://git-scm.com)    | any      | Version control                            |
| [Node.js](https://nodejs.org) | ≥ 20     | Required by the Claude Code CLI subprocess |

---

## Local Setup

```bash
# 1. Clone the repository
git clone https://github.com/chrisleekr/github-app-playground.git
cd github-app-playground

# 2. Install dependencies (also installs Husky pre-commit hooks)
bun install

# 3. Copy and fill in the environment file
cp .env.example .env
# Edit .env: see docs/operate/setup.md for the full variable reference
```

---

## Development Workflow

### Start the server in watch mode

```bash
bun run dev
```

The server starts on `PORT` (default `3000`) and restarts automatically on file changes.

### Expose the server for webhook delivery (optional)

GitHub must reach your webhook URL over the internet. Use a tunnelling tool during development:

```bash
# ngrok: generates a public HTTPS URL
bun run dev:ngrok   # alias for: ngrok http 3000
```

Paste the generated URL into the GitHub App webhook settings.

---

## Testing

```bash
bun test                  # run all tests once (with coverage by default via bunfig.toml)
bun run test:watch        # re-run on file changes
bun run test:coverage     # explicit coverage report (output in coverage/)
```

Test files live in `test/` and mirror the `src/` directory structure.

**Coverage threshold**: `bunfig.toml` enforces a per-file minimum of **90%
lines and 90% functions** via Bun's native `coverageThreshold`. Any PR that
drops a file below either threshold will fail `bun test` locally and in CI.

**Mocking**: External dependencies (GitHub API, Claude Agent SDK, git CLI)
MUST be mocked in tests, no real API calls in the test suite. See the
existing `test/webhook/router.test.ts` for the project's mocking patterns
using Bun's `mock.module()`.

### Database-backed integration tests

Some suites run against a real Postgres + Valkey instance instead of
mocks. They are identified by **a `describe.skipIf(sql === null)` (or
equivalent) gate against `process.env["TEST_DATABASE_URL"]`**: that is
the contract, not the file list below. Locate every current opt-in suite
with `grep -rn 'TEST_DATABASE_URL' test/`. Each suite skips cleanly when
the services are unreachable, so a default `bun test` works without
local infrastructure, but those suites only **exercise** their
assertions when both services are running.

Today's suites covered by this contract:

| Suite                                           | What it covers                                                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `test/db/migrate.test.ts`                       | Applies every SQL migration on a fresh DB and asserts the schema shape.                                          |
| `test/integration/repo-knowledge.test.ts`       | Regression test for the `Bun.sql` UUID-array binding bug fixed in commit `d5e1b17`.                              |
| `test/integration/telemetry-aggregates.test.ts` | Operator aggregate queries in `src/db/queries/dispatch-stats.ts` across every `DispatchReason`.                  |
| `test/webhook/events/issue-comment.test.ts`     | Asserts the comment-trigger and label-trigger paths produce indistinguishable `workflow_runs` rows.              |
| `test/workflows/runs-store.test.ts`             | CRUD shape and defaults for the `workflow_runs` state store.                                                     |
| `test/workflows/handlers/ship.test.ts`          | Resume semantics for the `ship` composite workflow (T027 prior-failure carry-forward).                           |
| `test/workflows/orchestrator.test.ts`           | Composite-workflow chaining: each child success enqueues the next, terminal child flips parent to `succeeded`.   |
| `test/orchestrator/liveness-reaper.test.ts`     | Heartbeat-based reaper flips abandoned in-flight rows to `failed` once the owning daemon/orchestrator goes dark. |

When you add a new suite that touches Postgres, gate it on
`process.env["TEST_DATABASE_URL"]` the same way and **drop every table
your migrations create** in `beforeAll`/`afterAll` (`_migrations`,
`workflow_runs`, `repo_memory`, `triage_results`, `executions`,
`daemons`, …), Bun runs each test file in its own process under
`scripts/test-isolated.sh`, so any table left behind by an earlier file
makes the next file's migration re-run fail with `relation … already
exists`. There is no need to update this section's table when adding a
new suite: the contract above is what readers should follow.

To run them locally:

```bash
# 1. Bring up Postgres + Valkey via Docker Compose
bun run dev:deps

# 2. Run the suite: defaults match docker-compose.dev.yml
bun test
```

The defaults baked into the test files are:

- `TEST_DATABASE_URL=postgres://bot:bot@localhost:5432/github_app_test`
- `VALKEY_URL=redis://localhost:6379` (default applied by `test/preload.ts`)

Override either env var if you point the suites at a different host.

> [!WARNING]
> `test/integration/repo-knowledge.test.ts` is **destructive**: its
> `beforeAll` hook drops and re-creates the `repo_memory`,
> `triage_results`, `executions`, `daemons`, and `workflow_runs` tables.
> To prevent accidental data loss against a development DB, this suite
> is opt-in: it only runs when `TEST_DATABASE_URL` is **explicitly
> set**. Set it on the CLI (`TEST_DATABASE_URL=… bun test`) and aim it
> at a throwaway database, never your `DATABASE_URL` target.

CI provisions Postgres-17 and Valkey-9 as service containers and exports
`TEST_DATABASE_URL` + `VALKEY_URL` on the `Test` step (see
`.github/workflows/ci.yml`), so PRs run these suites end-to-end on every
push. `scripts/test-isolated.sh` treats any non-zero `skip` count as a
failure, so a silent skip, caused by, for example, a missing service
container or a broken `TEST_DATABASE_URL`, fails the build instead of
masquerading as green.

---

## Code Quality

Before opening a pull request, run the unified quality gate: it runs
typecheck, lint, format check, and tests sequentially:

```bash
bun run check
```

Equivalent to running these four commands in order:

```bash
bun run typecheck     # TypeScript strict type check (no emit)
bun run lint          # ESLint check
bun run format        # Prettier format check
bun test              # Tests with coverage threshold enforcement
```

Auto-fix helpers (run individually as needed):

```bash
bun run lint:fix      # ESLint auto-fix
bun run format:fix    # Prettier auto-fix
```

### Pre-commit hooks

These checks are enforced by Husky on every commit:

- **pre-commit** runs, in order:
  1. `gitleaks protect --verbose --staged --config .gitleaks.toml` scans
     staged files for secrets (API keys, tokens, private keys). The
     `gitleaks` binary is **required**, install via `brew install gitleaks`
     on macOS, `sudo apt install gitleaks` on Debian/Ubuntu, or
     `go install github.com/gitleaks/gitleaks/v8@latest`. The hook fails
     closed: if the binary is missing, the commit is blocked with install
     guidance.
  2. `lint-staged` runs Prettier + ESLint on staged `.ts`/`.js` files and
     Prettier on staged `.json`/`.md`/`.yml` files.
- **commit-msg**: `commitlint` validates the commit message format.

Allowlist false positives in `.gitleaks.toml` rather than bypassing the hook
with `--no-verify`. CI also runs gitleaks on every push to branches except
`gh-pages` via `.github/workflows/secrets-scan.yml`, independently of the
main CI pipeline, so a bypassed local hook still fails the build.

---

## Commit Message Format

Commit messages are validated by
[commitlint](https://commitlint.js.org) using the
[Conventional Commits](https://www.conventionalcommits.org) specification.

### Format

```
<type>(<scope>): <subject>

[optional body]

[optional footer(s)]
```

### Allowed types

| Type       | When to use                                           |
| ---------- | ----------------------------------------------------- |
| `feat`     | A new feature                                         |
| `fix`      | A bug fix                                             |
| `docs`     | Documentation changes only                            |
| `style`    | Formatting, whitespace, no logic change               |
| `refactor` | Code change that is neither a fix nor a feature       |
| `test`     | Adding or updating tests                              |
| `chore`    | Build scripts, dependency updates, tooling            |
| `perf`     | Performance improvement                               |
| `build`    | Build system or external dependency changes           |
| `ci`       | CI/CD configuration changes                           |
| `revert`   | Reverts a previous commit                             |
| `localize` | Internationalisation / translation changes            |
| `bump`     | Version bump (typically automated by release tooling) |

### Examples

```bash
feat(mcp): add Slack notification MCP server
fix(checkout): handle empty branch name on issue events
docs: fix Section 7 anchor link in SETUP.md
test(router): add duplicate delivery idempotency test
chore: upgrade @anthropic-ai/claude-agent-sdk to 0.3.0
```

---

## Pull Request Guidelines

- Keep each PR focused on a single concern.
- Fill in the PR template (`.github/PULL_REQUEST_TEMPLATE.md`).
- All checks must pass before requesting review:
  - `bun test`: all tests green
  - `bun run typecheck`: no type errors
  - `bun run lint`: no lint errors
  - `bun run format`: no formatting violations

---

## Project Structure

See [docs/build/architecture.md](docs/build/architecture.md) for the full directory layout and
request flow. See [docs/build/extending.md](docs/build/extending.md) for how to add new webhook
event handlers and MCP servers.
