/**
 * Tests for isOwnerAllowed() in src/webhook/authorize.ts.
 *
 * These tests mutate `config.allowedOwners` directly (saved/restored per case)
 * because the config singleton is initialized once at module load via preload.ts.
 * Using `mock.module("../../src/config", ...)` would persist across all test files
 * in the same Bun process run, poisoning other suites.
 */

import { afterEach, describe, expect, it } from "bun:test";

import { config } from "../../src/config";
import { isOwnerAllowed } from "../../src/webhook/authorize";
import { makeSilentLogger } from "../factories";

describe("isOwnerAllowed", () => {
  // Preserve the original value so earlier tests don't leak into later suites
  // that also read `config.allowedOwners`.
  const originalAllowedOwners = config.allowedOwners;

  afterEach(() => {
    config.allowedOwners = originalAllowedOwners;
  });

  it("allows any owner when allowedOwners is undefined", () => {
    config.allowedOwners = undefined;
    const log = makeSilentLogger();
    const result = isOwnerAllowed("chrisleekr", log);
    expect(result.allowed).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(0);
  });

  it("allows a matching owner (exact case)", () => {
    config.allowedOwners = ["chrisleekr"];
    const log = makeSilentLogger();
    const result = isOwnerAllowed("chrisleekr", log);
    expect(result.allowed).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(0);
  });

  it("allows a matching owner (case-insensitive)", () => {
    // GitHub owner logins are case-insensitive for identity purposes:
    // ChrisLeeKR and chrisleekr are the same account.
    config.allowedOwners = ["chrisleekr"];
    const log = makeSilentLogger();
    const result = isOwnerAllowed("ChrisLeeKR", log);
    expect(result.allowed).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(0);
  });

  it("rejects a non-matching owner and logs a warning", () => {
    config.allowedOwners = ["chrisleekr"];
    const log = makeSilentLogger();
    const result = isOwnerAllowed("someone-else", log);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("someone-else");
      expect(result.reason).toContain("not in the configured allowlist");
    }
    expect(log.warn).toHaveBeenCalledTimes(1);
    const warnCall = log.warn.mock.calls[0];
    expect(warnCall?.[0]).toEqual({
      owner: "someone-else",
      allowedOwners: ["chrisleekr"],
    });
    expect(warnCall?.[1]).toBe("rejected: owner not in ALLOWED_OWNERS allowlist");
  });

  it("allows any owner in a multi-entry allowlist", () => {
    config.allowedOwners = ["user-a", "user-b"];
    const log = makeSilentLogger();
    const result = isOwnerAllowed("user-b", log);
    expect(result.allowed).toBe(true);
  });

  it("rejects when the owner is not in a multi-entry allowlist", () => {
    config.allowedOwners = ["user-a", "user-b"];
    const log = makeSilentLogger();
    const result = isOwnerAllowed("user-c", log);
    expect(result.allowed).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
