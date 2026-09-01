import { resolve } from "node:path";

import { describe, expect, it } from "bun:test";

const FIXTURE = resolve(import.meta.dir, "..", "fixtures", "fatal-handler-fixture.ts");

// The fixture imports src/logger -> src/config, which validates env at import.
// cwd is set to a directory without a .env so Bun does not autoload the repo's
// local .env (which may set CLAUDE_PROVIDER=bedrock etc.); all required config
// vars are passed explicitly. NODE_ENV is not "development", so the logger uses
// the default destination (JSON to stdout), not the pino-pretty transport.
type FixtureMode = "uncaught" | "unhandled" | "unhandled-string" | "unhandled-object";

function runFixture(mode: FixtureMode): { exitCode: number; stdout: string } {
  const proc = Bun.spawnSync(["bun", "run", FIXTURE, mode], {
    cwd: "/tmp",
    env: {
      PATH: process.env["PATH"] ?? "",
      NODE_ENV: "test",
      CLAUDE_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "test-anthropic-key",
      GITHUB_APP_ID: "test-app-id",
      GITHUB_APP_PRIVATE_KEY: "test-private-key",
      GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
      DAEMON_AUTH_TOKEN: "test-daemon-token",
      WORKFLOW_RUNNER_CAPABILITY_SECRET: "test-workflow-runner-capability-secret",
      DATABASE_URL: "postgres://bot:bot@localhost:5432/x",
      VALKEY_URL: "redis://localhost:6379",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode ?? -1, stdout: proc.stdout.toString() };
}

function findFatalLine(stdout: string, kind: string): Record<string, unknown> | undefined {
  for (const raw of stdout.trim().split("\n")) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      if (obj["msg"] === kind) return obj;
    } catch {
      // non-JSON line (e.g. a config warning); skip.
    }
  }
  return undefined;
}

describe("installFatalHandlers (#164)", () => {
  const cases: readonly (readonly [FixtureMode, string])[] = [
    ["uncaught", "uncaughtException"],
    ["unhandled", "unhandledRejection"],
    // Non-Error rejection reason: must still be redacted after coercion (#164).
    ["unhandled-string", "unhandledRejection"],
  ];

  for (const [mode, kind] of cases) {
    it(`emits a redacted fatal line and exits 1 on ${kind} (${mode})`, () => {
      const { exitCode, stdout } = runFixture(mode);
      expect(exitCode).toBe(1);

      const line = findFatalLine(stdout, kind);
      expect(line).toBeDefined();
      // fatal level is 60, operators can alert on level:60 over a window.
      expect(line?.["level"]).toBe(60);
      expect(line?.["processName"]).toBe("daemon");

      // The ghs_ token in the Error message must be scrubbed by errSerializer
      // before it reaches stdout, the whole point of the crash handler.
      expect(stdout).not.toContain(`ghs_${"A".repeat(36)}`);
      expect(JSON.stringify(line)).toContain("[REDACTED_GITHUB_TOKEN]");
    });
  }

  it("censors an opaque secret under a sensitive key in a bare-object rejection", () => {
    const { exitCode, stdout } = runFixture("unhandled-object");
    expect(exitCode).toBe(1);
    const line = findFatalLine(stdout, "unhandledRejection");
    expect(line).toBeDefined();
    // scrubStructured censors the `authorization` value by field name before
    // the object is flattened into the Error message.
    expect(stdout).not.toContain("opaque-non-ghs-secret-XYZ");
  });
});
