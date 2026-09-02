import { Octokit } from "octokit";

import { config } from "../config";

/**
 * Which GitHub login our writes are attributed to, for `isSelfActor`
 * (`src/utils/github-actor.ts`).
 *
 * Two auth modes, two identities:
 *
 *   - App installation token (default). Writes are attributed to the App's bot
 *     account, whose login is `config.botAppLogin` (`BOT_APP_LOGIN`). No API
 *     call: installation tokens cannot call `GET /user` at all, it requires
 *     user-to-server auth and returns 403. Same fact `implement.ts` records.
 *   - `GITHUB_PERSONAL_ACCESS_TOKEN`. Writes are attributed to the PAT owner,
 *     an ordinary User whose login only `GET /user` knows.
 */

let selfLogin: Promise<string | null> | null = null;

/**
 * Builds its own client rather than accepting one, because the caller's octokit
 * is whatever that call site had: the webhook server's is App-scoped even when a
 * PAT is configured, so asking it `GET /user` would 403 and silently resolve the
 * PAT owner to null. The PAT is the credential whose owner we want, so the PAT
 * is what we ask with. Mirrors `src/orchestrator/connection-handler.ts:284`.
 */
export function resolveSelfLogin(): Promise<string | null> {
  const pat = config.githubPersonalAccessToken;
  if (pat === undefined) return Promise.resolve(config.botAppLogin);
  // Memoise the promise, not the resolved value: that collapses concurrent
  // callers onto one request. The assignment stays in this sync body on
  // purpose, so there is no read-then-await-then-write window on `selfLogin`.
  selfLogin ??= fetchSelfLogin(pat);
  return selfLogin;
}

async function fetchSelfLogin(pat: string): Promise<string | null> {
  try {
    const r = await new Octokit({ auth: pat }).rest.users.getAuthenticated();
    return r.data.login;
  } catch {
    // Not cached: a transient failure degrades one call, it does not disable
    // the check for the lifetime of the process. Null is the fail-open
    // direction for every caller (a redundant review, a duplicate comment).
    selfLogin = null;
    return null;
  }
}

/** Test-only: drop the memoised login so cases can vary the auth mode. */
export function __resetBotIdentityCache(): void {
  selfLogin = null;
}
