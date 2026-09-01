/**
 * PR-side `.github-app.yaml` validation comment (issue #3, deliverable 1).
 *
 * `pr-check.ts` reads the HEAD-ref copy of the config purely to tell the
 * author whether it parses, and never applies it. That split is what these
 * tests pin down:
 *
 *   - C1: a valid head-ref copy upserts exactly one marker-keyed comment that
 *     says only the default-branch copy is ever applied.
 *   - C2: an invalid copy updates that SAME comment in place, capped at 10
 *     rendered issues.
 *   - C3: a PR that does not touch the config file performs no GitHub write.
 *   - C4: the head-ref read must not touch `fetcher.ts`'s `etagCache` /
 *     `absentCache` and must never call `loadRepoPolicy`, so an attacker-chosen
 *     commit can never leak into the applied policy.
 *   - C5: a file over 64 KB is reported as too large without rendering a byte
 *     of its contents.
 *   - C6: every attacker-derived substring goes through `sanitizeContent` +
 *     `redactSecrets` and is rendered as a literal code span (so no zod message
 *     can inject a live hyperlink) while the trailing marker survives verbatim.
 *
 * The silent-exit paths are covered too, because each one is a decision to say
 * nothing rather than post a wrong verdict: head-ref 404, non-404 read failure,
 * a path that is not a file, and a blob with no content.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";
import type { Logger } from "pino";

import { __resetRepoConfigCaches, fetchRepoConfig } from "../../src/repo-config/fetcher";
import { renderConfigCheckBody, runPrConfigCheck } from "../../src/repo-config/pr-check";
import { githubAppConfigSchema } from "../../src/repo-config/schema";

const log = {
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  error: () => undefined,
} as unknown as Logger;

const PATH = ".github-app.yaml";
const OWNER = "acme";
const REPO = "widgets";
const PR_NUMBER = 7;
const HEAD_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

/** The sticky-comment key `runPrConfigCheck` must embed verbatim. */
const MARKER = `<!-- bot:config-check:${String(PR_NUMBER)} -->`;

const VALID_YAML = "version: 1\nenabled: true\n";
// Fails `githubAppConfigSchema`: `allowed_users` entries must be GitHub logins.
const INVALID_YAML = "version: 1\ntriggers:\n  allowed_users:\n    - 'not a login'\n";

function b64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

interface FileStub {
  readonly yaml: string;
  readonly size?: number;
  readonly etag?: string;
}

interface OctokitHarness {
  readonly octokit: Octokit;
  readonly listFiles: ReturnType<typeof mock>;
  readonly getContent: ReturnType<typeof mock>;
  readonly listComments: ReturnType<typeof mock>;
  readonly createComment: ReturnType<typeof mock>;
  readonly updateComment: ReturnType<typeof mock>;
}

/**
 * Minimal Octokit double covering both the direct-REST and `paginate`
 * calling styles, so the assertions bind to the underlying endpoint mocks
 * rather than to whichever style the implementation picks.
 */
function makeOctokit(opts: {
  files?: { filename: string }[];
  file?: FileStub;
  comments?: { id: number; body: string }[];
  /** HTTP status `repos.getContent` should reject with (Octokit's error shape). */
  getContentStatus?: number;
  /** Replaces the resolved `data` wholesale: directory listings, contentless blobs. */
  getContentData?: unknown;
}): OctokitHarness {
  const files = opts.files ?? [{ filename: PATH }];
  const file = opts.file ?? { yaml: VALID_YAML };
  const comments = opts.comments ?? [];

  const listFiles = mock(() => Promise.resolve({ data: files }));
  const getContent = mock(() => {
    if (opts.getContentStatus !== undefined) {
      return Promise.reject(
        Object.assign(new Error("getContent failed"), { status: opts.getContentStatus }),
      );
    }
    if (opts.getContentData !== undefined) {
      return Promise.resolve({ data: opts.getContentData, headers: {} });
    }
    return Promise.resolve({
      data: {
        type: "file",
        path: PATH,
        size: file.size ?? Buffer.byteLength(file.yaml, "utf-8"),
        encoding: "base64",
        content: b64(file.yaml),
        sha: "filesha",
      },
      headers: file.etag !== undefined ? { etag: file.etag } : {},
    });
  });
  const listComments = mock(() => Promise.resolve({ data: comments }));
  const createComment = mock(() => Promise.resolve({ data: { id: 9001 } }));
  const updateComment = mock(() => Promise.resolve({ data: { id: 9002 } }));

  type Endpoint = (args: unknown) => Promise<{ data: unknown }>;
  const paginate = Object.assign(
    async (endpoint: Endpoint, params: unknown): Promise<unknown> => (await endpoint(params)).data,
    {
      iterator: (endpoint: Endpoint, params: unknown) => ({
        async *[Symbol.asyncIterator]() {
          yield await endpoint(params);
        },
      }),
    },
  );

  const octokit = {
    rest: {
      pulls: { listFiles },
      repos: { getContent },
      issues: { listComments, createComment, updateComment },
    },
    paginate,
  } as unknown as Octokit;

  return { octokit, listFiles, getContent, listComments, createComment, updateComment };
}

function runCheck(h: OctokitHarness): Promise<unknown> {
  return runPrConfigCheck({
    octokit: h.octokit,
    owner: OWNER,
    repo: REPO,
    prNumber: PR_NUMBER,
    headSha: HEAD_SHA,
    deliveryId: "delivery-1",
    log,
  }) as Promise<unknown>;
}

/** Body argument of the first call to a comment-write mock. */
function bodyOf(m: ReturnType<typeof mock>): string {
  const call = m.mock.calls[0] as unknown as [{ body: string }] | undefined;
  return call?.[0].body ?? "";
}

/** Real zod issues, normalised to the renderer's `{path, message}` shape. */
function issuesFor(doc: unknown): { path: string; message: string }[] {
  const parsed = githubAppConfigSchema.safeParse(doc);
  if (parsed.success) throw new Error("fixture was expected to fail validation");
  return parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

describe("runPrConfigCheck", () => {
  beforeEach(() => {
    __resetRepoConfigCaches();
  });

  it("C1: posts exactly one marker comment saying the change only applies on merge", async () => {
    const h = makeOctokit({ file: { yaml: VALID_YAML } });
    await runCheck(h);

    expect(h.createComment).toHaveBeenCalledTimes(1);
    expect(h.updateComment).not.toHaveBeenCalled();

    const body = bodyOf(h.createComment);
    expect(body).toContain(MARKER);
    expect(body).toMatch(/only the default-branch copy/i);
    expect(body).toMatch(/takes effect on merge/i);

    // The head-ref read is explicitly pinned to the PR's own commit.
    const getArgs = h.getContent.mock.calls[0] as unknown as [{ ref?: string; path?: string }];
    expect(getArgs[0].ref).toBe(HEAD_SHA);
  });

  it("C2: updates the existing marker comment in place instead of adding a second one", async () => {
    const h = makeOctokit({
      file: { yaml: INVALID_YAML },
      comments: [{ id: 4242, body: `stale verdict\n\n${MARKER}` }],
    });
    await runCheck(h);

    expect(h.updateComment).toHaveBeenCalledTimes(1);
    expect(h.createComment).not.toHaveBeenCalled();

    const call = h.updateComment.mock.calls[0] as unknown as [{ comment_id: number; body: string }];
    expect(call[0].comment_id).toBe(4242);
    expect(call[0].body).toContain(MARKER);
  });

  it("C3: performs no GitHub write when the PR does not touch the config file", async () => {
    const h = makeOctokit({ files: [{ filename: "src/app.ts" }, { filename: "README.md" }] });
    await runCheck(h);

    expect(h.createComment).not.toHaveBeenCalled();
    expect(h.updateComment).not.toHaveBeenCalled();
    // The head-ref read is skipped too: no changed config file, nothing to read.
    expect(h.getContent).not.toHaveBeenCalled();
  });

  it("C4: never imports the applied-policy path (fetchRepoConfig / loadRepoPolicy)", () => {
    // Structural guarantee, not a convention: a head-ref read that could reach
    // `fetchRepoConfig` would put an attacker-chosen commit one flag-flip away
    // from the policy the bot actually applies.
    const source = readFileSync(
      join(import.meta.dir, "../../src/repo-config/pr-check.ts"),
      "utf-8",
    );
    expect(source).not.toContain("fetchRepoConfig");
    expect(source).not.toContain("loadRepoPolicy");
  });

  it("C4: leaves the fetcher's ETag cache untouched, so the next real fetch is unconditional", async () => {
    const h = makeOctokit({ file: { yaml: VALID_YAML, etag: 'W/"headtag"' } });
    await runCheck(h);
    expect(h.getContent).toHaveBeenCalledTimes(1);

    const result = await fetchRepoConfig({
      octokit: h.octokit,
      owner: OWNER,
      repo: REPO,
      path: PATH,
      log,
    });
    expect(result.kind).toBe("ok");
    expect(h.getContent).toHaveBeenCalledTimes(2);

    // If the PR check had populated `etagCache`, this second read would carry
    // the head-ref ETag and could be served a 304 for a commit that was never
    // on the default branch.
    const second = (
      h.getContent.mock.calls[1] as unknown as [{ ref?: string; headers?: Record<string, string> }]
    )[0];
    expect(second).not.toHaveProperty("ref");
    expect(second.headers?.["if-none-match"]).toBeUndefined();
  });

  it("C5: reports an oversize file without rendering any of its bytes", async () => {
    const sentinel = "zzsentinelzz";
    const h = makeOctokit({
      file: { yaml: `version: 1\nnote: ${sentinel}\n`, size: 70_000 },
    });
    await runCheck(h);

    expect(h.createComment).toHaveBeenCalledTimes(1);
    const body = bodyOf(h.createComment);
    expect(body).toMatch(/too large to validate/i);
    expect(body).not.toContain(sentinel);
  });

  it("posts nothing when the head ref has no such blob (404)", async () => {
    // A pull request that DELETES the config file still lists it in the diff.
    // Rendering "not valid" for a deletion would be a lie.
    const h = makeOctokit({ getContentStatus: 404 });
    await runCheck(h);

    expect(h.getContent).toHaveBeenCalledTimes(1);
    expect(h.createComment).not.toHaveBeenCalled();
    expect(h.updateComment).not.toHaveBeenCalled();
  });

  it("posts nothing when the head-ref read fails for a non-404 reason", async () => {
    const h = makeOctokit({ getContentStatus: 500 });
    await runCheck(h);

    expect(h.createComment).not.toHaveBeenCalled();
    expect(h.updateComment).not.toHaveBeenCalled();
  });

  it("posts nothing when the config path resolves to a directory", async () => {
    const h = makeOctokit({ getContentData: [{ type: "file", name: "nested.yaml" }] });
    await runCheck(h);

    expect(h.createComment).not.toHaveBeenCalled();
    expect(h.updateComment).not.toHaveBeenCalled();
  });

  it("posts nothing when the blob carries no decodable content", async () => {
    const h = makeOctokit({ getContentData: { type: "file", path: PATH, size: 12, sha: "s" } });
    await runCheck(h);

    expect(h.createComment).not.toHaveBeenCalled();
    expect(h.updateComment).not.toHaveBeenCalled();
  });

  it("renders a YAML parse failure against the `(root)` path", async () => {
    const h = makeOctokit({ file: { yaml: "version: 1\n  bad: [unclosed\n" } });
    await runCheck(h);

    expect(h.createComment).toHaveBeenCalledTimes(1);
    const body = bodyOf(h.createComment);
    expect(body).toMatch(/is not valid/);
    // A parse failure has no zod path, so the renderer's empty-path fallback
    // is what keeps the list item well-formed.
    expect(body).toContain("- `(root)`:");
  });
});

describe("renderConfigCheckBody", () => {
  it("C2: caps the rendered issue list at ten and reports the remainder", () => {
    const issues = issuesFor({
      version: 1,
      triggers: { allowed_users: Array.from({ length: 25 }, () => "a".repeat(40)) },
    });
    expect(issues).toHaveLength(25);

    const body = renderConfigCheckBody({
      prNumber: PR_NUMBER,
      path: PATH,
      outcome: { kind: "invalid", issues },
    });

    const rendered = body.split("\n").filter((line) => line.startsWith("- "));
    expect(rendered).toHaveLength(10);
    expect(body).toMatch(/15 more/);
    expect(body).toContain(MARKER);
  });

  it("C6: sanitizes issue text while keeping the trailing marker verbatim", () => {
    // A zod `message` echoes the offending value, so it is attacker-controlled.
    // An unescaped HTML comment would let it forge or swallow the marker; a
    // lone CR would terminate the surrounding Markdown list item.
    const body = renderConfigCheckBody({
      prNumber: PR_NUMBER,
      path: PATH,
      outcome: {
        kind: "invalid",
        issues: [
          { path: "triggers.allowed_users.0", message: "bad <!--x--> value\u200B split\rline" },
          { path: "workflows.<!--y-->review", message: "unrecognized key" },
        ],
      },
    });

    expect(body).not.toContain("<!--x-->");
    expect(body).not.toContain("<!--y-->");
    expect(body).not.toContain("\u200B");
    expect(body).not.toContain("\r");
    // Sanitisation runs per-substring and the marker is concatenated last, so
    // `stripHtmlComments` cannot eat it.
    expect(body).toContain(MARKER);
  });

  it("C6: scrubs a credential before the length cap can bisect it", () => {
    // `sanitizeContent` only knows the five GitHub token shapes. A DB URL with
    // an embedded password is caught by `redactSecrets` alone, and if the cap
    // ran first it would leave a prefix too short for any pattern to match,
    // which the downstream `safePostToGitHub` scrub then walks straight past.
    const secret = "postgres://svc:SuperSecretPassword@db.internal:5432/app";
    const body = renderConfigCheckBody({
      prNumber: PR_NUMBER,
      path: PATH,
      outcome: {
        kind: "invalid",
        issues: [{ path: "", message: `Unrecognized key: "${"k".repeat(100)} ${secret}"` }],
      },
    });

    expect(body).not.toContain("SuperSecretPassword");
    expect(body).not.toContain("postgres://svc");
  });

  it("C6: scrubs a PEM whose boundary was broken with a newline", () => {
    // The PEM entry is the only `redactSecrets` pattern carrying literal
    // spaces (RFC 7468 §2), so `-----BEGIN\nPRIVATE KEY-----` evades it. If the
    // whitespace collapse ran after the scrub it would re-form the boundary
    // with no second pass, and the cap would then strip the `END` line that
    // the downstream `safePostToGitHub` scrub needs in order to match.
    const material = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj".repeat(2);
    const body = renderConfigCheckBody({
      prNumber: PR_NUMBER,
      path: PATH,
      outcome: {
        kind: "invalid",
        issues: [
          {
            path: "",
            message: `Unrecognized key: "-----BEGIN\nPRIVATE KEY-----\n${material}\n-----END PRIVATE KEY-----"`,
          },
        ],
      },
    });

    expect(body).not.toContain("MIIEvQIBADAN");
    expect(body).not.toContain("PRIVATE KEY");
  });

  it("C6: renders an attacker's Markdown link as literal text, not a live hyperlink", () => {
    // `z.strictObject` echoes unknown keys verbatim, so a crafted key becomes a
    // clickable phishing link published under the bot's identity.
    const body = renderConfigCheckBody({
      prNumber: PR_NUMBER,
      path: PATH,
      outcome: {
        kind: "invalid",
        issues: [
          { path: "workflows", message: 'Unrecognized key: "[CLICK HERE](https://evil.example)"' },
          // A stray backtick would otherwise pair with the next line's opening
          // backtick and corrupt the list (CommonMark 0.31.2 §6.1).
          { path: "defaults", message: "unbalanced ` backtick" },
        ],
      },
    });

    const lines = body.split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      // Every untrusted substring sits inside a single-backtick code span, and
      // no untrusted backtick survives to close one early.
      expect(line).toMatch(/^- `[^`]*`: `[^`]*`$/);
    }
    // Outside the code spans there is no link syntax left at all, so nothing
    // an attacker wrote is rendered as Markdown.
    const outsideCodeSpans = body.replace(/`[^`]*`/g, "");
    expect(outsideCodeSpans).not.toContain("evil.example");
    expect(outsideCodeSpans).not.toContain("](");
  });

  it("caps one rendered issue line and marks the truncation", () => {
    const body = renderConfigCheckBody({
      prNumber: PR_NUMBER,
      path: PATH,
      outcome: { kind: "invalid", issues: [{ path: "defaults", message: "z".repeat(500) }] },
    });

    const line = body.split("\n").find((l) => l.startsWith("- ")) ?? "";
    expect(line).toContain("…`");
    // 120-char cap + the ellipsis, inside a code span.
    expect(line).toContain(`\`${"z".repeat(120)}…\``);
    expect(line).not.toContain("z".repeat(121));
  });
});
