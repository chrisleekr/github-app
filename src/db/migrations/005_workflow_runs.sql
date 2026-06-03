-- Migration 005: workflow_runs — state store for the Definitive Bot Workflows feature.
--
-- FR mapping: FR-011 (in-flight uniqueness), FR-025 (no-migration extension
-- via JSONB state column), FR-026 (tracking_comment_id persisted), FR-029
-- (parent linkage for composite workflows).
--
-- This table is intentionally independent of `executions` — the dispatch/
-- triage pipeline and the workflow pipeline live side by side. A future
-- consolidation is out of scope.

CREATE TABLE workflow_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    workflow_name TEXT NOT NULL,
    target_type TEXT NOT NULL CHECK (target_type IN ('issue', 'pr')),
    target_owner TEXT NOT NULL,
    target_repo TEXT NOT NULL,
    target_number INT NOT NULL CHECK (target_number > 0),

    parent_run_id UUID NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
    parent_step_index INT NULL,
    CHECK ((parent_run_id IS NULL) = (parent_step_index IS NULL)),

    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),

    state JSONB NOT NULL DEFAULT '{}'::jsonb,

    tracking_comment_id BIGINT NULL,
    delivery_id TEXT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- FR-011: at most one in-flight run per (workflow, item). Terminal rows are
-- deliberately excluded so re-runs after completion are not blocked.
CREATE UNIQUE INDEX idx_workflow_runs_inflight
    ON workflow_runs (workflow_name, target_owner, target_repo, target_number)
    WHERE status IN ('queued', 'running');

-- Resume path: "what's the latest run for this item?"
CREATE INDEX idx_workflow_runs_target
    ON workflow_runs (target_owner, target_repo, target_number);

-- Parent lookup for composite hand-off (FR-028).
CREATE INDEX idx_workflow_runs_parent
    ON workflow_runs (parent_run_id)
    WHERE parent_run_id IS NOT NULL;

-- Touch updated_at on any row change.
CREATE OR REPLACE FUNCTION workflow_runs_bump_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_workflow_runs_bump_updated_at
    BEFORE UPDATE ON workflow_runs
    FOR EACH ROW EXECUTE FUNCTION workflow_runs_bump_updated_at();
