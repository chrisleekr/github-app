import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { SECRET_ENV_VARS } from "../../src/config-secret-env";

const SCRIPT = resolve(import.meta.dir, "..", "..", "scripts", "env-contract.ts");

// Config-kind sample vars. None are credential-shaped, so a clean fixture emits
// zero anti-drift findings.
const CONFIG_VARS = ["CLAUDE_PROVIDER", "TRIGGER_PHRASE", "PORT"];

// Build a src/config.ts whose loadConfig() literal reads each given env var. The
// extractor keys off the exact "configSchema.parse({" / "assertOauthRequiresAllowlist(cfg);"
// delimiters, so the fixture reproduces them.
function makeConfigTs(vars: string[]): string {
  const lines = vars.map((v, i) => `    field${String(i)}: process.env["${v}"],`).join("\n");
  return [
    "function loadConfig() {",
    "  const cfg = configSchema.parse({",
    "    // Group 1",
    lines,
    "  });",
    "  assertOauthRequiresAllowlist(cfg);",
    "  return cfg;",
    "}",
    "",
  ].join("\n");
}

// Document each var in the backtick-wrapped form the gate matches.
function makeDoc(vars: string[]): string {
  return `# Configuration\n\n${vars.map((v) => `| \`${v}\` | notes |`).join("\n")}\n`;
}

interface Layout {
  vars: string[];
  doc?: string; // override the generated doc
}

function makeFixture(layout: Layout): string {
  const root = mkdtempSync(join(tmpdir(), "env-contract-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "docs", "operate"), { recursive: true });
  writeFileSync(join(root, "src", "config.ts"), makeConfigTs(layout.vars));
  writeFileSync(
    join(root, "docs", "operate", "configuration.md"),
    layout.doc ?? makeDoc(layout.vars),
  );
  return root;
}

function run(
  root: string,
  args: string[] = [],
): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", "run", SCRIPT, ...args], {
    env: { ...process.env, ENV_CONTRACT_REPO_ROOT: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

// A fixture whose config reads every classified secret plus the config sample is
// the baseline "clean" state: emit then --check must pass.
const CLEAN_VARS = [...SECRET_ENV_VARS, ...CONFIG_VARS];

const fixtures: string[] = [];
afterEach(() => {
  while (fixtures.length > 0) {
    const f = fixtures.pop();
    if (f !== undefined) rmSync(f, { recursive: true, force: true });
  }
});

describe("scripts/env-contract.ts", () => {
  it("emits a contract and --check passes on a clean fixture", () => {
    const root = makeFixture({ vars: CLEAN_VARS });
    fixtures.push(root);
    expect(run(root).exitCode).toBe(0); // emit
    const { exitCode, stdout } = run(root, ["--check"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("classification aligned");
  });

  it("classifies secrets and config correctly in the emitted JSON", () => {
    const root = makeFixture({ vars: CLEAN_VARS });
    fixtures.push(root);
    run(root); // emit
    const contract = JSON.parse(readFileSync(join(root, "env-contract.json"), "utf-8")) as {
      env: string;
      kind: string;
    }[];
    const byName = new Map(contract.map((e) => [e.env, e.kind]));
    expect(byName.get("GITHUB_APP_PRIVATE_KEY")).toBe("secret");
    expect(byName.get("CLAUDE_PROVIDER")).toBe("config");
  });

  it("fails when env-contract.json is stale", () => {
    const root = makeFixture({ vars: CLEAN_VARS });
    fixtures.push(root);
    run(root); // emit
    writeFileSync(join(root, "env-contract.json"), "[]\n");
    const { exitCode, stderr } = run(root, ["--check"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("stale");
  });

  it("fails when a var is undocumented", () => {
    const root = makeFixture({ vars: CLEAN_VARS, doc: makeDoc(CONFIG_VARS) }); // secrets omitted from doc
    fixtures.push(root);
    run(root); // emit
    const { exitCode, stderr } = run(root, ["--check"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("does not document");
  });

  it("fires the anti-drift check for a credential-shaped name not classified secret", () => {
    // FOO_TOKEN is credential-shaped but not in SECRET_ENV_VARS, so it is emitted
    // as config and the anti-drift branch must reject it.
    const root = makeFixture({ vars: [...CLEAN_VARS, "FOO_TOKEN"] });
    fixtures.push(root);
    run(root); // emit
    const { exitCode, stderr } = run(root, ["--check"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("FOO_TOKEN looks like a secret");
  });

  it("fires the anti-drift check for a mid-name credential word (regression: suffix-only regex)", () => {
    const root = makeFixture({ vars: [...CLEAN_VARS, "FOO_TOKEN_V2"] });
    fixtures.push(root);
    run(root); // emit
    const { exitCode, stderr } = run(root, ["--check"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("FOO_TOKEN_V2 looks like a secret");
  });

  it("fires the anti-drift check for a URL-shaped name not classified secret", () => {
    const root = makeFixture({ vars: [...CLEAN_VARS, "FOO_URL"] });
    fixtures.push(root);
    run(root); // emit
    const { exitCode, stderr } = run(root, ["--check"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("FOO_URL looks like a secret");
  });

  it("fails when SECRET_ENV_VARS has an entry absent from the schema", () => {
    // Drop one classified secret from the config so the stale-entry branch fires.
    const dropped = [...SECRET_ENV_VARS][0]!;
    const vars = CLEAN_VARS.filter((v) => v !== dropped);
    const root = makeFixture({ vars });
    fixtures.push(root);
    run(root); // emit
    const { exitCode, stderr } = run(root, ["--check"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`stale entry ${dropped}`);
  });
});
