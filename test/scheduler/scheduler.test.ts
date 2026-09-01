/**
 * The document-level `enabled: false` master switch on the manual run path.
 *
 * Gate 1 (`src/repo-config/gate.ts`) covers the label and mention surfaces,
 * but a scheduled action is unattended: nothing else stands between the
 * config and an agent run, so this short-circuit is the only thing a repo
 * owner has to silence cron.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { App } from "octokit";

const mockIsOwnerAllowed = mock(() => ({ allowed: true }));
void mock.module("../../src/webhook/authorize", () => ({ isOwnerAllowed: mockIsOwnerAllowed }));

void mock.module("../../src/orchestrator/installation-token", () => ({
  mintInstallationToken: () => Promise.resolve({ octokit: {} }),
}));

const mockEnqueueJob = mock(() => Promise.resolve());
void mock.module("../../src/orchestrator/job-queue", () => ({ enqueueJob: mockEnqueueJob }));

const mockFetchRepoConfig = mock(() => Promise.resolve({ kind: "absent" as const }));
void mock.module("../../src/repo-config/fetcher", () => ({ fetchRepoConfig: mockFetchRepoConfig }));

const { githubAppConfigSchema } = await import("../../src/repo-config/schema");
const { createScheduler } = await import("../../src/scheduler/scheduler");

const fakeApp = {
  octokit: { rest: { apps: { getRepoInstallation: () => Promise.resolve({ data: { id: 1 } }) } } },
} as unknown as App;

/** An `ok` fetch result carrying a one-action document. */
function okConfig(enabled: boolean): { kind: "ok"; config: unknown; sha: string } {
  return {
    kind: "ok",
    config: githubAppConfigSchema.parse({
      version: 1,
      enabled,
      scheduled_actions: [{ name: "research", cron: "0 19 * * *", prompt: { inline: "hi" } }],
    }),
    sha: "sha-1",
  };
}

describe("runAction", () => {
  beforeEach(() => {
    mockEnqueueJob.mockClear();
    mockFetchRepoConfig.mockClear();
  });

  it("refuses when the repo-wide switch is off, before claiming a slot", async () => {
    mockFetchRepoConfig.mockResolvedValue(okConfig(false) as never);

    const result = await createScheduler({ app: fakeApp }).runAction({
      owner: "acme",
      repo: "repo",
      actionName: "research",
    });

    expect(result).toEqual({
      enqueued: false,
      reason: "the bot is disabled for this repository",
    });
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it("gets past the switch when it is on, so the refusal above is the switch firing", async () => {
    mockFetchRepoConfig.mockResolvedValue(okConfig(true) as never);

    // A name that does not exist: proves execution reached the action lookup,
    // which sits after the switch, without a DB round trip for the slot claim.
    const result = await createScheduler({ app: fakeApp }).runAction({
      owner: "acme",
      repo: "repo",
      actionName: "nope",
    });

    expect(result).toEqual({ enqueued: false, reason: 'action "nope" not found' });
  });
});
