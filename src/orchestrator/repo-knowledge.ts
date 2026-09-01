import type { SQL } from "bun";

import { requireDb } from "../db";
import { sanitizeRepoMemoryContent } from "../utils/sanitize";

// Types

export interface RepoMemoryEntry {
  id: string;
  category: string;
  content: string;
  pinned: boolean;
}

// Env vars (category = 'env_var')

/**
 * Get all env vars for a repo as a key-value map.
 * Parses "KEY=value" content format. Entries with no '=' are skipped.
 */
export async function getRepoEnvVars(owner: string, repo: string): Promise<Record<string, string>> {
  const db = requireDb();
  const rows: { content: string }[] = await db`
    SELECT content FROM repo_memory
    WHERE repo_owner = ${owner} AND repo_name = ${repo} AND category = 'env_var'
  `;

  const envVars = new Map<string, string>();
  for (const row of rows) {
    const eqIdx = row.content.indexOf("=");
    if (eqIdx === -1) continue;
    const key = row.content.slice(0, eqIdx);
    const value = row.content.slice(eqIdx + 1);
    envVars.set(key, value);
  }
  return Object.fromEntries(envVars);
}

/**
 * Set (upsert) a single env var for a repo.
 * Stored as pinned with category 'env_var' and content "KEY=value".
 */
export async function setRepoEnvVar(
  owner: string,
  repo: string,
  key: string,
  value: string,
): Promise<void> {
  const db = requireDb();
  const content = `${key}=${value}`;

  // The partial unique index on split_part(content, '=', 1) WHERE category = 'env_var'
  // prevents duplicate keys. Use a raw upsert targeting that constraint.
  await db`
    INSERT INTO repo_memory (repo_owner, repo_name, category, content, pinned)
    VALUES (${owner}, ${repo}, 'env_var', ${content}, true)
    ON CONFLICT (repo_owner, repo_name, split_part(content, '=', 1))
      WHERE category = 'env_var'
    DO UPDATE SET content = ${content}, updated_at = now()
  `;
}

// Memory (category != 'env_var')

/**
 * Get repo memory entries using LRU + pinned strategy.
 * Returns ALL pinned non-env entries plus top 5 non-pinned by most recent activity.
 * Bumps last_read_at on all returned rows.
 */
export async function getRepoMemory(
  owner: string,
  repo: string,
  db: SQL = requireDb(),
): Promise<RepoMemoryEntry[]> {
  const rows: { id: string; category: string; content: string; pinned: boolean }[] = await db`
    (
      SELECT id, category, content, pinned FROM repo_memory
      WHERE repo_owner = ${owner} AND repo_name = ${repo}
        AND category != 'env_var' AND pinned = true
    )
    UNION ALL
    (
      SELECT id, category, content, pinned FROM repo_memory
      WHERE repo_owner = ${owner} AND repo_name = ${repo}
        AND category != 'env_var' AND pinned = false
      ORDER BY GREATEST(updated_at, last_read_at) DESC
      LIMIT 5
    )
  `;

  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    await db`UPDATE repo_memory SET last_read_at = now() WHERE id IN ${db(ids)}`;
  }

  return rows;
}

/**
 * Save learnings discovered during execution.
 * Skips entries that already exist with the same (owner, repo, category, content),
 * and also silently skips entries whose content collapses to empty after
 * sanitizeRepoMemoryContent (e.g. content was entirely an HTML comment or
 * invisibles), so `saved < learnings.length` can mean either case.
 */
export async function saveRepoLearnings(
  owner: string,
  repo: string,
  learnings: readonly { category: string; content: string }[],
  db: SQL = requireDb(),
): Promise<number> {
  if (learnings.length === 0) return 0;

  let saved = 0;

  // Process each learning sequentially, DB writes are inherently serial per-connection
  // and the volume is tiny (typically 1-5 learnings per execution).
  for (const learning of learnings) {
    // Defense in depth: the MCP server already sanitizes on write, but the
    // daemon scratch file is attacker-reachable if a future executor regresses,
    // so re-sanitize at the durability boundary too. Skip empty rows that
    // collapsed to nothing after sanitization.
    const safeContent = sanitizeRepoMemoryContent(learning.content);
    if (safeContent === "") continue;
    // eslint-disable-next-line no-await-in-loop -- bounded action list preserves result order
    const result: { id: string }[] = await db`
      INSERT INTO repo_memory (repo_owner, repo_name, category, content, pinned)
      VALUES (${owner}, ${repo}, ${learning.category}, ${safeContent}, false)
      ON CONFLICT (
        repo_owner,
        repo_name,
        category,
        content_sha256
      ) WHERE category <> 'env_var' DO NOTHING
      RETURNING id
    `;
    if (result.length > 0) {
      saved++;
    } else {
      // eslint-disable-next-line no-await-in-loop -- bounded action list preserves result order
      await db`
        UPDATE repo_memory SET updated_at = now()
        WHERE repo_owner = ${owner} AND repo_name = ${repo}
          AND category = ${learning.category} AND content = ${safeContent}
      `;
    }
  }

  return saved;
}

/**
 * Delete repo memory entries by ID.
 * Used when Claude identifies outdated or incorrect memories.
 */
export async function deleteRepoMemories(
  owner: string,
  repo: string,
  ids: readonly string[],
  db: SQL = requireDb(),
): Promise<number> {
  if (ids.length === 0) return 0;
  const deleted: { id: string }[] = await db`
    DELETE FROM repo_memory
     WHERE id IN ${db(ids)}
       AND repo_owner = ${owner}
       AND repo_name = ${repo}
    RETURNING id
  `;
  return deleted.length;
}
