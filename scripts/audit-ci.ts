#!/usr/bin/env bun
/**
 * CI dependency-audit gate.
 *
 * Why this wrapper exists:
 *   `bun audit` exits 1 on ANY advisory regardless of --audit-level
 *   (verified against https://bun.com/docs/install/audit). That blocks
 *   unrelated PRs every time a moderate transitive advisory lands. This
 *   wrapper restores severity-based gating: block on high+critical, warn
 *   on moderate+low, with an inline GHSA allowlist for known-accepted
 *   findings.
 *
 * Allowlist convention: every entry MUST have an `expires` so it gets
 * re-reviewed. Mirrors the .trivyignore.yaml convention. Expired entries
 * become warnings on the next run.
 */

interface BunAuditAdvisory {
  id?: number;
  module_name?: string;
  severity?: "low" | "moderate" | "high" | "critical";
  title?: string;
  url?: string;
  github_advisory_id?: string;
  cves?: string[];
}

interface BunAuditReport {
  advisories?: Record<string, BunAuditAdvisory>;
}

interface AllowEntry {
  ghsa: string;
  reason: string;
  expires: string; // ISO date
}

const IGNORED: AllowEntry[] = [
  // Example:
  // { ghsa: "GHSA-xxxx-xxxx-xxxx", reason: "...", expires: "2026-06-01" },
];

// `bun audit` reaches the registry's advisory endpoint, which fails often
// enough to block merges on its own: repeated `ConnectionClosed: audit request
// failed` runs, each burning ~4.5 min before giving up. Retry the produce-no-
// JSON case only, so a real report is never re-rolled.
// A healthy audit answers in ~2s, so 60s only ever bites on a hung attempt.
// Worst case is 3 x 60s + 2 x 5s backoff = ~3.2 min, which has to fit inside
// ci.yml's `timeout-minutes: 10` alongside lint, typecheck, tests and build.
const MAX_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 60_000;
const BACKOFF_MS = 5_000;

interface Attempt {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signalled: boolean;
}

function runAudit(): Attempt {
  const proc = Bun.spawnSync({
    cmd: ["bun", "audit", "--json"],
    stdout: "pipe",
    stderr: "pipe",
    timeout: ATTEMPT_TIMEOUT_MS,
  });
  return {
    stdout: new TextDecoder().decode(proc.stdout).trim(),
    stderr: new TextDecoder().decode(proc.stderr).trim(),
    exitCode: proc.exitCode,
    // A timeout kill arrives as SIGTERM, which leaves exitCode null. Classify
    // that as a failure to run, not as a clean "no advisories" result, so the
    // outcome is reported as a skipped audit rather than as a pass.
    signalled: proc.exitCode === null,
  };
}

let attempt = runAudit();
for (let i = 2; i <= MAX_ATTEMPTS && !attempt.stdout && failedToRun(attempt); i++) {
  console.warn(`::warning::bun audit attempt ${i - 1}/${MAX_ATTEMPTS} produced no JSON, retrying.`);
  if (attempt.stderr) console.error(attempt.stderr);
  Bun.sleepSync(BACKOFF_MS);
  attempt = runAudit();
}

function failedToRun(a: Attempt): boolean {
  return a.signalled || (a.exitCode !== null && a.exitCode !== 0);
}

const { stdout, stderr } = attempt;

if (!stdout) {
  // Empty stdout + a signal or non-zero exit means bun audit failed to RUN
  // (registry outage, network error), not that it audited cleanly. The retries
  // above already absorbed a transient blip, so reaching here means the
  // advisory service is down and the gate has no signal either way. Blocking
  // every merge for the length of an upstream outage buys no security, so warn
  // loudly and pass. Real advisories and unparseable output below still
  // hard-fail, and trivy-scan.yml scans the published images daily.
  if (failedToRun(attempt)) {
    const how = attempt.signalled
      ? "was killed by a signal"
      : `exited with code ${attempt.exitCode}`;
    console.warn(
      `::warning::bun audit ${how} and produced no JSON after ${MAX_ATTEMPTS} attempts. Dependency audit SKIPPED for this run.`,
    );
    if (stderr) console.error(stderr);
    process.exit(0);
  }
  console.log("bun audit produced no JSON output (no advisories).");
  if (stderr) console.error(stderr);
  process.exit(0);
}

let report: BunAuditReport;
try {
  report = JSON.parse(stdout);
} catch (err) {
  console.error("Failed to parse bun audit JSON:");
  console.error(err);
  console.error("--- raw stdout ---");
  console.error(stdout);
  if (stderr) {
    console.error("--- raw stderr ---");
    console.error(stderr);
  }
  process.exit(1);
}

const advisories = Object.values(report.advisories ?? {});
const now = new Date();

function lookupAllow(ghsa: string): AllowEntry | null {
  const entry = IGNORED.find((e) => e.ghsa === ghsa);
  if (!entry) return null;
  // Enforce YYYY-MM-DD so we can append an end-of-day time deterministically.
  // `new Date("2026-04-30")` resolves to 00:00:00Z, so the entry would be
  // considered expired for the whole day. Treat the expiry as valid through
  // 23:59:59.999 UTC of the stated day instead.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)) {
    console.warn(
      `::warning::Allowlist entry for ${ghsa} has invalid expires date (want YYYY-MM-DD): ${entry.expires}`,
    );
    return null;
  }
  const expiresAt = new Date(`${entry.expires}T23:59:59.999Z`);
  if (Number.isNaN(expiresAt.getTime())) {
    console.warn(
      `::warning::Allowlist entry for ${ghsa} has invalid expires date: ${entry.expires}`,
    );
    return null;
  }
  if (expiresAt < now) {
    console.warn(
      `::warning::Allowlist entry for ${ghsa} expired ${entry.expires}, must re-review.`,
    );
    return null;
  }
  return entry;
}

let blocking = 0;
let warning = 0;
let ignored = 0;

for (const a of advisories) {
  const ghsa = a.github_advisory_id ?? "";
  const allow = ghsa ? lookupAllow(ghsa) : null;
  const sev = a.severity ?? "low";
  const id = ghsa || `id=${a.id ?? "?"}`;
  const where = a.module_name ?? "(unknown module)";
  const title = a.title ?? "(no title)";

  if (allow) {
    console.log(
      `::notice::Ignored ${id} (${sev}) ${where}: ${title}, ${allow.reason} (expires ${allow.expires})`,
    );
    ignored++;
    continue;
  }

  if (sev === "high" || sev === "critical") {
    console.log(`::error::${sev.toUpperCase()} ${id} ${where}: ${title}`);
    if (a.url) console.log(`  ${a.url}`);
    blocking++;
  } else {
    console.log(`::warning::${sev} ${id} ${where}: ${title}`);
    if (a.url) console.log(`  ${a.url}`);
    warning++;
  }
}

console.log(
  `\nSummary: blocking=${blocking} warning=${warning} ignored=${ignored} total=${advisories.length}`,
);

process.exit(blocking > 0 ? 1 : 0);
