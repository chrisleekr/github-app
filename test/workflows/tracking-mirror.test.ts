import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";
import pino from "pino";

import type { WorkflowRunRow } from "../../src/workflows/runs-store";
import { expectToReject } from "../utils/assertions";

// Mock the runs-store DB layer so the tracking-mirror exercises pure logic
// without touching Postgres. Each test seeds the mocks by mutating the
// module-scoped `mockRow` / `mockReservation` locals before calling
// `setState`; the mock factories below close over those bindings and
// re-read them on every call.
let mockRow: WorkflowRunRow | null = null;
let mockReservation: { won: boolean; trackingCommentId: number } = {
  won: true,
  trackingCommentId: 0,
};
let mockPriorComments: { runId: string; trackingCommentId: number }[] = [];
const mergeStateMock = mock(() => Promise.resolve());
const findByIdMock = mock(() => Promise.resolve(mockRow));
const tryReserveMock = mock(() => Promise.resolve(mockReservation));
const listChildrenByParentMock = mock(() => Promise.resolve([] as readonly WorkflowRunRow[]));
const findPriorTrackingCommentsMock = mock(() => Promise.resolve(mockPriorComments));
const clearTrackingCommentIdMock = mock(() => Promise.resolve());
const clearTrackingCommentIdForAttemptMock = mock(() => Promise.resolve());
const assertCurrentWorkflowAttemptMock = mock(() => Promise.resolve());
const mergeAttemptStateMock = mock(() => {
  if (mockRow === null) return Promise.reject(new Error("run missing"));
  return Promise.resolve(mockRow);
});
class StaleWorkflowAttemptError extends Error {}

void mock.module("../../src/workflows/runs-store", () => ({
  assertCurrentWorkflowAttempt: assertCurrentWorkflowAttemptMock,
  clearTrackingCommentId: clearTrackingCommentIdMock,
  clearTrackingCommentIdForAttempt: clearTrackingCommentIdForAttemptMock,
  findById: findByIdMock,
  findPriorTrackingComments: findPriorTrackingCommentsMock,
  listChildrenByParent: listChildrenByParentMock,
  mergeState: mergeStateMock,
  mergeAttemptState: mergeAttemptStateMock,
  StaleWorkflowAttemptError,
  tryReserveTrackingCommentId: tryReserveMock,
}));

// Import AFTER mock.module so the module-under-test binds to mocks.
const { CONFIG_NOTICE_KEY, renderCommentBody, setState } =
  await import("../../src/workflows/tracking-mirror");

const RUN_ID = "11111111-1111-1111-1111-111111111111";
const MARKER = `<!-- workflow-run:${RUN_ID} -->`;
const SILENT_LOGGER = pino({ level: "silent" });

function makeRow(overrides: Partial<WorkflowRunRow> = {}): WorkflowRunRow {
  return {
    id: RUN_ID,
    workflow_name: "plan",
    target_type: "issue",
    target_owner: "acme",
    target_repo: "widgets",
    target_number: 42,
    parent_run_id: null,
    parent_step_index: null,
    status: "running",
    state: {},
    tracking_comment_id: null,
    delivery_id: "del-1",
    owner_kind: "daemon",
    owner_id: "daemon-1",
    trigger_comment_id: null,
    trigger_event_type: null,
    created_at: new Date("2026-05-08T02:55:00Z"),
    updated_at: new Date("2026-05-08T02:55:00Z"),
    ...overrides,
  };
}

interface OctokitCallLog {
  createComment: ReturnType<typeof mock>;
  updateComment: ReturnType<typeof mock>;
  deleteComment: ReturnType<typeof mock>;
  listComments: ReturnType<typeof mock>;
}

function makeOctokit(opts: {
  listCommentsData?: { id: number; body: string; created_at: string }[];
  createCommentResult?: { id: number } | { throwError: Error };
}): { octokit: Octokit; calls: OctokitCallLog } {
  const listComments = mock(() => Promise.resolve({ data: opts.listCommentsData ?? [] }));
  const createComment = mock(() => {
    if (opts.createCommentResult && "throwError" in opts.createCommentResult) {
      return Promise.reject(opts.createCommentResult.throwError);
    }
    return Promise.resolve({ data: opts.createCommentResult ?? { id: 9000 } });
  });
  const updateComment = mock(() => Promise.resolve({ data: {} }));
  const deleteComment = mock(() => Promise.resolve({ data: {} }));
  // Single-page paginate stub: source uses octokit.paginate(listComments, params),
  // which under the real client follows Link headers. Our mocks return one page
  // with no Link header, so paginate is equivalent to "call endpoint once and
  // return .data". This keeps the listComments mock the call-shape source of
  // truth for assertions while letting the source-side pagination call land.
  const octokitRef: { paginate?: (ep: unknown, params: unknown) => Promise<unknown> } = {};
  octokitRef.paginate = async (
    endpoint: (params: unknown) => Promise<{ data: unknown[] }>,
    params: unknown,
  ): Promise<unknown[]> => {
    const resp = await endpoint(params);
    return resp.data;
  };
  const calls: OctokitCallLog = { createComment, updateComment, deleteComment, listComments };
  const octokit = {
    paginate: octokitRef.paginate,
    rest: { issues: { createComment, updateComment, deleteComment, listComments } },
  } as unknown as Octokit;
  return { octokit, calls };
}

describe("tracking-mirror.setState: first-touch create/adopt path", () => {
  beforeEach(() => {
    mergeStateMock.mockClear();
    findByIdMock.mockClear();
    tryReserveMock.mockClear();
    listChildrenByParentMock.mockClear();
    findPriorTrackingCommentsMock.mockClear();
    clearTrackingCommentIdMock.mockClear();
    clearTrackingCommentIdForAttemptMock.mockClear();
    assertCurrentWorkflowAttemptMock.mockClear();
    mergeAttemptStateMock.mockClear();
    mockPriorComments = [];
  });

  it("creates a comment on the happy path when no marker exists yet", async () => {
    mockRow = makeRow();
    mockReservation = { won: true, trackingCommentId: 9000 };
    const { octokit, calls } = makeOctokit({
      createCommentResult: { id: 9000 },
    });

    // Pre-scan empty, post-scan reflects the just-created comment.
    let scanCallCount = 0;
    const listComments = mock(() => {
      scanCallCount += 1;
      if (scanCallCount === 1) return Promise.resolve({ data: [] });
      return Promise.resolve({
        data: [{ id: 9000, body: `${MARKER}\nstarting`, created_at: "2026-05-08T02:55:43Z" }],
      });
    });
    (octokit.rest.issues as unknown as { listComments: typeof listComments }).listComments =
      listComments;

    const result = await setState(
      { octokit, logger: SILENT_LOGGER },
      { runId: RUN_ID, patch: {}, humanMessage: "starting" },
    );

    expect(listComments).toHaveBeenCalledTimes(2); // pre + post
    expect(calls.createComment).toHaveBeenCalledTimes(1);
    expect(calls.deleteComment).not.toHaveBeenCalled();
    expect(tryReserveMock).toHaveBeenCalledWith(RUN_ID, 9000);
    // Body sent to GitHub embeds the marker so future scans can find it.
    const createBody = (calls.createComment.mock.calls[0]?.[0] as { body: string } | undefined)
      ?.body;
    expect(createBody).toContain(MARKER);
    expect(result.tracking_comment_id).toBe(9000);
  });

  it("reserves a first-touch comment through the exact workflow attempt", async () => {
    mockRow = makeRow();
    mockReservation = { won: true, trackingCommentId: 9000 };
    const attempt = { runId: RUN_ID, attemptId: crypto.randomUUID() };
    const { octokit } = makeOctokit({ createCommentResult: { id: 9000 } });
    let scanCallCount = 0;
    const listComments = mock(() => {
      scanCallCount += 1;
      if (scanCallCount === 1) return Promise.resolve({ data: [] });
      return Promise.resolve({
        data: [{ id: 9000, body: `${MARKER}\nstarting`, created_at: "2026-05-08T02:55:43Z" }],
      });
    });
    (octokit.rest.issues as unknown as { listComments: typeof listComments }).listComments =
      listComments;

    await setState(
      { octokit, logger: SILENT_LOGGER },
      { runId: RUN_ID, patch: {}, humanMessage: "starting", attempt },
    );

    expect(tryReserveMock).toHaveBeenCalledWith(RUN_ID, 9000, attempt);
  });

  it("stops first-touch cleanup and updates when the reservation attempt is stale", async () => {
    mockRow = makeRow({ parent_run_id: "parent-run-id" });
    const attempt = { runId: RUN_ID, attemptId: crypto.randomUUID() };
    const { octokit, calls } = makeOctokit({ createCommentResult: { id: 9000 } });
    tryReserveMock.mockRejectedValueOnce(new StaleWorkflowAttemptError("attempt lost"));
    let scanCallCount = 0;
    const listComments = mock(() => {
      scanCallCount += 1;
      if (scanCallCount === 1) return Promise.resolve({ data: [] });
      return Promise.resolve({
        data: [{ id: 9000, body: `${MARKER}\nstarting`, created_at: "2026-05-08T02:55:43Z" }],
      });
    });
    (octokit.rest.issues as unknown as { listComments: typeof listComments }).listComments =
      listComments;

    await expectToReject(
      setState(
        { octokit, logger: SILENT_LOGGER },
        { runId: RUN_ID, patch: {}, humanMessage: "starting", attempt },
      ),
      "attempt lost",
    );

    expect(calls.createComment).toHaveBeenCalledTimes(1);
    expect(calls.updateComment).not.toHaveBeenCalled();
    expect(calls.deleteComment).not.toHaveBeenCalled();
    expect(findPriorTrackingCommentsMock).not.toHaveBeenCalled();
    expect(listChildrenByParentMock).not.toHaveBeenCalled();
  });

  it("adopts an existing marker comment without POSTing when pre-scan finds one (pod-restart recovery)", async () => {
    mockRow = makeRow();
    mockReservation = { won: true, trackingCommentId: 7777 };
    const { octokit, calls } = makeOctokit({
      listCommentsData: [
        { id: 7777, body: `${MARKER}\nold body`, created_at: "2026-05-08T02:55:43Z" },
      ],
    });

    const result = await setState(
      { octokit, logger: SILENT_LOGGER },
      { runId: RUN_ID, patch: {}, humanMessage: "starting" },
    );

    // No new POST, orphan adopted.
    expect(calls.createComment).not.toHaveBeenCalled();
    expect(calls.updateComment).toHaveBeenCalledTimes(1); // refresh body on adopted comment
    expect(tryReserveMock).toHaveBeenCalledWith(RUN_ID, 7777);
    expect(result.tracking_comment_id).toBe(7777);
  });

  it("reconciles octokit-internal retry duplicates: adopts oldest, deletes the rest", async () => {
    // Models the issue #109 failure mode: octokit's plugin-retry retried a
    // POST that had already committed server-side, producing N orphan comments.
    mockRow = makeRow();
    mockReservation = { won: true, trackingCommentId: 1001 };
    const { octokit, calls } = makeOctokit({
      listCommentsData: [], // pre-scan empty
      createCommentResult: { id: 1004 }, // create returns the LAST retry's id
    });

    // After createComment, post-scan returns the four duplicates.
    let scanCallCount = 0;
    const listComments = mock(() => {
      scanCallCount += 1;
      if (scanCallCount === 1) return Promise.resolve({ data: [] });
      return Promise.resolve({
        data: [
          { id: 1001, body: `${MARKER}\nstarting`, created_at: "2026-05-08T02:57:43Z" },
          { id: 1002, body: `${MARKER}\nstarting`, created_at: "2026-05-08T02:57:46Z" },
          { id: 1003, body: `${MARKER}\nstarting`, created_at: "2026-05-08T02:57:53Z" },
          { id: 1004, body: `${MARKER}\nstarting`, created_at: "2026-05-08T02:58:05Z" },
        ],
      });
    });
    (octokit.rest.issues as unknown as { listComments: typeof listComments }).listComments =
      listComments;

    const result = await setState(
      { octokit, logger: SILENT_LOGGER },
      { runId: RUN_ID, patch: {}, humanMessage: "starting" },
    );

    expect(calls.createComment).toHaveBeenCalledTimes(1);
    expect(calls.deleteComment).toHaveBeenCalledTimes(3); // 4 dupes → keep oldest, delete 3
    const deletedIds = calls.deleteComment.mock.calls.map(
      (c) => (c[0] as { comment_id: number }).comment_id,
    );
    expect(deletedIds).toEqual([1002, 1003, 1004]);
    expect(tryReserveMock).toHaveBeenCalledWith(RUN_ID, 1001);
    expect(result.tracking_comment_id).toBe(1001);
  });

  it("recovers when createComment throws but server actually committed (orphan from internal retry)", async () => {
    mockRow = makeRow();
    mockReservation = { won: true, trackingCommentId: 5555 };
    const { octokit, calls } = makeOctokit({
      listCommentsData: [],
      createCommentResult: { throwError: new Error("socket hang up") },
    });

    let scanCallCount = 0;
    const listComments = mock(() => {
      scanCallCount += 1;
      if (scanCallCount === 1) return Promise.resolve({ data: [] });
      return Promise.resolve({
        data: [{ id: 5555, body: `${MARKER}\nstarting`, created_at: "2026-05-08T02:57:43Z" }],
      });
    });
    (octokit.rest.issues as unknown as { listComments: typeof listComments }).listComments =
      listComments;

    const result = await setState(
      { octokit, logger: SILENT_LOGGER },
      { runId: RUN_ID, patch: {}, humanMessage: "starting" },
    );

    expect(calls.createComment).toHaveBeenCalledTimes(1);
    expect(calls.deleteComment).not.toHaveBeenCalled();
    expect(tryReserveMock).toHaveBeenCalledWith(RUN_ID, 5555);
    expect(result.tracking_comment_id).toBe(5555);
  });

  it("rethrows the createComment error when no marker is found server-side", async () => {
    mockRow = makeRow();
    mockReservation = { won: true, trackingCommentId: 0 };
    const { octokit, calls } = makeOctokit({
      listCommentsData: [], // both scans empty
      createCommentResult: { throwError: new Error("upstream 500") },
    });

    let thrown: unknown = null;
    try {
      await setState(
        { octokit, logger: SILENT_LOGGER },
        { runId: RUN_ID, patch: {}, humanMessage: "starting" },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("upstream 500");

    expect(calls.createComment).toHaveBeenCalledTimes(1);
    expect(tryReserveMock).not.toHaveBeenCalled();
  });

  it("scopes the listComments scan via since=row.created_at and per_page=100", async () => {
    mockRow = makeRow({ created_at: new Date("2026-05-08T02:55:00.000Z") });
    mockReservation = { won: true, trackingCommentId: 9000 };
    const { octokit } = makeOctokit({
      createCommentResult: { id: 9000 },
    });

    let scanCallCount = 0;
    const listComments = mock(() => {
      scanCallCount += 1;
      if (scanCallCount === 1) return Promise.resolve({ data: [] });
      return Promise.resolve({
        data: [{ id: 9000, body: `${MARKER}\nstarting`, created_at: "2026-05-08T02:55:43Z" }],
      });
    });
    (octokit.rest.issues as unknown as { listComments: typeof listComments }).listComments =
      listComments;

    await setState(
      { octokit, logger: SILENT_LOGGER },
      { runId: RUN_ID, patch: {}, humanMessage: "starting" },
    );

    const args = listComments.mock.calls[0]?.[0] as
      | { owner: string; repo: string; issue_number: number; per_page: number; since: string }
      | undefined;
    expect(args?.since).toBe("2026-05-08T02:55:00.000Z");
    expect(args?.per_page).toBe(100);
    expect(args?.owner).toBe("acme");
    expect(args?.repo).toBe("widgets");
    expect(args?.issue_number).toBe(42);
    // Regression-lock: GitHub's per-issue listComments endpoint silently
    // ignores `direction` and `sort` (only `since` / `per_page` / `page`
    // are honoured). A future contributor adding either would create a
    // false-confidence ordering assumption, fail the test instead.
    expect(args).not.toHaveProperty("direction");
    expect(args).not.toHaveProperty("sort");
  });

  it("lost-CAS: another racer reserved a different comment id, adopts the canonical, deletes our orphan", async () => {
    // Concurrent first-touch race: post-create scan finds two markers
    // (1010, 1011). Our code picks 1010 as candidate, but the CAS reveals
    // a concurrent racer already reserved 1011. The fix's invariant: never
    // delete the canonical id. Verify (a) tryReserveTrackingCommentId is
    // called with our candidate (1010), (b) only the non-canonical id
    // (1010) is deleted, (c) the row carries the racer's id (1011).
    mockRow = makeRow();
    mockReservation = { won: false, trackingCommentId: 1011 };
    const { octokit, calls } = makeOctokit({
      createCommentResult: { id: 1010 },
    });

    let scanCallCount = 0;
    const listComments = mock(() => {
      scanCallCount += 1;
      if (scanCallCount === 1) return Promise.resolve({ data: [] });
      return Promise.resolve({
        data: [
          { id: 1010, body: `${MARKER}\nstarting`, created_at: "2026-05-08T02:57:43Z" },
          { id: 1011, body: `${MARKER}\nstarting`, created_at: "2026-05-08T02:57:46Z" },
        ],
      });
    });
    (octokit.rest.issues as unknown as { listComments: typeof listComments }).listComments =
      listComments;

    const result = await setState(
      { octokit, logger: SILENT_LOGGER },
      { runId: RUN_ID, patch: {}, humanMessage: "starting" },
    );

    expect(tryReserveMock).toHaveBeenCalledWith(RUN_ID, 1010);
    expect(calls.deleteComment).toHaveBeenCalledTimes(1);
    const deletedIds = calls.deleteComment.mock.calls.map(
      (c) => (c[0] as { comment_id: number }).comment_id,
    );
    expect(deletedIds).toEqual([1010]);
    // Final updateComment targets the canonical (racer-reserved) id.
    const updateArgs = calls.updateComment.mock.calls.at(-1)?.[0] as
      | { comment_id: number }
      | undefined;
    expect(updateArgs?.comment_id).toBe(1011);
    expect(result.tracking_comment_id).toBe(1011);
  });

  it("re-run cleanup: deletes a prior run's tracking comment on first touch", async () => {
    mockRow = makeRow();
    mockReservation = { won: true, trackingCommentId: 9000 };
    mockPriorComments = [{ runId: "prior-run-id", trackingCommentId: 8001 }];
    const { octokit, calls } = makeOctokit({ createCommentResult: { id: 9000 } });

    let scanCallCount = 0;
    const listComments = mock(() => {
      scanCallCount += 1;
      if (scanCallCount === 1) return Promise.resolve({ data: [] });
      return Promise.resolve({
        data: [{ id: 9000, body: `${MARKER}\nstarting`, created_at: "2026-05-08T02:55:43Z" }],
      });
    });
    (octokit.rest.issues as unknown as { listComments: typeof listComments }).listComments =
      listComments;

    await setState(
      { octokit, logger: SILENT_LOGGER },
      { runId: RUN_ID, patch: {}, humanMessage: "starting" },
    );

    // The only deletion is the prior run's comment; no dedup losers here.
    expect(findPriorTrackingCommentsMock).toHaveBeenCalled();
    expect(calls.deleteComment).toHaveBeenCalledTimes(1);
    const deletedId = (calls.deleteComment.mock.calls[0]?.[0] as { comment_id: number } | undefined)
      ?.comment_id;
    expect(deletedId).toBe(8001);
    // The prior row's tracking_comment_id is cleared so a future re-run does
    // not re-list and re-attempt a 404 delete on the same comment.
    expect(clearTrackingCommentIdMock).toHaveBeenCalledWith("prior-run-id");
  });

  it("re-run cleanup: clears a prior row through the current attempt fence", async () => {
    mockRow = makeRow();
    mockReservation = { won: true, trackingCommentId: 9000 };
    mockPriorComments = [{ runId: "prior-run-id", trackingCommentId: 8001 }];
    const { octokit } = makeOctokit({ createCommentResult: { id: 9000 } });
    const attempt = { runId: RUN_ID, attemptId: crypto.randomUUID() };
    let scanCallCount = 0;
    const listComments = mock(() => {
      scanCallCount += 1;
      if (scanCallCount === 1) return Promise.resolve({ data: [] });
      return Promise.resolve({
        data: [{ id: 9000, body: `${MARKER}\nstarting`, created_at: "2026-05-08T02:55:43Z" }],
      });
    });
    (octokit.rest.issues as unknown as { listComments: typeof listComments }).listComments =
      listComments;

    await setState(
      { octokit, logger: SILENT_LOGGER },
      { runId: RUN_ID, patch: {}, humanMessage: "starting", attempt },
    );

    expect(clearTrackingCommentIdMock).not.toHaveBeenCalled();
    expect(clearTrackingCommentIdForAttemptMock).toHaveBeenCalledWith("prior-run-id", attempt);
  });

  it("re-run cleanup: a deleteComment failure does not block the new comment (fail-open)", async () => {
    mockRow = makeRow();
    mockReservation = { won: true, trackingCommentId: 9000 };
    mockPriorComments = [{ runId: "prior-run-id", trackingCommentId: 8001 }];
    const { octokit } = makeOctokit({ createCommentResult: { id: 9000 } });

    let scanCallCount = 0;
    const listComments = mock(() => {
      scanCallCount += 1;
      if (scanCallCount === 1) return Promise.resolve({ data: [] });
      return Promise.resolve({
        data: [{ id: 9000, body: `${MARKER}\nstarting`, created_at: "2026-05-08T02:55:43Z" }],
      });
    });
    (octokit.rest.issues as unknown as { listComments: typeof listComments }).listComments =
      listComments;
    // Prior-comment delete fails (already deleted, 404, transient API error).
    (octokit.rest.issues as unknown as { deleteComment: ReturnType<typeof mock> }).deleteComment =
      mock(() => Promise.reject(new Error("404 Not Found")));

    const result = await setState(
      { octokit, logger: SILENT_LOGGER },
      { runId: RUN_ID, patch: {}, humanMessage: "starting" },
    );

    // The new run's own comment is still created despite the cleanup failure.
    expect(result.tracking_comment_id).toBe(9000);
  });

  it("re-run cleanup: never deletes the comment of the current run's composite parent", async () => {
    mockRow = makeRow({ parent_run_id: "parent-run-id" });
    mockReservation = { won: true, trackingCommentId: 9000 };
    mockPriorComments = [{ runId: "parent-run-id", trackingCommentId: 8002 }];
    const { octokit, calls } = makeOctokit({ createCommentResult: { id: 9000 } });

    let scanCallCount = 0;
    const listComments = mock(() => {
      scanCallCount += 1;
      if (scanCallCount === 1) return Promise.resolve({ data: [] });
      return Promise.resolve({
        data: [{ id: 9000, body: `${MARKER}\nstarting`, created_at: "2026-05-08T02:55:43Z" }],
      });
    });
    (octokit.rest.issues as unknown as { listComments: typeof listComments }).listComments =
      listComments;

    await setState(
      { octokit, logger: SILENT_LOGGER },
      { runId: RUN_ID, patch: {}, humanMessage: "starting" },
    );

    expect(calls.deleteComment).not.toHaveBeenCalled();
  });

  it("updates the existing comment without POST when the row already has tracking_comment_id", async () => {
    mockRow = makeRow({ tracking_comment_id: 4242 });
    const { octokit, calls } = makeOctokit({});

    const result = await setState(
      { octokit, logger: SILENT_LOGGER },
      { runId: RUN_ID, patch: {}, humanMessage: "next message" },
    );

    expect(calls.createComment).not.toHaveBeenCalled();
    expect(calls.listComments).not.toHaveBeenCalled();
    expect(calls.updateComment).toHaveBeenCalledTimes(1);
    const updateArgs = calls.updateComment.mock.calls[0]?.[0] as
      | { comment_id: number; body: string }
      | undefined;
    expect(updateArgs?.comment_id).toBe(4242);
    expect(updateArgs?.body).toContain(MARKER);
    expect(result.tracking_comment_id).toBe(4242);
  });

  it("uses the exact workflow attempt for progress state and the GitHub update", async () => {
    mockRow = makeRow({ tracking_comment_id: 4242 });
    const { octokit, calls } = makeOctokit({});
    const attempt = { runId: RUN_ID, attemptId: "22222222-2222-4222-8222-222222222222" };

    await setState(
      { octokit, logger: SILENT_LOGGER },
      {
        runId: RUN_ID,
        patch: { progress: 50 },
        humanMessage: "half complete",
        attempt,
      },
    );

    expect(mergeStateMock).not.toHaveBeenCalled();
    expect(mergeAttemptStateMock).toHaveBeenCalledWith(
      attempt,
      expect.objectContaining({ progress: 50 }),
    );
    expect(assertCurrentWorkflowAttemptMock).toHaveBeenCalledWith(attempt);
    expect(calls.updateComment).toHaveBeenCalledTimes(1);
  });

  it("does not update GitHub after the progress attempt loses its lease", async () => {
    mockRow = makeRow({ tracking_comment_id: 4242 });
    const { octokit, calls } = makeOctokit({});
    const attempt = { runId: RUN_ID, attemptId: "33333333-3333-4333-8333-333333333333" };
    assertCurrentWorkflowAttemptMock.mockRejectedValueOnce(
      new StaleWorkflowAttemptError("attempt lost"),
    );

    await expectToReject(
      setState(
        { octokit, logger: SILENT_LOGGER },
        { runId: RUN_ID, patch: { progress: 50 }, humanMessage: "half complete", attempt },
      ),
      "attempt lost",
    );

    expect(calls.updateComment).not.toHaveBeenCalled();
  });
});

// ─── Per-repo config notice, `.github-app.yaml` Gate 2 ──────────────────────

describe("renderCommentBody: persisted config notice", () => {
  it("pins the state key so a rename fails loudly", () => {
    // The key is persisted into `workflow_runs.state`. Renaming it after
    // release strands the notice on every existing row, and the underscore
    // prefix keeps it out of the handler-visible state namespace.
    expect(CONFIG_NOTICE_KEY).toBe("_configNotice");
  });

  it("renders the notice on every body, not just the write that set it", () => {
    const row = makeRow({
      state: { [CONFIG_NOTICE_KEY]: "`.github-app.yaml` failed validation and was ignored." },
    });

    // The body is rebuilt from scratch on every write, so the assertion that
    // matters is that a LATER message still carries the notice.
    const body = renderCommentBody(row, "third progress update");

    expect(body).toContain("> [!WARNING]");
    expect(body).toContain("failed validation");
    expect(body).toContain("third progress update");
  });

  it("collapses whitespace so a stray CR cannot break out of the blockquote", () => {
    const row = makeRow({ state: { [CONFIG_NOTICE_KEY]: "config was\rignored" } });

    const body = renderCommentBody(row, "msg");

    expect(body).toContain("> config was ignored");
    expect(body).not.toContain("\r");
  });

  it("renders each stored line as its own paragraph inside one alert", () => {
    const row = makeRow({
      state: { [CONFIG_NOTICE_KEY]: "config was ignored\nreview scope reduced" },
    });

    const body = renderCommentBody(row, "msg");

    expect(body).toContain("> [!WARNING]\n> config was ignored\n>\n> review scope reduced");
  });

  it("renders nothing for an absent or whitespace-only notice", () => {
    expect(renderCommentBody(makeRow(), "msg")).not.toContain("[!WARNING]");
    expect(
      renderCommentBody(makeRow({ state: { [CONFIG_NOTICE_KEY]: "  " } }), "msg"),
    ).not.toContain("[!WARNING]");
  });
});
