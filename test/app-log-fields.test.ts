import { describe, expect, it } from "bun:test";

import {
  HTTP_LOG_EVENTS,
  HTTP_WEBHOOK_ERROR_KINDS,
  HttpLogFieldsSchema,
} from "../src/app-log-fields";

describe("HTTP_LOG_EVENTS", () => {
  it("pins the canonical http.* event strings", () => {
    expect(HTTP_LOG_EVENTS.webhookReceived).toBe("http.webhook.received");
    expect(HTTP_LOG_EVENTS.webhookError).toBe("http.webhook.error");
    expect(HTTP_LOG_EVENTS.readyzUnready).toBe("http.readyz.unready");
    expect(HTTP_LOG_EVENTS.schedulerRunRejectedDisabled).toBe(
      "http.scheduler.run.rejected_disabled",
    );
    expect(HTTP_LOG_EVENTS.schedulerRunRejectedUnauth).toBe("http.scheduler.run.rejected_unauth");
    expect(HTTP_LOG_EVENTS.schedulerRunRejectedPayload).toBe("http.scheduler.run.rejected_payload");
    expect(HTTP_LOG_EVENTS.schedulerRunEnqueued).toBe("http.scheduler.run.enqueued");
    expect(HTTP_LOG_EVENTS.schedulerRunFailed).toBe("http.scheduler.run.failed");
    expect(HTTP_LOG_EVENTS.requestFailed).toBe("http.request.failed");
  });

  it("pins the webhook-error kinds", () => {
    expect(HTTP_WEBHOOK_ERROR_KINDS).toEqual(["signature_mismatch", "handler_threw", "other"]);
  });
});

describe("HttpLogFieldsSchema: accepts well-formed events", () => {
  it("accepts http.webhook.received", () => {
    const r = HttpLogFieldsSchema.safeParse({
      event: HTTP_LOG_EVENTS.webhookReceived,
      deliveryId: "d1",
      event_name: "issue_comment",
      duration_ms: 12,
    });
    expect(r.success).toBe(true);
  });

  it("accepts http.webhook.error with full bounded metadata", () => {
    const r = HttpLogFieldsSchema.safeParse({
      event: HTTP_LOG_EVENTS.webhookError,
      kind: "signature_mismatch",
      deliveryId: "d1",
      event_name: "push",
      err: new Error("boom"),
    });
    expect(r.success).toBe(true);
  });

  it("accepts http.webhook.error with no deliveryId/event_name (early failure)", () => {
    const r = HttpLogFieldsSchema.safeParse({
      event: HTTP_LOG_EVENTS.webhookError,
      kind: "other",
      err: "boom",
    });
    expect(r.success).toBe(true);
  });

  it("accepts http.readyz.unready", () => {
    const r = HttpLogFieldsSchema.safeParse({
      event: HTTP_LOG_EVENTS.readyzUnready,
      is_ready: false,
      valkey_healthy: true,
    });
    expect(r.success).toBe(true);
  });

  it("accepts the four scheduler reject/accept events", () => {
    expect(
      HttpLogFieldsSchema.safeParse({
        event: HTTP_LOG_EVENTS.schedulerRunRejectedDisabled,
        status: 404,
      }).success,
    ).toBe(true);
    expect(
      HttpLogFieldsSchema.safeParse({
        event: HTTP_LOG_EVENTS.schedulerRunRejectedUnauth,
        status: 401,
      }).success,
    ).toBe(true);
    expect(
      HttpLogFieldsSchema.safeParse({
        event: HTTP_LOG_EVENTS.schedulerRunRejectedPayload,
        status: 413,
        reason: "body_too_large",
      }).success,
    ).toBe(true);
    expect(
      HttpLogFieldsSchema.safeParse({
        event: HTTP_LOG_EVENTS.schedulerRunEnqueued,
        status: 202,
        enqueued: true,
      }).success,
    ).toBe(true);
  });

  it("accepts http.scheduler.run.failed with err", () => {
    const r = HttpLogFieldsSchema.safeParse({
      event: HTTP_LOG_EVENTS.schedulerRunFailed,
      status: 500,
      err: new Error("kaboom"),
    });
    expect(r.success).toBe(true);
  });

  it("accepts http.request.failed with err only", () => {
    const r = HttpLogFieldsSchema.safeParse({
      event: HTTP_LOG_EVENTS.requestFailed,
      err: new Error("router exploded"),
    });
    expect(r.success).toBe(true);
  });

  it("rejects http.request.failed carrying request data", () => {
    // The Bun.serve error hook is a last-resort boundary that may be reached
    // via attacker-shaped input, so the branch is strict: err and nothing else.
    const r = HttpLogFieldsSchema.safeParse({
      event: HTTP_LOG_EVENTS.requestFailed,
      err: new Error("router exploded"),
      path: "/some-bogus-path",
    });
    expect(r.success).toBe(false);
  });
});

describe("HttpLogFieldsSchema: rejects drift and bad input", () => {
  it("rejects an unknown extra field (strict)", () => {
    const r = HttpLogFieldsSchema.safeParse({
      event: HTTP_LOG_EVENTS.readyzUnready,
      is_ready: false,
      valkey_healthy: true,
      surprise: "boo",
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown event literal", () => {
    const r = HttpLogFieldsSchema.safeParse({ event: "http.bogus", status: 404 });
    expect(r.success).toBe(false);
  });

  it("rejects an invalid webhook-error kind", () => {
    const r = HttpLogFieldsSchema.safeParse({
      event: HTTP_LOG_EVENTS.webhookError,
      kind: "weird",
      err: "x",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a wrong status code on a scheduler event", () => {
    const r = HttpLogFieldsSchema.safeParse({
      event: HTTP_LOG_EVENTS.schedulerRunRejectedDisabled,
      status: 500,
    });
    expect(r.success).toBe(false);
  });

  it("rejects an invalid payload-reject reason", () => {
    const r = HttpLogFieldsSchema.safeParse({
      event: HTTP_LOG_EVENTS.schedulerRunRejectedPayload,
      status: 400,
      reason: "nope",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a non-integer duration_ms", () => {
    const r = HttpLogFieldsSchema.safeParse({
      event: HTTP_LOG_EVENTS.webhookReceived,
      deliveryId: "d1",
      event_name: "push",
      duration_ms: 1.5,
    });
    expect(r.success).toBe(false);
  });

  it("rejects an empty deliveryId on webhook.received", () => {
    const r = HttpLogFieldsSchema.safeParse({
      event: HTTP_LOG_EVENTS.webhookReceived,
      deliveryId: "",
      event_name: "push",
      duration_ms: 1,
    });
    expect(r.success).toBe(false);
  });
});
