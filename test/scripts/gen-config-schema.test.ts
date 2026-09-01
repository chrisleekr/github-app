/**
 * `scripts/gen-config-schema.ts` (issue #3, deliverable 2).
 *
 * Generates `schema/github-app.schema.json` from `githubAppConfigSchema` so
 * editors can offer completion/validation on `.github-app.yaml`, and gates the
 * committed artifact against drift with `--check`.
 *
 * Same harness shape as `env-contract.test.ts`: the script is spawned against a
 * throwaway repo root (`CONFIG_SCHEMA_REPO_ROOT`) so a test run never rewrites
 * the committed artifact.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "gen-config-schema.ts");
const ARTIFACT = join("schema", "github-app.schema.json");

function run(
  root: string,
  args: string[] = [],
): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", "run", SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, CONFIG_SCHEMA_REPO_ROOT: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

const fixtures: string[] = [];
function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "gen-config-schema-"));
  fixtures.push(root);
  return root;
}

afterEach(() => {
  while (fixtures.length > 0) {
    const f = fixtures.pop();
    if (f !== undefined) rmSync(f, { recursive: true, force: true });
  }
});

describe("scripts/gen-config-schema.ts", () => {
  it("C8: writes a draft 2020-12 schema whose bytes are stable across runs", () => {
    const root = makeFixture();
    expect(run(root).exitCode).toBe(0);

    const raw = readFileSync(join(root, ARTIFACT), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
    // `version` is the one required root key, so a schema that lost the root
    // object shape (e.g. an unrepresentable node degrading to `{}`) is caught.
    expect(parsed["required"]).toEqual(["version"]);

    // Content, not just shape: a deep key proves the schema was actually
    // walked rather than emitted as a stub root object.
    const props = parsed["properties"] as Record<string, Record<string, unknown>>;
    const triggers = props["triggers"]?.["properties"] as Record<string, unknown> | undefined;
    expect(triggers).toHaveProperty("ignore_draft_prs");

    // The artifact is in `.prettierignore`, so prettier never formats it: this
    // generator is its ONLY formatter. That is exactly what makes the
    // byte-exact `--check` comparison meaningful, so the emitted bytes must be
    // reproducible from the parsed value alone.
    expect(raw).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
  });

  it("C9: --check exits 0 on a freshly generated artifact", () => {
    const root = makeFixture();
    run(root);
    const { exitCode } = run(root, ["--check"]);
    expect(exitCode).toBe(0);
  });

  it("C9: --check exits non-zero on a one-byte drift and names the regenerate command", () => {
    const root = makeFixture();
    run(root);
    const file = join(root, ARTIFACT);
    const raw = readFileSync(file, "utf-8");
    writeFileSync(file, raw.slice(0, -1)); // drop the trailing newline: one byte

    const { exitCode, stderr } = run(root, ["--check"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("bun run gen-config-schema");
  });

  it("C10: the guard is wired into CI and into the package.json check aggregate", () => {
    const ci = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf-8");
    expect(ci).toContain("bun run check:config-schema");

    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["gen-config-schema"]).toBeDefined();
    expect(pkg.scripts["check:config-schema"]).toBeDefined();
    expect(pkg.scripts["check"]).toContain("check:config-schema");
  });
});
