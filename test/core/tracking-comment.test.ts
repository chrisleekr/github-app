import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";

import {
  createTrackingComment,
  deliveryMarker,
  finalizeTrackingComment,
  renderDispatchReasonLine,
  renderTriageSection,
  type TriageCommentSection,
  updateTrackingComment,
} from "../../src/core/tracking-comment";
import { DISPATCH_REASONS } from "../../src/shared/dispatch-types";
import { makeBotContext } from "../factories";

const DELIVERY_ID = "del-abc-123";

// ─── deliveryMarker ───────────────────────────────────────────────────────────

describe("deliveryMarker", () => {
  it("returns an HTML comment with the delivery ID", () => {
    expect(deliveryMarker("abc-123")).toBe("<!-- delivery:abc-123 -->");
  });
});

// ─── createTrackingComment ────────────────────────────────────────────────────

describe("createTrackingComment", () => {
  it("creates a comment containing the delivery marker and returns the comment ID", async () => {
    const ctx = makeBotContext({ deliveryId: DELIVERY_ID });
    let capturedBody = "";
    ctx.octokit = {
      rest: {
        issues: {
          createComment: mock(({ body }: { body: string }) => {
            capturedBody = body;
            return Promise.resolve({ data: { id: 999 } });
          }),
        },
      },
    } as unknown as Octokit;

    const id = await createTrackingComment(ctx);

    expect(id).toBe(999);
    expect(capturedBody).toContain("<!-- delivery:del-abc-123 -->");
    expect(capturedBody).toContain("@chrisleekr-bot");
  });

  /** Capture the body `createTrackingComment` posts for `configWarning`. */
  async function bodyFor(configWarning?: string): Promise<string> {
    const ctx = makeBotContext({ deliveryId: DELIVERY_ID });
    let capturedBody = "";
    ctx.octokit = {
      rest: {
        issues: {
          createComment: mock(({ body }: { body: string }) => {
            capturedBody = body;
            return Promise.resolve({ data: { id: 999 } });
          }),
        },
      },
    } as unknown as Octokit;

    await createTrackingComment(ctx, configWarning);
    return capturedBody;
  }

  it("renders the invalid-config notice as a GitHub warning alert", async () => {
    // A silently ignored config file looks identical to one that took effect,
    // so the notice has to ride the first thing the user reads.
    const body = await bodyFor("`.github-app.yaml` failed validation and was ignored");

    expect(body).toContain("> [!WARNING]");
    expect(body).toContain("failed validation");
    // Still a notice, not an error: the run proceeds on built-in defaults.
    expect(body).toContain("is working on this...");
  });

  it("collapses newlines so the blockquote stays a single line", async () => {
    const body = await bodyFor("first line\nsecond line");

    expect(body).toContain("> first line second line");
    // A bare `\n` inside the quote would orphan everything after it.
    expect(body).not.toContain("> first line\nsecond line");
  });

  it("collapses a lone carriage return so the blockquote stays a single line", async () => {
    const body = await bodyFor("first line\rsecond line");

    // GitHub treats a bare `\r` as a line break too, so `\n`-only collapsing
    // would orphan the tail outside the `> ` quote.
    expect(body).toContain("> first line second line");
  });

  it("renders no alert block for a whitespace-only warning", async () => {
    expect(await bodyFor("   ")).not.toContain("[!WARNING]");
  });

  it("renders no alert block when no warning is supplied", async () => {
    expect(await bodyFor()).not.toContain("[!WARNING]");
  });
});

// ─── updateTrackingComment ────────────────────────────────────────────────────

describe("updateTrackingComment", () => {
  it("calls updateComment with the provided body", async () => {
    const ctx = makeBotContext({ deliveryId: DELIVERY_ID });
    let capturedArgs: Record<string, unknown> = {};
    ctx.octokit = {
      rest: {
        issues: {
          updateComment: mock((args: Record<string, unknown>) => {
            capturedArgs = args;
            return Promise.resolve({ data: { id: 1 } });
          }),
        },
      },
    } as unknown as Octokit;

    await updateTrackingComment(ctx, 1, "new body");

    expect(capturedArgs["owner"]).toBe("myorg");
    expect(capturedArgs["repo"]).toBe("myrepo");
    expect(capturedArgs["comment_id"]).toBe(1);
    expect(capturedArgs["body"]).toBe("new body");
  });
});

// ─── finalizeTrackingComment ──────────────────────────────────────────────────

describe("finalizeTrackingComment", () => {
  let capturedUpdateBody = "";
  let ctx = makeBotContext({ deliveryId: DELIVERY_ID });

  beforeEach(() => {
    capturedUpdateBody = "";
    ctx = makeBotContext({ deliveryId: DELIVERY_ID });
    ctx.octokit = {
      rest: {
        issues: {
          getComment: mock(() =>
            Promise.resolve({
              data: { body: "<!-- delivery:del-abc-123 -->\n**Working...**" },
            }),
          ),
          updateComment: mock(({ body }: { body: string }) => {
            capturedUpdateBody = body;
            return Promise.resolve({ data: { id: 1 } });
          }),
        },
      },
    } as unknown as Octokit;
  });

  it("success path: final body contains the success header with duration and cost", async () => {
    await finalizeTrackingComment(ctx, 1, {
      success: true,
      durationMs: 5000,
      costUsd: 0.0123,
    });

    expect(capturedUpdateBody).toContain("finished");
    expect(capturedUpdateBody).toContain("5.0s");
    expect(capturedUpdateBody).toContain("$0.0123");
  });

  it("success path: re-prepends the delivery marker", async () => {
    await finalizeTrackingComment(ctx, 1, { success: true });

    expect(capturedUpdateBody.startsWith("<!-- delivery:del-abc-123 -->")).toBe(true);
  });

  it("error path: final body contains the error section", async () => {
    await finalizeTrackingComment(ctx, 1, {
      success: false,
      error: "An internal error occurred. Check server logs for details.",
    });

    expect(capturedUpdateBody).toContain("encountered an error");
    expect(capturedUpdateBody).toContain(
      "An internal error occurred. Check server logs for details.",
    );
  });

  it("error path: re-prepends the delivery marker", async () => {
    await finalizeTrackingComment(ctx, 1, { success: false });

    expect(capturedUpdateBody.startsWith("<!-- delivery:del-abc-123 -->")).toBe(true);
  });

  it("re-appends the config warning the agent's comment rewrite erased", async () => {
    // `update_claude_comment` replaces the whole body, so the banner
    // `createTrackingComment` posted is gone by the time we finalize.
    await finalizeTrackingComment(ctx, 1, {
      success: true,
      configWarning: "`.github-app.yaml` failed validation and was ignored.",
    });

    expect(capturedUpdateBody).toContain("> [!WARNING]");
    expect(capturedUpdateBody).toContain("failed validation");
  });

  it("does not repeat the warning when the create-time banner survived", async () => {
    const warning = "`.github-app.yaml` failed validation and was ignored.";
    ctx.octokit = {
      rest: {
        issues: {
          getComment: mock(() =>
            Promise.resolve({
              data: {
                body: `<!-- delivery:del-abc-123 -->\n**Working...**\n\n> [!WARNING]\n> ${warning}`,
              },
            }),
          ),
          updateComment: mock(({ body }: { body: string }) => {
            capturedUpdateBody = body;
            return Promise.resolve({ data: { id: 1 } });
          }),
        },
      },
    } as unknown as Octokit;

    await finalizeTrackingComment(ctx, 1, { success: true, configWarning: warning });

    expect(capturedUpdateBody.split("[!WARNING]")).toHaveLength(2);
  });

  it("writes no warning block when the run carried no config warning", async () => {
    await finalizeTrackingComment(ctx, 1, { success: true });

    expect(capturedUpdateBody).not.toContain("[!WARNING]");
  });

  it("falls back gracefully when getComment throws, still calls updateComment", async () => {
    let updateCalled = false;
    ctx.octokit = {
      rest: {
        issues: {
          getComment: mock(() => Promise.reject(new Error("network error"))),
          updateComment: mock(() => {
            updateCalled = true;
            return Promise.resolve({ data: { id: 1 } });
          }),
        },
      },
    } as unknown as Octokit;

    await finalizeTrackingComment(ctx, 1, { success: true });

    expect(updateCalled).toBe(true);
  });
});

describe("renderDispatchReasonLine", () => {
  it("produces a non-empty one-sentence string for every DispatchReason value", () => {
    const seen = new Set<string>();
    for (const reason of DISPATCH_REASONS) {
      const line = renderDispatchReasonLine(reason, "daemon");
      expect(line).toBeString();
      expect(line.length).toBeGreaterThan(0);
      expect(line.length).toBeLessThanOrEqual(200);
      expect(line).not.toContain("\n");
      expect(seen.has(line)).toBe(false);
      seen.add(line);
    }
    expect(seen.size).toBe(DISPATCH_REASONS.length);
  });

  it("includes the target name verbatim in every output", () => {
    for (const reason of DISPATCH_REASONS) {
      const line = renderDispatchReasonLine(reason, "daemon");
      expect(line).toContain("daemon");
    }
  });

  it("uses distinguishable vocabulary for each reason", () => {
    expect(renderDispatchReasonLine("persistent-daemon", "daemon")).toMatch(/persistent/i);
    expect(renderDispatchReasonLine("ephemeral-daemon-triage", "daemon")).toMatch(/triage/i);
    expect(renderDispatchReasonLine("ephemeral-daemon-triage", "daemon")).toMatch(/heavy/i);
    expect(renderDispatchReasonLine("ephemeral-daemon-overflow", "daemon")).toMatch(/capacity/i);
    expect(renderDispatchReasonLine("ephemeral-spawn-failed", "daemon")).toMatch(
      /Kubernetes|infrastructure|unavailable/i,
    );
    expect(renderDispatchReasonLine("workflow-runner", "workflow-runner")).toMatch(/isolated/i);
  });

  it("spawn-failed reason does not use 'Routed' (nothing was routed)", () => {
    expect(renderDispatchReasonLine("ephemeral-spawn-failed", "daemon")).not.toMatch(/^Routed/);
  });
});

describe("renderTriageSection", () => {
  const base: TriageCommentSection = {
    heavy: false,
    confidence: 0.87,
    rationale: "Adds one endpoint and a unit test; standard tooling suffices.",
    provider: "anthropic",
    model: "claude-3-5-haiku-20241022",
    costUsd: 0.0008,
    latencyMs: 412,
  };

  it("produces a GitHub-renderable <details> collapsible block", () => {
    const out = renderTriageSection(base);
    expect(out).toContain("<details>");
    expect(out).toContain("</details>");
    expect(out).toContain("<summary>");
  });

  it("surfaces the binary heavy classification and confidence in the summary", () => {
    expect(renderTriageSection(base)).toContain("not heavy");
    expect(renderTriageSection(base)).toContain("87%");
    expect(renderTriageSection({ ...base, heavy: true })).toContain("heavy");
  });

  it("renders the rationale verbatim when it contains no HTML-special characters", () => {
    expect(renderTriageSection(base)).toContain(base.rationale);
  });

  it("HTML-escapes rationale to prevent <details> break-out", () => {
    const hostile = renderTriageSection({
      ...base,
      rationale: "close </details><script>alert(1)</script> tag",
    });
    expect(hostile).not.toContain("</details><script>");
    expect(hostile).toContain("&lt;/details&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(hostile.endsWith("</details>")).toBe(true);
  });

  it("escapes &, <, and > in rationale", () => {
    const out = renderTriageSection({ ...base, rationale: "a & b < c > d" });
    expect(out).toContain("a &amp; b &lt; c &gt; d");
    expect(out).not.toContain("a & b < c > d");
  });

  it("formats cost below US$0.001 as '<US$0.001'", () => {
    expect(renderTriageSection({ ...base, costUsd: 0.0004 })).toContain("<US$0.001");
  });

  it("formats cost ≥ US$0.001 with 4 decimals", () => {
    expect(renderTriageSection({ ...base, costUsd: 0.0032 })).toContain("US$0.0032");
  });

  it("renders provider and model in backticks", () => {
    const out = renderTriageSection(base);
    expect(out).toContain("`anthropic`");
    expect(out).toContain("`claude-3-5-haiku-20241022`");
  });

  it("leaves a blank line after summary (GitHub Markdown-in-HTML requirement)", () => {
    const lines = renderTriageSection(base).split("\n");
    const summaryIdx = lines.findIndex((l) => l.startsWith("<summary>"));
    expect(lines[summaryIdx + 1]).toBe("");
  });
});
