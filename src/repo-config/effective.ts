/**
 * Resolve a repo's `.github-app.yaml` into the flat policy the rest of the
 * app consumes.
 *
 * Two jobs:
 *
 * 1. **Merge.** `workflows.<name>` layered over `defaults`, so callers never
 *    reimplement the precedence.
 * 2. **Clamp.** Server env ceilings win. The YAML may lower `max_turns` /
 *    `timeout`, never raise them past `AGENT_MAX_TURNS` / `AGENT_TIMEOUT_MS`.
 *    A repo owner can spend less of the operator's budget, not more.
 *
 * Fail-open by contract: `loadRepoPolicy` never throws and never returns
 * null. A missing, unreadable, or invalid file yields `DEFAULT_REPO_POLICY`,
 * carrying a `warning` only in the invalid case so the tracking comment can
 * tell the user their file was ignored.
 */

import type { Octokit } from "octokit";
import type { Logger } from "pino";

import { config } from "../config";
// Type-only, so the handler dependency graph stays out of this path.
import type { WorkflowName } from "../shared/workflow-types";
import { AGENT_POLICY_WARNING_MAX, type AgentPolicy } from "../shared/ws-messages";
import { fetchRepoConfig } from "./fetcher";
import {
  DEFAULT_REVIEW_LEARNINGS_CONFIG,
  type GithubAppConfig,
  type ReviewLearningsConfig,
  type TriggersConfig,
} from "./schema";

/** Resolved agent policy for one workflow, after merge and clamping. */
export interface EffectiveWorkflowPolicy {
  readonly enabled: boolean;
  readonly model?: string;
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  readonly extraAllowedTools: readonly string[];
  /** `review` only; empty for every other workflow. */
  readonly pathFilters: readonly string[];
  /** `review` only; undefined for every other workflow. */
  readonly instructions?: string;
  /**
   * `review` only; false for every other workflow. Auto-run on push, gated on
   * `AUTO_REVIEW_USERS` as well. A dispatch-time decision, so it is resolved
   * here but deliberately not projected by `toAgentPolicy`: nothing about it
   * belongs on the `job:payload` wire.
   */
  readonly auto: boolean;
}

export interface EffectiveTriggers {
  readonly ignoreAuthors: readonly string[];
  readonly ignoreDraftPrs: boolean;
  readonly ignoreTitleKeywords: readonly string[];
  readonly baseBranches: readonly string[];
  readonly allowedUsers: readonly string[];
}

export interface EffectiveRepoPolicy {
  /** Repo-wide master switch. */
  readonly enabled: boolean;
  /** Repo-wide agent defaults, used by jobs with no workflow name. */
  readonly defaults: EffectiveWorkflowPolicy;
  readonly triggers: EffectiveTriggers;
  readonly reviewLearnings: ReviewLearningsConfig;
  /** Present only when the file existed but failed validation. */
  readonly warning?: string;
  /** Raw document, when one parsed. Undefined when defaults are in force. */
  readonly source?: GithubAppConfig;
}

const EMPTY_WORKFLOW_POLICY: EffectiveWorkflowPolicy = {
  enabled: true,
  extraAllowedTools: [],
  pathFilters: [],
  auto: false,
};

const DEFAULT_TRIGGERS: EffectiveTriggers = {
  ignoreAuthors: [],
  ignoreDraftPrs: false,
  ignoreTitleKeywords: [],
  baseBranches: [],
  allowedUsers: [],
};

/** Everything on, nothing overridden. The behaviour before this file existed. */
export const DEFAULT_REPO_POLICY: EffectiveRepoPolicy = {
  enabled: true,
  defaults: EMPTY_WORKFLOW_POLICY,
  triggers: DEFAULT_TRIGGERS,
  reviewLearnings: DEFAULT_REVIEW_LEARNINGS_CONFIG,
};

/**
 * Clamp `value` below `ceiling`. An undefined ceiling is "no opinion"; an
 * undefined `value` stays undefined.
 *
 * One ceiling, not a list. A variadic form makes the wrong call
 * (`clampBelow(v, agentMaxTurns, defaultMaxTurns)`) look natural, and that
 * intersection is exactly the bug the caller below documents avoiding.
 */
function clampBelow(value: number | undefined, ceiling: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return ceiling === undefined ? value : Math.min(value, ceiling);
}

function toTriggers(t: TriggersConfig): EffectiveTriggers {
  return {
    ignoreAuthors: t.ignore_authors,
    ignoreDraftPrs: t.ignore_draft_prs,
    ignoreTitleKeywords: t.ignore_title_keywords,
    baseBranches: t.base_branches,
    allowedUsers: t.allowed_users,
  };
}

// Explicit `| undefined` on every member: the zod output types carry it, and
// under exactOptionalPropertyTypes a bare `?:` would reject them.
interface RawKnobs {
  readonly enabled?: boolean | undefined;
  readonly model?: string | undefined;
  readonly max_turns?: number | undefined;
  readonly timeout?: number | undefined;
  readonly extra_allowed_tools?: readonly string[] | undefined;
  readonly path_filters?: readonly string[] | undefined;
  readonly instructions?: string | undefined;
  readonly auto?: boolean | undefined;
}

/**
 * Merge one workflow entry over the repo defaults and clamp against the
 * server ceilings. `extra_allowed_tools` is a union, everything else is a
 * plain override.
 */
function resolveKnobs(defaults: RawKnobs, entry: RawKnobs | undefined): EffectiveWorkflowPolicy {
  const model = entry?.model ?? defaults.model;
  // One ceiling, resolved the same way the runtime resolves it: see the
  // `maxTurns` assignment in `src/orchestrator/connection-handler.ts` and the
  // `defaultMaxTurns` field in `src/config.ts`, whose comment calls
  // AGENT_MAX_TURNS the override. Intersecting both would clamp the YAML to a
  // DEFAULT_MAXTURNS the runtime has already discarded. Cited by symbol, not
  // line: `check-docs-citations` does not scan `src/` comments.
  const turnCeiling = config.agentMaxTurns ?? config.defaultMaxTurns;
  const maxTurns = clampBelow(entry?.max_turns ?? defaults.max_turns, turnCeiling);
  const timeoutMs = clampBelow(entry?.timeout ?? defaults.timeout, config.agentTimeoutMs);
  const tools = new Set([
    ...(defaults.extra_allowed_tools ?? []),
    ...(entry?.extra_allowed_tools ?? []),
  ]);

  return {
    enabled: entry?.enabled ?? true,
    ...(model !== undefined ? { model } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    extraAllowedTools: [...tools],
    pathFilters: entry?.path_filters ?? [],
    ...(entry?.instructions !== undefined ? { instructions: entry.instructions } : {}),
    // Entry-only, never inherited from `defaults:`. Auto-review is a widening
    // and must be opted into per workflow, not switched on repo-wide by a knob
    // block that exists to tune the agent.
    auto: entry?.auto ?? false,
  };
}

/** Resolve a parsed document. Exported for tests and the PR validator. */
export function resolvePolicy(doc: GithubAppConfig): EffectiveRepoPolicy {
  return {
    enabled: doc.enabled,
    defaults: resolveKnobs(doc.defaults, undefined),
    triggers: toTriggers(doc.triggers),
    reviewLearnings: doc.review_learnings,
    source: doc,
  };
}

/**
 * `workflows.<name>` merged over `defaults`. Returns the repo defaults when
 * the workflow has no entry, which is the common case.
 */
export function policyForWorkflow(
  policy: EffectiveRepoPolicy,
  name: WorkflowName,
): EffectiveWorkflowPolicy {
  const doc = policy.source;
  if (doc === undefined) return policy.defaults;
  return resolveKnobs(doc.defaults, doc.workflows[name]);
}

/**
 * Project a resolved workflow policy onto the `job:payload` wire shape
 * ("Gate 2"). Returns `undefined` when nothing is set, so a repo without a
 * config file produces no `policy` key and the payload stays byte-identical
 * to the pre-Gate-2 one.
 *
 * `maxTurns` is deliberately not projected: it rides the existing top-level
 * `maxTurns` payload field, so the wire keeps one source of truth for the cap.
 */
export function toAgentPolicy(
  wf: EffectiveWorkflowPolicy,
  warning: string | undefined,
): AgentPolicy | undefined {
  const policy: AgentPolicy = {
    ...(wf.model !== undefined ? { model: wf.model } : {}),
    ...(wf.timeoutMs !== undefined ? { timeoutMs: wf.timeoutMs } : {}),
    ...(wf.extraAllowedTools.length > 0 ? { extraAllowedTools: [...wf.extraAllowedTools] } : {}),
    ...(wf.pathFilters.length > 0 ? { pathFilters: [...wf.pathFilters] } : {}),
    ...(wf.instructions !== undefined ? { instructions: wf.instructions } : {}),
    ...(warning !== undefined ? { warning } : {}),
  };
  return Object.keys(policy).length > 0 ? policy : undefined;
}

/**
 * Clamp the fail-open notice to the wire cap.
 *
 * Truncation belongs at the producer, not the wire: the notice's length is an
 * emergent property of `MAX_RENDERED_ISSUES` x `MAX_ISSUE_LENGTH` in
 * `src/repo-config/fetcher.ts`, so bumping either constant would otherwise
 * push the string past `agentPolicySchema`'s cap. The daemon's parse failure
 * is silent (the job is dropped after the orchestrator took a capacity slot),
 * so a shortened notice is the only acceptable failure mode here.
 */
function truncateWarning(message: string): string {
  if (message.length <= AGENT_POLICY_WARNING_MAX) return message;
  return `${message.slice(0, AGENT_POLICY_WARNING_MAX - 1)}…`;
}

export interface LoadRepoPolicyInput {
  readonly octokit: Octokit;
  readonly owner: string;
  readonly repo: string;
  readonly log: Logger;
}

/**
 * Fetch + resolve in one call. Never throws; any failure yields
 * `DEFAULT_REPO_POLICY`.
 */
export async function loadRepoPolicy(input: LoadRepoPolicyInput): Promise<EffectiveRepoPolicy> {
  const { octokit, owner, repo, log } = input;
  try {
    const result = await fetchRepoConfig({
      octokit,
      owner,
      repo,
      path: config.repoConfigFile,
      log,
    });
    switch (result.kind) {
      case "ok":
        return resolvePolicy(result.config);
      case "invalid":
        return {
          ...DEFAULT_REPO_POLICY,
          warning: truncateWarning(
            `\`${config.repoConfigFile}\` failed validation and was ignored; built-in defaults were used. First error: ${result.message}`,
          ),
        };
      case "absent":
        return DEFAULT_REPO_POLICY;
    }
  } catch (err) {
    // fetchRepoConfig is already total, so reaching here means something
    // unexpected (config access, import cycle). Still fail open.
    // `error`, matching the ship-rail emitter: the observability page tells
    // operators any `repo_config.gate_error` is a bug, so both callsites have
    // to clear a `level >= error` filter.
    log.error(
      { event: "repo_config.gate_error", err, owner, repo },
      "repo-config: policy load failed, using defaults",
    );
    return DEFAULT_REPO_POLICY;
  }
}
