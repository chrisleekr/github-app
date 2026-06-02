import { describe, expect, it } from "bun:test";
import type { Octokit } from "octokit";

import { dispatchGithubStateTool, GITHUB_STATE_TOOLS } from "../../src/github/state-fetchers";

interface FakeOctokitOptions {
  graphql?: (query: string, vars: unknown) => Promise<unknown>;
  rest?: {
    checks?: { get?: (args: unknown) => Promise<unknown> };
    actions?: { getWorkflowRun?: (args: unknown) => Promise<unknown> };
    repos?: { getBranchProtection?: (args: unknown) => Promise<unknown> };
    pulls?: {
      get?: (args: unknown) => Promise<unknown>;
      listFiles?: (args: unknown) => Promise<unknown>;
    };
    issues?: { listComments?: (args: unknown) => Promise<unknown> };
  };
}

function fakeOctokit(opts: FakeOctokitOptions): Octokit {
  return opts as unknown as Octokit;
}

const repo = { owner: "o", repo: "r" } as const;

describe("GITHUB_STATE_TOOLS surface", () => {
  it("declares the seven read-only tools", () => {
    expect(GITHUB_STATE_TOOLS.map((t) => t.name).sort()).toEqual([
      "get_branch_protection",
      "get_check_run_output",
      "get_pr_diff",
      "get_pr_files",
      "get_pr_state_check_rollup",
      "get_workflow_run",
      "list_pr_comments",
    ]);
  });

  it("every tool has a non-empty description and JSON-Schema-shaped input", () => {
    for (const tool of GITHUB_STATE_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.input_schema["type"]).toBe("object");
    }
  });
});

describe("dispatchGithubStateTool: parameter validation", () => {
  it("rejects get_pr_state_check_rollup without pr_number", async () => {
    const result = await dispatchGithubStateTool(
      { octokit: fakeOctokit({}), ...repo },
      { id: "x", name: "get_pr_state_check_rollup", input: {} },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("pr_number required");
  });

  it("rejects unknown tool names", async () => {
    const result = await dispatchGithubStateTool(
      { octokit: fakeOctokit({}), ...repo },
      { id: "x", name: "drop_database", input: {} },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("unknown tool");
  });

  it("rejects get_branch_protection without branch", async () => {
    const result = await dispatchGithubStateTool(
      { octokit: fakeOctokit({}), ...repo },
      { id: "x", name: "get_branch_protection", input: {} },
    );
    expect(result.isError).toBe(true);
  });
});

describe("dispatchGithubStateTool: happy paths", () => {
  it("get_pr_state_check_rollup returns sorted rollup with failed+required first", async () => {
    const octokit = fakeOctokit({
      graphql: () =>
        Promise.resolve({
          repository: {
            pullRequest: {
              number: 42,
              isDraft: false,
              state: "OPEN",
              merged: false,
              mergeable: "MERGEABLE",
              mergeStateStatus: "CLEAN",
              reviewDecision: null,
              baseRefName: "main",
              headRefName: "feat",
              headRefOid: "abc",
              commits: {
                nodes: [
                  {
                    commit: {
                      oid: "abc",
                      statusCheckRollup: {
                        state: "FAILURE",
                        contexts: {
                          nodes: [
                            {
                              __typename: "CheckRun",
                              name: "passing-check",
                              databaseId: 1,
                              conclusion: "SUCCESS",
                              status: "COMPLETED",
                              isRequired: false,
                            },
                            {
                              __typename: "CheckRun",
                              name: "failing-required",
                              databaseId: 2,
                              conclusion: "FAILURE",
                              status: "COMPLETED",
                              isRequired: true,
                            },
                          ],
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        }),
    });
    const result = await dispatchGithubStateTool(
      { octokit, ...repo },
      { id: "x", name: "get_pr_state_check_rollup", input: { pr_number: 42 } },
    );
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as {
      checks: { name: string; conclusion?: string }[];
    };
    expect(parsed.checks[0]?.name).toBe("failing-required");
    expect(parsed.checks[1]?.name).toBe("passing-check");
  });

  it("get_branch_protection returns protected:false on 404 (unprotected branch)", async () => {
    const octokit = fakeOctokit({
      rest: {
        repos: {
          getBranchProtection: () => {
            // Octokit's RequestError carries a numeric `status` field.
            const err = new Error("Not Found") as Error & { status: number };
            err.status = 404;
            return Promise.reject(err);
          },
        },
      },
    });
    const result = await dispatchGithubStateTool(
      { octokit, ...repo },
      { id: "x", name: "get_branch_protection", input: { branch: "feat-x" } },
    );
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toEqual({ branch: "feat-x", protected: false });
  });

  it("get_pr_files passes through the listFiles result", async () => {
    const octokit = fakeOctokit({
      rest: {
        pulls: {
          listFiles: () =>
            Promise.resolve({
              data: [
                {
                  filename: "a.ts",
                  status: "modified",
                  additions: 3,
                  deletions: 1,
                  changes: 4,
                },
              ],
            }),
        },
      },
    });
    const result = await dispatchGithubStateTool(
      { octokit, ...repo },
      { id: "x", name: "get_pr_files", input: { pr_number: 1 } },
    );
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as { file_count: number };
    expect(parsed.file_count).toBe(1);
  });

  it("list_pr_comments rejects non-positive-integer page", async () => {
    const result = await dispatchGithubStateTool(
      { octokit: fakeOctokit({}), ...repo },
      { id: "x", name: "list_pr_comments", input: { pr_number: 1, page: 0 } },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("page must be a positive integer");
  });

  it("list_pr_comments rejects non-integer page (NaN, fractional)", async () => {
    const result = await dispatchGithubStateTool(
      { octokit: fakeOctokit({}), ...repo },
      { id: "x", name: "list_pr_comments", input: { pr_number: 1, page: 1.5 } },
    );
    expect(result.isError).toBe(true);
  });

  it("non-404 errors from a fetcher become is_error tool results", async () => {
    const octokit = fakeOctokit({
      rest: {
        repos: {
          getBranchProtection: () => {
            // A non-retriable status (422) surfaces immediately as is_error.
            // The fetchers now wrap calls in retryWithBackoff (#199), so a
            // retriable status (5xx/429/network) would be retried first; that
            // retry behaviour is covered in test/utils/retry.test.ts. Using a
            // non-retriable status here keeps this surfacing test fast.
            const err = new Error("Validation Failed") as Error & { status: number };
            err.status = 422;
            return Promise.reject(err);
          },
        },
      },
    });
    const result = await dispatchGithubStateTool(
      { octokit, ...repo },
      { id: "x", name: "get_branch_protection", input: { branch: "main" } },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Validation Failed");
  });
});
