/**
 * Trigger router (T028a / FR-027). Single entry point producing the
 * `CanonicalCommand` record from any of the three trigger surfaces.
 * Returns `null` for non-actionable inputs.
 *
 * The `surface` field on the canonical record exists for observability
 * (FR-016) only: eligibility, authorisation, and routing MUST NOT
 * read it.
 */

import {
  type CanonicalCommand,
  type CanonicalCommandPr,
  type EventSurface,
  isIntentEligibleOnSurface,
  type TriggerSurface,
} from "../../shared/ship-types";
import { parseLabelTrigger } from "./label-trigger";
import { parseLiteralCommand } from "./literal-command";
import { classifyComment, toCommandIntent } from "./nl-classifier";

interface BasePayload {
  readonly principal_login: string;
  readonly pr: CanonicalCommandPr;
  /**
   * Webhook event surface where the trigger fired. Required for scoped
   * commands so per-intent eligibility (FR-029..FR-035) can be enforced.
   */
  readonly event_surface?: EventSurface;
  /** Set when the trigger originated from a `pull_request_review_comment` event. */
  readonly thread_id?: string;
  /**
   * Body of the triggering comment. Forwarded onto `CanonicalCommand`
   * for conversational handlers (chat-thread). Absent for label
   * triggers.
   */
  readonly comment_body?: string;
  /**
   * REST id of the triggering comment. Forwarded onto `CanonicalCommand`
   * for conversational handlers. Absent for label triggers.
   */
  readonly trigger_comment_id?: number;
}

export interface LiteralPayload extends BasePayload {
  readonly commentBody: string;
}

export interface LabelPayload extends BasePayload {
  readonly label_name: string;
}

export interface NLPayload extends BasePayload {
  readonly commentBody: string;
  readonly triggerPhrase: string;
  readonly callLlm: (input: { systemPrompt: string; userPrompt: string }) => Promise<string>;
}

export type RouteInput =
  | { readonly surface: "literal"; readonly payload: LiteralPayload }
  | { readonly surface: "label"; readonly payload: LabelPayload }
  | { readonly surface: "nl"; readonly payload: NLPayload };

function withSurface(
  parsed: { intent: CanonicalCommand["intent"]; deadline_ms?: number },
  surface: TriggerSurface,
  payload: BasePayload,
): CanonicalCommand | null {
  // Per-intent eligibility (FR-029..FR-035), scoped verbs reject events
  // outside their declared surface set. Ship-lifecycle verbs are accepted
  // on every PR-attached surface; the eligibility map encodes both.
  if (
    payload.event_surface !== undefined &&
    !isIntentEligibleOnSurface(parsed.intent, payload.event_surface)
  ) {
    return null;
  }
  const base = {
    intent: parsed.intent,
    surface,
    principal_login: payload.principal_login,
    pr: payload.pr,
  };
  const withDeadline =
    parsed.deadline_ms === undefined ? base : { ...base, deadline_ms: parsed.deadline_ms };
  const withEventSurface =
    payload.event_surface === undefined
      ? withDeadline
      : { ...withDeadline, event_surface: payload.event_surface };
  const withThread =
    payload.thread_id === undefined
      ? withEventSurface
      : { ...withEventSurface, thread_id: payload.thread_id };
  const withCommentBody =
    payload.comment_body === undefined
      ? withThread
      : { ...withThread, comment_body: payload.comment_body };
  const final =
    payload.trigger_comment_id === undefined
      ? withCommentBody
      : { ...withCommentBody, trigger_comment_id: payload.trigger_comment_id };
  return final;
}

/**
 * NL routing outcome. Richer than `CanonicalCommand | null` because the
 * caller now owns two verdicts the classifier can return but no handler can
 * execute: `unsupported` earns a refusal comment (FR-010), and `confidence`
 * decides whether a workflow verb is trusted or handed to the conversational
 * executor instead. Collapsing both to `null`, as this used to, is what made
 * a misroute indistinguishable from silence.
 */
export type NlRouteResult =
  | { readonly kind: "command"; readonly command: CanonicalCommand; readonly confidence: number }
  | { readonly kind: "unsupported" }
  | { readonly kind: "none" };

export async function routeNlTrigger(payload: NLPayload): Promise<NlRouteResult> {
  const result = await classifyComment({
    commentBody: payload.commentBody,
    triggerPhrase: payload.triggerPhrase,
    callLlm: payload.callLlm,
    ...(payload.event_surface !== undefined ? { eventSurface: payload.event_surface } : {}),
  });
  // `null` means the mention-prefix gate declined before any LLM call.
  if (result === null) return { kind: "none" };
  if (result.intent === "unsupported") return { kind: "unsupported" };
  const intent = toCommandIntent(result.intent);
  if (intent === null) return { kind: "none" };
  const parsed =
    result.deadline_ms === undefined ? { intent } : { intent, deadline_ms: result.deadline_ms };
  const command = withSurface(parsed, "nl", payload);
  if (command === null) return { kind: "none" };
  return { kind: "command", command, confidence: result.confidence };
}

export async function routeTrigger(input: RouteInput): Promise<CanonicalCommand | null> {
  if (input.surface === "literal") {
    const parsed = parseLiteralCommand(input.payload.commentBody);
    if (parsed === null) return null;
    return withSurface(parsed, "literal", input.payload);
  }
  if (input.surface === "label") {
    const parsed = parseLabelTrigger(input.payload.label_name);
    if (parsed === null) return null;
    return withSurface(parsed, "label", input.payload);
  }
  const nl = await routeNlTrigger(input.payload);
  return nl.kind === "command" ? nl.command : null;
}
