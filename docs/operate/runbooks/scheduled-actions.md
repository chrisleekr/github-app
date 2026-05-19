# Runbook: scheduled actions

Operating the internal scheduler that runs `.github-app.yaml` actions. See
[Scheduled actions](../../use/scheduled-actions.md) for the file schema.

## Enable / disable

The scheduler is gated by `SCHEDULER_ENABLED` (default `false`). It also
refuses to start without `DATABASE_URL` and a non-empty `ALLOWED_OWNERS`,
look for one of these lines at startup:

```text
scheduler: started
scheduler: SCHEDULER_ENABLED is false, not starting
scheduler: ALLOWED_OWNERS is unset; ... not starting
```

To disable a single action without touching the bot, set `enabled: false` on
that action in the repo's `.github-app.yaml`.

## Force a run

```bash
curl -X POST https://<bot-host>/api/scheduler/run \
  -H "Authorization: Bearer $DAEMON_AUTH_TOKEN" \
  -d '{"owner":"<owner>","repo":"<repo>","action":"<name>"}'
```

`409` means a run is already in-flight (see below). A manual run is recorded
against `last_run_at` at the current instant, so if it fires within the grace
window before a cron slot, that cron slot is treated as already done and
skipped: the manual run stands in for it. The endpoint also honours
`enabled: false` (returns a non-enqueued reason); enable the action to run it.

## Diagnose

Key log events (component `scheduler`):

| Event                               | Meaning                                                    |
| ----------------------------------- | ---------------------------------------------------------- |
| `scheduler.action.claimed`          | A slot was claimed and a job enqueued.                     |
| `scheduler.action.skipped_missed`   | A slot fired while the server was down; advanced, not run. |
| `scheduler.action.daemon.started`   | The daemon began running an action.                        |
| `scheduler.action.daemon.completed` | The action's agent session finished.                       |

The per-action state lives in the `scheduled_action_state` table
(`last_run_at`, `last_content_sha`, `in_flight_job_id`, `in_flight_started_at`).

## Stuck `in_flight_job_id`

The single-flight lock is taken when a run is claimed. It is normally cleared
the moment the run completes (the scoped-job-completion handler), so a healthy
run releases it immediately. As a backstop it is also **self-healing**: the
claim treats a lock older than `2 × AGENT_TIMEOUT_MS` (always longer than the
longest possible run) as released, so a daemon that died mid-run does not
strand the action: the next scan past that window reclaims it. There is
normally nothing to do.

To force-clear immediately (e.g. to retry now):

```sql
UPDATE scheduled_action_state
   SET in_flight_job_id = NULL, in_flight_started_at = NULL
 WHERE owner = '<owner>' AND repo = '<repo>' AND action_name = '<name>';
```

## Downtime behaviour

Missed cron slots are skipped, not backfilled. After an outage the next
scheduled slot fires normally; intervening slots are advanced over and logged
as `scheduler.action.skipped_missed`.
