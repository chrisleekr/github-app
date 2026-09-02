import type { SQL } from "bun";

import { config } from "../config";
import { requireDb } from "../db";
import { logger } from "../logger";

interface RepoKnowledgeActions {
  readonly learnings: readonly {
    readonly category: string;
    readonly content: string;
  }[];
  readonly deletions: readonly string[];
  readonly reviewLearningSaves?:
    | readonly {
        readonly directive: string;
        readonly rationale?: string | undefined;
        readonly fileGlob?: string | undefined;
        readonly scope?: "local" | "global" | undefined;
        readonly sourcePr?: number | undefined;
        readonly sourceThread?: string | undefined;
        readonly sourceAuthor?: string | undefined;
      }[]
    | undefined;
  readonly reviewLearningDeletes?: readonly string[] | undefined;
}

export async function persistRepoKnowledge(
  input: {
    readonly deliveryId: string;
    readonly daemonActions?: RepoKnowledgeActions;
    readonly appliedReviewLearningIds?: readonly string[];
  },
  db: SQL = requireDb(),
): Promise<void> {
  const rows: { repo_owner: string; repo_name: string }[] = await db`
    SELECT repo_owner, repo_name FROM executions WHERE delivery_id = ${input.deliveryId}
  `;
  const execution = rows[0];
  if (execution === undefined) {
    throw new Error(`Execution row missing for repo knowledge: ${input.deliveryId}`);
  }

  const actions = input.daemonActions;
  if (actions !== undefined && actions.learnings.length > 0) {
    const { saveRepoLearnings } = await import("./repo-knowledge");
    const saved = await saveRepoLearnings(
      execution.repo_owner,
      execution.repo_name,
      actions.learnings,
      db,
    );
    if (saved > 0) logger.info({ deliveryId: input.deliveryId, saved }, "Persisted repo learnings");
  }
  if (actions !== undefined && actions.deletions.length > 0) {
    const { deleteRepoMemories } = await import("./repo-knowledge");
    const deleted = await deleteRepoMemories(
      execution.repo_owner,
      execution.repo_name,
      actions.deletions,
      db,
    );
    if (deleted > 0)
      logger.info({ deliveryId: input.deliveryId, deleted }, "Deleted repo memories");
  }

  if (actions?.reviewLearningSaves !== undefined && actions.reviewLearningSaves.length > 0) {
    if (config.reviewLearningsEnabled) {
      const { saveReviewLearnings } = await import("./review-learnings");
      const saved = await saveReviewLearnings(
        execution.repo_owner,
        execution.repo_name,
        actions.reviewLearningSaves,
        db,
      );
      if (saved > 0) {
        logger.info({ deliveryId: input.deliveryId, saved }, "Persisted review learnings");
      }
    } else {
      logger.warn(
        { deliveryId: input.deliveryId, dropped: actions.reviewLearningSaves.length },
        "Dropped review-learning saves: REVIEW_LEARNINGS_ENABLED=false",
      );
    }
  }

  if (actions?.reviewLearningDeletes !== undefined && actions.reviewLearningDeletes.length > 0) {
    if (config.reviewLearningsEnabled) {
      const { deleteReviewLearnings } = await import("./review-learnings");
      const deleted = await deleteReviewLearnings(
        execution.repo_owner,
        execution.repo_name,
        actions.reviewLearningDeletes,
        db,
      );
      if (deleted > 0) {
        logger.info({ deliveryId: input.deliveryId, deleted }, "Deleted review learnings");
      }
    } else {
      logger.warn(
        { deliveryId: input.deliveryId, dropped: actions.reviewLearningDeletes.length },
        "Dropped review-learning deletes: REVIEW_LEARNINGS_ENABLED=false",
      );
    }
  }

  if (
    config.reviewLearningsEnabled &&
    input.appliedReviewLearningIds !== undefined &&
    input.appliedReviewLearningIds.length > 0
  ) {
    try {
      // Usage is approximate and must not make durable result settlement fail.
      const { bumpReviewLearningUsage } = await import("./review-learnings");
      await bumpReviewLearningUsage(input.appliedReviewLearningIds, db);
      logger.info(
        { deliveryId: input.deliveryId, applied: input.appliedReviewLearningIds.length },
        "Bumped use_count for applied review learnings",
      );
    } catch (err) {
      logger.warn(
        { err, deliveryId: input.deliveryId },
        "Failed to bump approximate review-learning usage",
      );
    }
  }
}
