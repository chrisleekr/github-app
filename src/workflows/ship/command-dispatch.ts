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
import { logger as rootLogger } from "../../logger";
import { loadRepoPolicy } from "../../repo-config/effective";
import { checkRepoGate, type TriggerContext } from "../../repo-config/gate";
import {
  type CanonicalCommand,
  type CanonicalCommandPr,
  type CommandIntent,
  isScopedCommandIntent,
  isShipCommandIntent,
} from "../../shared/ship-types";
import type { WorkflowName } from "../../shared/workflow-types";
import { getTriageLLMClient } from "../../webhook/triage-client-factory";
import { postRefusalComment } from "../tracking-mirror";
import { runLifecycleCommand } from "./lifecycle-commands";
import { dispatchScopedCommand, type ScopedCommandDeps } from "./scoped/dispatch-scoped";
import { runShipFromCommand } from "./session-runner";
import { routeTrigger } from "./trigger-router";

export interface DispatchDeps {
  readonly octokit: Octokit;
  readonly log?: Logger;
  /** Trigger facts for the repo-config filter rules. See `TriggerContext`. */
  readonly trigger?: TriggerContext;
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
 * `ship` and `triage` collide today. Missing an entry is a silent bypass,
 * not a type error: the canonical parser runs first in the event handlers
 * and returns before `dispatchByLabel`, which is the only other place rule 2
 * is evaluated, so a `bot:triage` label would never see the toggle at all.
 * `test/workflows/ship/command-dispatch.test.ts` fails if any `CommandIntent`
 * matching a `WorkflowName` is absent here.
 *
 * Written literally rather than looked up in the registry, which would pull
 * every handler's dependency graph into this module.
 */
export const INTENT_TO_WORKFLOW: Partial<Record<CommandIntent, WorkflowName>> = {
  ship: "ship",
  triage: "triage",
};

/**
 * Gate 1 for the canonical (ship) rail, which bypasses
 * `workflows/dispatcher.ts` entirely and therefore needs its own call.
 */
async function isBlockedByRepoConfig(
  command: CanonicalCommand,
  deps: DispatchDeps,
  log: Logger,
): Promise<boolean> {
  const policy = await loadRepoPolicy({
    octokit: deps.octokit,
    owner: command.pr.owner,
    repo: command.pr.repo,
    log,
  });
  const workflowName = INTENT_TO_WORKFLOW[command.intent];
  const verdict = checkRepoGate({
    policy,
    identityRulesOnly: UNGATED_INTENTS.has(command.intent),
    ...(workflowName !== undefined ? { workflowName } : {}),
    senderLogin: command.principal_login,
    ...(deps.trigger !== undefined ? { trigger: deps.trigger } : {}),
  });
  if (verdict.allowed) return false;

  // A deliberate label or literal command that is refused must be answered,
  // same as the dispatcher rail. Nothing else can speak for it: the event
  // handlers return as soon as the canonical parser yields a command, and
  // `dispatchCommentSurface` returns `true` on the literal branch, so
  // `dispatchByLabel` / `dispatchByIntent` never run. Without this the user
  // sees only the 👀 reaction. No double-post for the same reason.
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
  return true;
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
    try {
      blocked = await isBlockedByRepoConfig(command, deps, log);
    } catch (err) {
      // Fail open: a gate failure must not swallow the command.
      log.error(
        { event: "repo_config.gate_error", err },
        "repo-config gate threw, dispatching anyway",
      );
    }
    if (!blocked) routeToHandler(command, deps, log);
  })();
}

function routeToHandler(command: CanonicalCommand, deps: DispatchDeps, log: Logger): void {
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
  readonly octokit: Octokit;
  readonly log?: Logger;
  /** Trigger facts for the repo-config filter rules. See `TriggerContext`. */
  readonly trigger?: TriggerContext;
}): Promise<boolean> {
  const deps: DispatchDeps = {
    octokit: input.octokit,
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

    // Cheap local pre-check, mirroring the classifier's own FR-025a rule
    // (`nl-classifier.ts:86`): a body that does not open with the trigger
    // phrase is returned as `null` there regardless. Testing it here keeps a
    // disabled repo's ordinary chatter from costing a config fetch and a
    // gate_blocked log line per comment. `trimStart`, not `trim`, to match the
    // classifier exactly.
    if (!input.commentBody.trimStart().startsWith(config.triggerPhrase)) return false;

    // Repo-wide gate, between the two parsers on purpose. The literal parser
    // above is local, so running it first preserves the `stop`/`abort`
    // carve-out. That carve-out covers the literal `bot:stop` /
    // `bot:abort-ship` surface only: an NL-phrased stop reaches the
    // classifier, and the gate
    // blocks it before the intent is known. Ungating the NL path would mean
    // paying an LLM call for every comment in a disabled repo.
    //
    // Returns `false`, not `true`: the caller falls through to
    // `dispatchByIntent`, which re-runs the same gate and owns the
    // user-facing refusal comment. Deciding that here would duplicate it.
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
      (input.log ?? rootLogger).info(
        {
          event: "repo_config.gate_blocked",
          reason: verdict.reason,
          explained: false,
          owner: input.pr.owner,
          repo: input.pr.repo,
          pr_number: input.pr.number,
          senderLogin: input.principal_login,
        },
        "Comment surface blocked by repo config before NL classification",
      );
      return false;
    }

    // 2. NL fallback. Mention-prefix gate (FR-025a) lives in classifier.
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
        maxTokens: 256,
      });
      return res.text;
    };

    const nl = await routeTrigger({
      surface: "nl",
      payload: {
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
      },
    });
    if (nl !== null) {
      dispatchCanonicalCommand(nl, deps);
      return true;
    }
    return false;
  } catch (err) {
    // Pass `err` directly so pino's serializer captures the stack and
    // structured properties; `String(err)` would discard both.
    (input.log ?? rootLogger).error(
      { event: "ship.dispatch_comment_surface_failed", err },
      "ship dispatchCommentSurface threw, swallowed",
    );
    return false;
  }
}
