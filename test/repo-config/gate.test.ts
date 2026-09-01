import { describe, expect, it } from "bun:test";

import {
  DEFAULT_REPO_POLICY,
  type EffectiveRepoPolicy,
  resolvePolicy,
} from "../../src/repo-config/effective";
import { checkRepoGate, type RepoGateVerdict } from "../../src/repo-config/gate";
import { githubAppConfigSchema } from "../../src/repo-config/schema";

/** Build a policy from a partial YAML document, exercising the real schema. */
function policyFrom(doc: Record<string, unknown>): EffectiveRepoPolicy {
  return resolvePolicy(githubAppConfigSchema.parse({ version: 1, ...doc }));
}

/** Narrow to the blocked arm, so `reason` is reachable without a cast. */
function reasonOf(verdict: RepoGateVerdict): string {
  if (verdict.allowed) throw new Error("expected a blocked verdict");
  return verdict.reason;
}

describe("checkRepoGate", () => {
  it("allows everything under the default policy", () => {
    const verdict = checkRepoGate({ policy: DEFAULT_REPO_POLICY, senderLogin: "octocat" });
    expect(verdict.allowed).toBe(true);
  });

  it("rule 1: blocks and explains when the repo is disabled", () => {
    const verdict = checkRepoGate({
      policy: policyFrom({ enabled: false }),
      workflowName: "review",
      senderLogin: "octocat",
    });
    expect(verdict).toEqual({
      allowed: false,
      reason: "the bot is disabled for this repository",
      explain: true,
    });
  });

  it("rule 2: blocks and explains when the workflow is disabled", () => {
    const policy = policyFrom({ workflows: { review: { enabled: false } } });
    const blocked = checkRepoGate({ policy, workflowName: "review", senderLogin: "octocat" });
    expect(blocked.allowed).toBe(false);
    expect(blocked).toMatchObject({ explain: true });
    expect(reasonOf(blocked)).toContain("review");

    // A different workflow in the same repo is unaffected.
    expect(checkRepoGate({ policy, workflowName: "plan", senderLogin: "octocat" }).allowed).toBe(
      true,
    );
  });

  it("rule 2 is skipped when the caller has no workflow name yet", () => {
    // The comment path gates before the intent classifier runs, so it cannot
    // name a workflow. It must not be blocked by a per-workflow toggle.
    const policy = policyFrom({ workflows: { review: { enabled: false } } });
    expect(checkRepoGate({ policy, senderLogin: "octocat" }).allowed).toBe(true);
  });

  it("rule 3: blocks and explains when the sender is not in allowed_users", () => {
    const policy = policyFrom({ triggers: { allowed_users: ["maintainer"] } });
    const blocked = checkRepoGate({ policy, senderLogin: "drive-by" });
    expect(blocked).toMatchObject({ allowed: false, explain: true });
    expect(checkRepoGate({ policy, senderLogin: "maintainer" }).allowed).toBe(true);
  });

  it("rule 3: login matching is case-insensitive, as GitHub logins are", () => {
    const policy = policyFrom({ triggers: { allowed_users: ["Maintainer"] } });
    expect(checkRepoGate({ policy, senderLogin: "maintainer" }).allowed).toBe(true);
  });

  it("rule 4: blocks silently when the sender is in ignore_authors", () => {
    const policy = policyFrom({ triggers: { ignore_authors: ["renovate[bot]"] } });
    expect(checkRepoGate({ policy, senderLogin: "renovate[bot]" })).toEqual({
      allowed: false,
      reason: "author is in `triggers.ignore_authors`",
      explain: false,
    });
  });

  it("rule 5: blocks silently on an ignore_title_keywords substring, case-insensitively", () => {
    const policy = policyFrom({ triggers: { ignore_title_keywords: ["WIP"] } });
    const blocked = checkRepoGate({
      policy,
      senderLogin: "octocat",
      trigger: { title: "feat: still wip, do not review" },
    });
    expect(blocked).toMatchObject({ allowed: false, explain: false });

    // No title on this surface, so the rule cannot fire.
    expect(checkRepoGate({ policy, senderLogin: "octocat" }).allowed).toBe(true);
  });

  it("rule 6: blocks silently on a draft PR when ignore_draft_prs is set", () => {
    const policy = policyFrom({ triggers: { ignore_draft_prs: true } });
    expect(
      checkRepoGate({ policy, senderLogin: "octocat", trigger: { draft: true } }),
    ).toMatchObject({ allowed: false, explain: false });
    expect(
      checkRepoGate({ policy, senderLogin: "octocat", trigger: { draft: false } }).allowed,
    ).toBe(true);
    // Surfaces that carry no draft flag (issues, issue comments) skip it.
    expect(checkRepoGate({ policy, senderLogin: "octocat" }).allowed).toBe(true);
  });

  it("rule 7: blocks silently when the PR base is outside base_branches", () => {
    const policy = policyFrom({ triggers: { base_branches: ["main", "beta"] } });
    expect(
      checkRepoGate({ policy, senderLogin: "octocat", trigger: { baseBranch: "gh-pages" } }),
    ).toMatchObject({ allowed: false, explain: false });
    expect(
      checkRepoGate({ policy, senderLogin: "octocat", trigger: { baseBranch: "beta" } }).allowed,
    ).toBe(true);
    expect(checkRepoGate({ policy, senderLogin: "octocat" }).allowed).toBe(true);
  });

  it("returns the first rule that blocks, in documented order", () => {
    // Repo-wide off beats every narrower rule, so the user is told the most
    // useful thing rather than "you are not in allowed_users".
    const policy = policyFrom({
      enabled: false,
      workflows: { review: { enabled: false } },
      triggers: { allowed_users: ["someone-else"] },
    });
    const blocked = checkRepoGate({ policy, workflowName: "review", senderLogin: "octocat" });
    expect(reasonOf(blocked)).toBe("the bot is disabled for this repository");
  });

  it("narrows only: no YAML value can readmit a caller the env allowlist rejected", () => {
    // ALLOWED_OWNERS runs in the webhook handler; a rejected repo never
    // reaches checkRepoGate. This asserts the weaker property the gate itself
    // can enforce: `allowed` is never produced by a rule, only by falling
    // through every rule, so listing a user cannot flip any other block.
    const policy = policyFrom({
      enabled: false,
      triggers: { allowed_users: ["octocat"], ignore_authors: [] },
    });
    expect(checkRepoGate({ policy, senderLogin: "octocat" }).allowed).toBe(false);

    const filtered = policyFrom({
      triggers: { allowed_users: ["octocat"], ignore_authors: ["octocat"] },
    });
    expect(checkRepoGate({ policy: filtered, senderLogin: "octocat" }).allowed).toBe(false);
  });

  it("only the explain:true reasons are static, so nothing attacker-controlled is posted", () => {
    // Rules 5 and 7 interpolate user data into `reason`, so they must stay
    // explain:false; the dispatcher posts a comment only when explain is true.
    const policy = policyFrom({
      triggers: { ignore_title_keywords: ["WIP"], base_branches: ["main"] },
    });
    for (const trigger of [{ title: "WIP <img src=x>" }, { baseBranch: "evil-branch" }]) {
      const verdict = checkRepoGate({ policy, senderLogin: "octocat", trigger });
      expect(verdict).toMatchObject({ allowed: false, explain: false });
    }
  });

  describe("identityRulesOnly", () => {
    it("skips the two toggles and the three passive filters", () => {
      const policy = policyFrom({
        enabled: false,
        workflows: { ship: { enabled: false } },
        triggers: {
          ignore_draft_prs: true,
          ignore_title_keywords: ["WIP"],
          base_branches: ["main"],
        },
      });

      const verdict = checkRepoGate({
        policy,
        workflowName: "ship",
        senderLogin: "octocat",
        identityRulesOnly: true,
        trigger: { title: "WIP: fix", draft: true, baseBranch: "beta" },
      });

      // Every rule that would fire here is about config state, not identity.
      // Refusing a `stop` on any of them strands the run it was meant to end.
      expect(verdict.allowed).toBe(true);
    });

    it("still enforces ignore_authors and allowed_users", () => {
      const ignored = policyFrom({ enabled: false, triggers: { ignore_authors: ["renovate"] } });
      expect(
        checkRepoGate({ policy: ignored, senderLogin: "renovate", identityRulesOnly: true }),
      ).toMatchObject({ allowed: false, explain: false });

      const restricted = policyFrom({ triggers: { allowed_users: ["alice"] } });
      expect(
        checkRepoGate({ policy: restricted, senderLogin: "mallory", identityRulesOnly: true }),
      ).toMatchObject({ allowed: false, explain: true });
    });
  });
});
