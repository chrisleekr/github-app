import type { SQL } from "bun";

import { config } from "../config";
import { requireDb } from "../db";
import { logger } from "../logger";
import { isSafeGlob } from "../utils/review-learnings-filter";
import { sanitizeRepoMemoryContent } from "../utils/sanitize";
import { embedTexts, vectorLiteral } from "./embedding";

/**
 * Review learnings: persistent, per-repo (and owner-wide) review-policy
 * directives extracted from PR review pushback.
 *
 * Loaded only by the `review` and `resolve` workflow handlers and injected
 * into the agent prompt as repo policy. Directives can suppress findings,
 * so the trust boundary is stricter than `repo_memory`: see the handler-
 * level gate in src/workflows/handlers/review.ts + resolve.ts.
 *
 * Schema: src/db/migrations/014_review_learnings.sql
 * Surfacing: src/core/pipeline.ts appends a `🧠 Learnings used` footer.
 */

export type ReviewLearningScope = "local" | "global";

export interface ReviewLearning {
  id: string;
  scope: ReviewLearningScope;
  fileGlob: string | null;
  directive: string;
  rationale: string | null;
  sourcePr: number | null;
  sourceThread: string | null;
  sourceAuthor: string | null;
  createdAt: Date;
  useCount: number;
}

export interface SaveReviewLearningInput {
  directive: string;
  rationale?: string | undefined;
  fileGlob?: string | undefined;
  scope?: ReviewLearningScope | undefined;
  sourcePr?: number | undefined;
  sourceThread?: string | undefined;
  sourceAuthor?: string | undefined;
}

/** Maximum rows returned by loadReviewLearnings. Prompt-size bound. */
const LOAD_CAP = 50;

/**
 * Per-repo filter applied at load time. Sourced from `.github-app.yaml`'s
 * `review_learnings` block (1.5.F). Both fields optional with sensible
 * server-side defaults handled by the caller.
 */
export interface ReviewLearningsLoadFilter {
  /** `'local'` excludes owner-wide (`scope='global'`) rows. `'global'` keeps them. */
  scope?: "local" | "global";
  /** Excludes rows whose `created_at` is older than N days. `null` = no cap. */
  maxAgeDays?: number | null;
}

/**
 * Load review learnings applicable to (owner, repo), optionally filtered by
 * a per-repo `.github-app.yaml` policy (1.5.F).
 *
 * Returns every `local` row for (owner, repo) plus, when `scope: 'global'`
 * is allowed, every owner-wide row (`repo_name = '*'`). Up to LOAD_CAP,
 * ordered by recency. The orchestrator calls this at job-accept time, when
 * the PR's changed-file list is not yet known, so this function does NOT
 * filter by `file_glob`. The daemon-side prompt-builder applies that filter
 * via `pickApplicableLearnings` once `data.changedFiles` is available.
 *
 * **Pure read.** This function does NOT bump `use_count` / `last_used_at`.
 * Per 1.5.E, the bump moved to `bumpReviewLearningUsage`, which the
 * orchestrator calls with the IDs the daemon actually applied to a prompt
 * (reported back via `appliedReviewLearningIds` on `job:result`). That way
 * `use_count` reflects directives that informed real review work, not
 * directives that merely shipped in the payload.
 */
export async function loadReviewLearnings(
  owner: string,
  repo: string,
  filter: ReviewLearningsLoadFilter = {},
  db: SQL = requireDb(),
): Promise<ReviewLearning[]> {
  const includeGlobal = filter.scope !== "local";
  const maxAgeDays = filter.maxAgeDays ?? null;

  // Two WHERE shapes depending on whether owner-wide rows are included.
  // Building them as separate template-literal queries keeps Bun.sql
  // parameterisation honest; conditional `OR` inside one query would force
  // a placeholder for an enum, which is not how Bun.sql wants to be used.
  // `maxAgeDays` is applied identically in both shapes.
  interface Row {
    id: string;
    scope: string;
    file_glob: string | null;
    directive: string;
    rationale: string | null;
    source_pr: number | null;
    source_thread: string | null;
    source_author: string | null;
    created_at: Date;
    use_count: number;
  }
  const ageCutoffDays = maxAgeDays ?? 0; // ignored when maxAgeDays is null
  const rows: Row[] = includeGlobal
    ? maxAgeDays !== null
      ? await db`
          SELECT id, scope, file_glob, directive, rationale,
                 source_pr, source_thread, source_author,
                 created_at, use_count
          FROM review_learnings
          WHERE ((repo_owner = ${owner} AND repo_name = ${repo} AND scope = 'local')
              OR (repo_owner = ${owner} AND scope = 'global'))
            AND created_at > now() - make_interval(days => ${ageCutoffDays})
          ORDER BY last_used_at DESC NULLS LAST, created_at DESC
          LIMIT ${LOAD_CAP}
        `
      : await db`
          SELECT id, scope, file_glob, directive, rationale,
                 source_pr, source_thread, source_author,
                 created_at, use_count
          FROM review_learnings
          WHERE (repo_owner = ${owner} AND repo_name = ${repo} AND scope = 'local')
             OR (repo_owner = ${owner} AND scope = 'global')
          ORDER BY last_used_at DESC NULLS LAST, created_at DESC
          LIMIT ${LOAD_CAP}
        `
    : maxAgeDays !== null
      ? await db`
          SELECT id, scope, file_glob, directive, rationale,
                 source_pr, source_thread, source_author,
                 created_at, use_count
          FROM review_learnings
          WHERE repo_owner = ${owner} AND repo_name = ${repo} AND scope = 'local'
            AND created_at > now() - make_interval(days => ${ageCutoffDays})
          ORDER BY last_used_at DESC NULLS LAST, created_at DESC
          LIMIT ${LOAD_CAP}
        `
      : await db`
          SELECT id, scope, file_glob, directive, rationale,
                 source_pr, source_thread, source_author,
                 created_at, use_count
          FROM review_learnings
          WHERE repo_owner = ${owner} AND repo_name = ${repo} AND scope = 'local'
          ORDER BY last_used_at DESC NULLS LAST, created_at DESC
          LIMIT ${LOAD_CAP}
        `;

  return rows.map((r) => ({
    id: r.id,
    scope: r.scope === "global" ? "global" : "local",
    fileGlob: r.file_glob,
    directive: r.directive,
    rationale: r.rationale,
    sourcePr: r.source_pr,
    sourceThread: r.source_thread,
    sourceAuthor: r.source_author,
    createdAt: r.created_at,
    useCount: r.use_count,
  }));
}

/**
 * RAG-mode load (Phase 1.5.H). Embeds each of the PR's changed-file paths,
 * runs a top-K nearest-neighbour query against `embedding` for each, and
 * returns the de-duplicated union ordered by best match.
 *
 * Falls back to a regular `loadReviewLearnings` call when:
 *   - RAG is disabled (`embedTexts` returns null), OR
 *   - the embedding model failed to load (`embedTexts` returns null), OR
 *   - `fileNames` is empty (no file to query against).
 *
 * Applies the same `scope` and `maxAgeDays` filters as `loadReviewLearnings`.
 * Rows without an embedding (NULL) are excluded from the vector search,
 * they're picked up by the legacy file-glob fallback on the next dispatch
 * after a write refreshes them. Lazy backfill: a saver running with RAG
 * enabled will repopulate their `embedding` column.
 */
export interface SearchReviewLearningsOptions {
  filter?: ReviewLearningsLoadFilter;
  /** Per-file top-K cap. Default 10. */
  topKPerFile?: number;
  db?: SQL;
}

export async function searchReviewLearningsByEmbedding(
  owner: string,
  repo: string,
  fileNames: readonly string[],
  options: SearchReviewLearningsOptions = {},
): Promise<ReviewLearning[]> {
  const filter = options.filter ?? {};
  const topKPerFile = options.topKPerFile ?? 10;
  const db = options.db ?? requireDb();
  if (fileNames.length === 0) return loadReviewLearnings(owner, repo, filter, db);

  const queryEmbeddings = await embedTexts(fileNames);
  // Either RAG disabled, model unavailable, or inference failed: fall back.
  if (queryEmbeddings === null) return loadReviewLearnings(owner, repo, filter, db);

  const includeGlobal = filter.scope !== "local";
  const maxAgeDays = filter.maxAgeDays ?? null;
  const ageCutoffDays = maxAgeDays ?? 0;

  // Fan-out: one top-K query per file path. pgvector's `<=>` is cosine
  // distance; smaller = more similar. Union by id and keep the best distance
  // per id. With 50 max rows in the table and ~10 changed files in a
  // typical PR, this is <100 quick index lookups, well under network/RTT.
  interface Row {
    id: string;
    scope: string;
    file_glob: string | null;
    directive: string;
    rationale: string | null;
    source_pr: number | null;
    source_thread: string | null;
    source_author: string | null;
    created_at: Date;
    use_count: number;
    distance: number;
  }
  const bestById = new Map<string, Row>();

  for (const queryEmbedding of queryEmbeddings) {
    const qLit = vectorLiteral(queryEmbedding);
    // Per-file top-K. The WHERE clause mirrors loadReviewLearnings's
    // scope/age filter so the two paths return overlapping universes.
    // eslint-disable-next-line no-await-in-loop -- fan-out by file path; volume is tiny
    const rows: Row[] = await (includeGlobal
      ? maxAgeDays !== null
        ? db`
            SELECT id, scope, file_glob, directive, rationale,
                   source_pr, source_thread, source_author,
                   created_at, use_count,
                   (embedding <=> ${qLit}::vector) AS distance
            FROM review_learnings
            WHERE ((repo_owner = ${owner} AND repo_name = ${repo} AND scope = 'local')
                OR (repo_owner = ${owner} AND scope = 'global'))
              AND embedding IS NOT NULL
              AND created_at > now() - make_interval(days => ${ageCutoffDays})
            ORDER BY embedding <=> ${qLit}::vector
            LIMIT ${topKPerFile}
          `
        : db`
            SELECT id, scope, file_glob, directive, rationale,
                   source_pr, source_thread, source_author,
                   created_at, use_count,
                   (embedding <=> ${qLit}::vector) AS distance
            FROM review_learnings
            WHERE ((repo_owner = ${owner} AND repo_name = ${repo} AND scope = 'local')
                OR (repo_owner = ${owner} AND scope = 'global'))
              AND embedding IS NOT NULL
            ORDER BY embedding <=> ${qLit}::vector
            LIMIT ${topKPerFile}
          `
      : maxAgeDays !== null
        ? db`
            SELECT id, scope, file_glob, directive, rationale,
                   source_pr, source_thread, source_author,
                   created_at, use_count,
                   (embedding <=> ${qLit}::vector) AS distance
            FROM review_learnings
            WHERE repo_owner = ${owner} AND repo_name = ${repo} AND scope = 'local'
              AND embedding IS NOT NULL
              AND created_at > now() - make_interval(days => ${ageCutoffDays})
            ORDER BY embedding <=> ${qLit}::vector
            LIMIT ${topKPerFile}
          `
        : db`
            SELECT id, scope, file_glob, directive, rationale,
                   source_pr, source_thread, source_author,
                   created_at, use_count,
                   (embedding <=> ${qLit}::vector) AS distance
            FROM review_learnings
            WHERE repo_owner = ${owner} AND repo_name = ${repo} AND scope = 'local'
              AND embedding IS NOT NULL
            ORDER BY embedding <=> ${qLit}::vector
            LIMIT ${topKPerFile}
          `);

    for (const r of rows) {
      const prior = bestById.get(r.id);
      if (prior === undefined || r.distance < prior.distance) bestById.set(r.id, r);
    }
  }

  const merged = Array.from(bestById.values()).sort((a, b) => a.distance - b.distance);
  return merged.slice(0, LOAD_CAP).map((r) => ({
    id: r.id,
    scope: r.scope === "global" ? "global" : "local",
    fileGlob: r.file_glob,
    directive: r.directive,
    rationale: r.rationale,
    sourcePr: r.source_pr,
    sourceThread: r.source_thread,
    sourceAuthor: r.source_author,
    createdAt: r.created_at,
    useCount: r.use_count,
  }));
}

/**
 * Bump `use_count` + `last_used_at` for the directives the daemon actually
 * applied to a review/resolve prompt this run (1.5.E). Caller passes the
 * IDs the daemon reported via `appliedReviewLearningIds` on `job:result`.
 *
 * Fail-open: a failure to bump must NOT cause the run to fail. The counter
 * is a signal for tuning, not load-bearing.
 */
export async function bumpReviewLearningUsage(
  ids: readonly string[],
  db: SQL = requireDb(),
): Promise<void> {
  if (ids.length === 0) return;
  try {
    await db`
      UPDATE review_learnings
      SET last_used_at = now(), use_count = use_count + 1
      WHERE id IN ${db(ids)}
    `;
  } catch (err) {
    logger.warn({ err, count: ids.length }, "Failed to bump review_learnings use_count");
  }
}

/**
 * Persist review learnings discovered during a review/resolve run.
 *
 * Sanitises every text field at the durability boundary (defense in depth;
 * the MCP server already sanitised at the agent boundary). Skips rows whose
 * directive collapses to empty post-sanitization.
 *
 * Global scope is gated to single-owner ALLOWED_OWNERS deployments: a row
 * tagged `scope: 'global'` is silently downgraded to `'local'` when the
 * allowlist has more than one owner. This keeps the trust boundary out of
 * agent reach: a malicious directive cannot cross owners.
 */
export async function saveReviewLearnings(
  owner: string,
  repo: string,
  learnings: readonly SaveReviewLearningInput[],
  db: SQL = requireDb(),
): Promise<number> {
  if (learnings.length === 0) return 0;

  const globalScopeAllowed = config.allowedOwners?.length === 1;

  // Sanitise + scope-resolve every input up front; rows that collapse to
  // empty are dropped here so the embedding step doesn't waste a model
  // call on them.
  const prepared: { input: SaveReviewLearningInput; row: ReturnType<typeof sanitiseLearning> }[] =
    learnings.map((input) => ({
      input,
      row: sanitiseLearning(input, repo, globalScopeAllowed),
    }));
  const validRows = prepared.filter((p) => p.row !== null);
  if (validRows.length === 0) return 0;

  // Batch-embed `directive + rationale` for the surviving rows (1.5.H).
  // `embedTexts` returns null when RAG is disabled OR the model failed to
  // load; in either case we insert with NULL embedding and the load path
  // falls back to the deterministic file-glob filter.
  const embeddingInputs = validRows.map((p) => {
    const r = p.row;
    if (r === null) return "";
    return r.rationale === null ? r.directive : `${r.directive}\n${r.rationale}`;
  });
  const embeddings = await embedTexts(embeddingInputs);

  let saved = 0;
  for (let i = 0; i < validRows.length; i++) {
    const row = validRows[i]!.row;
    if (row === null) continue;
    const emb = embeddings?.[i] ?? null;
    const embLiteral = emb !== null ? vectorLiteral(emb) : null;

    try {
      // ON CONFLICT against idx_review_learnings_dedup (migration 014) makes
      // a re-save of the same (repo, scope, file_glob, directive) idempotent:
      // we bump updated_at + (optionally) refresh nullable provenance/rationale
      // when the new save carries values the old row didn't have. This keeps
      // the prompt block bounded; without it, repeated saves would accumulate
      // near-duplicates linearly. `embedding` is overwritten on conflict
      // (the most recent embedding reflects the most recent text), but only
      // when the incoming save brought one.
      // eslint-disable-next-line no-await-in-loop -- sequential to keep error attribution simple; volume is tiny
      const result: { id: string; inserted: boolean }[] = await db`
        INSERT INTO review_learnings
          (repo_owner, repo_name, scope, file_glob, directive, rationale,
           source_pr, source_thread, source_author, embedding)
        VALUES
          (${owner}, ${row.effectiveRepo}, ${row.effectiveScope},
           ${row.fileGlob}, ${row.directive}, ${row.rationale},
           ${row.sourcePr}, ${row.sourceThread}, ${row.sourceAuthor},
           ${embLiteral}::vector)
        ON CONFLICT (repo_owner, repo_name, scope, COALESCE(file_glob, ''), directive)
          DO UPDATE SET
            updated_at    = now(),
            rationale     = COALESCE(review_learnings.rationale,     EXCLUDED.rationale),
            source_pr     = COALESCE(review_learnings.source_pr,     EXCLUDED.source_pr),
            source_thread = COALESCE(review_learnings.source_thread, EXCLUDED.source_thread),
            source_author = COALESCE(review_learnings.source_author, EXCLUDED.source_author),
            embedding     = COALESCE(EXCLUDED.embedding,              review_learnings.embedding)
        RETURNING id, (xmax = 0) AS inserted
      `;
      // `inserted = true` means a fresh row was created. `false` means a
      // duplicate was upserted (existing row's updated_at bumped). Count
      // only fresh inserts so the caller's "saved N" log reflects real
      // additions, not silent dedups.
      if (result[0]?.inserted === true) saved++;
    } catch (err) {
      logger.warn(
        { err, owner, repo, scope: row.effectiveScope },
        "Failed to save review learning",
      );
    }
  }

  return saved;
}

/**
 * Sanitises every text field and resolves the effective scope/repo for one
 * input row. Returns null when the directive collapses to empty
 * post-sanitization (the caller skips empty rows entirely).
 */
function sanitiseLearning(
  input: SaveReviewLearningInput,
  repo: string,
  globalScopeAllowed: boolean,
): {
  effectiveScope: ReviewLearningScope;
  effectiveRepo: string;
  directive: string;
  rationale: string | null;
  fileGlob: string | null;
  sourcePr: number | null;
  sourceThread: string | null;
  sourceAuthor: string | null;
} | null {
  const directive = sanitizeRepoMemoryContent(input.directive);
  if (directive === "") return null;

  const effectiveScope: ReviewLearningScope =
    input.scope === "global" && globalScopeAllowed ? "global" : "local";

  const fileGlob = optionalSanitised(input.fileGlob);
  // Reject globs whose picomatch compilation is structurally pathological
  // (deeply nested alternations / quantifier nests that can trigger
  // catastrophic-backtracking under matcher()). A bad glob would otherwise
  // burn CPU on every future review. Drop the glob (degrade to repo-wide
  // scope) rather than rejecting the directive entirely: the policy itself
  // is still useful, just less precise.
  const safeFileGlob = fileGlob !== null && isSafeGlob(fileGlob) ? fileGlob : null;

  return {
    effectiveScope,
    effectiveRepo: effectiveScope === "global" ? "*" : repo,
    directive,
    rationale: optionalSanitised(input.rationale),
    fileGlob: safeFileGlob,
    sourcePr: input.sourcePr ?? null,
    sourceThread: optionalSanitised(input.sourceThread),
    sourceAuthor: optionalSanitised(input.sourceAuthor),
  };
}

function optionalSanitised(value: string | undefined): string | null {
  if (value === undefined) return null;
  const cleaned = sanitizeRepoMemoryContent(value);
  return cleaned === "" ? null : cleaned;
}

/**
 * Delete review learnings by id, scoped to (owner, repo).
 *
 * Defense in depth: an id that doesn't belong to the calling job's
 * (owner, repo) silently returns 0 rather than deleting from another repo's
 * row. The agent's `delete_review_learning` MCP tool runs in a known
 * owner/repo context (the job it was dispatched into), so an id leaking via
 * the discussion digest or a poisoned `priorBotOutput` from a different
 * repo cannot be used to delete that repo's learnings.
 *
 * `local` rows match on exact (owner, repo). `global` rows always live with
 * `repo_name = '*'` and apply across the whole owner, so an agent running in
 * any of that owner's repos may delete them.
 */
export async function deleteReviewLearnings(
  owner: string,
  repo: string,
  ids: readonly string[],
  db: SQL = requireDb(),
): Promise<number> {
  if (ids.length === 0) return 0;
  const deleted: { id: string }[] = await db`
    DELETE FROM review_learnings
    WHERE id IN ${db(ids)}
      AND repo_owner = ${owner}
      AND (
        (scope = 'local'  AND repo_name = ${repo}) OR
        (scope = 'global' AND repo_name = '*')
      )
    RETURNING id
  `;
  return deleted.length;
}
