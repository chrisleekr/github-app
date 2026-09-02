/**
 * Single source of truth for `ship_intents` lifecycle transitions
 * (T018). Every status transition: pause/resume, terminal transitions
 * (across handlers, abort path, deadline enforcement, iteration cap),
 * MUST go through this module. No inline `UPDATE ship_intents` writes
 * elsewhere in the codebase. This keeps the state-machine contract in
 * one place and makes the full transition graph testable from a single
 * file.
 *
 * State machine (data-model.md §"State machine"):
 *
 *   active ↔ paused                  (FR-011 pause/resume cycle)
 *   active → SessionTerminalState
 *   paused → SessionTerminalState
 *
 * Terminal states are absorbing.
 */

import type { SQL } from "bun";

import { requireDb } from "../../db";
import { isPostgresUniqueViolation } from "../../db/postgres-error";
import {
  appendIteration,
  type AppendIterationInput,
  findActiveIntent as dbFindActiveIntent,
  getIntentById as dbGetIntentById,
  insertIntent as dbInsertIntent,
  type ShipIntentRow,
  type ShipIterationRow,
  transitionIntent as dbTransitionIntent,
} from "../../db/queries/ship";
import { logger } from "../../logger";
import type { BlockerCategory, SessionTerminalState } from "../../shared/ship-types";

export interface CreateIntentInput {
  readonly installation_id: number;
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  readonly target_base_sha: string;
  readonly target_head_sha: string;
  readonly deadline_at: Date;
  readonly created_by_user: string;
  readonly tracking_comment_marker: string;
}

export type CreateIntentResult =
  | { readonly ok: true; readonly intent: ShipIntentRow }
  | {
      readonly ok: false;
      readonly reason: "already_in_progress";
      readonly existing: ShipIntentRow;
    };

export async function createIntent(
  input: CreateIntentInput,
  sql: SQL = requireDb(),
): Promise<CreateIntentResult> {
  try {
    const intent = await dbInsertIntent(input, sql);
    logger.info(
      {
        event: "ship.intent.create",
        intent_id: intent.id,
        owner: input.owner,
        repo: input.repo,
        pr_number: input.pr_number,
      },
      "ship intent created",
    );
    return { ok: true, intent };
  } catch (err: unknown) {
    if (isPostgresUniqueViolation(err, "ship_intents_one_active_per_pr")) {
      const existing = await dbFindActiveIntent(input.owner, input.repo, input.pr_number, sql);
      if (existing !== null) {
        return { ok: false, reason: "already_in_progress", existing };
      }
    }
    throw err;
  }
}

export async function getActiveIntent(
  owner: string,
  repo: string,
  pr_number: number,
  sql: SQL = requireDb(),
): Promise<ShipIntentRow | null> {
  return dbFindActiveIntent(owner, repo, pr_number, sql);
}

export async function getIntentById(
  id: string,
  sql: SQL = requireDb(),
): Promise<ShipIntentRow | null> {
  return dbGetIntentById(id, sql);
}

/**
 * Move an intent to a terminal state. Idempotent: returns null if the
 * intent did not exist or was already terminal.
 */
export async function transitionToTerminal(
  id: string,
  state: SessionTerminalState,
  blockerCategory: BlockerCategory | null,
  sql: SQL = requireDb(),
): Promise<ShipIntentRow | null> {
  const updated = await dbTransitionIntent(id, state, blockerCategory, sql);
  if (updated !== null) {
    logger.info(
      {
        event: "ship.intent.transition",
        intent_id: id,
        to_status: state,
        terminal_blocker_category: blockerCategory,
      },
      "ship intent terminated",
    );
  }
  return updated;
}

/**
 * Pause an active intent (FR-011, non-terminal). Guarded UPDATE
 * prevents stomping a concurrent transition.
 *
 * Returns the updated row, or `null` when the intent was not in
 * `'active'` state at the moment of the UPDATE (no-op).
 */
export async function pauseIntent(
  id: string,
  requestor: string,
  sql: SQL = requireDb(),
): Promise<ShipIntentRow | null> {
  const rows: ShipIntentRow[] = await sql`
    UPDATE ship_intents
       SET status = 'paused', updated_at = now()
     WHERE id = ${id} AND status = 'active'
    RETURNING *
  `;
  const row = rows[0] ?? null;
  if (row !== null) {
    logger.info(
      { event: "ship.intent.transition", intent_id: id, to_status: "paused", requestor },
      "ship intent paused",
    );
  }
  return row;
}

/**
 * Resume a paused intent (FR-011). Guarded UPDATE; does NOT touch the
 * Valkey cancellation flag: that is the orchestrator's responsibility
 * per `contracts/bot-commands.md` §"bot:resume Behavior" step 5.
 */
export async function resumeIntent(
  id: string,
  requestor: string,
  sql: SQL = requireDb(),
): Promise<ShipIntentRow | null> {
  const rows: ShipIntentRow[] = await sql`
    UPDATE ship_intents
       SET status = 'active', updated_at = now()
     WHERE id = ${id} AND status = 'paused'
    RETURNING *
  `;
  const row = rows[0] ?? null;
  if (row !== null) {
    logger.info(
      { event: "ship.intent.transition", intent_id: id, to_status: "active", requestor },
      "ship intent resumed",
    );
  }
  return row;
}

/**
 * Force-transition to `aborted_by_user` when no checkpoint completes
 * within the abort handler's wait window (per `contracts/bot-commands.md`
 * §"bot:abort-ship Behavior" step 4). Three side effects (T060):
 *   1. UPDATE ship_intents to terminal `aborted_by_user`
 *   2. DELETE the ship_continuations row
 *   3. ZREM the intent_id from the `ship:tickle` sorted set
 *
 * (2) and (3) are best-effort: failure does not roll back (1).
 */
export async function forceAbortIntent(
  id: string,
  requestor: string,
  sql: SQL = requireDb(),
): Promise<ShipIntentRow | null> {
  const rows: ShipIntentRow[] = await sql`
    UPDATE ship_intents
       SET status = 'aborted_by_user',
           terminal_blocker_category = 'stopped-by-user',
           terminated_at = now(),
           updated_at = now()
     WHERE id = ${id} AND status IN ('active', 'paused')
    RETURNING *
  `;
  const row = rows[0] ?? null;
  if (row === null) return null;

  // (2) DELETE continuation
  try {
    await sql`DELETE FROM ship_continuations WHERE intent_id = ${id}`;
  } catch (err) {
    logger.warn(
      { err, intent_id: id, event: "ship.force_abort.continuation_delete_failed" },
      "force-abort: continuation row delete failed (best-effort)",
    );
  }

  // (3) ZREM ship:tickle
  try {
    const { getValkeyClient } = await import("../../orchestrator/valkey");
    const valkey = getValkeyClient();
    if (valkey !== null) {
      const { TICKLE_KEY } = await import("./webhook-reactor");
      await valkey.send("ZREM", [TICKLE_KEY, id]);
    }
  } catch (err) {
    logger.warn(
      { err, intent_id: id, event: "ship.force_abort.tickle_zrem_failed" },
      "force-abort: tickle ZREM failed (best-effort)",
    );
  }

  logger.info(
    {
      event: "ship.intent.transition",
      intent_id: id,
      to_status: "aborted_by_user",
      terminal_blocker_category: "stopped-by-user",
      requestor,
    },
    "ship intent force-aborted",
  );
  return row;
}

/**
 * Update `target_base_sha` in place after a cascade base-ref change
 * (Q2-round1). Leaves `deadline_at` and `spent_usd` unchanged.
 */
export async function resyncBaseSha(
  id: string,
  newBaseSha: string,
  sql: SQL = requireDb(),
): Promise<ShipIntentRow | null> {
  const rows: ShipIntentRow[] = await sql`
    UPDATE ship_intents
       SET target_base_sha = ${newBaseSha}, updated_at = now()
     WHERE id = ${id} AND status IN ('active', 'paused')
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function recordIteration(
  input: AppendIterationInput,
  sql: SQL = requireDb(),
): Promise<ShipIterationRow> {
  return appendIteration(input, sql);
}
