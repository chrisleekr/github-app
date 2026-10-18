import { describe, expect, it } from "bun:test";

import {
  GITHUB_INSTALLATION_TOKEN_LIFETIME_MS,
  WORKFLOW_RUNNER_ATTEMPT_DEADLINE_MS,
  WORKFLOW_RUNNER_STARTUP_BUDGET_MS,
} from "../../src/orchestrator/workflow-runner-lifetime";

describe("workflow runner lifetime budgets", () => {
  it("reserves one token lifetime plus a minute of margin", () => {
    // The payload gate needs more than one token lifetime left at registration.
    expect(WORKFLOW_RUNNER_ATTEMPT_DEADLINE_MS - WORKFLOW_RUNNER_STARTUP_BUDGET_MS).toBe(
      GITHUB_INSTALLATION_TOKEN_LIFETIME_MS + 60_000,
    );
  });

  it("leaves a positive startup budget", () => {
    expect(WORKFLOW_RUNNER_STARTUP_BUDGET_MS).toBeGreaterThan(0);
  });
});
