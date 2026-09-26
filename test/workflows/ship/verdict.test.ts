/**
 * Tests for src/workflows/ship/verdict.ts.
 *
 * Pure-function tests: no I/O. Covers the verdict priority ladder
 * documented in `verdict.ts` JSDoc and the test-fixture matrix from
 * `contracts/probe-graphql-query.md` §"Test fixtures".
 */

import { describe, expect, it } from "bun:test";

import {
  computeVerdict,
  type MergeReadiness,
  type ProbeResponseShape,
} from "../../../src/workflows/ship/verdict";

const HEAD_SHA = "h".repeat(40);
const BASE_SHA = "b".repeat(40);
const BOT_LOGIN = "chrisleekr-bot";

function pr(
  overrides: Partial<NonNullable<NonNullable<ProbeResponseShape["repository"]>["pullRequest"]>>,
): ProbeResponseShape {
  return {
    repository: {
      pullRequest: {
        number: 1,
        isDraft: false,
        state: "OPEN",
        merged: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED",
        baseRefName: "main",
        baseRefOid: BASE_SHA,
        headRefName: "feat/x",
        headRefOid: HEAD_SHA,
        author: { login: "alice" },
        reviewThreads: { nodes: [] },
        commits: {
          nodes: [
            {
              commit: {
                oid: HEAD_SHA,
                committedDate: new Date().toISOString(),
                author: { user: { login: BOT_LOGIN }, email: null },
                statusCheckRollup: { contexts: { nodes: [] } },
              },
            },
          ],
        },
        ...overrides,
      },
    },
  };
}

const SHARED = {
  botAppLogin: BOT_LOGIN,
  botPushedShas: new Set<string>([HEAD_SHA]),
} as const;

function expectReason(v: MergeReadiness, reason: string): void {
  expect(v.ready).toBe(false);
  if (!v.ready) expect(v.reason).toBe(reason as never);
}

describe("computeVerdict", () => {
  it("returns ready when every clause passes", () => {
    const v = computeVerdict({ response: pr({}), ...SHARED });
    expect(v.ready).toBe(true);
    if (v.ready) expect(v.head_sha).toBe(HEAD_SHA);
  });

  it("returns human_took_over when head SHA author is non-bot and bot did not push", () => {
    const otherSha = "x".repeat(40);
    const v = computeVerdict({
      response: pr({
        headRefOid: otherSha,
        commits: {
          nodes: [
            {
              commit: {
                oid: otherSha,
                committedDate: new Date().toISOString(),
                author: { user: { login: "human" }, email: null },
                statusCheckRollup: { contexts: { nodes: [] } },
              },
            },
          ],
        },
      }),
      ...SHARED,
    });
    expectReason(v, "human_took_over");
  });

  it("returns behind_base when mergeable=CONFLICTING", () => {
    const v = computeVerdict({ response: pr({ mergeable: "CONFLICTING" }), ...SHARED });
    expectReason(v, "behind_base");
  });

  it("returns behind_base when mergeStateStatus=BEHIND", () => {
    const v = computeVerdict({ response: pr({ mergeStateStatus: "BEHIND" }), ...SHARED });
    expectReason(v, "behind_base");
  });

  it("returns failing_checks when a required check failed", () => {
    const v = computeVerdict({
      response: pr({
        commits: {
          nodes: [
            {
              commit: {
                oid: HEAD_SHA,
                committedDate: new Date().toISOString(),
                author: { user: { login: BOT_LOGIN }, email: null },
                statusCheckRollup: {
                  contexts: {
                    nodes: [
                      {
                        __typename: "CheckRun",
                        name: "test",
                        conclusion: "FAILURE",
                        status: "COMPLETED",
                        isRequired: true,
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      }),
      ...SHARED,
    });
    expectReason(v, "failing_checks");
    if (!v.ready) expect(v.detail).toMatch(/test/);
  });

  it("returns pending_checks when a required check is queued", () => {
    const v = computeVerdict({
      response: pr({
        commits: {
          nodes: [
            {
              commit: {
                oid: HEAD_SHA,
                committedDate: new Date().toISOString(),
                author: { user: { login: BOT_LOGIN }, email: null },
                statusCheckRollup: {
                  contexts: {
                    nodes: [
                      {
                        __typename: "CheckRun",
                        name: "lint",
                        conclusion: null,
                        status: "QUEUED",
                        isRequired: true,
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      }),
      ...SHARED,
    });
    expectReason(v, "pending_checks");
  });

  it("ignores non-required failing checks", () => {
    const v = computeVerdict({
      response: pr({
        commits: {
          nodes: [
            {
              commit: {
                oid: HEAD_SHA,
                committedDate: new Date().toISOString(),
                author: { user: { login: BOT_LOGIN }, email: null },
                statusCheckRollup: {
                  contexts: {
                    nodes: [
                      {
                        __typename: "CheckRun",
                        name: "non-required",
                        conclusion: "FAILURE",
                        status: "COMPLETED",
                        isRequired: false,
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      }),
      ...SHARED,
    });
    expect(v.ready).toBe(true);
  });

  it("returns mergeable_pending when mergeable=null", () => {
    const v = computeVerdict({ response: pr({ mergeable: null }), ...SHARED });
    expectReason(v, "mergeable_pending");
  });

  it("returns changes_requested for that review decision", () => {
    const v = computeVerdict({
      response: pr({ reviewDecision: "CHANGES_REQUESTED" }),
      ...SHARED,
    });
    expectReason(v, "changes_requested");
  });

  it("returns open_threads for unresolved non-outdated threads", () => {
    const v = computeVerdict({
      response: pr({
        reviewThreads: {
          nodes: [{ id: "t1", isResolved: false, isOutdated: false }],
        },
      }),
      ...SHARED,
    });
    expectReason(v, "open_threads");
  });

  it("ignores resolved or outdated threads", () => {
    const v = computeVerdict({
      response: pr({
        reviewThreads: {
          nodes: [
            { id: "t1", isResolved: true, isOutdated: false },
            { id: "t2", isResolved: false, isOutdated: true },
          ],
        },
      }),
      ...SHARED,
    });
    expect(v.ready).toBe(true);
  });

  it("priority: human_took_over wins over failing_checks", () => {
    const otherSha = "y".repeat(40);
    const v = computeVerdict({
      response: pr({
        headRefOid: otherSha,
        commits: {
          nodes: [
            {
              commit: {
                oid: otherSha,
                committedDate: new Date().toISOString(),
                author: { user: { login: "human" }, email: null },
                statusCheckRollup: {
                  contexts: {
                    nodes: [
                      {
                        __typename: "CheckRun",
                        name: "test",
                        conclusion: "FAILURE",
                        status: "COMPLETED",
                        isRequired: true,
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      }),
      ...SHARED,
    });
    expectReason(v, "human_took_over");
  });

  it("returns human_took_over when the PR is missing from the response", () => {
    const v = computeVerdict({
      response: { repository: { pullRequest: null } },
      ...SHARED,
    });
    expectReason(v, "human_took_over");
  });
});
