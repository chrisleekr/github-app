/**
 * Gate 1: the pre-dispatch decision on whether the bot acts at all.
 *
 * Called from the dispatch chokepoints before any `workflow_runs` row, label
 * mutex, queue job, or tracking comment exists, so a blocked trigger leaves
 * nothing behind but a log line.
 *
 * **Narrowing only.** Every rule here can refuse; none can permit. The
 * `ALLOWED_OWNERS` env allowlist already ran in the webhook handler and a
 * repo that failed it never reaches this function, so no YAML value can
 * readmit it. `gate.test.ts` asserts that property directly.
 *
 * `explain` splits deliberate refusals from passive filters. An explicit
 * label or mention deserves a reply saying why nothing happened; a filter
 * the owner configured to keep the bot quiet (bot authors, draft PRs) must
 * stay quiet, or the filter defeats itself.
 */

import type { WorkflowName } from "../shared/workflow-types";
import { type EffectiveRepoPolicy, policyForWorkflow } from "./effective";

/**
 * The trigger facts rules 5 to 7 need. All optional: a caller that does not
 * have a field (a composite child dispatch, whose parent already evaluated
 * these) skips the rule rather than guessing.
 *
 * Kept separate from `DispatchTarget` on purpose. `target` is persisted to
 * `workflow_runs` and logged on every dispatch line; `title` is
 * attacker-controlled free text and does not belong in either.
 */
export interface TriggerContext {
  readonly title?: string | undefined;
  // Explicit `| undefined`: the webhook payload types mark `draft` optional on
  // some PR shapes, and under exactOptionalPropertyTypes a bare `?:` rejects
  // an explicitly-undefined value. An absent field skips its rule either way.
  readonly draft?: boolean | undefined;
  readonly baseBranch?: string | undefined;
}

export interface RepoGateInput {
  readonly policy: EffectiveRepoPolicy;
  /**
   * Omitted by the comment path, which gates the repo before spending an
   * LLM call on intent classification and therefore does not yet know the
   * workflow. Rule 2 is skipped in that case and re-evaluated downstream
   * once the name is known.
   */
  readonly workflowName?: WorkflowName | undefined;
  readonly senderLogin: string;
  readonly trigger?: TriggerContext | undefined;
  /**
   * Evaluate the identity rules only (`ignore_authors`, `allowed_users`),
   * skipping the two enable toggles and the three passive trigger filters.
   *
   * Set by the de-escalating verbs `stop` and `abort`. They must land after
   * an owner disables the bot, or retitles the PR to "WIP", or retargets its
   * base branch, otherwise the config change strands the very run it was
   * meant to end. Who may drive the bot at all is a different question and
   * stays enforced: a login the repo excluded must not be able to kill
   * someone else's in-flight session.
   */
  readonly identityRulesOnly?: boolean | undefined;
}

export type RepoGateVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string; readonly explain: boolean };

const ALLOWED: RepoGateVerdict = { allowed: true };

/** GitHub logins are case-insensitive, so membership tests must be too. */
function includesLogin(logins: readonly string[], login: string): boolean {
  const normalized = login.toLowerCase();
  return logins.some((l) => l.toLowerCase() === normalized);
}

/**
 * Evaluate the repo's config against one trigger. Returns the first rule
 * that blocks, in the documented order, so the reason a user sees is the
 * most specific one that applies.
 */
export function checkRepoGate(input: RepoGateInput): RepoGateVerdict {
  const { policy, workflowName, senderLogin, trigger, identityRulesOnly = false } = input;
  const { triggers } = policy;

  if (!identityRulesOnly) {
    if (!policy.enabled) {
      return { allowed: false, reason: "the bot is disabled for this repository", explain: true };
    }

    if (workflowName !== undefined && !policyForWorkflow(policy, workflowName).enabled) {
      return {
        allowed: false,
        reason: `workflow '${workflowName}' is disabled in this repository's config`,
        explain: true,
      };
    }
  }

  // Before `allowed_users` on purpose. A bot login is normally in
  // `ignore_authors` and absent from `allowed_users`, so the other order
  // would answer every Renovate event with a public refusal comment, which
  // is exactly the noise `ignore_authors` exists to prevent.
  if (includesLogin(triggers.ignoreAuthors, senderLogin)) {
    return { allowed: false, reason: "author is in `triggers.ignore_authors`", explain: false };
  }

  if (triggers.allowedUsers.length > 0 && !includesLogin(triggers.allowedUsers, senderLogin)) {
    return {
      allowed: false,
      reason: "you are not in this repository's `triggers.allowed_users` list",
      explain: true,
    };
  }

  // Everything past here is a passive preference about which triggers are
  // worth acting on, not about who may act. See `identityRulesOnly`.
  if (identityRulesOnly) return ALLOWED;

  const title = trigger?.title;
  if (title !== undefined && triggers.ignoreTitleKeywords.length > 0) {
    const haystack = title.toLowerCase();
    const hit = triggers.ignoreTitleKeywords.find((k) => haystack.includes(k.toLowerCase()));
    if (hit !== undefined) {
      return {
        allowed: false,
        reason: `title matches \`triggers.ignore_title_keywords\` entry "${hit}"`,
        explain: false,
      };
    }
  }

  if (triggers.ignoreDraftPrs && trigger?.draft === true) {
    return { allowed: false, reason: "`triggers.ignore_draft_prs` is set", explain: false };
  }

  const baseBranch = trigger?.baseBranch;
  if (
    baseBranch !== undefined &&
    triggers.baseBranches.length > 0 &&
    !triggers.baseBranches.includes(baseBranch)
  ) {
    return {
      allowed: false,
      reason: `base branch '${baseBranch}' is not in \`triggers.base_branches\``,
      explain: false,
    };
  }

  return ALLOWED;
}
