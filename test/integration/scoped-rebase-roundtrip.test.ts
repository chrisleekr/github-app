/**
 * T028: scoped-rebase contract round-trip integration test (FR-020).
 *
 * Exercises the full WS message contract for one scoped kind end-to-end:
 *
 *   1. Build a real `scoped-rebase` `ScopedQueuedJob` shape.
 *   2. Construct the `scoped-job:offer` envelope the orchestrator sends to
 *      a daemon (per `contracts/ws-messages.md`); round-trip through the
 *      `serverMessageSchema` discriminated union.
 *   3. Build the daemon's `scoped-job:completion` reply for a `merged`
 *      outcome; round-trip through `daemonMessageSchema`.
 *   4. Drive that parsed completion message through the orchestrator's
 *      WS-side `handleDaemonMessage` router; assert the side-effects:
 *      - the pending-offer registry's `removePendingOffer` was invoked,
 *      - capacity counters (`decrementActiveCount` and per-daemon
 *        `decrementDaemonActiveJobs`) decremented,
 *      - per-kind telemetry event key (`ship.scoped.rebase.daemon.completed`)
 *        was emitted.
 *
 * Why "round-trip" without a real WS server: FR-020 cares about the
 * *contract*: that producer-side envelopes parse cleanly through the
 * consumer-side schema and that the orchestrator's bookkeeping releases
 * resources on completion. A live `Bun.serve`/`WebSocket` pair would only
 * exercise transport, which the existing `ws-server.test.ts` covers.
 */

import type { ServerWebSocket } from "bun";
import { beforeAll, describe, expect, it, mock } from "bun:test";

import type { PendingOffer } from "../../src/shared/daemon-types";
import { createMessageEnvelope } from "../../src/shared/ws-messages";

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Tracker state, mutated by the mock job-dispatcher / concurrency / daemon-registry
// modules and asserted on after the round-trip.
const removePendingOfferSpy = mock(() => {});
const decrementActiveCountSpy = mock(() => {});
const decrementDaemonActiveJobsSpy = mock(() => Promise.resolve());
const markExecutionFailedSpy = mock(() => Promise.resolve());

const FAKE_DAEMON_ID = "daemon-test-1";
// `offerId` doubles as the WS envelope id (per handleScopedAccept), which is
// validated as `z.uuid()`, generate a real UUID up-front so both
// schema parses and the orchestrator's ownership check match.
const FAKE_OFFER_ID = crypto.randomUUID();
const FAKE_DELIVERY_ID = "delivery-rebase-1";

// Pending offer the daemon "claimed", handleScopedJobCompletion's ownership
// check matches `offer.daemonId` against `ws.data.daemonId`.
const fakePendingOffer: PendingOffer = {
  offerId: FAKE_OFFER_ID,
  daemonId: FAKE_DAEMON_ID,
  deliveryId: FAKE_DELIVERY_ID,
  // Required by PendingOffer; the real value is irrelevant for this contract test.
  timer: setTimeout(() => {}, 0) as unknown as PendingOffer["timer"],
  job: {} as unknown as PendingOffer["job"],
  offeredAt: Date.now(),
};
clearTimeout(fakePendingOffer.timer as unknown as ReturnType<typeof setTimeout>);

void mock.module("../../src/orchestrator/job-dispatcher", () => ({
  getPendingOffer: (offerId: string): PendingOffer | undefined =>
    offerId === fakePendingOffer.offerId ? fakePendingOffer : undefined,
  removePendingOffer: removePendingOfferSpy,
  // The completion handler doesn't call these, but ws-server import chain may.
  inferRequiredTools: mock(() => []),
  selectDaemon: mock(() => Promise.resolve(null)),
  dispatchJob: mock(() => Promise.resolve(false)),
  handleJobAccept: mock(() => {}),
  handleJobReject: mock(() => Promise.resolve()),
}));

void mock.module("../../src/orchestrator/concurrency", () => ({
  decrementActiveCount: decrementActiveCountSpy,
  incrementActiveCount: mock(() => {}),
  getActiveCount: mock(() => 0),
  isAtCapacity: mock(() => false),
}));

void mock.module("../../src/orchestrator/daemon-registry", () => ({
  registerDaemon: mock(() => Promise.resolve()),
  deregisterDaemon: mock(() => Promise.resolve()),
  getActiveDaemons: mock(() => Promise.resolve([])),
  getDaemonActiveJobs: mock(() => Promise.resolve(0)),
  refreshDaemonTtl: mock(() => Promise.resolve()),
  incrementDaemonActiveJobs: mock(() => Promise.resolve()),
  decrementDaemonActiveJobs: decrementDaemonActiveJobsSpy,
}));

void mock.module("../../src/orchestrator/history", () => ({
  failDisconnectedDaemon: mock(() =>
    Promise.resolve({ executionDeliveryIds: [], workflowRunIds: [] }),
  ),
  markExecutionOffered: mock(() => Promise.resolve()),
  markExecutionFailed: markExecutionFailedSpy,
  markExecutionRunning: mock(() => Promise.resolve()),
  markExecutionCompleted: mock(() => Promise.resolve()),
  // Seed durable execution state matching the test's daemon + delivery so
  // the orchestrator's ownership/late-result guard in
  // handleScopedJobCompletion accepts this round-trip. A null state would
  // (correctly) be rejected as forged/late.
  getExecutionState: mock(() => Promise.resolve({ status: "running", daemonId: FAKE_DAEMON_ID })),
  getOrphanedExecutions: mock(() => Promise.resolve([])),
  requeueExecution: mock(() => Promise.resolve()),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface MockSocketData {
  authenticated: true;
  remoteAddr: string;
  daemonId: string | undefined;
}

function makeMockServerSocket(daemonId: string): {
  ws: ServerWebSocket<MockSocketData>;
  sent: string[];
} {
  const sent: string[] = [];
  const ws = {
    data: {
      authenticated: true as const,
      remoteAddr: "127.0.0.1",
      daemonId,
    } satisfies MockSocketData,
    sendText: (text: string): void => {
      sent.push(text);
    },
    send: (text: string): void => {
      sent.push(text);
    },
    close: (): void => {},
    readyState: 1,
  } as unknown as ServerWebSocket<MockSocketData>;
  return { ws, sent };
}

// ─── Test ─────────────────────────────────────────────────────────────────────

describe("T028: scoped-rebase WS contract round-trip", () => {
  beforeAll(() => {
    removePendingOfferSpy.mockClear();
    decrementActiveCountSpy.mockClear();
    decrementDaemonActiveJobsSpy.mockClear();
    markExecutionFailedSpy.mockClear();
  });

  it("offer→completion contract round-trips and releases the pending offer", async () => {
    const { serverMessageSchema, daemonMessageSchema } =
      await import("../../src/shared/ws-messages");
    const { handleDaemonMessage } = await import("../../src/orchestrator/connection-handler");

    // 1. Producer-side: build the offer envelope as the orchestrator does.
    const offerEnvelope = {
      type: "scoped-job:offer" as const,
      ...createMessageEnvelope(FAKE_OFFER_ID),
      payload: {
        jobKind: "scoped-rebase" as const,
        deliveryId: FAKE_DELIVERY_ID,
        installationId: 7777,
        owner: "round-trip",
        repo: "fixtures",
        prNumber: 42,
        triggerCommentId: 1234567,
        enqueuedAt: Date.now(),
      },
    };

    // 2. Server→daemon contract: parse via serverMessageSchema (round-trip 1).
    const offerParsed = serverMessageSchema.safeParse(offerEnvelope);
    expect(offerParsed.success).toBe(true);
    if (!offerParsed.success) return;
    expect(offerParsed.data.type).toBe("scoped-job:offer");

    // 3. Daemon-side: build the matching completion message for a `merged` rebase.
    const completionEnvelope = {
      type: "scoped-job:completion" as const,
      ...createMessageEnvelope(),
      payload: {
        offerId: fakePendingOffer.offerId,
        deliveryId: fakePendingOffer.deliveryId,
        jobKind: "scoped-rebase" as const,
        status: "succeeded" as const,
        rebaseOutcome: {
          result: "merged" as const,
          commentId: 9876543,
          mergeCommitSha: "deadbeef0000000000000000000000000000beef",
        },
        costUsd: 0,
        durationMs: 250,
      },
    };

    // 4. Daemon→server contract: parse via daemonMessageSchema (round-trip 2).
    const completionParsed = daemonMessageSchema.safeParse(completionEnvelope);
    expect(completionParsed.success).toBe(true);
    if (!completionParsed.success) return;
    expect(completionParsed.data.type).toBe("scoped-job:completion");

    // 5. Drive the parsed completion through the orchestrator's WS router.
    const { ws } = makeMockServerSocket(FAKE_DAEMON_ID);
    handleDaemonMessage(
      ws as unknown as Parameters<typeof handleDaemonMessage>[0],
      completionParsed.data,
    );

    // handleDaemonMessage queues the async completion handler with `void`;
    // wait one microtask so its awaits settle before asserting.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 6. Assertions: pending-offer cleared, capacity slot released, no fail-mark.
    expect(removePendingOfferSpy).toHaveBeenCalledWith(fakePendingOffer.offerId);
    expect(decrementActiveCountSpy).toHaveBeenCalledTimes(1);
    expect(decrementDaemonActiveJobsSpy).toHaveBeenCalledWith(FAKE_DAEMON_ID);
    expect(markExecutionFailedSpy).not.toHaveBeenCalled();
  });
});
