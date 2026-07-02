#!/usr/bin/env bun
/**
 * Single source of truth for the app's env-var surface. Extracts every env var
 * the runtime reads from the loadConfig() literal in src/config.ts, classifies
 * each via SECRET_ENV_VARS, and emits env-contract.json. The Helm chart in
 * chrisleekr/helm-charts consumes the published env-contract.json (at
 * v<appVersion>) to gate its own ConfigMap/Secret parity, so this file is the
 * contract both repos agree on.
 *
 * Without a flag: (re)writes env-contract.json.
 * --check (CI): fails if
 *   (a) env-contract.json is stale vs src/config.ts,
 *   (b) any var is undocumented in docs/operate/configuration.md,
 *   (c) a secret-shaped name (credential-word segment, or URL/DSN suffix not
 *       allowlisted) is missing from SECRET_ENV_VARS,
 *   (d) a SECRET_ENV_VARS entry no longer exists in the schema.
 * (c)+(d) keep the classification aligned with config.ts forever.
 *
 * Exit 0 on clean, 1 on any drift.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SECRET_ENV_VARS } from "../src/config-secret-env";

// `ENV_CONTRACT_REPO_ROOT` override exists solely so the test suite can point the
// gate at a fixture tree. Production invocations leave it unset and resolve from
// the script's own location.
const repoRoot =
  process.env["ENV_CONTRACT_REPO_ROOT"] ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_TS = join(repoRoot, "src/config.ts");
const CONTRACT_JSON = join(repoRoot, "env-contract.json");
const CONFIG_DOC = join(repoRoot, "docs/operate/configuration.md");

// "This name is a credential" test, matched as a `_`-delimited segment ANYWHERE
// in the name (not just the suffix), so mid-name credential words are caught too
// (e.g. AWS_BEARER_TOKEN_BEDROCK, DAEMON_AUTH_TOKEN_PREVIOUS). No config-only var
// contains any of these words as a segment.
const SECRET_NAME_RE = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|BEARER)(?:_|$)/;
// URL / DSN / connection-string names usually carry embedded credentials, so they
// must be classified secret unless explicitly listed as a plain, non-secret
// endpoint. This inverts the default to fail-safe for connection-string shapes.
const SECRET_URL_RE = /(?:_URL|_DSN|_CONN|_CONNECTION)$/;
const NON_SECRET_URL_ALLOWLIST: ReadonlySet<string> = new Set([
  "ORCHESTRATOR_URL",
  "ORCHESTRATOR_PUBLIC_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
]);

interface Entry {
  env: string;
  group: string;
  kind: "secret" | "config";
}

function extract(): Entry[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- constant repo-relative path
  const src = readFileSync(CONFIG_TS, "utf-8");
  // Scope to the loadConfig() literal so process.env reads elsewhere in the
  // file (e.g. the daemon-secret-leak warning) are ignored.
  const start = src.indexOf("configSchema.parse({");
  const end = src.indexOf("assertOauthRequiresAllowlist(cfg);");
  if (start < 0 || end < 0) {
    throw new Error("could not locate loadConfig() literal in src/config.ts");
  }
  const body = src.slice(start, end);

  const entries: Entry[] = [];
  const seen = new Set<string>();
  let group = "ungrouped";
  const groupRe = /\/\/\s*(Group\s+[0-9]+[a-z]?)/;
  // Handles both process.env["NAME"] and the bare process.env.NAME form (NODE_ENV).
  const envRe = /process\.env(?:\[\s*"([A-Z0-9_]+)"\s*\]|\.([A-Z0-9_]+))/g;
  for (const line of body.split("\n")) {
    const g = groupRe.exec(line);
    if (g?.[1]) group = g[1];
    let m: RegExpExecArray | null;
    envRe.lastIndex = 0;
    while ((m = envRe.exec(line)) !== null) {
      const env = (m[1] ?? m[2]) as string;
      if (seen.has(env)) continue;
      seen.add(env);
      entries.push({ env, group, kind: SECRET_ENV_VARS.has(env) ? "secret" : "config" });
    }
  }
  return entries;
}

function main(): void {
  const check = process.argv.includes("--check");
  const entries = extract();
  const names = new Set(entries.map((e) => e.env));
  const rendered = JSON.stringify(entries, null, 2) + "\n";

  if (!check) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- constant repo-relative path
    writeFileSync(CONTRACT_JSON, rendered);
    console.log(`OK: wrote ${String(entries.length)} entries to env-contract.json`);
    return;
  }

  const errs: string[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- constant repo-relative path
  if (readFileSync(CONTRACT_JSON, "utf-8") !== rendered) {
    errs.push("env-contract.json is stale. Run `bun run env-contract` and commit the result.");
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- constant repo-relative path
  const doc = readFileSync(CONFIG_DOC, "utf-8");
  for (const e of entries) {
    // Match the backtick-wrapped form the config tables always use, so a var name
    // that is a substring of another (PORT/WS_PORT) or of prose does not falsely
    // satisfy the check.
    if (!doc.includes(`\`${e.env}\``)) {
      errs.push(`docs/operate/configuration.md does not document ${e.env}`);
    }
  }
  // Anti-drift: a credential-shaped name that isn't classified as a secret would
  // otherwise render into the plaintext ConfigMap. Connection-string shapes
  // (URL/DSN) must be classified secret unless explicitly allowlisted.
  for (const e of entries) {
    const looksSecret =
      SECRET_NAME_RE.test(e.env) ||
      (SECRET_URL_RE.test(e.env) && !NON_SECRET_URL_ALLOWLIST.has(e.env));
    if (looksSecret && e.kind !== "secret") {
      errs.push(
        `${e.env} looks like a secret; add it to SECRET_ENV_VARS in src/config-secret-env.ts ` +
          `(or, if it is a non-secret endpoint URL, add it to NON_SECRET_URL_ALLOWLIST in scripts/env-contract.ts)`,
      );
    }
  }
  // Anti-drift: a SECRET_ENV_VARS entry that no longer exists in the schema.
  for (const s of SECRET_ENV_VARS) {
    if (!names.has(s))
      errs.push(`SECRET_ENV_VARS has stale entry ${s}; remove it from src/config-secret-env.ts`);
  }

  if (errs.length > 0) {
    console.error(`ERROR: env contract out of sync:\n${errs.map((e) => `  - ${e}`).join("\n")}`);
    process.exit(1);
  }
  console.log(
    `OK: env-contract.json current, all ${String(entries.length)} vars documented, classification aligned`,
  );
}

main();
