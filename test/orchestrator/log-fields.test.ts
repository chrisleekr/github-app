import { describe, expect, it } from "bun:test";

import {
  DAEMON_HEARTBEAT_LOG_EVENTS,
  DaemonHeartbeatLogSchema,
  DISPATCHER_LOG_EVENTS,
  DispatcherNoEligibleDaemonLogSchema,
  DispatcherOfferLogSchema,
} from "../../src/orchestrator/log-fields";

describe("DispatcherOfferLogSchema (#187)", () => {
  it("accepts a well-formed offer.sent line (kind + fleetSize + requiredTools + queue_wait_ms)", () => {
    const result = DispatcherOfferLogSchema.safeParse({
      event: DISPATCHER_LOG_EVENTS.offer_sent,
      kind: "legacy",
      deliveryId: "delivery-1",
      daemonId: "daemon-1",
      offerId: "offer-1",
      fleetSize: 3,
      requiredTools: ["mcp__github"],
      queue_wait_ms: 1200,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an offer.accepted line carrying offer_latency_ms", () => {
    const result = DispatcherOfferLogSchema.safeParse({
      event: DISPATCHER_LOG_EVENTS.offer_accepted,
      deliveryId: "delivery-1",
      daemonId: "daemon-1",
      offerId: "offer-1",
      offer_latency_ms: 42,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an offer.rejected line carrying reason + latency", () => {
    const result = DispatcherOfferLogSchema.safeParse({
      event: DISPATCHER_LOG_EVENTS.offer_rejected,
      deliveryId: "delivery-1",
      daemonId: "daemon-1",
      offerId: "offer-1",
      offer_latency_ms: 7,
      reason: "at capacity",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an offer.timed_out line carrying latency", () => {
    const result = DispatcherOfferLogSchema.safeParse({
      event: DISPATCHER_LOG_EVENTS.offer_timed_out,
      deliveryId: "delivery-1",
      daemonId: "daemon-1",
      offerId: "offer-1",
      offer_latency_ms: 5000,
    });
    expect(result.success).toBe(true);
  });

  it("rejects offer.sent missing queue_wait_ms", () => {
    const result = DispatcherOfferLogSchema.safeParse({
      event: DISPATCHER_LOG_EVENTS.offer_sent,
      kind: "legacy",
      deliveryId: "delivery-1",
      daemonId: "daemon-1",
      offerId: "offer-1",
      fleetSize: 3,
      requiredTools: ["mcp__github"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative or non-integer queue_wait_ms on offer.sent", () => {
    const base = {
      event: DISPATCHER_LOG_EVENTS.offer_sent,
      kind: "legacy",
      deliveryId: "delivery-1",
      daemonId: "daemon-1",
      offerId: "offer-1",
      fleetSize: 3,
      requiredTools: ["mcp__github"],
    };
    expect(DispatcherOfferLogSchema.safeParse({ ...base, queue_wait_ms: -1 }).success).toBe(false);
    expect(DispatcherOfferLogSchema.safeParse({ ...base, queue_wait_ms: 1.5 }).success).toBe(false);
  });

  it("rejects offer.sent missing requiredTools", () => {
    const result = DispatcherOfferLogSchema.safeParse({
      event: DISPATCHER_LOG_EVENTS.offer_sent,
      kind: "legacy",
      deliveryId: "delivery-1",
      daemonId: "daemon-1",
      offerId: "offer-1",
      fleetSize: 3,
    });
    expect(result.success).toBe(false);
  });

  it("rejects offer.accepted carrying kind (accept emitter omits it)", () => {
    const result = DispatcherOfferLogSchema.safeParse({
      event: DISPATCHER_LOG_EVENTS.offer_accepted,
      kind: "non-scoped",
      deliveryId: "delivery-1",
      daemonId: "daemon-1",
      offerId: "offer-1",
      offer_latency_ms: 42,
    });
    expect(result.success).toBe(false);
  });

  it("rejects reason on a non-rejected event (per-event strictness)", () => {
    const result = DispatcherOfferLogSchema.safeParse({
      event: DISPATCHER_LOG_EVENTS.offer_accepted,
      deliveryId: "delivery-1",
      daemonId: "daemon-1",
      offerId: "offer-1",
      offer_latency_ms: 42,
      reason: "should not be here",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer / negative offer_latency_ms", () => {
    const base = {
      event: DISPATCHER_LOG_EVENTS.offer_accepted,
      deliveryId: "delivery-1",
      daemonId: "daemon-1",
      offerId: "offer-1",
    };
    expect(DispatcherOfferLogSchema.safeParse({ ...base, offer_latency_ms: 1.5 }).success).toBe(
      false,
    );
    expect(DispatcherOfferLogSchema.safeParse({ ...base, offer_latency_ms: -1 }).success).toBe(
      false,
    );
  });

  it("rejects the no_eligible_daemon event (it has its own schema)", () => {
    const result = DispatcherOfferLogSchema.safeParse({
      event: DISPATCHER_LOG_EVENTS.no_eligible_daemon,
      deliveryId: "delivery-1",
      daemonId: "daemon-1",
      offerId: "offer-1",
    });
    expect(result.success).toBe(false);
  });
});

describe("DispatcherNoEligibleDaemonLogSchema (#187)", () => {
  it("accepts a well-formed no_eligible_daemon line", () => {
    const result = DispatcherNoEligibleDaemonLogSchema.safeParse({
      event: DISPATCHER_LOG_EVENTS.no_eligible_daemon,
      kind: "legacy",
      deliveryId: "delivery-1",
      fleetSize: 0,
      requiredTools: ["mcp__github"],
      queue_wait_ms: 4500,
    });
    expect(result.success).toBe(true);
  });

  it("rejects no_eligible_daemon missing queue_wait_ms", () => {
    const result = DispatcherNoEligibleDaemonLogSchema.safeParse({
      event: DISPATCHER_LOG_EVENTS.no_eligible_daemon,
      kind: "legacy",
      deliveryId: "delivery-1",
      fleetSize: 0,
      requiredTools: ["mcp__github"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing required field (fleetSize)", () => {
    const result = DispatcherNoEligibleDaemonLogSchema.safeParse({
      event: DISPATCHER_LOG_EVENTS.no_eligible_daemon,
      kind: "legacy",
      deliveryId: "delivery-1",
      requiredTools: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects the wrong event literal", () => {
    const result = DispatcherNoEligibleDaemonLogSchema.safeParse({
      event: DISPATCHER_LOG_EVENTS.offer_sent,
      kind: "legacy",
      deliveryId: "delivery-1",
      fleetSize: 1,
      requiredTools: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("DaemonHeartbeatLogSchema (#187)", () => {
  it("accepts a pong_missed line with missedPongs", () => {
    const result = DaemonHeartbeatLogSchema.safeParse({
      event: DAEMON_HEARTBEAT_LOG_EVENTS.pong_missed,
      daemonId: "daemon-1",
      missedPongs: 2,
    });
    expect(result.success).toBe(true);
  });

  it("rejects pong_missed without missedPongs (required on this event)", () => {
    const result = DaemonHeartbeatLogSchema.safeParse({
      event: DAEMON_HEARTBEAT_LOG_EVENTS.pong_missed,
      daemonId: "daemon-1",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a timeout line without missedPongs", () => {
    const result = DaemonHeartbeatLogSchema.safeParse({
      event: DAEMON_HEARTBEAT_LOG_EVENTS.timeout,
      daemonId: "daemon-1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missedPongs on the timeout event (pinned to pong_missed only)", () => {
    const result = DaemonHeartbeatLogSchema.safeParse({
      event: DAEMON_HEARTBEAT_LOG_EVENTS.timeout,
      daemonId: "daemon-1",
      missedPongs: 1,
    });
    expect(result.success).toBe(false);
  });

  it("accepts ttl_refresh_failed carrying err (it is emitted inline with the error)", () => {
    const result = DaemonHeartbeatLogSchema.safeParse({
      event: DAEMON_HEARTBEAT_LOG_EVENTS.ttl_refresh_failed,
      daemonId: "daemon-1",
      err: new Error("valkey unreachable"),
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown field (strict shape pins drift)", () => {
    const result = DaemonHeartbeatLogSchema.safeParse({
      event: DAEMON_HEARTBEAT_LOG_EVENTS.pong_missed,
      daemonId: "daemon-1",
      missedPongs: 2,
      missed_pongs: 2, // snake_case dup, must be rejected
    });
    expect(result.success).toBe(false);
  });
});

describe("event key constants (#187)", () => {
  it("exposes the five canonical dispatcher event keys", () => {
    expect(DISPATCHER_LOG_EVENTS).toEqual({
      offer_sent: "dispatcher.offer.sent",
      offer_accepted: "dispatcher.offer.accepted",
      offer_rejected: "dispatcher.offer.rejected",
      offer_timed_out: "dispatcher.offer.timed_out",
      no_eligible_daemon: "dispatcher.no_eligible_daemon",
    });
  });

  it("exposes the three canonical heartbeat event keys", () => {
    expect(DAEMON_HEARTBEAT_LOG_EVENTS).toEqual({
      pong_missed: "daemon.heartbeat.pong_missed",
      timeout: "daemon.heartbeat.timeout",
      ttl_refresh_failed: "daemon.heartbeat.ttl_refresh_failed",
    });
  });
});
