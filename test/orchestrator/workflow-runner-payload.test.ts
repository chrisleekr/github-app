import { beforeEach, describe, expect, it, mock } from "bun:test";

import { expectToReject } from "../utils/assertions";

const context = {
  owner: "acme",
  repo: "widgets",
  entityNumber: 16,
  isPR: false,
  deliveryId: "delivery-16",
};
const db = mock(() => Promise.resolve([{ context_json: context }]));
const getRepoInstallation = mock(() => Promise.resolve({ data: { id: 123 } }));
const TOKEN_EXPIRES_AT = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
const ATTEMPT_DEADLINE_AT = new Date(Date.now() + 70 * 60 * 1_000);
const revokeToken = mock(() => Promise.resolve());
const revokeInstallationToken = mock((octokit: { request: typeof revokeToken }) => {
  void octokit.request("DELETE /installation/token");
  return Promise.resolve(true);
});
const mintInstallationToken = mock(() =>
  Promise.resolve({
    octokit: { request: revokeToken },
    token: "ghs_scoped",
    expiresAt: TOKEN_EXPIRES_AT,
  }),
);
const loggerWarn = mock(() => undefined);
const loggerInfo = mock(() => undefined);
const repoMemoryRows = Array.from({ length: 51 }, (_, index) => ({
  id: crypto.randomUUID(),
  category: "architecture",
  content: `memory-${String(index)}`,
  pinned: false,
}));
const invalidMemory = {
  id: "not-a-uuid",
  category: "secret",
  content: "must be dropped",
  pinned: false,
};
const firstMemory = repoMemoryRows[0];
if (firstMemory === undefined) throw new Error("Expected repo memory fixture");
const getRepoMemory = mock(() =>
  Promise.resolve([firstMemory, invalidMemory, ...repoMemoryRows.slice(1)]),
);
const findLatestForTarget = mock(() => Promise.resolve(null));
const findLatestSucceededForTarget = mock(() => Promise.resolve(null));
const config = {
  appId: "test-app",
  privateKey: "test-key",
  githubPersonalAccessToken: undefined as string | undefined,
  reviewLearningsEnabled: false,
  reviewLearningsRagEnabled: false,
  agentMaxTurns: undefined as number | undefined,
  defaultMaxTurns: 100,
  repoConfigFile: ".github/chrisleekr-bot.yml",
};
const loadRepoPolicy = mock(() =>
  Promise.resolve({ reviewLearnings: { enabled: false }, warning: undefined }),
);
const policyForWorkflow = mock(() => ({}) as Record<string, unknown>);
const toAgentPolicy = mock(() => undefined as undefined | Record<string, unknown>);
const mergeAttemptState = mock(() => Promise.resolve());

function workflowAttempt(
  workflowName: "implement" | "ship" = "implement",
  attemptDeadlineAt = ATTEMPT_DEADLINE_AT,
) {
  const attemptId = crypto.randomUUID();
  return {
    runId: crypto.randomUUID(),
    attemptId,
    runnerId: `workflow-runner:${attemptId}`,
    executionDeliveryId: "delivery-16",
    workflowName,
    attemptDeadlineAt,
  };
}

void mock.module("../../src/config", () => ({ config }));
void mock.module("../../src/db", () => ({ requireDb: (): typeof db => db }));
void mock.module("../../src/logger", () => ({
  logger: {
    info: loggerInfo,
    warn: loggerWarn,
    error: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));
void mock.module("octokit", () => ({
  App: function MockApp(): unknown {
    return { octokit: { rest: { apps: { getRepoInstallation } } } };
  },
}));
void mock.module("../../src/repo-config/effective", () => ({
  loadRepoPolicy,
  policyForWorkflow,
  toAgentPolicy,
}));
void mock.module("../../src/workflows/runs-store", () => ({
  findLatestForTarget,
  findLatestSucceededForTarget,
  mergeAttemptState,
}));
void mock.module("../../src/workflows/tracking-mirror", () => ({
  CONFIG_NOTICE_KEY: "configNotice",
}));
void mock.module("../../src/orchestrator/installation-token", () => ({
  mintInstallationToken,
  revokeInstallationToken,
}));
void mock.module("../../src/orchestrator/repo-knowledge", () => ({ getRepoMemory }));
void mock.module("../../src/orchestrator/review-learnings", () => ({
  loadReviewLearnings: mock(() => Promise.resolve([])),
  searchReviewLearningsByEmbedding: mock(() => Promise.resolve([])),
}));

const { prepareWorkflowRunnerPayload } =
  await import("../../src/orchestrator/workflow-runner-payload");

describe("workflow runner payload", () => {
  beforeEach(() => {
    config.githubPersonalAccessToken = undefined;
    config.agentMaxTurns = undefined;
    findLatestForTarget.mockReset();
    findLatestForTarget.mockResolvedValue(null);
    findLatestSucceededForTarget.mockReset();
    findLatestSucceededForTarget.mockResolvedValue(null);
    loadRepoPolicy.mockReset();
    loadRepoPolicy.mockResolvedValue({ reviewLearnings: { enabled: false }, warning: undefined });
    policyForWorkflow.mockReset();
    policyForWorkflow.mockReturnValue({});
    toAgentPolicy.mockReset();
    toAgentPolicy.mockReturnValue(undefined);
    mergeAttemptState.mockClear();
    loggerInfo.mockClear();
    revokeToken.mockClear();
    revokeInstallationToken.mockClear();
    mintInstallationToken.mockReset();
    mintInstallationToken.mockResolvedValue({
      octokit: { request: revokeToken },
      token: "ghs_scoped",
      expiresAt: TOKEN_EXPIRES_AT,
    });
  });

  it("propagates the scoped installation token expiry", async () => {
    const attempt = {
      runId: "11111111-1111-4111-8111-111111111111",
      attemptId: "22222222-2222-4222-8222-222222222222",
      runnerId: "workflow-runner:22222222-2222-4222-8222-222222222222",
      executionDeliveryId: "delivery-16",
      workflowName: "implement" as const,
      attemptDeadlineAt: ATTEMPT_DEADLINE_AT,
    };

    const payload = await prepareWorkflowRunnerPayload(attempt);

    expect(mintInstallationToken).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: 123, repositoryName: "widgets" }),
    );
    expect(payload.installationToken).toBe("ghs_scoped");
    expect(payload.installationTokenExpiresAt).toBe(TOKEN_EXPIRES_AT);
    expect(payload.attemptDeadlineAt).toBe(ATTEMPT_DEADLINE_AT.toISOString());
    expect(payload.repoMemory).toHaveLength(50);
    expect(payload.repoMemory?.map((row) => row.id)).toEqual(
      repoMemoryRows.slice(0, 50).map((row) => row.id),
    );
    expect(loggerWarn).toHaveBeenCalledWith(
      { owner: "acme", repo: "widgets", dropped: 1, omitted: 1 },
      "Filtered invalid or excess workflow runner repo memory",
    );
  });

  it("rejects a late payload request before minting a token", async () => {
    await expectToReject(
      prepareWorkflowRunnerPayload(
        workflowAttempt("implement", new Date(Date.now() + 59 * 60 * 1_000)),
      ),
      "insufficient lifetime",
    );

    expect(mintInstallationToken).not.toHaveBeenCalled();
  });

  it("revokes and rejects a token whose authoritative expiry crosses the attempt deadline", async () => {
    const attemptDeadlineAt = new Date(Date.now() + 70 * 60 * 1_000);
    mintInstallationToken.mockResolvedValueOnce({
      octokit: { request: revokeToken },
      token: "ghs_unsafe",
      expiresAt: new Date(attemptDeadlineAt.getTime() + 1_000).toISOString(),
    });

    await expectToReject(
      prepareWorkflowRunnerPayload(workflowAttempt("implement", attemptDeadlineAt)),
      "expiry exceeds",
    );

    expect(revokeToken).toHaveBeenCalledWith("DELETE /installation/token");
  });

  it("revokes the minted token when policy loading fails", async () => {
    const policyError = new Error("repository policy unavailable");
    loadRepoPolicy.mockRejectedValueOnce(policyError);

    let caught: unknown;
    try {
      await prepareWorkflowRunnerPayload(workflowAttempt());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(policyError);

    expect(revokeInstallationToken).toHaveBeenCalledTimes(1);
    expect(revokeToken).toHaveBeenCalledWith("DELETE /installation/token");
  });

  it("revokes the minted token when the post-load state write fails", async () => {
    loadRepoPolicy.mockResolvedValueOnce({
      reviewLearnings: { enabled: false },
      warning: "Repository policy was reduced.",
    });
    toAgentPolicy.mockReturnValueOnce({ warning: "Repository policy was reduced." });
    mergeAttemptState.mockRejectedValueOnce(new Error("database unavailable"));

    await expectToReject(prepareWorkflowRunnerPayload(workflowAttempt()), "database unavailable");

    expect(revokeInstallationToken).toHaveBeenCalledTimes(1);
  });

  it("projects only handler-consumed fields from prior workflow state", async () => {
    findLatestSucceededForTarget.mockResolvedValueOnce({
      state: { plan: "## Approved plan", unrelated: "must-not-cross" },
    } as never);
    const implementPayload = await prepareWorkflowRunnerPayload(workflowAttempt());
    expect(implementPayload.priorPlanState).toEqual({ plan: "## Approved plan" });

    const createdAt = new Date("2026-08-23T03:00:00Z");
    findLatestForTarget.mockImplementation((name) =>
      Promise.resolve({
        id: crypto.randomUUID(),
        status: "succeeded",
        state:
          name === "triage"
            ? { recommendedNext: "plan", hidden: "drop" }
            : name === "implement"
              ? { pr_number: 42, branch: "drop" }
              : { hidden: "drop" },
        created_at: createdAt,
      } as never),
    );
    const shipPayload = await prepareWorkflowRunnerPayload(workflowAttempt("ship"));
    expect(shipPayload.shipStepRuns?.triage?.state).toEqual({ recommendedNext: "plan" });
    expect(shipPayload.shipStepRuns?.implement?.state).toEqual({ pr_number: 42 });
    expect(shipPayload.shipStepRuns?.review?.state).toEqual({});
  });

  it("fails closed before token minting in PAT mode", async () => {
    config.githubPersonalAccessToken = "global-pat";
    await expectToReject(
      prepareWorkflowRunnerPayload(workflowAttempt()),
      "do not support GITHUB_PERSONAL_ACCESS_TOKEN",
    );
  });

  it("applies max-turn precedence and strips review-only instructions", async () => {
    const attempt = workflowAttempt();
    loadRepoPolicy.mockResolvedValueOnce({
      reviewLearnings: { enabled: false },
      warning: "Repository policy was reduced.",
    });
    policyForWorkflow.mockReturnValueOnce({ maxTurns: 25 });
    toAgentPolicy.mockReturnValueOnce({
      model: "claude-test",
      instructions: "Review only.",
      pathFilters: ["vendor/**"],
      warning: "Repository policy was reduced.",
    });

    const payload = await prepareWorkflowRunnerPayload(attempt);

    expect(payload.maxTurns).toBe(25);
    expect(payload.policy).toEqual({
      model: "claude-test",
      pathFilters: ["vendor/**"],
      warning: "Repository policy was reduced.",
    });
    expect(mergeAttemptState).toHaveBeenCalledWith(
      { runId: attempt.runId, attemptId: attempt.attemptId },
      {
        configNotice:
          "Repository policy was reduced.\nReview scope reduced by `.github/chrisleekr-bot.yml`: files matching `vendor/**` are excluded.",
      },
    );
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "repo_config.policy_applied",
        owner: "acme",
        repo: "widgets",
        deliveryId: "delivery-16",
        workflow: "implement",
        runId: attempt.runId,
        attemptId: attempt.attemptId,
        model: "claude-test",
        maxTurns: 25,
        pathFilterCount: 1,
        hasInstructions: false,
        warned: true,
      }),
      "Per-repo agent policy applied",
    );
  });
});
