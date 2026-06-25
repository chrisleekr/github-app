import { describe, expect, it } from "bun:test";

import {
  DAEMON_CONNECTION_LOG_EVENTS,
  DAEMON_JOB_LOG_EVENTS,
  DaemonConnectionLogSchema,
  DaemonJobCancelledLogSchema,
} from "../../src/daemon/log-fields";

describe("DAEMON_CONNECTION_LOG_EVENTS", () => {
  it("pins the five canonical event strings", () => {
    expect(DAEMON_CONNECTION_LOG_EVENTS.connectAttempt).toBe("daemon.connection.connect_attempt");
    expect(DAEMON_CONNECTION_LOG_EVENTS.connected).toBe("daemon.connection.connected");
    expect(DAEMON_CONNECTION_LOG_EVENTS.disconnected).toBe("daemon.connection.disconnected");
    expect(DAEMON_CONNECTION_LOG_EVENTS.reconnectScheduled).toBe(
      "daemon.connection.reconnect_scheduled",
    );
    expect(DAEMON_CONNECTION_LOG_EVENTS.error).toBe("daemon.connection.error");
  });
});

describe("DaemonConnectionLogSchema: accepts well-formed events", () => {
  it("accepts connect_attempt", () => {
    const result = DaemonConnectionLogSchema.safeParse({
      event: DAEMON_CONNECTION_LOG_EVENTS.connectAttempt,
      attempt: 1,
      downtime_ms: 0,
      previous_backoff_ms: 1000,
    });
    expect(result.success).toBe(true);
  });

  it("accepts connected", () => {
    const result = DaemonConnectionLogSchema.safeParse({
      event: DAEMON_CONNECTION_LOG_EVENTS.connected,
      attempt: 3,
      time_to_connect_ms: 42,
      downtime_ms: 5300,
    });
    expect(result.success).toBe(true);
  });

  it("accepts disconnected", () => {
    const result = DaemonConnectionLogSchema.safeParse({
      event: DAEMON_CONNECTION_LOG_EVENTS.disconnected,
      code: 1006,
      reason: "abnormal closure",
      connected_duration_ms: 360000,
    });
    expect(result.success).toBe(true);
  });

  it("accepts disconnected with an empty reason", () => {
    const result = DaemonConnectionLogSchema.safeParse({
      event: DAEMON_CONNECTION_LOG_EVENTS.disconnected,
      code: 1000,
      reason: "",
      connected_duration_ms: 0,
    });
    expect(result.success).toBe(true);
  });

  it("accepts reconnect_scheduled", () => {
    const result = DaemonConnectionLogSchema.safeParse({
      event: DAEMON_CONNECTION_LOG_EVENTS.reconnectScheduled,
      attempt: 2,
      backoff_ms: 2700,
    });
    expect(result.success).toBe(true);
  });

  it("accepts error with a message", () => {
    const result = DaemonConnectionLogSchema.safeParse({
      event: DAEMON_CONNECTION_LOG_EVENTS.error,
      readyState: 3,
      message: "Expected 101 status code",
    });
    expect(result.success).toBe(true);
  });

  it("accepts error with a null readyState and no message", () => {
    const result = DaemonConnectionLogSchema.safeParse({
      event: DAEMON_CONNECTION_LOG_EVENTS.error,
      readyState: null,
    });
    expect(result.success).toBe(true);
  });
});

describe("DaemonConnectionLogSchema: rejects drift and bad input", () => {
  it("rejects an unknown extra field (strict)", () => {
    const result = DaemonConnectionLogSchema.safeParse({
      event: DAEMON_CONNECTION_LOG_EVENTS.connected,
      attempt: 1,
      time_to_connect_ms: 10,
      downtime_ms: 0,
      surprise: "boo",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown event literal", () => {
    const result = DaemonConnectionLogSchema.safeParse({
      event: "daemon.connection.bogus",
      attempt: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-positive attempt on connect_attempt", () => {
    const result = DaemonConnectionLogSchema.safeParse({
      event: DAEMON_CONNECTION_LOG_EVENTS.connectAttempt,
      attempt: 0,
      downtime_ms: 0,
      previous_backoff_ms: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative downtime_ms", () => {
    const result = DaemonConnectionLogSchema.safeParse({
      event: DAEMON_CONNECTION_LOG_EVENTS.connectAttempt,
      attempt: 1,
      downtime_ms: -1,
      previous_backoff_ms: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects connected missing time_to_connect_ms", () => {
    const result = DaemonConnectionLogSchema.safeParse({
      event: DAEMON_CONNECTION_LOG_EVENTS.connected,
      attempt: 1,
      downtime_ms: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a fields-on-wrong-event leak (backoff_ms on connected)", () => {
    const result = DaemonConnectionLogSchema.safeParse({
      event: DAEMON_CONNECTION_LOG_EVENTS.connected,
      attempt: 1,
      time_to_connect_ms: 10,
      downtime_ms: 0,
      backoff_ms: 1000,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty message on error (min length)", () => {
    const result = DaemonConnectionLogSchema.safeParse({
      event: DAEMON_CONNECTION_LOG_EVENTS.error,
      readyState: 3,
      message: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("DaemonJobCancelledLogSchema", () => {
  it("pins the canonical event string", () => {
    expect(DAEMON_JOB_LOG_EVENTS.cancelled).toBe("daemon.job.cancelled");
  });

  it("accepts a well-formed cancel record", () => {
    const result = DaemonJobCancelledLogSchema.safeParse({
      event: DAEMON_JOB_LOG_EVENTS.cancelled,
      offerId: "offer-1",
      deliveryId: "del-1",
      reason: "superseded",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown extra field (strict)", () => {
    const result = DaemonJobCancelledLogSchema.safeParse({
      event: DAEMON_JOB_LOG_EVENTS.cancelled,
      offerId: "offer-1",
      deliveryId: "del-1",
      reason: "superseded",
      surprise: "boo",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty offerId", () => {
    const result = DaemonJobCancelledLogSchema.safeParse({
      event: DAEMON_JOB_LOG_EVENTS.cancelled,
      offerId: "",
      deliveryId: "del-1",
      reason: "superseded",
    });
    expect(result.success).toBe(false);
  });
});
