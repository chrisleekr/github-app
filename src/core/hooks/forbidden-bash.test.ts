import { describe, expect, it } from "bun:test";

import type { Logger } from "../../logger";
import { createForbiddenBashHook } from "./forbidden-bash";

// Minimal logger stub: records `.warn` calls so a deny can be asserted. The
// factory's `log` param is a pino Logger in production; only `.warn` is used
// here, so the cast at the call site keeps the test honest without pulling in
// the full pino surface.
function makeLog() {
  const warns: { obj: Record<string, unknown>; msg: string }[] = [];
  const log = {
    warn: (obj: Record<string, unknown>, msg: string) => warns.push({ obj, msg }),
    info: () => {},
    error: () => {},
    debug: () => {},
  };
  return { log, warns };
}

// Invoke the hook with a Bash command. Input is cast so the test does not need
// to import SDK hook-input types. `overrides` lets a case swap the event name or
// tool_input to exercise the non-PreToolUse and malformed-input branches.
async function run(
  hook: ReturnType<typeof createForbiddenBashHook>,
  command: string,
  toolName = "Bash",
  overrides: { hookEventName?: string; toolInput?: unknown } = {},
): Promise<{
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
}> {
  return hook(
    {
      hook_event_name: overrides.hookEventName ?? "PreToolUse",
      tool_name: toolName,
      tool_input: "toolInput" in overrides ? overrides.toolInput : { command },
      tool_use_id: "t1",
    } as unknown as Parameters<typeof hook>[0],
    "t1",
    { signal: new AbortController().signal },
  ) as Promise<{
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  }>;
}

describe("createForbiddenBashHook", () => {
  it("denies git push --force", async () => {
    const { log } = makeLog();
    const hook = createForbiddenBashHook(log as unknown as Logger);
    const result = await run(hook, "git push --force origin feature");
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(typeof result.hookSpecificOutput?.permissionDecisionReason).toBe("string");
    expect(result.hookSpecificOutput?.permissionDecisionReason?.length).toBeGreaterThan(0);
  });

  it("denies git push -f", async () => {
    const { log } = makeLog();
    const hook = createForbiddenBashHook(log as unknown as Logger);
    const result = await run(hook, "git push -f origin feature");
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(typeof result.hookSpecificOutput?.permissionDecisionReason).toBe("string");
    expect(result.hookSpecificOutput?.permissionDecisionReason?.length).toBeGreaterThan(0);
  });

  it("denies git push --force-with-lease", async () => {
    const { log } = makeLog();
    const hook = createForbiddenBashHook(log as unknown as Logger);
    const result = await run(hook, "git push --force-with-lease origin feature");
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(typeof result.hookSpecificOutput?.permissionDecisionReason).toBe("string");
    expect(result.hookSpecificOutput?.permissionDecisionReason?.length).toBeGreaterThan(0);
  });

  it("denies git reset --hard", async () => {
    const { log } = makeLog();
    const hook = createForbiddenBashHook(log as unknown as Logger);
    const result = await run(hook, "git reset --hard HEAD~1");
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(typeof result.hookSpecificOutput?.permissionDecisionReason).toBe("string");
    expect(result.hookSpecificOutput?.permissionDecisionReason?.length).toBeGreaterThan(0);
  });

  it("denies gh pr merge", async () => {
    const { log } = makeLog();
    const hook = createForbiddenBashHook(log as unknown as Logger);
    const result = await run(hook, "gh pr merge 5 --squash");
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(typeof result.hookSpecificOutput?.permissionDecisionReason).toBe("string");
    expect(result.hookSpecificOutput?.permissionDecisionReason?.length).toBeGreaterThan(0);
  });

  it("denies a graphql mergePullRequest mutation", async () => {
    const { log } = makeLog();
    const hook = createForbiddenBashHook(log as unknown as Logger);
    const result = await run(
      hook,
      `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }'`,
    );
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(typeof result.hookSpecificOutput?.permissionDecisionReason).toBe("string");
    expect(result.hookSpecificOutput?.permissionDecisionReason?.length).toBeGreaterThan(0);
  });

  it("allows a normal push", async () => {
    const { log } = makeLog();
    const hook = createForbiddenBashHook(log as unknown as Logger);
    const result = await run(hook, "git push origin HEAD");
    expect(result.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  it("allows git status", async () => {
    const { log } = makeLog();
    const hook = createForbiddenBashHook(log as unknown as Logger);
    const result = await run(hook, "git status");
    expect(result.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  it("allows gh pr checks", async () => {
    const { log } = makeLog();
    const hook = createForbiddenBashHook(log as unknown as Logger);
    const result = await run(hook, "gh pr checks 5");
    expect(result.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  it("allows git reset --soft", async () => {
    const { log } = makeLog();
    const hook = createForbiddenBashHook(log as unknown as Logger);
    const result = await run(hook, "git reset --soft HEAD~1");
    expect(result.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  it("allows git commit", async () => {
    const { log } = makeLog();
    const hook = createForbiddenBashHook(log as unknown as Logger);
    const result = await run(hook, `git commit -m "fix: x"`);
    expect(result.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  it("logs agent.hook.denied with the rule on deny", async () => {
    const { log, warns } = makeLog();
    const hook = createForbiddenBashHook(log as unknown as Logger);
    await run(hook, "git push --force origin SECRET_BRANCH_token");
    expect(warns.length).toBe(1);
    expect(warns[0]?.obj).toMatchObject({ event: "agent.hook.denied", tool: "Bash" });
    // The raw command must never be logged. The static rule label
    // ("git push --force") may appear since it carries no attacker input, but the
    // command's attacker-controlled tail (the ref/args) must not leak.
    expect(JSON.stringify(warns[0]?.obj)).not.toContain("SECRET_BRANCH_token");
    // Exact key set: a future change adding a raw-command field would fail here.
    expect(Object.keys(warns[0]!.obj).sort()).toEqual(["event", "rule", "tool"]);
  });

  it("allows a non-Bash tool", async () => {
    const { log } = makeLog();
    const hook = createForbiddenBashHook(log as unknown as Logger);
    const result = await run(hook, "git push --force origin feature", "Read");
    expect(result.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  // One representative command per FORBIDDEN rule: a deny here proves the rule
  // fires, and the +refspec entry proves the broadened pattern from issue #222.
  const denyCases: readonly [label: string, command: string][] = [
    ["git push --force", "git push --force origin main"],
    ["git push --force-with-lease", "git push --force-with-lease origin main"],
    ["git push -f", "git push -f origin main"],
    ["git push +refspec", "git push origin +HEAD:main"],
    ["git push --mirror", "git push --mirror origin"],
    ["git reset --hard", "git reset --hard HEAD~1"],
    ["git branch -D", "git branch -D feature"],
    ["git push --delete", "git push origin --delete feature"],
    ["git filter-branch", "git filter-branch --tree-filter x HEAD"],
    ["git filter-repo", "git filter-repo --path x"],
    ["git replace", "git replace a b"],
    ["gh pr merge", "gh pr merge 5 --squash"],
    [
      "mergePullRequest mutation",
      "gh api graphql -f query='mutation { mergePullRequest(input:{}) { x } }'",
    ],
    ["mergeBranch mutation", "gh api graphql -f query='mutation { mergeBranch(input:{}) { x } }'"],
  ];

  it.each(denyCases)("denies %s", async (_label, command) => {
    const { log } = makeLog();
    const hook = createForbiddenBashHook(log as unknown as Logger);
    const result = await run(hook, command);
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("allows malformed tool_input (no command key)", async () => {
    const { log } = makeLog();
    const hook = createForbiddenBashHook(log as unknown as Logger);
    const result = await run(hook, "", "Bash", { toolInput: {} });
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe("deny");
  });

  it("allows a non-PreToolUse event", async () => {
    const { log } = makeLog();
    const hook = createForbiddenBashHook(log as unknown as Logger);
    const result = await run(hook, "git push --force origin main", "Bash", {
      hookEventName: "Stop",
    });
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe("deny");
  });
});
