import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

import type { Logger } from "../../logger";
import { findForbiddenBash } from "../../utils/forbidden-bash";

/**
 * Runtime backstop for the prompt-only destructive-action bans (issue #222).
 *
 * The agent subprocess runs under `bypassPermissions` with the Bash tool
 * allowed, so a prompt-injected force-push / `git reset --hard` / `gh pr merge`
 * / GraphQL merge mutation would otherwise execute unchecked. This PreToolUse
 * hook denies any Bash command matching the shared FORBIDDEN set before the
 * tool runs, backing the prompt instructions with an enforced gate.
 *
 * Patterns are shared with the static `check:no-destructive` CI guard via
 * `src/utils/forbidden-bash.ts`, so the two layers stay in lockstep.
 *
 * This is a defense-in-depth backstop for the naive/literal destructive command,
 * not a sandbox: a regex denylist on free-form shell cannot defeat obfuscation
 * (variable indirection, command substitution, base64|sh). The durable control is
 * remote branch protection plus a least-privilege token.
 */
export function createForbiddenBashHook(log: Logger): HookCallback {
  // Non-async: the HookCallback contract needs a Promise return, but the body
  // does no awaiting, so wrap the result in Promise.resolve to satisfy the type
  // without a lint-flagged empty async (require-await).
  return (input, _toolUseId, _opts) => {
    // input is the HookInput discriminated union; the event-name guard narrows
    // it to PreToolUseHookInput, so no cast is needed.
    if (input.hook_event_name !== "PreToolUse") return Promise.resolve({});
    const pre: PreToolUseHookInput = input;
    if (pre.tool_name !== "Bash") return Promise.resolve({});

    const ti = pre.tool_input;
    const command =
      typeof ti === "object" && ti !== null && "command" in ti && typeof ti.command === "string"
        ? ti.command
        : "";

    const hit = findForbiddenBash(command);
    if (!hit) return Promise.resolve({});

    // Never log the raw command: it can carry tokens/secrets (token-leak risk).
    log.warn(
      { event: "agent.hook.denied", tool: "Bash", rule: hit.description },
      "Blocked destructive Bash command",
    );

    return Promise.resolve({
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: `Blocked by forbidden-bash hook: ${hit.description}`,
      },
    });
  };
}
