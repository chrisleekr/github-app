#!/usr/bin/env bun
/**
 * Direct probe for CLAUDE_CODE_OAUTH_TOKEN against the Anthropic API.
 *
 * Why this exists: when the local dev server's chat-thread executor logs
 * a 429 from Anthropic, you can't tell from the log alone whether (a) the
 * token is invalid, (b) the whole subscription is throttled, or (c) only
 * specific model tiers are throttled. This script answers that by hitting
 * three model tiers from the same OAuth token in one pass and printing
 * the raw status / error type per call.
 *
 * Usage: bun run scripts/test-oauth.ts
 *
 * Reads CLAUDE_CODE_OAUTH_TOKEN from environment. The .env at repo root
 * is intentionally NOT auto-loaded: export the var before running, or
 * pipe it through `env $(grep CLAUDE_CODE_OAUTH_TOKEN .env) bun run ...`
 * so multi-line PEM keys in .env don't break shell sourcing.
 */

import Anthropic from "@anthropic-ai/sdk";

const token = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
if (token === undefined || token.trim().length === 0) {
  console.error("CLAUDE_CODE_OAUTH_TOKEN not set in environment");
  process.exit(1);
}

console.log(`token prefix: ${token.slice(0, 12)}…  length: ${String(token.length)}`);

const client = new Anthropic({ authToken: token });

const MODELS: readonly { label: string; id: string }[] = [
  { label: "sonnet-4-6 (alias)", id: "claude-sonnet-4-6" },
  { label: "opus-5 (default)", id: "claude-opus-5" },
  { label: "haiku-4-5 (snapshot)", id: "claude-haiku-4-5-20251001" },
];

for (const m of MODELS) {
  process.stdout.write(`\n[${m.label}] model=${m.id} … `);
  try {
    const res = await client.messages.create({
      model: m.id,
      // <-- gates the correct rate-limit pool; otherwise, it will throw 429
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
    });
    const text = res.content
      .filter((c) => c.type === "text")
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("");
    console.log(
      `✓ ${res.model} → "${text.trim()}" (in=${String(res.usage.input_tokens)}, out=${String(res.usage.output_tokens)})`,
    );
  } catch (err) {
    const status =
      err !== null && typeof err === "object" && "status" in err
        ? (err as { status: unknown }).status
        : "?";
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`✗ status=${String(status)} → ${msg}`);
  }
}
