/**
 * The two behaviours the retired `dispatchByIntent` used to own, now that the
 * scoped rail is the only path to chat-thread.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";
import type pino from "pino";

let dbHandle: unknown = null;
void mock.module("../../../../src/db", () => ({
  getDb: (): unknown => dbHandle,
  requireDb: (): unknown => dbHandle,
}));

const mockRunChatThread = mock(() => Promise.resolve({ mode: "answered" }));
void mock.module("../../../../src/workflows/ship/scoped/chat-thread", () => ({
  runChatThread: mockRunChatThread,
}));

const mockCreate = mock((_params: { maxTokens: number }) =>
  Promise.resolve({ text: "{}", usage: { inputTokens: 1, outputTokens: 1 }, model: "m" }),
);
void mock.module("../../../../src/webhook/triage-client-factory", () => ({
  getTriageLLMClient: (): unknown => ({ provider: "anthropic", create: mockCreate }),
}));

const realTrackingMirror = await import("../../../../src/workflows/tracking-mirror");
const mockPostRefusalComment = mock(
  (_deps: unknown, _target: unknown, _name: string, _reason: string) => Promise.resolve(),
);
void mock.module("../../../../src/workflows/tracking-mirror", () => ({
  ...realTrackingMirror,
  postRefusalComment: mockPostRefusalComment,
}));

const { runChatThreadFromCommand } =
  await import("../../../../src/workflows/ship/scoped/dispatch-scoped");

import type { CanonicalCommand } from "../../../../src/shared/ship-types";

function silentLog(): pino.Logger {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    child: mock(function (this: unknown) {
      return this;
    }),
  } as unknown as pino.Logger;
}

const fakeOctokit = {} as unknown as Octokit;

function chatCommand(): CanonicalCommand {
  return {
    intent: "chat-thread",
    surface: "nl",
    principal_login: "alice",
    pr: { owner: "acme", repo: "repo", number: 42, installation_id: 1 },
    event_surface: "pr-comment",
    comment_body: "@chrisleekr-bot what does this function do?",
    trigger_comment_id: 555,
  };
}

describe("runChatThreadFromCommand: inline-mode guard", () => {
  beforeEach(() => {
    mockRunChatThread.mockClear();
    mockPostRefusalComment.mockClear();
  });

  it("posts a coherent refusal instead of running when DATABASE_URL is unset", async () => {
    dbHandle = null;

    await runChatThreadFromCommand(chatCommand(), { octokit: fakeOctokit, log: silentLog() });

    // Without this guard the executor reaches `requireDb()` deep inside its
    // first cache read and the user sees nothing at all.
    expect(mockRunChatThread).not.toHaveBeenCalled();
    expect(mockPostRefusalComment).toHaveBeenCalledTimes(1);
    const reason = mockPostRefusalComment.mock.calls[0]?.[3] ?? "";
    expect(reason).toContain("database backend");
  });

  it("runs chat-thread normally when a database is configured", async () => {
    dbHandle = {};

    await runChatThreadFromCommand(chatCommand(), { octokit: fakeOctokit, log: silentLog() });

    expect(mockPostRefusalComment).not.toHaveBeenCalled();
    expect(mockRunChatThread).toHaveBeenCalledTimes(1);
  });

  it("still refuses a command that carries no comment fields, before the DB check", async () => {
    dbHandle = {};
    const { comment_body: _body, ...withoutBody } = chatCommand();

    await runChatThreadFromCommand(withoutBody as CanonicalCommand, {
      octokit: fakeOctokit,
      log: silentLog(),
    });

    expect(mockRunChatThread).not.toHaveBeenCalled();
    expect(mockPostRefusalComment).not.toHaveBeenCalled();
  });
});

describe("buildCallLlm output budget", () => {
  beforeEach(() => {
    mockRunChatThread.mockClear();
    mockCreate.mockClear();
    dbHandle = {};
  });

  it("gives the tool-less branch the same budget as the tool loop", async () => {
    await runChatThreadFromCommand(chatCommand(), { octokit: fakeOctokit, log: silentLog() });

    const passed = mockRunChatThread.mock.calls[0]?.[0] as unknown as {
      callLlm: (i: { systemPrompt: string; userPrompt: string }) => Promise<string>;
    };
    await passed.callLlm({ systemPrompt: "sys", userPrompt: "user" });

    // chat-thread runs tool-less on issue surfaces and whenever the tools flag
    // is off. 800 truncated the structured answer into a parse failure, and
    // this rail now also absorbs the classifier's outage fallback.
    expect(mockCreate.mock.calls[0]?.[0]?.maxTokens).toBe(1500);
  });
});
