/**
 * Router tests for the webhook server's HTTP surface.
 *
 * The regression these exist for: before the `Bun.serve` migration, any path
 * the handler did not recognise was delegated to the octokit webhook
 * middleware, which returns `false` without writing a response. The request was
 * never answered and the socket stayed open until the peer gave up. Every
 * "returns 404" assertion below is guarding that.
 *
 * Driven two ways: directly with `new Request(...)` for the routing table, and
 * over a real `Bun.serve` on an ephemeral port for the end-to-end proof that a
 * response actually reaches the wire (mirrors `test/orchestrator/ws-server.test.ts`).
 */
import { describe, expect, it } from "bun:test";

import { createFetchHandler, normalizePath, type RouterDeps } from "../src/http-router";

/** Deps with everything healthy and no endpoint delegation exercised. */
function makeDeps(overrides: Partial<RouterDeps> = {}): RouterDeps {
  return {
    isReady: () => true,
    isValkeyHealthy: () => true,
    nodeEnv: "test",
    webhookMiddleware: () => Promise.resolve(new Response("ok\n", { status: 200 })),
    handleTestWebhook: () => Promise.resolve(Response.json({ accepted: true }, { status: 202 })),
    handleSchedulerRun: () => Promise.resolve(Response.json({ enqueued: true }, { status: 202 })),
    ...overrides,
  };
}

function get(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

describe("normalizePath", () => {
  it("strips trailing slashes and preserves root", () => {
    expect(normalizePath("/healthz")).toBe("/healthz");
    expect(normalizePath("/healthz/")).toBe("/healthz");
    expect(normalizePath("/healthz///")).toBe("/healthz");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("///")).toBe("/");
    expect(normalizePath("")).toBe("/");
  });
});

describe("createFetchHandler routing", () => {
  it("answers 404 on an unmatched path instead of hanging", async () => {
    const handler = createFetchHandler(makeDeps());
    const res = await handler(get("/some-bogus-path"));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
  });

  it("answers 404 on an unmatched path even when it looks webhook-adjacent", async () => {
    const handler = createFetchHandler(makeDeps());
    for (const path of ["/api", "/api/github", "/api/github/webhook", "/api/github/webhooksx"]) {
      const res = await handler(get(path));
      expect(res.status).toBe(404);
    }
  });

  it("never delegates an unmatched path to the webhook middleware", async () => {
    let called = false;
    const handler = createFetchHandler(
      makeDeps({
        webhookMiddleware: () => {
          called = true;
          return Promise.resolve(new Response("ok\n"));
        },
      }),
    );
    await handler(get("/some-bogus-path"));
    expect(called).toBe(false);
  });

  it("serves /healthz regardless of query string or trailing slash", async () => {
    const handler = createFetchHandler(makeDeps());
    // The pre-migration handler compared `req.url` exactly, so both of these
    // missed the branch and fell through into the hang.
    for (const path of ["/healthz", "/healthz/", "/healthz?x=1"]) {
      const res = await handler(get(path));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    }
  });

  it("serves /healthz even when the process is not ready", async () => {
    const handler = createFetchHandler(makeDeps({ isReady: () => false }));
    const res = await handler(get("/healthz"));
    expect(res.status).toBe(200);
  });

  it("returns 200 from /readyz when ready and Valkey is healthy", async () => {
    const handler = createFetchHandler(makeDeps());
    const res = await handler(get("/readyz"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ready");
  });

  it("returns 503 from /readyz when either gate is false", async () => {
    for (const deps of [{ isReady: () => false }, { isValkeyHealthy: () => false }]) {
      const handler = createFetchHandler(makeDeps(deps));
      const res = await handler(get("/readyz"));
      expect(res.status).toBe(503);
      expect(await res.text()).toBe("not ready");
    }
  });

  it("returns 503 for non-health traffic until startup finishes", async () => {
    const handler = createFetchHandler(makeDeps({ isReady: () => false }));
    const res = await handler(get("/api/github/webhooks", { method: "POST" }));
    expect(res.status).toBe(503);
  });

  it("404s the dev test-webhook endpoint in production", async () => {
    let called = false;
    const handler = createFetchHandler(
      makeDeps({
        nodeEnv: "production",
        handleTestWebhook: () => {
          called = true;
          return Promise.resolve(Response.json({}, { status: 202 }));
        },
      }),
    );
    const res = await handler(get("/api/test/webhook", { method: "POST" }));
    expect(res.status).toBe(404);
    expect(called).toBe(false);
  });

  it("delegates the dev test-webhook endpoint outside production", async () => {
    const handler = createFetchHandler(makeDeps());
    const res = await handler(get("/api/test/webhook", { method: "POST" }));
    expect(res.status).toBe(202);
  });

  it("404s a non-POST on the POST-only endpoints", async () => {
    const handler = createFetchHandler(makeDeps());
    for (const path of ["/api/test/webhook", "/api/scheduler/run"]) {
      const res = await handler(get(path));
      expect(res.status).toBe(404);
    }
  });

  it("delegates the scheduler endpoint", async () => {
    const handler = createFetchHandler(makeDeps());
    const res = await handler(get("/api/scheduler/run", { method: "POST" }));
    expect(res.status).toBe(202);
  });

  it("delegates the webhook path, including with a trailing slash", async () => {
    const seen: string[] = [];
    const handler = createFetchHandler(
      makeDeps({
        webhookMiddleware: (request) => {
          seen.push(new URL(request.url).pathname);
          return Promise.resolve(new Response("ok\n", { status: 200 }));
        },
      }),
    );
    for (const path of ["/api/github/webhooks", "/api/github/webhooks/"]) {
      const res = await handler(get(path, { method: "POST" }));
      expect(res.status).toBe(200);
    }
    expect(seen).toHaveLength(2);
  });

  it("delegates a non-POST on the webhook path so octokit owns the status", async () => {
    // octokit answers 404 "Unknown route" itself; the router must not pre-empt
    // that, or a method mismatch would report the wrong body.
    const handler = createFetchHandler(
      makeDeps({
        webhookMiddleware: () =>
          Promise.resolve(Response.json({ error: "Unknown route: GET" }, { status: 404 })),
      }),
    );
    const res = await handler(get("/api/github/webhooks"));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Unknown route");
  });

  it("emits the access log only when both delivery headers are present", async () => {
    const handler = createFetchHandler(makeDeps());
    // Both headers present: the `http.webhook.received` branch runs.
    const withHeaders = await handler(
      get("/api/github/webhooks", {
        method: "POST",
        headers: { "x-github-delivery": "abc-123", "x-github-event": "issues" },
      }),
    );
    expect(withHeaders.status).toBe(200);

    // Missing / empty headers must not throw and must not block the response.
    for (const headers of [
      {},
      { "x-github-delivery": "abc-123" },
      { "x-github-delivery": "", "x-github-event": "issues" },
    ]) {
      const res = await handler(get("/api/github/webhooks", { method: "POST", headers }));
      expect(res.status).toBe(200);
    }
  });

  it("still answers when the webhook middleware throws", async () => {
    const handler = createFetchHandler(
      makeDeps({
        webhookMiddleware: () => Promise.reject(new Error("middleware exploded")),
      }),
    );
    // The finally-block access log must not swallow or mask the rejection: it
    // propagates to Bun.serve's `error` hook, which answers 500.
    let caught: unknown;
    try {
      await handler(
        get("/api/github/webhooks", {
          method: "POST",
          headers: { "x-github-delivery": "abc-123", "x-github-event": "issues" },
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("middleware exploded");
  });

  it("propagates the webhook middleware's response verbatim", async () => {
    const handler = createFetchHandler(
      makeDeps({
        webhookMiddleware: () =>
          Promise.resolve(new Response("still processing\n", { status: 202 })),
      }),
    );
    const res = await handler(get("/api/github/webhooks", { method: "POST" }));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("still processing\n");
  });
});

describe("createFetchHandler over a real server", () => {
  it("answers an unmatched path on the wire rather than leaving it open", async () => {
    const server = Bun.serve({
      port: 0,
      idleTimeout: 10,
      fetch: createFetchHandler(makeDeps()),
    });
    try {
      // The pre-migration server returned nothing here and the request timed
      // out with 0 bytes; an AbortSignal makes that failure mode explicit.
      const res = await fetch(`http://localhost:${String(server.port)}/some-bogus-path`, {
        signal: AbortSignal.timeout(5000),
      });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("not found");
    } finally {
      await server.stop(true);
    }
  });

  it("serves the health endpoints on the wire", async () => {
    const server = Bun.serve({
      port: 0,
      idleTimeout: 10,
      fetch: createFetchHandler(makeDeps()),
    });
    try {
      const base = `http://localhost:${String(server.port)}`;
      const health = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(5000) });
      expect(health.status).toBe(200);
      const ready = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(5000) });
      expect(ready.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });
});
