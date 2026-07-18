import { describe, expect, it } from "bun:test";

import {
  assertOauthRequiresAllowlist,
  assertPatRequiresAllowlist,
  type Config,
  configSchema,
  parseBooleanEnv,
} from "../src/config";

const BASE = {
  appId: "123",
  privateKey: "-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----",
  webhookSecret: "secret",
  daemonAuthToken: "daemon-token",
  databaseUrl: "postgres://user:pass@localhost:55432/db",
  valkeyUrl: "redis://localhost:56379",
};

const ANTHROPIC_BASE = {
  ...BASE,
  provider: "anthropic",
  anthropicApiKey: "sk-ant-test",
};

const BEDROCK_BASE = {
  ...BASE,
  provider: "bedrock",
  awsRegion: "us-east-1",
  model: "anthropic.claude-3-5-haiku-20241022-v1:0",
};

describe("configSchema: Anthropic provider", () => {
  it("parses successfully with an API key", () => {
    const result = configSchema.safeParse({ ...ANTHROPIC_BASE });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe("anthropic");
      expect(result.data.model).toBe("claude-opus-4-7");
    }
  });

  it("accepts CLAUDE_CODE_OAUTH_TOKEN instead of ANTHROPIC_API_KEY", () => {
    const result = configSchema.safeParse({
      ...BASE,
      provider: "anthropic",
      claudeCodeOauthToken: "sk-ant-oat-test",
      allowedOwners: "luxuryescapes",
    });
    expect(result.success).toBe(true);
  });

  it("rejects when neither API key nor OAuth token is provided", () => {
    const result = configSchema.safeParse({ ...BASE, provider: "anthropic" });
    expect(result.success).toBe(false);
  });

  it("coerces empty-string credentials to undefined so they cannot shadow a real value", () => {
    // Reproduces the production trap: a SealedSecret entry that decrypts to ""
    // gets injected by `envFrom: secretRef` as ANTHROPIC_API_KEY="". Without
    // coercion, downstream `apiKey ?? oauthToken` returns "" instead of the
    // real OAuth token, and createLLMClient throws.
    const result = configSchema.safeParse({
      ...BASE,
      provider: "anthropic",
      anthropicApiKey: "",
      claudeCodeOauthToken: "sk-ant-oat-test",
      allowedOwners: "luxuryescapes",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.anthropicApiKey).toBeUndefined();
      expect(result.data.claudeCodeOauthToken).toBe("sk-ant-oat-test");
    }
  });

  it("coerces whitespace-only credentials to undefined", () => {
    const result = configSchema.safeParse({
      ...BASE,
      provider: "anthropic",
      anthropicApiKey: "   ",
      claudeCodeOauthToken: "sk-ant-oat-test",
      allowedOwners: "luxuryescapes",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.anthropicApiKey).toBeUndefined();
    }
  });
});

describe("configSchema: Bedrock provider", () => {
  it("parses successfully with region + model", () => {
    const result = configSchema.safeParse({ ...BEDROCK_BASE });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe("bedrock");
      expect(result.data.awsRegion).toBe("us-east-1");
    }
  });

  it("requires an explicit CLAUDE_MODEL for Bedrock", () => {
    const result = configSchema.safeParse({
      ...BASE,
      provider: "bedrock",
      awsRegion: "us-east-1",
    });
    expect(result.success).toBe(false);
  });
});

describe("configSchema: data layer validation", () => {
  it("requires DAEMON_AUTH_TOKEN in every mode", () => {
    const { daemonAuthToken, ...withoutToken } = ANTHROPIC_BASE;
    expect(daemonAuthToken).toBeDefined();
    const result = configSchema.safeParse(withoutToken);
    expect(result.success).toBe(false);
  });

  it("requires DATABASE_URL in server mode", () => {
    const { databaseUrl, ...withoutDb } = ANTHROPIC_BASE;
    expect(databaseUrl).toBeDefined();
    const result = configSchema.safeParse(withoutDb);
    expect(result.success).toBe(false);
  });

  it("requires VALKEY_URL in server mode", () => {
    const { valkeyUrl, ...withoutValkey } = ANTHROPIC_BASE;
    expect(valkeyUrl).toBeDefined();
    const result = configSchema.safeParse(withoutValkey);
    expect(result.success).toBe(false);
  });

  it("waives DB + Valkey when ORCHESTRATOR_URL is set (daemon mode)", () => {
    const result = configSchema.safeParse({
      appId: "123",
      privateKey: "-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----",
      webhookSecret: "secret",
      provider: "anthropic",
      anthropicApiKey: "sk-ant-test",
      daemonAuthToken: "daemon-token",
      orchestratorUrl: "wss://orchestrator.example.com",
    });
    expect(result.success).toBe(true);
  });

  it("still requires DAEMON_AUTH_TOKEN in daemon mode (ORCHESTRATOR_URL set)", () => {
    // The DB/Valkey waiver must not cascade into waiving daemon auth,
    // an orchestrator-connected daemon without a shared token would
    // accept unauthenticated connections on restart.
    const { daemonAuthToken, ...withoutToken } = ANTHROPIC_BASE;
    expect(daemonAuthToken).toBeDefined();
    const result = configSchema.safeParse({
      ...withoutToken,
      orchestratorUrl: "wss://orchestrator.example.com",
    });
    expect(result.success).toBe(false);
  });
});

describe("configSchema: ephemeral-daemon defaults", () => {
  it("has sensible defaults for all five ephemeral env vars", () => {
    const result = configSchema.safeParse({ ...ANTHROPIC_BASE });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.daemonEphemeral).toBe(false);
      expect(result.data.ephemeralDaemonIdleTimeoutMs).toBe(120_000);
      expect(result.data.ephemeralDaemonSpawnCooldownMs).toBe(30_000);
      expect(result.data.ephemeralDaemonSpawnQueueThreshold).toBe(3);
      expect(result.data.ephemeralDaemonNamespace).toBe("default");
    }
  });

  it("accepts explicit overrides", () => {
    const result = configSchema.safeParse({
      ...ANTHROPIC_BASE,
      daemonEphemeral: true,
      ephemeralDaemonIdleTimeoutMs: 60_000,
      ephemeralDaemonSpawnCooldownMs: 10_000,
      ephemeralDaemonSpawnQueueThreshold: 5,
      ephemeralDaemonNamespace: "ops",
      daemonImage: "ghcr.io/org/daemon:1.2.3",
      orchestratorPublicUrl: "wss://orchestrator.example.com",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.daemonEphemeral).toBe(true);
      expect(result.data.ephemeralDaemonIdleTimeoutMs).toBe(60_000);
      expect(result.data.ephemeralDaemonNamespace).toBe("ops");
      expect(result.data.daemonImage).toBe("ghcr.io/org/daemon:1.2.3");
    }
  });

  it("rejects a non-ws URL for orchestratorPublicUrl", () => {
    const result = configSchema.safeParse({
      ...ANTHROPIC_BASE,
      orchestratorPublicUrl: "https://example.com",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-positive queue threshold", () => {
    expect(
      configSchema.safeParse({ ...ANTHROPIC_BASE, ephemeralDaemonSpawnQueueThreshold: 0 }).success,
    ).toBe(false);
  });
});

describe("configSchema: socket-health watchdog defaults (#265)", () => {
  it("has documented defaults for all five socket-health vars", () => {
    const result = configSchema.safeParse({ ...ANTHROPIC_BASE });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.socketHealthIntervalMs).toBe(30_000);
      expect(result.data.socketHealthLeakSamples).toBe(3);
      expect(result.data.socketHealthSelfHealSamples).toBe(10);
      expect(result.data.socketHealthCpuPercent).toBe(90);
      expect(result.data.socketHealthSelfHealEnabled).toBe(false);
    }
  });

  it("accepts explicit overrides and coerces numeric strings", () => {
    const result = configSchema.safeParse({
      ...ANTHROPIC_BASE,
      socketHealthIntervalMs: "60000",
      socketHealthLeakSamples: "5",
      socketHealthSelfHealSamples: "20",
      socketHealthCpuPercent: "95",
      socketHealthSelfHealEnabled: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.socketHealthIntervalMs).toBe(60_000);
      expect(result.data.socketHealthLeakSamples).toBe(5);
      expect(result.data.socketHealthSelfHealSamples).toBe(20);
      expect(result.data.socketHealthCpuPercent).toBe(95);
      expect(result.data.socketHealthSelfHealEnabled).toBe(true);
    }
  });

  it("allows interval 0 through zod so the consumer can treat it as disabled", () => {
    // Bounds are clamped in socket-health.ts, not here, so `0` must survive
    // validation rather than being floored to the 5s minimum.
    const result = configSchema.safeParse({ ...ANTHROPIC_BASE, socketHealthIntervalMs: 0 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.socketHealthIntervalMs).toBe(0);
  });

  it("does not clamp out-of-range numbers in zod (clamp is at the consumer)", () => {
    // A leakSamples of 1 is unsafe but must pass schema validation; the
    // socket-health arming path is the single place that clamps it to >= 2.
    const result = configSchema.safeParse({
      ...ANTHROPIC_BASE,
      socketHealthLeakSamples: 1,
      socketHealthCpuPercent: 10,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.socketHealthLeakSamples).toBe(1);
      expect(result.data.socketHealthCpuPercent).toBe(10);
    }
  });

  it("rejects negative numbers but accepts 0 for the fail-open threshold knobs", () => {
    // Negatives are nonsense and rejected. A `0` (typo) is accepted by the
    // schema and floored to the safe minimum at the consumer (`clampThresholds`)
    // rather than crashing the orchestrator over a diagnostic knob.
    expect(configSchema.safeParse({ ...ANTHROPIC_BASE, socketHealthIntervalMs: -1 }).success).toBe(
      false,
    );
    expect(configSchema.safeParse({ ...ANTHROPIC_BASE, socketHealthLeakSamples: -1 }).success).toBe(
      false,
    );
    expect(configSchema.safeParse({ ...ANTHROPIC_BASE, socketHealthCpuPercent: -1 }).success).toBe(
      false,
    );

    const zeroed = configSchema.safeParse({
      ...ANTHROPIC_BASE,
      socketHealthLeakSamples: 0,
      socketHealthSelfHealSamples: 0,
      socketHealthCpuPercent: 0,
    });
    expect(zeroed.success).toBe(true);
    if (zeroed.success) {
      expect(zeroed.data.socketHealthLeakSamples).toBe(0);
      expect(zeroed.data.socketHealthCpuPercent).toBe(0);
    }
  });

  it("rejects a non-integer cpu percent", () => {
    expect(
      configSchema.safeParse({ ...ANTHROPIC_BASE, socketHealthCpuPercent: 90.5 }).success,
    ).toBe(false);
  });

  it("rejects an unparseable boolean via parseBooleanEnv", () => {
    expect(() => parseBooleanEnv("SOCKET_HEALTH_SELF_HEAL_ENABLED", "maybe")).toThrow();
  });
});

describe("parseBooleanEnv", () => {
  it("accepts true/false, 1/0, yes/no case-insensitively", () => {
    for (const v of ["true", "TRUE", "1", "yes", "YES"]) {
      expect(parseBooleanEnv("X", v)).toBe(true);
    }
    for (const v of ["false", "FALSE", "0", "no", "NO"]) {
      expect(parseBooleanEnv("X", v)).toBe(false);
    }
  });

  it("returns undefined for undefined", () => {
    expect(parseBooleanEnv("X", undefined)).toBeUndefined();
  });

  it("throws on unknown values", () => {
    expect(() => parseBooleanEnv("X", "maybe")).toThrow();
    expect(() => parseBooleanEnv("X", "")).toThrow();
  });
});

describe("assertOauthRequiresAllowlist", () => {
  const baseOauthCfg: Config = configSchema.parse({
    ...BASE,
    provider: "anthropic",
    claudeCodeOauthToken: "sk-ant-oat-test",
    allowedOwners: "single-owner",
  });

  it("accepts OAuth with exactly one allowlisted owner", () => {
    expect(() => {
      assertOauthRequiresAllowlist(baseOauthCfg);
    }).not.toThrow();
  });

  it("throws when OAuth is set without an allowlist", () => {
    // With `exactOptionalPropertyTypes`, the absence of a property is
    // distinct from an explicit `undefined`. Destructure the property
    // out so this test actually models "no allowlist configured", not
    // "allowlist is undefined-valued".
    const { allowedOwners, ...cfg } = baseOauthCfg;
    expect(allowedOwners).toBeDefined();
    expect(() => {
      assertOauthRequiresAllowlist(cfg);
    }).toThrow(/ALLOWED_OWNERS/);
  });

  it("throws when OAuth is set with multiple allowlisted owners", () => {
    const cfg = { ...baseOauthCfg, allowedOwners: ["a", "b"] };
    expect(() => {
      assertOauthRequiresAllowlist(cfg);
    }).toThrow(/ALLOWED_OWNERS/);
  });

  it("does not trigger for API-key auth", () => {
    const cfg: Config = configSchema.parse({
      ...ANTHROPIC_BASE,
      allowedOwners: "a,b",
    });
    expect(() => {
      assertOauthRequiresAllowlist(cfg);
    }).not.toThrow();
  });
});

describe("assertPatRequiresAllowlist", () => {
  const basePatCfg: Config = configSchema.parse({
    ...ANTHROPIC_BASE,
    githubPersonalAccessToken: "ghp_test",
    allowedOwners: "single-owner",
  });

  it("accepts PAT with exactly one allowlisted owner", () => {
    expect(() => {
      assertPatRequiresAllowlist(basePatCfg);
    }).not.toThrow();
  });

  it("throws when PAT is set without an allowlist", () => {
    const { allowedOwners, ...cfg } = basePatCfg;
    expect(allowedOwners).toBeDefined();
    expect(() => {
      assertPatRequiresAllowlist(cfg);
    }).toThrow(/ALLOWED_OWNERS/);
  });

  it("throws when PAT is set with multiple allowlisted owners", () => {
    const cfg = { ...basePatCfg, allowedOwners: ["a", "b"] };
    expect(() => {
      assertPatRequiresAllowlist(cfg);
    }).toThrow(/ALLOWED_OWNERS/);
  });

  it("does not trigger when PAT is unset", () => {
    const cfg: Config = configSchema.parse({
      ...ANTHROPIC_BASE,
      allowedOwners: "a,b",
    });
    expect(() => {
      assertPatRequiresAllowlist(cfg);
    }).not.toThrow();
  });
});

describe("configSchema: ship workflow defaults", () => {
  it("populates every ship env var with its documented default", () => {
    const result = configSchema.safeParse({ ...ANTHROPIC_BASE });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxWallClockPerShipRun).toBe(14_400_000);
      expect(result.data.maxShipIterations).toBe(50);
      expect(result.data.cronTickleIntervalMs).toBe(15_000);
      expect(result.data.mergeableNullBackoffMsList).toEqual([
        5_000, 10_000, 30_000, 60_000, 60_000,
      ]);
      expect(result.data.reviewBarrierSafetyMarginMs).toBe(1_200_000);
      expect(result.data.fixAttemptsPerSignatureCap).toBe(3);
      expect(result.data.shipForbiddenTargetBranches).toEqual([]);
    }
  });

  it("accepts explicit overrides for the numeric ship envs", () => {
    const result = configSchema.safeParse({
      ...ANTHROPIC_BASE,
      maxShipIterations: 10,
      cronTickleIntervalMs: 5_000,
      reviewBarrierSafetyMarginMs: 60_000,
      fixAttemptsPerSignatureCap: 2,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxShipIterations).toBe(10);
      expect(result.data.cronTickleIntervalMs).toBe(5_000);
      expect(result.data.reviewBarrierSafetyMarginMs).toBe(60_000);
      expect(result.data.fixAttemptsPerSignatureCap).toBe(2);
    }
  });
});

describe("configSchema: discussion-digest model", () => {
  it("defaults digestModel to sonnet-4-6", () => {
    const result = configSchema.safeParse({ ...ANTHROPIC_BASE });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.digestModel).toBe("sonnet-4-6");
  });

  it("accepts an explicit digestModel override", () => {
    const result = configSchema.safeParse({ ...ANTHROPIC_BASE, digestModel: "haiku-4-5" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.digestModel).toBe("haiku-4-5");
  });
});

describe("configSchema: MAX_WALL_CLOCK_PER_SHIP_RUN duration parsing", () => {
  it("accepts a plain integer (ms)", () => {
    const result = configSchema.safeParse({ ...ANTHROPIC_BASE, maxWallClockPerShipRun: "60000" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.maxWallClockPerShipRun).toBe(60_000);
  });

  it("accepts a numeric ms value as a JS number", () => {
    const result = configSchema.safeParse({ ...ANTHROPIC_BASE, maxWallClockPerShipRun: 60_000 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.maxWallClockPerShipRun).toBe(60_000);
  });

  it("parses h/m/s suffixes", () => {
    const cases: [string, number][] = [
      ["4h", 14_400_000],
      ["30m", 1_800_000],
      ["90s", 90_000],
      ["1.5h", 5_400_000],
    ];
    for (const [input, expected] of cases) {
      const result = configSchema.safeParse({ ...ANTHROPIC_BASE, maxWallClockPerShipRun: input });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.maxWallClockPerShipRun).toBe(expected);
    }
  });

  it("rejects malformed duration strings", () => {
    for (const bad of ["4hours", "abc", "-1h", "0", "0h"]) {
      const result = configSchema.safeParse({ ...ANTHROPIC_BASE, maxWallClockPerShipRun: bad });
      expect(result.success).toBe(false);
    }
  });

  it("rejects zero and negative integers", () => {
    expect(configSchema.safeParse({ ...ANTHROPIC_BASE, maxWallClockPerShipRun: 0 }).success).toBe(
      false,
    );
    expect(configSchema.safeParse({ ...ANTHROPIC_BASE, maxWallClockPerShipRun: -1 }).success).toBe(
      false,
    );
  });
});

describe("configSchema: MAX_SHIP_ITERATIONS validation", () => {
  it("rejects zero", () => {
    expect(configSchema.safeParse({ ...ANTHROPIC_BASE, maxShipIterations: 0 }).success).toBe(false);
  });
  it("rejects non-integer", () => {
    expect(configSchema.safeParse({ ...ANTHROPIC_BASE, maxShipIterations: 1.5 }).success).toBe(
      false,
    );
  });
});

describe("configSchema: MERGEABLE_NULL_BACKOFF_MS_LIST parsing", () => {
  it("parses a comma-separated list of positive integers", () => {
    const result = configSchema.safeParse({
      ...ANTHROPIC_BASE,
      mergeableNullBackoffMsList: "1000,2000,3000",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.mergeableNullBackoffMsList).toEqual([1000, 2000, 3000]);
  });

  it("trims whitespace inside entries", () => {
    const result = configSchema.safeParse({
      ...ANTHROPIC_BASE,
      mergeableNullBackoffMsList: " 1000 , 2000 ",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.mergeableNullBackoffMsList).toEqual([1000, 2000]);
  });

  it("rejects an empty string", () => {
    expect(
      configSchema.safeParse({ ...ANTHROPIC_BASE, mergeableNullBackoffMsList: "" }).success,
    ).toBe(false);
  });

  it("rejects non-positive entries", () => {
    expect(
      configSchema.safeParse({ ...ANTHROPIC_BASE, mergeableNullBackoffMsList: "1000,0,2000" })
        .success,
    ).toBe(false);
    expect(
      configSchema.safeParse({ ...ANTHROPIC_BASE, mergeableNullBackoffMsList: "1000,-5,2000" })
        .success,
    ).toBe(false);
  });

  it("rejects non-integer entries", () => {
    expect(
      configSchema.safeParse({ ...ANTHROPIC_BASE, mergeableNullBackoffMsList: "1000,abc,2000" })
        .success,
    ).toBe(false);
    expect(
      configSchema.safeParse({ ...ANTHROPIC_BASE, mergeableNullBackoffMsList: "1.5,2,3" }).success,
    ).toBe(false);
  });
});

describe("configSchema: SHIP_FORBIDDEN_TARGET_BRANCHES parsing", () => {
  it("defaults to empty array when unset", () => {
    const result = configSchema.safeParse({ ...ANTHROPIC_BASE });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.shipForbiddenTargetBranches).toEqual([]);
  });

  it("parses a comma-separated list with whitespace tolerance", () => {
    const result = configSchema.safeParse({
      ...ANTHROPIC_BASE,
      shipForbiddenTargetBranches: " main, master ,release/* ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.shipForbiddenTargetBranches).toEqual(["main", "master", "release/*"]);
    }
  });

  it("treats empty string as empty list", () => {
    const result = configSchema.safeParse({
      ...ANTHROPIC_BASE,
      shipForbiddenTargetBranches: "",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.shipForbiddenTargetBranches).toEqual([]);
  });
});

describe("configSchema: PROMPT_CACHE_LAYOUT", () => {
  it("defaults to legacy when unset", () => {
    const result = configSchema.safeParse({ ...ANTHROPIC_BASE });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.promptCacheLayout).toBe("legacy");
  });

  it("accepts the cacheable value", () => {
    const result = configSchema.safeParse({ ...ANTHROPIC_BASE, promptCacheLayout: "cacheable" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.promptCacheLayout).toBe("cacheable");
  });

  it("rejects an unknown layout value", () => {
    const result = configSchema.safeParse({ ...ANTHROPIC_BASE, promptCacheLayout: "turbo" });
    expect(result.success).toBe(false);
  });
});
