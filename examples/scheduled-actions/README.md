# Scheduled actions: example

Drop a `.github-app.yaml` at your repo's default-branch root to run
prompt-based actions on a cron schedule, executed by the bot's daemon fleet.
See [docs/use/scheduled-actions.md](../../docs/use/scheduled-actions.md) for
the full schema.

## Adopting

1. Copy `.github-app.yaml` to your repo root and edit the actions.
2. Copy any referenced prompt files (e.g. `research.md`) to the path the
   action's `prompt.ref` points at (here, `.github/skills/`).
3. Ask the operator to set `SCHEDULER_ENABLED=true` on the bot, and your owner
   to be in `ALLOWED_OWNERS`.

## Files

- `.github-app.yaml`: a single `research` action that runs daily.
- `research.md`: the skill prompt the action runs (a copy of this repo's
  `.github/skills/research.md`).

## Prompt forms

A `prompt` is one of:

- `prompt: { inline: "..." }`: the text verbatim.
- `prompt: { ref: "path/to/file.md" }`: a single file.
- `prompt: { ref: "dir/", entrypoint: "SKILL.md" }`: a folder; the entrypoint
  plus one level of sibling files are concatenated.

Add `repo: "owner/name"` to a `ref` to source the prompt from another repo
owned by the same owner as the action's repo (one installation token).
