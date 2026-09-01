import { afterEach, describe, expect, it, jest } from "bun:test";

import {
  createWorkflowRunnerDeadline,
  workflowRunnerDeadlineDelayMs,
  WorkflowRunnerDeadlineError,
} from "../../src/runner/token-deadline";

describe("installation token execution deadline", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("fires five minutes before the authoritative expiry", () => {
    jest.useFakeTimers();
    const now = Date.parse("2026-08-23T03:00:00Z");
    const expiresAt = "2026-08-23T04:00:00Z";
    const attemptDeadlineAt = "2026-08-23T04:10:00Z";
    expect(workflowRunnerDeadlineDelayMs(expiresAt, attemptDeadlineAt, now)).toBe(55 * 60_000);
    const deadline = createWorkflowRunnerDeadline(expiresAt, attemptDeadlineAt, now);

    jest.advanceTimersByTime(55 * 60_000 - 1);
    expect(deadline.signal.aborted).toBe(false);
    jest.advanceTimersByTime(1);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBeInstanceOf(WorkflowRunnerDeadlineError);
  });

  it("aborts immediately when the reporting buffer has already begun", () => {
    const now = Date.parse("2026-08-23T03:56:00Z");
    const deadline = createWorkflowRunnerDeadline(
      "2026-08-23T04:00:00Z",
      "2026-08-23T04:10:00Z",
      now,
    );
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBeInstanceOf(WorkflowRunnerDeadlineError);
  });

  it("clamps a freshly minted token to the durable attempt deadline", () => {
    const now = Date.parse("2026-08-23T03:00:00Z");
    expect(workflowRunnerDeadlineDelayMs("2026-08-23T04:00:00Z", "2026-08-23T03:20:00Z", now)).toBe(
      20 * 60_000,
    );
  });
});
