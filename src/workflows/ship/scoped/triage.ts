/**
 * `bot:triage` scoped command (FR-034). Posts a single suggest-only
 * comment proposing labels, severity, and duplicate candidates for an
 * issue. Idempotent across re-triggers via the marker
 * `<!-- bot:triage:<issue_number> -->`.
 *
 * **Suggest-only: v1 MUST NOT mutate.** This module deliberately does
 * NOT import `addLabelsToLabelable`, `removeLabelsFromLabelable`,
 * `closeIssue`, `lockLockable`, `addAssigneesToAssignable`, or
 * `pinIssue`. The Oxlint `eslint-js/no-restricted-syntax` rule on this file path
 * (.oxlintrc.json) backs the contract at lint time; the test suite
 * (T078) backs it at runtime.
 *
 * Mutation paths are a deliberate v2 follow-up, kept out of v1 to give
 * maintainers full control over the actual label set.
 */

import type { Octokit } from "octokit";
import type { Logger } from "pino";

import { logger as rootLogger } from "../../../logger";
import { buildScopedMarker, upsertMarkerComment } from "./marker-comment";

const SCOPED_MARKER_VERB = "triage";

export const TRIAGE_SYSTEM_PROMPT = `You produce a triage proposal for a GitHub issue.
The reader is a maintainer who will decide whether to apply your suggestions manually.
Return Markdown with these sections in order:
  ### Proposed labels
  ### Severity (Low / Medium / High / Critical)
  ### Duplicate candidates (issue numbers + reasoning, or "none")
  ### Rationale (1-2 sentences)
This is **suggest-only**. You are NOT taking action: the maintainer decides.
Be conservative; prefer fewer, more accurate labels over a broad sweep.`;

export interface RunTriageInput {
  readonly octokit: Pick<Octokit, "rest" | "paginate">;
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number;
  readonly callLlm: (input: { systemPrompt: string; userPrompt: string }) => Promise<string>;
  readonly log?: Logger;
}

export async function runTriage(input: RunTriageInput): Promise<{ comment_id: number }> {
  const log = (input.log ?? rootLogger).child({
    event: "ship.scoped.triage",
    owner: input.owner,
    repo: input.repo,
    issue_number: input.issue_number,
  });

  const issue = await input.octokit.rest.issues.get({
    owner: input.owner,
    repo: input.repo,
    issue_number: input.issue_number,
  });

  const userPrompt = [
    `Title: ${issue.data.title}`,
    `State: ${issue.data.state}`,
    `Body:\n${issue.data.body ?? "(empty)"}`,
    `Existing labels: ${
      issue.data.labels
        .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
        .filter((s) => s.length > 0)
        .join(", ") || "(none)"
    }`,
  ].join("\n\n");

  const proposal = await input.callLlm({
    systemPrompt: TRIAGE_SYSTEM_PROMPT,
    userPrompt,
  });

  const closedPrefix =
    issue.data.state === "closed"
      ? `> _Issue is currently **closed**, triage proposal is read-only._\n\n`
      : "";

  const marker = buildScopedMarker({
    verb: SCOPED_MARKER_VERB,
    number: input.issue_number,
  });
  const body = `${closedPrefix}${proposal.trim()}\n\n${marker}`;

  const comment_id = await upsertMarkerComment({
    octokit: input.octokit,
    owner: input.owner,
    repo: input.repo,
    issue_number: input.issue_number,
    marker,
    body,
    source: "agent",
    log,
  });

  log.info({ comment_id }, "ship.scoped.triage posted");
  return { comment_id };
}
