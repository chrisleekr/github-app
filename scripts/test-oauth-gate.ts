#!/usr/bin/env bun
/**
 * Probe the precise rule of Anthropic's Claude Code OAuth gate.
 *
 * Hypothesis being tested: does the gate accept the identifier as a PREFIX
 * (production code path), or only as the EXACT-AND-ONLY system prompt
 * (matching what the `claude` CLI itself sends)?
 */

import Anthropic from "@anthropic-ai/sdk";

const token = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
if (token === undefined || token.trim().length === 0) {
  console.error("CLAUDE_CODE_OAUTH_TOKEN not set");
  process.exit(1);
}

const client = new Anthropic({ authToken: token });
const ID = "You are Claude Code, Anthropic's official CLI for Claude.";

const CASES: { label: string; system: string }[] = [
  { label: "A. identifier ONLY (matches working test)", system: ID },
  {
    label: "B. identifier + \\n\\n + extra text (matches production)",
    system: `${ID}\n\nYou are a classifier. Reply with: OK`,
  },
  {
    label: "C. identifier + \\n + extra text",
    system: `${ID}\nYou are a classifier. Reply with: OK`,
  },
  {
    label: "D. identifier + space + extra text",
    system: `${ID} You are a classifier. Reply with: OK`,
  },
  { label: "E. extra text BEFORE identifier", system: `You are a classifier. ${ID}` },
  { label: "F. NO identifier (control)", system: "You are a classifier. Reply with: OK" },
];

// Extra cases for array-of-blocks system form + user-turn-prefix workaround.
const ARRAY_CASES: { label: string; req: Anthropic.MessageCreateParamsNonStreaming }[] = [
  {
    label: "G. system as ARRAY: [identifier, callerSystem]",
    req: {
      model: "claude-sonnet-5-5",
      system: [
        { type: "text", text: ID },
        { type: "text", text: "You are a classifier. Reply with: OK" },
      ],
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply OK" }],
    },
  },
  {
    label: "H. system=identifier ALONE; caller's system instructions moved into user turn",
    req: {
      model: "claude-sonnet-5-5",
      system: ID,
      max_tokens: 16,
      messages: [
        {
          role: "user",
          content: "<instructions>You are a classifier. Reply with: OK</instructions>\n\nReply OK",
        },
      ],
    },
  },
];

for (const c of CASES) {
  process.stdout.write(
    `\n${c.label}\n  system="${c.system.slice(0, 80)}${c.system.length > 80 ? "…" : ""}"\n  → `,
  );
  try {
    const res = await client.messages.create({
      model: "claude-sonnet-5-5",
      system: c.system,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply OK" }],
    });
    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    console.log(`✓ 200 → "${text.trim()}"`);
  } catch (err) {
    const status =
      err !== null && typeof err === "object" && "status" in err
        ? (err as { status: unknown }).status
        : "?";
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`✗ status=${String(status)} → ${msg.slice(0, 150)}`);
  }
}

for (const c of ARRAY_CASES) {
  process.stdout.write(`\n${c.label}\n  → `);
  try {
    const res = await client.messages.create(c.req);
    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    console.log(`✓ 200 → "${text.trim()}"`);
  } catch (err) {
    const status =
      err !== null && typeof err === "object" && "status" in err
        ? (err as { status: unknown }).status
        : "?";
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`✗ status=${String(status)} → ${msg.slice(0, 150)}`);
  }
}
