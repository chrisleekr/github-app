import { hostname } from "node:os";

import { describe, expect, it } from "bun:test";

import { getInstanceId } from "../../src/orchestrator/instance-id";

const INSTANCE_ID_MODULE = new URL("../../src/orchestrator/instance-id.ts", import.meta.url).href;
const UUID_SUFFIX = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function getInstanceIdFromFreshProcess(): string {
  const script = `import { getInstanceId } from ${JSON.stringify(INSTANCE_ID_MODULE)}; process.stdout.write(getInstanceId());`;
  const proc = Bun.spawnSync(["bun", "--eval", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(proc.exitCode).toBe(0);
  expect(proc.stderr.toString()).toBe("");
  return proc.stdout.toString();
}

describe("getInstanceId", () => {
  it("caches one process-incarnation id across calls", () => {
    const first = getInstanceId();

    expect(getInstanceId()).toBe(first);
    expect(first.startsWith(`${hostname()}-`)).toBe(true);
    expect(first).toMatch(UUID_SUFFIX);
  });

  it("uses a different incarnation id in two fresh orchestrator processes", () => {
    const firstBoot = getInstanceIdFromFreshProcess();
    const secondBoot = getInstanceIdFromFreshProcess();

    expect(firstBoot).not.toBe(secondBoot);
    expect(firstBoot.startsWith(`${hostname()}-`)).toBe(true);
    expect(secondBoot.startsWith(`${hostname()}-`)).toBe(true);
    expect(firstBoot).toMatch(UUID_SUFFIX);
    expect(secondBoot).toMatch(UUID_SUFFIX);
  });
});
