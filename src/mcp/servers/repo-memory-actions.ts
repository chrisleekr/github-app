/**
 * Pure logic for the repo_memory MCP server's tool handlers and the
 * .daemon-actions.json round-trip. Lives in a sibling module so the server
 * file (which has module-level env reads and a `void main()` call) stays
 * focused on transport wiring, and so direct unit tests can exercise the
 * handlers without spawning a subprocess.
 *
 * The action types here are the on-wire shape of `.daemon-actions.json`.
 * `src/core/pipeline.ts:readDaemonActionsFile` and the orchestrator
 * persistence path consume these.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { sanitizeRepoMemoryContent } from "../../utils/sanitize";

export interface SaveAction {
  type: "save";
  category: string;
  content: string;
}

export interface DeleteAction {
  type: "delete";
  id: string;
}

export interface SaveReviewLearningAction {
  type: "save_learning";
  directive: string;
  rationale?: string;
  fileGlob?: string;
  scope?: "local" | "global";
  sourcePr?: number;
  sourceThread?: string;
  sourceAuthor?: string;
}

export interface DeleteReviewLearningAction {
  type: "delete_learning";
  id: string;
}

export type DaemonAction =
  | SaveAction
  | DeleteAction
  | SaveReviewLearningAction
  | DeleteReviewLearningAction;

/**
 * Read all actions from an absolute path. Returns `[]` on missing or
 * corrupted file: the .daemon-actions.json store is best-effort scratch
 * state and a future `appendAction` call will overwrite it with fresh
 * contents.
 */
export function readActionsFromPath(path: string): DaemonAction[] {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-controlled path
    if (existsSync(path)) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-controlled path
      return JSON.parse(readFileSync(path, "utf-8")) as DaemonAction[];
    }
  } catch {
    // Corrupted file, start fresh.
  }
  return [];
}

/**
 * Append an action to the file at `path`. Read-modify-write: not atomic, but
 * the MCP server runs tools sequentially and the daemon scratch dir is
 * exclusive to this job, so concurrent writers are not a real concern.
 */
export function appendActionToPath(path: string, action: DaemonAction): void {
  const actions = readActionsFromPath(path);
  actions.push(action);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-controlled path
  writeFileSync(path, JSON.stringify(actions, null, 2));
}

// Pure builders. Each takes the agent-facing snake_case input and returns
// either a normalised camelCase action ready to append, or a failure reason
// (e.g. empty after sanitisation). Tests can exercise the build path
// directly without filesystem side effects.

export type BuildResult<T> = { ok: true; action: T } | { ok: false; reason: string };

export interface SaveRepoMemoryInput {
  category: string;
  content: string;
}

export function buildSaveAction(input: SaveRepoMemoryInput): BuildResult<SaveAction> {
  const safeContent = sanitizeRepoMemoryContent(input.content);
  if (safeContent === "") {
    return { ok: false, reason: "empty_after_sanitize" };
  }
  return {
    ok: true,
    action: { type: "save", category: input.category, content: safeContent },
  };
}

export interface SaveReviewLearningInput {
  directive: string;
  rationale?: string | undefined;
  file_glob?: string | undefined;
  scope?: "local" | "global" | undefined;
  source_pr?: number | undefined;
  source_thread?: string | undefined;
  source_author?: string | undefined;
}

export function buildSaveReviewLearningAction(
  input: SaveReviewLearningInput,
): BuildResult<SaveReviewLearningAction> {
  const directive = sanitizeRepoMemoryContent(input.directive);
  if (directive === "") {
    return { ok: false, reason: "empty_after_sanitize" };
  }

  const action: SaveReviewLearningAction = { type: "save_learning", directive };
  const rationale = optionalSanitised(input.rationale);
  if (rationale !== null) action.rationale = rationale;
  const fileGlob = optionalSanitised(input.file_glob);
  if (fileGlob !== null) action.fileGlob = fileGlob;
  if (input.scope !== undefined) action.scope = input.scope;
  if (input.source_pr !== undefined) action.sourcePr = input.source_pr;
  const sourceThread = optionalSanitised(input.source_thread);
  if (sourceThread !== null) action.sourceThread = sourceThread;
  const sourceAuthor = optionalSanitised(input.source_author);
  if (sourceAuthor !== null) action.sourceAuthor = sourceAuthor;

  return { ok: true, action };
}

function optionalSanitised(value: string | undefined): string | null {
  if (value === undefined) return null;
  const cleaned = sanitizeRepoMemoryContent(value);
  return cleaned === "" ? null : cleaned;
}
