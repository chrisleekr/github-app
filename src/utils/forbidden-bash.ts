/**
 * Single source of truth for the destructive-action pattern set.
 *
 * Shared by two layers (issue #222):
 *   - the static CI guard `scripts/check-no-destructive-actions.ts`, which greps
 *     ship-workflow source for these patterns at build time, and
 *   - the runtime PreToolUse hook `src/core/hooks/forbidden-bash.ts`, which
 *     denies a matching Bash command before the agent subprocess executes it.
 *
 * Keeping the list in one module guarantees the static and runtime layers can
 * never drift apart.
 */

export interface ForbiddenRule {
  readonly pattern: RegExp;
  readonly description: string;
}

export const FORBIDDEN: readonly ForbiddenRule[] = [
  // `(?!-with-lease)` keeps this rule mutually exclusive with the next one, so
  // `--force-with-lease` reports the specific rule (not "git push --force") and
  // the static scanner does not double-count one line. `--force-if-includes`
  // still matches here, which is intended.
  { pattern: /git\s+push\s+--force(?!-with-lease)/i, description: "git push --force" },
  { pattern: /git\s+push\s+--force-with-lease/i, description: "git push --force-with-lease" },
  { pattern: /git\s+push\s+-f\b/i, description: "git push -f" },
  // Whitespace then `+` then a word char catches `+HEAD:main` after a remote;
  // a JS concat like `" + branch"` has a space after `+` so it does not match.
  { pattern: /git\s+push\b[^|;&\n]*\s\+\w/i, description: "git push with + force-refspec" },
  { pattern: /git\s+push\s+--mirror/i, description: "git push --mirror" },
  { pattern: /git\s+reset\s+--hard\b/i, description: "git reset --hard" },
  { pattern: /git\s+branch\s+-D\b/i, description: "git branch -D" },
  { pattern: /git\s+push\b[^"\n]*\s--delete\b/i, description: "git push --delete" },
  { pattern: /git\s+filter-branch/i, description: "git filter-branch" },
  { pattern: /git\s+filter-repo/i, description: "git filter-repo" },
  { pattern: /git\s+replace\b/i, description: "git replace" },
  { pattern: /\bgh\s+pr\s+merge/i, description: "gh pr merge" },
  { pattern: /mergePullRequest\s*\(/, description: "mergePullRequest GraphQL mutation" },
  { pattern: /mergeBranch\s*\(/, description: "mergeBranch GraphQL mutation" },
];

/**
 * First FORBIDDEN entry whose pattern matches `command`, else undefined.
 * Patterns carry no /g flag, so reusing them across calls via .test() is safe.
 */
export function findForbiddenBash(command: string): ForbiddenRule | undefined {
  return FORBIDDEN.find((entry) => entry.pattern.test(command));
}
