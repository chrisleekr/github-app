/**
 * Gate 1 on the canonical ship rail.
 *
 * `command-dispatch.ts` bypasses `workflows/dispatcher.ts` entirely, so it
 * carries its own `checkRepoGate` call. These tests assert that call exists
 * and its verdict is honoured; `test/repo-config/gate.test.ts` owns the rule
 * semantics.
 *
 * Dispatch is fire-and-forget (`void (async () => ...)()`), so every
 * assertion waits a macrotask tick for the IIFE to settle.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";
import type pino from "pino";

import type { CanonicalCommand, CommandIntent } from "../../../src/shared/ship-types";

// ─── Mocked handlers ─────────────────────────────────────────────────────

const mockRunShipFromCommand = mock(() => Promise.resolve());
void mock.module("../../../src/workflows/ship/session-runner", () => ({
  runShipFromCommand: mockRunShipFromCommand,
}));

const mockRunLifecycleCommand = mock(() => Promise.resolve());
void mock.module("../../../src/workflows/ship/lifecycle-commands", () => ({
  runLifecycleCommand: mockRunLifecycleCommand,
}));

const mockDispatchScopedCommand = mock(() => Promise.resolve());
void mock.module("../../../src/workflows/ship/scoped/dispatch-scoped", () => ({
  dispatchScopedCommand: mockDispatchScopedCommand,
}));

// The ship rail posts its own refusal comment for `explain: true` verdicts;
// nothing else can speak for it once the canonical parser has claimed the
// trigger. Stubbed so the tests can assert it fired without a real Octokit.
const realTrackingMirror = await import("../../../src/workflows/tracking-mirror");
const mockPostRefusalComment = mock(
  (_deps: unknown, _target: unknown, _name: string, _reason: string) => Promise.resolve(),
);
void mock.module("../../../src/workflows/tracking-mirror", () => ({
  ...realTrackingMirror,
  postRefusalComment: mockPostRefusalComment,
}));

// Both parsers behind `dispatchCommentSurface`. Returning null from the
// literal surface is what pushes execution past the gate to the NL fallback,
// which is the path under test.
const mockRouteTrigger = mock((_input: { surface: string }) => Promise.resolve(null));
void mock.module("../../../src/workflows/ship/trigger-router", () => ({
  routeTrigger: mockRouteTrigger,
}));

// Gate 1's config loader. Stubbed rather than left to fail open: the fake
// Octokit below is an empty object, so the real loader throws internally and
// degrades to the permissive default, which would let these assertions pass
// even with the gate call deleted.
const realEffective = await import("../../../src/repo-config/effective");
const mockLoadRepoPolicy = mock(() => Promise.resolve(realEffective.DEFAULT_REPO_POLICY));
void mock.module("../../../src/repo-config/effective", () => ({
  ...realEffective,
  loadRepoPolicy: mockLoadRepoPolicy,
}));

const { config } = await import("../../../src/config");
const { githubAppConfigSchema } = await import("../../../src/repo-config/schema");
const { COMMAND_INTENTS } = await import("../../../src/shared/ship-types");
const { WorkflowNameSchema } = await import("../../../src/workflows/registry");
const { dispatchCanonicalCommand, dispatchCommentSurface, INTENT_TO_WORKFLOW } =
  await import("../../../src/workflows/ship/command-dispatch");

// ─── Fixtures ─────────────────────────────────────────────────────────────

function silentLog(): pino.Logger {
  const log = {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    child: mock(function (this: unknown) {
      return this;
    }),
  } as unknown as pino.Logger;
  return log;
}

const fakeOctokit = {} as unknown as Octokit;

function command(intent: CommandIntent): CanonicalCommand {
  return {
    intent,
    surface: "literal",
    principal_login: "alice",
    pr: { owner: "acme", repo: "repo", number: 42, installation_id: 1 },
  };
}

/** Let the fire-and-forget IIFE resolve its awaits before asserting. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function disabledRepo(): typeof realEffective.DEFAULT_REPO_POLICY {
  return { ...realEffective.DEFAULT_REPO_POLICY, enabled: false };
}

/** Build a real policy from YAML, so the tests exercise the actual resolver. */
function policyFrom(doc: unknown): typeof realEffective.DEFAULT_REPO_POLICY {
  return realEffective.resolvePolicy(githubAppConfigSchema.parse(doc));
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("dispatchCanonicalCommand repo-config gate", () => {
  beforeEach(() => {
    mockRunShipFromCommand.mockClear();
    mockRunLifecycleCommand.mockClear();
    mockDispatchScopedCommand.mockClear();
    mockLoadRepoPolicy.mockClear();
    mockPostRefusalComment.mockClear();
    mockLoadRepoPolicy.mockResolvedValue(realEffective.DEFAULT_REPO_POLICY);
  });

  it("dispatches ship when the repo policy allows it", async () => {
    dispatchCanonicalCommand(command("ship"), { octokit: fakeOctokit, log: silentLog() });
    await settle();

    expect(mockLoadRepoPolicy).toHaveBeenCalledTimes(1);
    expect(mockRunShipFromCommand).toHaveBeenCalledTimes(1);
  });

  it("blocks ship when the repo is disabled", async () => {
    mockLoadRepoPolicy.mockResolvedValue(disabledRepo());

    dispatchCanonicalCommand(command("ship"), { octokit: fakeOctokit, log: silentLog() });
    await settle();

    expect(mockRunShipFromCommand).not.toHaveBeenCalled();
  });

  it("blocks a scoped verb when the repo is disabled", async () => {
    mockLoadRepoPolicy.mockResolvedValue(disabledRepo());

    dispatchCanonicalCommand(command("rebase"), { octokit: fakeOctokit, log: silentLog() });
    await settle();

    expect(mockDispatchScopedCommand).not.toHaveBeenCalled();
  });

  it.each(["stop", "abort"] as const)("lets '%s' through a disabled repo", async (intent) => {
    mockLoadRepoPolicy.mockResolvedValue(disabledRepo());

    dispatchCanonicalCommand(command(intent), { octokit: fakeOctokit, log: silentLog() });
    await settle();

    // De-escalating verbs must land, or disabling the bot strands the very
    // run the owner was trying to end.
    expect(mockRunLifecycleCommand).toHaveBeenCalledTimes(1);
    expect(mockPostRefusalComment).not.toHaveBeenCalled();
  });

  it.each(["stop", "abort"] as const)(
    "still blocks '%s' from a sender outside allowed_users",
    async (intent) => {
      mockLoadRepoPolicy.mockResolvedValue(
        policyFrom({ version: 1, triggers: { allowed_users: ["bob"] } }),
      );

      dispatchCanonicalCommand(command(intent), { octokit: fakeOctokit, log: silentLog() });
      await settle();

      // The carve-out is about config state, not identity: a login the repo
      // excluded must not be able to kill someone else's in-flight run.
      expect(mockRunLifecycleCommand).not.toHaveBeenCalled();
      expect(mockPostRefusalComment).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["stop", "abort"] as const)(
    "lets '%s' through a passive trigger filter that would strand the run",
    async (intent) => {
      mockLoadRepoPolicy.mockResolvedValue(
        policyFrom({ version: 1, triggers: { ignore_title_keywords: ["WIP"] } }),
      );

      dispatchCanonicalCommand(command(intent), {
        octokit: fakeOctokit,
        log: silentLog(),
        trigger: { title: "WIP: something" },
      });
      await settle();

      expect(mockRunLifecycleCommand).toHaveBeenCalledTimes(1);
    },
  );

  it("blocks ship when only workflows.ship is disabled, leaving scoped verbs alone", async () => {
    mockLoadRepoPolicy.mockResolvedValue(
      policyFrom({ version: 1, workflows: { ship: { enabled: false } } }),
    );

    dispatchCanonicalCommand(command("ship"), { octokit: fakeOctokit, log: silentLog() });
    await settle();
    expect(mockRunShipFromCommand).not.toHaveBeenCalled();

    dispatchCanonicalCommand(command("rebase"), { octokit: fakeOctokit, log: silentLog() });
    await settle();
    expect(mockDispatchScopedCommand).toHaveBeenCalledTimes(1);
  });

  it("blocks bot:triage when workflows.triage is disabled", async () => {
    // `triage` is both a scoped CommandIntent and a registry workflow. The
    // canonical parser claims `bot:triage` before `dispatchByLabel` runs, so
    // this rail is the only place the toggle can be enforced.
    mockLoadRepoPolicy.mockResolvedValue(
      policyFrom({ version: 1, workflows: { triage: { enabled: false } } }),
    );

    dispatchCanonicalCommand(command("triage"), { octokit: fakeOctokit, log: silentLog() });
    await settle();

    expect(mockDispatchScopedCommand).not.toHaveBeenCalled();
    expect(mockPostRefusalComment).toHaveBeenCalledTimes(1);
  });

  it("maps every intent that collides with a registry workflow name", () => {
    // Missing an entry is a silent bypass, not a type error: the intent just
    // stops carrying its workflow name into rule 2.
    const workflowNames = new Set<string>(WorkflowNameSchema.options);
    const colliding = COMMAND_INTENTS.filter((i) => workflowNames.has(i)).sort();
    expect(Object.keys(INTENT_TO_WORKFLOW).sort()).toEqual(colliding);
  });

  it("posts a refusal comment naming the intent for a scoped verb", async () => {
    mockLoadRepoPolicy.mockResolvedValue(disabledRepo());

    dispatchCanonicalCommand(command("summarize"), { octokit: fakeOctokit, log: silentLog() });
    await settle();

    // Scoped verbs have no registry entry, so the comment names the verb the
    // user actually typed rather than echoing "unknown".
    expect(mockPostRefusalComment.mock.calls[0]?.[2]).toBe("summarize");
  });

  it("blocks 'resume' on a disabled repo, unlike stop and abort", async () => {
    mockLoadRepoPolicy.mockResolvedValue(disabledRepo());

    dispatchCanonicalCommand(command("resume"), { octokit: fakeOctokit, log: silentLog() });
    await settle();

    expect(mockRunLifecycleCommand).not.toHaveBeenCalled();
  });

  it("fails open and still dispatches when the policy load throws", async () => {
    mockLoadRepoPolicy.mockRejectedValueOnce(new Error("github unreachable"));

    dispatchCanonicalCommand(command("ship"), { octokit: fakeOctokit, log: silentLog() });
    await settle();

    expect(mockRunShipFromCommand).toHaveBeenCalledTimes(1);
  });
});

describe("dispatchCommentSurface repo-config gate", () => {
  const pr = { owner: "acme", repo: "repo", number: 42, installation_id: 1 };

  beforeEach(() => {
    mockLoadRepoPolicy.mockClear();
    mockLoadRepoPolicy.mockResolvedValue(realEffective.DEFAULT_REPO_POLICY);
    mockRouteTrigger.mockClear();
    mockRouteTrigger.mockResolvedValue(null);
  });

  it("returns false and never reaches the NL classifier on a disabled repo", async () => {
    mockLoadRepoPolicy.mockResolvedValue(disabledRepo());

    const handled = await dispatchCommentSurface({
      commentBody: `${config.triggerPhrase} please review this`,
      principal_login: "alice",
      pr,
      octokit: fakeOctokit,
      log: silentLog(),
    });

    // `false`, not `true`: the caller falls through to `dispatchByIntent`,
    // which re-runs the gate and owns the single refusal comment.
    expect(handled).toBe(false);
    const surfaces = mockRouteTrigger.mock.calls.map(([arg]) => arg.surface);
    expect(surfaces).toEqual(["literal"]);
  });

  it("skips the gate entirely for a comment that does not open with the trigger phrase", async () => {
    const handled = await dispatchCommentSurface({
      commentBody: "just a normal review comment, no mention",
      principal_login: "alice",
      pr,
      octokit: fakeOctokit,
      log: silentLog(),
    });

    // The classifier would return null for this body anyway (FR-025a), so
    // paying a config fetch per comment buys nothing.
    expect(handled).toBe(false);
    expect(mockLoadRepoPolicy).not.toHaveBeenCalled();
  });

  it("reaches the NL classifier when the repo policy allows it", async () => {
    const handled = await dispatchCommentSurface({
      commentBody: `${config.triggerPhrase} please review this`,
      principal_login: "alice",
      pr,
      octokit: fakeOctokit,
      log: silentLog(),
    });

    expect(handled).toBe(false); // both parsers returned null
    const surfaces = mockRouteTrigger.mock.calls.map(([arg]) => arg.surface);
    expect(surfaces).toEqual(["literal", "nl"]);
  });
});
