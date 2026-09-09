import { z } from "zod";

/**
 * Terminal session states for a `ship_intents` row. A session in any of
 * these states is finished: `terminated_at` is set, no further reactor
 * fan-out, no further iterations. The Postgres `ship_intents.status`
 * CHECK constraint is the union of these values plus the non-terminal
 * `'active'` and `'paused'` (FR-011 pause/resume cycle); see migration
 * `008_ship_intents.sql` (T005).
 *
 * `SessionStatus` (the full enum stored in the column) lives alongside
 * this list so consumers do not have to re-derive it.
 */
export const SESSION_TERMINAL_STATES = [
  "merged_externally",
  "ready_awaiting_human_merge",
  "deadline_exceeded",
  "human_took_over",
  "aborted_by_user",
  "pr_closed",
] as const;

export type SessionTerminalState = (typeof SESSION_TERMINAL_STATES)[number];

export const SessionTerminalStateSchema = z.enum(SESSION_TERMINAL_STATES);

export function isSessionTerminalState(value: unknown): value is SessionTerminalState {
  return (
    typeof value === "string" && (SESSION_TERMINAL_STATES as readonly string[]).includes(value)
  );
}

/**
 * Full status enum for `ship_intents.status`: the terminal states above
 * plus the two non-terminal in-flight states `'active'` (currently
 * iterating or waiting) and `'paused'` (FR-011 pause/resume cycle,
 * non-terminal, can transition back to `'active'`).
 */
export const SESSION_STATUSES = ["active", "paused", ...SESSION_TERMINAL_STATES] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const SessionStatusSchema = z.enum(SESSION_STATUSES);

/**
 * Reason why the bot handed control back to a human on a terminal
 * `human_took_over` intent. Stored on `ship_intents.terminal_blocker_category`
 * (NULL when the terminal state is self-explanatory, e.g. `deadline_exceeded`).
 *
 * Mapping from terminal state to required category lives in
 * `src/workflows/handlers/ship.ts` (T046).
 */
export const BLOCKER_CATEGORIES = [
  "design-discussion-needed",
  "manual-push-detected",
  "iteration-cap",
  "flake-cap",
  "merge-conflict-needs-human",
  "permission-denied",
  "stopped-by-user",
  "unrecoverable-error",
] as const;

export type BlockerCategory = (typeof BLOCKER_CATEGORIES)[number];

export const BlockerCategorySchema = z.enum(BLOCKER_CATEGORIES);

export function isBlockerCategory(value: unknown): value is BlockerCategory {
  return typeof value === "string" && (BLOCKER_CATEGORIES as readonly string[]).includes(value);
}

// ─── Trigger surfaces (FR-018, FR-025/025a, FR-026/026a, FR-027) ─────────────

export const TRIGGER_SURFACES = ["literal", "nl", "label"] as const;
export type TriggerSurface = (typeof TRIGGER_SURFACES)[number];
export const TriggerSurfaceSchema = z.enum(TRIGGER_SURFACES);

/**
 * The four ship-lifecycle verbs (FR-018, FR-027): these write a
 * `ship_intents` session row and drive the long-running shepherding
 * pipeline.
 */
export const SHIP_COMMAND_INTENTS = ["ship", "stop", "resume", "abort"] as const;
export type ShipCommandIntent = (typeof SHIP_COMMAND_INTENTS)[number];

/**
 * The seven scoped verbs (FR-029..FR-035): stateless one-shot actions
 * that do NOT consume a `ship_intents` session row. Each runs to
 * completion in a single agent invocation and exits.
 */
export const SCOPED_COMMAND_INTENTS = [
  "fix-thread",
  "chat-thread",
  "summarize",
  "rebase",
  "investigate",
  "triage",
  "open-pr",
] as const;
export type ScopedCommandIntent = (typeof SCOPED_COMMAND_INTENTS)[number];

/**
 * Registry workflows reachable by mention, dispatched through
 * `dispatchWorkflowByName` (the same primitive the label trigger uses).
 *
 * `ship` and `triage` are absent on purpose: both words already belong to a
 * rail above, and the existing handler keeps them so no mention that works
 * today changes meaning.
 */
export const WORKFLOW_COMMAND_INTENTS = [
  "plan",
  "implement",
  "review",
  "resolve",
  "remember",
] as const;
export type WorkflowCommandIntent = (typeof WORKFLOW_COMMAND_INTENTS)[number];

/** Union of all 16 verbs the bot recognises. */
export const COMMAND_INTENTS = [
  ...SHIP_COMMAND_INTENTS,
  ...SCOPED_COMMAND_INTENTS,
  ...WORKFLOW_COMMAND_INTENTS,
] as const;
export type CommandIntent = (typeof COMMAND_INTENTS)[number];
export const CommandIntentSchema = z.enum(COMMAND_INTENTS);

export function isShipCommandIntent(value: CommandIntent): value is ShipCommandIntent {
  return (SHIP_COMMAND_INTENTS as readonly string[]).includes(value);
}

export function isScopedCommandIntent(value: CommandIntent): value is ScopedCommandIntent {
  return (SCOPED_COMMAND_INTENTS as readonly string[]).includes(value);
}

export function isWorkflowCommandIntent(value: CommandIntent): value is WorkflowCommandIntent {
  return (WORKFLOW_COMMAND_INTENTS as readonly string[]).includes(value);
}

/**
 * Webhook event surface where the trigger fired. Each scoped command
 * declares which surfaces it accepts (FR-029..FR-035); the classifier
 * MUST return `'none'` when the actual event surface does not match
 * the intent's declared eligibility.
 */
export const EVENT_SURFACES = [
  "pr-comment",
  "review-comment",
  "issue-comment",
  "pr-label",
  "issue-label",
] as const;
export type EventSurface = (typeof EVENT_SURFACES)[number];
export const EventSurfaceSchema = z.enum(EVENT_SURFACES);

/** Per-intent eligibility: which event surfaces may trigger each intent. */
export const INTENT_ELIGIBLE_SURFACES: Record<CommandIntent, readonly EventSurface[]> = {
  ship: ["pr-comment", "review-comment", "pr-label"],
  stop: ["pr-comment", "review-comment", "pr-label"],
  resume: ["pr-comment", "review-comment", "pr-label"],
  abort: ["pr-comment", "review-comment", "pr-label"],
  "fix-thread": ["review-comment"],
  // chat-thread is the general conversational executor, eligible on
  // every comment surface so the bot can engage on review threads,
  // top-level PR comments, and issue comments alike. Issue and PR
  // labels are intentionally excluded, labels are imperative, not
  // conversational.
  "chat-thread": ["review-comment", "pr-comment", "issue-comment"],
  summarize: ["pr-comment", "review-comment", "pr-label"],
  rebase: ["pr-comment", "review-comment", "pr-label"],
  investigate: ["issue-comment", "issue-label"],
  triage: ["issue-comment", "issue-label"],
  "open-pr": ["issue-comment", "issue-label"],
  // Registry workflows, surfaces taken from each entry's `context` in
  // `src/workflows/registry.ts`. Label surfaces are excluded on purpose:
  // `bot:review` and friends already dispatch through `dispatchByLabel`, so
  // listing them here would turn one webhook into two runs. This map is a
  // cheap pre-filter, not a second source of truth: `dispatchWorkflowByName`
  // still owns the authoritative `context` and `requiresPrior` checks.
  plan: ["issue-comment"],
  implement: ["issue-comment"],
  review: ["pr-comment", "review-comment"],
  resolve: ["pr-comment", "review-comment"],
  remember: ["pr-comment", "review-comment", "issue-comment"],
};

export function isIntentEligibleOnSurface(intent: CommandIntent, surface: EventSurface): boolean {
  return INTENT_ELIGIBLE_SURFACES[intent].includes(surface);
}

export interface CanonicalCommandPr {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly installation_id: number;
}

/**
 * The single canonical record produced by `trigger-router.routeTrigger(...)`
 * every downstream handler reads commands in this shape regardless of
 * which surface (literal comment, natural-language, or GitHub label) the
 * maintainer used. The `surface` field exists for observability (FR-016)
 * only and MUST NOT influence eligibility, authorisation, or routing.
 *
 * For issue-targeted scoped commands (`investigate`, `triage`, `open-pr`),
 * `pr.number` carries the issue number: the `pr` field is the
 * conversation-context target regardless of GitHub's PR-vs-Issue
 * distinction, mirroring the unified `issue_comment` event surface.
 *
 * `event_surface` carries the per-event-type origin so per-intent
 * eligibility (FR-029..FR-035) can be enforced downstream.
 *
 * `thread_id` is set only when the trigger originated from a
 * `pull_request_review_comment` event. **Identifier semantics**: it
 * carries the REST `payload.comment.id` (numeric, stringified): the
 * originating review-comment id, NOT the GraphQL
 * `PullRequestReviewThread` node ID. Downstream handlers that need to
 * resolve the parent review-thread node ID (e.g., the `fix-thread`
 * MCP `resolveReviewThread` mutation) MUST resolve it at execution
 * time via GraphQL (`pullRequestReviewThread` lookup keyed on the
 * comment) rather than treating `thread_id` as a node ID. Carrying
 * the REST id avoids paying a GraphQL round-trip on every
 * review-comment webhook delivery, including comments that don't
 * trigger a scoped command.
 */
export interface CanonicalCommand {
  readonly intent: CommandIntent;
  readonly deadline_ms?: number;
  readonly surface: TriggerSurface;
  readonly event_surface?: EventSurface;
  readonly thread_id?: string;
  readonly principal_login: string;
  readonly pr: CanonicalCommandPr;
  /**
   * Body of the comment that triggered the canonical command. Set on
   * comment surfaces (literal + NL); absent for label triggers. Carried
   * here so conversational handlers (chat-thread) don't have to refetch.
   */
  readonly comment_body?: string;
  /**
   * REST id of the triggering comment (always `payload.comment.id`).
   * Set on comment surfaces. NOTE: this differs from `thread_id` on
   * review-comment replies: `thread_id` resolves to the top-level
   * comment via `payload.comment.in_reply_to_id ?? payload.comment.id`
   * so the cache and chat_proposals row scope to the thread root, not
   * the individual reply. The two ids only coincide when the comment
   * itself starts a thread.
   */
  readonly trigger_comment_id?: number;
}
