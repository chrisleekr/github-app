/**
 * Request router for the webhook server's HTTP surface.
 *
 * Lives outside `src/app.ts` on purpose. `app.ts` starts the server and runs
 * startup checks at import time, so anything defined there is untestable
 * without booting the process. This module starts nothing and takes its
 * collaborators as arguments, so the whole routing table can be driven with
 * `new Request(...)`. (It still imports `logger`, and therefore `config`, like
 * the rest of the codebase, so the usual test env applies.)
 *
 * ## Why every branch returns a Response
 *
 * The previous node:http handler delegated unmatched paths to the octokit
 * webhook middleware. On a non-matching path that middleware calls
 * `handleResponse(null)`, which returns `false` **without touching the
 * response** (`@octokit/webhooks` `dist-src/middleware/node/handle-response.js`),
 * and `app.ts` discarded that boolean. The request was therefore never
 * answered: the socket stayed open until the peer gave up, and the abandoned
 * fd is a candidate source of the CLOSE_WAIT spin in issue #264. octokit's own
 * README documents the contract that was being missed:
 *
 * ```js
 * // `middleware` returns `false` when `req` is unhandled (beyond `/webhooks`)
 * if (await middleware(req, res)) return;
 * res.writeHead(404);
 * ```
 *
 * Routing explicitly and answering 404 ourselves removes the ambiguity: the
 * middleware is only ever called on an exact path match, so its non-matching
 * branch is unreachable. That matters for the web middleware too, whose
 * equivalent branch answers an empty `200` rather than nothing at all.
 */
import { HTTP_LOG_EVENTS } from "./app-log-fields";
import { logger } from "./logger";

export const WEBHOOK_PATH = "/api/github/webhooks";

export const TEXT_PLAIN = { "Content-Type": "text/plain" } as const;

/** Everything the router touches outside itself. Injected so tests stay hermetic. */
export interface RouterDeps {
  /** Startup checks (including DB migrations) have finished. */
  isReady: () => boolean;
  /** Server mode always needs Valkey (FM-7); daemon mode skips this file entirely. */
  isValkeyHealthy: () => boolean;
  /** `config.nodeEnv`; the test webhook endpoint is 404 in production. */
  nodeEnv: string;
  /** octokit's web middleware, which verifies HMAC and dispatches. */
  webhookMiddleware: (request: Request) => Promise<Response>;
  handleTestWebhook: (request: Request) => Promise<Response>;
  handleSchedulerRun: (request: Request) => Promise<Response>;
}

/**
 * Strip trailing slashes so `/healthz/` routes like `/healthz`.
 *
 * The previous handler compared `req.url` with `===`, so a query string or a
 * trailing slash missed every branch and fell through to the webhook middleware,
 * i.e. into the hang described above. Matching on a parsed, normalised pathname
 * closes both holes. Mirrors `normalizeTrailingSlashes` in `@octokit/webhooks`
 * so our routing and the middleware's agree on what the webhook path is.
 */
export function normalizePath(pathname: string): string {
  let i = pathname.length;
  while (i > 0 && pathname.charCodeAt(i - 1) === 47) i--;
  return i === 0 ? "/" : pathname.slice(0, i);
}

/** Narrow a header value to a non-empty string. */
function headerString(value: string | null): string | undefined {
  return value !== null && value.length > 0 ? value : undefined;
}

/** Readiness probe. The two flags name which gate is false. */
function handleReadyz(deps: RouterDeps): Response {
  const isReady = deps.isReady();
  const valkeyHealthy = deps.isValkeyHealthy();
  const ready = isReady && valkeyHealthy;
  if (!ready) {
    // Info-level (issue #247): a 503 means we are refusing traffic, an operator
    // wants this at the LOG_LEVEL=info baseline to see startup races / Valkey
    // reconnect storms. /healthz stays silent (k8s liveness hammers it).
    logger.info(
      { event: HTTP_LOG_EVENTS.readyzUnready, is_ready: isReady, valkey_healthy: valkeyHealthy },
      "/readyz returning 503",
    );
  }
  return new Response(ready ? "ready" : "not ready", {
    status: ready ? 200 : 503,
    headers: TEXT_PLAIN,
  });
}

/** Delegate to octokit and emit the per-receipt access log. */
async function handleWebhook(request: Request, deps: RouterDeps): Promise<Response> {
  // Webhook entry (issue #247). `http.webhook.received` records the inbound
  // delivery with its GitHub-bounded delivery id + event name (header values,
  // not body) and the wall-clock around the middleware, which verifies HMAC and
  // dispatches. A signature mismatch surfaces separately via `onError` ->
  // `http.webhook.error`; this line is the per-receipt access log.
  const deliveryId = headerString(request.headers.get("x-github-delivery"));
  const eventName = headerString(request.headers.get("x-github-event"));
  const startedAt = Date.now();
  try {
    return await deps.webhookMiddleware(request);
  } finally {
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
  }
}

/**
 * Build the request router. Every path resolves to a Response; there is no
 * implicit fallthrough.
 */
export function createFetchHandler(deps: RouterDeps): (request: Request) => Promise<Response> {
  return async function handleRequest(request: Request): Promise<Response> {
    const pathname = normalizePath(new URL(request.url).pathname);

    // Liveness: is the process alive? (no external deps)
    if (pathname === "/healthz") {
      return new Response("ok", { status: 200, headers: TEXT_PLAIN });
    }

    if (pathname === "/readyz") {
      return handleReadyz(deps);
    }

    // Reject non-health traffic until startup checks (including DB migrations) finish.
    if (!deps.isReady()) {
      return new Response("not ready", { status: 503, headers: TEXT_PLAIN });
    }

    // Dev-only test endpoint: simulate a webhook event without HMAC verification.
    if (pathname === "/api/test/webhook" && request.method === "POST") {
      if (deps.nodeEnv === "production") {
        return new Response("not found", { status: 404, headers: TEXT_PLAIN });
      }
      return await deps.handleTestWebhook(request);
    }

    // Operator endpoint: force one scheduled action to run now (the
    // `workflow_dispatch` analogue). Authenticated with the daemon auth token
    // since it triggers an agent run; 404 when the scheduler is disabled.
    if (pathname === "/api/scheduler/run" && request.method === "POST") {
      return await deps.handleSchedulerRun(request);
    }

    if (pathname === WEBHOOK_PATH) {
      return await handleWebhook(request, deps);
    }

    return new Response("not found", { status: 404, headers: TEXT_PLAIN });
  };
}
