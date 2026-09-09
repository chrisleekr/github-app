import { describe, expect, it } from "bun:test";

import {
  assertAutoReviewRequiresAllowlist,
  assertOauthRequiresAllowlist,
  assertPatRequiresAllowlist,
  blankToUndefined,
  type Config,
  configSchema,
  parseBooleanEnv,
} from "../src/config";

const BASE = {
  appId: "123",
  privateKey: "-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----",
  webhookSecret: "secret",
  daemonAuthToken: "daemon-token",
  workflowRunnerCapabilitySecret: "workflow-runner-capability-root-secret",
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

describe("configSchema: workflow runner resource quantities", () => {
  it("defaults to the quantities the admission boundary pins", () => {
    const result = configSchema.safeParse({ ...ANTHROPIC_BASE });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.workflowRunnerCpuRequest).toBe("500m");
    expect(result.data.workflowRunnerMemoryRequest).toBe("1Gi");
    expect(result.data.workflowRunnerStorageRequest).toBe("2Gi");
    expect(result.data.workflowRunnerCpuLimit).toBe("2");
    expect(result.data.workflowRunnerMemoryLimit).toBe("4Gi");
    expect(result.data.workflowRunnerStorageLimit).toBe("10Gi");
  });

  it("accepts a canonical override", () => {
    const result = configSchema.safeParse({ ...ANTHROPIC_BASE, workflowRunnerMemoryLimit: "8Gi" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.workflowRunnerMemoryLimit).toBe("8Gi");
  });

  // The API server re-serializes 8192Mi as 8Gi, 2000m as 2 and 1000 as 1k, and
  // the spawner compares the returned Pod's resource strings byte for byte, so a
  // non-canonical spelling would terminalize every attempt with a message about
  // Pod identity instead of about the variable that caused it.
  it.each([
    ["workflowRunnerMemoryLimit", "8192Mi", "WORKFLOW_RUNNER_MEMORY_LIMIT"],
    ["workflowRunnerStorageLimit", "1024Mi", "WORKFLOW_RUNNER_STORAGE_LIMIT"],
    ["workflowRunnerCpuLimit", "2000m", "WORKFLOW_RUNNER_CPU_LIMIT"],
    // Whole cores divisible by 1000 hit the same rule: Kubernetes formats a
    // suffixless decimal quantity with an exponent that is a multiple of three,
    // so it stores 1000 as 1k and 4000 as 4k.
    ["workflowRunnerCpuLimit", "1000", "WORKFLOW_RUNNER_CPU_LIMIT"],
    ["workflowRunnerCpuRequest", "4000", "WORKFLOW_RUNNER_CPU_REQUEST"],
    ["workflowRunnerCpuRequest", "1000m", "WORKFLOW_RUNNER_CPU_REQUEST"],
  ])("rejects the non-canonical %s value %s", (key, value, envVar) => {
    const result = configSchema.safeParse({ ...ANTHROPIC_BASE, [key]: value });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path[0] === key);
    expect(issue?.message).toContain(envVar);
    expect(issue?.message).toContain("canonical");
  });

  it.each([
    ["workflowRunnerCpuRequest", "1.5"],
    ["workflowRunnerMemoryRequest", "4G"],
    ["workflowRunnerStorageRequest", "512Ki"],
  ])("rejects %s=%s, a shape the boundary does not pin", (key, value) => {
    expect(configSchema.safeParse({ ...ANTHROPIC_BASE, [key]: value }).success).toBe(false);
  });

  // The API server refuses this Pod, which the spawner classifies permanent, so
  // every attempt dies naming Pod creation rather than the two variables.
  it("rejects a request above its limit", () => {
    const result = configSchema.safeParse({
      ...ANTHROPIC_BASE,
      workflowRunnerMemoryRequest: "8Gi",
      workflowRunnerMemoryLimit: "4Gi",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path[0] === "workflowRunnerMemoryLimit");
    expect(issue?.message).toBe(
      "WORKFLOW_RUNNER_MEMORY_REQUEST must not exceed WORKFLOW_RUNNER_MEMORY_LIMIT",
    );
  });

  it("allows a request equal to its limit", () => {
    const result = configSchema.safeParse({
      ...ANTHROPIC_BASE,
      workflowRunnerCpuRequest: "2",
      workflowRunnerCpuLimit: "2",
    });
    expect(result.success).toBe(true);
  });

  // Number rounds both of these to the same value, so a Number comparison would
  // accept a request above its limit.
  it("compares quantities beyond the safe integer range exactly", () => {
    const result = configSchema.safeParse({
      ...ANTHROPIC_BASE,
      workflowRunnerCpuRequest: "9007199254740993m",
      workflowRunnerCpuLimit: "9007199254740992m",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path[0] === "workflowRunnerCpuLimit");
    expect(issue?.message).toBe(
      "WORKFLOW_RUNNER_CPU_REQUEST must not exceed WORKFLOW_RUNNER_CPU_LIMIT",
    );
  });

  // zod runs the object-level superRefine even when a field failed its own
  // checks, so the ordering rule sees the raw string. It must stay quiet: the
  // shape message already names the variable, and an ordering complaint about a
  // value nobody could parse sends the reader after the wrong variable.
  it("reports only the shape failure for an unparseable quantity", () => {
    const result = configSchema.safeParse({ ...ANTHROPIC_BASE, workflowRunnerCpuRequest: "abc" });
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message);
    expect(messages).toContain(
      "WORKFLOW_RUNNER_CPU_REQUEST must be whole cores (e.g. 2) or millicores (e.g. 500m)",
    );
    expect(messages.some((m) => m.includes("must not exceed"))).toBe(false);
  });
});

describe("configSchema: Anthropic provider", () => {
  it("parses successfully with an API key", () => {
    const result = configSchema.safeParse({ ...ANTHROPIC_BASE });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe("anthropic");
      expect(result.data.model).toBe("claude-opus-5");
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

  it("requires a dedicated workflow runner capability secret in server mode", () => {
    // Mandatory from this slice on: workflow-runner-dispatch.ts derives every
    // runner capability from this root.
    const { workflowRunnerCapabilitySecret, ...withoutCapabilitySecret } = ANTHROPIC_BASE;
    expect(workflowRunnerCapabilitySecret).toBeDefined();
    expect(configSchema.safeParse(withoutCapabilitySecret).success).toBe(false);
  });

  it("rejects capability roots reused from either daemon authentication slot", () => {
    const shared = "shared-authentication-root-secret-123";
    const cases = [
      { daemonAuthToken: shared, workflowRunnerCapabilitySecret: shared },
      { daemonAuthToken: shared, workflowRunnerCapabilitySecretPrevious: shared },
      { daemonAuthTokenPrevious: shared, workflowRunnerCapabilitySecret: shared },
      { daemonAuthTokenPrevious: shared, workflowRunnerCapabilitySecretPrevious: shared },
    ];

    for (const reused of cases) {
      expect(configSchema.safeParse({ ...ANTHROPIC_BASE, ...reused }).success).toBe(false);
    }
  });

  it("does not require DB or Valkey in shared daemon mode", () => {
    const daemonBase = {
      provider: "anthropic",
      anthropicApiKey: "sk-ant-test",
      daemonAuthToken: "daemon-token",
      orchestratorUrl: "wss://orchestrator.example.com",
    };
    expect(configSchema.safeParse(daemonBase).success).toBe(true);
  });

  it("still requires DAEMON_AUTH_TOKEN in daemon mode (ORCHESTRATOR_URL set)", () => {
    const { daemonAuthToken, ...withoutToken } = ANTHROPIC_BASE;
    expect(daemonAuthToken).toBeDefined();
    const result = configSchema.safeParse({
      ...withoutToken,
      orchestratorUrl: "wss://orchestrator.example.com",
    });
    expect(result.success).toBe(false);
  });

  it("allows an isolated workflow runner without data-layer or daemon credentials", () => {
    const result = configSchema.safeParse({
      provider: "anthropic",
      anthropicApiKey: "sk-ant-test",
      orchestratorUrl: "wss://orchestrator.example.com/ws/workflow-runner/run/attempt",
      workflowRunner: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a workflow runner carrying the capability signing root", () => {
    // WORKFLOW_RUNNER=true waives every data-layer check, so a controller env
    // that picked up the flag by accident would otherwise start clean and die
    // at first DB use. A runner is issued a per-attempt capability and never
    // the root, so its presence identifies a misapplied flag at boot.
    const result = configSchema.safeParse({
      provider: "anthropic",
      anthropicApiKey: "sk-ant-test",
      orchestratorUrl: "wss://orchestrator.example.com/ws/workflow-runner/run/attempt",
      workflowRunner: true,
      workflowRunnerCapabilitySecret: "workflow-runner-capability-root-secret",
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
      expect(result.data.ephemeralDaemonSecretName).toBe("daemon-secrets");
      expect(result.data.workflowRunnerNamespace).toBe("github-app-runners");
      expect(result.data.workflowRunnerNodeLabel).toBe(
        "github-app.node-restriction.kubernetes.io/workflow-runner",
      );
      expect(result.data.workflowRunnerNodeValue).toBe("true");
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
      ephemeralDaemonSecretName: "github-app-secrets",
      workflowRunnerNamespace: "workflow-ops",
      workflowRunnerNodeLabel: "node.homelab/class",
      workflowRunnerNodeValue: "worker",
      daemonImage: "ghcr.io/org/daemon:1.2.3",
      orchestratorPublicUrl: "wss://orchestrator.example.com",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.daemonEphemeral).toBe(true);
      expect(result.data.ephemeralDaemonIdleTimeoutMs).toBe(60_000);
      expect(result.data.ephemeralDaemonNamespace).toBe("ops");
      expect(result.data.ephemeralDaemonSecretName).toBe("github-app-secrets");
      expect(result.data.workflowRunnerNamespace).toBe("workflow-ops");
      expect(result.data.workflowRunnerNodeLabel).toBe("node.homelab/class");
      expect(result.data.workflowRunnerNodeValue).toBe("worker");
      expect(result.data.daemonImage).toBe("ghcr.io/org/daemon:1.2.3");
    }
  });

  it("rejects a controller that shares the workflow-runner namespace", () => {
    const result = configSchema.safeParse({
      ...ANTHROPIC_BASE,
      ephemeralDaemonNamespace: "workers",
      workflowRunnerNamespace: "workers",
    });
    expect(result.success).toBe(false);
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

describe("blankToUndefined", () => {
  it("treats undefined, empty, and whitespace-only as unset", () => {
    expect(blankToUndefined(undefined)).toBeUndefined();
    expect(blankToUndefined("")).toBeUndefined();
    expect(blankToUndefined("   ")).toBeUndefined();
  });

  it("passes a real value through untrimmed", () => {
    expect(blankToUndefined(" .github-app.yaml ")).toBe(" .github-app.yaml ");
  });

  it("lets the deprecated alias win only when the new name is blank", () => {
    // Mirrors the REPO_CONFIG_FILE ?? SCHEDULER_CONFIG_FILE chain in
    // loadConfig. A chart rendering an unset key as "" must not win the
    // chain, or the path resolves to the repo root for every repo.
    expect(blankToUndefined("") ?? blankToUndefined("legacy.yaml")).toBe("legacy.yaml");
    expect(blankToUndefined("new.yaml") ?? blankToUndefined("legacy.yaml")).toBe("new.yaml");
    expect(blankToUndefined("") ?? blankToUndefined("")).toBeUndefined();
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

describe("assertAutoReviewRequiresAllowlist", () => {
  const withOwners = (owners: string | undefined, users: string | undefined): Config =>
    configSchema.parse({
      ...ANTHROPIC_BASE,
      ...(owners === undefined ? {} : { allowedOwners: owners }),
      ...(users === undefined ? {} : { autoReviewUsers: users }),
    });

  it("rejects AUTO_REVIEW_USERS with no ALLOWED_OWNERS", () => {
    // Every other allowlist here narrows; this one widens. `isOwnerAllowed`
    // permits every owner when ALLOWED_OWNERS is unset, so the whole chain to
    // "run an agent on a stranger's repo" would be a login-string match plus a
    // key that stranger controls.
    expect(() => {
      assertAutoReviewRequiresAllowlist(withOwners(undefined, "chrisleekr"));
    }).toThrow(/ALLOWED_OWNERS must be set/);
  });

  it("accepts AUTO_REVIEW_USERS bound to one owner", () => {
    expect(() => {
      assertAutoReviewRequiresAllowlist(withOwners("acme", "chrisleekr"));
    }).not.toThrow();
  });

  it("accepts several owners, unlike the OAuth and PAT guards", () => {
    // Auto-review carries no personal identity and no shared rate-limit bucket,
    // so it only needs the list to be non-empty, not singular.
    expect(() => {
      assertAutoReviewRequiresAllowlist(withOwners("acme,other", "chrisleekr"));
    }).not.toThrow();
  });

  it("ignores an unset AUTO_REVIEW_USERS entirely", () => {
    expect(() => {
      assertAutoReviewRequiresAllowlist(withOwners(undefined, undefined));
    }).not.toThrow();
  });
});
