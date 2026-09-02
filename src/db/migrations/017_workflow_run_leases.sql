-- Add durable receipts and leases for one isolated workflow runner attempt.

-- Fail quickly instead of waiting behind an unrelated long-running table lock.
SET LOCAL lock_timeout = '5s';

ALTER TABLE workflow_runs
    ADD COLUMN attempt_id UUID NULL,
    ADD COLUMN lease_expires_at TIMESTAMPTZ NULL,
    ADD COLUMN attempt_deadline_at TIMESTAMPTZ NULL,
    ADD COLUMN attempt_completed_at TIMESTAMPTZ NULL,
    ADD COLUMN cascade_completed_at TIMESTAMPTZ NULL,
    ADD COLUMN execution_delivery_id TEXT NULL,
    ADD COLUMN trigger_body_preview TEXT NOT NULL DEFAULT '',
    ADD COLUMN dispatch_enqueued_at TIMESTAMPTZ NULL,
    ADD COLUMN dispatch_generation_id UUID NULL,
    ADD COLUMN runner_payload_issued_at TIMESTAMPTZ NULL,
    ADD COLUMN runner_token_expires_at TIMESTAMPTZ NULL,
    ADD COLUMN runner_resources_cleaned_at TIMESTAMPTZ NULL,
    ADD COLUMN failure_notified_at TIMESTAMPTZ NULL,
    ADD COLUMN dispatch_retry_count INTEGER NOT NULL DEFAULT 0
        CHECK (dispatch_retry_count >= 0);

-- A volatile ADD COLUMN default rewrites every existing row while ALTER TABLE
-- holds its strongest lock. Backfill explicitly, then make future inserts use
-- the default.
UPDATE workflow_runs
   SET dispatch_generation_id = gen_random_uuid()
 WHERE dispatch_generation_id IS NULL;

ALTER TABLE workflow_runs
    ALTER COLUMN dispatch_generation_id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN dispatch_generation_id SET NOT NULL;

ALTER TABLE workflow_runs
    ADD CONSTRAINT workflow_runs_runner_payload_receipt_check
        CHECK (
            (runner_payload_issued_at IS NULL AND runner_token_expires_at IS NULL)
            OR (
                runner_payload_issued_at IS NOT NULL
                AND runner_token_expires_at IS NOT NULL
                AND attempt_deadline_at IS NOT NULL
                AND runner_token_expires_at <= attempt_deadline_at
            )
        );

ALTER TABLE executions
    ADD COLUMN offer_id UUID NULL,
    ADD COLUMN result_processed_at TIMESTAMPTZ NULL,
    ADD COLUMN workflow_result_payload JSONB NULL;

ALTER TABLE executions
    DROP CONSTRAINT executions_dispatch_target_check,
    DROP CONSTRAINT executions_dispatch_mode_check,
    DROP CONSTRAINT executions_dispatch_reason_check;

ALTER TABLE executions
    ADD CONSTRAINT executions_dispatch_target_check
        CHECK (dispatch_target IN ('daemon', 'workflow-runner')),
    ADD CONSTRAINT executions_dispatch_mode_check
        CHECK (dispatch_mode IN ('daemon', 'workflow-runner')),
    ADD CONSTRAINT executions_dispatch_reason_check
        CHECK (dispatch_reason IN (
            'persistent-daemon',
            'ephemeral-daemon-triage',
            'ephemeral-daemon-overflow',
            'ephemeral-spawn-failed',
            'workflow-runner'
        ));

CREATE TABLE workflow_attempt_commands (
    attempt_id UUID NOT NULL,
    command_id UUID NOT NULL,
    run_id UUID NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
    command_kind TEXT NOT NULL CHECK (command_kind IN ('set-state', 'hand-off-child')),
    request JSONB NOT NULL,
    response JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (attempt_id, command_id)
);

-- The execution key can be recovered from every producer shape that existed
-- before this migration: top-level delivery, composite child id, or
-- ship-iteration state. Mark non-queued history as already published.
UPDATE workflow_runs
   SET execution_delivery_id = CASE
           WHEN parent_run_id IS NOT NULL THEN id::text
           WHEN delivery_id IS NOT NULL THEN delivery_id
           WHEN state ? 'shipIntentId' AND state ? 'iteration_n'
             THEN (state ->> 'shipIntentId') || '::iteration::' || (state ->> 'iteration_n')
           ELSE NULL
       END,
       dispatch_enqueued_at = now();

-- Queued executions will run on the isolated protocol after this migration.
-- Historical terminal or already-active rows retain the protocol that
-- actually executed them.
UPDATE executions AS e
   SET dispatch_mode = 'workflow-runner',
       dispatch_target = 'workflow-runner',
       dispatch_reason = 'workflow-runner'
  FROM workflow_runs AS wr
 WHERE wr.execution_delivery_id = e.delivery_id
   AND wr.status = 'queued'
   AND e.status = 'queued';

-- A queued row may have committed immediately before a crash without reaching
-- Valkey. Reopen every reconstructable row; duplicate copies lose at the exact
-- execution-offer claim and are consumed without affecting the winner.
UPDATE workflow_runs
   SET dispatch_enqueued_at = NULL
 WHERE status = 'queued'
   AND execution_delivery_id IS NOT NULL
   AND EXISTS (
       SELECT 1
         FROM executions AS e
        WHERE e.delivery_id = workflow_runs.execution_delivery_id
          AND e.status = 'queued'
   );

-- A queued row without its execution half cannot be reconstructed. Fail it so
-- the in-flight target guard does not block a deliberate retry forever.
WITH irrecoverable AS (
    UPDATE workflow_runs AS wr
       SET status = 'failed',
           state = state || jsonb_build_object(
               'phase', 'migration-interrupted',
               'failedReason', 'workflow dispatch incomplete during lease migration'
           ),
           owner_kind = NULL,
           owner_id = NULL,
           attempt_completed_at = now()
     WHERE wr.status = 'queued'
       AND (
           wr.execution_delivery_id IS NULL
           OR NOT EXISTS (
               SELECT 1
                 FROM executions AS e
                WHERE e.delivery_id = wr.execution_delivery_id
           )
       )
    RETURNING wr.id, wr.parent_run_id, wr.parent_step_index
),
irrecoverable_parent_inputs AS (
    SELECT parent_run_id,
           min(COALESCE(parent_step_index, -1)) AS failed_step_index
      FROM irrecoverable
     WHERE parent_run_id IS NOT NULL
     GROUP BY parent_run_id
)
UPDATE workflow_runs AS parent
   SET status = 'failed',
       state = state || jsonb_build_object(
           'failedAtStepIndex', irrecoverable_parent_inputs.failed_step_index,
           'failedReason', 'workflow dispatch incomplete during lease migration'
       )
  FROM irrecoverable_parent_inputs
 WHERE parent.id = irrecoverable_parent_inputs.parent_run_id
   AND parent.status = 'running'
   AND NOT EXISTS (
       SELECT 1 FROM irrecoverable AS direct WHERE direct.id = parent.id
   );

-- A shared daemon cannot hand an active workflow attempt to the isolated
-- runner protocol. Fail only rows whose own execution receipt is active.
-- A running composite parent whose receipt is already complete is preserved,
-- allowing its queued child to resume on an isolated runner.
WITH interrupted_workflows AS (
    UPDATE workflow_runs AS wr
       SET status = 'failed',
           state = state || jsonb_build_object(
               'phase', 'migration-interrupted',
               'failedReason', 'workflow execution interrupted during isolated-runner migration'
           ),
           owner_kind = NULL,
           owner_id = NULL,
           lease_expires_at = NULL,
           attempt_completed_at = now()
      FROM executions AS e
     WHERE e.delivery_id = wr.execution_delivery_id
       AND wr.status IN ('queued', 'running')
       AND e.status IN ('offered', 'running')
    RETURNING wr.id, wr.parent_run_id, wr.parent_step_index, wr.execution_delivery_id
),
interrupted_parent_inputs AS (
    SELECT parent_run_id,
           min(COALESCE(parent_step_index, -1)) AS failed_step_index
      FROM interrupted_workflows
     WHERE parent_run_id IS NOT NULL
     GROUP BY parent_run_id
),
failed_parents AS (
    UPDATE workflow_runs AS parent
       SET status = 'failed',
           state = state || jsonb_build_object(
               'failedAtStepIndex', interrupted_parent_inputs.failed_step_index,
               'failedReason', 'workflow execution interrupted during isolated-runner migration'
           )
      FROM interrupted_parent_inputs
     WHERE parent.id = interrupted_parent_inputs.parent_run_id
       AND parent.status = 'running'
       AND NOT EXISTS (
           SELECT 1 FROM interrupted_workflows AS direct WHERE direct.id = parent.id
       )
    RETURNING parent.id
),
interrupted_executions AS (
    UPDATE executions AS e
       SET status = 'failed',
           completed_at = now(),
           error_message = 'workflow execution interrupted during isolated-runner migration',
           result_processed_at = now()
      FROM interrupted_workflows
     WHERE e.delivery_id = interrupted_workflows.execution_delivery_id
    RETURNING e.delivery_id
)
UPDATE scheduled_action_state
   SET in_flight_job_id = NULL,
       in_flight_started_at = NULL
 WHERE in_flight_job_id IN (SELECT delivery_id FROM interrupted_executions);

-- A composite parent whose own receipt is already complete remains the
-- durable coordinator for its queued child. It must no longer carry the
-- shared daemon identity that performed the hand-off.
UPDATE workflow_runs AS parent
   SET owner_kind = NULL,
       owner_id = NULL,
       lease_expires_at = NULL
 WHERE parent.status = 'running'
   AND parent.owner_kind = 'daemon'
   AND NOT EXISTS (
       SELECT 1
         FROM executions AS e
        WHERE e.delivery_id = parent.execution_delivery_id
          AND e.status IN ('offered', 'running')
   )
   AND EXISTS (
       SELECT 1
         FROM workflow_runs AS child
        WHERE child.parent_run_id = parent.id
          AND child.status = 'queued'
   );

CREATE INDEX idx_workflow_runs_lease_expiry
    ON workflow_runs (LEAST(lease_expires_at, attempt_deadline_at))
    WHERE status = 'running'
      AND lease_expires_at IS NOT NULL
      AND attempt_deadline_at IS NOT NULL;

CREATE UNIQUE INDEX idx_workflow_runs_attempt_id
    ON workflow_runs (attempt_id)
    WHERE attempt_id IS NOT NULL;

CREATE INDEX idx_workflow_runs_dispatch_pending
    ON workflow_runs (dispatch_enqueued_at NULLS FIRST, created_at)
    WHERE status = 'queued'
      AND execution_delivery_id IS NOT NULL;

ALTER TABLE repo_memory
    ADD COLUMN content_sha256 BYTEA NULL;

UPDATE repo_memory
   SET content_sha256 = pg_catalog.sha256(pg_catalog.convert_to(content, 'UTF8'))
 WHERE category <> 'env_var';

ALTER TABLE repo_memory
    ADD CONSTRAINT repo_memory_learning_hash_check
        CHECK (category = 'env_var' OR content_sha256 IS NOT NULL);

CREATE OR REPLACE FUNCTION set_repo_memory_content_sha256()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
    NEW.content_sha256 := CASE
        WHEN NEW.category = 'env_var' THEN NULL
        ELSE pg_catalog.sha256(pg_catalog.convert_to(NEW.content, 'UTF8'))
    END;
    RETURN NEW;
END;
$$;

CREATE TRIGGER repo_memory_content_sha256
BEFORE INSERT OR UPDATE OF category, content ON repo_memory
FOR EACH ROW
EXECUTE FUNCTION set_repo_memory_content_sha256();

-- Result replay can persist the same learning concurrently. Keep the most
-- useful existing copy, then let PostgreSQL enforce the durable invariant.
WITH duplicate_learning AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY repo_owner, repo_name, category, content
               ORDER BY pinned DESC, updated_at DESC, created_at DESC, id
           ) AS duplicate_number
      FROM repo_memory
     WHERE category <> 'env_var'
)
DELETE FROM repo_memory AS memory
 USING duplicate_learning AS duplicate
 WHERE memory.id = duplicate.id
   AND duplicate.duplicate_number > 1;

CREATE UNIQUE INDEX idx_repo_memory_learning_unique
    ON repo_memory (
        repo_owner,
        repo_name,
        category,
        content_sha256
    )
    WHERE category <> 'env_var';

CREATE INDEX idx_workflow_runs_runner_cleanup_pending
    ON workflow_runs (attempt_completed_at)
    WHERE attempt_id IS NOT NULL
      AND attempt_completed_at IS NOT NULL
      AND runner_resources_cleaned_at IS NULL;

CREATE INDEX idx_workflow_runs_failure_notification_pending
    ON workflow_runs (attempt_completed_at)
    WHERE status = 'failed'
      AND attempt_completed_at IS NOT NULL
      AND failure_notified_at IS NULL;

CREATE UNIQUE INDEX idx_executions_offer_id
    ON executions (offer_id)
    WHERE offer_id IS NOT NULL;

CREATE INDEX idx_executions_running_daemon
    ON executions (daemon_id)
    WHERE status = 'running' AND daemon_id IS NOT NULL;

CREATE INDEX idx_executions_workflow_result_pending
    ON executions (completed_at)
    WHERE workflow_result_payload IS NOT NULL
      AND result_processed_at IS NULL;
