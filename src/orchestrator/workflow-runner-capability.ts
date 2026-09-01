import { createHmac, timingSafeEqual } from "node:crypto";

const CAPABILITY_PREFIX = "wfr1.";
const CAPABILITY_PATTERN = /^wfr1\.([1-9][0-9]{12})\.([A-Za-z0-9_-]{43})$/;
const RUNNER_PATH_PREFIX = "/ws/workflow-runner/";

function signature(secret: string, runId: string, attemptId: string, expiresAtMs: number): string {
  return createHmac("sha256", secret)
    .update(`workflow-runner-v1\0${runId}\0${attemptId}\0${String(expiresAtMs)}`, "utf8")
    .digest("base64url");
}

function expiryMillis(expiresAt: Date | number): number {
  const value = expiresAt instanceof Date ? expiresAt.getTime() : expiresAt;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("workflow runner capability expiry must be a positive safe integer");
  }
  return value;
}

export function deriveWorkflowRunnerCapability(
  secret: string,
  runId: string,
  attemptId: string,
  expiresAt: Date | number,
): string {
  const expiresAtMs = expiryMillis(expiresAt);
  return `${CAPABILITY_PREFIX}${String(expiresAtMs)}.${signature(secret, runId, attemptId, expiresAtMs)}`;
}

function constantTimeEqual(left: string, right: string): boolean {
  const rightBytes = Buffer.from(right, "utf8");
  const leftLength = Buffer.byteLength(left, "utf8");
  const leftBytes = Buffer.alloc(rightBytes.length);
  leftBytes.write(left, 0, rightBytes.length, "utf8");
  const equal = timingSafeEqual(leftBytes, rightBytes);
  return equal && leftLength === rightBytes.length;
}

/** Validate the exact run/attempt capability against both rotation slots. */
export function isWorkflowRunnerCapabilityValid(
  authorization: string | null | undefined,
  runId: string,
  attemptId: string,
  primarySecret: string,
  previousSecret?: string,
  nowMs = Date.now(),
): boolean {
  const actual = authorization?.startsWith("Bearer ") === true ? authorization.slice(7) : "";
  const parsed = CAPABILITY_PATTERN.exec(actual);
  if (parsed === null) return false;
  const expiresAtMs = Number(parsed[1]);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) return false;
  const primary = deriveWorkflowRunnerCapability(primarySecret, runId, attemptId, expiresAtMs);
  const previous = deriveWorkflowRunnerCapability(
    previousSecret ?? primarySecret,
    runId,
    attemptId,
    expiresAtMs,
  );
  const primaryMatch = constantTimeEqual(actual, primary);
  const previousMatch = constantTimeEqual(actual, previous);
  return primaryMatch || (previousSecret !== undefined && previousMatch);
}

export function workflowRunnerPath(runId: string, attemptId: string): string {
  return `${RUNNER_PATH_PREFIX}${encodeURIComponent(runId)}/${encodeURIComponent(attemptId)}`;
}

export function parseWorkflowRunnerPath(
  pathname: string,
): { runId: string; attemptId: string } | null {
  if (!pathname.startsWith(RUNNER_PATH_PREFIX)) return null;
  const parts = pathname.slice(RUNNER_PATH_PREFIX.length).split("/");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return null;
  try {
    return {
      runId: decodeURIComponent(parts[0] ?? ""),
      attemptId: decodeURIComponent(parts[1] ?? ""),
    };
  } catch {
    return null;
  }
}

export function workflowRunnerUrl(baseUrl: string, runId: string, attemptId: string): string {
  const url = new URL(baseUrl);
  url.pathname = workflowRunnerPath(runId, attemptId);
  url.search = "";
  url.hash = "";
  return url.toString();
}
