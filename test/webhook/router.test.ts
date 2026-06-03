/**
 * Router tests: post dispatch-collapse surface.
 *
 * The router now exposes these functions:
 *   - logDispatchDecision (pure telemetry)
 *   - decideDispatch      (triage → scaler → spawn? verdict)
 *   - dispatch            (routes spawn-failed vs persistent-daemon)
 *   - processRequest      (dev-test-endpoint-only: auth + capacity + dispatch)
 *
 * The in-memory idempotency Map + `isAlreadyProcessed` marker scan that
 * `processRequest` used to carry were retired in issue #211 (the path is
 * reachable only from the dev `/api/test/webhook` endpoint, which mints a
 * fresh delivery id per call; production handlers own redelivery dedup via
 * `claimDelivery` + `idx_workflow_runs_inflight`, issue #202).
 *
 * We mock every downstream surface that reaches over the network or hits
 * Valkey/Postgres: the router is a pure orchestrator.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { BotContext } from "../../src/types";
import { makeBotContext, makeOctokit } from "../factories";

// ─── Mocked downstream surfaces (persist across this process run) ─────────

const mockGetDb = mock(() => null as unknown);
void mock.module("../../src/db", () => ({
  getDb: mockGetDb,
}));

// Align with production: `spawnEphemeralDaemon` returns the Pod name as a
// bare string and `EphemeralSpawnError.kind` uses the 4-value taxonomy
// from `src/k8s/ephemeral-daemon-spawner.ts`. Drift here would exercise
// a branch the router can never hit in production.
const mockSpawnEphemeralDaemon = mock(() => Promise.resolve("ephemeral-daemon-xyz"));
class MockEphemeralSpawnError extends Error {
  constructor(
    public kind: "infra-absent" | "auth-load-failed" | "api-rejected" | "api-unavailable",
    message: string,
  ) {
    super(message);
  }
}
void mock.module("../../src/k8s/ephemeral-daemon-spawner", () => ({
  spawnEphemeralDaemon: mockSpawnEphemeralDaemon,
  EphemeralSpawnError: MockEphemeralSpawnError,
}));

const mockGetPersistentPoolFreeSlots = mock(() => Promise.resolve(5));
void mock.module("../../src/orchestrator/daemon-registry", () => ({
  getPersistentPoolFreeSlots: mockGetPersistentPoolFreeSlots,
}));

const mockDecideEphemeralSpawn = mock(
  () =>
    ({ spawn: false, skipReason: "no-signal" }) as
      | { spawn: true; trigger: "triage-heavy" | "queue-overflow" }
      | { spawn: false; skipReason: "no-signal" | "cooldown" },
);
const mockMarkSpawn = mock(() => {});
const mockRollbackSpawn = mock(() => {});
void mock.module("../../src/orchestrator/ephemeral-daemon-scaler", () => ({
  decideEphemeralSpawn: mockDecideEphemeralSpawn,
  markSpawn: mockMarkSpawn,
  rollbackSpawn: mockRollbackSpawn,
}));

const mockCreateExecution = mock(() => Promise.resolve());
void mock.module("../../src/orchestrator/history", () => ({
  createExecution: mockCreateExecution,
}));

const mockDispatchJob = mock(() => Promise.resolve(false));
void mock.module("../../src/orchestrator/job-dispatcher", () => ({
  dispatchJob: mockDispatchJob,
}));

const mockEnqueueJob = mock(() => Promise.resolve());
const mockGetQueueLength = mock(() => Promise.resolve(0));
void mock.module("../../src/orchestrator/job-queue", () => ({
  enqueueJob: mockEnqueueJob,
  getQueueLength: mockGetQueueLength,
  isScopedJob: () => false,
  SCOPED_JOB_KINDS: ["scoped-rebase", "scoped-fix-thread", "scoped-open-pr"],
}));

const mockTriageRequest = mock(() =>
  Promise.resolve({ outcome: "fallback" as const, reason: "disabled" as const }),
);
void mock.module("../../src/orchestrator/triage", () => ({
  triageRequest: mockTriageRequest,
}));

const mockIsValkeyHealthy = mock(() => true);
void mock.module("../../src/orchestrator/valkey", () => ({
  isValkeyHealthy: mockIsValkeyHealthy,
}));

const mockGetTriageLLMClient = mock(() => ({}) as unknown);
void mock.module("../../src/webhook/triage-client-factory", () => ({
  getTriageLLMClient: mockGetTriageLLMClient,
}));

// Import router AFTER mocks are set up.

const { decideDispatch, dispatch, logDispatchDecision, processRequest } =
  await import("../../src/webhook/router");
const { getActiveCount, decrementActiveCount } = await import("../../src/orchestrator/concurrency");
const { config } = await import("../../src/config");

// ─── Context / octokit factories ──────────────────────────────────────────

function makeCtx(overrides: Partial<BotContext> = {}): BotContext {
  return makeBotContext({
    owner: "chrisleekr",
    repo: "app",
    triggerUsername: "chrisleekr",
    triggerTimestamp: "2026-04-19T00:00:00Z",
    deliveryId: `del-${Math.random().toString(36).slice(2)}`,
    octokit: makeOctokit(),
    ...overrides,
  });
}

// ─── Config mutation helpers ──────────────────────────────────────────────

function withConfig<T>(patch: Record<string, unknown>, fn: () => T | Promise<T>): Promise<T> {
  const mutable = config as unknown as Record<string, unknown>;
  const keys = Object.keys(patch);
  const snapshot: Record<string, unknown> = {};
  for (const k of keys) {
    snapshot[k] = mutable[k];
    mutable[k] = patch[k];
  }
  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      for (const k of keys) {
        mutable[k] = snapshot[k];
      }
    });
}

// ─── Tests ────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockSpawnEphemeralDaemon.mockClear();
  mockSpawnEphemeralDaemon.mockImplementation(() => Promise.resolve("ephemeral-daemon-xyz"));
  mockMarkSpawn.mockClear();
  mockRollbackSpawn.mockClear();
  mockDecideEphemeralSpawn.mockClear();
  mockDecideEphemeralSpawn.mockImplementation(() => ({ spawn: false, skipReason: "no-signal" }));
  mockGetPersistentPoolFreeSlots.mockClear();
  mockGetPersistentPoolFreeSlots.mockImplementation(() => Promise.resolve(5));
  mockGetQueueLength.mockClear();
  mockGetQueueLength.mockImplementation(() => Promise.resolve(0));
  mockCreateExecution.mockClear();
  mockDispatchJob.mockClear();
  mockDispatchJob.mockImplementation(() => Promise.resolve(false));
  mockEnqueueJob.mockClear();
  mockTriageRequest.mockClear();
  mockTriageRequest.mockImplementation(() =>
    Promise.resolve({ outcome: "fallback" as const, reason: "disabled" as const }),
  );
  mockIsValkeyHealthy.mockClear();
  mockIsValkeyHealthy.mockImplementation(() => true);
  // Drain any active-count state left over from prior tests.
  while (getActiveCount() > 0) decrementActiveCount();
});

describe("logDispatchDecision", () => {
  it("emits the core dispatch fields", () => {
    const ctx = makeCtx();
    const calls: [Record<string, unknown>, string][] = [];
    (ctx.log as unknown as { info: (o: Record<string, unknown>, m: string) => void }).info = (
      o,
      m,
    ) => {
      calls.push([o, m]);
    };
    logDispatchDecision(ctx, { target: "daemon", reason: "persistent-daemon" });
    expect(calls.length).toBe(1);
    const [obj, msg] = calls[0] ?? [{}, ""];
    expect(msg).toBe("dispatch decision");
    expect(obj["dispatchTarget"]).toBe("daemon");
    expect(obj["dispatchReason"]).toBe("persistent-daemon");
    expect(obj["triageInvoked"]).toBe(false);
  });

  it("includes triage fields when present", () => {
    const ctx = makeCtx();
    const calls: [Record<string, unknown>, string][] = [];
    (ctx.log as unknown as { info: (o: Record<string, unknown>, m: string) => void }).info = (
      o,
      m,
    ) => {
      calls.push([o, m]);
    };
    logDispatchDecision(ctx, {
      target: "daemon",
      reason: "ephemeral-daemon-triage",
      triageAttempted: true,
      triage: {
        heavy: true,
        confidence: 0.9,
        rationale: "multi-service",
        costUsd: 0.001,
        latencyMs: 300,
        provider: "anthropic",
        model: "claude-3-5-haiku-20241022",
        deliveryId: ctx.deliveryId,
      },
    });
    const [obj] = calls[0] ?? [{}];
    expect(obj["triageHeavy"]).toBe(true);
    expect(obj["triageConfidence"]).toBe(0.9);
    expect(obj["triageInvoked"]).toBe(true);
  });

  it("includes spawnError when ephemeral-spawn-failed", () => {
    const ctx = makeCtx();
    const calls: [Record<string, unknown>, string][] = [];
    (ctx.log as unknown as { info: (o: Record<string, unknown>, m: string) => void }).info = (
      o,
      m,
    ) => {
      calls.push([o, m]);
    };
    logDispatchDecision(ctx, {
      target: "daemon",
      reason: "ephemeral-spawn-failed",
      spawnError: "api-unavailable: 403 forbidden",
    });
    const [obj] = calls[0] ?? [{}];
    expect(obj["spawnError"]).toBe("api-unavailable: 403 forbidden");
  });
});

describe("decideDispatch", () => {
  it("returns persistent-daemon when scaler declines to spawn", async () => {
    mockDecideEphemeralSpawn.mockImplementation(() => ({ spawn: false, skipReason: "no-signal" }));
    const decision = await decideDispatch(makeCtx());
    expect(decision).toEqual({ target: "daemon", reason: "persistent-daemon" });
  });

  it("returns ephemeral-daemon-triage when scaler fires on heavy signal", async () => {
    await withConfig(
      {
        daemonImage: "ghcr.io/org/daemon:1.0.0",
        orchestratorPublicUrl: "wss://orch.example.com",
        daemonAuthToken: "auth-tok",
      },
      async () => {
        mockDecideEphemeralSpawn.mockReturnValue({
          spawn: true,
          trigger: "triage-heavy",
        });
        const decision = await decideDispatch(makeCtx());
        expect(decision.reason).toBe("ephemeral-daemon-triage");
        expect(mockSpawnEphemeralDaemon).toHaveBeenCalledTimes(1);
        expect(mockMarkSpawn).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("returns ephemeral-daemon-overflow when scaler fires on queue pressure", async () => {
    await withConfig(
      {
        daemonImage: "ghcr.io/org/daemon:1.0.0",
        orchestratorPublicUrl: "wss://orch.example.com",
        daemonAuthToken: "auth-tok",
      },
      async () => {
        mockDecideEphemeralSpawn.mockReturnValue({
          spawn: true,
          trigger: "queue-overflow",
        });
        const decision = await decideDispatch(makeCtx());
        expect(decision.reason).toBe("ephemeral-daemon-overflow");
      },
    );
  });

  it("returns ephemeral-spawn-failed when required config is missing", async () => {
    await withConfig({ daemonImage: undefined, orchestratorPublicUrl: undefined }, async () => {
      mockDecideEphemeralSpawn.mockReturnValue({
        spawn: true,
        trigger: "triage-heavy",
      });
      const decision = await decideDispatch(makeCtx());
      expect(decision.reason).toBe("ephemeral-spawn-failed");
      expect(decision.spawnError).toContain("infra-absent");
      expect(mockSpawnEphemeralDaemon).toHaveBeenCalledTimes(0);
    });
  });

  it("returns ephemeral-spawn-failed when K8s spawn throws EphemeralSpawnError", async () => {
    await withConfig(
      {
        daemonImage: "ghcr.io/org/daemon:1.0.0",
        orchestratorPublicUrl: "wss://orch.example.com",
        daemonAuthToken: "auth-tok",
      },
      async () => {
        mockDecideEphemeralSpawn.mockReturnValue({
          spawn: true,
          trigger: "triage-heavy",
        });
        mockSpawnEphemeralDaemon.mockRejectedValueOnce(
          new MockEphemeralSpawnError("api-unavailable", "api-server unreachable"),
        );
        const decision = await decideDispatch(makeCtx());
        expect(decision.reason).toBe("ephemeral-spawn-failed");
        expect(decision.spawnError).toBe("api-unavailable: api-server unreachable");
        // The router reserves the cooldown slot BEFORE awaiting the K8s
        // round-trip (to prevent a thundering herd of concurrent spawns)
        // and then rolls it back on failure so the next attempt isn't
        // blocked. `rollbackSpawn` takes the reserved timestamp and only
        // clears the slot if it still matches, preventing it from
        // trampling a concurrent successful reservation.
        expect(mockMarkSpawn).toHaveBeenCalledTimes(1);
        expect(mockRollbackSpawn).toHaveBeenCalledTimes(1);
        expect(mockRollbackSpawn.mock.calls[0]?.[0]).toBe(mockMarkSpawn.mock.calls[0]?.[0]);
      },
    );
  });

  it("carries the triage result through when present", async () => {
    mockTriageRequest.mockImplementation(() =>
      Promise.resolve({
        outcome: "result" as const,
        result: {
          heavy: false,
          confidence: 0.9,
          rationale: "small",
          costUsd: 0.0005,
          latencyMs: 100,
          provider: "anthropic" as const,
          model: "claude-3-5-haiku-20241022",
          deliveryId: "x",
        },
      }),
    );
    const decision = await decideDispatch(makeCtx());
    expect(decision.triage?.heavy).toBe(false);
    expect(decision.triageAttempted).toBe(true);
  });
});

describe("dispatch", () => {
  it("routes ephemeral-spawn-failed to the infra-unavailable rejection path", async () => {
    const ctx = makeCtx();
    await dispatch(ctx, {
      target: "daemon",
      reason: "ephemeral-spawn-failed",
      spawnError: "api-unavailable: boom",
    });
    const createComment = (
      ctx.octokit as unknown as {
        rest: { issues: { createComment: ReturnType<typeof mock> } };
      }
    ).rest.issues.createComment;
    expect(createComment).toHaveBeenCalledTimes(1);
    const body = (createComment.mock.calls[0] as [{ body: string }])[0].body;
    expect(body).toContain("Kubernetes infrastructure");
    // Must NOT inline the raw spawnError into the public comment, k8s
    // exception strings can carry API URLs, RBAC detail, or other
    // operational info. The structured spawnError remains on the log
    // line and in the executions row.
    expect(body).not.toContain("api-unavailable: boom");
  });

  it("enqueues to daemon when no claimable daemon is ready", async () => {
    mockDispatchJob.mockImplementation(() => Promise.resolve(false));
    const ctx = makeCtx();
    await dispatch(ctx, { target: "daemon", reason: "persistent-daemon" });
    expect(mockCreateExecution).toHaveBeenCalledTimes(1);
    expect(mockDispatchJob).toHaveBeenCalledTimes(1);
    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
  });

  it("does NOT enqueue when a daemon claims the job directly", async () => {
    mockDispatchJob.mockImplementation(() => Promise.resolve(true));
    const ctx = makeCtx();
    await dispatch(ctx, { target: "daemon", reason: "persistent-daemon" });
    expect(mockDispatchJob).toHaveBeenCalledTimes(1);
    expect(mockEnqueueJob).toHaveBeenCalledTimes(0);
  });

  it("posts Valkey-unavailable comment and aborts when Valkey is down", async () => {
    mockIsValkeyHealthy.mockImplementation(() => false);
    const ctx = makeCtx();
    await dispatch(ctx, { target: "daemon", reason: "persistent-daemon" });
    expect(mockCreateExecution).toHaveBeenCalledTimes(0);
    const createComment = (
      ctx.octokit as unknown as {
        rest: { issues: { createComment: ReturnType<typeof mock> } };
      }
    ).rest.issues.createComment;
    const body = (createComment.mock.calls[0] as [{ body: string }])[0].body;
    expect(body).toContain("job queue service is temporarily unavailable");
  });
});

describe("processRequest: auth + dispatch wiring", () => {
  it("dispatches an allowlisted request through decideDispatch → dispatch", async () => {
    await withConfig({ allowedOwners: undefined }, async () => {
      await processRequest(makeCtx());
      // Reached dispatchDaemon: executions row written + daemon dispatch attempted.
      expect(mockCreateExecution).toHaveBeenCalledTimes(1);
      expect(mockDispatchJob).toHaveBeenCalledTimes(1);
    });
  });

  it("skips a non-allowlisted owner without any side effects", async () => {
    await withConfig({ allowedOwners: ["someone-else"] }, async () => {
      await processRequest(makeCtx({ owner: "chrisleekr" }));
      expect(mockCreateExecution).toHaveBeenCalledTimes(0);
      expect(mockDispatchJob).toHaveBeenCalledTimes(0);
    });
  });
});
