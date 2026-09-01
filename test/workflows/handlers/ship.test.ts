/** Unit tests for bounded ship-resume state at the isolated runner boundary. */

import { describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";
import type pino from "pino";

import type { WorkflowRunSnapshot } from "../../../src/shared/workflow-types";

function silentLogger(): pino.Logger {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    child: mock(function (this: unknown) {
      return this;
    }),
  } as unknown as pino.Logger;
}

function buildOctokit(prState: "open" | "closed" | "throw"): Octokit {
  return {
    rest: {
      pulls: {
        get: mock(() => {
          if (prState === "throw") return Promise.reject(new Error("404 not found"));
          return Promise.resolve({ data: { state: prState } });
        }),
      },
    },
  } as unknown as Octokit;
}

function snapshot(input: {
  readonly status: WorkflowRunSnapshot["status"];
  readonly state?: WorkflowRunSnapshot["state"];
  readonly createdAt: string;
}): WorkflowRunSnapshot {
  return {
    id: crypto.randomUUID(),
    status: input.status,
    state: input.state ?? {},
    createdAt: input.createdAt,
  };
}

// Warm the registry before importing ship.ts. The registry eagerly references
// the ship handler, so importing the handler first would re-enter its TDZ.
await import("../../../src/workflows/registry");
const { handler: shipHandler } = await import("../../../src/workflows/handlers/ship");

describe("ship handler", () => {
  it("resumes at implement after succeeded triage and plan", async () => {
    const triage = snapshot({
      status: "succeeded",
      state: { recommendedNext: "plan" },
      createdAt: "2026-08-23T01:00:00.000Z",
    });
    const plan = snapshot({
      status: "succeeded",
      createdAt: "2026-08-23T01:01:00.000Z",
    });
    const implement = snapshot({
      status: "failed",
      createdAt: "2026-08-23T01:02:00.000Z",
    });
    const target = { type: "issue" as const, owner: "acme", repo: "repo", number: 301 };
    const setState = mock(() => Promise.resolve());
    const handOffChild = mock(() => Promise.resolve({ childRunId: "child-implement" }));

    const result = await shipHandler({
      runId: crypto.randomUUID(),
      workflowName: "ship",
      target,
      logger: silentLogger(),
      octokit: buildOctokit("open"),
      deliveryId: "delivery-301",
      setState,
      handOffChild,
      shipStepRuns: { triage, plan, implement },
    });

    expect(result).toEqual({
      status: "handed-off",
      state: {
        currentStepIndex: 2,
        stepRuns: [triage.id, plan.id],
        handedOffTo: "child-implement",
      },
      humanMessage: "ship resumed at step 2 (`implement`); 2 prior step(s) reused.",
      childRunId: "child-implement",
    });
    expect(handOffChild).toHaveBeenCalledWith({
      workflowName: "implement",
      target,
      parentStepIndex: 2,
      state: { currentStepIndex: 2, stepRuns: [triage.id, plan.id] },
      humanMessage: "ship resumed at step 2 (`implement`); 2 prior step(s) reused.",
    });
    expect(setState).not.toHaveBeenCalled();
  });

  it("skips to review when the prior implement PR remains open", async () => {
    const triage = snapshot({
      status: "succeeded",
      state: { recommendedNext: "plan" },
      createdAt: "2026-08-23T02:00:00.000Z",
    });
    const plan = snapshot({
      status: "succeeded",
      createdAt: "2026-08-23T02:01:00.000Z",
    });
    const implement = snapshot({
      status: "succeeded",
      state: { pr_number: 999 },
      createdAt: "2026-08-23T02:02:00.000Z",
    });
    const target = { type: "issue" as const, owner: "acme", repo: "repo", number: 302 };
    const octokit = buildOctokit("open");
    const handOffChild = mock(() => Promise.resolve({ childRunId: "child-review" }));

    const result = await shipHandler({
      runId: crypto.randomUUID(),
      workflowName: "ship",
      target,
      logger: silentLogger(),
      octokit,
      deliveryId: "delivery-302",
      setState: mock(() => Promise.resolve()),
      handOffChild,
      shipStepRuns: { triage, plan, implement },
    });

    expect(result).toEqual({
      status: "handed-off",
      state: {
        currentStepIndex: 3,
        stepRuns: [triage.id, plan.id, implement.id],
        handedOffTo: "child-review",
      },
      humanMessage: "ship resumed at step 3 (`review`); 3 prior step(s) reused.",
      childRunId: "child-review",
    });
    const pullsGet = octokit.rest.pulls.get as unknown as ReturnType<typeof mock>;
    expect(pullsGet).toHaveBeenCalledWith({
      owner: target.owner,
      repo: target.repo,
      pull_number: 999,
    });
    expect(handOffChild).toHaveBeenCalledWith({
      workflowName: "review",
      target,
      parentStepIndex: 3,
      state: { currentStepIndex: 3, stepRuns: [triage.id, plan.id, implement.id] },
      humanMessage: "ship resumed at step 3 (`review`); 3 prior step(s) reused.",
    });
  });

  for (const prState of ["closed", "throw"] as const) {
    it(`restarts implement when the prior PR is ${prState === "throw" ? "unverifiable" : "closed"}`, async () => {
      const triage = snapshot({
        status: "succeeded",
        state: { recommendedNext: "plan" },
        createdAt: "2026-08-23T03:00:00.000Z",
      });
      const plan = snapshot({
        status: "succeeded",
        createdAt: "2026-08-23T03:01:00.000Z",
      });
      const implement = snapshot({
        status: "succeeded",
        state: { pr_number: 999 },
        createdAt: "2026-08-23T03:02:00.000Z",
      });
      const target = { type: "issue" as const, owner: "acme", repo: "repo", number: 303 };
      const handOffChild = mock(() => Promise.resolve({ childRunId: "child-implement" }));

      const result = await shipHandler({
        runId: crypto.randomUUID(),
        workflowName: "ship",
        target,
        logger: silentLogger(),
        octokit: buildOctokit(prState),
        deliveryId: "delivery-303",
        setState: mock(() => Promise.resolve()),
        handOffChild,
        shipStepRuns: { triage, plan, implement },
      });

      expect(result).toMatchObject({
        status: "handed-off",
        state: {
          currentStepIndex: 2,
          stepRuns: [triage.id, plan.id],
          handedOffTo: "child-implement",
        },
        childRunId: "child-implement",
      });
      expect(handOffChild).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowName: "implement",
          parentStepIndex: 2,
          state: { currentStepIndex: 2, stepRuns: [triage.id, plan.id] },
        }),
      );
    });
  }
});
