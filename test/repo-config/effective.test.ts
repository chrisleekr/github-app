import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Octokit } from "octokit";
import type { Logger } from "pino";

import { config } from "../../src/config";
import {
  DEFAULT_REPO_POLICY,
  type EffectiveWorkflowPolicy,
  loadRepoPolicy,
  policyForWorkflow,
  resolvePolicy,
  toAgentPolicy,
} from "../../src/repo-config/effective";
import { __resetRepoConfigCaches } from "../../src/repo-config/fetcher";
import { type GithubAppConfig, githubAppConfigSchema } from "../../src/repo-config/schema";
import { AGENT_POLICY_WARNING_MAX, serverMessageSchema } from "../../src/shared/ws-messages";

const log = {
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  error: () => undefined,
} as unknown as Logger;

function parse(doc: unknown): GithubAppConfig {
  return githubAppConfigSchema.parse(doc);
}

function octokitServing(yaml: string | { status: number }): Octokit {
  return {
    rest: {
      repos: {
        getContent: () => {
          if (typeof yaml !== "string") {
            const err = new Error("boom") as Error & { status: number };
            err.status = yaml.status;
            return Promise.reject(err);
          }
          return Promise.resolve({
            data: {
              type: "file",
              content: Buffer.from(yaml, "utf-8").toString("base64"),
              sha: "s",
            },
            headers: {},
          });
        },
      },
    },
  } as unknown as Octokit;
}

// The clamp is against the live config singleton, so the ceilings are saved
// and restored rather than assumed.
const savedMaxTurns = config.agentMaxTurns;
const savedDefaultMaxTurns = config.defaultMaxTurns;
const savedTimeoutMs = config.agentTimeoutMs;

interface MutableCeilings {
  agentMaxTurns?: number | undefined;
  defaultMaxTurns?: number | undefined;
  agentTimeoutMs: number;
}

describe("resolvePolicy and policyForWorkflow", () => {
  beforeEach(() => {
    __resetRepoConfigCaches();
    // Both turn ceilings are pinned, not just the one under test: the resolver
    // reads `agentMaxTurns ?? defaultMaxTurns`, so leaving DEFAULT_MAXTURNS to
    // whatever the ambient env holds makes the fallback case untestable.
    (config as MutableCeilings).agentMaxTurns = 100;
    (config as MutableCeilings).defaultMaxTurns = undefined;
    (config as MutableCeilings).agentTimeoutMs = 600_000;
  });

  afterEach(() => {
    (config as MutableCeilings).agentMaxTurns = savedMaxTurns;
    (config as MutableCeilings).defaultMaxTurns = savedDefaultMaxTurns;
    (config as MutableCeilings).agentTimeoutMs = savedTimeoutMs;
  });

  it("layers a workflow entry over the repo defaults", () => {
    const policy = resolvePolicy(
      parse({
        version: 1,
        defaults: { model: "default-model", max_turns: 50 },
        workflows: { implement: { model: "implement-model" } },
      }),
    );

    expect(policy.defaults.model).toBe("default-model");
    const implement = policyForWorkflow(policy, "implement");
    expect(implement.model).toBe("implement-model");
    expect(implement.maxTurns).toBe(50); // inherited, not overridden
    // A workflow with no entry falls all the way through to the defaults.
    expect(policyForWorkflow(policy, "plan").model).toBe("default-model");
  });

  it("clamps max_turns and timeout down to the server ceilings, never up", () => {
    const policy = resolvePolicy(
      parse({
        version: 1,
        defaults: { max_turns: 500, timeout: "60m" },
        workflows: { review: { max_turns: 20, timeout: "5m" } },
      }),
    );

    expect(policy.defaults.maxTurns).toBe(100); // clamped from 500
    expect(policy.defaults.timeoutMs).toBe(600_000); // clamped from 3_600_000
    const review = policyForWorkflow(policy, "review");
    expect(review.maxTurns).toBe(20); // below the ceiling, kept as written
    expect(review.timeoutMs).toBe(300_000);
  });

  it("falls back to DEFAULT_MAXTURNS only when AGENT_MAX_TURNS is unset", () => {
    const doc = parse({ version: 1, defaults: { max_turns: 500 } });

    // AGENT_MAX_TURNS overrides DEFAULT_MAXTURNS at runtime (the `maxTurns`
    // assignment in `connection-handler.ts`), so the resolver must clamp
    // against the winner alone. Intersecting both would cap this at 30.
    (config as MutableCeilings).defaultMaxTurns = 30;
    expect(resolvePolicy(doc).defaults.maxTurns).toBe(100);

    (config as MutableCeilings).agentMaxTurns = undefined;
    expect(resolvePolicy(doc).defaults.maxTurns).toBe(30);

    // Neither ceiling set: no cap, the config value applies as written.
    (config as MutableCeilings).defaultMaxTurns = undefined;
    expect(resolvePolicy(doc).defaults.maxTurns).toBe(500);
  });

  it("unions and dedupes extra_allowed_tools across defaults and the entry", () => {
    const policy = resolvePolicy(
      parse({
        version: 1,
        defaults: { extra_allowed_tools: ["Bash(bun run lint:*)", "WebSearch"] },
        workflows: { review: { extra_allowed_tools: ["WebSearch", "WebFetch"] } },
      }),
    );

    expect([...policyForWorkflow(policy, "review").extraAllowedTools].sort()).toEqual([
      "Bash(bun run lint:*)",
      "WebFetch",
      "WebSearch",
    ]);
  });

  it("keeps review-only fields on review and empty elsewhere", () => {
    const policy = resolvePolicy(
      parse({
        version: 1,
        workflows: { review: { path_filters: ["dist/**"], instructions: "be strict" } },
      }),
    );

    expect(policyForWorkflow(policy, "review").pathFilters).toEqual(["dist/**"]);
    expect(policyForWorkflow(policy, "review").instructions).toBe("be strict");
    expect(policyForWorkflow(policy, "plan").pathFilters).toEqual([]);
    expect(policyForWorkflow(policy, "plan").instructions).toBeUndefined();
  });

  it("carries `enabled: false` through from the document", () => {
    const policy = resolvePolicy(
      parse({ version: 1, enabled: false, workflows: { ship: { enabled: false } } }),
    );
    expect(policy.enabled).toBe(false);
    expect(policyForWorkflow(policy, "ship").enabled).toBe(false);
    expect(policyForWorkflow(policy, "review").enabled).toBe(true);
  });
});

describe("loadRepoPolicy", () => {
  beforeEach(() => {
    __resetRepoConfigCaches();
  });

  it("resolves a valid document", async () => {
    const policy = await loadRepoPolicy({
      octokit: octokitServing("version: 1\nenabled: false\n"),
      owner: "acme",
      repo: "widgets",
      log,
    });
    expect(policy.enabled).toBe(false);
    expect(policy.warning).toBeUndefined();
  });

  it("falls open to defaults with a warning when the file is invalid", async () => {
    const policy = await loadRepoPolicy({
      octokit: octokitServing("version: 1\nworkflows:\n  revue: {}\n"),
      owner: "acme",
      repo: "widgets",
      log,
    });
    expect(policy.enabled).toBe(true);
    expect(policy.source).toBeUndefined();
    expect(policy.warning).toContain("failed validation");
  });

  it("falls open silently when the file is absent", async () => {
    const policy = await loadRepoPolicy({
      octokit: octokitServing({ status: 404 }),
      owner: "acme",
      repo: "widgets",
      log,
    });
    expect(policy).toEqual(DEFAULT_REPO_POLICY);
  });

  it("falls open on a non-HTTP octokit failure, with no gate_error", async () => {
    // A synchronous throw carries no `status`, so it takes neither the 304 nor
    // the 404 branch. It is still absorbed inside `fetchRepoConfig` (the call
    // sits in its try block) and degrades to `absent`, which is what keeps
    // Gate 1 fail-open for transport faults that are not clean HTTP errors.
    // `loadRepoPolicy`'s own catch stays unreached, matching its comment: it
    // guards against config access or import-cycle faults, not fetch faults.
    const exploding = {
      rest: {
        repos: {
          getContent: () => {
            throw new Error("octokit exploded");
          },
        },
      },
    } as unknown as Octokit;

    const errors: unknown[] = [];
    const capturingLog = { ...log, error: (o: unknown) => errors.push(o) } as unknown as Logger;

    const policy = await loadRepoPolicy({
      octokit: exploding,
      owner: "acme",
      repo: "widgets",
      log: capturingLog,
    });

    expect(policy).toEqual(DEFAULT_REPO_POLICY);
    // No `repo_config.gate_error`: the observability page tells operators that
    // event means a bug, and a flaky transport is not one.
    expect(errors).toHaveLength(0);
  });
});

// ─── Producer-vs-wire contract for the fail-open warning ─────────────────────

describe("loadRepoPolicy: warning fits the wire cap", () => {
  const savedRepoConfigFile = config.repoConfigFile;

  beforeEach(() => {
    __resetRepoConfigCaches();
  });

  afterEach(() => {
    (config as { repoConfigFile: string }).repoConfigFile = savedRepoConfigFile;
  });

  /** A `job:payload` carrying `warning`, parsed exactly as the daemon does. */
  function parsesOnTheWire(warning: string): boolean {
    return serverMessageSchema.safeParse({
      type: "job:payload",
      id: "11111111-1111-4111-8111-111111111111",
      timestamp: Date.now(),
      payload: {
        context: {},
        installationToken: "ghs_abc123",
        allowedTools: [],
        policy: { warning },
      },
    }).success;
  }

  it("keeps a realistic worst-case warning inside the daemon's parse cap", async () => {
    // The notice length is emergent: MAX_RENDERED_ISSUES lines of at most
    // MAX_ISSUE_LENGTH chars each (src/repo-config/fetcher.ts). Long keys
    // force every rendered line to its own cap, which is the widest shape the
    // fetcher can hand the producer today.
    //
    // One unknown key per workflow block, NOT several on one object: zod 4
    // collapses every unknown key of a single `strictObject` into ONE
    // `unrecognized_keys` issue carrying a `keys` array, so a flat fixture
    // renders a single line and never reaches the cap this case exists to pin.
    const longKey = "y".repeat(200);
    const blocks = ["triage", "plan", "implement", "review", "resolve", "remember"]
      .map((name) => `  ${name}:\n    ${longKey}: 1`)
      .join("\n");
    const policy = await loadRepoPolicy({
      octokit: octokitServing(`version: 1\nworkflows:\n${blocks}\n`),
      owner: "acme",
      repo: "widgets",
      log,
    });

    expect(policy.warning).toBeDefined();
    expect(policy.warning?.length).toBeLessThanOrEqual(AGENT_POLICY_WARNING_MAX);
    expect(parsesOnTheWire(policy.warning ?? "")).toBe(true);
  });

  it("truncates at the producer rather than letting the wire drop the job", async () => {
    // A silent parse failure in the daemon discards a job the orchestrator has
    // already charged a capacity slot for, so the producer must clamp. The
    // filename is the one part of the template a test can stretch on demand.
    (config as { repoConfigFile: string }).repoConfigFile = `${"a".repeat(2000)}.yaml`;

    const policy = await loadRepoPolicy({
      octokit: octokitServing("version: 1\nworkflows:\n  revue: {}\n"),
      owner: "acme",
      repo: "widgets",
      log,
    });

    expect(policy.warning).toBeDefined();
    expect(policy.warning).toHaveLength(AGENT_POLICY_WARNING_MAX);
    expect(policy.warning?.endsWith("…")).toBe(true);
    expect(parsesOnTheWire(policy.warning ?? "")).toBe(true);
  });
});

// ─── toAgentPolicy: the `job:payload` projection ─────────────────────────────

describe("toAgentPolicy", () => {
  function wf(overrides: Partial<EffectiveWorkflowPolicy> = {}): EffectiveWorkflowPolicy {
    return { enabled: true, extraAllowedTools: [], pathFilters: [], auto: false, ...overrides };
  }

  it("returns undefined when nothing is configured", () => {
    // Load-bearing for rolling deploys: no key means the payload stays
    // byte-identical to the pre-Gate-2 one an older daemon expects.
    expect(toAgentPolicy(wf(), undefined)).toBeUndefined();
  });

  it("omits empty arrays instead of emitting []", () => {
    const policy = toAgentPolicy(wf({ model: "m" }), undefined);
    expect(policy).toEqual({ model: "m" });
    expect(Object.hasOwn(policy ?? {}, "extraAllowedTools")).toBe(false);
    expect(Object.hasOwn(policy ?? {}, "pathFilters")).toBe(false);
  });

  it("projects the review-only fields and the warning", () => {
    const policy = toAgentPolicy(
      wf({
        model: "repo-model",
        timeoutMs: 300_000,
        extraAllowedTools: ["WebFetch"],
        pathFilters: ["dist/**"],
        instructions: "be strict",
      }),
      "config was ignored",
    );

    expect(policy).toEqual({
      model: "repo-model",
      timeoutMs: 300_000,
      extraAllowedTools: ["WebFetch"],
      pathFilters: ["dist/**"],
      instructions: "be strict",
      warning: "config was ignored",
    });
  });

  it("omits maxTurns, which rides the top-level payload field instead", () => {
    expect(toAgentPolicy(wf({ maxTurns: 42 }), undefined)).toBeUndefined();
  });

  it("copies the arrays rather than aliasing the resolved policy", () => {
    const source = wf({ extraAllowedTools: ["WebFetch"], pathFilters: ["dist/**"] });
    const policy = toAgentPolicy(source, undefined);

    expect(policy?.extraAllowedTools).not.toBe(source.extraAllowedTools);
    expect(policy?.pathFilters).not.toBe(source.pathFilters);
  });
});

describe("workflows.review.auto resolution (work item #1)", () => {
  function policyFrom(doc: Record<string, unknown>) {
    return resolvePolicy(githubAppConfigSchema.parse({ version: 1, ...doc }));
  }

  it("resolves to false when the file declares nothing", () => {
    expect(policyForWorkflow(policyFrom({}), "review").auto).toBe(false);
  });

  it("resolves to true when the repo opts in", () => {
    const policy = policyFrom({ workflows: { review: { auto: true } } });
    expect(policyForWorkflow(policy, "review").auto).toBe(true);
  });

  it("is false on DEFAULT_REPO_POLICY, the fail-open fallback", () => {
    // This is the property the default-off choice exists for: a missing,
    // unreachable, or invalid config must not enable auto-review.
    expect(DEFAULT_REPO_POLICY.defaults.auto).toBe(false);
    expect(policyForWorkflow(DEFAULT_REPO_POLICY, "review").auto).toBe(false);
  });

  it("is false for every non-review workflow even when review opts in", () => {
    const policy = policyFrom({ workflows: { review: { auto: true }, triage: { enabled: true } } });
    expect(policyForWorkflow(policy, "triage").auto).toBe(false);
    expect(policyForWorkflow(policy, "resolve").auto).toBe(false);
  });

  it("does not reach the job:payload wire", () => {
    // `auto` is a dispatch-time decision. Shipping it to the daemon would imply
    // the agent could act on it, which it cannot.
    const wf = policyForWorkflow(policyFrom({ workflows: { review: { auto: true } } }), "review");
    expect(toAgentPolicy(wf, undefined)).toBeUndefined();
  });
});
