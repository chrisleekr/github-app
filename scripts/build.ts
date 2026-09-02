export {};

const isProduction = process.env["NODE_ENV"] === "production";

// Build 1: main app entry point. Outputs dist/app.js.
const result = await Bun.build({
  entrypoints: ["./src/app.ts"],
  outdir: "./dist",
  target: "bun",
  minify: isProduction,
  sourcemap: isProduction ? "external" : "inline",
  splitting: false,
  naming: "app.js",
});

if (!result.success) {
  console.error("Build failed (app):");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

// Build 2: MCP stdio servers. Outputs dist/mcp/servers/<name>.js.
// sanitize.ts (and github-state's fetcher helpers) are inlined into each
// bundle (splitting: false) since each server runs as an independent
// child process with no shared runtime.
//
// Entrypoints are auto-discovered by scanning src/mcp/servers/ for files that
// import StdioServerTransport. registry.ts spawns these as subprocesses, and
// drift between the registry and a hardcoded entrypoint list previously
// shipped MCP servers that did not exist in the production image. context7.ts
// is HTTP-transport and consumed via direct import, so it is correctly omitted
// by the StdioServerTransport filter.
const { readdirSync, readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const serversDir = "./src/mcp/servers";
// `.ts` only by repo convention. test/mcp/registry.test.ts asserts every
// resolveServerPath("...") name in registry.ts is in this discovered set, so
// adding a `.mts`/`.cts` server without broadening this filter trips CI
// instead of silently shipping a missing bundle.
//
// Sort the result: `readdirSync` order is not guaranteed across filesystems,
// and a stable order keeps Bun.build output deterministic so artifact diffs
// only reflect real changes.
const stdioEntrypoints = readdirSync(serversDir)
  .filter((f) => f.endsWith(".ts"))
  .sort()
  .map((f) => join(serversDir, f))
  .filter((p) => readFileSync(p, "utf8").includes("StdioServerTransport"));

const mcpResult = await Bun.build({
  entrypoints: stdioEntrypoints,
  outdir: "./dist/mcp/servers",
  target: "bun",
  minify: isProduction,
  sourcemap: isProduction ? "external" : "inline",
  splitting: false,
});

if (!mcpResult.success) {
  console.error("Build failed (mcp servers):");
  for (const log of mcpResult.logs) {
    console.error(log);
  }
  process.exit(1);
}

// Build 3: daemon worker entry point. Outputs dist/daemon/main.js.
// Invoked by the chart's daemon Deployment via `bun run dist/daemon/main.js`.
// Self-contained bundle (splitting: false) since the daemon runs as its own process.
const daemonResult = await Bun.build({
  entrypoints: ["./src/daemon/main.ts"],
  outdir: "./dist/daemon",
  target: "bun",
  minify: isProduction,
  sourcemap: isProduction ? "external" : "inline",
  splitting: false,
  naming: "main.js",
});

if (!daemonResult.success) {
  console.error("Build failed (daemon):");
  for (const log of daemonResult.logs) {
    console.error(log);
  }
  process.exit(1);
}

// Build 4: execute the real startup probe against the produced daemon image.
const processBoundarySmokeResult = await Bun.build({
  entrypoints: ["./src/daemon/process-boundary-smoke.ts"],
  outdir: "./dist/daemon",
  target: "bun",
  minify: isProduction,
  sourcemap: isProduction ? "external" : "inline",
  splitting: false,
  naming: "process-boundary-smoke.js",
});

if (!processBoundarySmokeResult.success) {
  console.error("Build failed (process boundary smoke):");
  for (const log of processBoundarySmokeResult.logs) {
    console.error(log);
  }
  process.exit(1);
}

// Build 5: one-attempt workflow runner. It ships in the daemon image because
// it needs the same agent CLI/toolchain, but has a separate process boundary.
const runnerResult = await Bun.build({
  entrypoints: ["./src/runner/main.ts"],
  outdir: "./dist/runner",
  target: "bun",
  minify: isProduction,
  sourcemap: isProduction ? "external" : "inline",
  splitting: false,
  naming: "main.js",
});

if (!runnerResult.success) {
  console.error("Build failed (workflow runner):");
  for (const log of runnerResult.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log("Build completed successfully");
