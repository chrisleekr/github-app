/**
 * Scheduled-actions scheduler: an internal cron timer for the webhook
 * server (a GitHub App receives no native schedule event).
 *
 * Each tick enumerates installed repos, reads `.github-app.yaml`, and for
 * every enabled action decides via `computeDueDecision` whether to run,
 * advance-over (skip a missed slot), or stay idle. A due action's slot is
 * claimed with a compare-and-swap UPDATE so multiple webhook-server replicas
 * never double-fire, then a `scheduled-action` job is enqueued for the
 * daemon fleet.
 *
 * Mirrors the lifecycle of `src/workflows/ship/tickle-scheduler.ts`:
 * `setInterval` + a reentrancy guard, started/stopped explicitly.
 */

import type { App, Octokit } from "octokit";
import type { Logger } from "pino";

import { config } from "../config";
import { getDb } from "../db";
import {
  advanceScheduleSlot,
  claimScheduleSlotForRun,
  getScheduleState,
  releaseInFlight,
} from "../db/queries/scheduled-actions-store";
import { logger as rootLogger } from "../logger";
import { createExecution, markExecutionFailed } from "../orchestrator/history";
import { enqueueJob } from "../orchestrator/job-queue";
import { isOwnerAllowed } from "../webhook/authorize";
import { fetchRepoConfig } from "./config-fetcher";
import type { ScheduledAction } from "./config-schema";
import { computeDueDecision } from "./due-evaluator";
import { enumerateScheduledRepos, type ScheduledRepo } from "./installation-enumerator";
import { resolvePrompt } from "./prompt-resolver";

/**
 * In-flight lock staleness backstop. The lock is normally cleared when the
 * run completes (`clearInFlightByJobId`, called from the scoped-job-completion
 * handler); this window only releases a lock whose daemon died without ever
 * reporting completion. Derived as 2x `config.agentTimeoutMs` so it is always
 * longer than the longest possible run regardless of how high an operator
 * sets the timeout, so a live run is never reclaimed.
 */
const STALE_IN_FLIGHT_MS = 2 * config.agentTimeoutMs;

export interface SchedulerDeps {
  readonly app: App;
  readonly intervalMs?: number;
  readonly log?: Logger;
}

export interface SchedulerHandle {
  /** Boot scan + begin the periodic timer. No-op when disabled/misconfigured. */
  readonly start: () => Promise<void>;
  readonly stop: () => void;
  /** Run one full scan synchronously (manual trigger + tests). */
  readonly runOnce: () => Promise<void>;
  /** Force a single named action to run now, bypassing the cron check. */
  readonly runAction: (input: {
    owner: string;
    repo: string;
    actionName: string;
  }) => Promise<{ enqueued: boolean; reason?: string }>;
}

/** Immutable per-scheduler context shared by the module-level helpers. */
interface SchedulerCtx {
  readonly app: App;
  readonly log: Logger;
  readonly graceMs: number;
}

interface RepoCoords {
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
}

/** Enqueue a `scheduled-action` job for an already-claimed slot. */
async function enqueueRun(
  ctx: SchedulerCtx,
  run: {
    repo: RepoCoords;
    action: ScheduledAction;
    slotIso: string;
    promptText: string;
    deliveryId: string;
  },
): Promise<void> {
  const { repo, action, slotIso, promptText, deliveryId } = run;
  const autoMerge = action.auto_merge && config.schedulerAllowAutoMerge;
  // Create the `executions` row BEFORE enqueueing: the scoped-job-completion
  // handler validates ownership against this row and would otherwise reject
  // the completion (leaking a daemon capacity slot). It doubles as run history.
  await createExecution({
    deliveryId,
    repoOwner: repo.owner,
    repoName: repo.repo,
    entityNumber: 0,
    entityType: "scheduled-action",
    eventName: "scheduled-action",
    triggerUsername: "scheduler",
    dispatchMode: "daemon",
    // The `executions` CHECK rejects the `static-default` column default;
    // a scheduled action always dispatches to the persistent daemon fleet.
    dispatchReason: "persistent-daemon",
  });
  await enqueueJob({
    kind: "scheduled-action",
    deliveryId,
    repoOwner: repo.owner,
    repoName: repo.repo,
    entityNumber: 0,
    isPR: false,
    eventName: "scheduled-action",
    triggerUsername: "scheduler",
    labels: [],
    triggerBodyPreview: "",
    enqueuedAt: Date.now(),
    retryCount: 0,
    installationId: repo.installationId,
    actionName: action.name,
    cronSlotIso: slotIso,
    promptText,
    autoMerge,
    ...(action.model !== undefined ? { model: action.model } : {}),
    ...(action.max_turns !== undefined ? { maxTurns: action.max_turns } : {}),
    ...(action.timeout !== undefined ? { timeoutMs: action.timeout } : {}),
    ...(action.allowed_tools !== undefined ? { allowedTools: action.allowed_tools } : {}),
  });
  ctx.log.info(
    {
      event: "scheduler.action.claimed",
      owner: repo.owner,
      repo: repo.repo,
      action: action.name,
      deliveryId,
      slot: slotIso,
      autoMerge,
    },
    "scheduler: action enqueued",
  );
}

/** Evaluate one action against its cron and enqueue it if a slot is due. */
async function processAction(
  ctx: SchedulerCtx,
  item: {
    repo: ScheduledRepo;
    action: ScheduledAction;
    docTimezone: string;
    contentSha: string;
    now: Date;
  },
): Promise<void> {
  const { repo, action, docTimezone, contentSha, now } = item;
  const tz = action.timezone ?? docTimezone;
  const key = {
    installationId: repo.installationId,
    owner: repo.owner,
    repo: repo.repo,
    actionName: action.name,
  };
  const state = await getScheduleState(key);
  const decision = computeDueDecision({
    cron: action.cron,
    timezone: tz,
    lastRunAt: state?.last_run_at ?? null,
    now,
    graceMs: ctx.graceMs,
  });
  if (decision.action === "idle" || decision.slotTime === null) return;

  if (decision.action === "advance") {
    await advanceScheduleSlot({ ...key, slotTime: decision.slotTime, contentSha });
    ctx.log.info(
      {
        event: "scheduler.action.skipped_missed",
        owner: repo.owner,
        repo: repo.repo,
        action: action.name,
        slot: decision.slotTime.toISOString(),
      },
      "scheduler: missed slot advanced (skip-missed policy)",
    );
    return;
  }

  // decision.action === "run"
  const slotTime = decision.slotTime;
  let promptText: string;
  try {
    promptText = await resolvePrompt(
      repo.octokit,
      action.prompt,
      { owner: repo.owner, repo: repo.repo },
      ctx.log,
    );
  } catch (err) {
    ctx.log.warn(
      { err, owner: repo.owner, repo: repo.repo, action: action.name },
      "scheduler: prompt resolution failed, skipping action",
    );
    return;
  }

  const deliveryId = `sched-${crypto.randomUUID()}`;
  const claimed = await claimScheduleSlotForRun({
    ...key,
    slotTime,
    contentSha,
    jobId: deliveryId,
    staleBefore: new Date(now.getTime() - STALE_IN_FLIGHT_MS),
  });
  if (!claimed) {
    ctx.log.debug(
      { owner: repo.owner, repo: repo.repo, action: action.name },
      "scheduler: slot not claimed (raced replica or run in-flight)",
    );
    return;
  }

  try {
    await enqueueRun(ctx, {
      repo,
      action,
      slotIso: slotTime.toISOString(),
      promptText,
      deliveryId,
    });
  } catch (err) {
    // The slot is claimed but no job landed; release the in-flight lock and
    // fail the executions row `enqueueRun` created, so it does not linger
    // `queued`. `markExecutionFailed` is a no-op when no row exists.
    ctx.log.error(
      { err, deliveryId, action: action.name },
      "scheduler: enqueue failed after claim, releasing lock",
    );
    await releaseInFlight({ ...key, jobId: deliveryId });
    await markExecutionFailed(deliveryId, "scheduler: enqueue failed after slot claim");
  }
}

/** One full scan over every installed repo. */
async function scanOnce(ctx: SchedulerCtx): Promise<void> {
  const now = new Date();
  for await (const repo of enumerateScheduledRepos(ctx.app, ctx.log)) {
    const fetched = await fetchRepoConfig({
      octokit: repo.octokit,
      owner: repo.owner,
      repo: repo.repo,
      path: config.schedulerConfigFile,
      log: ctx.log,
    });
    if (fetched === null) continue;
    for (const action of fetched.config.scheduled_actions) {
      if (!action.enabled) continue;
      try {
        // eslint-disable-next-line no-await-in-loop -- sequential to keep the slot-claim race window small
        await processAction(ctx, {
          repo,
          action,
          docTimezone: fetched.config.config.timezone,
          contentSha: fetched.sha,
          now,
        });
      } catch (err) {
        // One action's failure (e.g. a transient DB error) must not abort the
        // scan for the remaining repos/actions this tick.
        ctx.log.error(
          { err, owner: repo.owner, repo: repo.repo, action: action.name },
          "scheduler: processAction failed, continuing scan",
        );
      }
    }
  }
}

/** Force a single named action to run now, bypassing the cron check. */
async function runAction(
  ctx: SchedulerCtx,
  input: { owner: string; repo: string; actionName: string },
): Promise<{ enqueued: boolean; reason?: string }> {
  // The manual endpoint must honour the same owner-allowlist trust gate as
  // the periodic scan; otherwise it could run an action for a repo the
  // scheduler would never scan (the gate that the `.github-app.yaml` trust
  // model depends on).
  if (!isOwnerAllowed(input.owner, ctx.log).allowed) {
    return { enqueued: false, reason: `owner "${input.owner}" is not in ALLOWED_OWNERS` };
  }
  let installationId: number;
  let octokit: Octokit;
  try {
    const inst = await ctx.app.octokit.rest.apps.getRepoInstallation({
      owner: input.owner,
      repo: input.repo,
    });
    installationId = inst.data.id;
    octokit = (await ctx.app.getInstallationOctokit(installationId)) as unknown as Octokit;
  } catch (err) {
    // Detail logged server-side only: an octokit error stringifies with the
    // request URL, which carries the installation token.
    ctx.log.error(
      { err, owner: input.owner, repo: input.repo },
      "scheduler: installation lookup failed",
    );
    return { enqueued: false, reason: "installation lookup failed" };
  }
  const fetched = await fetchRepoConfig({
    octokit,
    owner: input.owner,
    repo: input.repo,
    path: config.schedulerConfigFile,
    log: ctx.log,
  });
  if (fetched === null) {
    return { enqueued: false, reason: "no valid .github-app.yaml" };
  }
  const action = fetched.config.scheduled_actions.find((a) => a.name === input.actionName);
  if (action === undefined) {
    return { enqueued: false, reason: `action "${input.actionName}" not found` };
  }
  if (!action.enabled) {
    // The manual endpoint honours `enabled: false`; enable the action to run it.
    return { enqueued: false, reason: `action "${input.actionName}" is disabled` };
  }
  const repo: ScheduledRepo = { installationId, owner: input.owner, repo: input.repo, octokit };
  let promptText: string;
  try {
    promptText = await resolvePrompt(octokit, action.prompt, input, ctx.log);
  } catch (err) {
    ctx.log.warn(
      { err, owner: input.owner, repo: input.repo },
      "scheduler: prompt resolution failed",
    );
    return { enqueued: false, reason: "prompt resolution failed" };
  }
  // Manual run: claim against the current instant so it does not collide with
  // a cron slot, and bypass the due check.
  const now = new Date();
  const deliveryId = `sched-manual-${crypto.randomUUID()}`;
  const claimed = await claimScheduleSlotForRun({
    installationId,
    owner: input.owner,
    repo: input.repo,
    actionName: action.name,
    slotTime: now,
    contentSha: fetched.sha,
    jobId: deliveryId,
    staleBefore: new Date(now.getTime() - STALE_IN_FLIGHT_MS),
  });
  if (!claimed) {
    return { enqueued: false, reason: "a run is already in-flight for this action" };
  }
  try {
    await enqueueRun(ctx, { repo, action, slotIso: now.toISOString(), promptText, deliveryId });
  } catch (err) {
    // Release the lock and fail the orphaned executions row so a transient
    // enqueue failure does not strand the action for the full stale window.
    await releaseInFlight({
      installationId,
      owner: input.owner,
      repo: input.repo,
      actionName: action.name,
      jobId: deliveryId,
    });
    await markExecutionFailed(deliveryId, "scheduler: enqueue failed after slot claim");
    ctx.log.error(
      { err, owner: input.owner, repo: input.repo },
      "scheduler: manual run enqueue failed",
    );
    return { enqueued: false, reason: "enqueue failed" };
  }
  return { enqueued: true };
}

export function createScheduler(deps: SchedulerDeps): SchedulerHandle {
  const log = (deps.log ?? rootLogger).child({ component: "scheduler" });
  const intervalMs = deps.intervalMs ?? config.schedulerScanIntervalMs;
  // A slot fires only within 2 ticks of its scheduled time; older slots are
  // "missed" and advanced over (the skip-missed-slots policy).
  const ctx: SchedulerCtx = { app: deps.app, log, graceMs: intervalMs * 2 };
  let timer: ReturnType<typeof setInterval> | null = null;
  let scanning = false;

  /*
   * Reentrancy guard against overlapping `setInterval` invocations. The
   * check-then-set is safe because JS is single-threaded and no `await`
   * separates the read from the write; `require-atomic-updates` flags it
   * conservatively. Same structural guarantee as `tickle-scheduler.ts`.
   */
  /* eslint-disable require-atomic-updates */
  const guardedScan = async (): Promise<void> => {
    if (scanning) return;
    scanning = true;
    try {
      await scanOnce(ctx);
    } catch (err) {
      log.error({ err }, "scheduler: scan tick failed");
    } finally {
      scanning = false;
    }
  };
  /* eslint-enable require-atomic-updates */

  return {
    start: async (): Promise<void> => {
      if (!config.schedulerEnabled) {
        log.info("scheduler: SCHEDULER_ENABLED is false, not starting");
        return;
      }
      if (getDb() === null) {
        log.warn("scheduler: DATABASE_URL not configured, not starting");
        return;
      }
      if (config.allowedOwners === undefined) {
        // Scheduled actions run owner-trusted prompts; without an allowlist
        // the trust gate is a no-op. Refuse to start rather than run
        // arbitrary owners' configs.
        log.warn(
          "scheduler: ALLOWED_OWNERS is unset; scheduled actions require an owner allowlist, not starting",
        );
        return;
      }
      await guardedScan();
      timer = setInterval(() => void guardedScan(), intervalMs);
      log.info({ intervalMs }, "scheduler: started");
    },
    stop: (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    runOnce: guardedScan,
    runAction: (input) => runAction(ctx, input),
  };
}
