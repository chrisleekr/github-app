/**
 * Surface tests for the daemon-side `scoped-fix-thread` executor (T025).
 * The executor's body becomes a multi-turn Agent SDK invocation in a
 * follow-up; today it posts the maintainer-facing thread reply and
 * returns a structured halt so the orchestrator-side bridge has a
 * deterministic outcome to consume.
 */

import { describe, expect, it, mock } from "bun:test";

import { expectToReject } from "../utils/assertions";

const mockCreateReply = mock(() => Promise.resolve({ data: { id: 9001 } }));
void mock.module("octokit", () => ({
  Octokit: class MockOctokit {
    rest = {
      pulls: {
        createReplyForReviewComment: mockCreateReply,
      },
    };
  },
}));

describe("executeScopedFixThread", () => {
  it("posts a thread reply and reports halted with the reply id", async () => {
    mockCreateReply.mockClear();
    mockCreateReply.mockImplementationOnce(() => Promise.resolve({ data: { id: 9001 } }));
    const { executeScopedFixThread } = await import("../../src/daemon/scoped-fix-thread-executor");

    const outcome = await executeScopedFixThread({
      installationToken: "tok",
      owner: "octo",
      repo: "repo",
      prNumber: 42,
      threadRef: {
        threadId: "thread-1",
        commentId: 7777,
        filePath: "src/foo.ts",
        startLine: 10,
        endLine: 15,
      },
      triggerCommentId: 8888,
    });

    expect(outcome.status).toBe("halted");
    expect(outcome.threadReplyId).toBe(9001);
    expect(mockCreateReply).toHaveBeenCalledTimes(1);
    const args = mockCreateReply.mock.calls[0]?.[0] as
      { body?: string; comment_id?: number } | undefined;
    expect(args?.body).toContain("src/foo.ts:10-15");
    // Reply MUST be posted against threadRef.commentId, never triggerCommentId.
    expect(args?.comment_id).toBe(7777);
  });

  // H2: 4xx from `createReplyForReviewComment` must map to `halted` (with a
  // structured reason), NOT `failed`, operator dashboards must distinguish
  // "user deleted the comment" from "executor crashed."
  it("maps Octokit 4xx errors to halted with a structured reason (H2)", async () => {
    mockCreateReply.mockClear();
    mockCreateReply.mockImplementationOnce(() => {
      const err = Object.assign(new Error("Not Found"), { status: 404 });
      throw err;
    });
    const { executeScopedFixThread } = await import("../../src/daemon/scoped-fix-thread-executor");

    const outcome = await executeScopedFixThread({
      installationToken: "tok",
      owner: "octo",
      repo: "repo",
      prNumber: 42,
      threadRef: {
        threadId: "thread-1",
        commentId: 7777,
        filePath: "src/foo.ts",
        startLine: 10,
        endLine: 15,
      },
      triggerCommentId: 8888,
    });

    expect(outcome.status).toBe("halted");
    expect(outcome.threadReplyId).toBeUndefined();
    expect(outcome.reason).toContain("thread reply failed");
    expect(outcome.reason).toContain("Not Found");
  });

  // H2b: 5xx and transport errors must rethrow so the daemon's outer scoped
  // catch reports `failed` and the orchestrator can retry.
  it("rethrows transient (5xx / no status) errors so the outer catch can mark failed", async () => {
    mockCreateReply.mockClear();
    mockCreateReply.mockImplementationOnce(() => {
      const err = Object.assign(new Error("Server unavailable"), { status: 503 });
      throw err;
    });
    const { executeScopedFixThread } = await import("../../src/daemon/scoped-fix-thread-executor");

    await expectToReject(
      executeScopedFixThread({
        installationToken: "tok",
        owner: "octo",
        repo: "repo",
        prNumber: 42,
        threadRef: {
          threadId: "thread-1",
          commentId: 7777,
          filePath: "src/foo.ts",
          startLine: 10,
          endLine: 15,
        },
        triggerCommentId: 8888,
      }),
      "Server unavailable",
    );
  });
});
