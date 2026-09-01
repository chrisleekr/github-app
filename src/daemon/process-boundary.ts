import { platform } from "node:os";

const EXPECTED_DENIAL_EXIT_CODE = 77;
const PROCESS_GUARD_PATH = "/usr/local/lib/github-app/daemon-process-guard.so";

export function daemonEnvironmentBoundaryFailure(input: {
  readonly platform: NodeJS.Platform;
  readonly preload: string | undefined;
  readonly probeExitCode: number | null;
}): string | null {
  if (input.platform !== "linux") return null;
  if (input.probeExitCode === EXPECTED_DENIAL_EXIT_CODE) return null;
  const guardInstalled = input.preload?.split(/[:\s]+/).includes(PROCESS_GUARD_PATH) === true;
  if (!guardInstalled) {
    return `daemon process guard is not installed at ${PROCESS_GUARD_PATH}`;
  }
  if (input.probeExitCode === 0) return "daemon process guard is installed but ineffective";
  return `daemon environment isolation probe failed with exit code ${String(input.probeExitCode)}`;
}

/** Fail daemon startup if a same-UID child can inspect the parent environment. */
export function assertDaemonEnvironmentPrivate(): void {
  const runtimePlatform = platform();
  if (runtimePlatform !== "linux") return;

  const target = `/proc/${String(process.pid)}/environ`;
  const script = `
    const { readFileSync } = require("node:fs");
    try {
      readFileSync(${JSON.stringify(target)});
      process.exit(0);
    } catch (error) {
      process.exit(error?.code === "EACCES" || error?.code === "EPERM" ? 77 : 78);
    }
  `;
  const probe = Bun.spawnSync([process.execPath, "--eval", script], {
    env: {},
    stdout: "ignore",
    stderr: "ignore",
  });

  const failure = daemonEnvironmentBoundaryFailure({
    platform: runtimePlatform,
    preload: process.env["LD_PRELOAD"],
    probeExitCode: probe.exitCode,
  });
  if (failure !== null) throw new Error(failure);
}
