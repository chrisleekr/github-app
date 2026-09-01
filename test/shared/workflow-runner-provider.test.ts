import { describe, expect, it } from "bun:test";

import {
  assertExactWorkflowRunnerProviderEnvironment,
  WorkflowRunnerProviderConfigurationError,
  workflowRunnerProviderEnv,
} from "../../src/shared/workflow-runner-provider";

type RunnerProviderConfig = Parameters<typeof workflowRunnerProviderEnv>[0];

const baseConfig: RunnerProviderConfig = {
  provider: "anthropic",
  model: "claude-test",
  anthropicApiKey: undefined,
  claudeCodeOauthToken: undefined,
  awsRegion: undefined,
  awsProfile: undefined,
  awsAccessKeyId: undefined,
  awsSecretAccessKey: undefined,
  awsSessionToken: undefined,
  awsBearerTokenBedrock: undefined,
  anthropicBedrockBaseUrl: undefined,
  allowedOwners: undefined,
};

function providerConfig(overrides: Partial<RunnerProviderConfig>): RunnerProviderConfig {
  return { ...baseConfig, ...overrides };
}

function environment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { CLAUDE_PROVIDER: "anthropic", ...overrides };
}

describe("workflowRunnerProviderEnv", () => {
  it("selects the API key when both Anthropic credentials are configured", () => {
    expect(
      workflowRunnerProviderEnv(
        providerConfig({
          anthropicApiKey: "api-key",
          claudeCodeOauthToken: "oauth-token",
          allowedOwners: ["owner-a", "owner-b"],
        }),
      ),
    ).toEqual([
      { name: "CLAUDE_PROVIDER", value: "anthropic" },
      { name: "CLAUDE_MODEL", value: "claude-test" },
      { name: "ANTHROPIC_API_KEY", secretKey: "ANTHROPIC_API_KEY" },
      { name: "ALLOWED_OWNERS", value: "owner-a,owner-b" },
    ]);
  });

  it("selects Anthropic OAuth when no API key is configured", () => {
    expect(
      workflowRunnerProviderEnv(providerConfig({ claudeCodeOauthToken: "oauth-token" })),
    ).toContainEqual({
      name: "CLAUDE_CODE_OAUTH_TOKEN",
      secretKey: "CLAUDE_CODE_OAUTH_TOKEN",
    });
  });

  it("rejects Anthropic without a credential", () => {
    expect(() => workflowRunnerProviderEnv(baseConfig)).toThrow(
      WorkflowRunnerProviderConfigurationError,
    );
  });

  it("selects a Bedrock bearer token and omits configured static credentials", () => {
    expect(
      workflowRunnerProviderEnv(
        providerConfig({
          provider: "bedrock",
          awsRegion: "ap-southeast-2",
          awsBearerTokenBedrock: "bearer-token",
          awsAccessKeyId: "access-key",
          awsSecretAccessKey: "secret-key",
          anthropicBedrockBaseUrl: "https://bedrock.example.test",
        }),
      ),
    ).toEqual([
      { name: "CLAUDE_PROVIDER", value: "bedrock" },
      { name: "CLAUDE_MODEL", value: "claude-test" },
      { name: "AWS_REGION", value: "ap-southeast-2" },
      { name: "ANTHROPIC_BEDROCK_BASE_URL", value: "https://bedrock.example.test" },
      { name: "AWS_BEARER_TOKEN_BEDROCK", secretKey: "AWS_BEARER_TOKEN_BEDROCK" },
    ]);
  });

  it("selects a complete Bedrock static session chain", () => {
    expect(
      workflowRunnerProviderEnv(
        providerConfig({
          provider: "bedrock",
          awsRegion: "ap-southeast-2",
          awsAccessKeyId: "access-key",
          awsSecretAccessKey: "secret-key",
          awsSessionToken: "session-token",
        }),
      ).filter((entry) => entry.secretKey !== undefined),
    ).toEqual([
      { name: "AWS_ACCESS_KEY_ID", secretKey: "AWS_ACCESS_KEY_ID" },
      { name: "AWS_SECRET_ACCESS_KEY", secretKey: "AWS_SECRET_ACCESS_KEY" },
      { name: "AWS_SESSION_TOKEN", secretKey: "AWS_SESSION_TOKEN" },
    ]);
  });

  it("rejects Bedrock without a region", () => {
    expect(() =>
      workflowRunnerProviderEnv(
        providerConfig({ provider: "bedrock", awsBearerTokenBedrock: "bearer-token" }),
      ),
    ).toThrow("Bedrock workflow runners require AWS_REGION");
  });

  it.each([
    "http://bedrock.example.test",
    "https://user@bedrock.example.test",
    "https://user:secret@bedrock.example.test",
    "https://bedrock.example.test?token=secret",
    "https://bedrock.example.test#fragment",
    " bedrock.example.test ",
  ])("rejects unsafe Bedrock base URL %s", (baseUrl) => {
    expect(() =>
      workflowRunnerProviderEnv(
        providerConfig({
          provider: "bedrock",
          awsRegion: "ap-southeast-2",
          awsBearerTokenBedrock: "bearer-token",
          anthropicBedrockBaseUrl: baseUrl,
        }),
      ),
    ).toThrow(WorkflowRunnerProviderConfigurationError);
  });

  it.each([
    ["access key only", { awsAccessKeyId: "access-key" }],
    ["secret key only", { awsSecretAccessKey: "secret-key" }],
    ["session token only", { awsSessionToken: "session-token" }],
    ["profile only", { awsProfile: "runner-profile" }],
  ])("rejects an incomplete Bedrock %s configuration", (_name, credentials) => {
    expect(() =>
      workflowRunnerProviderEnv(
        providerConfig({ provider: "bedrock", awsRegion: "ap-southeast-2", ...credentials }),
      ),
    ).toThrow(WorkflowRunnerProviderConfigurationError);
  });
});

describe("assertExactWorkflowRunnerProviderEnvironment", () => {
  it.each([
    ["Anthropic API key", environment({ ANTHROPIC_API_KEY: "api-key" })],
    ["Anthropic OAuth", environment({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" })],
    [
      "Bedrock bearer",
      environment({
        CLAUDE_PROVIDER: "bedrock",
        AWS_BEARER_TOKEN_BEDROCK: "bearer-token",
      }),
    ],
    [
      "Bedrock static",
      environment({
        CLAUDE_PROVIDER: "bedrock",
        AWS_ACCESS_KEY_ID: "access-key",
        AWS_SECRET_ACCESS_KEY: "secret-key",
      }),
    ],
    [
      "Bedrock static session",
      environment({
        CLAUDE_PROVIDER: "bedrock",
        AWS_ACCESS_KEY_ID: "access-key",
        AWS_SECRET_ACCESS_KEY: "secret-key",
        AWS_SESSION_TOKEN: "session-token",
      }),
    ],
  ])("accepts exactly one %s chain", (_name, env) => {
    expect(() => {
      assertExactWorkflowRunnerProviderEnvironment(env);
    }).not.toThrow();
  });

  it.each([
    ["missing provider", {}],
    ["unknown provider", { CLAUDE_PROVIDER: "unknown", ANTHROPIC_API_KEY: "api-key" }],
    [
      "dual Anthropic",
      environment({ ANTHROPIC_API_KEY: "api-key", CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" }),
    ],
    [
      "Anthropic with AWS",
      environment({ ANTHROPIC_API_KEY: "api-key", AWS_ACCESS_KEY_ID: "access-key" }),
    ],
    [
      "Bedrock with Anthropic",
      environment({
        CLAUDE_PROVIDER: "bedrock",
        AWS_BEARER_TOKEN_BEDROCK: "bearer-token",
        ANTHROPIC_API_KEY: "api-key",
      }),
    ],
    [
      "mixed Bedrock chains",
      environment({
        CLAUDE_PROVIDER: "bedrock",
        AWS_BEARER_TOKEN_BEDROCK: "bearer-token",
        AWS_ACCESS_KEY_ID: "access-key",
        AWS_SECRET_ACCESS_KEY: "secret-key",
      }),
    ],
    ["Bedrock access only", environment({ CLAUDE_PROVIDER: "bedrock", AWS_ACCESS_KEY_ID: "key" })],
    [
      "Bedrock secret only",
      environment({ CLAUDE_PROVIDER: "bedrock", AWS_SECRET_ACCESS_KEY: "secret" }),
    ],
    [
      "orphan Bedrock session",
      environment({ CLAUDE_PROVIDER: "bedrock", AWS_SESSION_TOKEN: "session" }),
    ],
    ["Bedrock profile", environment({ CLAUDE_PROVIDER: "bedrock", AWS_PROFILE: "runner-profile" })],
  ])("rejects %s", (_name, env) => {
    expect(() => {
      assertExactWorkflowRunnerProviderEnvironment(env);
    }).toThrow(WorkflowRunnerProviderConfigurationError);
  });
});
