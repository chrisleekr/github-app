import { describe, expect, it } from "bun:test";

import {
  deriveWorkflowRunnerCapability,
  isWorkflowRunnerCapabilityValid,
  parseWorkflowRunnerPath,
  workflowRunnerPath,
  workflowRunnerUrl,
} from "../../src/orchestrator/workflow-runner-capability";

const runId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
const expiresAtMs = 2_000_000_000_000;
const nowMs = 1_900_000_000_000;

describe("workflow runner attempt capability", () => {
  it("binds authentication to the exact run and attempt", () => {
    const capability = deriveWorkflowRunnerCapability(
      "primary-secret",
      runId,
      attemptId,
      expiresAtMs,
    );
    const authorization = `Bearer ${capability}`;

    expect(
      isWorkflowRunnerCapabilityValid(
        authorization,
        runId,
        attemptId,
        "primary-secret",
        undefined,
        nowMs,
      ),
    ).toBe(true);
    expect(
      isWorkflowRunnerCapabilityValid(
        authorization,
        crypto.randomUUID(),
        attemptId,
        "primary-secret",
        undefined,
        nowMs,
      ),
    ).toBe(false);
    expect(
      isWorkflowRunnerCapabilityValid(
        authorization,
        runId,
        crypto.randomUUID(),
        "primary-secret",
        undefined,
        nowMs,
      ),
    ).toBe(false);
  });

  it("accepts the previous root secret only during an explicit rotation window", () => {
    const previous = `Bearer ${deriveWorkflowRunnerCapability(
      "old-secret",
      runId,
      attemptId,
      expiresAtMs,
    )}`;
    expect(
      isWorkflowRunnerCapabilityValid(
        previous,
        runId,
        attemptId,
        "new-secret",
        "old-secret",
        nowMs,
      ),
    ).toBe(true);
    expect(
      isWorkflowRunnerCapabilityValid(previous, runId, attemptId, "new-secret", undefined, nowMs),
    ).toBe(false);
  });

  it("rejects an expired capability before signature comparison", () => {
    const expired = deriveWorkflowRunnerCapability("primary-secret", runId, attemptId, nowMs - 1);
    expect(
      isWorkflowRunnerCapabilityValid(
        `Bearer ${expired}`,
        runId,
        attemptId,
        "primary-secret",
        undefined,
        nowMs,
      ),
    ).toBe(false);
  });

  it("rejects missing, malformed, and prefix-collision authorization values", () => {
    const capability = deriveWorkflowRunnerCapability(
      "primary-secret",
      runId,
      attemptId,
      expiresAtMs,
    );
    for (const authorization of [
      undefined,
      capability,
      `Basic ${capability}`,
      `Bearer ${capability}extra`,
      `Bearer ${capability.slice(0, -1)}`,
    ]) {
      expect(
        isWorkflowRunnerCapabilityValid(
          authorization,
          runId,
          attemptId,
          "primary-secret",
          undefined,
          nowMs,
        ),
      ).toBe(false);
    }
  });

  it("parses only the two-segment runner path and rejects malformed encoding", () => {
    const path = workflowRunnerPath(runId, attemptId);
    expect(parseWorkflowRunnerPath(path)).toEqual({ runId, attemptId });
    expect(parseWorkflowRunnerPath(`${path}/extra`)).toBeNull();
    expect(parseWorkflowRunnerPath("/ws/workflow-runner/%E0%A4%A/value")).toBeNull();
    expect(parseWorkflowRunnerPath("/ws/workflow-runner//value")).toBeNull();
    expect(parseWorkflowRunnerPath("/ws/workflow-runner/%2F/value")).toEqual({
      runId: "/",
      attemptId: "value",
    });
  });

  it("builds a path-only URL without inherited credentials, query, or fragment", () => {
    expect(
      workflowRunnerUrl("wss://controller.example/base?secret=query#fragment", runId, attemptId),
    ).toBe(`wss://controller.example/ws/workflow-runner/${runId}/${attemptId}`);
  });
});
