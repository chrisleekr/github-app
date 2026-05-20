/**
 * Test environment preload script.
 * Runs before each test file to set consistent environment variables.
 * Configured in bunfig.toml [test].preload
 */

// Force test environment
process.env.NODE_ENV = "test";

// Consistent timezone for date-dependent tests
process.env.TZ = "UTC";

// Always use the Anthropic provider in tests so the config singleton resolves
// without needing AWS credentials. This overrides any CLAUDE_PROVIDER value
// that Bun auto-loads from a local .env file (e.g. "bedrock" for local dev).
process.env["CLAUDE_PROVIDER"] = "anthropic";

// Clear owner-allowlist and OAuth vars so a developer's local .env can't leak
// into the config singleton and skew tests. Individual tests that need to
// exercise allowlist or OAuth behavior must set these explicitly (typically
// via mutation of the config singleton with save/restore in try/finally),
// never by relying on ambient process.env.
delete process.env["ALLOWED_OWNERS"];
delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
delete process.env["GITHUB_PERSONAL_ACCESS_TOKEN"];

// DAEMON_AUTH_TOKEN is required post-dispatch-collapse (validated in
// validateDataLayerConfig). Individual tests that need to exercise missing
// auth flip this back to undefined within a save/restore block.
process.env["DAEMON_AUTH_TOKEN"] = "test-daemon-token";

// A developer's .env may set TRIGGER_PHRASE to a local-dev variant
// (e.g. @chrisleekr-bot-dev) which would leak into tests that hardcode
// the production phrase. Pin to the default so test assertions stay
// deterministic across machines.
process.env["TRIGGER_PHRASE"] = "@chrisleekr-bot";

// Helper: set env var to a fallback when absent or empty.
// ?? (nullish coalescing) only replaces null/undefined, not "". A local .env
// file may contain KEY= (empty string), which Bun loads as "" into process.env.
// We use explicit comparison so empty strings from .env are also replaced.
const setIfEmpty = (key: string, fallback: string): void => {
  // eslint-disable-next-line security/detect-object-injection
  const current = process.env[key];
  if (current === undefined || current === "") {
    // eslint-disable-next-line security/detect-object-injection
    process.env[key] = fallback;
  }
};

// Provide dummy values for required config env vars so modules that
// import `config` can load without crashing in unit tests.
setIfEmpty("GITHUB_APP_ID", "test-app-id");
setIfEmpty("GITHUB_APP_PRIVATE_KEY", "test-private-key");
setIfEmpty("GITHUB_WEBHOOK_SECRET", "test-webhook-secret");
// ANTHROPIC_API_KEY: Required because CLAUDE_PROVIDER is forced to "anthropic" above,
// and superRefine enforces the key for that provider.
setIfEmpty("ANTHROPIC_API_KEY", "test-anthropic-key");
// Post-dispatch-collapse, validateDataLayerConfig requires DATABASE_URL and
// VALKEY_URL in server mode (ORCHESTRATOR_URL unset). Without these, config
// load aborts before any test can run in CI, where no .env is present.
setIfEmpty("DATABASE_URL", "postgres://test:test@localhost:55432/test");
setIfEmpty("VALKEY_URL", "redis://localhost:56379");
