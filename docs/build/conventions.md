# Code conventions

The repo enforces conventions through tooling, not docs, every rule below is checked by `bun run check`. This page is a tour of what's wired so you know what to expect.

## Runtime and language

- **Runtime.** Bun for the application; Node.js 20 for the Claude Code CLI subprocess. Both are installed in the Docker `base` stage.
- **Bun version.** Pinned in `.tool-versions` (`bun 1.3.14`). All workflows use `oven-sh/setup-bun` with `bun-version-file: .tool-versions`.
- **TypeScript.** Strict mode plus the strictest flags: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `useUnknownInCatchVariables`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`. Module resolution is `bundler`, imports do not need `.js` extensions.

## ESLint

`eslint.config.mjs` is the flat config:

- **Preset.** `@eslint/js` recommended + `typescript-eslint:strictTypeChecked` + `stylisticTypeChecked`.
- **Plugins.** `eslint-plugin-security`, `eslint-plugin-simple-import-sort`, `prettier`.
- **Notable rules.**
  - `@typescript-eslint/strict-boolean-expressions: error`
  - `@typescript-eslint/no-explicit-any: warn`
  - `@typescript-eslint/no-unused-vars` (underscore-prefix exempted)
  - `simple-import-sort/imports`, `simple-import-sort/exports`: auto-fixable
  - `complexity: warn` (15), `max-lines-per-function: warn` (120), `max-nested-callbacks: error` (3)
  - Security rules from `eslint-plugin-security:recommended`
- **Special restriction.** `src/workflows/ship/scoped/triage.ts` carries a `no-restricted-syntax` rule forbidding GitHub mutations: ship-side triage is suggest-only.

## Prettier

`.prettierrc`:

| Rule             | Value      |
| ---------------- | ---------- |
| `semi`           | `true`     |
| `singleQuote`    | `false`    |
| `trailingComma`  | `"all"`    |
| `printWidth`     | `100`      |
| `tabWidth`       | `2`        |
| `endOfLine`      | `"lf"`     |
| `arrowParens`    | `"always"` |
| `bracketSpacing` | `true`     |

## Em dashes

The repo-wide style rule (per `~/.claude/CLAUDE.md`) forbids em dashes (U+2014). Use commas, colons, semicolons, or parentheses instead. Enforced in CI via `scripts/em-dash-sweep.ts --check` (also wired into the umbrella `bun run check`). The check skips `specs/`, `src/db/migrations/`, `CHANGELOG.md`, `test/**/fixtures/`, build outputs, and spec-kit-managed assets (`.specify/`, `.claude/skills/speckit*`, `.github/agents/speckit*`); those are sync'd from upstream and editing them in-repo gets clobbered. To remediate an offending line locally, run `bun run scripts/em-dash-sweep.ts <path>` to apply the heuristic rewrite, then hand-review the result. See issue #116 for the original sweep.

## Pre-commit hooks

`.husky/pre-commit`:

1. `gitleaks protect --staged`, secret scan. Hard exit 1 if `gitleaks` is missing.
2. `bunx lint-staged`, Prettier and ESLint on staged files.

`.husky/commit-msg` runs `commitlint` against `@commitlint/config-conventional`. Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `build`, `ci`, `revert`, `localize`, `bump`.

## Logging

- Structured JSON via `pino` with child loggers per request.
- The ship workflow draws every `event` value from the typed `SHIP_LOG_EVENTS` constant in `src/workflows/ship/log-fields.ts` so a typo is a compile error. See [`../operate/observability.md`](../operate/observability.md).

## Configuration

- All process-level configuration is validated via `zod` at startup in `src/config.ts`. The process exits with a clear error if any required variable is missing or malformed.
- Environment variable group is the canonical doc surface: see [`../operate/configuration.md`](../operate/configuration.md).

## Scripts

The full list lives in [`../operate/setup.md`](../operate/setup.md#common-dev-commands). For PRs, what matters is `bun run check`:

```bash
bun run check
# typecheck + lint + format + check:no-destructive + check:docs-sync + tests
```

`bun run audit:ci` (used by CI) wraps `bun audit --json` to gate on severity:

- Blocks on `high` and `critical` advisories.
- Warns on `moderate` and `low`.
- Inline GHSA allowlist in `IGNORED` array; each entry has `ghsa`, `reason`, and `expires` (ISO date). Expired entries become warnings on next run.

## CI pipeline

Five workflow files form the pipeline; each owns one responsibility.

| Workflow                             | Trigger                                                   | Owns                                                                                                              |
| ------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`           | `pull_request` + `push: main` + `workflow_call`           | Quality gates only: typecheck, lint, format, audit:ci, test, build                                                |
| `.github/workflows/secrets-scan.yml` | `push: branches-ignore: [gh-pages]` + `workflow_dispatch` | Standalone gitleaks scan, decoupled so every push (incl. chore/docs) is gated                                     |
| `.github/workflows/dev-release.yml`  | `push: branches-ignore: [main, v*]` + `workflow_dispatch` | Calls `ci.yml` → semantic-release dev (pre-release tag) → `docker-build.yml`                                      |
| `.github/workflows/release.yml`      | `workflow_dispatch` only (manual)                         | Calls `ci.yml` → semantic-release prod → `docker-build.yml`                                                       |
| `.github/workflows/docker-build.yml` | `workflow_call` + `workflow_dispatch`                     | Reusable image builder: matrix split-and-merge (amd64 on `ubuntu-24.04`, arm64 on `ubuntu-24.04-arm`), Trivy scan |

Notes:

- **Multi-arch images.** amd64 builds on `ubuntu-24.04`, arm64 builds natively on `ubuntu-24.04-arm` (free for public repos). Both runners are explicitly pinned (not `ubuntu-latest`) so the rolling alias cannot silently flip to a new major. Manifest assembled by `docker buildx imagetools create`. GHA cache scoped per arch.
- **Defense in depth.** Every dynamic input flowing into a `run:` block is passed via `env:` first.
- **Prod releases are manual.** Push to main triggers only `ci.yml`. Cut a release with `gh workflow run release.yml`.

## Documentation discipline

When a PR touches any of these surfaces, update the matching page under `docs/`:

| Source                                          | Doc                                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| `src/config.ts` env schema                      | `docs/operate/configuration.md`                                        |
| `src/shared/dispatch-types.ts`                  | `docs/operate/observability.md` + `docs/build/architecture.md`         |
| `src/orchestrator/triage.ts`                    | `docs/operate/runbooks/triage.md`                                      |
| `src/webhook/` routing or idempotency           | `docs/build/architecture.md`                                           |
| `src/k8s/ephemeral-daemon-spawner.ts`           | `docs/operate/runbooks/daemon-fleet.md` + `docs/operate/deployment.md` |
| `src/daemon/` lifecycle                         | `docs/operate/runbooks/daemon-fleet.md`                                |
| `src/workflows/` registry, dispatcher, handlers | `docs/use/workflows/*.md`                                              |
| New MCP server in `src/mcp/`                    | `docs/build/extending.md`                                              |
| New Pino field or metric                        | `docs/operate/observability.md`                                        |

`bun run docs:build` (strict) runs in CI. `check:docs-sync` blocks PRs that touch `src/workflows/**` without an accompanying docs change.
