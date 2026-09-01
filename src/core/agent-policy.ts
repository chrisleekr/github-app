import { config } from "../config";
import type { AgentPolicy } from "../shared/ws-messages";

/**
 * Turns a per-repo `.github-app.yaml` agent policy ("Gate 2") into
 * `executeAgent` options. Shared by `runPipeline` and by the handlers that
 * bypass it because they own their prompts (`plan`, `triage`).
 *
 * `pathFilters` / `instructions` are not handled here: both need fetched PR
 * data and the prompt builder, so they stay pipeline-only.
 */

export interface ApplyAgentPolicyInput {
  readonly baseAllowedTools: readonly string[];
  readonly policy?: AgentPolicy | undefined;
  /** Rides the `job:payload.maxTurns` wire field, not `policy`, to keep one source of truth. */
  readonly maxTurns?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface AppliedAgentPolicy {
  /** Unset knobs are absent, not `undefined`-valued (`exactOptionalPropertyTypes`). */
  readonly options: {
    allowedTools: string[];
    model?: string;
    maxTurns?: number;
    signal?: AbortSignal;
  };
  /** Call in a `finally`: a live timer keeps Bun's event loop alive for the rest of the deadline. */
  readonly dispose: () => void;
}

export function applyAgentPolicy(input: ApplyAgentPolicyInput): AppliedAgentPolicy {
  const { baseAllowedTools, policy, maxTurns, signal: callerSignal } = input;

  // Additive only: a repo can widen the tool list, never revoke what the caller requires.
  const extraTools = policy?.extraAllowedTools ?? [];
  const allowedTools =
    extraTools.length > 0
      ? [...new Set([...baseAllowedTools, ...extraTools])]
      : [...baseAllowedTools];

  // Composed over the caller's signal, not replacing it, so a daemon cancel still lands.
  // An explicit named Error, not `AbortSignal.timeout`: its bare TimeoutError DOMException
  // fails executeAgent's identity check, losing the attribution to the repo's `timeout:`.
  const policyTimeoutMs = policy?.timeoutMs;
  const policyDeadline = new AbortController();
  let policyTimer: ReturnType<typeof setTimeout> | undefined;
  let signal = callerSignal;
  if (policyTimeoutMs !== undefined) {
    policyTimer = setTimeout(() => {
      policyDeadline.abort(
        new Error(
          `Agent execution exceeded the per-repo \`timeout\` from ${config.repoConfigFile} after ${String(policyTimeoutMs)}ms`,
        ),
      );
    }, policyTimeoutMs);
    signal =
      signal === undefined
        ? policyDeadline.signal
        : AbortSignal.any([signal, policyDeadline.signal]);
  }

  const options: AppliedAgentPolicy["options"] = {
    allowedTools,
    ...(policy?.model !== undefined ? { model: policy.model } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(signal !== undefined ? { signal } : {}),
  };

  return {
    options,
    dispose: () => {
      if (policyTimer === undefined) return;
      clearTimeout(policyTimer);
      policyTimer = undefined;
    },
  };
}
