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
  // null means the probe was killed by a signal, not that it exited with a
  // status. Rendering it as "exit code null" points diagnosis the wrong way.
  if (input.probeExitCode === null) {
    return "daemon environment isolation probe was killed by a signal";
  }
  return `daemon environment isolation probe failed with exit code ${String(input.probeExitCode)}`;
}

/**
 * Throw if a same-UID child can read this process's environment.
 *
 * Called by `process-boundary-smoke.ts`, the entrypoint the daemon image build
 * runs to prove the guard is installed and effective in the built image. The
 * daemon startup path wires it separately.
 */
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
