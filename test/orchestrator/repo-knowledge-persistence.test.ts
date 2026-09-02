import { beforeEach, describe, expect, it, mock } from "bun:test";

import { expectToReject } from "../utils/assertions";

const db = mock(() => Promise.resolve([{ repo_owner: "acme", repo_name: "widgets" }]));
const saveRepoLearnings = mock(() => Promise.resolve(1));
const deleteRepoMemories = mock(() => Promise.resolve(1));
const saveReviewLearnings = mock(() => Promise.resolve(1));
const deleteReviewLearnings = mock(() => Promise.resolve(1));
const bumpReviewLearningUsage = mock(() => Promise.resolve());

void mock.module("../../src/config", () => ({ config: { reviewLearningsEnabled: true } }));
void mock.module("../../src/db", () => ({ requireDb: (): typeof db => db }));
void mock.module("../../src/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));
void mock.module("../../src/orchestrator/repo-knowledge", () => ({
  saveRepoLearnings,
  deleteRepoMemories,
}));
void mock.module("../../src/orchestrator/review-learnings", () => ({
  saveReviewLearnings,
  deleteReviewLearnings,
  bumpReviewLearningUsage,
}));

const { persistRepoKnowledge } = await import("../../src/orchestrator/repo-knowledge-persistence");

const actions = {
  learnings: [{ category: "setup" as const, content: "Run isolated tests." }],
  deletions: ["11111111-1111-4111-8111-111111111111"],
  reviewLearningSaves: [{ directive: "Keep tests isolated." }],
  reviewLearningDeletes: ["22222222-2222-4222-8222-222222222222"],
};

describe("repo knowledge persistence", () => {
  beforeEach(() => {
    db.mockReset();
    db.mockResolvedValue([{ repo_owner: "acme", repo_name: "widgets" }]);
    saveRepoLearnings.mockReset();
    saveRepoLearnings.mockResolvedValue(1);
    deleteRepoMemories.mockClear();
    saveReviewLearnings.mockClear();
    deleteReviewLearnings.mockClear();
    bumpReviewLearningUsage.mockClear();
  });

  it("resolves repository ownership and scopes every durable action", async () => {
    await persistRepoKnowledge(
      {
        deliveryId: "delivery-16",
        daemonActions: actions,
        appliedReviewLearningIds: ["learning-1"],
      },
      db as never,
    );

    expect(saveRepoLearnings).toHaveBeenCalledWith("acme", "widgets", actions.learnings, db);
    expect(deleteRepoMemories).toHaveBeenCalledWith("acme", "widgets", actions.deletions, db);
    expect(deleteReviewLearnings).toHaveBeenCalledWith(
      "acme",
      "widgets",
      actions.reviewLearningDeletes,
      db,
    );
    expect(bumpReviewLearningUsage).toHaveBeenCalledWith(["learning-1"], db);
  });

  it("throws for a missing execution row or a load-bearing write failure", async () => {
    db.mockResolvedValueOnce([]);
    await expectToReject(
      persistRepoKnowledge({ deliveryId: "missing", daemonActions: actions }, db as never),
      "Execution row missing",
    );

    saveRepoLearnings.mockRejectedValueOnce(new Error("write failed"));
    await expectToReject(
      persistRepoKnowledge({ deliveryId: "delivery-16", daemonActions: actions }, db as never),
      "write failed",
    );
  });

  it("does not block durable settlement when an approximate usage bump fails", async () => {
    bumpReviewLearningUsage.mockRejectedValueOnce(new Error("usage unavailable"));

    await persistRepoKnowledge(
      {
        deliveryId: "delivery-16",
        appliedReviewLearningIds: ["learning-1"],
      },
      db as never,
    );

    expect(bumpReviewLearningUsage).toHaveBeenCalledWith(["learning-1"], db);
  });
});
