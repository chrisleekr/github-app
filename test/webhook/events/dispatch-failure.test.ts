import type {
  IssueCommentEvent,
  IssuesEvent,
  PullRequestEvent,
  PullRequestReviewCommentEvent,
} from "@octokit/webhooks-types";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";

const FIXED_FAILURE_MESSAGE = "Sorry, I couldn't start that workflow. Please try again.";
const rawError = "postgres://user:secret@internal/db";

const testLog = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
  child: mock(function (this: unknown) {
    return this;
  }),
};
void mock.module("../../../src/logger", () => ({
  logger: testLog,
  createChildLogger: mock(() => testLog),
}));

const mockDispatchByLabel = mock((_input: unknown) =>
  Promise.resolve({ status: "dispatched", runId: "run-1", workflowName: "triage" }),
);
const mockDispatchByIntent = mock((_input: unknown) =>
  Promise.resolve({ status: "dispatched", runId: "run-2", workflowName: "triage" }),
);
void mock.module("../../../src/workflows/dispatcher", () => ({
  dispatchByLabel: mockDispatchByLabel,
  dispatchByIntent: mockDispatchByIntent,
  dispatchWorkflowByName: mock(() => Promise.resolve({ status: "ignored", reason: "test" })),
}));

const mockSafePostToGitHub = mock(
  async (input: { body: string; source: string; post: (body: string) => Promise<unknown> }) => {
    await input.post(input.body);
    return { posted: true, matchCount: 0, kinds: [] };
  },
);
void mock.module("../../../src/utils/github-output-guard", () => ({
  safePostToGitHub: mockSafePostToGitHub,
}));

void mock.module("../../../src/core/trigger", () => ({ containsTrigger: (): boolean => true }));
void mock.module("../../../src/webhook/authorize", () => ({
  isOwnerAllowed: (): { allowed: true } => ({ allowed: true }),
}));
void mock.module("../../../src/webhook/idempotency", () => ({
  claimDelivery: (): Promise<boolean> => Promise.resolve(true),
}));
void mock.module("../../../src/db/queries/conversation-store", () => ({
  deleteTarget: mock(() => Promise.resolve()),
  softDeleteComment: mock(() => Promise.resolve()),
  upsertComment: mock(() => Promise.resolve()),
  upsertTarget: mock(() => Promise.resolve()),
}));
void mock.module("../../../src/orchestrator/proposal-poller", () => ({
  runProposalPollOnce: mock(() => Promise.resolve()),
}));
void mock.module("../../../src/utils/reactions", () => ({
  addReaction: mock(() => Promise.resolve()),
}));
void mock.module("../../../src/workflows/ship/command-dispatch", () => ({
  dispatchCanonicalCommand: mock(() => undefined),
  dispatchCommentSurface: mock(() => Promise.resolve(false)),
}));
void mock.module("../../../src/workflows/ship/reactor-bridge", () => ({
  fireReactor: mock(() => undefined),
}));
void mock.module("../../../src/workflows/ship/trigger-router", () => ({
  routeTrigger: mock(() => Promise.resolve(null)),
}));
void mock.module("../../../src/repo-config/effective", () => ({
  loadRepoPolicy: mock(() => Promise.resolve({ enabled: true })),
  policyForWorkflow: (): {
    enabled: boolean;
    auto: boolean;
    extraAllowedTools: never[];
    pathFilters: never[];
  } => ({ enabled: true, auto: false, extraAllowedTools: [], pathFilters: [] }),
}));
void mock.module("../../../src/repo-config/pr-check", () => ({
  runPrConfigCheck: mock(() => Promise.resolve()),
}));
void mock.module("../../../src/webhook/auto-review-guard", () => ({
  computeDiffFingerprint: mock(() => Promise.resolve(null)),
  hasActiveShipIntent: mock(() => Promise.resolve(false)),
  isSelfPush: mock(() => Promise.resolve(false)),
  matchesLastReviewed: mock(() => Promise.resolve(false)),
  recordReviewedFingerprint: mock(() => Promise.resolve()),
}));
void mock.module("../../../src/config", () => ({
  config: { allowedOwners: ["acme"], logLevel: "silent", nodeEnv: "test" },
}));

const { handleIssues } = await import("../../../src/webhook/events/issues");
const { handlePullRequest } = await import("../../../src/webhook/events/pull-request");
const { handleIssueComment } = await import("../../../src/webhook/events/issue-comment");
const { handleReviewComment } = await import("../../../src/webhook/events/review-comment");

const createComment = mock((_input: unknown) => Promise.resolve({ data: { id: 1 } }));
const octokit = { rest: { issues: { createComment } } } as unknown as Octokit;

function issuesPayload(): IssuesEvent {
  return {
    action: "labeled",
    installation: { id: 1 },
    issue: { number: 16, title: "Broken dispatch" },
    label: { name: "bot:triage" },
    repository: { name: "repo", owner: { login: "acme" } },
    sender: { login: "alice" },
  } as unknown as IssuesEvent;
}

function pullRequestPayload(): PullRequestEvent {
  return {
    action: "labeled",
    installation: { id: 1 },
    label: { name: "bot:triage" },
    pull_request: {
      number: 16,
      title: "Broken dispatch",
      draft: false,
      base: { ref: "main" },
      head: { ref: "fix", sha: "a".repeat(40) },
    },
    repository: { name: "repo", owner: { login: "acme" } },
    sender: { login: "alice" },
  } as unknown as PullRequestEvent;
}

function issueCommentPayload(): IssueCommentEvent {
  return {
    action: "created",
    installation: { id: 1 },
    comment: { id: 1601, body: "@chrisleekr-bot triage", user: { login: "alice", type: "User" } },
    issue: { number: 16, title: "Broken dispatch" },
    repository: { name: "repo", owner: { login: "acme" } },
  } as unknown as IssueCommentEvent;
}

function reviewCommentPayload(): PullRequestReviewCommentEvent {
  return {
    action: "created",
    installation: { id: 1 },
    comment: { id: 1602, body: "@chrisleekr-bot triage", user: { login: "alice", type: "User" } },
    pull_request: { number: 16, title: "Broken dispatch", draft: false, base: { ref: "main" } },
    repository: { name: "repo", owner: { login: "acme" } },
  } as unknown as PullRequestReviewCommentEvent;
}

async function flushDispatch(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("user-triggered dispatch failures", () => {
  beforeEach(() => {
    mockDispatchByLabel.mockClear();
    mockDispatchByIntent.mockClear();
    mockSafePostToGitHub.mockClear();
    createComment.mockClear();
    testLog.error.mockClear();
  });

  const cases = [
    {
      surface: "issue label",
      dispatch: mockDispatchByLabel,
      fire: (): void => {
        handleIssues(octokit, issuesPayload(), "delivery-issue-label");
      },
    },
    {
      surface: "pull request label",
      dispatch: mockDispatchByLabel,
      fire: (): void => {
        handlePullRequest(octokit, pullRequestPayload(), "delivery-pr-label");
      },
    },
    {
      surface: "issue mention",
      dispatch: mockDispatchByIntent,
      fire: (): void => {
        handleIssueComment(octokit, issueCommentPayload(), "delivery-issue-mention");
      },
    },
    {
      surface: "review mention",
      dispatch: mockDispatchByIntent,
      fire: (): void => {
        handleReviewComment(octokit, reviewCommentPayload(), "delivery-review-mention");
      },
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.surface} logs the raw failure and posts only the fixed sanitized reply`, async () => {
      testCase.dispatch.mockRejectedValueOnce(new Error(rawError));

      testCase.fire();
      await flushDispatch();

      expect(testLog.error).toHaveBeenCalledTimes(1);
      expect(mockSafePostToGitHub).toHaveBeenCalledTimes(1);
      const safePostInput = mockSafePostToGitHub.mock.calls[0]?.[0];
      expect(safePostInput?.body).toBe(FIXED_FAILURE_MESSAGE);
      expect(safePostInput?.source).toBe("system");
      expect(safePostInput?.body).not.toContain(rawError);
      const loggedError = testLog.error.mock.calls[0]?.[0] as { err?: unknown } | undefined;
      expect(String(loggedError?.err)).toContain(rawError);
      expect(createComment.mock.calls[0]?.[0]).toMatchObject({ body: FIXED_FAILURE_MESSAGE });
    });
  }

  it("contains a GitHub post failure without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      mockDispatchByLabel.mockRejectedValueOnce(new Error(rawError));
      createComment.mockRejectedValueOnce(new Error("GitHub unavailable"));

      handleIssues(octokit, issuesPayload(), "delivery-post-failure");
      await flushDispatch();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockSafePostToGitHub).toHaveBeenCalledTimes(1);
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
