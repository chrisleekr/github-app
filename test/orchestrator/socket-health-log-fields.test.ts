import { describe, expect, it } from "bun:test";

import {
  SOCKET_HEALTH_LOG_EVENTS,
  SocketCloseWaitDetectedSchema,
  SocketCloseWaitSelfHealExitSchema,
  SocketCloseWaitSpinSuspectedSchema,
  SocketWatchdogDisabledSchema,
  SocketWatchdogSampleFailedSchema,
} from "../../src/orchestrator/socket-health-log-fields";

const socket = {
  inode: "31005274",
  local: "[::ffff:10.0.0.206]:3000",
  remote: "[::ffff:10.0.0.206]:59938",
  age_ms: 90_000,
  samples: 3,
};

const detected = {
  event: SOCKET_HEALTH_LOG_EVENTS.closeWaitDetected,
  close_wait_sockets: 7,
  window_ms: 30_000,
  cpu_cores_used: 0.12,
  sockets: [socket],
};

const spin = {
  event: SOCKET_HEALTH_LOG_EVENTS.closeWaitSpinSuspected,
  close_wait_sockets: 7,
  window_ms: 30_000,
  cpu_cores_used: 1.0,
  sockets: [socket],
  self_heal_enabled: false,
};

const selfHealExit = {
  event: SOCKET_HEALTH_LOG_EVENTS.closeWaitSelfHealExit,
  close_wait_sockets: 7,
  cpu_cores_used: 1.0,
};

describe("SOCKET_HEALTH_LOG_EVENTS", () => {
  it("pins the five canonical socket-health event strings", () => {
    expect(SOCKET_HEALTH_LOG_EVENTS.closeWaitDetected).toBe("socket.close_wait.detected");
    expect(SOCKET_HEALTH_LOG_EVENTS.closeWaitSpinSuspected).toBe(
      "socket.close_wait.spin_suspected",
    );
    expect(SOCKET_HEALTH_LOG_EVENTS.closeWaitSelfHealExit).toBe("socket.close_wait.self_heal_exit");
    expect(SOCKET_HEALTH_LOG_EVENTS.watchdogSampleFailed).toBe("socket.watchdog.sample_failed");
    expect(SOCKET_HEALTH_LOG_EVENTS.watchdogDisabled).toBe("socket.watchdog.disabled");
  });
});

describe("socket-health schemas: accept well-formed events", () => {
  it("accepts a detected record", () => {
    expect(SocketCloseWaitDetectedSchema.safeParse(detected).success).toBe(true);
  });

  it("accepts a detected record with an empty socket list", () => {
    expect(
      SocketCloseWaitDetectedSchema.safeParse({ ...detected, close_wait_sockets: 0, sockets: [] })
        .success,
    ).toBe(true);
  });

  it("accepts exactly 20 sockets, the cap that keeps the line bounded", () => {
    const sockets = Array.from({ length: 20 }, (_, i) => ({ ...socket, inode: String(i) }));
    expect(
      SocketCloseWaitDetectedSchema.safeParse({ ...detected, close_wait_sockets: 40, sockets })
        .success,
    ).toBe(true);
  });

  it("accepts a fractional cpu_cores_used, since it is a rate and not a counter", () => {
    expect(
      SocketCloseWaitDetectedSchema.safeParse({ ...detected, cpu_cores_used: 0.997 }).success,
    ).toBe(true);
  });

  it("accepts a spin_suspected record in both self-heal modes", () => {
    expect(SocketCloseWaitSpinSuspectedSchema.safeParse(spin).success).toBe(true);
    expect(
      SocketCloseWaitSpinSuspectedSchema.safeParse({ ...spin, self_heal_enabled: true }).success,
    ).toBe(true);
  });

  it("accepts a self_heal_exit record", () => {
    expect(SocketCloseWaitSelfHealExitSchema.safeParse(selfHealExit).success).toBe(true);
  });

  it("accepts the bare sample_failed and disabled records", () => {
    expect(
      SocketWatchdogSampleFailedSchema.safeParse({
        event: SOCKET_HEALTH_LOG_EVENTS.watchdogSampleFailed,
      }).success,
    ).toBe(true);
    expect(
      SocketWatchdogDisabledSchema.safeParse({ event: SOCKET_HEALTH_LOG_EVENTS.watchdogDisabled })
        .success,
    ).toBe(true);
  });
});

describe("socket-health schemas: reject drift and bad input", () => {
  it("rejects an unknown extra field on detected (strict)", () => {
    expect(SocketCloseWaitDetectedSchema.safeParse({ ...detected, surprise: "boo" }).success).toBe(
      false,
    );
  });

  it("rejects a camelCase window field (snake_case drift)", () => {
    const { window_ms: _dropped, ...rest } = detected;
    expect(SocketCloseWaitDetectedSchema.safeParse({ ...rest, windowMs: 30_000 }).success).toBe(
      false,
    );
  });

  it("rejects a camelCase socket count (snake_case drift)", () => {
    const { close_wait_sockets: _dropped, ...rest } = detected;
    expect(SocketCloseWaitDetectedSchema.safeParse({ ...rest, closeWaitSockets: 7 }).success).toBe(
      false,
    );
  });

  it("rejects a negative or non-integer window_ms", () => {
    expect(SocketCloseWaitDetectedSchema.safeParse({ ...detected, window_ms: -1 }).success).toBe(
      false,
    );
    expect(SocketCloseWaitDetectedSchema.safeParse({ ...detected, window_ms: 1.5 }).success).toBe(
      false,
    );
  });

  it("rejects a negative or non-integer close_wait_sockets", () => {
    expect(
      SocketCloseWaitDetectedSchema.safeParse({ ...detected, close_wait_sockets: -1 }).success,
    ).toBe(false);
    expect(
      SocketCloseWaitDetectedSchema.safeParse({ ...detected, close_wait_sockets: 1.5 }).success,
    ).toBe(false);
  });

  it("rejects a negative cpu_cores_used", () => {
    expect(
      SocketCloseWaitDetectedSchema.safeParse({ ...detected, cpu_cores_used: -0.1 }).success,
    ).toBe(false);
  });

  it("rejects more than 20 sockets, so the line cannot blow up under a real storm", () => {
    const sockets = Array.from({ length: 21 }, (_, i) => ({ ...socket, inode: String(i) }));
    expect(SocketCloseWaitDetectedSchema.safeParse({ ...detected, sockets }).success).toBe(false);
  });

  it("rejects an unknown extra field on a socket entry (strict)", () => {
    expect(
      SocketCloseWaitDetectedSchema.safeParse({
        ...detected,
        sockets: [{ ...socket, fd: 42 }],
      }).success,
    ).toBe(false);
  });

  it("rejects a socket entry missing a field", () => {
    const { age_ms: _dropped, ...partial } = socket;
    expect(
      SocketCloseWaitDetectedSchema.safeParse({ ...detected, sockets: [partial] }).success,
    ).toBe(false);
  });

  it("rejects a socket entry with a zero sample count", () => {
    // A tracked socket is only in the list because it was seen at least once.
    expect(
      SocketCloseWaitDetectedSchema.safeParse({
        ...detected,
        sockets: [{ ...socket, samples: 0 }],
      }).success,
    ).toBe(false);
  });

  it("rejects a numeric inode (the kernel prints it as a string token)", () => {
    expect(
      SocketCloseWaitDetectedSchema.safeParse({
        ...detected,
        sockets: [{ ...socket, inode: 31005274 }],
      }).success,
    ).toBe(false);
  });

  it("rejects spin_suspected missing self_heal_enabled", () => {
    // The self-heal posture is the whole point of the line: an operator must be
    // able to tell a bounded burn from an unbounded one.
    const { self_heal_enabled: _dropped, ...rest } = spin;
    expect(SocketCloseWaitSpinSuspectedSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a detected record carrying self_heal_enabled (wrong family)", () => {
    expect(
      SocketCloseWaitDetectedSchema.safeParse({ ...detected, self_heal_enabled: true }).success,
    ).toBe(false);
  });

  it("rejects an unknown extra field on the bare events (strict)", () => {
    expect(
      SocketWatchdogDisabledSchema.safeParse({
        event: SOCKET_HEALTH_LOG_EVENTS.watchdogDisabled,
        reason: "not linux",
      }).success,
    ).toBe(false);
  });

  it("rejects a wrong event literal on every schema", () => {
    expect(
      SocketCloseWaitDetectedSchema.safeParse({ ...detected, event: "socket.close_wait.bogus" })
        .success,
    ).toBe(false);
    expect(
      SocketCloseWaitSpinSuspectedSchema.safeParse({ ...spin, event: "socket.close_wait.detected" })
        .success,
    ).toBe(false);
    expect(
      SocketCloseWaitSelfHealExitSchema.safeParse({ ...selfHealExit, event: "socket.exit" })
        .success,
    ).toBe(false);
    expect(
      SocketWatchdogSampleFailedSchema.safeParse({ event: "socket.watchdog.failed" }).success,
    ).toBe(false);
    expect(SocketWatchdogDisabledSchema.safeParse({ event: "socket.watchdog.off" }).success).toBe(
      false,
    );
  });
});
