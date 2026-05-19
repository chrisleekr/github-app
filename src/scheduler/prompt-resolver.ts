/**
 * Resolve a scheduled action's `prompt` into the final prompt text the daemon
 * runs. Three forms (see `config-schema.ts`):
 *
 *   - inline: the text is used verbatim.
 *   - file:   a single file is fetched and used verbatim.
 *   - folder: an entrypoint file plus one level of sibling files are fetched
 *             and concatenated with `=== FILE: <path> ===` markers, so a
 *             skill-style bundle reaches the agent as one prompt.
 *
 * A `repo` on the prompt sources it from another repo. That is honoured only
 * when the other owner is allowlisted; installation access is enforced
 * naturally (a repo the installation cannot read returns 404 → the action is
 * skipped for the tick).
 */

import type { Octokit } from "octokit";
import type { Logger } from "pino";

import { isOwnerAllowed } from "../webhook/authorize";
import type { PromptRef } from "./config-schema";

/** Folder bundles are capped so a pathological directory cannot blow the prompt. */
const MAX_FOLDER_FILES = 20;
const MAX_FOLDER_BYTES = 200_000;

interface RepoCoords {
  readonly owner: string;
  readonly repo: string;
}

/** Resolve which repo a prompt ref points at, enforcing the owner allowlist. */
function resolveSourceRepo(
  promptRepo: string | undefined,
  ctxRepo: RepoCoords,
  log: Logger,
): RepoCoords {
  if (promptRepo === undefined) return ctxRepo;
  const [owner, repo] = promptRepo.split("/");
  if (owner === undefined || repo === undefined) {
    throw new Error(`prompt.repo is malformed: "${promptRepo}"`);
  }
  // The action runs with one installation token, scoped to a single account.
  // A cross-owner ref is a different installation the token cannot read (it
  // would 404), so cross-repo refs are restricted to the action's own owner.
  if (owner !== ctxRepo.owner) {
    throw new Error(
      `prompt.repo "${promptRepo}" must be owned by "${ctxRepo.owner}" (same installation)`,
    );
  }
  if (!isOwnerAllowed(owner, log).allowed) {
    throw new Error(`prompt.repo owner "${owner}" is not in ALLOWED_OWNERS`);
  }
  return { owner, repo };
}

/** Fetch one repo file as UTF-8 text, or null if the path is not a file. */
async function fetchFileText(
  octokit: Octokit,
  src: RepoCoords,
  path: string,
): Promise<string | null> {
  const res = await octokit.rest.repos.getContent({ owner: src.owner, repo: src.repo, path });
  const data = res.data;
  if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string") {
    return null;
  }
  return Buffer.from(data.content, "base64").toString("utf-8");
}

/** Resolve a folder prompt: entrypoint + one level of sibling files. */
async function resolveFolder(
  octokit: Octokit,
  src: RepoCoords,
  ref: string,
  entrypoint: string,
): Promise<string> {
  const dir = ref.replace(/\/+$/, "");
  const entryPath = `${dir}/${entrypoint}`;

  const listing = await octokit.rest.repos.getContent({
    owner: src.owner,
    repo: src.repo,
    path: dir,
  });
  if (!Array.isArray(listing.data)) {
    throw new Error(`prompt folder "${dir}" is not a directory`);
  }

  // Entrypoint first, then the rest of the directory's files in name order.
  const fileEntries = listing.data
    .filter((e) => e.type === "file")
    .sort((a, b) => a.path.localeCompare(b.path));
  const ordered = [
    ...fileEntries.filter((e) => e.path === entryPath),
    ...fileEntries.filter((e) => e.path !== entryPath),
  ].slice(0, MAX_FOLDER_FILES);
  if (!ordered.some((e) => e.path === entryPath)) {
    throw new Error(`prompt folder entrypoint "${entryPath}" not found`);
  }

  const sections: string[] = [];
  let totalBytes = 0;
  for (const entry of ordered) {
    // eslint-disable-next-line no-await-in-loop -- sequential fetch keeps the byte cap honest
    const text = await fetchFileText(octokit, src, entry.path);
    if (text === null) continue;
    totalBytes += Buffer.byteLength(text, "utf-8");
    if (totalBytes > MAX_FOLDER_BYTES) break;
    sections.push(`=== FILE: ${entry.path} ===\n${text}`);
  }
  if (sections.length === 0) {
    // Entrypoint and siblings all resolved to non-file entries, surface this
    // as a resolution failure so the caller logs the accurate cause.
    throw new Error(`prompt folder "${dir}" has no readable files`);
  }
  return sections.join("\n\n");
}

/**
 * Resolve a `PromptRef` into prompt text. Throws on any resolution failure;
 * the scheduler treats a throw as "skip this action for the tick".
 */
export async function resolvePrompt(
  octokit: Octokit,
  prompt: PromptRef,
  ctxRepo: RepoCoords,
  log: Logger,
): Promise<string> {
  if (prompt.form === "inline") {
    return prompt.text;
  }
  const src = resolveSourceRepo(prompt.repo, ctxRepo, log);
  if (prompt.form === "file") {
    const text = await fetchFileText(octokit, src, prompt.ref);
    if (text === null) {
      throw new Error(`prompt file "${prompt.ref}" is not a file`);
    }
    return text;
  }
  return resolveFolder(octokit, src, prompt.ref, prompt.entrypoint);
}
