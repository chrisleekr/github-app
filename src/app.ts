import { randomUUID } from "node:crypto";
import { access, constants } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";

import { createNodeMiddleware } from "@octokit/webhooks";
import type {
  CheckRunEvent,
  CheckSuiteEvent,
  IssueCommentEvent,
  IssuesEvent,
  PullRequestEvent,
  PullRequestReviewCommentEvent,
  PullRequestReviewEvent,
  PullRequestReviewThreadEvent,
} from "@octokit/webhooks-types";
import { App, Octokit } from "octokit";

import { HTTP_LOG_EVENTS } from "./app-log-fields";
import { config } from "./config";
import { sweepStaleWorkspaces } from "./core/workspace-sweep";
import { closeDb, getDb } from "./db";
import { runMigrations } from "./db/migrate";
import { installFatalHandlers, logger } from "./logger";
import { startFleetSnapshot, stopFleetSnapshot } from "./orchestrator/fleet-snapshot";
import { recoverStaleExecutions } from "./orchestrator/history";
import { mintInstallationToken } from "./orchestrator/installation-token";
import { getInstanceId } from "./orchestrator/instance-id";
import { startInstanceHeartbeat, stopInstanceHeartbeat } from "./orchestrator/instance-liveness";
import { recoverProcessingList } from "./orchestrator/job-queue";
import {
  reapOnce as reapLivenessOnce,
  startLivenessReaper,
  stopLivenessReaper,
} from "./orchestrator/liveness-reaper";
import { type ProposalPollerHandle, startProposalPoller } from "./orchestrator/proposal-poller";
import { startQueueWorker, stopQueueWorker } from "./orchestrator/queue-worker";
import { startSocketHealthWatchdog, stopSocketHealthWatchdog } from "./orchestrator/socket-health";
import {
  closeValkey,
  connectValkey,
  isValkeyHealthy,
  requireValkeyClient,
} from "./orchestrator/valkey";
import { sweepValkeyOrphans } from "./orchestrator/valkey-cleanup";
import {
  buildAuthExpectations,
  isAuthHeaderValid,
  startWebSocketServer,
  stopWebSocketServer,
} from "./orchestrator/ws-server";
import { createScheduler, type SchedulerHandle } from "./scheduler";
import type { BotContext } from "./types";
import { observableOctokit } from "./utils/octokit-observability";
import { handleCheckRun } from "./webhook/events/check-run";
import { handleCheckSuite } from "./webhook/events/check-suite";
import { handleIssueComment } from "./webhook/events/issue-comment";
import { handleIssues } from "./webhook/events/issues";
import { handlePullRequest } from "./webhook/events/pull-request";
import { handleReview } from "./webhook/events/review";
import { handleReviewComment } from "./webhook/events/review-comment";
import { handleReviewThread } from "./webhook/events/review-thread";
import { resumeShipIntent } from "./workflows/ship/session-runner";
import { createTickleScheduler, type TickleScheduler } from "./workflows/ship/tickle-scheduler";

/**
 * Main HTTP server entry point.
 *
 * Uses octokit App class per GitHub tutorial:
 * https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-github-app-that-responds-to-webhook-events
 *
 * createNodeMiddleware auto-verifies HMAC-SHA256 signatures per:
 * https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 */
// Server mode: appId, privateKey, webhookSecret are guaranteed present by config superRefine
// (only optional for daemon-only mode when ORCHESTRATOR_URL is set).
if (
  config.appId === undefined ||
  config.privateKey === undefined ||
  config.webhookSecret === undefined
) {
  throw new Error(
    "Server mode requires GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_WEBHOOK_SECRET",
  );
}
const app = new App({
  appId: config.appId,
  privateKey: config.privateKey,
  webhooks: { secret: config.webhookSecret },
  // Log GitHub rate-limit headers on every octokit response (issue #170);
  // covers app.octokit + all installation octokits via the shared subclass.
  Octokit: observableOctokit(),
});

// All three actions are subscribed so the chat-thread cache write-through
// at `webhook/events/issue-comment.ts:writeCommentCacheThrough` fires on
// edits and deletes too. The dispatch path is still gated to `created` by
// the early-return inside the handler. Mirrors the review-comment block
// below. See issue #129.
app.webhooks.on(
  ["issue_comment.created", "issue_comment.edited", "issue_comment.deleted"],
  ({ octokit, payload, id }) => {
    handleIssueComment(octokit, payload as unknown as IssueCommentEvent, id);
  },
);

// Cache write-through (issue #130): every action that mutates a field
// stored in `target_cache` is subscribed so the chat-thread cache stays
// fresh without waiting for a cold-miss backfill. Dispatch paths inside
// `handlePullRequest` remain gated to their original action set (only
// `labeled` / `synchronize` / `closed` trigger workflows; the rest are
// cache-only).
app.webhooks.on(
  [
    "pull_request.opened",
    "pull_request.edited",
    "pull_request.labeled",
    "pull_request.synchronize",
    "pull_request.closed",
    "pull_request.reopened",
    "pull_request.converted_to_draft",
    "pull_request.ready_for_review",
  ],
  ({ octokit, payload, id }) => {
    handlePullRequest(octokit, payload as unknown as PullRequestEvent, id);
  },
);

app.webhooks.on("check_run.completed", ({ octokit, payload, id }) => {
  handleCheckRun(octokit, payload as unknown as CheckRunEvent, id);
});

app.webhooks.on("check_suite.completed", ({ octokit, payload, id }) => {
  handleCheckSuite(octokit, payload as unknown as CheckSuiteEvent, id);
});

// Cache write-through (issue #130): every action that mutates a field
// stored in `target_cache` is subscribed so the chat-thread cache stays
// fresh without waiting for a cold-miss backfill. Dispatch is still
// gated to `labeled` by the early-returns inside `handleIssues`; the
// other actions are cache-only.
app.webhooks.on(
  [
    "issues.opened",
    "issues.edited",
    "issues.closed",
    "issues.reopened",
    "issues.deleted",
    "issues.labeled",
    "issues.unlabeled",
  ],
  ({ octokit, payload, id }) => {
    handleIssues(octokit, payload as unknown as IssuesEvent, id);
  },
);

app.webhooks.on("pull_request_review.submitted", ({ octokit, payload, id }) => {
  handleReview(octokit, payload as unknown as PullRequestReviewEvent, id);
});

app.webhooks.on(
  [
    "pull_request_review_comment.created",
    "pull_request_review_comment.edited",
    "pull_request_review_comment.deleted",
  ],
  ({ octokit, payload, id }) => {
    handleReviewComment(octokit, payload as unknown as PullRequestReviewCommentEvent, id);
  },
);

// "pull_request_review_thread.created" is NOT a valid GitHub action.
// The correct actions are "resolved" and "unresolved".
app.webhooks.on(
  ["pull_request_review_thread.resolved", "pull_request_review_thread.unresolved"],
  ({ octokit, payload, id }) => {
    handleReviewThread(octokit, payload as unknown as PullRequestReviewThreadEvent, id);
  },
);

// `@octokit/webhooks` routes BOTH HMAC verification failures and downstream
// handler exceptions through this single callback as an AggregateError. The
// `http.webhook.error` line splits them via `kind` so an operator can alert on
// "signature verification failing >N/min" (a stale GITHUB_WEBHOOK_SECRET drops
// 100% of deliveries) separately from a handler throw. NEVER logs the
// signature bytes, the secret, or the raw body, only the FACT of failure plus
// the GitHub-bounded delivery id / event name when present (issue #247).
app.webhooks.onError((error) => {
  const { kind, deliveryId, eventName } = classifyWebhookError(error);
  logger.warn(
    {
      event: HTTP_LOG_EVENTS.webhookError,
      kind,
      ...(deliveryId !== undefined ? { deliveryId } : {}),
      ...(eventName !== undefined ? { event_name: eventName } : {}),
      err: error,
    },
    "Webhook processing error",
  );
});

/**
 * Classify an `@octokit/webhooks` `onError` AggregateError into the bounded
 * metadata the `http.webhook.error` line carries. Reads only the
 * GitHub-bounded `id` / `name` off the wrapped event, never the signature or
 * payload bytes. A signature mismatch carries the marker message
 * "signature does not match" (see verify-and-receive.js) and HTTP status 400.
 */
function classifyWebhookError(error: unknown): {
  kind: "signature_mismatch" | "handler_threw" | "other";
  deliveryId: string | undefined;
  eventName: string | undefined;
} {
  const agg = error as {
    errors?: { message?: unknown }[];
    event?: { id?: unknown; name?: unknown } | undefined;
  };
  const inner = Array.isArray(agg.errors) ? agg.errors : [];
  const isSignatureMismatch = inner.some(
    (e) => typeof e.message === "string" && e.message.includes("signature does not match"),
  );
  const ev = agg.event;
  const deliveryId = typeof ev?.id === "string" && ev.id.length > 0 ? ev.id : undefined;
  const eventName = typeof ev?.name === "string" && ev.name.length > 0 ? ev.name : undefined;
  const kind = isSignatureMismatch
    ? "signature_mismatch"
    : eventName !== undefined
      ? "handler_threw"
      : "other";
  return { kind, deliveryId, eventName };
}

// Create the webhook middleware that handles signature verification.
// Uses @octokit/webhooks directly (not @octokit/app's wrapper) to avoid
// the OAuth dependency. Per official GitHub docs:
// https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-github-app-that-responds-to-webhook-events
const webhookMiddleware = createNodeMiddleware(app.webhooks, {
  path: "/api/github/webhooks",
});

// Readiness flag -- starts false until async startup checks pass.
// Set to false again during shutdown to stop accepting new work.
let isReady = false;

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    // Liveness: is the process alive? (no external deps)
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return;
  }
  if (req.url === "/readyz") {
    // Readiness: should we receive traffic?
    // Server mode always needs Valkey (FM-7); daemon mode skips this file entirely.
    const valkeyHealthy = isValkeyHealthy();
    const ready = isReady && valkeyHealthy;
    if (!ready) {
      // Info-level (issue #247): a 503 means we are refusing traffic, an
      // operator wants this at the LOG_LEVEL=info baseline to see startup
      // races / Valkey reconnect storms. /healthz stays silent (k8s liveness
      // hammers it). The two flags name which gate is false.
      logger.info(
        { event: HTTP_LOG_EVENTS.readyzUnready, is_ready: isReady, valkey_healthy: valkeyHealthy },
        "/readyz returning 503",
      );
    }
    res
      .writeHead(ready ? 200 : 503, { "Content-Type": "text/plain" })
      .end(ready ? "ready" : "not ready");
    return;
  }

  // Reject non-health traffic until startup checks (including DB migrations) finish.
  if (!isReady) {
    res.writeHead(503, { "Content-Type": "text/plain" }).end("not ready");
    return;
  }

  // Dev-only test endpoint: simulate a webhook event without HMAC verification.
  // Builds a BotContext with a mock Octokit and skipTrackingComments: true,
  // then feeds it into the normal processRequest() pipeline.
  if (req.url === "/api/test/webhook" && req.method === "POST") {
    if (config.nodeEnv === "production") {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
      return;
    }
    void handleTestWebhook(req, res);
    return;
  }

  // Operator endpoint: force one scheduled action to run now (the
  // `workflow_dispatch` analogue). Authenticated with the daemon auth token
  // since it triggers an agent run; 404 when the scheduler is disabled.
  if (req.url === "/api/scheduler/run" && req.method === "POST") {
    void handleSchedulerRun(req, res);
    return;
  }

  // Webhook entry (issue #247). `http.webhook.received` records the inbound
  // delivery with its GitHub-bounded delivery id + event name (header values,
  // not body) and the HTTP-handler wall-clock around the middleware, which
  // verifies HMAC and dispatches. A signature mismatch surfaces separately via
  // `onError` -> `http.webhook.error`; this line is the per-receipt access log.
  const deliveryId = headerString(req.headers["x-github-delivery"]);
  const eventName = headerString(req.headers["x-github-event"]);
  const startedAt = Date.now();
  void webhookMiddleware(req, res).finally(() => {
    if (deliveryId !== undefined && eventName !== undefined) {
      logger.info(
        {
          event: HTTP_LOG_EVENTS.webhookReceived,
          deliveryId,
          event_name: eventName,
          duration_ms: Date.now() - startedAt,
        },
        "Webhook received",
      );
    }
  });
});

/** Narrow a Node header value (string | string[] | undefined) to a non-empty string. */
function headerString(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

server.listen(config.port, () => {
  logger.info({ port: config.port }, "Server started");
});

/**
 * Dev-only test webhook handler. Parses a JSON body, builds a BotContext with
 * a mock Octokit (no real GitHub API calls), sets skipTrackingComments: true,
 * and feeds it into processRequest() to exercise the full orchestrator → daemon flow.
 */
async function handleTestWebhook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const { createChildLogger } = await import("./logger");
  const { processRequest } = await import("./webhook/router");

  try {
    const body = await new Promise<string>((resolve, reject) => {
      let data = "";
      req.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      req.on("end", () => {
        resolve(data);
      });
      req.on("error", reject);
    });

    const payload = JSON.parse(body) as {
      owner?: string;
      repo?: string;
      entityNumber?: number;
      isPR?: boolean;
      triggerBody?: string;
      eventName?: string;
      dryRun?: boolean;
    };

    const owner = payload.owner ?? "chrisleekr";
    const repo = payload.repo ?? "github-app";
    const entityNumber = payload.entityNumber ?? 1;
    const isPR = payload.isPR ?? false;
    const triggerBody =
      payload.triggerBody ?? `${config.triggerPhrase} what files are in this repo?`;
    const dryRun = payload.dryRun ?? true;
    const eventName = (payload.eventName ?? "issue_comment") as BotContext["eventName"];
    const deliveryId = `test-${randomUUID()}`;

    // Mock Octokit that logs instead of calling GitHub API.
    // Only used by the router path (capacity / spawn-failed comments).
    // The daemon creates its own real Octokit from the installation token.
    const mockOctokit = buildMockOctokit();

    const log = createChildLogger({
      deliveryId,
      owner,
      repo,
      entityNumber,
    });

    const ctx: BotContext = {
      owner,
      repo,
      entityNumber,
      isPR,
      eventName,
      triggerUsername: "test-user",
      triggerTimestamp: new Date().toISOString(),
      triggerBody,
      commentId: -1,
      deliveryId,
      labels: [],
      skipTrackingComments: true,
      dryRun,
      defaultBranch: "main",
      octokit: mockOctokit,
      log,
    };

    logger.info(
      { deliveryId, owner, repo, entityNumber, isPR, dryRun },
      "[test-webhook] Dispatching",
    );

    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ accepted: true, deliveryId }));

    processRequest(ctx).catch((err: unknown) => {
      log.error({ err }, "[test-webhook] processRequest failed");
    });
  } catch (err) {
    logger.error({ err }, "[test-webhook] Failed to parse request");
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON body" }));
  }
}

/**
 * Async startup checks. Runs after the HTTP server is listening so that the
 * process does not silently fail mid-request on a missing script or stale file.
 *
 * 1. Verify MCP server scripts are accessible (access() with F_OK).
 *    These scripts are spawned on every request; a missing file causes a cryptic
 *    runtime error deep in the pipeline rather than a clear startup failure.
 * 2. Sweep stale credential helper scripts (*.cred.sh) left behind by a
 *    previous pod lifetime that was SIGKILL-ed mid-checkout.
 */
async function runStartupChecks(): Promise<void> {
  // Use process.cwd() (always the project root, /app in Docker) so the path matches
  // how registry.ts spawns these servers, CWD-relative dist/mcp/servers/*.js.
  // import.meta.dir would resolve to src/ in dev and dist/ in prod, breaking one or the other.
  const mcpScripts = [
    join(process.cwd(), "dist/mcp/servers/comment.js"),
    join(process.cwd(), "dist/mcp/servers/inline-comment.js"),
  ];

  for (const scriptPath of mcpScripts) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await access(scriptPath, constants.F_OK);
      logger.info({ scriptPath }, "MCP script accessible");
    } catch {
      logger.error({ scriptPath }, "MCP script not accessible, cannot start");
      process.exit(1);
    }
  }

  // Reclaim workspace triples (clone dir + `.cred.sh` token helper +
  // `-artifacts`) orphaned in cloneBaseDir when a pod was SIGKILL-ed
  // mid-run, to avoid leaking installation tokens and disk across restarts
  // (issue #221).
  await sweepStaleWorkspaces(config.cloneBaseDir, config.workspaceStaleTtlMs, logger);

  const db = getDb();
  if (db !== null) {
    await runMigrations(db);
    logger.info("Database migrations completed");

    // Recover stale executions from previous server lifetime (FM-4).
    // Runs AFTER migrations, BEFORE WebSocket server accepts connections.
    await recoverStaleExecutions(db);
  }

  // Block until Valkey is actually connected (FM-7). Without this, isReady
  // flips true synchronously while RedisClient.onconnect fires on a later
  // tick, producing 503s on /readyz until then. See src/orchestrator/valkey.ts.
  await connectValkey();

  // Publish this orchestrator's liveness key BEFORE the Valkey orphan sweep
  // so concurrently-starting peers don't misidentify us as dead and drain
  // our own processing list out from under us.
  const instanceId = getInstanceId();
  await startInstanceHeartbeat();

  // Best-effort recovery passes. None of these block startup if they fail,
  // the queue worker still comes up and makes forward progress.
  try {
    await sweepValkeyOrphans(instanceId);
  } catch (err) {
    logger.error({ err }, "Valkey orphan sweep failed, continuing startup");
  }
  try {
    await recoverProcessingList(instanceId);
  } catch (err) {
    logger.error({ err }, "recoverProcessingList failed, continuing startup");
  }

  // One eager reaper pass on startup catches rows abandoned by a previous
  // crash before the periodic timer's first tick. Then start the timer.
  try {
    await reapLivenessOnce();
  } catch (err) {
    logger.error({ err }, "Initial liveness reaper pass failed, continuing startup");
  }
  startLivenessReaper();

  // Periodic fleet-state gauge so queue depth / pool saturation are log-visible
  // even when no webhook is arriving to trigger an on-demand read (issue #174).
  startFleetSnapshot(config.fleetSnapshotIntervalMs);

  // CLOSE_WAIT socket-spin watchdog for the HTTP listener (issue #265). Does
  // not fix #264, it detects the signature and structurally logs it, and
  // optionally self-heals by exiting. Fire-and-forget: the probe reads procfs
  // and must never delay startup or the listener.
  void startSocketHealthWatchdog({
    intervalMs: config.socketHealthIntervalMs,
    port: config.port,
    leakSamples: config.socketHealthLeakSamples,
    selfHealSamples: config.socketHealthSelfHealSamples,
    cpuPercent: config.socketHealthCpuPercent,
    selfHealEnabled: config.socketHealthSelfHealEnabled,
  }).catch((err: unknown) => {
    logger.error({ err }, "Socket health watchdog failed to start, continuing");
  });

  startWebSocketServer();
  logger.info({ wsPort: config.wsPort }, "Orchestrator WebSocket server started");

  // Queue worker is started AFTER the WS server so any leased-then-dispatched
  // offers have a listening server to receive the eventual job:accept reply.
  startQueueWorker();

  // Ship-intent tickle scheduler. start() performs the boot reconciliation
  // against ship_continuations AND begins the periodic scan in a single
  // call (verified in src/workflows/ship/tickle-scheduler.ts), there is
  // no separate reconcile method to invoke.
  shipTickleScheduler = createTickleScheduler({
    valkey: requireValkeyClient(),
    onDue: (intent_id) =>
      resumeShipIntent({
        intentId: intent_id,
        // PAT mode short-circuit: the PAT replaces the installation token
        // for ALL GitHub API calls. Resume actions (push, comments, PR
        // edits) must therefore run as the PAT user, not the App identity,
        // to honour the contract documented in CLAUDE.md.
        // Otherwise reuse the App singleton; cached installation tokens
        // save a JWT mint per resume.
        octokitFactory: async (installationId) =>
          config.githubPersonalAccessToken !== undefined
            ? new Octokit({ auth: config.githubPersonalAccessToken })
            : (
                await mintInstallationToken({
                  app,
                  installationId,
                  via: "shipTickleResume",
                  log: logger,
                })
              ).octokit,
      }),
  });
  await shipTickleScheduler.start();
  logger.info({ event: "ship.tickle.started" }, "Ship-intent tickle scheduler started");

  // Chat-thread proposal poller (FIX R2#2). Periodic reaction scan +
  // expired-row cleanup. No-op when DATABASE_URL is unset; resolves
  // installations on demand via apps.getRepoInstallation since
  // chat_proposals does not carry installation_id.
  proposalPoller = startProposalPoller({
    resolveOctokit: async (installationId) =>
      (await mintInstallationToken({ app, installationId, via: "proposalPoller", log: logger }))
        .octokit,
    resolveInstallationId: async (q) => {
      try {
        const r = await app.octokit.rest.apps.getRepoInstallation({
          owner: q.owner,
          repo: q.repo,
        });
        return r.data.id;
      } catch (err) {
        logger.debug(
          { err, owner: q.owner, repo: q.repo },
          "proposal-poller: getRepoInstallation lookup failed",
        );
        return null;
      }
    },
  });

  // Scheduled-actions scheduler (.github-app.yaml). `start()` is a no-op
  // when SCHEDULER_ENABLED is false, no DB is configured, or ALLOWED_OWNERS
  // is unset, so it is safe to construct unconditionally.
  scheduledActionScheduler = createScheduler({ app });
  await scheduledActionScheduler.start();

  isReady = true;
  logger.info({ valkeyHealthy: isValkeyHealthy() }, "Startup checks passed, server is ready");
}

let shipTickleScheduler: TickleScheduler | null = null;
let proposalPoller: ProposalPollerHandle | null = null;
let scheduledActionScheduler: SchedulerHandle | null = null;

void runStartupChecks().catch((err: unknown) => {
  logger.error({ err }, "Startup checks failed unexpectedly");
  process.exit(1);
});

/**
 * Precomputed expected `Authorization` values for the operator scheduler
 * endpoint. `null` when no daemon auth token is configured, in which case
 * the endpoint rejects every request. Reuses the WS server's comparator so
 * operator auth honours the same `DAEMON_AUTH_TOKEN_PREVIOUS` rotation
 * window as the daemon handshake.
 */
const schedulerAuthExpectations =
  config.daemonAuthToken !== undefined
    ? buildAuthExpectations(config.daemonAuthToken, config.daemonAuthTokenPrevious)
    : null;

/** Max accepted body size for `POST /api/scheduler/run`; the payload is tiny. */
const MAX_SCHEDULER_BODY_BYTES = 4096;

/**
 * Constant-time bearer-token check for the operator scheduler endpoint.
 * The endpoint triggers an agent run, so it is gated on the daemon auth
 * token (an existing operator secret) rather than left unauthenticated.
 */
function schedulerBearerOk(header: string | undefined): boolean {
  if (schedulerAuthExpectations === null) return false;
  return isAuthHeaderValid(header, schedulerAuthExpectations);
}

/**
 * Operator endpoint handler: `POST /api/scheduler/run` with a JSON body
 * `{ owner, repo, action }`. Forces one scheduled action to run now,
 * bypassing the cron check. 404 when the scheduler is disabled, 401 on a
 * bad token.
 */
async function handleSchedulerRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!config.schedulerEnabled || scheduledActionScheduler === null) {
    logger.warn(
      { event: HTTP_LOG_EVENTS.schedulerRunRejectedDisabled, status: 404 },
      "scheduler: manual run rejected (disabled)",
    );
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
    return;
  }
  if (!schedulerBearerOk(req.headers.authorization)) {
    // Logs the FACT of rejection only, never the provided token.
    logger.warn(
      { event: HTTP_LOG_EVENTS.schedulerRunRejectedUnauth, status: 401 },
      "scheduler: manual run rejected (unauthorized)",
    );
    res.writeHead(401, { "Content-Type": "text/plain" }).end("unauthorized");
    return;
  }
  try {
    // The payload is a tiny `{ owner, repo, action }` object. Cap the body
    // so a slowloris-style or oversized upload cannot pressure memory before
    // the parse/validation below even runs. On overflow the 413 is written
    // from the data handler; the post-await `headersSent` guard then bails.
    const body = await new Promise<string>((resolve, reject) => {
      let data = "";
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        if (res.headersSent) return;
        size += chunk.length;
        if (size > MAX_SCHEDULER_BODY_BYTES) {
          logger.warn(
            {
              event: HTTP_LOG_EVENTS.schedulerRunRejectedPayload,
              status: 413,
              reason: "body_too_large",
            },
            "scheduler: manual run rejected (body too large)",
          );
          res
            .writeHead(413, { "Content-Type": "application/json" })
            .end(JSON.stringify({ error: "request body too large" }));
          req.destroy();
          resolve("");
          return;
        }
        data += chunk.toString();
      });
      req.on("end", () => {
        resolve(data);
      });
      req.on("error", reject);
    });
    if (res.headersSent) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      // Malformed client input is a 400, not a 500.
      logger.warn(
        { event: HTTP_LOG_EVENTS.schedulerRunRejectedPayload, status: 400, reason: "invalid_json" },
        "scheduler: manual run rejected (invalid JSON)",
      );
      res
        .writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: "request body is not valid JSON" }));
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      // A valid JSON literal that is not an object (null, number, string) is
      // still malformed input for this endpoint: 400, not 500.
      logger.warn(
        { event: HTTP_LOG_EVENTS.schedulerRunRejectedPayload, status: 400, reason: "not_object" },
        "scheduler: manual run rejected (not a JSON object)",
      );
      res
        .writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: "request body must be a JSON object" }));
      return;
    }
    const payload = parsed as { owner?: unknown; repo?: unknown; action?: unknown };
    if (
      typeof payload.owner !== "string" ||
      typeof payload.repo !== "string" ||
      typeof payload.action !== "string"
    ) {
      logger.warn(
        {
          event: HTTP_LOG_EVENTS.schedulerRunRejectedPayload,
          status: 400,
          reason: "missing_field",
        },
        "scheduler: manual run rejected (missing field)",
      );
      res
        .writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: "owner, repo, and action are required" }));
      return;
    }
    const result = await scheduledActionScheduler.runAction({
      owner: payload.owner,
      repo: payload.repo,
      actionName: payload.action,
    });
    const status = result.enqueued ? 202 : 409;
    logger.info(
      { event: HTTP_LOG_EVENTS.schedulerRunEnqueued, status, enqueued: result.enqueued },
      "scheduler: manual run accepted",
    );
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(result));
  } catch (err) {
    logger.error(
      { event: HTTP_LOG_EVENTS.schedulerRunFailed, status: 500, err },
      "scheduler: manual run endpoint failed",
    );
    res
      .writeHead(500, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: "internal error" }));
  }
}

/**
 * Graceful shutdown handler.
 * Sets readiness to false, then closes the server (waits for in-flight requests).
 * In-flight review cleanup callbacks (checkoutRepo) will run in their finally blocks.
 */
function shutdown(signal: string): void {
  logger.info({ signal }, "Received shutdown signal");
  isReady = false;

  server.close(() => {
    void (async (): Promise<void> => {
      try {
        // Stop the tickle scheduler FIRST so no resume callbacks fire
        // mid-drain. Then stop the queue worker so no new offers go out
        // during WS shutdown. Then drain the WebSocket server (daemon
        // disconnect cleanup still uses Valkey). Then release this
        // instance's liveness key so peers immediately pick up our leased
        // jobs via the reaper. Close Valkey + DB last, once nothing else
        // needs them.
        if (shipTickleScheduler !== null) {
          shipTickleScheduler.stop();
          shipTickleScheduler = null;
        }
        if (scheduledActionScheduler !== null) {
          scheduledActionScheduler.stop();
          scheduledActionScheduler = null;
        }
        if (proposalPoller !== null) {
          proposalPoller.stop();
          proposalPoller = null;
        }
        await stopQueueWorker();
        stopLivenessReaper();
        stopFleetSnapshot();
        stopSocketHealthWatchdog();
        await stopWebSocketServer();
        await stopInstanceHeartbeat();
        closeValkey();
        await closeDb();
        logger.info("Server closed, exiting");
        process.exit(0);
      } catch (err) {
        logger.error({ err }, "Failed to close resources during shutdown");
        process.exit(1);
      }
    })();
  });

  // Force exit after terminationGracePeriodSeconds if server.close hangs
  setTimeout(() => {
    logger.warn("Forced exit after timeout");
    process.exit(1);
  }, 290_000); // 10s below K8s default terminationGracePeriodSeconds (300s)
}

// Route crashes through the redacting pino chokepoint instead of the
// runtime's default plaintext stderr stack (issue #164).
installFatalHandlers("orchestrator");

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  shutdown("SIGINT");
});

/**
 * Build a Proxy-based mock Octokit for the test webhook endpoint.
 * Intercepts all `rest.*.*()` calls and `auth()`, logging instead of hitting GitHub.
 */
function buildMockOctokit(): BotContext["octokit"] {
  type MockApiMethod = (...args: unknown[]) => Promise<{ data: unknown[] }>;

  const methodProxy = new Proxy({} as Record<string, MockApiMethod>, {
    get(_t, method: string): MockApiMethod {
      return (...args: unknown[]): Promise<{ data: unknown[] }> => {
        logger.info(
          { method, args: JSON.stringify(args).slice(0, 200) },
          "[test-webhook] Mock Octokit call",
        );
        return Promise.resolve({ data: [] });
      };
    },
  });

  const restProxy = new Proxy({} as Record<string, typeof methodProxy>, {
    get(): typeof methodProxy {
      return methodProxy;
    },
  });

  return {
    rest: restProxy,
    auth: (): Promise<{ token: string }> => Promise.resolve({ token: "mock-test-token" }),
  } as unknown as BotContext["octokit"];
}
