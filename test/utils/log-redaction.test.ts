import { describe, expect, it } from "bun:test";

import { redactErrorMessage } from "../../src/utils/log-redaction";

describe("redactErrorMessage", () => {
  it("strips a ghs_ token and credentialed URL from an Octokit RequestError", () => {
    // The authoritative red->green case: an Octokit error message echoes both a
    // bare installation token and the credentialed clone/API URL that carries it.
    const token = `ghs_${"a".repeat(36)}`;
    const err = new Error(
      `HttpError: request failed for https://x-access-token:${token}@api.github.com/repos/o/r/issues/1`,
    );
    const out = redactErrorMessage(err);
    expect(out).not.toContain("ghs_");
    expect(out).not.toContain(token);
  });

  it("strips the new ghs_APPID_JWT stateless installation token (~520 chars, dots + underscores)", () => {
    // GitHub's 2026-04-27 rollout changes ghs_ tokens to ghs_APPID_JWT, far
    // longer than 36 chars and containing underscores + JWT dots. The legacy
    // /ghs_[A-Za-z0-9]{36}/ shape cannot match it. Cover the bare form, the
    // Authorization: Bearer header form, and the credentialed-URL form.
    const newToken = `ghs_1234567_eyJ${"a".repeat(200)}.${"b".repeat(160)}.${"c".repeat(140)}`;
    expect(newToken.length).toBeGreaterThan(500);

    const bare = redactErrorMessage(new Error(`Bad credentials: ${newToken}`));
    expect(bare).not.toContain(newToken);
    expect(bare).not.toContain("ghs_");

    const bearer = redactErrorMessage(
      new Error(`request failed Authorization: Bearer ${newToken}`),
    );
    expect(bearer).not.toContain(newToken);
    expect(bearer).not.toContain("ghs_");

    const url = redactErrorMessage(
      new Error(`clone failed https://x-access-token:${newToken}@github.com/o/r.git`),
    );
    expect(url).not.toContain(newToken);
    expect(url).not.toContain("ghs_");
  });

  it("strips a github_pat_ fine-grained token (shape the old inline regex missed)", () => {
    const token = `github_pat_${"a".repeat(40)}`;
    const out = redactErrorMessage(new Error(`auth failed with ${token}`));
    expect(out).not.toContain(token);
    expect(out).not.toContain("github_pat_");
  });

  it("strips an Anthropic sk-ant-api03- key", () => {
    const key = `sk-ant-api03-${"x".repeat(80)}`;
    const out = redactErrorMessage(new Error(`bad key: ${key}`));
    expect(out).not.toContain(key);
    expect(out).not.toContain("sk-ant-api03-");
  });

  it("masks a DB URL password so the secret is absent", () => {
    const out = redactErrorMessage(
      new Error("connect failed: postgres://user:secret@db.local:5432/app"),
    );
    expect(out).not.toContain("secret");
  });

  it("passes a benign message through unchanged", () => {
    const benign = "ENOENT: no such file or directory, open '/tmp/missing'";
    expect(redactErrorMessage(new Error(benign))).toBe(benign);
  });

  it("passes a benign non-Error input through unchanged", () => {
    // Locks the String(err) branch against over-redaction of clean input.
    expect(redactErrorMessage("plain string, no secrets here")).toBe(
      "plain string, no secrets here",
    );
  });

  it("handles a non-Error input (plain string) without throwing and redacts a token", () => {
    const token = `ghs_${"b".repeat(36)}`;
    const out = redactErrorMessage(`raw string with ${token} inside`);
    expect(out).not.toContain(token);
    expect(out).not.toContain("ghs_");
  });
});
