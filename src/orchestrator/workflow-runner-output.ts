import { config } from "../config";
import { logger } from "../logger";
import {
  type WorkflowRunnerCommand,
  WorkflowRunnerCommandSchema,
  type WorkflowRunnerResultPayload,
  WorkflowRunnerResultPayloadSchema,
} from "../shared/workflow-runner-messages";
import {
  configuredCredentialValues,
  containsExactCredentialPropertyName,
  containsExactCredentialValue,
} from "../utils/exact-credential-redaction";
import { detectSecretsWithLlm } from "../utils/llm-output-scanner";
import { redactSecrets } from "../utils/sanitize";

export class WorkflowRunnerOutputRejectedError extends Error {
  constructor() {
    super("workflow runner output was rejected by credential policy");
    this.name = "WorkflowRunnerOutputRejectedError";
  }
}

interface RedactedValue {
  readonly value: unknown;
  readonly matchCount: number;
  readonly kinds: readonly string[];
  readonly propertyNameMatchCount: number;
}

function redactStructuredValue(value: unknown): RedactedValue {
  if (typeof value === "string") {
    const result = redactSecrets(value);
    return {
      value: result.body,
      matchCount: result.matchCount,
      kinds: result.kinds,
      propertyNameMatchCount: 0,
    };
  }
  if (Array.isArray(value)) {
    const entries = value.map(redactStructuredValue);
    return combine(
      entries,
      entries.map((entry) => entry.value),
    );
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).map(([key, entry]) => {
      const keyScan = redactSecrets(key);
      return { key, keyScan, entry: redactStructuredValue(entry) };
    });
    const combined = combine(
      entries.map(({ entry }) => entry),
      Object.fromEntries(entries.map(({ key, entry }) => [key, entry.value])),
    );
    return {
      ...combined,
      matchCount:
        combined.matchCount + entries.reduce((total, item) => total + item.keyScan.matchCount, 0),
      kinds: [...new Set([...combined.kinds, ...entries.flatMap((item) => item.keyScan.kinds)])],
      propertyNameMatchCount:
        combined.propertyNameMatchCount +
        entries.reduce((total, item) => total + item.keyScan.matchCount, 0),
    };
  }
  return { value, matchCount: 0, kinds: [], propertyNameMatchCount: 0 };
}

function combine(entries: readonly RedactedValue[], value: unknown): RedactedValue {
  return {
    value,
    matchCount: entries.reduce((total, entry) => total + entry.matchCount, 0),
    kinds: [...new Set(entries.flatMap((entry) => entry.kinds))],
    propertyNameMatchCount: entries.reduce(
      (total, entry) => total + entry.propertyNameMatchCount,
      0,
    ),
  };
}

async function encodedSecretScanIsSafe(value: unknown, callsite: string): Promise<boolean> {
  if (!config.llmOutputScannerEnabled) {
    logger.error(
      { event: "workflow_runner_output_scan_unavailable", scanner: "llm", callsite },
      "Workflow runner output scanner is disabled; rejecting output",
    );
    return false;
  }
  try {
    // Detect-only: this boundary rejects the whole payload on a hit and never
    // reads a redacted body. Asking the model to echo a review-sized payload
    // back made the call's wall-clock scale with output size, which timed out
    // and discarded completed runs.
    const scan = await detectSecretsWithLlm(JSON.stringify(value), {
      timeoutMs: config.llmOutputScannerTimeoutMs,
      log: logger,
    });
    if (scan.containsSecret) {
      logger.warn(
        {
          event: "workflow_runner_output_rejected",
          scanner: "llm",
          callsite,
          kinds: scan.kinds,
          matchCount: scan.matchCount,
        },
        "Rejected workflow runner output containing encoded credentials",
      );
    }
    return !scan.containsSecret;
  } catch (err) {
    logger.error(
      { event: "workflow_runner_output_scan_unavailable", scanner: "llm", err, callsite },
      "Workflow runner output scanner failed; rejecting output",
    );
    return false;
  }
}

function containsConfiguredCredential(value: unknown): boolean {
  const credentials = configuredCredentialValues();
  return (
    containsExactCredentialPropertyName(value, credentials) ||
    containsExactCredentialValue(value, credentials)
  );
}

function logDeterministicRedaction(redacted: RedactedValue, callsite: string): void {
  if (redacted.matchCount === 0) return;
  logger.warn(
    {
      event: "secret_redacted",
      scanner: "regex",
      callsite,
      kinds: redacted.kinds,
      matchCount: redacted.matchCount,
      propertyNameMatchCount: redacted.propertyNameMatchCount,
    },
    "Redacted credentials from workflow runner output",
  );
}

export async function sanitizeWorkflowRunnerCommand(
  command: WorkflowRunnerCommand,
): Promise<WorkflowRunnerCommand> {
  if (containsConfiguredCredential(command)) throw new WorkflowRunnerOutputRejectedError();
  const redacted = redactStructuredValue(command);
  logDeterministicRedaction(redacted, "workflow-runner.command");
  if (redacted.matchCount > 0) throw new WorkflowRunnerOutputRejectedError();
  const parsed = WorkflowRunnerCommandSchema.safeParse(redacted.value);
  if (!parsed.success || !(await encodedSecretScanIsSafe(parsed.data, "workflow-runner.command"))) {
    throw new WorkflowRunnerOutputRejectedError();
  }
  return parsed.data;
}

export async function sanitizeWorkflowRunnerResult(
  payload: WorkflowRunnerResultPayload,
): Promise<WorkflowRunnerResultPayload> {
  const exactCredential = containsConfiguredCredential(payload);
  const redacted = redactStructuredValue(payload);
  logDeterministicRedaction(redacted, "workflow-runner.result");
  const parsed = WorkflowRunnerResultPayloadSchema.safeParse(redacted.value);
  if (
    !exactCredential &&
    redacted.propertyNameMatchCount === 0 &&
    parsed.success &&
    (await encodedSecretScanIsSafe(parsed.data, "workflow-runner.result"))
  ) {
    return parsed.data;
  }
  return {
    runId: payload.runId,
    attemptId: payload.attemptId,
    durationMs: payload.durationMs,
    result: {
      status: "failed",
      reason: "workflow runner output was rejected by credential policy",
      humanMessage: "Workflow output was rejected by the credential safety boundary.",
    },
  };
}
