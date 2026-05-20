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

const target = process.env["SMEE_TARGET"] ?? "http://localhost:3030/api/github/webhooks";

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
