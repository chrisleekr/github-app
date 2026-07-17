/**
 * CLOSE_WAIT socket-spin watchdog (issue #265).
 *
 * ## What this is for
 *
 * Issue #264: the orchestrator burned exactly 1.000 CPU core, forever, in an
 * EPOLLRDHUP storm over ~7 sockets wedged in CLOSE_WAIT. The container ran
 * that way for 14 days and then died with `reason=Error`, leaving nothing to
 * read. Three labs (~28k socket closes) could not reproduce it.
 *
 * ## What this does NOT do
 *
 * It does not fix #264. The root cause is unknown and the fix proposed there
 * (`server.setTimeout()`) was disproven: the timer runs on a 4s wheel whatever
 * value you pass, and it drops any response that takes longer than the
 * timeout, which `scheduler.scan` (13.5s) legitimately does.
 *
 * This module does two narrower things instead:
 *
 * 1. Detects the signature and logs it structurally, so the next occurrence
 *    self-documents instead of being a mystery core burn.
 * 2. Optionally self-heals by exiting non-zero so k8s restarts the pod, which
 *    bounds the burn to one sample window instead of two weeks.
 *
 * ## Why persistent CLOSE_WAIT is the trigger and CPU never is
 *
 * A pinned core is not by itself a fault: `scheduler.scan` burns 13.5s of CPU
 * in a single tick and is entirely healthy. The discriminator is CLOSE_WAIT
 * sockets that survive sample after sample. CPU only ever escalates an
 * already-persistent leak from "detected" to "spin suspected". No amount of
 * CPU alone can trigger a self-heal.
 *
 * ## Shape
 *
 * A pure detector (`createWatchdogState` + `evaluateSample`) plus a thin
 * timer around it. The module is a leaf on purpose: it takes the port and its
 * dependencies from the caller and imports neither `config` nor the HTTP
 * server, so the self-heal path cannot reach for a graceful drain. Draining
 * through the socket layer is exactly what is wedged.
 */
import { readFile } from "node:fs/promises";

import { logger } from "../logger";
import { type CloseWaitSocket, collectCloseWaitSockets } from "./proc-net-tcp";
import { SOCKET_HEALTH_LOG_EVENTS } from "./socket-health-log-fields";

/**
 * EX_TEMPFAIL from sysexits.h. Deliberately not 1: a distinct code lets
 * `lastState.terminated.exitCode` tell a self-heal apart from a real crash.
 * The #264 container died `reason=Error` with no trace and the two were
 * indistinguishable after the fact.
 */
export const SELF_HEAL_EXIT_CODE = 75;

const MIN_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 300_000;

// Threshold bounds, clamped here at the consumer rather than in zod so a typo
// cannot defeat the persistence logic: leakSamples of 1 would flag every
// transient CLOSE_WAIT, and a cpuPercent of 1 would treat any load as a spin.
const MIN_LEAK_SAMPLES = 2;
const MAX_LEAK_SAMPLES = 100;
const MIN_SELF_HEAL_SAMPLES = 2;
const MAX_SELF_HEAL_SAMPLES = 1_000;
const MIN_CPU_PERCENT = 50;
const MAX_CPU_PERCENT = 100;

/** Bound on the per-socket evidence list, so a storm cannot produce a huge log line. */
const MAX_LOGGED_SOCKETS = 20;

const PROC_NET_TCP4 = "/proc/net/tcp";
const PROC_NET_TCP6 = "/proc/net/tcp6";

const log = logger.child({ component: "socket-health" });

/** Per-socket evidence emitted with a detected / spin_suspected line. */
export interface WatchdogSocketDetail {
  inode: string;
  local: string;
  remote: string;
  age_ms: number;
  samples: number;
}

/** The log payload shared by the two CLOSE_WAIT verdicts. Snake_case: these fields are logged verbatim. */
export interface WatchdogFields {
  close_wait_sockets: number;
  window_ms: number;
  cpu_cores_used: number;
  sockets: WatchdogSocketDetail[];
}

/**
 * The detector's answer for one sample. `fields` is spread straight into the
 * matching log line, so the shapes here and in `socket-health-log-fields.ts`
 * are pinned against each other by test.
 */
export type WatchdogVerdict =
  | { kind: "quiet" }
  | { kind: "leak"; fields: WatchdogFields }
  | { kind: "spin"; fields: WatchdogFields & { self_heal_enabled: boolean } };

export interface WatchdogSample {
  sockets: CloseWaitSocket[];
  nowMs: number;
  /** Cumulative process CPU time in microseconds. Rates come from the delta between samples. */
  cpuMicros: number;
}

export interface WatchdogThresholds {
  /** Consecutive samples a socket must survive before it counts as leaked. */
  leakSamples: number;
  /** Consecutive samples before a leak plus a pinned core is treated as a spin. */
  selfHealSamples: number;
  /** CPU floor for a spin, as a percentage of one core. */
  cpuPercent: number;
  selfHealEnabled: boolean;
}

interface TrackedSocket {
  firstSeenMs: number;
  samples: number;
  socket: CloseWaitSocket;
}

export interface WatchdogState {
  tracked: Map<string, TrackedSocket>;
  prev: { nowMs: number; cpuMicros: number } | null;
}

export function createWatchdogState(): WatchdogState {
  return { tracked: new Map(), prev: null };
}

/**
 * Fold one sample into `state` and classify it. Pure apart from mutating the
 * state it is handed, so the whole state machine is testable without timers.
 *
 * A socket that vanishes is forgotten entirely, so a later socket reusing its
 * inode starts a fresh age rather than inheriting a fake multi-hour lifetime.
 */
export function evaluateSample(
  state: WatchdogState,
  sample: WatchdogSample,
  thresholds: WatchdogThresholds,
): WatchdogVerdict {
  const live = new Set(sample.sockets.map((s) => s.inode));
  for (const inode of [...state.tracked.keys()]) {
    if (!live.has(inode)) state.tracked.delete(inode);
  }
  for (const socket of sample.sockets) {
    const tracked = state.tracked.get(socket.inode);
    if (tracked === undefined) {
      state.tracked.set(socket.inode, { firstSeenMs: sample.nowMs, samples: 1, socket });
    } else {
      tracked.samples += 1;
      tracked.socket = socket;
    }
  }

  // The first sample has no predecessor, and two samples can in principle land
  // in the same millisecond. Both would divide by zero, so report no rate
  // rather than a NaN or an Infinity that could fake a spin.
  const windowMs = state.prev === null ? 0 : Math.max(0, sample.nowMs - state.prev.nowMs);
  const cpuDeltaMicros =
    state.prev === null ? 0 : Math.max(0, sample.cpuMicros - state.prev.cpuMicros);
  const cpuCoresUsed = windowMs === 0 ? 0 : cpuDeltaMicros / (windowMs * 1000);
  state.prev = { nowMs: sample.nowMs, cpuMicros: sample.cpuMicros };

  const persistent = [...state.tracked.values()].filter((t) => t.samples >= thresholds.leakSamples);
  if (persistent.length === 0) return { kind: "quiet" };

  const fields: WatchdogFields = {
    close_wait_sockets: sample.sockets.length,
    window_ms: windowMs,
    cpu_cores_used: cpuCoresUsed,
    sockets: persistent.slice(0, MAX_LOGGED_SOCKETS).map((t) => ({
      inode: t.socket.inode,
      local: t.socket.local,
      remote: t.socket.remote,
      age_ms: sample.nowMs - t.firstSeenMs,
      samples: t.samples,
    })),
  };

  const wedged = persistent.some((t) => t.samples >= thresholds.selfHealSamples);
  if (wedged && cpuCoresUsed >= thresholds.cpuPercent / 100) {
    return { kind: "spin", fields: { ...fields, self_heal_enabled: thresholds.selfHealEnabled } };
  }
  return { kind: "leak", fields };
}

/** Everything the watchdog touches outside itself. Injectable so the timer path is deterministic in test. */
export interface SocketHealthDeps {
  /** Resolves null when there is no procfs to read, which disables the watchdog. */
  readProcNet: () => Promise<{ tcp4: string; tcp6: string } | null>;
  /** Cumulative process CPU time in microseconds. */
  cpuUsage: () => number;
  now: () => number;
  exit: (code: number) => void;
}

/**
 * Read both procfs tables, tolerating every failure.
 *
 * A missing `/proc/net/tcp` means no procfs at all (macOS, a dev laptop), so
 * there is nothing to watch and the caller disables the watchdog. A missing
 * `/proc/net/tcp6` is different: a kernel with IPv6 disabled does not create
 * that file, and it also has no IPv6 sockets, so an empty tcp6 table is the
 * correct and complete answer rather than a reason to give up.
 *
 * Paths are parameters so the missing-file path is testable on any OS.
 */
export async function readProcNetAt(
  tcp4Path: string,
  tcp6Path: string,
): Promise<{ tcp4: string; tcp6: string } | null> {
  let tcp4: string;
  try {
    tcp4 = await readFile(tcp4Path, "utf8");
  } catch (err) {
    // ENOENT is the "no procfs" signal (macOS, a dev laptop): nothing to watch,
    // so disable. Any other error (EMFILE fd exhaustion, EACCES, EISDIR) is
    // transient or environmental, exactly the failure mode this watchdog exists
    // to surface, so rethrow and let `sampleOnce` log `sample_failed` once and
    // keep ticking rather than going silent.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let tcp6: string;
  try {
    tcp6 = await readFile(tcp6Path, "utf8");
  } catch {
    tcp6 = "";
  }
  return { tcp4, tcp6 };
}

const defaultDeps: SocketHealthDeps = {
  readProcNet: () => readProcNetAt(PROC_NET_TCP4, PROC_NET_TCP6),
  cpuUsage: () => {
    const usage = process.cpuUsage();
    return usage.user + usage.system;
  },
  now: () => Date.now(),
  exit: (code) => process.exit(code),
};

export interface SocketHealthOptions extends WatchdogThresholds {
  /** 0 disables the watchdog. Other values are clamped to [5s, 300s]. */
  intervalMs: number;
  /** The local port whose CLOSE_WAIT sockets are ours to care about. */
  port: number;
  deps?: SocketHealthDeps;
}

// Module singletons, mirroring `fleet-snapshot.ts` / `instance-liveness.ts`.
let timer: ReturnType<typeof setInterval> | null = null;
let sampleFailedLogged = false;

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function clampInterval(ms: number): number {
  return clamp(ms, MIN_INTERVAL_MS, MAX_INTERVAL_MS, MIN_INTERVAL_MS);
}

/**
 * Clamp the detector thresholds into safe ranges. Kept out of the pure
 * `evaluateSample` so the detector stays a faithful state machine over
 * whatever it is handed; the arming path is the single place that sanitises
 * operator input.
 */
function clampThresholds(opts: SocketHealthOptions): WatchdogThresholds {
  return {
    leakSamples: clamp(opts.leakSamples, MIN_LEAK_SAMPLES, MAX_LEAK_SAMPLES, MIN_LEAK_SAMPLES),
    selfHealSamples: clamp(
      opts.selfHealSamples,
      MIN_SELF_HEAL_SAMPLES,
      MAX_SELF_HEAL_SAMPLES,
      MIN_SELF_HEAL_SAMPLES,
    ),
    cpuPercent: clamp(opts.cpuPercent, MIN_CPU_PERCENT, MAX_CPU_PERCENT, MAX_CPU_PERCENT),
    selfHealEnabled: opts.selfHealEnabled,
  };
}

async function sampleOnce(
  state: WatchdogState,
  opts: SocketHealthOptions,
  deps: SocketHealthDeps,
): Promise<void> {
  let tables: { tcp4: string; tcp6: string } | null;
  try {
    tables = await deps.readProcNet();
  } catch (err) {
    // Once per lifetime: a procfs that fails once tends to fail every tick,
    // and a warn line every 30s would bury the leak this exists to surface.
    if (!sampleFailedLogged) {
      sampleFailedLogged = true;
      log.warn(
        { event: SOCKET_HEALTH_LOG_EVENTS.watchdogSampleFailed, err },
        "Socket health sample failed, watchdog continues",
      );
    }
    return;
  }
  if (tables === null) return;

  const sockets = collectCloseWaitSockets(tables.tcp4, tables.tcp6, opts.port);
  const verdict = evaluateSample(
    state,
    { sockets, nowMs: deps.now(), cpuMicros: deps.cpuUsage() },
    opts,
  );

  if (verdict.kind === "quiet") return;

  if (verdict.kind === "leak") {
    log.warn(
      { event: SOCKET_HEALTH_LOG_EVENTS.closeWaitDetected, ...verdict.fields },
      "Persistent CLOSE_WAIT sockets on the listener",
    );
    return;
  }

  log.warn(
    { event: SOCKET_HEALTH_LOG_EVENTS.closeWaitSpinSuspected, ...verdict.fields },
    "Persistent CLOSE_WAIT sockets with a pinned core, suspected socket spin (issue #264)",
  );
  if (!opts.selfHealEnabled) return;

  log.error(
    {
      event: SOCKET_HEALTH_LOG_EVENTS.closeWaitSelfHealExit,
      close_wait_sockets: verdict.fields.close_wait_sockets,
      cpu_cores_used: verdict.fields.cpu_cores_used,
    },
    `Self-healing suspected socket spin, exiting ${SELF_HEAL_EXIT_CODE} for a restart`,
  );
  // Exit here and now, with no drain and no delay of its own. Anything that
  // waits on the socket layer would be waiting on the thing that is wedged.
  deps.exit(SELF_HEAL_EXIT_CODE);
}

/**
 * Start the watchdog. Idempotent.
 *
 * Probes procfs once before arming so a host without it (any dev laptop) is
 * disabled outright rather than logging a failure every tick. The probe is
 * deliberately not a sample: the first sample has no previous CPU reading to
 * difference against, so it can never carry a rate worth acting on.
 */
export async function startSocketHealthWatchdog(opts: SocketHealthOptions): Promise<void> {
  if (timer !== null) return;
  if (opts.intervalMs === 0) {
    log.info(
      { event: SOCKET_HEALTH_LOG_EVENTS.watchdogDisabled },
      "Socket health watchdog disabled (SOCKET_HEALTH_INTERVAL_MS=0)",
    );
    return;
  }

  const deps = opts.deps ?? defaultDeps;
  let probe: { tcp4: string; tcp6: string } | null;
  try {
    probe = await deps.readProcNet();
  } catch {
    // A throwing probe is a transient fault, not proof of a missing procfs, so
    // arm anyway and let the tick path report it once if it persists.
    probe = { tcp4: "", tcp6: "" };
  }
  if (probe === null) {
    log.info(
      { event: SOCKET_HEALTH_LOG_EVENTS.watchdogDisabled },
      "Socket health watchdog disabled, no readable /proc/net/tcp",
    );
    return;
  }

  const state = createWatchdogState();
  sampleFailedLogged = false;
  const intervalMs = clampInterval(opts.intervalMs);
  const effectiveOpts: SocketHealthOptions = { ...opts, ...clampThresholds(opts) };
  // Cannot arm before the await like instance-liveness does: the procfs probe
  // above decides whether to arm at all. Single boot-time caller, so the
  // read-then-write of `timer` across the await cannot actually double-arm.
  // eslint-disable-next-line require-atomic-updates -- single-threaded, one boot-time caller
  timer = setInterval(() => {
    void sampleOnce(state, effectiveOpts, deps);
  }, intervalMs);
  log.info({ intervalMs, port: opts.port }, "Socket health watchdog started");
}

/** Stop the watchdog. Idempotent. */
export function stopSocketHealthWatchdog(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  // Reset with the handle so a later start reports its first failure again.
  sampleFailedLogged = false;
}
