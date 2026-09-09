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
// literal surface is what pushes execution past the gate to the NL
// classifier, which is the path under test.
const mockRouteTrigger = mock((_input: { surface: string }) => Promise.resolve(null));
const mockRouteNlTrigger = mock(
  (_payload: unknown) => Promise.resolve({ kind: "none" }) as Promise<unknown>,
);
void mock.module("../../../src/workflows/ship/trigger-router", () => ({
  routeTrigger: mockRouteTrigger,
  routeNlTrigger: mockRouteNlTrigger,
}));

// The registry rail the mention surface now shares with the `bot:<name>`
// label trigger.
const mockDispatchWorkflowByName = mock((_input: unknown) =>
  Promise.resolve({ status: "dispatched", runId: "run-1", workflowName: "review" }),
);
void mock.module("../../../src/workflows/dispatcher", () => ({
  dispatchWorkflowByName: mockDispatchWorkflowByName,
}));

// The classifier's LLM. Stubbed so no test in this file can reach Bedrock.
void mock.module("../../../src/webhook/triage-client-factory", () => ({
  getTriageLLMClient: () => ({
    provider: "anthropic",
    create: mock(() => Promise.resolve({ text: "{}" })),
  }),
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

function deps(): {
  octokit: Octokit;
  log: pino.Logger;
  deliveryId: string;
} {
  return { octokit: fakeOctokit, log: silentLog(), deliveryId: "delivery-1" };
}

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
    dispatchCanonicalCommand(command("ship"), deps());
    await settle();

    expect(mockLoadRepoPolicy).toHaveBeenCalledTimes(1);
    expect(mockRunShipFromCommand).toHaveBeenCalledTimes(1);
  });

  it("blocks ship when the repo is disabled", async () => {
    mockLoadRepoPolicy.mockResolvedValue(disabledRepo());

    dispatchCanonicalCommand(command("ship"), deps());
    await settle();

    expect(mockRunShipFromCommand).not.toHaveBeenCalled();
  });

  it("blocks a scoped verb when the repo is disabled", async () => {
    mockLoadRepoPolicy.mockResolvedValue(disabledRepo());

    dispatchCanonicalCommand(command("rebase"), deps());
    await settle();

    expect(mockDispatchScopedCommand).not.toHaveBeenCalled();
  });

  it.each(["stop", "abort"] as const)("lets '%s' through a disabled repo", async (intent) => {
    mockLoadRepoPolicy.mockResolvedValue(disabledRepo());

    dispatchCanonicalCommand(command(intent), deps());
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

      dispatchCanonicalCommand(command(intent), deps());
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
        ...deps(),
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

    dispatchCanonicalCommand(command("ship"), deps());
    await settle();
    expect(mockRunShipFromCommand).not.toHaveBeenCalled();

    dispatchCanonicalCommand(command("rebase"), deps());
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

    dispatchCanonicalCommand(command("triage"), deps());
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

    dispatchCanonicalCommand(command("summarize"), deps());
    await settle();

    // Scoped verbs have no registry entry, so the comment names the verb the
    // user actually typed rather than echoing "unknown".
    expect(mockPostRefusalComment.mock.calls[0]?.[2]).toBe("summarize");
  });

  it("blocks 'resume' on a disabled repo, unlike stop and abort", async () => {
    mockLoadRepoPolicy.mockResolvedValue(disabledRepo());

    dispatchCanonicalCommand(command("resume"), deps());
    await settle();

    expect(mockRunLifecycleCommand).not.toHaveBeenCalled();
  });

  it("fails open and still dispatches when the policy load throws", async () => {
    mockLoadRepoPolicy.mockRejectedValueOnce(new Error("github unreachable"));

    dispatchCanonicalCommand(command("ship"), deps());
    await settle();

    expect(mockRunShipFromCommand).toHaveBeenCalledTimes(1);
  });
});

describe("dispatchCommentSurface repo-config gate", () => {
  const pr = { owner: "acme", repo: "repo", number: 42, installation_id: 1 };

  function surfaceInput(
    overrides: Record<string, unknown> = {},
  ): Parameters<typeof dispatchCommentSurface>[0] {
    return {
      commentBody: `${config.triggerPhrase} please review this`,
      principal_login: "alice",
      pr,
      event_surface: "pr-comment" as const,
      deliveryId: "delivery-1",
      octokit: fakeOctokit,
      log: silentLog(),
      ...overrides,
    };
  }

  beforeEach(() => {
    mockLoadRepoPolicy.mockClear();
    mockLoadRepoPolicy.mockResolvedValue(realEffective.DEFAULT_REPO_POLICY);
    mockRouteTrigger.mockClear();
    mockRouteTrigger.mockResolvedValue(null);
    mockRouteNlTrigger.mockClear();
    mockRouteNlTrigger.mockResolvedValue({ kind: "none", classified: true });
    mockPostRefusalComment.mockClear();
    mockDispatchWorkflowByName.mockClear();
    mockDispatchScopedCommand.mockClear();
    mockRunShipFromCommand.mockClear();
  });

  it("owns the refusal and never reaches the NL classifier on a disabled repo", async () => {
    mockLoadRepoPolicy.mockResolvedValue(disabledRepo());

    const handled = await dispatchCommentSurface(surfaceInput());

    // `true`, not `false`: this used to hand the comment to `dispatchByIntent`,
    // which re-ran the gate and owned the refusal. With that rail retired this
    // is the only place left that can answer.
    expect(handled).toBe(true);
    expect(mockPostRefusalComment).toHaveBeenCalledTimes(1);
    expect(mockRouteNlTrigger).not.toHaveBeenCalled();
  });

  it("stays silent for a passive trigger filter, but still claims the comment", async () => {
    mockLoadRepoPolicy.mockResolvedValue(
      policyFrom({ version: 1, triggers: { ignore_title_keywords: ["WIP"] } }),
    );

    const handled = await dispatchCommentSurface(
      surfaceInput({ trigger: { title: "WIP: something" } }),
    );

    // A passive filter answering every Renovate comment in public is the
    // failure mode `explain: false` exists to prevent.
    expect(handled).toBe(true);
    expect(mockPostRefusalComment).not.toHaveBeenCalled();
    expect(mockRouteNlTrigger).not.toHaveBeenCalled();
  });

  it("skips the gate entirely for a comment that does not open with the trigger phrase", async () => {
    const handled = await dispatchCommentSurface(
      surfaceInput({ commentBody: "just a normal review comment, no mention" }),
    );

    // The classifier would return null for this body anyway (FR-025a), so
    // paying a config fetch per comment buys nothing.
    expect(handled).toBe(false);
    expect(mockLoadRepoPolicy).not.toHaveBeenCalled();
  });

  it("reaches the NL classifier when the repo policy allows it", async () => {
    const handled = await dispatchCommentSurface(surfaceInput());

    expect(handled).toBe(false); // literal parser and classifier both declined
    const surfaces = mockRouteTrigger.mock.calls.map(([arg]) => arg.surface);
    expect(surfaces).toEqual(["literal"]);
    expect(mockRouteNlTrigger).toHaveBeenCalledTimes(1);
  });
});

describe("dispatchCommentSurface NL routing", () => {
  const pr = { owner: "acme", repo: "repo", number: 42, installation_id: 1 };

  function nlCommand(intent: CommandIntent): CanonicalCommand {
    return {
      intent,
      surface: "nl",
      principal_login: "alice",
      pr,
      event_surface: "pr-comment",
    };
  }

  function surfaceInput(): Parameters<typeof dispatchCommentSurface>[0] {
    return {
      commentBody: `${config.triggerPhrase} review please`,
      principal_login: "alice",
      pr,
      event_surface: "pr-comment" as const,
      deliveryId: "delivery-nl",
      octokit: fakeOctokit,
      log: silentLog(),
    };
  }

  beforeEach(() => {
    mockLoadRepoPolicy.mockClear();
    mockLoadRepoPolicy.mockResolvedValue(realEffective.DEFAULT_REPO_POLICY);
    mockRouteTrigger.mockClear();
    mockRouteTrigger.mockResolvedValue(null);
    mockRouteNlTrigger.mockClear();
    mockPostRefusalComment.mockClear();
    mockDispatchWorkflowByName.mockClear();
    mockDispatchScopedCommand.mockClear();
    mockRunShipFromCommand.mockClear();
  });

  // The bug this whole rail exists to fix: `review` used to be absent from the
  // ship classifier's enum, so it fell into chat-thread and the review workflow
  // was unreachable by mention.
  it("dispatches a confident registry workflow through dispatchWorkflowByName", async () => {
    mockRouteNlTrigger.mockResolvedValue({
      kind: "command",
      command: nlCommand("review"),
      confidence: 0.95,
    });

    const handled = await dispatchCommentSurface(surfaceInput());
    await settle();

    expect(handled).toBe(true);
    expect(mockDispatchWorkflowByName).toHaveBeenCalledTimes(1);
    const arg = mockDispatchWorkflowByName.mock.calls[0]?.[0] as {
      workflowName: string;
      deliveryId: string;
      target: { type: string; number: number };
    };
    expect(arg.workflowName).toBe("review");
    expect(arg.deliveryId).toBe("delivery-nl");
    expect(arg.target).toMatchObject({ type: "pr", number: 42 });
  });

  it("hands the gate's policy to the workflow rail, so rule 2 costs one fetch", async () => {
    mockRouteNlTrigger.mockResolvedValue({
      kind: "command",
      command: nlCommand("review"),
      confidence: 0.95,
    });

    await dispatchCommentSurface(surfaceInput());
    await settle();

    // One load for the whole mention. The pre-classification gate loads it,
    // the post-classification gate reuses it through `DispatchDeps`, and
    // `dispatchWorkflowByName` gets it handed to it rather than fetching again.
    expect(mockLoadRepoPolicy).toHaveBeenCalledTimes(1);
    const arg = mockDispatchWorkflowByName.mock.calls[0]?.[0] as { repoPolicy?: unknown };
    expect(arg.repoPolicy).toBe(realEffective.DEFAULT_REPO_POLICY);
  });

  it("caps triggerBodyPreview, which carries attacker-authored comment text", async () => {
    const long = "x".repeat(40_000);
    mockRouteNlTrigger.mockResolvedValue({
      kind: "command",
      command: { ...nlCommand("review"), comment_body: long },
      confidence: 0.95,
    });

    await dispatchCommentSurface(surfaceInput());
    await settle();

    const arg = mockDispatchWorkflowByName.mock.calls[0]?.[0] as { triggerBodyPreview: string };
    expect(arg.triggerBodyPreview).toHaveLength(200);
  });

  it("rethrows so the webhook handler can post its dispatch-failure reply", async () => {
    mockRouteNlTrigger.mockRejectedValue(new Error("bedrock 503"));

    // Swallowing here made the handler's `catch` unreachable, so an outage was
    // logged and the user saw only the 👀 reaction.
    let thrown: unknown = null;
    try {
      await dispatchCommentSurface(surfaceInput());
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error | null)?.message).toBe("bedrock 503");
  });

  it("logs nl.intent.resolved when the classifier answers none", async () => {
    mockRouteNlTrigger.mockResolvedValue({
      kind: "none",
      classified: true,
      classified_intent: "none",
      confidence: 0.4,
    });
    const lines: Record<string, unknown>[] = [];
    const log = silentLog();
    log.info = ((obj: Record<string, unknown>) => {
      lines.push(obj);
    }) as typeof log.info;

    const handled = await dispatchCommentSurface({ ...surfaceInput(), log });
    await settle();

    expect(handled).toBe(false);
    // With the second classifier gone this is the only trace that a mention was
    // classified and discarded.
    const resolved = lines.find((l) => l["event"] === "nl.intent.resolved");
    expect(resolved).toMatchObject({ intent: "none", rail: "none", confidence: 0.4 });
  });

  it("emits no log line when the mention gate declined before any LLM call", async () => {
    mockRouteNlTrigger.mockResolvedValue({ kind: "none", classified: false });
    const lines: Record<string, unknown>[] = [];
    const log = silentLog();
    log.info = ((obj: Record<string, unknown>) => {
      lines.push(obj);
    }) as typeof log.info;

    await dispatchCommentSurface({ ...surfaceInput(), log });
    await settle();

    expect(lines.find((l) => l["event"] === "nl.intent.resolved")).toBeUndefined();
  });

  it("derives target.type from the event surface, not from the pr field", async () => {
    mockRouteNlTrigger.mockResolvedValue({
      kind: "command",
      command: { ...nlCommand("plan"), event_surface: "issue-comment" },
      confidence: 0.95,
    });

    await dispatchCommentSurface(surfaceInput());
    await settle();

    // `pr.number` carries the issue number on issue surfaces, so the surface is
    // the only honest discriminator.
    const arg = mockDispatchWorkflowByName.mock.calls[0]?.[0] as {
      target: { type: string };
    };
    expect(arg.target.type).toBe("issue");
  });

  it("downgrades a low-confidence workflow verb to chat-thread instead of guessing", async () => {
    mockRouteNlTrigger.mockResolvedValue({
      kind: "command",
      command: nlCommand("review"),
      confidence: config.intentConfidenceThreshold - 0.01,
    });

    const handled = await dispatchCommentSurface(surfaceInput());
    await settle();

    expect(handled).toBe(true);
    expect(mockDispatchWorkflowByName).not.toHaveBeenCalled();
    // chat-thread is a scoped verb, so it lands on the scoped rail.
    expect(mockDispatchScopedCommand).toHaveBeenCalledTimes(1);
    const scoped = mockDispatchScopedCommand.mock.calls[0]?.[0] as { intent: string };
    expect(scoped.intent).toBe("chat-thread");
  });

  it("does NOT apply the threshold to ship-lifecycle verbs", async () => {
    mockRouteNlTrigger.mockResolvedValue({
      kind: "command",
      command: nlCommand("ship"),
      confidence: 0.1,
    });

    await dispatchCommentSurface(surfaceInput());
    await settle();

    // `stop` and friends must land even when the model is unsure: refusing to
    // act on a de-escalating verb strands the run it was meant to end.
    expect(mockRunShipFromCommand).toHaveBeenCalledTimes(1);
  });

  it("posts a refusal for an unsupported ask (FR-010)", async () => {
    mockRouteNlTrigger.mockResolvedValue({ kind: "unsupported", confidence: 0.9 });

    const handled = await dispatchCommentSurface(surfaceInput());

    expect(handled).toBe(true);
    expect(mockPostRefusalComment).toHaveBeenCalledTimes(1);
    expect(mockDispatchWorkflowByName).not.toHaveBeenCalled();
    expect(mockDispatchScopedCommand).not.toHaveBeenCalled();
  });

  it("returns false for 'none' so the caller knows nothing was claimed", async () => {
    mockRouteNlTrigger.mockResolvedValue({ kind: "none", classified: true });

    const handled = await dispatchCommentSurface(surfaceInput());

    expect(handled).toBe(false);
    expect(mockPostRefusalComment).not.toHaveBeenCalled();
  });
});
