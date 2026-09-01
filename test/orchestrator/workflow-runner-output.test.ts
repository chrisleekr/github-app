import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

import { expectToReject } from "../utils/assertions";

const detectSecretsWithLlm = mock(() =>
  Promise.resolve({ containsSecret: false, matchCount: 0, kinds: [] }),
);
// The redacting entry point must stay unused here: it makes the model restate
// the payload, so its latency scales with body size and a fail-closed boundary
// turns that into a rejected run.
const scanForSecretsWithLlm = mock(() =>
  Promise.resolve({ containsSecret: false, redactedBody: "", matchCount: 0, kinds: [] }),
);
const config = { llmOutputScannerEnabled: true, llmOutputScannerTimeoutMs: 100 };
const loggerWarn = mock(() => undefined);
const loggerError = mock(() => undefined);
const originalApiKey = process.env["ANTHROPIC_API_KEY"];
process.env["ANTHROPIC_API_KEY"] = "controller-test-provider-secret";

void mock.module("../../src/config", () => ({
  config,
}));
void mock.module("../../src/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: loggerWarn,
    error: loggerError,
    debug: mock(() => undefined),
  },
}));
void mock.module("../../src/utils/llm-output-scanner", () => ({
  detectSecretsWithLlm,
  scanForSecretsWithLlm,
}));

const { sanitizeWorkflowRunnerCommand, sanitizeWorkflowRunnerResult } =
  await import("../../src/orchestrator/workflow-runner-output");

describe("controller workflow runner output boundary", () => {
  beforeEach(() => {
    config.llmOutputScannerEnabled = true;
    detectSecretsWithLlm.mockReset();
    detectSecretsWithLlm.mockResolvedValue({
      containsSecret: false,
      matchCount: 0,
      kinds: [],
    });
    scanForSecretsWithLlm.mockReset();
    loggerWarn.mockClear();
    loggerError.mockClear();
  });

  it("rejects a command when deterministic redaction detects a credential", async () => {
    const token = `ghs_${"a".repeat(36)}`;
    await expectToReject(
      sanitizeWorkflowRunnerCommand({
        type: "set-state",
        patch: { report: `before ${token} after` },
        humanMessage: `done ${token}`,
      }),
      "credential policy",
    );
  });

  it("rejects a command when the encoded-secret scanner detects a credential", async () => {
    detectSecretsWithLlm.mockResolvedValueOnce({
      containsSecret: true,
      matchCount: 1,
      kinds: ["ENCODED_SECRET"],
    });

    await expectToReject(
      sanitizeWorkflowRunnerCommand({
        type: "set-state",
        patch: { report: "encoded credential" },
        humanMessage: "done",
      }),
      "credential policy",
    );
  });

  it("converts a rejected terminal result into a fixed safe failure", async () => {
    detectSecretsWithLlm.mockResolvedValueOnce({
      containsSecret: true,
      matchCount: 1,
      kinds: ["AWS_SECRET_KEY"],
    });

    const payload = await sanitizeWorkflowRunnerResult({
      runId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      durationMs: 10,
      result: {
        status: "succeeded",
        state: { report: "opaque credential" },
        humanMessage: "complete",
      },
    });

    expect(payload.result).toEqual({
      status: "failed",
      reason: "workflow runner output was rejected by credential policy",
      humanMessage: "Workflow output was rejected by the credential safety boundary.",
    });
  });

  for (const secret of [
    `ghs_${"b".repeat(36)}`,
    "AKIAIOSFODNN7EXAMPLE",
    `sk-ant-api03-${"c".repeat(80)}`,
    `wfr1.2000000000000.${"d".repeat(43)}`,
  ]) {
    it(`rejects a credential-bearing property name with deterministic scanning: ${secret.slice(0, 4)}`, async () => {
      config.llmOutputScannerEnabled = false;
      await expectToReject(
        sanitizeWorkflowRunnerCommand({
          type: "set-state",
          patch: { nested: { [secret]: "x" } },
          humanMessage: "done",
        }),
        "credential policy",
      );

      const result = await sanitizeWorkflowRunnerResult({
        runId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        durationMs: 1,
        result: { status: "succeeded", state: { nested: { [secret]: "x" } } },
      });
      expect(result.result.status).toBe("failed");
    });
  }

  it("keeps property-name rejection when the encoded scanner throws", async () => {
    const token = `ghs_${"e".repeat(36)}`;
    detectSecretsWithLlm.mockRejectedValueOnce(new Error("scanner unavailable"));
    const result = await sanitizeWorkflowRunnerResult({
      runId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      durationMs: 1,
      result: { status: "succeeded", state: { [token]: "x" } },
    });
    expect(result.result.status).toBe("failed");
  });

  it("fails closed when encoded-secret scanning is unavailable", async () => {
    detectSecretsWithLlm.mockRejectedValueOnce(new Error("scanner unavailable"));
    const result = await sanitizeWorkflowRunnerResult({
      runId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      durationMs: 1,
      result: { status: "succeeded", state: { report: "safe" } },
    });
    expect(result.result.status).toBe("failed");
    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "workflow_runner_output_scan_unavailable",
        scanner: "llm",
        callsite: "workflow-runner.result",
      }),
      "Workflow runner output scanner failed; rejecting output",
    );
  });

  it("fails closed when encoded-secret scanning is disabled", async () => {
    config.llmOutputScannerEnabled = false;
    await expectToReject(
      sanitizeWorkflowRunnerCommand({
        type: "set-state",
        patch: { report: "safe" },
        humanMessage: "done",
      }),
      "credential policy",
    );
    const result = await sanitizeWorkflowRunnerResult({
      runId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      durationMs: 1,
      result: { status: "succeeded", state: { report: "safe" } },
    });
    expect(result.result.status).toBe("failed");
  });

  it("scans with the detect-only entry point so latency stays flat in payload size", async () => {
    const payload = await sanitizeWorkflowRunnerResult({
      runId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      durationMs: 1,
      result: { status: "succeeded", state: { report: "x".repeat(50_000) } },
    });

    expect(payload.result.status).toBe("succeeded");
    expect(detectSecretsWithLlm).toHaveBeenCalledTimes(1);
    // Echoing a 50 KB payload back is what exhausted the per-call budget and
    // turned a completed run into a credential-policy rejection.
    expect(scanForSecretsWithLlm).not.toHaveBeenCalled();
  });

  it("rejects common reversible encodings of configured credentials", async () => {
    const encoded = Buffer.from("controller-test-provider-secret", "utf8").toString("base64");
    await expectToReject(
      sanitizeWorkflowRunnerCommand({
        type: "set-state",
        patch: { report: encoded },
        humanMessage: "done",
      }),
      "credential policy",
    );
  });
});

afterAll(() => {
  if (originalApiKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
  else process.env["ANTHROPIC_API_KEY"] = originalApiKey;
});
