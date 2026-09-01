/**
 * Unit tests for dispatchByLabel: registry-driven label → workflow lookup
 * and the seven-step label-trigger protocol.
 *
 * Downstream surfaces (runs-store, job-queue, label-mutex, tracking-mirror)
 * are mocked: the dispatcher is a pure orchestrator over the registry.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";
import type pino from "pino";

import { expectToReject } from "../utils/assertions";

// ─── Mocked downstream surfaces ──────────────────────────────────────────

const mockEnqueueJob = mock(() => Promise.resolve());
void mock.module("../../src/orchestrator/job-queue", () => ({
  enqueueJob: mockEnqueueJob,
  isScopedJob: () => false,
  SCOPED_JOB_KINDS: ["scoped-rebase", "scoped-fix-thread", "scoped-open-pr"],
}));

const mockRecordWorkflowExecution = mock(() => Promise.resolve());
void mock.module("../../src/workflows/execution-row", () => ({
  recordWorkflowExecution: mockRecordWorkflowExecution,
  buildWorkflowContextJson: mock(() => ({})),
}));

const transaction = {};
const mockDbBegin = mock(async (callback: (sql: unknown) => Promise<unknown>) =>
  callback(transaction),
);
const fakeDb = { begin: mockDbBegin };
void mock.module("../../src/db", () => ({
  getDb: () => fakeDb,
  requireDb: () => fakeDb,
  closeDb: () => Promise.resolve(),
}));

const mockPublishWorkflowRunById = mock(() => Promise.resolve(true));
void mock.module("../../src/workflows/dispatch-outbox", () => ({
  publishWorkflowRunById: mockPublishWorkflowRunById,
  publishPendingWorkflowRuns: mock(() => Promise.resolve(0)),
}));

void mock.module("../../src/orchestrator/concurrency", () => ({
  incrementActiveCount: mock(() => {}),
  decrementActiveCount: mock(() => {}),
}));

const mockEnforceSingleBotLabel = mock(() =>
  Promise.resolve({ kept: "bot:plan", removed: [] as string[] }),
);
void mock.module("../../src/workflows/label-mutex", () => ({
  enforceSingleBotLabel: mockEnforceSingleBotLabel,
}));

const mockInsertQueued = mock(() =>
  Promise.resolve({ id: "00000000-0000-0000-0000-000000000001" }),
);
const mockFindLatestForTarget = mock(() => Promise.resolve(null as unknown));
const mockFindLatestSucceededForTarget = mock(() => Promise.resolve(null as unknown));
const mockFindCommittedWorkflowDispatch = mock(() => Promise.resolve(null as unknown));
const realRunsStore = await import("../../src/workflows/runs-store");
void mock.module("../../src/workflows/runs-store", () => ({
  ...realRunsStore,
  insertQueued: mockInsertQueued,
  findLatestForTarget: mockFindLatestForTarget,
  findLatestSucceededForTarget: mockFindLatestSucceededForTarget,
  findCommittedWorkflowDispatch: mockFindCommittedWorkflowDispatch,
  // findById is imported by review/resolve handlers (transitively reachable
  // when registry resolves them). Provide a stub so module loading succeeds,
  // tests in this file don't exercise that code path.
  findById: mock(async () => Promise.resolve(null)),
}));

const mockPostRefusalComment = mock(() => Promise.resolve());
void mock.module("../../src/workflows/tracking-mirror", () => ({
  postRefusalComment: mockPostRefusalComment,
}));

// Gate 1's config loader. Stubbed rather than left to fail open: `fakeOctokit`
// below is an empty object, so the real `loadRepoPolicy` throws internally and
// degrades to the permissive default, which would let every gate assertion in
// this file pass even if the call site were deleted.
const realEffective = await import("../../src/repo-config/effective");
const { githubAppConfigSchema } = await import("../../src/repo-config/schema");
const mockLoadRepoPolicy = mock(() => Promise.resolve(realEffective.DEFAULT_REPO_POLICY));
void mock.module("../../src/repo-config/effective", () => ({
  ...realEffective,
  loadRepoPolicy: mockLoadRepoPolicy,
}));

// The LLM call `dispatchByIntent` makes after the gate. Mocked so the gate
// tests can assert it was never reached, which is the whole point of gating
// before classification.
const mockClassify = mock(() =>
  Promise.resolve({ workflow: "triage" as const, confidence: 0.99, rationale: "test" }),
);
void mock.module("../../src/workflows/intent-classifier", () => ({
  classify: mockClassify,
}));

// Import dispatcher AFTER mocks.
const { dispatchByIntent, dispatchByLabel, dispatchWorkflowByName } =
  await import("../../src/workflows/dispatcher");

beforeEach(() => {
  mockRecordWorkflowExecution.mockClear();
  mockPublishWorkflowRunById.mockReset();
  mockPublishWorkflowRunById.mockResolvedValue(true);
  mockDbBegin.mockClear();
  mockFindCommittedWorkflowDispatch.mockReset();
  mockFindCommittedWorkflowDispatch.mockResolvedValue(null);
});

// ─── Test fixtures ───────────────────────────────────────────────────────

function silentLog(): pino.Logger {
  const log = {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    child: mock(function (this: unknown) {
      return this;
    }),
  } as unknown as pino.Logger;
  return log;
}

const fakeOctokit = {} as unknown as Octokit;

/** Build a policy from a partial YAML document, exercising the real resolver. */
function policyFrom(doc: Record<string, unknown>): typeof realEffective.DEFAULT_REPO_POLICY {
  return realEffective.resolvePolicy(githubAppConfigSchema.parse({ version: 1, ...doc }));
}

function baseParams(overrides: {
  label: string;
  targetType: "issue" | "pr";
}): Parameters<typeof dispatchByLabel>[0] {
  return {
    octokit: fakeOctokit,
    logger: silentLog(),
    label: overrides.label,
    target: {
      type: overrides.targetType,
      owner: "acme",
      repo: "repo",
      number: 42,
    },
    senderLogin: "alice",
    deliveryId: "delivery-abc",
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("dispatchByLabel", () => {
  beforeEach(() => {
    mockEnqueueJob.mockClear();
    mockEnforceSingleBotLabel.mockClear();
    mockInsertQueued.mockClear();
    mockFindLatestForTarget.mockClear();
    mockFindLatestSucceededForTarget.mockClear();
    mockRecordWorkflowExecution.mockClear();
    mockPublishWorkflowRunById.mockReset();
    mockPublishWorkflowRunById.mockResolvedValue(true);
    mockDbBegin.mockClear();
    mockPostRefusalComment.mockClear();
    mockLoadRepoPolicy.mockClear();
  });

  it("returns ignored for unknown labels without touching any downstream surface", async () => {
    const result = await dispatchByLabel(
      baseParams({ label: "needs-triage", targetType: "issue" }),
    );

    expect(result.status).toBe("ignored");
    if (result.status === "ignored") {
      expect(result.reason).toContain("needs-triage");
    }
    expect(mockEnforceSingleBotLabel).not.toHaveBeenCalled();
    expect(mockInsertQueued).not.toHaveBeenCalled();
    expect(mockPublishWorkflowRunById).not.toHaveBeenCalled();
    expect(mockPostRefusalComment).not.toHaveBeenCalled();
  });

  it("dispatches a known label whose context matches (bot:triage on issue)", async () => {
    const result = await dispatchByLabel(baseParams({ label: "bot:triage", targetType: "issue" }));

    expect(result.status).toBe("dispatched");
    if (result.status === "dispatched") {
      expect(result.workflowName).toBe("triage");
      expect(result.runId).toBe("00000000-0000-0000-0000-000000000001");
    }
    expect(mockEnforceSingleBotLabel).toHaveBeenCalledTimes(1);
    expect(mockInsertQueued).toHaveBeenCalledTimes(1);
    expect(mockRecordWorkflowExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "00000000-0000-0000-0000-000000000001",
        workflowName: "triage",
        sql: transaction,
      }),
    );
    expect(mockPublishWorkflowRunById).toHaveBeenCalledWith("00000000-0000-0000-0000-000000000001");
  });

  it("refuses a known label whose context mismatches (bot:resolve on issue)", async () => {
    const result = await dispatchByLabel(baseParams({ label: "bot:resolve", targetType: "issue" }));

    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.workflowName).toBe("resolve");
      expect(result.reason).toContain("pr");
    }
    expect(mockPostRefusalComment).toHaveBeenCalledTimes(1);
    expect(mockInsertQueued).not.toHaveBeenCalled();
    expect(mockPublishWorkflowRunById).not.toHaveBeenCalled();
  });

  it("refuses when requiresPrior is unsatisfied (bot:plan without a successful triage)", async () => {
    mockFindLatestSucceededForTarget.mockResolvedValueOnce(null);

    const result = await dispatchByLabel(baseParams({ label: "bot:plan", targetType: "issue" }));

    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.workflowName).toBe("plan");
      expect(result.reason).toContain("triage");
    }
    expect(mockFindLatestSucceededForTarget).toHaveBeenCalledTimes(1);
    expect(mockPostRefusalComment).toHaveBeenCalledTimes(1);
    expect(mockInsertQueued).not.toHaveBeenCalled();
    expect(mockPublishWorkflowRunById).not.toHaveBeenCalled();
    expect(mockEnforceSingleBotLabel).not.toHaveBeenCalled();
  });

  it("refuses on insertQueued collision (in-flight run already exists)", async () => {
    const collisionErr = Object.assign(
      new Error("duplicate key value violates unique constraint"),
      {
        code: "ERR_POSTGRES_SERVER_ERROR",
        errno: "23505",
        constraint: "idx_workflow_runs_inflight",
      },
    );
    mockInsertQueued.mockRejectedValueOnce(collisionErr);

    const result = await dispatchByLabel(baseParams({ label: "bot:triage", targetType: "issue" }));

    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.workflowName).toBe("triage");
      expect(result.reason).toContain("in-flight");
    }
    expect(mockPostRefusalComment).toHaveBeenCalledTimes(1);
    expect(mockPostRefusalComment.mock.calls[0]?.[3]).toBe(
      "an in-flight run already exists for this workflow and target",
    );
    expect(mockPublishWorkflowRunById).not.toHaveBeenCalled();
  });

  it("rethrows non-collision insertQueued errors without refusing", async () => {
    mockInsertQueued.mockRejectedValueOnce(new Error("connection reset"));

    await expectToReject(
      dispatchByLabel(baseParams({ label: "bot:triage", targetType: "issue" })),
      "connection reset",
    );

    expect(mockPostRefusalComment).not.toHaveBeenCalled();
    expect(mockPublishWorkflowRunById).not.toHaveBeenCalled();
  });

  it("continues after an ambiguous commit when the exact durable pair exists", async () => {
    mockInsertQueued.mockRejectedValueOnce(new Error("connection lost after commit"));
    mockFindCommittedWorkflowDispatch.mockResolvedValueOnce({
      id: "00000000-0000-0000-0000-000000000099",
    });

    const result = await dispatchByLabel(baseParams({ label: "bot:triage", targetType: "issue" }));

    expect(result).toEqual({
      status: "dispatched",
      runId: "00000000-0000-0000-0000-000000000099",
      workflowName: "triage",
    });
    expect(mockFindCommittedWorkflowDispatch).toHaveBeenCalledWith(
      {
        workflowName: "triage",
        target: { type: "issue", owner: "acme", repo: "repo", number: 42 },
        executionDeliveryId: "delivery-abc",
      },
      fakeDb,
    );
    expect(mockPublishWorkflowRunById).toHaveBeenCalledWith("00000000-0000-0000-0000-000000000099");
    expect(mockPostRefusalComment).not.toHaveBeenCalled();
  });

  it("retains the trigger until an ambiguous commit can be read", async () => {
    mockInsertQueued.mockRejectedValueOnce(new Error("connection lost after commit"));
    mockFindCommittedWorkflowDispatch
      .mockRejectedValueOnce(new Error("database read unavailable"))
      .mockResolvedValueOnce({
        id: "00000000-0000-0000-0000-000000000098",
      });

    const result = await dispatchByLabel(baseParams({ label: "bot:triage", targetType: "issue" }));

    expect(result).toEqual({
      status: "dispatched",
      runId: "00000000-0000-0000-0000-000000000098",
      workflowName: "triage",
    });
    expect(mockFindCommittedWorkflowDispatch).toHaveBeenCalledTimes(2);
    expect(mockPostRefusalComment).not.toHaveBeenCalled();
  });

  it("stops ambiguous-commit reconciliation and surfaces the dispatch failure", async () => {
    mockInsertQueued.mockRejectedValueOnce(new Error("connection lost after commit"));
    mockFindCommittedWorkflowDispatch.mockRejectedValue(new Error("database read unavailable"));

    await expectToReject(
      dispatchByLabel(baseParams({ label: "bot:triage", targetType: "issue" })),
      "connection lost after commit",
    );

    expect(mockFindCommittedWorkflowDispatch).toHaveBeenCalledTimes(8);
    expect(mockPublishWorkflowRunById).not.toHaveBeenCalled();
  });

  it("keeps the durable run pending when queue publication fails", async () => {
    mockPublishWorkflowRunById.mockRejectedValueOnce(new Error("valkey unreachable"));

    const result = await dispatchByLabel(baseParams({ label: "bot:triage", targetType: "issue" }));

    expect(result.status).toBe("dispatched");
    expect(mockPublishWorkflowRunById).toHaveBeenCalledTimes(1);
    expect(mockPostRefusalComment).not.toHaveBeenCalled();
  });
});

// ─── Gate 1 wiring ────────────────────────────────────────────────────────

/**
 * These assert the gate is *called* and its verdict is *honoured*, not the
 * rule semantics themselves (`test/repo-config/gate.test.ts` owns those).
 * Deleting the `applyRepoGate` call from `dispatchByLabel` must fail here.
 */
describe("dispatchByLabel repo-config gate", () => {
  beforeEach(() => {
    mockEnqueueJob.mockClear();
    mockInsertQueued.mockClear();
    mockEnforceSingleBotLabel.mockClear();
    mockPostRefusalComment.mockClear();
    mockLoadRepoPolicy.mockClear();
    mockLoadRepoPolicy.mockResolvedValue(realEffective.DEFAULT_REPO_POLICY);
  });

  it("consults the repo policy on every dispatch", async () => {
    await dispatchByLabel(baseParams({ label: "bot:triage", targetType: "issue" }));
    expect(mockLoadRepoPolicy).toHaveBeenCalledTimes(1);
  });

  it("refuses with a comment when the repo is disabled, before any side effect", async () => {
    mockLoadRepoPolicy.mockResolvedValue({ ...realEffective.DEFAULT_REPO_POLICY, enabled: false });

    const result = await dispatchByLabel(baseParams({ label: "bot:triage", targetType: "issue" }));

    expect(result.status).toBe("refused");
    if (result.status === "refused") expect(result.reason).toContain("disabled");
    // `explain: true`, so the user who applied the label hears why.
    expect(mockPostRefusalComment).toHaveBeenCalledTimes(1);
    // Nothing persisted, nothing queued, no label mutation.
    expect(mockInsertQueued).not.toHaveBeenCalled();
    expect(mockPublishWorkflowRunById).not.toHaveBeenCalled();
    expect(mockEnforceSingleBotLabel).not.toHaveBeenCalled();
  });

  it("refuses silently when a passive trigger filter matches", async () => {
    mockLoadRepoPolicy.mockResolvedValue({
      ...realEffective.DEFAULT_REPO_POLICY,
      triggers: { ...realEffective.DEFAULT_REPO_POLICY.triggers, ignoreAuthors: ["alice"] },
    });

    const result = await dispatchByLabel(baseParams({ label: "bot:triage", targetType: "issue" }));

    expect(result.status).toBe("refused");
    // `explain: false`: a filter set to keep the bot quiet must stay quiet.
    expect(mockPostRefusalComment).not.toHaveBeenCalled();
    expect(mockPublishWorkflowRunById).not.toHaveBeenCalled();
  });

  it("checks ignore_authors before allowed_users, so a bot author stays silent", async () => {
    // Both rules would block. The louder one must not win, or every Renovate
    // event earns a public refusal comment.
    mockLoadRepoPolicy.mockResolvedValue({
      ...realEffective.DEFAULT_REPO_POLICY,
      triggers: {
        ...realEffective.DEFAULT_REPO_POLICY.triggers,
        ignoreAuthors: ["alice"],
        allowedUsers: ["bob"],
      },
    });

    const result = await dispatchByLabel(baseParams({ label: "bot:triage", targetType: "issue" }));

    expect(result.status).toBe("refused");
    expect(mockPostRefusalComment).not.toHaveBeenCalled();
  });

  it("honours a per-workflow disable without affecting other workflows", async () => {
    mockLoadRepoPolicy.mockResolvedValue(policyFrom({ workflows: { triage: { enabled: false } } }));

    const blocked = await dispatchByLabel(baseParams({ label: "bot:triage", targetType: "issue" }));
    expect(blocked.status).toBe("refused");
    if (blocked.status === "refused") expect(blocked.reason).toContain("triage");
    expect(mockPostRefusalComment).toHaveBeenCalledTimes(1);

    // `review` has no entry, so it inherits enabled and still dispatches.
    const allowed = await dispatchByLabel(baseParams({ label: "bot:review", targetType: "pr" }));
    expect(allowed.status).toBe("dispatched");
  });
});

/**
 * `dispatchByIntent` gates before classification, so the assertions here are
 * about what did NOT happen: no LLM call, and no second config fetch.
 */
describe("dispatchByIntent repo-config gate", () => {
  function intentParams(): Parameters<typeof dispatchByIntent>[0] {
    return {
      octokit: fakeOctokit,
      logger: silentLog(),
      commentBody: "@chrisleekr-bot please triage this",
      target: { type: "issue", owner: "acme", repo: "repo", number: 42 },
      senderLogin: "alice",
      deliveryId: "delivery-intent",
      triggerCommentId: 7,
      triggerEventType: "issue_comment",
    };
  }

  beforeEach(() => {
    mockEnqueueJob.mockClear();
    mockInsertQueued.mockClear();
    mockPostRefusalComment.mockClear();
    mockClassify.mockClear();
    mockLoadRepoPolicy.mockClear();
    mockLoadRepoPolicy.mockResolvedValue(realEffective.DEFAULT_REPO_POLICY);
  });

  it("refuses without paying for classification when the repo is disabled", async () => {
    mockLoadRepoPolicy.mockResolvedValue({ ...realEffective.DEFAULT_REPO_POLICY, enabled: false });

    const result = await dispatchByIntent(intentParams());

    expect(result.status).toBe("refused");
    // The gate exists to spend nothing on a repo that opted out.
    expect(mockClassify).not.toHaveBeenCalled();
    expect(mockInsertQueued).not.toHaveBeenCalled();
    expect(mockPublishWorkflowRunById).not.toHaveBeenCalled();
    expect(mockPostRefusalComment).toHaveBeenCalledTimes(1);
  });

  it("refuses silently for a filtered author and still skips the LLM", async () => {
    mockLoadRepoPolicy.mockResolvedValue({
      ...realEffective.DEFAULT_REPO_POLICY,
      triggers: { ...realEffective.DEFAULT_REPO_POLICY.triggers, ignoreAuthors: ["alice"] },
    });

    const result = await dispatchByIntent(intentParams());

    expect(result.status).toBe("refused");
    expect(mockClassify).not.toHaveBeenCalled();
    expect(mockPostRefusalComment).not.toHaveBeenCalled();
  });

  it("loads the policy once and threads it into the per-workflow re-check", async () => {
    const result = await dispatchByIntent(intentParams());

    expect(result.status).toBe("dispatched");
    expect(mockClassify).toHaveBeenCalledTimes(1);
    // One fetch for the pre-classification gate, reused by
    // `dispatchWorkflowByName` for the per-workflow rule. Two would mean the
    // `policy` hand-off regressed to a second REST round trip per comment.
    expect(mockLoadRepoPolicy).toHaveBeenCalledTimes(1);
  });

  it("refuses with the fixed comment for Bun's in-flight collision shape", async () => {
    mockInsertQueued.mockRejectedValueOnce(
      Object.assign(new Error("raw duplicate detail"), {
        code: "ERR_POSTGRES_SERVER_ERROR",
        errno: "23505",
        constraint: "idx_workflow_runs_inflight",
      }),
    );

    const result = await dispatchByIntent(intentParams());

    expect(result).toMatchObject({
      status: "refused",
      workflowName: "triage",
      reason: "an in-flight run already exists for this workflow and target",
      explained: true,
    });
    expect(mockPostRefusalComment.mock.calls[0]?.[3]).toBe(
      "an in-flight run already exists for this workflow and target",
    );
  });

  it("still refuses a disabled workflow once classification names it", async () => {
    mockLoadRepoPolicy.mockResolvedValue(policyFrom({ workflows: { triage: { enabled: false } } }));

    const result = await dispatchByIntent(intentParams());

    expect(result).toMatchObject({ status: "refused", workflowName: "triage", explained: true });
    // The LLM call is still paid: rule 2 cannot fire before the classifier
    // names the workflow. Only rules 1 and 3 to 7 save that cost.
    expect(mockClassify).toHaveBeenCalledTimes(1);
    expect(mockPublishWorkflowRunById).not.toHaveBeenCalled();
    expect(mockPostRefusalComment).toHaveBeenCalledTimes(1);
    // Still one fetch, not two: the post-classification re-check reuses the
    // policy the pre-classification gate already loaded.
    expect(mockLoadRepoPolicy).toHaveBeenCalledTimes(1);
  });
});

// ─── auto-trigger mode (work item #1) ────────────────────────────────────

describe("dispatchWorkflowByName auto mode", () => {
  function autoParams(overrides: Record<string, unknown> = {}) {
    return {
      octokit: fakeOctokit,
      logger: silentLog(),
      workflowName: "review" as const,
      target: { type: "pr" as const, owner: "acme", repo: "widgets", number: 7 },
      senderLogin: "chrisleekr",
      deliveryId: "d-auto",
      triggerBodyPreview: "",
      addRocketReaction: false,
      ...overrides,
    };
  }

  function inflightError(): Error {
    return Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "ERR_POSTGRES_SERVER_ERROR",
      errno: "23505",
      constraint: "idx_workflow_runs_inflight",
    });
  }

  beforeEach(() => {
    mockPostRefusalComment.mockClear();
    mockEnforceSingleBotLabel.mockClear();
    mockInsertQueued.mockClear();
    mockEnqueueJob.mockClear();
    // `mockResolvedValue` persists across suites, so without this the auto-mode
    // cases inherit the last policy the preceding describe set. They pass today
    // only because that policy disables `triage` and these dispatch `review`.
    mockLoadRepoPolicy.mockClear();
    mockLoadRepoPolicy.mockResolvedValue(realEffective.DEFAULT_REPO_POLICY);
  });

  it("stays silent on an in-flight collision", async () => {
    // The whole point of "ignore, do not queue": a push landing mid-review must
    // not narrate itself on the PR.
    mockInsertQueued.mockRejectedValueOnce(inflightError());

    const result = await dispatchWorkflowByName(autoParams({ auto: true }));

    expect(result.status).toBe("refused");
    expect(mockPostRefusalComment).not.toHaveBeenCalled();
  });

  it("still comments on an in-flight collision when not an auto-trigger", async () => {
    // Regression guard for the label/mention callers, who DID ask and deserve
    // an answer.
    mockInsertQueued.mockRejectedValueOnce(inflightError());

    const result = await dispatchWorkflowByName(
      autoParams({ triggerCommentId: 1, triggerEventType: "issue_comment" }),
    );

    expect(result.status).toBe("refused");
    expect(mockPostRefusalComment).toHaveBeenCalledTimes(1);
  });

  it("skips the bot-label mutex, which would strip a user's bot:ship", async () => {
    await dispatchWorkflowByName(autoParams({ auto: true }));
    expect(mockEnforceSingleBotLabel).not.toHaveBeenCalled();
  });

  it("still runs the mutex for a label/mention dispatch", async () => {
    await dispatchWorkflowByName(
      autoParams({ triggerCommentId: 1, triggerEventType: "issue_comment" }),
    );
    expect(mockEnforceSingleBotLabel).toHaveBeenCalledTimes(1);
  });

  it("omits triggerCommentId entirely when the trigger had no comment", async () => {
    // The column is nullable and TriggerEventType has a DB CHECK, so there is no
    // synthetic value to pass; the key must be absent, not undefined.
    await dispatchWorkflowByName(autoParams({ auto: true }));

    const arg = mockInsertQueued.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.hasOwn(arg, "triggerCommentId")).toBe(false);
    expect(Object.hasOwn(arg, "triggerEventType")).toBe(false);
  });

  it("commits the capability preview for durable outbox publication", async () => {
    await dispatchWorkflowByName(
      autoParams({ triggerBodyPreview: "run python in a docker container" }),
    );

    expect(mockInsertQueued.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ triggerBodyPreview: "run python in a docker container" }),
    );
  });

  it("still commits and publishes normally", async () => {
    const result = await dispatchWorkflowByName(autoParams({ auto: true }));
    expect(result.status).toBe("dispatched");
    expect(mockPublishWorkflowRunById).toHaveBeenCalledTimes(1);
  });

  it("suppresses the Gate-1 refusal comment, and reports explained=false", async () => {
    // A repo with `workflows.review.enabled: false` would otherwise be answered
    // on every single push. `explained` must follow: it is the signal a caller
    // uses to decide whether the dispatcher already spoke.
    mockLoadRepoPolicy.mockResolvedValue(policyFrom({ workflows: { review: { enabled: false } } }));

    const result = await dispatchWorkflowByName(autoParams({ auto: true }));

    expect(result.status).toBe("refused");
    if (result.status === "refused") expect(result.explained).toBe(false);
    expect(mockPostRefusalComment).not.toHaveBeenCalled();
  });

  it("still comments on a Gate-1 refusal for a label or mention dispatch", async () => {
    // Regression guard: the suppression must be scoped to auto-triggers only.
    mockLoadRepoPolicy.mockResolvedValue(policyFrom({ workflows: { review: { enabled: false } } }));

    const result = await dispatchWorkflowByName(
      autoParams({ triggerCommentId: 1, triggerEventType: "issue_comment" }),
    );

    expect(result.status).toBe("refused");
    if (result.status === "refused") expect(result.explained).toBe(true);
    expect(mockPostRefusalComment).toHaveBeenCalledTimes(1);
  });

  it("reports explained=false on a silently-dropped in-flight collision", async () => {
    mockInsertQueued.mockRejectedValueOnce(inflightError());

    const result = await dispatchWorkflowByName(autoParams({ auto: true }));

    if (result.status === "refused") expect(result.explained).toBe(false);
  });
});
