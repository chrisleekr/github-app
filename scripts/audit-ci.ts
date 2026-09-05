#!/usr/bin/env bun
/**
 * CI dependency-audit gate.
 *
 * Why this wrapper exists:
 *   It provides an expiring GHSA allowlist, retries then warns and passes when
 *   the advisory service is unreachable, and emits per-advisory GitHub Actions
 *   annotations.
 *
 * Allowlist convention: every entry MUST have an `expires` so it gets
 * re-reviewed. Mirrors the .trivyignore.yaml convention. Expired entries
 * become warnings on the next run.
 */

interface BunAuditAdvisory {
  id?: number | string | null | undefined;
  url?: string | null | undefined;
  title?: string | null | undefined;
  severity: "low" | "moderate" | "high" | "critical";
}

type BunAuditReport = Record<string, BunAuditAdvisory[]>;

// WHY: registry data must not inject additional GitHub Actions workflow commands.
function escapeData(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

// WHY: the Actions runner treats any line that starts with "::" after TrimStart() as a
// workflow command, on stderr as well as stdout. A fixed prefix keeps registry-derived
// lines from ever starting with "::". Split on \r too: StreamReader.ReadLine ends a line there.
function dump(text: string): void {
  for (const line of text.split(/\r\n|\r|\n/)) console.error(`> ${line}`);
}

function isAdvisory(value: unknown): value is BunAuditAdvisory {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const advisory = value as Record<string, unknown>;
  const severity = advisory.severity;
  return (
    (severity === "low" ||
      severity === "moderate" ||
      severity === "high" ||
      severity === "critical") &&
    (advisory.title === undefined ||
      advisory.title === null ||
      typeof advisory.title === "string") &&
    (advisory.url === undefined || advisory.url === null || typeof advisory.url === "string") &&
    (advisory.id === undefined ||
      advisory.id === null ||
      typeof advisory.id === "number" ||
      typeof advisory.id === "string")
  );
}

function isBunAuditReport(value: unknown): value is BunAuditReport {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(
    (advisoryArray) => Array.isArray(advisoryArray) && advisoryArray.every(isAdvisory),
  );
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
    // `exitCode` is declared `number` but is null at runtime on a signal kill
    // (verified on bun 1.3.12 and 1.3.14), so it cannot carry this check in
    // typed code. These two optional fields are the documented way to detect
    // termination: https://bun.com/reference/bun/SyncSubprocess
    signalled: proc.signalCode != null || proc.exitedDueToTimeout === true,
  };
}

// `bun audit` exits 1 when it FINDS advisories, so a non-zero exit alongside a
// report is the normal path. Only an empty report marks a run that never
// happened.
function failedToRun(a: Attempt): boolean {
  return a.signalled || (a.exitCode !== null && a.exitCode !== 0);
}

// A killed process can still have flushed parseable JSON, which would be a
// partial report. Treat any termination as "no report" so a truncated one is
// never mistaken for a verdict.
function producedNoReport(a: Attempt): boolean {
  return a.signalled || (!a.stdout && failedToRun(a));
}

// Only a genuine failure to reach the advisory service earns the skip below.
// Every other failure to run (bun crash, unreadable lockfile, bad credentials)
// says something about this repo and still hard-fails.
const SERVICE_UNREACHABLE =
  /audit request failed|ConnectionClosed|ConnectionRefused|ConnectionTimedOut|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed/i;

function isServiceUnreachable(a: Attempt): boolean {
  // A killed attempt is one that got 60s to answer and never did, which is
  // unreachable from this side whatever the cause.
  return a.signalled || SERVICE_UNREACHABLE.test(a.stderr);
}

// Reached only when every attempt failed to produce a report. An unreachable
// advisory service yields no verdict in either direction, and blocking every
// merge for the length of an upstream outage buys no security, so warn loudly
// and pass. Anything else exits non-zero.
function skipOrFail(a: Attempt): never {
  const how = a.signalled ? "was killed after not responding" : `exited with code ${a.exitCode}`;
  if (isServiceUnreachable(a)) {
    console.warn(
      `::warning::bun audit ${how} and produced no usable JSON after ${MAX_ATTEMPTS} attempts. Dependency audit SKIPPED for this run.`,
    );
    if (a.stderr) dump(a.stderr);
    process.exit(0);
  }
  console.error(`::error::bun audit ${how} without reaching the advisory service.`);
  if (a.stderr) dump(a.stderr);
  process.exit(a.exitCode ?? 1);
}

let attempt = runAudit();
for (let i = 2; i <= MAX_ATTEMPTS && producedNoReport(attempt); i++) {
  console.warn(`::warning::bun audit attempt ${i - 1}/${MAX_ATTEMPTS} produced no JSON, retrying.`);
  if (attempt.stderr) dump(attempt.stderr);
  Bun.sleepSync(BACKOFF_MS);
  attempt = runAudit();
}

if (producedNoReport(attempt)) skipOrFail(attempt);

const { stdout, stderr } = attempt;

if (!stdout) {
  console.log("bun audit produced no JSON output (no advisories).");
  if (stderr) dump(stderr);
  process.exit(0);
}

let report: unknown;
try {
  report = JSON.parse(stdout);
} catch (err) {
  console.error("Failed to parse bun audit JSON:");
  dump(String(err));
  console.error("--- raw stdout ---");
  dump(stdout.slice(0, 2000));
  if (stderr) {
    console.error("--- raw stderr ---");
    dump(stderr);
  }
  process.exit(1);
}

if (!isBunAuditReport(report)) {
  console.error(
    "::error::unrecognised bun audit JSON shape (expected a map of package name to advisory list)",
  );
  dump(stdout.slice(0, 2000));
  process.exit(1);
}

const advisories = Object.entries(report).flatMap(([pkgName, advisoryArray]) =>
  advisoryArray.map((advisory) => ({ advisory, pkgName })),
);
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

for (const { advisory: a, pkgName } of advisories) {
  const ghsa = /(?:^|\/)(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/i.exec(a.url ?? "")?.[1] ?? "";
  const allow = ghsa ? lookupAllow(ghsa) : null;
  const sev = a.severity;
  const id = ghsa || `id=${escapeData(String(a.id ?? "?"))}`;
  const pkg = escapeData(pkgName);
  const title = escapeData(a.title ?? "(no title)");
  const url = a.url ? ` ${escapeData(a.url)}` : "";

  if (allow) {
    console.log(
      `::notice::Ignored ${id} (${sev}) ${pkg}: ${title}, ${allow.reason} (expires ${allow.expires})`,
    );
    ignored++;
    continue;
  }

  if (sev === "high" || sev === "critical") {
    console.log(`::error::${sev.toUpperCase()} ${id} ${pkg}: ${title}${url}`);
    blocking++;
  } else {
    console.log(`::warning::${sev} ${id} ${pkg}: ${title}${url}`);
    warning++;
  }
}

console.log(
  `\nSummary: blocking=${blocking} warning=${warning} ignored=${ignored} total=${advisories.length}`,
);

process.exit(blocking > 0 ? 1 : 0);
