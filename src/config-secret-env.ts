/**
 * Env vars that must render into the Helm chart's Secret, not its ConfigMap.
 * Single source of truth for secret-vs-config classification, consumed by
 * scripts/env-contract.ts to emit env-contract.json (which chrisleekr/helm-charts
 * gates its ConfigMap/Secret parity against).
 *
 * Kept in its own side-effect-free module rather than config.ts on purpose:
 * importing config.ts eagerly runs loadConfig() (config.ts `export const config
 * = loadConfig()`), which throws when the app env is not fully set, e.g. in the
 * `check:env-contract` CI step. This module has no runtime side effects.
 *
 * The `check:env-contract` gate fails if any env var read by loadConfig() whose
 * name looks secret-shaped (a KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL/BEARER segment
 * anywhere in the name, or a URL/DSN/connection-string suffix that is not in the
 * gate's NON_SECRET_URL_ALLOWLIST) is absent here. So a new credential var cannot
 * drift into the plaintext ConfigMap by omission.
 */
export const SECRET_ENV_VARS: ReadonlySet<string> = new Set([
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CONTEXT7_API_KEY",
  "DATABASE_URL",
  "VALKEY_URL",
  "DAEMON_AUTH_TOKEN",
  "DAEMON_AUTH_TOKEN_PREVIOUS",
]);
