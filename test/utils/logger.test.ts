import { describe, expect, it } from "bun:test";
import pino from "pino";

import { createChildLogger, errSerializer, REDACT_PATHS } from "../../src/logger";

/**
 * Build a logger with the same redact paths and err serializer as the
 * production root logger, but writing to an in-memory buffer so tests can
 * assert on the emitted JSON. This intentionally re-uses the exported
 * constants so a regression in the production config trips a test.
 */
function buildCapturingLogger(): { logger: pino.Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const dest = {
    write: (chunk: string): void => {
      lines.push(JSON.parse(chunk) as Record<string, unknown>);
    },
  };
  const logger = pino(
    {
      level: "info",
      redact: { paths: [...REDACT_PATHS] },
      serializers: { err: errSerializer },
    },
    dest as pino.DestinationStream,
  );
  return { logger, lines };
}

describe("logger redaction", () => {
  it("redacts request.headers.authorization carrying an App JWT", () => {
    const { logger, lines } = buildCapturingLogger();
    const err = Object.assign(new Error("Bad credentials"), {
      name: "RequestError",
      request: {
        method: "POST",
        url: "https://api.github.com/app/installations/123/access_tokens",
        headers: {
          authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.SECRET_APP_JWT.signature",
          accept: "application/vnd.github+json",
        },
      },
    });
    logger.error({ err }, "Failed to mint installation token for job");

    const raw = JSON.stringify(lines);
    expect(raw).not.toContain("SECRET_APP_JWT");
    expect(raw).not.toContain("eyJhbGciOiJSUzI1NiJ9");
    const line = lines[0];
    expect(line).toBeDefined();
    const errOut = (line as { err: { request: { headers: Record<string, unknown> } } }).err;
    expect(errOut.request.headers["authorization"]).toBe("[Redacted]");
    expect(errOut.request.headers["accept"]).toBe("application/vnd.github+json");
  });

  it("scrubs ghs_ installation tokens that leak into err.message and err.stack", () => {
    const { logger, lines } = buildCapturingLogger();
    const fakeToken = `ghs_${"A".repeat(36)}`;
    const err = Object.assign(new Error(`auth failed token: ${fakeToken} bad`), {
      name: "RequestError",
    });
    logger.error({ err }, "Job execution failed");

    const raw = JSON.stringify(lines);
    expect(raw).not.toContain(fakeToken);
    expect(raw).toContain("[REDACTED_GITHUB_TOKEN]");
    const line = lines[0];
    const errOut = (line as { err: { message: string; stack: string } }).err;
    expect(errOut.message).not.toContain(fakeToken);
    expect(errOut.message).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(errOut.stack).not.toContain(fakeToken);
  });

  it("redacts a top-level privateKey field", () => {
    const { logger, lines } = buildCapturingLogger();
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
    logger.info({ privateKey: pem }, "Loaded config");

    const raw = JSON.stringify(lines);
    expect(raw).not.toContain("MIIEowIBAAKCAQEA");
    const line = lines[0]!;
    expect(line["privateKey"]).toBe("[Redacted]");
  });

  it("redacts the x-hub-signature-256 webhook signature header", () => {
    const { logger, lines } = buildCapturingLogger();
    const err = Object.assign(new Error("Invalid signature"), {
      name: "WebhookError",
      request: {
        headers: {
          "x-hub-signature-256": "sha256=DEADBEEFCAFEBABE",
          "x-github-event": "pull_request",
        },
      },
    });
    logger.error({ err }, "Webhook processing error");

    const raw = JSON.stringify(lines);
    expect(raw).not.toContain("DEADBEEFCAFEBABE");
    const line = lines[0] as { err: { request: { headers: Record<string, string> } } };
    expect(line.err.request.headers["x-hub-signature-256"]).toBe("[Redacted]");
    expect(line.err.request.headers["x-github-event"]).toBe("pull_request");
  });

  it("scrubs Valkey URL credentials embedded in err.message", () => {
    const { logger, lines } = buildCapturingLogger();
    const err = Object.assign(
      new Error("ECONNREFUSED redis://admin:supersecret@cache.internal:6379"),
      { name: "ConnectionError" },
    );
    logger.error({ err }, "Valkey connect failed during startup");

    const raw = JSON.stringify(lines);
    expect(raw).not.toContain("supersecret");
    expect(raw).not.toContain("admin:");
    const line = lines[0] as { err: { message: string } };
    expect(line.err.message).toContain("redis://***:***@cache.internal:6379");
  });

  it("does not mutate the original Error instance", () => {
    const { logger } = buildCapturingLogger();
    const originalAuth = "Bearer ORIGINAL_VALUE";
    const err = Object.assign(new Error("boom"), {
      name: "RequestError",
      request: { headers: { authorization: originalAuth } },
    });
    logger.error({ err }, "test");
    expect(err.request.headers.authorization).toBe(originalAuth);
  });

  it("redacts response.data.token from a GitHub 401 echo", () => {
    const { logger, lines } = buildCapturingLogger();
    const err = Object.assign(new Error("Unauthorized"), {
      name: "RequestError",
      response: { status: 401, data: { token: "ghs_should_not_appear", message: "Bad" } },
    });
    logger.error({ err }, "auth check");

    const raw = JSON.stringify(lines);
    expect(raw).not.toContain("ghs_should_not_appear");
    const line = lines[0] as { err: { response: { data: { token: string; message: string } } } };
    expect(line.err.response.data.token).toBe("[Redacted]");
    expect(line.err.response.data.message).toBe("Bad");
  });

  it("passes through non-error values from the err serializer unchanged", () => {
    expect(errSerializer("not an error")).toBe("not an error");
    expect(errSerializer(null)).toBeNull();
    expect(errSerializer(42)).toBe(42);
  });

  it("redacts non-token sensitive keys directly under err.response.data", () => {
    const { logger, lines } = buildCapturingLogger();
    const pem = "MIIEowIBAAKCAQEA_SECRET_PEM_CONTENT";
    const err = Object.assign(new Error("Unauthorized"), {
      name: "RequestError",
      response: {
        status: 401,
        data: {
          privateKey: pem,
          installationToken: "ghs_should_not_appear_in_data",
          webhookSecret: "whsec_top_secret",
          message: "Bad",
        },
      },
    });
    logger.error({ err }, "auth check");

    const raw = JSON.stringify(lines);
    expect(raw).not.toContain("MIIEowIBAAKCAQEA");
    expect(raw).not.toContain("whsec_top_secret");
    expect(raw).not.toContain("ghs_should_not_appear_in_data");
    const data = (
      lines[0] as {
        err: {
          response: {
            data: {
              privateKey: string;
              installationToken: string;
              webhookSecret: string;
              message: string;
            };
          };
        };
      }
    ).err.response.data;
    expect(data.privateKey).toBe("[Redacted]");
    expect(data.installationToken).toBe("[Redacted]");
    expect(data.webhookSecret).toBe("[Redacted]");
    expect(data.message).toBe("Bad");
  });

  it("recurses into nested objects under err.response.data", () => {
    const { logger, lines } = buildCapturingLogger();
    const nestedToken = `ghs_${"B".repeat(36)}`;
    const err = Object.assign(new Error("Unauthorized"), {
      name: "RequestError",
      response: {
        status: 401,
        data: {
          meta: {
            token: nestedToken,
            privateKey: "DEEPLY_NESTED_PEM",
            details: { awsSecretAccessKey: "AKIAEXAMPLENESTED" },
          },
        },
      },
    });
    logger.error({ err }, "deep auth check");

    const raw = JSON.stringify(lines);
    expect(raw).not.toContain(nestedToken);
    expect(raw).not.toContain("DEEPLY_NESTED_PEM");
    expect(raw).not.toContain("AKIAEXAMPLENESTED");
    const meta = (
      lines[0] as {
        err: {
          response: {
            data: {
              meta: {
                token: string;
                privateKey: string;
                details: { awsSecretAccessKey: string };
              };
            };
          };
        };
      }
    ).err.response.data.meta;
    expect(meta.token).toBe("[Redacted]");
    expect(meta.privateKey).toBe("[Redacted]");
    expect(meta.details.awsSecretAccessKey).toBe("[Redacted]");
  });

  it("recurses into nested objects under err.request.headers", () => {
    const { logger, lines } = buildCapturingLogger();
    const err = Object.assign(new Error("boom"), {
      name: "RequestError",
      request: {
        headers: {
          accept: "application/json",
          forwarded: { authorization: "Bearer NESTED_PROXY_BEARER" },
        },
      },
    });
    logger.error({ err }, "proxy chain failed");

    const raw = JSON.stringify(lines);
    expect(raw).not.toContain("NESTED_PROXY_BEARER");
    const headers = (
      lines[0] as {
        err: { request: { headers: { forwarded: { authorization: string }; accept: string } } };
      }
    ).err.request.headers;
    expect(headers.forwarded.authorization).toBe("[Redacted]");
    expect(headers.accept).toBe("application/json");
  });

  it("freezes the exported REDACT_PATHS list at runtime", () => {
    expect(Object.isFrozen(REDACT_PATHS)).toBe(true);
  });

  it("redacts both halves of the daemon auth-token rotation pair (#76 follow-up)", () => {
    const { logger, lines } = buildCapturingLogger();
    logger.info(
      {
        daemonAuthToken: "PRIMARY_DAEMON_SECRET",
        daemonAuthTokenPrevious: "PREVIOUS_DAEMON_SECRET",
      },
      "Loaded config",
    );

    const raw = JSON.stringify(lines);
    expect(raw).not.toContain("PRIMARY_DAEMON_SECRET");
    expect(raw).not.toContain("PREVIOUS_DAEMON_SECRET");
    const line = lines[0]!;
    expect(line["daemonAuthToken"]).toBe("[Redacted]");
    expect(line["daemonAuthTokenPrevious"]).toBe("[Redacted]");
  });

  it("redacts daemonAuthTokenPrevious nested under err.response.data (structural walker, #76 follow-up)", () => {
    const { logger, lines } = buildCapturingLogger();
    const err = Object.assign(new Error("Unauthorized"), {
      name: "RequestError",
      response: {
        status: 401,
        data: {
          daemonAuthTokenPrevious: "NESTED_PREVIOUS_SECRET",
          message: "Bad",
        },
      },
    });
    logger.error({ err }, "auth check");

    const raw = JSON.stringify(lines);
    expect(raw).not.toContain("NESTED_PREVIOUS_SECRET");
    const data = (
      lines[0] as {
        err: { response: { data: { daemonAuthTokenPrevious: string; message: string } } };
      }
    ).err.response.data;
    expect(data.daemonAuthTokenPrevious).toBe("[Redacted]");
    expect(data.message).toBe("Bad");
  });
});

describe("createChildLogger correlation contract (#175)", () => {
  it("binds the entity identifier under the canonical `entityNumber` field", () => {
    // pino prepends a child logger's bindings to every line it emits, so
    // asserting the bindings is asserting what an operator can grep on.
    const log = createChildLogger({
      deliveryId: "d-1",
      owner: "octo",
      repo: "demo",
      entityNumber: 42,
    });
    const bindings = log.bindings();
    expect(bindings["entityNumber"]).toBe(42);
    expect(bindings["deliveryId"]).toBe("d-1");
    expect(bindings["owner"]).toBe("octo");
    expect(bindings["repo"]).toBe("demo");
    // The drifted per-handler names must NOT leak back in.
    expect(bindings["issueNumber"]).toBeUndefined();
    expect(bindings["prNumber"]).toBeUndefined();
  });

  it("passes arbitrary per-handler extras through alongside the canonical fields", () => {
    const log = createChildLogger({
      deliveryId: "d-2",
      owner: "octo",
      repo: "demo",
      entityNumber: 7,
      event: "issues.labeled",
      label: "type: fix",
      senderLogin: "alice",
    });
    const bindings = log.bindings();
    expect(bindings["entityNumber"]).toBe(7);
    expect(bindings["event"]).toBe("issues.labeled");
    expect(bindings["label"]).toBe("type: fix");
    expect(bindings["senderLogin"]).toBe("alice");
  });
});
