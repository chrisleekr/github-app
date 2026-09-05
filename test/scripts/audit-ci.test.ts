import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

const SCRIPT = resolve(import.meta.dir, "..", "..", "scripts", "audit-ci.ts");

const fixtures: string[] = [];
afterEach(() => {
  while (fixtures.length > 0) {
    const f = fixtures.pop();
    if (f !== undefined) rmSync(f, { recursive: true, force: true });
  }
});

function runAuditFixture(
  json: string,
  exitCode: number,
  stderr = "",
): {
  exitCode: number;
  combined: string;
} {
  const root = mkdtempSync(join(tmpdir(), "audit-ci-"));
  fixtures.push(root);
  const fakeBunPath = join(root, "bun");
  // Fixture paths are created within the temporary test directory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture path
  writeFileSync(
    fakeBunPath,
    `#!/bin/sh
if [ "$1" = "audit" ] && [ "$2" = "--json" ]; then
  cat <<'JSON'
${json}
JSON
${stderr ? `  printf '%s' "$FAKE_BUN_STDERR" >&2\n` : ""}  exit ${String(exitCode)}
fi
echo "unexpected fake bun invocation" >&2
exit 99
`,
  );
  // The test replaces Bun only for the child audit command.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture path
  chmodSync(fakeBunPath, 0o755);
  const proc = Bun.spawnSync([process.execPath, "run", SCRIPT], {
    env: {
      ...process.env,
      PATH: `${root}:${process.env["PATH"] ?? ""}`,
      ...(stderr ? { FAKE_BUN_STDERR: stderr } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    combined: proc.stdout.toString() + proc.stderr.toString(),
  };
}

describe("scripts/audit-ci.ts", () => {
  it("parses the real per-package Bun audit shape and blocks on a high severity advisory", () => {
    const { exitCode, combined } = runAuditFixture(
      JSON.stringify({
        "@humanfs/node": [
          {
            id: 1158499,
            url: "https://github.com/advisories/GHSA-p498-v437-472g",
            title:
              "humanfs: Recursive copy follows symlinked files and copies data from outside the source tree",
            severity: "moderate",
            vulnerable_versions: "<0.16.8",
            cwe: ["CWE-22"],
            cvss: { score: 0, vectorString: null },
          },
        ],
        sharp: [
          {
            id: 1160001,
            url: "https://github.com/advisories/GHSA-f88m-g3jw-g9cj",
            title: "sharp inherited vulnerabilities in libvips",
            severity: "high",
            vulnerable_versions: "<0.35.0",
            cwe: ["CWE-1395"],
            cvss: {
              score: 7,
              vectorString: "CVSS:4.0/AV:L/AC:L/AT:N/PR:L/UI:N/VC:L/VI:H/VA:H/SC:N/SI:N/SA:N",
            },
          },
        ],
      }),
      1,
    );
    expect(exitCode).toBe(1);
    expect(combined).toContain("::error::HIGH GHSA-f88m-g3jw-g9cj sharp:");
    expect(combined).toContain("::warning::moderate GHSA-p498-v437-472g @humanfs/node:");
    expect(combined).toContain("Summary: blocking=1 warning=1 ignored=0 total=2");
  });

  it("parses the real shape with only moderate and low advisories and does not block", () => {
    const { exitCode, combined } = runAuditFixture(
      JSON.stringify({
        "pkg-a": [
          {
            id: 1,
            url: "https://github.com/advisories/GHSA-aaaa-aaaa-aaaa",
            title: "pkg-a issue one",
            severity: "moderate",
            vulnerable_versions: "<1.0.0",
          },
          {
            id: 2,
            url: "https://github.com/advisories/GHSA-bbbb-bbbb-bbbb",
            title: "pkg-a issue two",
            severity: "low",
            vulnerable_versions: "<1.0.0",
          },
        ],
        "pkg-b": [
          {
            id: 3,
            url: "https://github.com/advisories/GHSA-cccc-cccc-cccc",
            title: "pkg-b issue",
            severity: "moderate",
            vulnerable_versions: "<2.0.0",
          },
        ],
      }),
      1,
    );
    expect(exitCode).toBe(0);
    expect(combined).toContain("Summary: blocking=0 warning=3 ignored=0 total=3");
  });

  it("treats a clean empty-object report as no advisories", () => {
    const { exitCode, combined } = runAuditFixture("{}", 0);
    expect(exitCode).toBe(0);
    expect(combined).toContain("Summary: blocking=0 warning=0 ignored=0 total=0");
  });

  it("rejects the legacy npm-style advisories shape as unrecognised", () => {
    const { exitCode, combined } = runAuditFixture(
      JSON.stringify({
        advisories: {
          1: {
            severity: "high",
            github_advisory_id: "GHSA-xxxx-xxxx-xxxx",
            module_name: "x",
            title: "t",
          },
        },
      }),
      1,
    );
    expect(exitCode).toBe(1);
    expect(combined).toContain("unrecognised bun audit JSON shape");
    expect(combined).not.toContain("Summary:");
  });

  it("rejects a top-level JSON array as unrecognised", () => {
    const { exitCode, combined } = runAuditFixture("[]", 1);
    expect(exitCode).toBe(1);
    expect(combined).toContain("unrecognised bun audit JSON shape");
  });

  it("rejects a string advisory entry as unrecognised", () => {
    const { exitCode, combined } = runAuditFixture(JSON.stringify({ pkg: ["oops"] }), 1);
    expect(exitCode).toBe(1);
    expect(combined).toContain("unrecognised bun audit JSON shape");
  });

  it("rejects a recased advisory severity as unrecognised", () => {
    const { exitCode, combined } = runAuditFixture(
      JSON.stringify({
        pkg: [
          {
            id: 42,
            url: "https://example.test/advisory/42",
            title: "recased severity",
            severity: "High",
          },
        ],
      }),
      1,
    );
    expect(exitCode).toBe(1);
    expect(combined).toContain("unrecognised bun audit JSON shape");
    expect(combined).not.toContain("Summary:");
  });

  it("uses the numeric advisory id when the url has no GHSA slug", () => {
    const { exitCode, combined } = runAuditFixture(
      JSON.stringify({
        pkg: [
          {
            id: 42,
            url: "https://example.test/advisory/42",
            title: "t",
            severity: "critical",
          },
        ],
      }),
      1,
    );
    expect(exitCode).toBe(1);
    expect(combined).toContain("::error::CRITICAL id=42 pkg: t");
  });

  it("escapes newlines in advisory titles before annotation output", () => {
    const { exitCode, combined } = runAuditFixture(
      JSON.stringify({
        pkg: [
          {
            id: 42,
            url: "https://example.test/advisory/42",
            title: "foo\n::add-mask::x",
            severity: "high",
          },
        ],
      }),
      1,
    );
    expect(exitCode).toBe(1);
    expect(combined).not.toMatch(/^\s*::add-mask::/m);
    expect(combined).toContain("%0A::add-mask::x");
  });

  it("escapes newlines in package names before annotation output", () => {
    const { exitCode, combined } = runAuditFixture(
      JSON.stringify({
        "pkg\n::add-mask::x": [
          {
            id: 42,
            title: "package name issue",
            severity: "high",
          },
        ],
      }),
      1,
    );
    expect(exitCode).toBe(1);
    expect(combined).toContain("%0A::add-mask::x");
    expect(combined).not.toMatch(/^\s*::add-mask::/m);
  });

  it("rejects an advisory with a non-string title as unrecognised", () => {
    const { exitCode, combined } = runAuditFixture(
      JSON.stringify({
        pkg: [
          {
            severity: "high",
            title: 42,
          },
        ],
      }),
      1,
    );
    expect(exitCode).toBe(1);
    expect(combined).toContain("unrecognised bun audit JSON shape");
    expect(combined).not.toContain("Summary:");
  });

  it("escapes newlines in raw stdout from a JSON parse failure", () => {
    const { exitCode, combined } = runAuditFixture("<html>\n::add-mask::x\n</html>", 1);
    expect(exitCode).toBe(1);
    expect(combined).toContain("> ::add-mask::x");
    expect(combined).not.toMatch(/^\s*::add-mask::/m);
  });

  it("escapes advisory ids, titles, and urls before annotation output", () => {
    const { exitCode, combined } = runAuditFixture(
      JSON.stringify({
        pkg: [
          {
            id: "7\n::add-mask::z",
            url: "https://example.test/a\r\n::add-mask::y",
            title: "50% off",
            severity: "high",
          },
        ],
      }),
      1,
    );
    expect(exitCode).toBe(1);
    expect(combined).toContain(
      "::error::HIGH id=7%0A::add-mask::z pkg: 50%25 off https://example.test/a%0D%0A::add-mask::y",
    );
    expect(combined).not.toMatch(/^\s*::add-mask::/m);
  });

  it("keeps an advisory url on the annotation line", () => {
    const { exitCode, combined } = runAuditFixture(
      JSON.stringify({
        pkg: [
          {
            id: 1,
            url: "::add-mask::y",
            title: "t",
            severity: "high",
          },
        ],
      }),
      1,
    );
    expect(exitCode).toBe(1);
    expect(combined).toContain("::error::HIGH id=1 pkg: t ::add-mask::y");
    expect(combined).not.toMatch(/^\s*::add-mask::/m);
  });

  it("prefixes each line of a parse-failure stdout dump", () => {
    const { exitCode, combined } = runAuditFixture("::add-mask::x\nrest", 1);
    expect(exitCode).toBe(1);
    expect(combined).toContain("> ::add-mask::x");
    expect(combined).toContain("> rest");
    expect(combined).not.toMatch(/^\s*::add-mask::/m);
  });

  it("caps the parse-failure stdout dump at 2000 characters", () => {
    const { exitCode, combined } = runAuditFixture(`${"a".repeat(2100)}\n::add-mask::z`, 1);
    expect(exitCode).toBe(1);
    expect(combined).not.toContain("add-mask");
  });

  it("prefixes each line of a no-output stderr echo", () => {
    const { exitCode, combined } = runAuditFixture("", 0, "warn\n::add-mask::q");
    expect(exitCode).toBe(0);
    expect(combined).toContain("> warn");
    expect(combined).toContain("> ::add-mask::q");
    expect(combined).not.toMatch(/^\s*::add-mask::/m);
  });
});
