import { describe, expect, it } from "bun:test";

import { daemonEnvironmentBoundaryFailure } from "../../src/daemon/process-boundary";

const guardPath = "/usr/local/lib/github-app/daemon-process-guard.so";

describe("daemon process boundary", () => {
  it("does not require the Linux preload guard on other platforms", () => {
    expect(
      daemonEnvironmentBoundaryFailure({
        platform: "darwin",
        preload: undefined,
        probeExitCode: 0,
      }),
    ).toBeNull();
  });

  it("distinguishes a missing guard from an ineffective guard", () => {
    expect(
      daemonEnvironmentBoundaryFailure({
        platform: "linux",
        preload: undefined,
        probeExitCode: 0,
      }),
    ).toContain("not installed");
    expect(
      daemonEnvironmentBoundaryFailure({
        platform: "linux",
        preload: guardPath,
        probeExitCode: 0,
      }),
    ).toBe("daemon process guard is installed but ineffective");
  });

  it("accepts only the child probe's permission-denied exit", () => {
    expect(
      daemonEnvironmentBoundaryFailure({
        platform: "linux",
        preload: undefined,
        probeExitCode: 77,
      }),
    ).toBeNull();
    expect(
      daemonEnvironmentBoundaryFailure({
        platform: "linux",
        preload: guardPath,
        probeExitCode: 78,
      }),
    ).toContain("exit code 78");
  });
});
