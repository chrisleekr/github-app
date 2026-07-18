/**
 * Socket-health watchdog contract (issue #265).
 *
 * #264's signature is an EPOLLRDHUP storm: sockets stuck in CLOSE_WAIT while
 * the process pins a full CPU core. #265 does not fix that, it detects the
 * signature, logs it structurally so the next occurrence self-documents, and
 * optionally exits so k8s bounds the burn.
 *
 * The detector is pure and the runtime takes injected deps, so every case here
 * is deterministic on macOS and Linux CI. The only test that touches the real
 * filesystem is the default reader's missing-file path, which is exactly the
 * path a stubbed dep cannot exercise.
 */
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";

import type { CloseWaitSocket } from "../../src/orchestrator/proc-net-tcp";
import {
  createWatchdogState,
  evaluateSample,
  readProcNetAt,
  SELF_HEAL_EXIT_CODE,
  type SocketHealthDeps,
  startSocketHealthWatchdog,
  stopSocketHealthWatchdog,
  type WatchdogThresholds,
  type WatchdogVerdict,
} from "../../src/orchestrator/socket-health";
import {
  SOCKET_HEALTH_LOG_EVENTS,
  SocketCloseWaitDetectedSchema,
  SocketCloseWaitSpinSuspectedSchema,
} from "../../src/orchestrator/socket-health-log-fields";

const TCP4_PATH = fileURLToPath(new URL("./fixtures/proc-net-tcp.txt", import.meta.url));
const TCP6_PATH = fileURLToPath(new URL("./fixtures/proc-net-tcp6.txt", import.meta.url));
const MISSING_PATH = "/nonexistent/proc/net/tcp-does-not-exist";

const tcp4 = await Bun.file(TCP4_PATH).text();
const tcp6 = await Bun.file(TCP6_PATH).text();

/** The production shape from #264: five IPv4-mapped CLOSE_WAIT sockets on 3000. */
const WATCHED_PORT = 3000;
const FIXTURE_CLOSE_WAIT_COUNT = 5;

const THRESHOLDS: WatchdogThresholds = {
  leakSamples: 3,
  selfHealSamples: 10,
  cpuPercent: 90,
  selfHealEnabled: false,
};

const TICK_MS = 30_000;
/** One full core for `TICK_MS` of wall clock, expressed in CPU microseconds. */
const ONE_CORE_MICROS_PER_TICK = TICK_MS * 1000;

function sock(inode: string, remotePort: number): CloseWaitSocket {
  return {
    inode,
    local: "[::ffff:10.0.0.206]:3000",
    remote: `[::ffff:10.0.0.206]:${remotePort}`,
    rx_queue: 1,
  };
}

function expectLeak(v: WatchdogVerdict): Extract<WatchdogVerdict, { kind: "leak" }> {
  if (v.kind !== "leak") throw new Error(`expected a leak verdict, got "${v.kind}"`);
  return v;
}

function expectSpin(v: WatchdogVerdict): Extract<WatchdogVerdict, { kind: "spin" }> {
  if (v.kind !== "spin") throw new Error(`expected a spin verdict, got "${v.kind}"`);
  return v;
}

describe("evaluateSample: leak detection (C2, C3)", () => {
  it("stays quiet until a socket has been seen leakSamples times in a row", () => {
    const state = createWatchdogState();
    const s = sock("31005274", 59938);

    expect(evaluateSample(state, { sockets: [s], nowMs: 0, cpuMicros: 0 }, THRESHOLDS).kind).toBe(
      "quiet",
    );
    expect(
      evaluateSample(state, { sockets: [s], nowMs: 30_000, cpuMicros: 3_000_000 }, THRESHOLDS).kind,
    ).toBe("quiet");

    const verdict = evaluateSample(
      state,
      { sockets: [s], nowMs: 60_000, cpuMicros: 6_000_000 },
      THRESHOLDS,
    );
    expect(verdict.kind).toBe("leak");
  });

  it("reports the count, the window, the CPU rate and per-socket provenance", () => {
    const state = createWatchdogState();
    const s = sock("31005274", 59938);
    evaluateSample(state, { sockets: [s], nowMs: 0, cpuMicros: 0 }, THRESHOLDS);
    evaluateSample(state, { sockets: [s], nowMs: 30_000, cpuMicros: 3_000_000 }, THRESHOLDS);
    const leak = expectLeak(
      evaluateSample(state, { sockets: [s], nowMs: 60_000, cpuMicros: 6_000_000 }, THRESHOLDS),
    );

    expect(leak.fields.close_wait_sockets).toBe(1);
    // The window is the wall clock the CPU rate was averaged over, not the
    // socket age: 3s of CPU across the last 30s window is 0.1 cores.
    expect(leak.fields.window_ms).toBe(30_000);
    expect(leak.fields.cpu_cores_used).toBeCloseTo(0.1, 5);
    expect(leak.fields.sockets).toEqual([
      {
        inode: "31005274",
        local: "[::ffff:10.0.0.206]:3000",
        remote: "[::ffff:10.0.0.206]:59938",
        age_ms: 60_000,
        samples: 3,
      },
    ]);
  });

  it("emits a payload the strict detected schema accepts", () => {
    // Pins the detector's payload against the log-field contract, so the two
    // cannot drift apart without a test failing.
    const state = createWatchdogState();
    const s = sock("31005274", 59938);
    evaluateSample(state, { sockets: [s], nowMs: 0, cpuMicros: 0 }, THRESHOLDS);
    evaluateSample(state, { sockets: [s], nowMs: 30_000, cpuMicros: 3_000_000 }, THRESHOLDS);
    const leak = expectLeak(
      evaluateSample(state, { sockets: [s], nowMs: 60_000, cpuMicros: 6_000_000 }, THRESHOLDS),
    );

    const parsed = SocketCloseWaitDetectedSchema.safeParse({
      event: SOCKET_HEALTH_LOG_EVENTS.closeWaitDetected,
      ...leak.fields,
    });
    expect(parsed.success).toBe(true);
  });

  it("stays quiet when a CLOSE_WAIT socket drains after a single sample", () => {
    // The normal case: a socket passes through CLOSE_WAIT between two samples.
    const state = createWatchdogState();
    const s = sock("31005274", 59938);
    expect(evaluateSample(state, { sockets: [s], nowMs: 0, cpuMicros: 0 }, THRESHOLDS).kind).toBe(
      "quiet",
    );
    expect(
      evaluateSample(state, { sockets: [], nowMs: 30_000, cpuMicros: 100 }, THRESHOLDS).kind,
    ).toBe("quiet");
    expect(
      evaluateSample(state, { sockets: [], nowMs: 60_000, cpuMicros: 200 }, THRESHOLDS).kind,
    ).toBe("quiet");
    expect(
      evaluateSample(state, { sockets: [], nowMs: 90_000, cpuMicros: 300 }, THRESHOLDS).kind,
    ).toBe("quiet");
  });

  it("tracks each inode independently and only reports the persistent ones", () => {
    const state = createWatchdogState();
    const stuck = sock("31005274", 59938);
    evaluateSample(state, { sockets: [stuck], nowMs: 0, cpuMicros: 0 }, THRESHOLDS);
    evaluateSample(
      state,
      { sockets: [stuck, sock("31005275", 59942)], nowMs: 30_000, cpuMicros: 100 },
      THRESHOLDS,
    );
    const leak = expectLeak(
      evaluateSample(
        state,
        { sockets: [stuck, sock("31005276", 59954)], nowMs: 60_000, cpuMicros: 200 },
        THRESHOLDS,
      ),
    );

    // Two sockets are live, but only the one seen three times in a row is the
    // leak. The count is the live total, the list is the evidence.
    expect(leak.fields.close_wait_sockets).toBe(2);
    expect(leak.fields.sockets.map((s) => s.inode)).toEqual(["31005274"]);
  });

  it("caps the socket list at 20 while still counting them all", () => {
    const state = createWatchdogState();
    const many = Array.from({ length: 25 }, (_, i) => sock(String(40_000 + i), 50_000 + i));
    evaluateSample(state, { sockets: many, nowMs: 0, cpuMicros: 0 }, THRESHOLDS);
    evaluateSample(state, { sockets: many, nowMs: 30_000, cpuMicros: 100 }, THRESHOLDS);
    const leak = expectLeak(
      evaluateSample(state, { sockets: many, nowMs: 60_000, cpuMicros: 200 }, THRESHOLDS),
    );

    expect(leak.fields.close_wait_sockets).toBe(25);
    expect(leak.fields.sockets).toHaveLength(20);
    expect(
      SocketCloseWaitDetectedSchema.safeParse({
        event: SOCKET_HEALTH_LOG_EVENTS.closeWaitDetected,
        ...leak.fields,
      }).success,
    ).toBe(true);
  });
});

describe("evaluateSample: age tracking (C4)", () => {
  it("resets a socket's age and sample count when its inode disappears and returns", () => {
    // Inodes are reused by the kernel. A gap means a different socket, so the
    // age must restart rather than inflate and fake a long-lived leak.
    const state = createWatchdogState();
    const s = sock("31005274", 59938);
    evaluateSample(state, { sockets: [s], nowMs: 0, cpuMicros: 0 }, THRESHOLDS);
    evaluateSample(state, { sockets: [s], nowMs: 30_000, cpuMicros: 100 }, THRESHOLDS);
    evaluateSample(state, { sockets: [], nowMs: 60_000, cpuMicros: 200 }, THRESHOLDS);

    // Re-appears at 90_000, so three consecutive samples land at 90k/120k/150k.
    expect(
      evaluateSample(state, { sockets: [s], nowMs: 90_000, cpuMicros: 300 }, THRESHOLDS).kind,
    ).toBe("quiet");
    expect(
      evaluateSample(state, { sockets: [s], nowMs: 120_000, cpuMicros: 400 }, THRESHOLDS).kind,
    ).toBe("quiet");
    const leak = expectLeak(
      evaluateSample(state, { sockets: [s], nowMs: 150_000, cpuMicros: 500 }, THRESHOLDS),
    );

    expect(leak.fields.sockets[0]?.samples).toBe(3);
    // 150_000 - 90_000, not 150_000 - 0.
    expect(leak.fields.sockets[0]?.age_ms).toBe(60_000);
  });
});

describe("evaluateSample: spin detection (C7, C8, C10)", () => {
  const selfHeal: WatchdogThresholds = { ...THRESHOLDS, selfHealEnabled: true };

  function run(
    state: ReturnType<typeof createWatchdogState>,
    sockets: CloseWaitSocket[],
    ticks: number,
    cores: number,
    thresholds: WatchdogThresholds,
  ): WatchdogVerdict {
    let verdict: WatchdogVerdict = { kind: "quiet" };
    for (let i = 1; i <= ticks; i += 1) {
      verdict = evaluateSample(
        state,
        {
          sockets,
          nowMs: i * TICK_MS,
          cpuMicros: Math.round(i * cores * ONE_CORE_MICROS_PER_TICK),
        },
        thresholds,
      );
    }
    return verdict;
  }

  it("escalates to spin once the sockets persist and the CPU is pinned", () => {
    const state = createWatchdogState();
    const spin = expectSpin(run(state, [sock("31005274", 59938)], 10, 1.0, selfHeal));

    expect(spin.fields.close_wait_sockets).toBe(1);
    expect(spin.fields.cpu_cores_used).toBeCloseTo(1.0, 5);
    expect(spin.fields.self_heal_enabled).toBe(true);
    expect(spin.fields.sockets[0]?.samples).toBe(10);
  });

  it("reports leak, not spin, before selfHealSamples is reached", () => {
    const state = createWatchdogState();
    expect(run(state, [sock("31005274", 59938)], 9, 1.0, selfHeal).kind).toBe("leak");
  });

  it("reports leak, not spin, when the sockets persist but the CPU is idle", () => {
    // A pile of CLOSE_WAIT sockets on an idle process is a leak worth logging,
    // not the #264 storm, and must never justify killing the pod.
    const state = createWatchdogState();
    expect(run(state, [sock("31005274", 59938)], 20, 0.02, selfHeal).kind).toBe("leak");
  });

  it("treats the CPU threshold as inclusive of its configured floor", () => {
    const state = createWatchdogState();
    expect(run(state, [sock("31005274", 59938)], 10, 0.9, selfHeal).kind).toBe("spin");
  });

  it("stays a leak just under the CPU threshold", () => {
    const state = createWatchdogState();
    expect(run(state, [sock("31005274", 59938)], 10, 0.85, selfHeal).kind).toBe("leak");
  });

  it("carries self_heal_enabled=false through the spin verdict by default", () => {
    const state = createWatchdogState();
    const spin = expectSpin(run(state, [sock("31005274", 59938)], 10, 1.0, THRESHOLDS));
    expect(spin.fields.self_heal_enabled).toBe(false);
    expect(
      SocketCloseWaitSpinSuspectedSchema.safeParse({
        event: SOCKET_HEALTH_LOG_EVENTS.closeWaitSpinSuspected,
        ...spin.fields,
      }).success,
    ).toBe(true);
  });

  it("never spins on a pinned core with no CLOSE_WAIT sockets at all", () => {
    // The false positive that matters: `scheduler.scan` burns 13.5s of CPU in
    // one tick. Heavy work is not the #264 signature.
    const state = createWatchdogState();
    expect(run(state, [], 20, 1.0, selfHeal).kind).toBe("quiet");
  });

  it("never spins on a pinned core when CLOSE_WAIT sockets churn instead of persisting", () => {
    const state = createWatchdogState();
    let verdict: WatchdogVerdict = { kind: "quiet" };
    for (let i = 1; i <= 20; i += 1) {
      // A fresh inode every sample: healthy connection turnover under load.
      verdict = evaluateSample(
        state,
        {
          sockets: [sock(String(50_000 + i), 59_000 + i)],
          nowMs: i * TICK_MS,
          cpuMicros: i * ONE_CORE_MICROS_PER_TICK,
        },
        selfHeal,
      );
    }
    expect(verdict.kind).toBe("quiet");
  });
});

describe("evaluateSample: degenerate input", () => {
  it("reports a finite CPU rate when two samples land in the same millisecond", () => {
    const state = createWatchdogState();
    const s = sock("31005274", 59938);
    evaluateSample(state, { sockets: [s], nowMs: 1_000, cpuMicros: 0 }, THRESHOLDS);
    evaluateSample(state, { sockets: [s], nowMs: 1_000, cpuMicros: 500 }, THRESHOLDS);
    const leak = expectLeak(
      evaluateSample(state, { sockets: [s], nowMs: 1_000, cpuMicros: 900 }, THRESHOLDS),
    );

    expect(leak.fields.window_ms).toBe(0);
    expect(Number.isFinite(leak.fields.cpu_cores_used)).toBe(true);
    expect(leak.fields.cpu_cores_used).toBe(0);
  });
});

describe("readProcNetAt (C5)", () => {
  it("reads both files when they exist", async () => {
    const result = await readProcNetAt(TCP4_PATH, TCP6_PATH);
    expect(result?.tcp4).toBe(tcp4);
    expect(result?.tcp6).toBe(tcp6);
  });

  it("returns null when /proc/net/tcp is missing, and never throws", async () => {
    // The non-Linux case: no procfs means the watchdog has nothing to watch.
    expect(await readProcNetAt(MISSING_PATH, TCP6_PATH)).toBeNull();
    expect(await readProcNetAt(MISSING_PATH, MISSING_PATH)).toBeNull();
  });

  it("degrades to an empty tcp6 when only the IPv6 table is missing", async () => {
    // A kernel with IPv6 disabled has no /proc/net/tcp6 and no IPv6 sockets, so
    // the IPv4 table alone is complete rather than a reason to give up.
    const result = await readProcNetAt(TCP4_PATH, MISSING_PATH);
    expect(result?.tcp4).toBe(tcp4);
    expect(result?.tcp6).toBe("");
  });

  it("rejects on a non-ENOENT error (e.g. the path is a directory)", async () => {
    // Only ENOENT ("no procfs") disables the watchdog. Any other error, such as
    // reading a directory (EISDIR) or fd exhaustion (EMFILE), rejects so the
    // tick path logs `sample_failed` once instead of going silent.
    const dir = fileURLToPath(new URL("./fixtures", import.meta.url));
    let threw = false;
    try {
      await readProcNetAt(dir, TCP6_PATH);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("rejects on a non-ENOENT tcp6 error rather than silently emptying it", async () => {
    // Symmetric to the tcp4 case: a readable tcp4 plus a tcp6 that fails with a
    // non-ENOENT error (here EISDIR from a directory) must reject, so a real
    // IPv6-side fault surfaces as `sample_failed` instead of dropping IPv6
    // leaks under an "IPv6 disabled" guise.
    const dir = fileURLToPath(new URL("./fixtures", import.meta.url));
    let threw = false;
    try {
      await readProcNetAt(TCP4_PATH, dir);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

// The root logger writes JSON to stdout (no transport in NODE_ENV=test).
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as unknown as typeof process.stdout.write;
  try {
    await fn();
    return chunks.join("");
  } finally {
    // eslint-disable-next-line require-atomic-updates -- single-threaded test helper restoring a stubbed global
    process.stdout.write = original;
  }
}

function linesFor(out: string, event: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const line of out.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj["event"] === event) found.push(obj);
    } catch {
      // non-JSON line, skip
    }
  }
  return found;
}

interface HarnessState {
  nowMs: number;
  cpuMicros: number;
  readCalls: number;
  exitCodes: number[];
}

function makeHarness(read?: () => Promise<{ tcp4: string; tcp6: string } | null>): {
  state: HarnessState;
  deps: SocketHealthDeps;
} {
  const state: HarnessState = { nowMs: 0, cpuMicros: 0, readCalls: 0, exitCodes: [] };
  const deps: SocketHealthDeps = {
    readProcNet: () => {
      state.readCalls += 1;
      return read === undefined ? Promise.resolve({ tcp4, tcp6 }) : read();
    },
    cpuUsage: () => state.cpuMicros,
    now: () => state.nowMs,
    exit: (code: number) => {
      state.exitCodes.push(code);
    },
  };
  return { state, deps };
}

/** Drain the microtask queue so an in-flight async tick settles. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- draining microtasks in order
    await Promise.resolve();
  }
}

/** Advance fake time by `ms`, burning `cores` of CPU across that window. */
async function advance(state: HarnessState, ms: number, cores = 0): Promise<void> {
  state.nowMs += ms;
  state.cpuMicros += Math.round(cores * ms * 1000);
  jest.advanceTimersByTime(ms);
  await flush();
}

describe("startSocketHealthWatchdog: timer (C1, C11)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    stopSocketHealthWatchdog();
    jest.useRealTimers();
  });

  const quiet = (): Promise<{ tcp4: string; tcp6: string }> =>
    Promise.resolve({ tcp4: "", tcp6: "" });

  it("probes once at start and then samples once per interval", async () => {
    const { state, deps } = makeHarness(quiet);
    await startSocketHealthWatchdog({
      intervalMs: TICK_MS,
      port: WATCHED_PORT,
      ...THRESHOLDS,
      deps,
    });

    expect(state.readCalls).toBe(1);
    await advance(state, TICK_MS);
    expect(state.readCalls).toBe(2);
    await advance(state, TICK_MS);
    expect(state.readCalls).toBe(3);
  });

  it("clamps an interval below the floor up to 5s", async () => {
    const { state, deps } = makeHarness(quiet);
    await startSocketHealthWatchdog({ intervalMs: 1_000, port: WATCHED_PORT, ...THRESHOLDS, deps });

    await advance(state, 4_999);
    expect(state.readCalls).toBe(1);
    await advance(state, 1);
    expect(state.readCalls).toBe(2);
  });

  it("clamps an interval above the ceiling down to 300s", async () => {
    const { state, deps } = makeHarness(quiet);
    await startSocketHealthWatchdog({
      intervalMs: 999_999,
      port: WATCHED_PORT,
      ...THRESHOLDS,
      deps,
    });

    await advance(state, 299_999);
    expect(state.readCalls).toBe(1);
    await advance(state, 1);
    expect(state.readCalls).toBe(2);
  });

  it("does not probe or arm a timer when the interval is 0", async () => {
    const { state, deps } = makeHarness(quiet);
    const out = await captureStdout(async () => {
      await startSocketHealthWatchdog({ intervalMs: 0, port: WATCHED_PORT, ...THRESHOLDS, deps });
      await advance(state, 600_000);
    });

    expect(state.readCalls).toBe(0);
    expect(linesFor(out, SOCKET_HEALTH_LOG_EVENTS.watchdogDisabled)).toHaveLength(1);
  });

  it("is idempotent: a second start does not arm a second timer", async () => {
    const { state, deps } = makeHarness(quiet);
    await startSocketHealthWatchdog({
      intervalMs: TICK_MS,
      port: WATCHED_PORT,
      ...THRESHOLDS,
      deps,
    });
    await startSocketHealthWatchdog({
      intervalMs: TICK_MS,
      port: WATCHED_PORT,
      ...THRESHOLDS,
      deps,
    });

    const before = state.readCalls;
    await advance(state, TICK_MS);
    expect(state.readCalls).toBe(before + 1);
  });

  it("stops sampling after stopSocketHealthWatchdog", async () => {
    const { state, deps } = makeHarness(quiet);
    await startSocketHealthWatchdog({
      intervalMs: TICK_MS,
      port: WATCHED_PORT,
      ...THRESHOLDS,
      deps,
    });
    await advance(state, TICK_MS);
    expect(state.readCalls).toBe(2);

    stopSocketHealthWatchdog();
    await advance(state, TICK_MS * 10);
    expect(state.readCalls).toBe(2);
  });

  it("stop is idempotent and safe before any start", () => {
    expect(() => {
      stopSocketHealthWatchdog();
      stopSocketHealthWatchdog();
    }).not.toThrow();
  });
});

describe("startSocketHealthWatchdog: disabled and failing reads (C5, C6)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    stopSocketHealthWatchdog();
    jest.useRealTimers();
  });

  it("disables itself and arms no timer when the reader reports no procfs", async () => {
    const { state, deps } = makeHarness(() => Promise.resolve(null));
    const out = await captureStdout(async () => {
      await startSocketHealthWatchdog({
        intervalMs: TICK_MS,
        port: WATCHED_PORT,
        ...THRESHOLDS,
        deps,
      });
      await advance(state, TICK_MS * 10);
    });

    expect(state.readCalls).toBe(1);
    expect(linesFor(out, SOCKET_HEALTH_LOG_EVENTS.watchdogDisabled)).toHaveLength(1);
  });

  it("logs sample_failed at most once and keeps ticking when a read throws", async () => {
    // A permanently noisy warn line is worse than the leak it reports, but the
    // timer must survive so recovery is still observed.
    let calls = 0;
    const { state, deps } = makeHarness(() => {
      calls += 1;
      return calls === 1
        ? Promise.resolve({ tcp4, tcp6 })
        : Promise.reject(new Error("procfs read failed"));
    });

    const out = await captureStdout(async () => {
      await startSocketHealthWatchdog({
        intervalMs: TICK_MS,
        port: WATCHED_PORT,
        ...THRESHOLDS,
        deps,
      });
      await advance(state, TICK_MS);
      await advance(state, TICK_MS);
      await advance(state, TICK_MS);
    });

    expect(state.readCalls).toBe(4);
    expect(linesFor(out, SOCKET_HEALTH_LOG_EVENTS.watchdogSampleFailed)).toHaveLength(1);
  });
});

describe("startSocketHealthWatchdog: detection (C2)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    stopSocketHealthWatchdog();
    jest.useRealTimers();
  });

  it("emits socket.close_wait.detected once the fixture's sockets persist", async () => {
    const { state, deps } = makeHarness();
    const out = await captureStdout(async () => {
      await startSocketHealthWatchdog({
        intervalMs: TICK_MS,
        port: WATCHED_PORT,
        ...THRESHOLDS,
        deps,
      });
      await advance(state, TICK_MS, 0.1);
      await advance(state, TICK_MS, 0.1);
      await advance(state, TICK_MS, 0.1);
    });

    const detected = linesFor(out, SOCKET_HEALTH_LOG_EVENTS.closeWaitDetected);
    expect(detected).toHaveLength(1);
    const line = detected[0];
    expect(line?.["component"]).toBe("socket-health");
    expect(line?.["close_wait_sockets"]).toBe(FIXTURE_CLOSE_WAIT_COUNT);
    expect(line?.["window_ms"]).toBe(TICK_MS);
    expect(line?.["cpu_cores_used"]).toBeCloseTo(0.1, 5);

    const sockets = line?.["sockets"] as { inode: string; local: string; samples: number }[];
    expect(sockets).toHaveLength(FIXTURE_CLOSE_WAIT_COUNT);
    expect(sockets.every((s) => s.local === "[::ffff:10.0.0.206]:3000")).toBe(true);
    expect(sockets.every((s) => s.samples === 3)).toBe(true);
    expect(sockets.map((s) => s.inode).sort()).toEqual([
      "31005273",
      "31005274",
      "31005275",
      "31005276",
      "31005278",
    ]);
  });

  it("emits nothing while the watched port has no CLOSE_WAIT sockets", async () => {
    const { state, deps } = makeHarness();
    const out = await captureStdout(async () => {
      // Port 65000 exists in neither table.
      await startSocketHealthWatchdog({ intervalMs: TICK_MS, port: 65_000, ...THRESHOLDS, deps });
      for (let i = 0; i < 12; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- ticks must be sequential
        await advance(state, TICK_MS, 1.0);
      }
    });

    expect(linesFor(out, SOCKET_HEALTH_LOG_EVENTS.closeWaitDetected)).toHaveLength(0);
    expect(linesFor(out, SOCKET_HEALTH_LOG_EVENTS.closeWaitSpinSuspected)).toHaveLength(0);
    expect(state.exitCodes).toEqual([]);
  });
});

describe("startSocketHealthWatchdog: self-heal (C7, C8, C9)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    stopSocketHealthWatchdog();
    jest.useRealTimers();
  });

  async function runToSpin(
    selfHealEnabled: boolean,
  ): Promise<{ out: string; state: HarnessState }> {
    const { state, deps } = makeHarness();
    const out = await captureStdout(async () => {
      await startSocketHealthWatchdog({
        intervalMs: TICK_MS,
        port: WATCHED_PORT,
        ...THRESHOLDS,
        selfHealEnabled,
        deps,
      });
      for (let i = 0; i < THRESHOLDS.selfHealSamples; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- ticks must be sequential
        await advance(state, TICK_MS, 1.0);
      }
    });
    return { out, state };
  }

  it("suspects a spin and exits 75 when self-heal is enabled", async () => {
    const { out, state } = await runToSpin(true);

    const spin = linesFor(out, SOCKET_HEALTH_LOG_EVENTS.closeWaitSpinSuspected);
    expect(spin).toHaveLength(1);
    expect(spin[0]?.["self_heal_enabled"]).toBe(true);
    expect(spin[0]?.["close_wait_sockets"]).toBe(FIXTURE_CLOSE_WAIT_COUNT);
    expect(spin[0]?.["cpu_cores_used"]).toBeCloseTo(1.0, 5);

    const exit = linesFor(out, SOCKET_HEALTH_LOG_EVENTS.closeWaitSelfHealExit);
    expect(exit).toHaveLength(1);
    expect(exit[0]?.["close_wait_sockets"]).toBe(FIXTURE_CLOSE_WAIT_COUNT);

    expect(state.exitCodes).toEqual([SELF_HEAL_EXIT_CODE]);
  });

  it("uses EX_TEMPFAIL (75) so k8s can tell a self-heal from a real crash", () => {
    expect(SELF_HEAL_EXIT_CODE).toBe(75);
  });

  it("suspects a spin but never exits when self-heal is disabled (the default)", async () => {
    const { out, state } = await runToSpin(false);

    const spin = linesFor(out, SOCKET_HEALTH_LOG_EVENTS.closeWaitSpinSuspected);
    expect(spin).toHaveLength(1);
    expect(spin[0]?.["self_heal_enabled"]).toBe(false);
    expect(linesFor(out, SOCKET_HEALTH_LOG_EVENTS.closeWaitSelfHealExit)).toHaveLength(0);
    expect(state.exitCodes).toEqual([]);
  });

  it("exits inside the deciding tick, with no drain or delay of its own", async () => {
    // #264's proposed `server.setTimeout` fix was disproven: anything that
    // waits on the socket layer is exactly what is wedged. `advance` only
    // drains microtasks, so a self-heal that parked work on a timer would
    // leave exitCodes empty here.
    const { state } = await runToSpin(true);
    expect(state.exitCodes).toEqual([SELF_HEAL_EXIT_CODE]);
  });

  it("does not couple the watchdog to the http server or to config", async () => {
    // The module must stay a leaf: it takes a port and its deps from the
    // caller, so it can never reach for `server.close()` on the way out.
    const source = await Bun.file(
      new URL("../../src/orchestrator/socket-health.ts", import.meta.url),
    ).text();

    expect(source).not.toMatch(/from\s+"\.\.\/app"/);
    expect(source).not.toMatch(/from\s+"\.\.\/config"/);
    expect(source).not.toMatch(/\bserver\s*\.\s*close\s*\(/);
    expect(source).not.toMatch(/\bcloseAllConnections\s*\(/);
  });
});

describe("stopSocketHealthWatchdog: in-flight sample (CR3b)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    stopSocketHealthWatchdog();
    jest.useRealTimers();
  });

  it("a sample still awaiting when the watchdog is stopped neither logs nor exits", async () => {
    // The self-heal mechanism's own hazard: an async sample already past its
    // read when stop() fires could otherwise complete and log or exit(75)
    // against a torn-down watchdog. The generation guard must suppress it.
    let resolvePending: (() => void) | null = null;
    let calls = 0;
    const exitCodes: number[] = [];
    const deps: SocketHealthDeps = {
      readProcNet: () => {
        calls += 1;
        // Probe (call 1) plus the first two ticks resolve immediately, building
        // the fixture sockets toward the 3-sample leak threshold. The third
        // sample stays pending so we can stop the watchdog mid-flight; without
        // the stop it would be the first `detected` emit.
        if (calls <= 3) return Promise.resolve({ tcp4, tcp6 });
        return new Promise<{ tcp4: string; tcp6: string }>((resolve) => {
          resolvePending = () => {
            resolve({ tcp4, tcp6 });
          };
        });
      },
      cpuUsage: () => 0,
      now: () => calls * TICK_MS,
      exit: (code: number) => {
        exitCodes.push(code);
      },
    };

    const out = await captureStdout(async () => {
      await startSocketHealthWatchdog({
        intervalMs: TICK_MS,
        port: WATCHED_PORT,
        ...THRESHOLDS,
        selfHealEnabled: true,
        deps,
      });
      jest.advanceTimersByTime(TICK_MS); // tick 1 (call 2), quiet
      await flush();
      jest.advanceTimersByTime(TICK_MS); // tick 2 (call 3), quiet
      await flush();
      jest.advanceTimersByTime(TICK_MS); // tick 3 (call 4), read stays pending
      await flush();
      stopSocketHealthWatchdog();
      resolvePending?.();
      await flush();
    });

    // Without the guard this resolved sample would be the first leak (3rd
    // consecutive) and log `detected`; the stop must make it a no-op.
    expect(linesFor(out, SOCKET_HEALTH_LOG_EVENTS.closeWaitDetected)).toHaveLength(0);
    expect(linesFor(out, SOCKET_HEALTH_LOG_EVENTS.closeWaitSpinSuspected)).toHaveLength(0);
    expect(exitCodes).toEqual([]);
  });
});
