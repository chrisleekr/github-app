/**
 * Dispatch shim from `trigger-router.routeTrigger(...)` (T028a) output to
 * the appropriate handler in `src/workflows/handlers/`. The `ship`
 * intent is wired to `runShipFromCommand` (T028); `stop` / `resume` /
 * `abort` log only until US4 (T058a/b) wires their handlers.
 */

import type { Octokit } from "octokit";
import type { Logger } from "pino";

import { resolveModelId } from "../../ai/llm-client";
import { config } from "../../config";
import { containsTrigger } from "../../core/trigger";
import { logger as rootLogger } from "../../logger";
import { type EffectiveRepoPolicy, loadRepoPolicy } from "../../repo-config/effective";
import { checkRepoGate, type TriggerContext } from "../../repo-config/gate";
import {
  type CanonicalCommand,
  type CanonicalCommandPr,
  type CommandIntent,
  isScopedCommandIntent,
  isShipCommandIntent,
  isWorkflowCommandIntent,
} from "../../shared/ship-types";
import type { WorkflowName } from "../../shared/workflow-types";
import { getTriageLLMClient } from "../../webhook/triage-client-factory";
import { dispatchWorkflowByName } from "../dispatcher";
import { postRefusalComment } from "../tracking-mirror";
import { runLifecycleCommand } from "./lifecycle-commands";
import { dispatchScopedCommand, type ScopedCommandDeps } from "./scoped/dispatch-scoped";
import { runShipFromCommand } from "./session-runner";
import { routeNlTrigger, routeTrigger } from "./trigger-router";

export interface DispatchDeps {
  readonly octokit: Octokit;
  readonly log?: Logger;
  /** Trigger facts for the repo-config filter rules. See `TriggerContext`. */
  readonly trigger?: TriggerContext;
  /**
   * Webhook delivery id, required by `dispatchWorkflowByName` for its
   * idempotent `workflow_runs` insert. The only field the workflow rail needs
   * that the ship rail did not already carry.
   */
  readonly deliveryId: string;
  /**
   * Policy the caller already loaded for this repo. `dispatchCommentSurface`
   * loads one for the pre-classification gate; without threading it, every
   * classified mention paid a second GitHub round trip for the same file.
   */
  readonly repoPolicy?: EffectiveRepoPolicy;
}

/** Which rail a resolved intent lands on. Observability only. */
function railFor(intent: CommandIntent): "ship" | "scoped" | "workflow" {
  if (isShipCommandIntent(intent)) return "ship";
  if (isScopedCommandIntent(intent)) return "scoped";
  return "workflow";
}

/**
 * De-escalating verbs, exempt from Gate 1. If an owner disables the bot
 * while an intent is mid-flight, `stop` and `abort` must still land, or the
 * config change strands the very run it was meant to end.
 *
 * `resume` is deliberately NOT here: it re-starts work, so a repo that has
 * since been disabled should refuse it. An owner who wants a paused session
 * gone still has `abort`.
 *
 * The exemption is narrow. These verbs skip the two enable toggles and the
 * passive trigger filters, not the identity rules, so `allowed_users` and
 * `ignore_authors` still decide who may end a run. See `identityRulesOnly`
 * in `src/repo-config/gate.ts`.
 *
 * Typed as `CommandIntent` so renaming a verb is a compile error rather than
 * a silently stale literal.
 */
const UNGATED_INTENTS: ReadonlySet<CommandIntent> = new Set<CommandIntent>(["stop", "abort"]);

/**
 * Canonical intents that share a name with a registry workflow, so the
 * per-workflow `enabled` rule can be evaluated for them.
 *
 * `ship` and `triage` collide because a rail above owns the word; the five
 * `WORKFLOW_COMMAND_INTENTS` collide because they ARE registry workflows.
 * Missing an entry is a silent bypass, not a type error: the canonical parser
 * runs first in the event handlers and returns before `dispatchByLabel`, so a
 * `bot:triage` label would never see the toggle at all. For the five workflow
 * verbs an entry also saves the cost of a run that `dispatchWorkflowByName`
 * would refuse anyway, and keeps the refusal to exactly one comment.
 * `test/workflows/ship/command-dispatch.test.ts` fails if any `CommandIntent`
 * matching a `WorkflowName` is absent here.
 *
 * Written literally rather than looked up in the registry, which would pull
 * every handler's dependency graph into this module.
 */
export const INTENT_TO_WORKFLOW: Partial<Record<CommandIntent, WorkflowName>> = {
  ship: "ship",
  triage: "triage",
  plan: "plan",
  implement: "implement",
  review: "review",
  resolve: "resolve",
  remember: "remember",
};

/**
 * Gate 1 for the canonical (ship) rail, which bypasses
 * `workflows/dispatcher.ts` entirely and therefore needs its own call.
 *
 * Returns the loaded policy alongside the verdict so the workflow rail can
 * hand it to `dispatchWorkflowByName` instead of paying a second fetch for the
 * per-workflow re-check.
 */
async function isBlockedByRepoConfig(
  command: CanonicalCommand,
  deps: DispatchDeps,
  log: Logger,
): Promise<{ blocked: boolean; policy: EffectiveRepoPolicy }> {
  const policy =
    deps.repoPolicy ??
    (await loadRepoPolicy({
      octokit: deps.octokit,
      owner: command.pr.owner,
      repo: command.pr.repo,
      log,
    }));
  const workflowName = INTENT_TO_WORKFLOW[command.intent];
  const verdict = checkRepoGate({
    policy,
    identityRulesOnly: UNGATED_INTENTS.has(command.intent),
    ...(workflowName !== undefined ? { workflowName } : {}),
    senderLogin: command.principal_login,
    ...(deps.trigger !== undefined ? { trigger: deps.trigger } : {}),
  });
  if (verdict.allowed) return { blocked: false, policy };

  // A deliberate label or literal command that is refused must be answered.
  // Nothing else can speak for it: the event handlers return as soon as the
  // canonical parser yields a command, and `dispatchCommentSurface` returns
  // `true` on the literal branch, so `dispatchByLabel` never runs. Without this
  // the user sees only the 👀 reaction. No double-post for the same reason.
  if (verdict.explain) {
    await postRefusalComment(
      { octokit: deps.octokit, logger: log },
      { owner: command.pr.owner, repo: command.pr.repo, number: command.pr.number },
      workflowName ?? command.intent,
      verdict.reason,
    );
  }

  // `event` overrides the child binding for this line only. `senderLogin` is
  // written explicitly even though the child logger already binds the same
  // value as `principal_login`, so every `repo_config.gate_blocked` line
  // answers "who was refused" under one field name and an operator's triage
  // query needs no per-emitter special case.
  log.info(
    {
      event: "repo_config.gate_blocked",
      reason: verdict.reason,
      explained: verdict.explain,
      senderLogin: command.principal_login,
    },
    "Ship command blocked by repo config",
  );
  return { blocked: true, policy };
}

export function dispatchCanonicalCommand(command: CanonicalCommand, deps: DispatchDeps): void {
  const log = (deps.log ?? rootLogger).child({
    event: "ship.command.dispatched",
    intent: command.intent,
    surface: command.surface,
    principal_login: command.principal_login,
    owner: command.pr.owner,
    repo: command.pr.repo,
    pr_number: command.pr.number,
    installation_id: command.pr.installation_id,
    deadline_ms: command.deadline_ms,
  });

  // Fire-and-forget, matching how every handler below is already launched.
  // The try wraps only the gate, so `routeToHandler` is reachable exactly
  // once on both paths.
  void (async (): Promise<void> => {
    let blocked = false;
    let policy: EffectiveRepoPolicy | undefined;
    try {
      const gate = await isBlockedByRepoConfig(command, deps, log);
      blocked = gate.blocked;
      policy = gate.policy;
    } catch (err) {
      // Fail open: a gate failure must not swallow the command. `policy` stays
      // undefined, so the workflow rail loads its own.
      log.error(
        { event: "repo_config.gate_error", err },
        "repo-config gate threw, dispatching anyway",
      );
    }
    if (!blocked) routeToHandler(command, deps, log, policy);
  })();
}

function routeToHandler(
  command: CanonicalCommand,
  deps: DispatchDeps,
  log: Logger,
  /** Policy the gate already loaded, threaded so rule 2 costs no second fetch. */
  repoPolicy?: EffectiveRepoPolicy,
): void {
  if (command.intent === "ship") {
    void runShipFromCommand({ command, octokit: deps.octokit, log }).catch((err: unknown) => {
      log.error({ err }, "runShipFromCommand threw");
    });
    return;
  }

  if (isShipCommandIntent(command.intent)) {
    // stop / resume / abort (T058, T058b).
    void runLifecycleCommand({ command, octokit: deps.octokit, log }).catch((err: unknown) => {
      log.error({ err }, "runLifecycleCommand threw");
    });
    return;
  }

  if (isScopedCommandIntent(command.intent)) {
    // US5, fan out to the right scoped handler. Each scoped handler
    // is stateless (no `ship_intents` row) and runs to completion in a
    // single agent invocation.
    const scopedDeps: ScopedCommandDeps = { octokit: deps.octokit, log };
    void dispatchScopedCommand(command, scopedDeps).catch((err: unknown) => {
      log.error({ err }, "dispatchScopedCommand threw");
    });
    return;
  }

  if (isWorkflowCommandIntent(command.intent)) {
    // Same primitive the label trigger uses, so a mention and a `bot:<name>`
    // label share one seven-step protocol: context check, prior-output check,
    // label mutex, idempotent insert, durable commit, outbox.
    //
    // Issue-vs-PR comes from `event_surface`, not from a field on the command:
    // `pr.number` carries the issue number on issue surfaces (see
    // `CanonicalCommand`), so the surface is the only honest discriminator.
    const targetType =
      command.event_surface === "issue-comment" || command.event_surface === "issue-label"
        ? "issue"
        : "pr";
    void dispatchWorkflowByName({
      octokit: deps.octokit,
      logger: log,
      workflowName: command.intent,
      target: {
        type: targetType,
        owner: command.pr.owner,
        repo: command.pr.repo,
        number: command.pr.number,
      },
      senderLogin: command.principal_login,
      deliveryId: deps.deliveryId,
      // Bounded like every other producer: this is attacker-authored text that
      // lands in `workflow_runs.trigger_body_preview`, the queue offer, and the
      // daemon payload.
      triggerBodyPreview: command.comment_body?.slice(0, 200) ?? "",
      addRocketReaction: true,
      ...(repoPolicy !== undefined ? { repoPolicy } : {}),
      triggerEventType:
        command.event_surface === "review-comment"
          ? "pull_request_review_comment"
          : "issue_comment",
      ...(command.trigger_comment_id !== undefined
        ? { triggerCommentId: command.trigger_comment_id }
        : {}),
      ...(deps.trigger !== undefined ? { trigger: deps.trigger } : {}),
    }).catch((err: unknown) => {
      log.error({ err }, "dispatchWorkflowByName threw");
    });
    return;
  }

  log.warn("dispatchCanonicalCommand: unrecognised intent (no handler)");
}

/**
 * T028e dispatcher for comment surfaces (issue_comment +
 * pull_request_review_comment). Tries the literal `bot:<verb>` parser
 * first; on no match, falls back to the NL classifier (gated on
 * mention-prefix per FR-025a). Both paths produce a `CanonicalCommand`
 * via `routeTrigger(...)`: the NL classifier MUST NOT run when the
 * literal parser already matched (no double-fire).
 *
 * Returns `true` when canonical routing matched a verb and dispatched
 * a handler; `false` when neither the literal parser nor the NL
 * classifier produced an actionable intent. Callers use the return
 * value to decide whether to fall back to legacy dispatch.
 */
export async function dispatchCommentSurface(input: {
  readonly commentBody: string;
  readonly principal_login: string;
  readonly pr: CanonicalCommandPr;
  /**
   * Per-event-surface eligibility carrier (FR-029..FR-035). When present,
   * it is forwarded verbatim into the canonical command. When absent
   * (legacy callers), per-intent eligibility is not enforced: every
   * 11-verb intent reaches its handler.
   */
  readonly event_surface?: "pr-comment" | "review-comment" | "issue-comment";
  /** Set when the comment originates from a `pull_request_review_comment`. */
  readonly thread_id?: string;
  /**
   * REST id of the triggering comment. Required so conversational
   * handlers (chat-thread) can post replies on the same surface
   * without refetching the comment.
   */
  readonly trigger_comment_id?: number;
  /**
   * Webhook delivery id, forwarded to `dispatchWorkflowByName` for its
   * idempotent `workflow_runs` insert.
   */
  readonly deliveryId: string;
  readonly octokit: Octokit;
  readonly log?: Logger;
  /** Trigger facts for the repo-config filter rules. See `TriggerContext`. */
  readonly trigger?: TriggerContext;
}): Promise<boolean> {
  const deps: DispatchDeps = {
    octokit: input.octokit,
    deliveryId: input.deliveryId,
    ...(input.log ? { log: input.log } : {}),
    ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
  };
  // Wrap parser + classifier in a single guard. The literal parser is
  // synchronous-ish, but `routeTrigger("nl")` makes a remote LLM call which
  // can throw on Bedrock outages. Letting that bubble out of the webhook
  // handler causes 5xx + delivery retries; we log and swallow instead so
  // a transient classifier outage doesn't double-deliver work.
  try {
    // 1. Literal-first.
    const literal = await routeTrigger({
      surface: "literal",
      payload: {
        commentBody: input.commentBody,
        principal_login: input.principal_login,
        pr: input.pr,
        ...(input.event_surface !== undefined ? { event_surface: input.event_surface } : {}),
        ...(input.thread_id !== undefined ? { thread_id: input.thread_id } : {}),
        comment_body: input.commentBody,
        ...(input.trigger_comment_id !== undefined
          ? { trigger_comment_id: input.trigger_comment_id }
          : {}),
      },
    });
    if (literal !== null) {
      dispatchCanonicalCommand(literal, deps);
      return true;
    }

    // Cheap local pre-check, and it must be the SAME predicate the classifier
    // and the 👀 reaction use, or a mention is acknowledged then dropped.
    // Testing it here keeps a disabled repo's ordinary chatter from costing a
    // config fetch and a gate_blocked log line per comment.
    if (!containsTrigger(input.commentBody)) return false;

    // Repo-wide gate, between the two parsers on purpose. The literal parser
    // above is local, so running it first preserves the `stop`/`abort`
    // carve-out. That carve-out covers the literal `bot:stop` /
    // `bot:abort-ship` surface only: an NL-phrased stop reaches the
    // classifier, and the gate
    // blocks it before the intent is known. Ungating the NL path would mean
    // paying an LLM call for every comment in a disabled repo.
    //
    // This branch also owns the user-facing refusal. It used to return `false`
    // and let `dispatchByIntent` re-run the gate and post it; with that path
    // retired, deciding here is the only place left.
    const policy = await loadRepoPolicy({
      octokit: input.octokit,
      owner: input.pr.owner,
      repo: input.pr.repo,
      log: input.log ?? rootLogger,
    });
    const verdict = checkRepoGate({
      policy,
      senderLogin: input.principal_login,
      ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
    });
    if (!verdict.allowed) {
      // Only the three deliberate refusals earn a comment; the four passive
      // `triggers.*` filters stay silent, or every Renovate event would draw a
      // public reply. `explain` is the gate's own split, so honour it rather
      // than re-deriving the rule here.
      if (verdict.explain) {
        await postRefusalComment(
          { octokit: input.octokit, logger: input.log ?? rootLogger },
          { owner: input.pr.owner, repo: input.pr.repo, number: input.pr.number },
          "unknown",
          verdict.reason,
        );
      }
      (input.log ?? rootLogger).info(
        {
          event: "repo_config.gate_blocked",
          reason: verdict.reason,
          explained: verdict.explain,
          owner: input.pr.owner,
          repo: input.pr.repo,
          pr_number: input.pr.number,
          senderLogin: input.principal_login,
        },
        "Comment surface blocked by repo config before NL classification",
      );
      // `true`: this branch has now handled the comment. Returning `false`
      // used to mean "fall through to the legacy rail"; there is none.
      return true;
    }

    // 2. NL classification. Mention-prefix gate (FR-025a) lives in classifier.
    const llm = getTriageLLMClient();
    const modelId = resolveModelId(config.triageModel, llm.provider);
    const callLlm = async (params: {
      systemPrompt: string;
      userPrompt: string;
    }): Promise<string> => {
      const res = await llm.create({
        model: modelId,
        system: params.systemPrompt,
        messages: [{ role: "user", content: params.userPrompt }],
        // Was a hardcoded 256, identical to this default. Named so an operator
        // can widen the classifier budget without a code change.
        maxTokens: config.triageMaxTokens,
      });
      return res.text;
    };

    const nl = await routeNlTrigger({
      commentBody: input.commentBody,
      triggerPhrase: config.triggerPhrase,
      principal_login: input.principal_login,
      pr: input.pr,
      callLlm,
      ...(input.event_surface !== undefined ? { event_surface: input.event_surface } : {}),
      ...(input.thread_id !== undefined ? { thread_id: input.thread_id } : {}),
      comment_body: input.commentBody,
      ...(input.trigger_comment_id !== undefined
        ? { trigger_comment_id: input.trigger_comment_id }
        : {}),
    });

    const log = input.log ?? rootLogger;

    if (nl.kind === "unsupported") {
      log.info(
        {
          event: "nl.intent.resolved",
          intent: "unsupported",
          classified_intent: "unsupported",
          confidence: nl.confidence,
          rail: "refusal",
        },
        "NL intent resolved",
      );
      await postRefusalComment(
        { octokit: input.octokit, logger: log },
        { owner: input.pr.owner, repo: input.pr.repo, number: input.pr.number },
        "unknown",
        "that ask is outside what I can do on this repository",
      );
      return true;
    }

    if (nl.kind === "none") {
      // The model answering `none` for an ask the user meant seriously is the
      // misroute with no other trace, so it earns the same line as every other
      // verdict. `classified: false` means the mention gate declined before any
      // LLM call, which is not a classification and would only add noise.
      if (nl.classified) {
        log.info(
          {
            event: "nl.intent.resolved",
            intent: "none",
            classified_intent: nl.classified_intent,
            confidence: nl.confidence,
            rail: "none",
          },
          "NL intent resolved",
        );
      }
      return false;
    }

    // A workflow verb starts an expensive isolated run, so an uncertain guess
    // is worse than a conversation. Below the threshold, hand it to
    // chat-thread, which can ask rather than assume. Ship and scoped verbs are
    // left alone: `stop` must land even when the model is unsure.
    const command =
      isWorkflowCommandIntent(nl.command.intent) && nl.confidence < config.intentConfidenceThreshold
        ? ({ ...nl.command, intent: "chat-thread" } as CanonicalCommand)
        : nl.command;

    log.info(
      {
        event: "nl.intent.resolved",
        intent: command.intent,
        classified_intent: nl.command.intent,
        confidence: nl.confidence,
        // `event_surface` is deliberately absent: both webhook handlers bind it
        // on the child logger they pass in, and repeating it here emitted the
        // key twice in one JSON line, which is ambiguous to a log collector.
        rail: railFor(command.intent),
      },
      "NL intent resolved",
    );

    // Reuse the policy the pre-classification gate already loaded: the
    // per-workflow re-check reads the same file.
    dispatchCanonicalCommand(command, { ...deps, repoPolicy: policy });
    return true;
  } catch (err) {
    // Pass `err` directly so pino's serializer captures the stack and
    // structured properties; `String(err)` would discard both.
    (input.log ?? rootLogger).error(
      { event: "ship.dispatch_comment_surface_failed", err },
      "ship dispatchCommentSurface threw",
    );
    // Rethrow: the caller already acknowledged the comment with 👀, and its
    // `catch` is what posts the user-facing failure reply. Returning `false`
    // here made that reply unreachable and restored the silent drop.
    throw err;
  }
}
