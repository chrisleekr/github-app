-- Migration 014: review_learnings — per-repo (and owner-wide) review-policy
-- directives extracted from past PR review pushback.
--
-- Separate from `repo_memory` because the columns are structurally different:
-- file_glob scope, source-PR provenance, and the local/global scope enum.
-- Packing those into `repo_memory.content` as a serialized blob would force
-- every reader to parse it, and the prompt-injection block needs structured
-- provenance fields rendered verbatim.
--
-- Trust boundary: `review_learnings` directives can suppress findings (e.g.
-- "do not flag this pattern as duplication because…"). They are loaded ONLY
-- by the `review` and `resolve` handlers; the prompt block is gated at the
-- handler level, not in the prompt builder. See src/workflows/handlers/.
--
-- Scope:
--   local  — applies to (repo_owner, repo_name).
--   global — applies to every repo under `repo_owner`. Rows set repo_name='*'
--            so the (repo_owner, repo_name) lookup index still answers both
--            cases in one query. Global writes are gated on the orchestrator
--            side to single-owner ALLOWED_OWNERS deployments.
--
-- Lifecycle:
--   use_count and last_used_at are bumped when a learning is loaded into a
--   review prompt. They drive the load-time ordering ("most recently useful
--   first") and the eventual age-based cap configurable via .github-app.yaml
--   review_learnings.max_age_days.

CREATE TABLE review_learnings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity. repo_name = '*' encodes the owner-wide (global) scope so the
  -- (repo_owner, repo_name) index serves both lookups.
  repo_owner    TEXT NOT NULL,
  repo_name     TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT 'local'
                CHECK (scope IN ('local', 'global')),

  -- Directive. file_glob is matched against the PR's changed-file paths in
  -- TypeScript (picomatch). NULL = applies to every file in the repo.
  file_glob     TEXT NULL,
  directive     TEXT NOT NULL,
  rationale     TEXT NULL,

  -- Provenance. Every field nullable: an agent that observes a directive may
  -- not always know which thread or maintainer to attribute. NULL renders as
  -- "(not recorded)" in the surfacing footer.
  source_pr     INTEGER NULL,
  source_thread TEXT NULL,
  source_author TEXT NULL,

  -- Lifecycle.
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ NULL,
  use_count     INTEGER NOT NULL DEFAULT 0,

  -- Cross-row invariants.
  CONSTRAINT review_learnings_global_uses_wildcard_repo
    CHECK ((scope = 'global' AND repo_name = '*') OR scope = 'local')
);

-- Primary lookup: load all local rows for this (owner, repo) UNION all global
-- rows for this owner. Both queries are served by this composite index.
CREATE INDEX idx_review_learnings_repo
  ON review_learnings (repo_owner, repo_name);

-- Dedup guard: a single repo+scope shouldn't accumulate identical directives.
-- The orchestrator's saveReviewLearnings INSERT uses ON CONFLICT to bump
-- updated_at on the existing row instead of creating a near-duplicate when
-- the agent re-saves the same text. file_glob is part of the key so the same
-- directive scoped to different globs is allowed (those describe different
-- policies). Uses COALESCE so NULL file_glob rows still dedupe against each
-- other (NULL would otherwise compare not-equal to itself).
CREATE UNIQUE INDEX idx_review_learnings_dedup
  ON review_learnings (repo_owner, repo_name, scope, COALESCE(file_glob, ''), directive);

-- Hot path for global-scope scan when the loader fans out across repos.
CREATE INDEX idx_review_learnings_global
  ON review_learnings (repo_owner)
  WHERE scope = 'global';

-- Touch updated_at on any row change. Same trigger pattern as
-- scheduled_action_state (migration 013), workflow_runs (005), chat_proposals (010).
CREATE OR REPLACE FUNCTION review_learnings_bump_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_review_learnings_bump_updated_at
    BEFORE UPDATE ON review_learnings
    FOR EACH ROW EXECUTE FUNCTION review_learnings_bump_updated_at();
