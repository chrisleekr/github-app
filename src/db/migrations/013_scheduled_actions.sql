-- Migration 013: scheduled_action_state — per-action scheduling state for
-- the scheduled-actions feature (`.github-app.yaml` → internal cron).
--
-- One row per (installation_id, owner, repo, action_name). The scheduler
-- (src/scheduler/) reads `last_run_at` to decide whether a cron slot is due,
-- and writes it back via a compare-and-swap UPDATE so two webhook-server
-- replicas ticking at the same time cannot enqueue the same slot twice.
--
-- `in_flight_job_id` + `in_flight_started_at` are the single-flight /
-- concurrency lock, mirroring research.yml's `concurrency:
-- cancel-in-progress: false` (skip, never overlap). The claim UPDATE
-- refuses to fire while a run is in-flight UNLESS the lock is stale
-- (`in_flight_started_at` older than a generous window). The lock is
-- released two ways: actively, when a run reaches a terminal state
-- (`clearInFlightByJobId` from the scoped-job-completion handler and
-- from every terminal-failure path in connection-handler.ts), and
-- passively, via the stale window. The stale window is the crash-safety
-- fallback: a daemon that dies before any terminal path runs cannot
-- strand the action permanently.
--
-- Per-run history is NOT stored here; it reuses the existing `executions`
-- table, same as every other daemon job.

CREATE TABLE scheduled_action_state (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    installation_id  BIGINT NOT NULL,
    owner            TEXT   NOT NULL,
    repo             TEXT   NOT NULL,
    action_name      TEXT   NOT NULL,

    -- The cron slot most recently claimed (run OR advanced-over). The
    -- claim UPDATE guards on `last_run_at < slotTime`, so a replica that
    -- loses the race sees the slot already taken and skips it.
    last_run_at      TIMESTAMPTZ NULL,

    -- Blob SHA of `.github-app.yaml` at the last claim. Lets the
    -- config-fetcher issue conditional (If-None-Match) requests.
    last_content_sha TEXT   NULL,

    -- deliveryId of the in-flight job; NULL when idle. Single-flight lock.
    in_flight_job_id TEXT   NULL,

    -- When the in-flight run was claimed; the claim treats a lock older
    -- than the stale window as released. NULL when idle.
    in_flight_started_at TIMESTAMPTZ NULL,

    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One state row per action. The claim path INSERTs with ON CONFLICT DO
-- NOTHING against this index, then UPDATEs.
CREATE UNIQUE INDEX idx_scheduled_action_state_identity
    ON scheduled_action_state (installation_id, owner, repo, action_name);

-- The terminal-path lock release (clearInFlightByJobId) updates WHERE
-- in_flight_job_id = $1. Partial index keeps that lookup off a full scan.
CREATE INDEX idx_scheduled_action_state_in_flight_job_id
    ON scheduled_action_state (in_flight_job_id)
    WHERE in_flight_job_id IS NOT NULL;

-- Touch updated_at on any row change. Same trigger pattern as
-- chat_proposals (migration 010) and workflow_runs (migration 005).
CREATE OR REPLACE FUNCTION scheduled_action_state_bump_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_scheduled_action_state_bump_updated_at
    BEFORE UPDATE ON scheduled_action_state
    FOR EACH ROW EXECUTE FUNCTION scheduled_action_state_bump_updated_at();
