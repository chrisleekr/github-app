import { config } from "../config";

/**
 * Escape special regex characters in a string.
 * Ported from claude-code-action's src/github/validation/trigger.ts
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary match for a mention ANYWHERE in the body, not just as a
 * prefix. `([\s.,!?;:)]|$)` after the phrase keeps a longer login that shares
 * the prefix (`@chrisleekr-bot-foo`) from matching `@chrisleekr-bot`.
 *
 * `global` is required by `stripTriggerPhrase`, which replaces every
 * occurrence. A global regex carries `lastIndex` across `.test` calls, so
 * every entry point below builds its own instance rather than sharing one.
 */
function buildTriggerRegex(phrase: string): RegExp {
  // `phrase` is a Zod-validated config string; escapeRegExp neutralises all special chars.
  // eslint-disable-next-line security/detect-non-literal-regexp
  return new RegExp(`(^|\\s)${escapeRegExp(phrase)}([\\s.,!?;:)]|$)`, "g");
}

/**
 * Module-level constant: built once at startup since config.triggerPhrase is immutable.
 * Avoids allocating a new RegExp object on every webhook event.
 */
const TRIGGER_REGEX = buildTriggerRegex(config.triggerPhrase);

/**
 * Check if a comment body contains the trigger phrase (@chrisleekr-bot).
 * Uses word boundary matching to avoid false positives.
 *
 * Ported from claude-code-action's checkContainsTrigger()
 */
export function containsTrigger(body: string): boolean {
  // Reset first: `TRIGGER_REGEX` is global, so a previous `.test` left
  // `lastIndex` past the start and the next call would miss an earlier match.
  TRIGGER_REGEX.lastIndex = 0;
  return TRIGGER_REGEX.test(body);
}

/**
 * Same predicate as `containsTrigger`, with the phrase supplied by the caller.
 * The classifier takes its phrase as an argument so tests need no config
 * rebuild, and both gates must agree or a mention is acknowledged then dropped.
 */
export function containsTriggerPhrase(body: string, phrase: string): boolean {
  return buildTriggerRegex(phrase).test(body);
}

/**
 * Remove every mention of the phrase, keeping the trailing boundary character
 * so surrounding punctuation survives: `Hey @bot, please review` becomes
 * `Hey, please review`. The remaining text is what the classifier reads.
 */
export function stripTriggerPhrase(body: string, phrase: string): string {
  return body.replace(buildTriggerRegex(phrase), "$2");
}
