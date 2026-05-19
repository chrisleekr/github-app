/**
 * Enumerate every repo the GitHub App is installed on, filtered through the
 * `ALLOWED_OWNERS` allowlist.
 *
 * The scheduler walks this list each tick to find `.github-app.yaml` files.
 * Owner-allowlist filtering here is the load-bearing trust gate: a scheduled
 * action's prompt is owner-trusted config, so only allowlisted owners' repos
 * may run one. The caller (scheduler.ts) refuses to start at all when
 * `ALLOWED_OWNERS` is unset, so this filter is never a no-op in practice.
 */

import type { App, Octokit } from "octokit";
import type { Logger } from "pino";

import { isOwnerAllowed } from "../webhook/authorize";

export interface ScheduledRepo {
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  /** Installation-scoped Octokit for config + prompt fetches. */
  readonly octokit: Octokit;
}

/**
 * Yield every installed repo owned by an allowlisted owner. Per-installation
 * enumeration errors are logged and skipped so one bad installation does not
 * abort the whole scan.
 */
export async function* enumerateScheduledRepos(
  app: App,
  log: Logger,
): AsyncGenerator<ScheduledRepo> {
  for await (const { octokit, installation } of app.eachInstallation.iterator()) {
    const installationId = installation.id;
    try {
      for await (const { repository } of app.eachRepository.iterator({ installationId })) {
        const owner = repository.owner.login;
        const repo = repository.name;
        if (!isOwnerAllowed(owner, log).allowed) continue;
        yield { installationId, owner, repo, octokit: octokit as unknown as Octokit };
      }
    } catch (err) {
      log.warn({ err, installationId }, "scheduler: repo enumeration failed for installation");
    }
  }
}
