/**
 * Is this GitHub actor us?
 *
 * A login comparison, deliberately NOT a `type === "Bot"` test. `type` is the
 * account class every GitHub App shares, not an identity: `renovate[bot]`,
 * `dependabot[bot]`, `coderabbitai[bot]` and `github-actions[bot]` all carry it.
 * Claiming those as us silently drops third-party review feedback and lets
 * anyone who can post as `github-actions[bot]` suppress one of our findings by
 * commenting on the line first.
 *
 * Config-free on purpose, like `src/utils/log-redaction.ts`: the inline-comment
 * MCP server imports this from a subprocess whose env allowlist excludes what
 * `src/config.ts` validates at import. Resolving *which* login is ours needs
 * config, so it lives in `src/utils/bot-identity.ts` for in-process callers and
 * in the server's own `BOT_APP_LOGIN` env for the subprocess.
 */

/** A GitHub actor as it appears on a comment, a push sender, or a PR author. */
export interface GithubActorLike {
  readonly login?: string | undefined;
  readonly type?: string | undefined;
}

/**
 * `selfLogin` is the login our writes are attributed to: the App's bot account
 * under an installation token, the PAT owner under
 * `GITHUB_PERSONAL_ACCESS_TOKEN`. Null means we could not resolve one, and the
 * answer is then "not us". Every caller treats that as the fail-open direction
 * (a redundant review, a duplicate comment), never as a suppression.
 */
export function isSelfActor(
  actor: GithubActorLike | null | undefined,
  selfLogin: string | null,
): boolean {
  if (selfLogin === null) return false;
  if (actor?.login === undefined) return false;
  return actor.login.toLowerCase() === selfLogin.toLowerCase();
}
