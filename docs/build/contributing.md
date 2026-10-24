# Contributing

Short version: open a PR, keep `bun run check` green, update the matching docs page.

## Branching

| Branch           | Purpose                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `main`           | Always green. Stable channel: release-please opens a Release PR on push; merging it cuts the release.                                  |
| `beta`           | Long-lived prerelease channel. release-please opens a beta Release PR; merging it cuts `v<x.y.z>-beta` and a beta image.               |
| Feature branches | Any name **other** than `main`, `beta`, and `v*`. CI runs on the PR; no per-branch release (the semantic-release dev rail is retired). |

## Commit format

`commitlint` with `@commitlint/config-conventional`. Allowed types:

```text
feat, fix, docs, style, refactor, test, chore, perf, build, ci, revert, localize, bump
```

Example: `feat(ship): wire ship iteration loop, tickle scheduler, and four scoped executors`.

## Pre-commit gate

`.husky/pre-commit` runs:

1. `gitleaks protect --staged`, secret scan (hard exit if `gitleaks` is missing; install with your package manager).
2. `bunx lint-staged`, Prettier and Oxlint on staged files.

`.husky/commit-msg` runs `commitlint` on the message itself.

## What to run before opening a PR

```bash
bun run check
```

That single command runs typecheck, lint, format, the no-destructive-action guard, the docs-sync check, and tests. Failing any of those fails CI.

For a broader smoke test:

```bash
bun run audit:ci    # severity-gated dependency audit
bun run docs:build  # strict docs build (catches broken internal links)
```

## PRs that touch `src/workflows/**`

The `check:docs-sync` script blocks any PR touching workflow source without a matching update under `docs/use/workflows/`. The intent is that the workflow tree on the docs site never lies about what the registered workflows actually do.

Test files (`*.test.ts`) and inline markdown (`*.md` under `src/workflows/`) are exempt.

## PRs that change configuration

If you add or rename an environment variable in `src/config.ts`, update [`../operate/configuration.md`](../operate/configuration.md) in the same PR. The full doc-sync mapping is in [`conventions.md`](conventions.md#documentation-discipline).

## Where to file issues

Use the GitHub issue tracker on the repo. The bot also responds to mentions on issues, `@chrisleekr-bot triage this` is a perfectly valid first move (see [`../use/workflows/triage.md`](../use/workflows/triage.md)).

## Running the docs site locally

```bash
bun run docs:install   # one-time, installs MkDocs Material
bun run docs:serve     # http://localhost:8000 with live reload
bun run docs:build     # strict build (CI also runs this)
```
