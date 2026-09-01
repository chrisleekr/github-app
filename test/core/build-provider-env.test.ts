import { describe, expect, it } from "bun:test";

import { buildProviderEnv } from "../../src/core/executor";

// `buildProviderEnv` uses an explicit allowlist + prefix patterns + deny-set
// (issue #102, defense layer 1a). Only enumerated keys (or keys matching an
// allowlist prefix) reach the agent subprocess; explicit deny-keys override.
// These tests assert both expected keys and the direct-inheritance deny set.

/**
 * Run `fn` with the given env vars set, restoring whatever values
 * (or absence) were there before. Accepts a map so multiple vars
 * can be set in a single call without nesting callbacks.
 */
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      const before = prev[k];
      if (before === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = before;
    }
  }
}

describe("buildProviderEnv", () => {
  it("forwards an installation token as both GH_TOKEN and GITHUB_TOKEN", () => {
    const env = buildProviderEnv("ghs_test_token");
    expect(env["GH_TOKEN"]).toBe("ghs_test_token");
    expect(env["GITHUB_TOKEN"]).toBe("ghs_test_token");
  });

  it("exports BOT_ARTIFACT_DIR when an artifacts directory is supplied", () => {
    const env = buildProviderEnv(undefined, "/tmp/work-abc-artifacts");
    expect(env["BOT_ARTIFACT_DIR"]).toBe("/tmp/work-abc-artifacts");
  });

  it("emits both token vars and BOT_ARTIFACT_DIR together when both inputs are supplied", () => {
    const env = buildProviderEnv("ghs_token", "/tmp/work-xyz-artifacts");
    expect(env["GH_TOKEN"]).toBe("ghs_token");
    expect(env["GITHUB_TOKEN"]).toBe("ghs_token");
    expect(env["BOT_ARTIFACT_DIR"]).toBe("/tmp/work-xyz-artifacts");
  });

  // Negative-path guards for BOT_ARTIFACT_DIR, a future refactor that
  // accidentally sets the var with an empty/undefined value would point the
  // agent at `$BOT_ARTIFACT_DIR/...` and dump artifacts at filesystem root.
  it("does not set BOT_ARTIFACT_DIR when artifactsDir is undefined", () => {
    const env = buildProviderEnv("ghs_token");
    expect(env["BOT_ARTIFACT_DIR"]).toBeUndefined();
  });

  it("does not set BOT_ARTIFACT_DIR when artifactsDir is an empty string", () => {
    const env = buildProviderEnv("ghs_token", "");
    expect(env["BOT_ARTIFACT_DIR"]).toBeUndefined();
  });

  it("scrubs blank ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN so the SDK does not select an empty credential", () => {
    // Regression guard for the auth-precedence bug documented in
    // buildProviderEnv: an empty string in either of these env vars wins
    // the SDK's precedence chain and blocks the real credential. The
    // function strips them explicitly before forwarding parent env.
    const prevApi = process.env["ANTHROPIC_API_KEY"];
    const prevOauth = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    process.env["ANTHROPIC_API_KEY"] = "  ";
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "";
    try {
      const env = buildProviderEnv("ghs_token");
      expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
      expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
    } finally {
      if (prevApi === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = prevApi;
      if (prevOauth === undefined) delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
      else process.env["CLAUDE_CODE_OAUTH_TOKEN"] = prevOauth;
    }
  });

  // --- Defense layer 1a (issue #102), env allowlist regression guards ---
  //
  // These cases pin down the security property: even when banned daemon
  // secrets are set on `process.env`, they MUST NOT appear in the env
  // object handed to the Claude Code CLI subprocess. A regression here
  // re-opens the prompt-injection exfiltration path.

  it("never forwards GITHUB_APP_PRIVATE_KEY to the subprocess", () => {
    withEnv({ GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----xxx" }, () => {
      const env = buildProviderEnv("ghs_token");
      expect(env["GITHUB_APP_PRIVATE_KEY"]).toBeUndefined();
    });
  });

  it("never forwards GITHUB_WEBHOOK_SECRET to the subprocess", () => {
    withEnv({ GITHUB_WEBHOOK_SECRET: "wh-secret-value" }, () => {
      const env = buildProviderEnv("ghs_token");
      expect(env["GITHUB_WEBHOOK_SECRET"]).toBeUndefined();
    });
  });

  it("never forwards daemon or workflow-runner HMAC roots to the subprocess", () => {
    withEnv(
      {
        DAEMON_AUTH_TOKEN: "rotation-current",
        DAEMON_AUTH_TOKEN_PREVIOUS: "rotation-previous",
        WORKFLOW_RUNNER_CAPABILITY_SECRET: "runner-capability-current-secret",
        WORKFLOW_RUNNER_CAPABILITY_SECRET_PREVIOUS: "runner-capability-previous-secret",
      },
      () => {
        const env = buildProviderEnv("ghs_token");
        expect(env["DAEMON_AUTH_TOKEN"]).toBeUndefined();
        expect(env["DAEMON_AUTH_TOKEN_PREVIOUS"]).toBeUndefined();
        expect(env["WORKFLOW_RUNNER_CAPABILITY_SECRET"]).toBeUndefined();
        expect(env["WORKFLOW_RUNNER_CAPABILITY_SECRET_PREVIOUS"]).toBeUndefined();
      },
    );
  });

  it("never forwards DATABASE_URL / VALKEY_URL / REDIS_URL to the subprocess", () => {
    withEnv(
      {
        DATABASE_URL: "postgres://u:p@db/x",
        VALKEY_URL: "redis://default:p@cache:6379",
        REDIS_URL: "redis://default:p@cache:6380",
      },
      () => {
        const env = buildProviderEnv("ghs_token");
        expect(env["DATABASE_URL"]).toBeUndefined();
        expect(env["VALKEY_URL"]).toBeUndefined();
        expect(env["REDIS_URL"]).toBeUndefined();
      },
    );
  });

  it("never forwards CONTEXT7_API_KEY to the subprocess", () => {
    withEnv({ CONTEXT7_API_KEY: "ctx-key-xxx" }, () => {
      const env = buildProviderEnv("ghs_token");
      expect(env["CONTEXT7_API_KEY"]).toBeUndefined();
    });
  });

  it("never forwards dynamic-loader controls to the subprocess", () => {
    withEnv(
      {
        LD_PRELOAD: "/usr/local/lib/github-app/daemon-process-guard.so",
        LD_LIBRARY_PATH: "/controller-only",
      },
      () => {
        const env = buildProviderEnv("ghs_token");
        expect(env["LD_PRELOAD"]).toBeUndefined();
        expect(env["LD_LIBRARY_PATH"]).toBeUndefined();
      },
    );
  });

  it("never forwards GITHUB_PERSONAL_ACCESS_TOKEN by env name (PAT flows in via resolved GH_TOKEN only)", () => {
    withEnv({ GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_pat_value" }, () => {
      const env = buildProviderEnv("ghs_resolved_installation_token");
      expect(env["GITHUB_PERSONAL_ACCESS_TOKEN"]).toBeUndefined();
      // Resolved token still flows through as GH_TOKEN/GITHUB_TOKEN.
      expect(env["GH_TOKEN"]).toBe("ghs_resolved_installation_token");
    });
  });

  it("never forwards a hypothetical future GITHUB_APP_* env var (deny-prefix blocks)", () => {
    // GITHUB_* is not currently in the allow-prefix list, so the deny-prefix
    // is the last line of defence. Pinning this test means a future
    // maintainer who adds GITHUB_* (or anything overlapping GITHUB_APP_*) to
    // the allow set still fails fast here.
    withEnv({ GITHUB_APP_NEW_KNOB: "future-value" }, () => {
      const env = buildProviderEnv("ghs_token");
      expect(env["GITHUB_APP_NEW_KNOB"]).toBeUndefined();
    });
  });

  it("forwards arbitrary AWS_* / ANTHROPIC_* / CLAUDE_CODE_* keys via the prefix allowlist", () => {
    withEnv(
      {
        AWS_REGION: "us-west-2",
        AWS_PROFILE: "dev",
        ANTHROPIC_BASE_URL: "https://api.example.com",
        CLAUDE_CODE_PATH: "/opt/claude",
      },
      () => {
        const env = buildProviderEnv("ghs_token");
        expect(env["AWS_REGION"]).toBe("us-west-2");
        expect(env["AWS_PROFILE"]).toBe("dev");
        expect(env["ANTHROPIC_BASE_URL"]).toBe("https://api.example.com");
        expect(env["CLAUDE_CODE_PATH"]).toBe("/opt/claude");
      },
    );
  });

  it("does NOT set CLAUDE_CODE_SUBPROCESS_ENV_SCRUB by default (regression guard)", () => {
    // Setting this env var requires `bubblewrap` in the runtime image and
    // silently downgrades `permissionMode: bypassPermissions` when the
    // allowed-tools list contains write-capable tools. Both effects break
    // headless agent execution, so the var must not be forced on.
    // See PR #106 for the incident write-up.
    const prev = process.env["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"];
    Reflect.deleteProperty(process.env, "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB");
    try {
      const env = buildProviderEnv("ghs_token");
      expect(env["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"]).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"] = prev;
    }
  });

  it("does NOT forward arbitrary unknown keys (allowlist semantics)", () => {
    withEnv({ MY_RANDOM_OPERATOR_VAR: "should-not-leak" }, () => {
      const env = buildProviderEnv("ghs_token");
      expect(env["MY_RANDOM_OPERATOR_VAR"]).toBeUndefined();
    });
  });

  it("does forward HOME / PATH / LANG (basics needed by the CLI)", () => {
    withEnv(
      {
        HOME: "/home/test",
        PATH: "/usr/local/bin:/usr/bin",
        LANG: "en_US.UTF-8",
      },
      () => {
        const env = buildProviderEnv("ghs_token");
        expect(env["HOME"]).toBe("/home/test");
        expect(env["PATH"]).toBe("/usr/local/bin:/usr/bin");
        expect(env["LANG"]).toBe("en_US.UTF-8");
      },
    );
  });
});
