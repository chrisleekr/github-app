import { hostname } from "node:os";

import { describe, expect, it } from "bun:test";

import { getDaemonId } from "../../src/daemon/daemon-id";

const DAEMON_ID_MODULE = new URL("../../src/daemon/daemon-id.ts", import.meta.url).href;
const UUID_SUFFIX = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function getDaemonIdFromFreshProcess(): string {
  const script = `import { getDaemonId } from ${JSON.stringify(DAEMON_ID_MODULE)}; process.stdout.write(getDaemonId());`;
  const proc = Bun.spawnSync(["bun", "--eval", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(proc.exitCode).toBe(0);
  expect(proc.stderr.toString()).toBe("");
  return proc.stdout.toString();
}

describe("getDaemonId", () => {
  it("caches one process-incarnation id across calls and reconnects", () => {
    const first = getDaemonId();

    expect(getDaemonId()).toBe(first);
    expect(first.startsWith(`daemon-${hostname()}-`)).toBe(true);
    expect(first).toMatch(UUID_SUFFIX);
  });

  it("uses a different incarnation id in two fresh daemon processes", () => {
    const firstBoot = getDaemonIdFromFreshProcess();
    const secondBoot = getDaemonIdFromFreshProcess();

    expect(firstBoot).not.toBe(secondBoot);
    expect(firstBoot.startsWith(`daemon-${hostname()}-`)).toBe(true);
    expect(secondBoot.startsWith(`daemon-${hostname()}-`)).toBe(true);
    expect(firstBoot).toMatch(UUID_SUFFIX);
    expect(secondBoot).toMatch(UUID_SUFFIX);
  });
});
