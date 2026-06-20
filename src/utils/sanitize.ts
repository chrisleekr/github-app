/**
 * Content sanitization utilities.
 * Ported from claude-code-action's src/github/utils/sanitizer.ts
 *
 * Prevents prompt injection and token leakage by stripping:
 * - Invisible Unicode characters
 * - Hidden HTML attributes
 * - GitHub tokens
 * - Markdown alt-text injection vectors
 */

/** Strip zero-width and control characters */
export function stripInvisibleCharacters(content: string): string {
  // eslint-disable-next-line no-misleading-character-class -- Intentional: stripping individual zero-width chars
  content = content.replace(/[\u200B\u200C\u200D\uFEFF]/g, "");
  // Intentionally stripping control characters for sanitization
  // eslint-disable-next-line no-control-regex
  const controlCharRegex = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
  content = content.replace(controlCharRegex, "");
  content = content.replace(/\u00AD/g, "");
  content = content.replace(/[\u202A-\u202E\u2066-\u2069]/g, "");
  // Unicode TAG block (U+E0000 to U+E007F): invisible "tag" codepoints used by
  // recent prompt-injection variants (Cisco / Promptfoo write-ups). They
  // render zero-width but encode ASCII letters that the model can read.
  content = content.replace(/[\u{E0000}-\u{E007F}]/gu, "");
  return content;
}

/** Strip image alt text (injection vector) */
export function stripMarkdownImageAltText(content: string): string {
  return content.replace(/!\[[^\]]*\]\(/g, "![](");
}

/** Strip markdown link title attributes */
export function stripMarkdownLinkTitles(content: string): string {
  content = content.replace(/(\[[^\]]*\]\([^)]+)\s+"[^"]*"/g, "$1");
  content = content.replace(/(\[[^\]]*\]\([^)]+)\s+'[^']*'/g, "$1");
  return content;
}

/** Strip hidden HTML attributes that could carry injected content */
export function stripHiddenAttributes(content: string): string {
  content = content.replace(/\salt\s*=\s*["'][^"']*["']/gi, "");
  content = content.replace(/\salt\s*=\s*[^\s>]+/gi, "");
  content = content.replace(/\stitle\s*=\s*["'][^"']*["']/gi, "");
  content = content.replace(/\stitle\s*=\s*[^\s>]+/gi, "");
  content = content.replace(/\saria-label\s*=\s*["'][^"']*["']/gi, "");
  content = content.replace(/\saria-label\s*=\s*[^\s>]+/gi, "");
  content = content.replace(/\sdata-[a-zA-Z0-9-]+\s*=\s*["'][^"']*["']/gi, "");
  content = content.replace(/\sdata-[a-zA-Z0-9-]+\s*=\s*[^\s>]+/gi, "");
  content = content.replace(/\splaceholder\s*=\s*["'][^"']*["']/gi, "");
  content = content.replace(/\splaceholder\s*=\s*[^\s>]+/gi, "");
  return content;
}

/** Normalize HTML entities to printable ASCII */
export function normalizeHtmlEntities(content: string): string {
  content = content.replace(/&#(\d+);/g, (_match, dec: string) => {
    const num = parseInt(dec, 10);
    if (num >= 32 && num <= 126) {
      return String.fromCharCode(num);
    }
    return "";
  });
  content = content.replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => {
    const num = parseInt(hex, 16);
    if (num >= 32 && num <= 126) {
      return String.fromCharCode(num);
    }
    return "";
  });
  return content;
}

/** Strip HTML comments */
export function stripHtmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * Redact GitHub tokens to prevent leakage (input-side sanitizer).
 * Uses an inline `[REDACTED_GITHUB_TOKEN]` marker so the downstream LLM can
 * see that a credential-shaped string was scrubbed and treat the slot as data.
 * For OUTPUT-side stripping (bytes about to leave us bound for GitHub), use
 * `redactSecrets` below: that path silently deletes matches to deny an
 * attacker any probing feedback.
 */
export function redactGitHubTokens(content: string): string {
  // ghp_/gho_/ghs_/ghr_ tokens: open-ended body, no trailing \b. The legacy
  // shape was exactly 36 alphanumerics, but GitHub's stateless installation
  // token (ghs_APPID_JWT, ~520 chars with dots/underscores; staged rollout from
  // 2026-04-27) breaks any /ghs_[A-Za-z0-9]{36}/ assumption. Match the whole
  // opaque run instead so the new format is scrubbed too. Over-matching is the
  // safe direction for redaction.
  // GitHub Personal Access Tokens (classic)
  content = content.replace(/\bghp_[A-Za-z0-9._-]{36,}/g, "[REDACTED_GITHUB_TOKEN]");
  // GitHub OAuth tokens
  content = content.replace(/\bgho_[A-Za-z0-9._-]{36,}/g, "[REDACTED_GITHUB_TOKEN]");
  // GitHub installation tokens (legacy 36-char body + new ghs_APPID_JWT stateless)
  content = content.replace(/\bghs_[A-Za-z0-9._-]{36,}/g, "[REDACTED_GITHUB_TOKEN]");
  // GitHub refresh tokens
  content = content.replace(/\bghr_[A-Za-z0-9._-]{36,}/g, "[REDACTED_GITHUB_TOKEN]");
  // GitHub fine-grained personal access tokens
  content = content.replace(/\bgithub_pat_[A-Za-z0-9_]{11,221}\b/g, "[REDACTED_GITHUB_TOKEN]");
  return content;
}

/**
 * Output-side secret scanner. Silently strips matched bytes (no marker, no
 * footer, no count surfaced in the body) and returns a structured result so
 * the caller can log redaction events without ever logging the matched bytes.
 *
 * Apply to every body about to be posted to GitHub: see
 * `src/utils/github-output-guard.ts`.
 */
export interface RedactSecretsResult {
  body: string;
  matchCount: number;
  /** Distinct secret kinds detected, in match order, deduplicated. */
  kinds: string[];
}

interface SecretPattern {
  kind: string;
  re: RegExp;
}

// Patterns are applied in fixed order. Most-specific first so a value that
// would match multiple patterns is attributed to its true kind.
const SECRET_PATTERNS: SecretPattern[] = [
  // GitHub tokens, same five formats as the input-side redactor. Open-ended
  // bodies (no trailing \b) so the new ghs_APPID_JWT stateless installation
  // token (~520 chars with dots/underscores, GitHub rollout from 2026-04-27)
  // is matched, not just the legacy 36-char shape.
  { kind: "GITHUB_TOKEN", re: /\bghp_[A-Za-z0-9._-]{36,}/g },
  { kind: "GITHUB_TOKEN", re: /\bgho_[A-Za-z0-9._-]{36,}/g },
  { kind: "GITHUB_TOKEN", re: /\bghs_[A-Za-z0-9._-]{36,}/g },
  { kind: "GITHUB_TOKEN", re: /\bghr_[A-Za-z0-9._-]{36,}/g },
  { kind: "GITHUB_TOKEN", re: /\bgithub_pat_[A-Za-z0-9_]{11,221}\b/g },
  // Anthropic API keys and OAuth tokens.
  { kind: "ANTHROPIC_API_KEY", re: /\bsk-ant-api03-[A-Za-z0-9_-]{80,}\b/g },
  { kind: "ANTHROPIC_OAUTH", re: /\bsk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{80,}\b/g },
  // AWS access key IDs (long-lived + STS). The matching secret-access-key is
  // not regex-detectable (any 40-char base64) without massive false positives.
  { kind: "AWS_ACCESS_KEY_ID", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "AWS_ACCESS_KEY_ID", re: /\bASIA[0-9A-Z]{16}\b/g },
  // PEM-encoded private keys (RSA, EC, generic, OpenSSH). Multiline.
  {
    kind: "PRIVATE_KEY_PEM",
    re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
  },
  // Database / cache connection URLs with embedded credentials. Match only
  // when both user and password components are present, bare URLs are fine.
  // The trailing class consumes host + port + path + query, but stops at
  // common markdown delimiters so a URL embedded in `(…)`, `[…]`, or quotes
  // does not swallow following prose.
  {
    kind: "DB_URL_WITH_PASSWORD",
    re: /\b(?:postgres|postgresql|redis|valkey|rediss|mongodb|mongodb\+srv|mysql):\/\/[^\s:@/]+:[^\s@/]+@[^\s)\]"'`<>]+/g,
  },
  // JWT must stay BELOW the GITHUB_TOKEN patterns: a new ghs_APPID_JWT stateless
  // token embeds a JWT, and the ghs_ pattern above must claim the whole run
  // first. Reordering JWT above would strip only the JWT portion and leak the
  // ghs_APPID_ prefix bytes.
  // JSON Web Tokens. Three base64url segments separated by `.`. Each segment
  // requires ≥20 chars to keep us above the noise floor of arbitrary base64
  // chunks that happen to start with `eyJ` (the literal `{"`). Real-world
  // JWTs comfortably exceed this; truncated marketing snippets do not.
  // Operators who see an empty agent reply can attribute via the
  // `kinds: ["JWT"]` log field.
  {
    kind: "JWT",
    re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
  },
];

export function redactSecrets(content: string): RedactSecretsResult {
  let matchCount = 0;
  const kindSet = new Set<string>();
  let body = content;
  for (const { kind, re } of SECRET_PATTERNS) {
    body = body.replace(re, () => {
      matchCount++;
      kindSet.add(kind);
      return "";
    });
  }
  return { body, matchCount, kinds: [...kindSet] };
}

/**
 * True iff `candidate` can be produced from `original` by deleting zero or more
 * code units, i.e. `candidate` is a (not necessarily contiguous) subsequence of
 * `original`. O(N) two-pointer walk over UTF-16 code units.
 *
 * Used to gate the output-side LLM secret scanner (issue #198): the scanner's
 * redaction must only remove bytes the regex pass accepted, never add, reorder,
 * or alter them. A prompt-injected or hallucinating scanner returns a
 * schema-valid `redacted_body` string that this check denies whenever it is not
 * deletion-only, so attacker-controlled text cannot be substituted into a public
 * GitHub comment under the bot's identity.
 */
export function isDeletionOnly(original: string, candidate: string): boolean {
  if (candidate.length > original.length) return false;
  let i = 0;
  let j = 0;
  // Two-pointer walk over UTF-16 code units. A `while` loop (not `for`/for-of)
  // because the two indices advance independently and code-unit granularity is
  // required: for-of iterates by code point, which would mis-handle a deletion
  // adjacent to an astral character.
  while (j < candidate.length) {
    // eslint-disable-next-line security/detect-object-injection -- string index by loop counter, not user input
    while (i < original.length && original[i] !== candidate[j]) i++;
    if (i === original.length) return false;
    i++;
    j++;
  }
  return true;
}

/**
 * Full sanitization pipeline.
 * Apply to all user-provided content before including in prompts.
 */
export function sanitizeContent(content: string): string {
  content = stripHtmlComments(content);
  content = stripInvisibleCharacters(content);
  content = stripMarkdownImageAltText(content);
  content = stripMarkdownLinkTitles(content);
  content = stripHiddenAttributes(content);
  content = normalizeHtmlEntities(content);
  content = redactGitHubTokens(content);
  return content;
}

/**
 * Repo-memory write-side sanitizer.
 *
 * Memory rows persist across sessions and are re-injected as data on every
 * future run, so the standard prompt sanitizer alone is not enough: an
 * embedded LF/CR can break out of the per-line `[id:UUID] [category] content`
 * shape rendered by `prompt-builder.ts`, and a NUL byte can desync downstream
 * Postgres/JSON readers. Replace line terminators with a single space and
 * drop NUL bytes; the standard pipeline handles HTML comments, invisibles,
 * and known-format token redaction.
 */
export function sanitizeRepoMemoryContent(content: string): string {
  let body = sanitizeContent(content);
  body = body.replace(/[\r\n\u2028\u2029]+/g, " ");
  body = body.replace(/\0/g, "");
  return body.trim();
}
