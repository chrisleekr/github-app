import { describe, expect, it } from "bun:test";

import {
  configuredCredentialValues,
  containsExactCredentialPropertyName,
  containsExactCredentialValue,
  redactExactValues,
} from "../../src/runner/output-sanitizer";

describe("workflow runner exact credential redaction", () => {
  it("selects credential values without treating provider settings as secrets", () => {
    expect(
      configuredCredentialValues({
        AWS_REGION: "ap-southeast-2",
        AWS_SECRET_ACCESS_KEY: "opaque-aws-secret-value",
        CLAUDE_CODE_OAUTH_TOKEN: "opaque-oauth-token",
        CLAUDE_MODEL: "claude-test",
      }),
    ).toEqual(["opaque-aws-secret-value", "opaque-oauth-token"]);
  });

  it("removes exact raw credentials from nested command and result values", () => {
    const secret = "opaque-credential-value";
    expect(
      redactExactValues(
        {
          humanMessage: `before ${secret} after`,
          state: { report: secret, rows: [secret, 42] },
        },
        [secret],
      ),
    ).toEqual({
      humanMessage: "before  after",
      state: { report: "", rows: ["", 42] },
    });
  });

  it("detects configured credentials used as nested property names", () => {
    const values = [
      `ghs_${"a".repeat(36)}`,
      "anthropic-opaque-token",
      "aws-opaque-secret",
      "wfr1.opaque-capability",
    ];
    for (const secret of values) {
      expect(
        containsExactCredentialPropertyName({ safe: { [`prefix-${secret}-suffix`]: "x" } }, [
          secret,
        ]),
      ).toBe(true);
    }
    expect(containsExactCredentialPropertyName({ safe: { nested: "value" } }, values)).toBe(false);
  });

  it("detects common reversible encodings in nested values", () => {
    const secret = "opaque-credential-value";
    const encoded = [
      Buffer.from(secret, "utf8").toString("base64"),
      Buffer.from(secret, "utf8").toString("base64url"),
      Buffer.from(secret, "utf8").toString("hex").toUpperCase(),
      encodeURIComponent(secret),
    ];
    for (const value of encoded) {
      expect(containsExactCredentialValue({ nested: `before ${value} after` }, [secret])).toBe(
        true,
      );
    }
  });
});
