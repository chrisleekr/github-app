#!/usr/bin/env bun
// Forwards smee.io webhook deliveries to the local dev server.
// SMEE_URL is read from .env, auto-loaded by the bun runtime (bun run <script>
// only loads .env for bun-runtime entry points, not for shell-substitution npm
// scripts, so a TS launcher is the cleanest path).

const url = process.env["SMEE_URL"];
if (!url) {
  console.error(
    "Set SMEE_URL=https://smee.io/<your-channel> in .env (create a channel at https://smee.io)",
  );
  process.exit(1);
}

// Default target follows PORT (same var the dev server binds) so the relay
// tracks the server across the manual flow (.env PORT) and dev-up.sh (PORT=3030).
// SMEE_TARGET overrides the whole URL when set.
const port = process.env["PORT"] ?? "3000";
const target = process.env["SMEE_TARGET"] ?? `http://localhost:${port}/api/github/webhooks`;

console.log(`[dev:smee] forwarding ${url} -> ${target}`);

const proc = Bun.spawn(["bunx", "smee-client", "--url", url, "--target", target], {
  stdio: ["inherit", "inherit", "inherit"],
});

const forwardSignal = (sig: NodeJS.Signals): void => {
  proc.kill(sig);
};
process.on("SIGINT", forwardSignal);
process.on("SIGTERM", forwardSignal);

const exitCode = await proc.exited;
process.exit(exitCode);
