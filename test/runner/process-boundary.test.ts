import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import {
  assertCloudMetadataUnavailable,
  assertWorkflowRunnerEnvironment,
  FORBIDDEN_RUNNER_ENV,
} from "../../src/runner/process-boundary";
import { expectToReject } from "../utils/assertions";

const originalValues = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;
const providerEnv = [
  "CLAUDE_PROVIDER",
  "CLAUDE_MODEL",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_REGION",
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_BEDROCK_BASE_URL",
] as const;
const allowedRunnerEnv = [...providerEnv, "ALLOWED_OWNERS", "WORKFLOW_RUNNER_TOKEN"] as const;
const metadataEndpoints = [
  "http://169.254.169.254/",
  "http://[fd00:ec2::254]/",
  "http://[fd20:ce::254]/",
] as const;

beforeEach(() => {
  for (const name of FORBIDDEN_RUNNER_ENV) {
    originalValues.set(name, process.env[name]);
    Reflect.deleteProperty(process.env, name);
  }
  for (const name of allowedRunnerEnv) {
    originalValues.set(name, process.env[name]);
    Reflect.deleteProperty(process.env, name);
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const name of [...FORBIDDEN_RUNNER_ENV, ...allowedRunnerEnv]) {
    const value = originalValues.get(name);
    if (value === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = value;
    }
  }
  originalValues.clear();
});

describe("workflow runner parent environment boundary", () => {
  it("accepts provider-only and runner control variables", () => {
    process.env["CLAUDE_PROVIDER"] = "anthropic";
    process.env["CLAUDE_MODEL"] = "claude-test";
    process.env["ANTHROPIC_API_KEY"] = "provider-key";
    process.env["ALLOWED_OWNERS"] = "owner";
    process.env["WORKFLOW_RUNNER_TOKEN"] = "attempt-capability";

    expect(assertWorkflowRunnerEnvironment).not.toThrow();
  });

  it("rejects dual Anthropic credentials", () => {
    process.env["CLAUDE_PROVIDER"] = "anthropic";
    process.env["CLAUDE_MODEL"] = "claude-test";
    process.env["ANTHROPIC_API_KEY"] = "provider-key";
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "provider-oauth";

    expect(assertWorkflowRunnerEnvironment).toThrow("exactly one Anthropic credential");
  });

  it("rejects an unselected provider credential", () => {
    process.env["CLAUDE_PROVIDER"] = "anthropic";
    process.env["CLAUDE_MODEL"] = "claude-test";
    process.env["ANTHROPIC_API_KEY"] = "provider-key";
    process.env["AWS_BEARER_TOKEN_BEDROCK"] = "unselected-credential";

    expect(assertWorkflowRunnerEnvironment).toThrow("no AWS credentials");
  });

  it("accepts one Bedrock static credential chain", () => {
    process.env["CLAUDE_PROVIDER"] = "bedrock";
    process.env["CLAUDE_MODEL"] = "bedrock-model";
    process.env["AWS_REGION"] = "ap-southeast-2";
    process.env["AWS_ACCESS_KEY_ID"] = "access";
    process.env["AWS_SECRET_ACCESS_KEY"] = "secret";
    process.env["AWS_SESSION_TOKEN"] = "session";

    expect(assertWorkflowRunnerEnvironment).not.toThrow();
  });

  for (const name of FORBIDDEN_RUNNER_ENV) {
    it(`rejects ${name}`, () => {
      process.env[name] = "must-not-reach-runner";
      expect(assertWorkflowRunnerEnvironment).toThrow(name);
    });
  }

  it("does not reject empty forbidden variables", () => {
    for (const name of FORBIDDEN_RUNNER_ENV) process.env[name] = "  ";
    process.env["CLAUDE_PROVIDER"] = "anthropic";
    process.env["CLAUDE_MODEL"] = "claude-test";
    process.env["ANTHROPIC_API_KEY"] = "provider-key";
    expect(assertWorkflowRunnerEnvironment).not.toThrow();
  });
});

describe("workflow runner cloud metadata boundary", () => {
  it("accepts a network where metadata endpoints are unreachable", async () => {
    const requested: string[] = [];
    globalThis.fetch = mock((input: string | URL | Request) => {
      requested.push(requestUrl(input));
      return Promise.reject(new TypeError("unreachable"));
    }) as typeof fetch;
    await assertCloudMetadataUnavailable();
    expect(requested).toEqual(metadataEndpoints);
  });

  it("accepts metadata probes dropped until their timeout", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new DOMException("The operation timed out", "TimeoutError")),
    ) as typeof fetch;

    await assertCloudMetadataUnavailable();
  });

  for (const endpoint of metadataEndpoints) {
    it(`rejects any HTTP response from ${endpoint}`, async () => {
      globalThis.fetch = mock((input: string | URL | Request) =>
        requestUrl(input) === endpoint
          ? Promise.resolve(new Response("", { status: 403 }))
          : Promise.reject(new TypeError("unreachable")),
      ) as typeof fetch;

      await expectToReject(assertCloudMetadataUnavailable(), endpoint);
    });
  }
});

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}
