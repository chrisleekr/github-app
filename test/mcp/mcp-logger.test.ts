import { afterEach, describe, expect, it } from "bun:test";

import { createMcpLogger } from "../../src/mcp/mcp-logger";

// Capture what the logger writes to process.stderr (where MCP loggers write so
// stdout stays clean for JSON-RPC), restoring the original writer afterwards.
function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as unknown as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join("");
}

const savedDelivery = process.env["DELIVERY_ID"];
afterEach(() => {
  if (savedDelivery === undefined) delete process.env["DELIVERY_ID"];
  else process.env["DELIVERY_ID"] = savedDelivery;
});

describe("createMcpLogger (#172)", () => {
  it("binds the server name and inherited deliveryId", () => {
    process.env["DELIVERY_ID"] = "del-123";
    const bindings = createMcpLogger("github-state").bindings();
    expect(bindings["server"]).toBe("github-state");
    expect(bindings["deliveryId"]).toBe("del-123");
  });

  it("omits deliveryId when DELIVERY_ID is unset", () => {
    delete process.env["DELIVERY_ID"];
    const bindings = createMcpLogger("repo-memory").bindings();
    expect(bindings["server"]).toBe("repo-memory");
    expect(bindings["deliveryId"]).toBeUndefined();
  });

  it("redacts a ghs_ token in err.message with parity to the main logger", () => {
    const token = `ghs_${"A".repeat(36)}`;
    const out = captureStderr(() => {
      const log = createMcpLogger("comment");
      log.error({ err: new Error(`boom ${token}`) }, "server failed");
    });
    expect(out).not.toContain(token);
    expect(out).toContain("[REDACTED_GITHUB_TOKEN]");
  });

  it("redacts a top-level token field via REDACT_PATHS", () => {
    const out = captureStderr(() => {
      const log = createMcpLogger("comment");
      log.warn({ installationToken: "ghs_secret_value_here" }, "config");
    });
    expect(out).not.toContain("ghs_secret_value_here");
    expect(out).toContain("[Redacted]");
  });

  it("writes to stderr, never stdout (stdout carries JSON-RPC)", () => {
    // Runtime destination check: the load-bearing contract for every stdio MCP
    // server is that log output goes to stderr, leaving stdout clean for the
    // JSON-RPC transport. Capture both streams and assert the line landed on
    // stderr and nothing leaked to stdout.
    const stderrChunks: string[] = [];
    const stdoutChunks: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    const origOut = process.stdout.write.bind(process.stdout);
    process.stderr.write = ((chunk: unknown): boolean => {
      stderrChunks.push(String(chunk));
      return true;
    }) as unknown as typeof process.stderr.write;
    process.stdout.write = ((chunk: unknown): boolean => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as unknown as typeof process.stdout.write;
    try {
      createMcpLogger("comment").info({ marker: "to-stderr" }, "log line");
    } finally {
      process.stderr.write = origErr;
      process.stdout.write = origOut;
    }
    expect(stderrChunks.join("")).toContain("to-stderr");
    expect(stdoutChunks.join("")).toBe("");
  });
});
