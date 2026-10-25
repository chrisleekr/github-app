import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { SQL } from "bun";

import { logger } from "../logger";

// Use process.cwd() (project root) instead of import.meta.dir because Bun.build
// bundles TS→JS into dist/ but does not copy .sql files. The Dockerfile copies
// src/db/migrations/ into the production image so the path resolves correctly.
const MIGRATIONS_DIR = join(process.cwd(), "src/db/migrations");

// Fixed advisory lock key to serialize migrations across replicas.
const MIGRATION_LOCK_KEY = 819_283_746;

/**
 * Run all pending SQL migrations in order.
 *
 * Tracks applied migrations in a `_migrations` table. Each migration runs
 * inside a transaction for atomicity: if a migration fails, the transaction
 * is rolled back and subsequent migrations are not attempted.
 *
 * Migration files are plain `.sql` files in `src/db/migrations/`, sorted by
 * filename (use numeric prefixes like `001_`, `002_` for ordering).
 */
export async function runMigrations(sql: SQL): Promise<void> {
  // Verify connectivity before attempting migrations, produces a clear error
  // instead of a raw Postgres connection failure deep in a DDL statement.
  try {
    await sql`SELECT 1`;
  } catch (err) {
    throw new Error(
      `Cannot connect to database: ${err instanceof Error ? err.message : String(err)}`,
      {
        cause: err,
      },
    );
  }

  // Ensure the tracking table exists (idempotent)
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  // Reserve a single connection so the advisory lock and unlock execute on the
  // same session, pool-dispatched queries can land on different connections,
  // leaving the lock orphaned until the connection is recycled.
  const conn = await sql.reserve();
  // Track whether the advisory lock was actually acquired so the matching
  // unlock runs exactly when needed, and always runs, even if a migration
  // throws. Session-level locks otherwise stay held on the pooled connection
  // and block the next migrator.
  let locked = false;

  try {
    await conn`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    locked = true;

    const applied: { version: string }[] = await conn`
      SELECT version FROM _migrations ORDER BY version
    `;
    const appliedSet = new Set(applied.map((r) => r.version));

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      if (appliedSet.has(version)) {
        continue;
      }

      const filePath = join(MIGRATIONS_DIR, file);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is join()-constructed from controlled dir
      const content = readFileSync(filePath, "utf-8");

      logger.info({ version, file }, "Applying migration");

      // eslint-disable-next-line no-await-in-loop -- migrations must run sequentially
      await conn.begin(async (tx) => {
        await tx.unsafe(content);
        await tx`INSERT INTO _migrations (version) VALUES (${version})`;
      });

      logger.info({ version }, "Migration applied successfully");
    }
  } finally {
    try {
      if (locked) {
        await conn`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
      }
    } finally {
      await conn.release();
    }
  }
}
