import { beforeEach, describe, expect, it, mock } from "bun:test";

import {
  mintInstallationToken,
  revokeInstallationToken,
} from "../../src/orchestrator/installation-token";
import { expectToReject } from "../utils/assertions";

const createInstallationAccessToken = mock(() =>
  Promise.resolve({
    data: {
      token: "ghs_scoped",
      expires_at: "2026-08-23T04:00:00Z",
    },
  }),
);
const before = mock(() => undefined);
const remove = mock(() => undefined);
const log = {
  info: mock(() => undefined),
  warn: mock(() => undefined),
  error: mock(() => undefined),
  debug: mock(() => undefined),
  child: mock(function (this: unknown): unknown {
    return this;
  }),
};
const app = {
  octokit: {
    hook: { before, remove },
    rest: { apps: { createInstallationAccessToken } },
  },
};

describe("scoped installation token mint", () => {
  beforeEach(() => {
    createInstallationAccessToken.mockReset();
    createInstallationAccessToken.mockResolvedValue({
      data: { token: "ghs_scoped", expires_at: "2026-08-23T04:00:00Z" },
    });
    before.mockClear();
    remove.mockClear();
    log.info.mockClear();
    log.warn.mockClear();
  });

  it("returns the authoritative expiry and restricts the mint to one repository", async () => {
    const result = await mintInstallationToken({
      app: app as never,
      installationId: 123,
      repositoryName: "widgets",
      via: "workflowRunnerPayload",
      log: log as never,
    });

    expect(createInstallationAccessToken).toHaveBeenCalledWith({
      installation_id: 123,
      repositories: ["widgets"],
    });
    expect(result.token).toBe("ghs_scoped");
    expect(result.expiresAt).toBe("2026-08-23T04:00:00Z");
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("rejects a schema-invalid expiry", async () => {
    createInstallationAccessToken.mockResolvedValueOnce({
      data: { token: "ghs_scoped", expires_at: "not-a-timestamp" },
    });

    await expectToReject(
      mintInstallationToken({
        app: app as never,
        installationId: 123,
        repositoryName: "widgets",
        via: "workflowRunnerPayload",
        log: log as never,
      }),
      "Invalid ISO datetime",
    );
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe("installation token revocation", () => {
  beforeEach(() => {
    log.error.mockClear();
  });

  it("uses a bounded request and reports success", async () => {
    const request = mock(() => Promise.resolve());

    expect(await revokeInstallationToken({ request } as never, log as never)).toBe(true);

    expect(request).toHaveBeenCalledWith("DELETE /installation/token", {
      request: { signal: expect.any(AbortSignal) },
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  it("logs a revocation failure without throwing into the owner cleanup path", async () => {
    const failure = new Error("GitHub unavailable");
    const request = mock(() => Promise.reject(failure));

    expect(
      await revokeInstallationToken({ request } as never, log as never, {
        attemptId: "attempt-1",
      }),
    ).toBe(false);

    expect(log.error).toHaveBeenCalledWith(
      { attemptId: "attempt-1", err: failure },
      "Installation token revocation failed",
    );
  });
});
