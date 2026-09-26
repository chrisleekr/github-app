/**
 * Surface tests for the daemon-side `scoped-open-pr` executor (T027).
 * The full clone + Agent SDK + createPullRequest path lands as a
 * follow-up; today's test asserts the maintainer-facing reply on the
 * originating issue carries the policy-layer verdictSummary verbatim.
 */

import { describe, expect, it, mock } from "bun:test";

const mockCreateComment = mock(() => Promise.resolve({ data: { id: 9003 } }));
void mock.module("octokit", () => ({
  Octokit: class MockOctokit {
    rest = {
      issues: {
        createComment: mockCreateComment,
      },
    };
  },
}));

describe("executeScopedOpenPr", () => {
  it("posts a maintainer-visible reply on the originating issue and reports halted", async () => {
    mockCreateComment.mockClear();
    const { executeScopedOpenPr } = await import("../../src/daemon/scoped-open-pr-executor");

    const outcome = await executeScopedOpenPr({
      installationToken: "tok",
      owner: "octo",
      repo: "repo",
      issueNumber: 1234,
      triggerCommentId: 5555,
      verdictSummary: "Add caching layer\n\nclassifier: feature (actionable)",
    });

    expect(outcome.status).toBe("halted");
    expect(outcome.reason).toContain("agent-sdk invocation");
    expect(mockCreateComment).toHaveBeenCalledTimes(1);
    const args = mockCreateComment.mock.calls[0]?.[0] as
      { issue_number?: number; body?: string } | undefined;
    expect(args?.issue_number).toBe(1234);
    expect(args?.body).toContain("Add caching layer");
  });
});
