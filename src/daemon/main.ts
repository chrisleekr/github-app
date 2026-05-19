import { platform } from "node:os";

import { config } from "../config";
import { logger } from "../logger";
import type { DaemonCapabilities } from "../shared/daemon-types";
import {
  createMessageEnvelope,
  type ScopedJobKind,
  type ServerMessage,
  WS_REJECT_REASONS,
} from "../shared/ws-messages";
import { getDaemonId } from "./daemon-id";
import { buildHeartbeatPong } from "./health-reporter";
import {
  evaluateOffer,
  evaluateScopedOffer,
  executeJob,
  getActiveJobCount,
  handleJobCancel,
  registerExitCleanup,
} from "./job-executor";
import { discoverCapabilities, getCurrentResources } from "./tool-discovery";
import { DaemonWsClient } from "./ws-client";

/**
 * Scoped jobKinds this daemon image understands. Reject any other kind
 * via `WS_REJECT_REASONS.SCOPED_KIND_UNSUPPORTED` so the orchestrator
 * can re-offer to a capable daemon (FR-021 forward-compat).
 */
const SUPPORTED_SCOPED_KINDS: readonly ScopedJobKind[] = [
  "scoped-rebase",
  "scoped-fix-thread",
  "scoped-open-pr",
  "scheduled-action",
] as const;

const daemonId = getDaemonId();

// State

let capabilities: DaemonCapabilities;
let wsClient: DaemonWsClient;
let draining = false;
let spotCheckInterval: Timer | null = null;
let ephemeralIdleCheckInterval: Timer | null = null;
/**
 * Wall-clock timestamp of the last moment this daemon saw activity
 * (registered, took a job offer, or finished one). Used only by the
 * ephemeral idle-exit loop.
 */
let lastActiveAtMs = Date.now();

function markActive(): void {
  lastActiveAtMs = Date.now();
}

// Platform-aware drain timeout (T040, FM-10)

async function detectPlatformTerminationDeadline(): Promise<number> {
  // AWS Spot: 2-minute warning
  try {
    const resp = await fetch("http://169.254.169.254/latest/meta-data/instance-life-cycle", {
      signal: AbortSignal.timeout(500),
    });
    if (resp.ok && (await resp.text()) === "spot") return 120_000;
  } catch {
    /* not on AWS */
  }

  // GCP Preemptible: 30-second warning
  try {
    const resp = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/scheduling/preemptible",
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(500) },
    );
    if (resp.ok && (await resp.text()) === "TRUE") return 30_000;
  } catch {
    /* not on GCP */
  }

  return Infinity; // Not on ephemeral infrastructure
}

// Graceful shutdown (T039, FM-5)

let effectiveDrainTimeout: number;

function initiateGracefulShutdown(reason: string): void {
  if (draining) return;
  draining = true;

  logger.info({ reason, activeJobs: getActiveJobCount() }, "Initiating graceful shutdown");

  wsClient.send({
    type: "daemon:draining",
    ...createMessageEnvelope(),
    payload: {
      activeJobs: getActiveJobCount(),
      reason,
    },
  });

  const drainStart = Date.now();

  const checkInterval = setInterval(() => {
    if (getActiveJobCount() === 0) {
      clearInterval(checkInterval);
      logger.info("All active jobs completed, shutting down");
      wsClient.close(1000, "graceful shutdown");
      process.exit(0);
    }

    if (Date.now() - drainStart > effectiveDrainTimeout) {
      clearInterval(checkInterval);
      logger.warn(
        { activeJobs: getActiveJobCount() },
        "Drain timeout expired with active jobs, forcing shutdown",
      );
      wsClient.close(1000, "graceful shutdown (timeout)");
      process.exit(1);
    }
  }, 1000);
}

// Message handler

function handleMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case "daemon:registered":
      logger.info(
        {
          heartbeatIntervalMs: msg.payload.heartbeatIntervalMs,
          offerTimeoutMs: msg.payload.offerTimeoutMs,
        },
        "Registered with orchestrator",
      );
      break;

    case "heartbeat:ping": {
      void (async (): Promise<void> => {
        const { pong, updatedCapabilities } = await buildHeartbeatPong(
          msg,
          getActiveJobCount(),
          capabilities,
          config.cloneBaseDir,
        );
        // eslint-disable-next-line require-atomic-updates -- single-threaded; stale write is acceptable
        capabilities = updatedCapabilities;
        wsClient.send(pong);
      })();
      break;
    }

    case "job:offer": {
      if (draining) {
        wsClient.send({
          type: "job:reject",
          ...createMessageEnvelope(msg.id),
          payload: { reason: WS_REJECT_REASONS.SHUTTING_DOWN },
        });
        return;
      }

      capabilities = { ...capabilities, resources: getCurrentResources() };
      const evaluation = evaluateOffer(msg, capabilities);

      if (evaluation.accept) {
        // Mark active before accept so the ephemeral idle loop cannot
        // self-drain during the orchestrator-side token/context lookup
        // that runs before `job:payload` arrives.
        markActive();
        wsClient.send({
          type: "job:accept",
          ...createMessageEnvelope(msg.id),
          payload: {},
        });
      } else {
        wsClient.send({
          type: "job:reject",
          ...createMessageEnvelope(msg.id),
          payload: { reason: evaluation.reason ?? WS_REJECT_REASONS.INCOMPATIBLE },
        });
      }
      break;
    }

    case "scoped-job-offer": {
      if (draining) {
        wsClient.send({
          type: "job:reject",
          ...createMessageEnvelope(msg.id),
          payload: { reason: WS_REJECT_REASONS.SHUTTING_DOWN },
        });
        return;
      }

      capabilities = { ...capabilities, resources: getCurrentResources() };
      const evaluation = evaluateScopedOffer(msg, capabilities, SUPPORTED_SCOPED_KINDS);

      if (evaluation.accept) {
        markActive();
        wsClient.send({
          type: "job:accept",
          ...createMessageEnvelope(msg.id),
          payload: {},
        });
      } else {
        wsClient.send({
          type: "job:reject",
          ...createMessageEnvelope(msg.id),
          payload: { reason: evaluation.reason ?? WS_REJECT_REASONS.INCOMPATIBLE },
        });
      }
      break;
    }

    case "job:payload":
      markActive();
      void executeJob(msg, capabilities, (m) => {
        wsClient.send(m);
        if (
          typeof m === "object" &&
          m !== null &&
          (m as { type?: unknown }).type === "job:result"
        ) {
          markActive();
        }
      });
      break;

    case "job:cancel":
      handleJobCancel(msg, (m) => {
        wsClient.send(m);
      });
      break;

    case "daemon:update-required":
      handleUpdateRequired(msg);
      break;

    case "error":
      logger.error(
        { code: msg.payload.code, message: msg.payload.message },
        "Error from orchestrator",
      );
      break;
  }
}

// Update handler (T044, R-016)

function handleUpdateRequired(
  msg: Extract<ServerMessage, { type: "daemon:update-required" }>,
): void {
  const strategy = config.daemonUpdateStrategy;
  const baseDelay = config.daemonUpdateDelayMs;
  // Jitter: random 0-30s to prevent thundering herd
  const jitter = Math.round(Math.random() * 30_000);
  const delayMs = baseDelay + jitter;

  logger.warn(
    {
      targetVersion: msg.payload.targetVersion,
      reason: msg.payload.reason,
      urgent: msg.payload.urgent,
      strategy,
      delayMs,
    },
    "Update required by orchestrator",
  );

  const actualDelayMs = msg.payload.urgent ? 0 : delayMs;

  wsClient.send({
    type: "daemon:update-acknowledged",
    ...createMessageEnvelope(msg.id),
    payload: { strategy, delayMs: actualDelayMs },
  });

  setTimeout(() => {
    initiateGracefulShutdown(`auto-update to ${msg.payload.targetVersion}`);
  }, actualDelayMs);
}

// Spot termination notice polling (T041, FM-10)

function startSpotTerminationPolling(): void {
  if (!capabilities.ephemeral || platform() !== "linux") return;

  spotCheckInterval = setInterval((): void => {
    void (async (): Promise<void> => {
      try {
        const resp = await fetch("http://169.254.169.254/latest/meta-data/spot/instance-action", {
          signal: AbortSignal.timeout(1000),
        });
        if (resp.ok) {
          logger.warn("Spot termination notice detected, initiating graceful drain");
          if (spotCheckInterval !== null) {
            clearInterval(spotCheckInterval);
            spotCheckInterval = null;
          }
          initiateGracefulShutdown("spot termination notice");
        }
      } catch {
        // 404 = no termination pending, network error = ignore
      }
    })();
  }, 5_000);
  // Don't keep process alive just for spot polling
  spotCheckInterval.unref();
}

// Ephemeral idle-exit (DAEMON_EPHEMERAL=true only)

/**
 * When the daemon runs as an ephemeral K8s Pod, it must exit after a
 * period of idleness so the Pod is reclaimed and the orchestrator doesn't
 * keep paying for unused capacity. The persistent pool never exits on
 * idle: those Pods are replaced by operators, not self-terminated.
 */
function startEphemeralIdleLoop(): void {
  if (!capabilities.ephemeral) return;
  const idleTimeoutMs = config.ephemeralDaemonIdleTimeoutMs;
  ephemeralIdleCheckInterval = setInterval(() => {
    if (draining) return;
    const active = getActiveJobCount();
    if (active > 0) {
      markActive();
      return;
    }
    const idleFor = Date.now() - lastActiveAtMs;
    if (idleFor >= idleTimeoutMs) {
      if (ephemeralIdleCheckInterval !== null) {
        clearInterval(ephemeralIdleCheckInterval);
        ephemeralIdleCheckInterval = null;
      }
      logger.info({ idleForMs: idleFor, idleTimeoutMs }, "Ephemeral daemon idle, exiting");
      initiateGracefulShutdown("ephemeral idle timeout");
    }
  }, 5_000);
  ephemeralIdleCheckInterval.unref();
}

// Main

async function main(): Promise<void> {
  logger.info({ daemonId }, "Daemon starting");

  // Surface silent exits: if the event loop ever drains while we're not
  // explicitly shutting down, log it so future regressions of the "daemon
  // just disappeared" class are immediately visible.
  process.on("beforeExit", (code) => {
    logger.warn(
      { code, activeJobs: getActiveJobCount(), draining },
      "Event loop drained, about to exit",
    );
  });
  process.on("exit", (code) => {
    logger.info({ code, draining }, "Process exit");
  });

  registerExitCleanup();

  capabilities = await discoverCapabilities(config.cloneBaseDir);
  logger.info(
    {
      platform: capabilities.platform,
      cliTools: capabilities.cliTools.filter((t) => t.functional).map((t) => t.name),
      ephemeral: capabilities.ephemeral,
    },
    "Capabilities discovered",
  );

  // T040: drain timeout capped by platform termination deadline
  const platformDeadline = await detectPlatformTerminationDeadline();
  effectiveDrainTimeout = Math.min(
    config.daemonDrainTimeoutMs,
    platformDeadline === Infinity
      ? config.daemonDrainTimeoutMs
      : Math.max(5_000, platformDeadline - 10_000),
  );
  logger.info({ effectiveDrainTimeout, platformDeadline }, "Drain timeout configured");

  const orchestratorUrl = config.orchestratorUrl;
  if (orchestratorUrl === undefined) {
    logger.error("ORCHESTRATOR_URL is required for daemon mode");
    process.exit(1);
  }

  const authToken = config.daemonAuthToken;
  if (authToken === undefined) {
    logger.error("DAEMON_AUTH_TOKEN is required for daemon mode");
    process.exit(1);
  }

  wsClient = new DaemonWsClient({
    orchestratorUrl,
    authToken,
    daemonId,
    capabilities,
    onMessage: handleMessage,
    onConnected: (): void => {
      logger.info("Connected to orchestrator");
    },
    onDisconnected: (): void => {
      logger.info("Disconnected from orchestrator");
    },
  });

  wsClient.connect();

  startSpotTerminationPolling();
  startEphemeralIdleLoop();

  // Signal handlers (FM-5)
  process.on("SIGTERM", () => {
    initiateGracefulShutdown("SIGTERM received");
  });
  process.on("SIGINT", () => {
    initiateGracefulShutdown("SIGINT received");
  });
}

void main().catch((err: unknown) => {
  logger.error({ err }, "Daemon startup failed");
  process.exit(1);
});
