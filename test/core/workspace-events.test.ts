import { describe, expect, it } from "bun:test";

import {
  WORKSPACE_CLEANUP_TARGETS,
  WORKSPACE_LOG_EVENTS,
  WorkspaceLogFieldsSchema,
} from "../../src/core/workspace-events";

describe("WORKSPACE_LOG_EVENTS", () => {
  it("pins the canonical event strings", () => {
    expect(WORKSPACE_LOG_EVENTS.cloneStarted).toBe("workspace.clone.started");
    expect(WORKSPACE_LOG_EVENTS.cloneCompleted).toBe("workspace.clone.completed");
    expect(WORKSPACE_LOG_EVENTS.cloneFailed).toBe("workspace.clone.failed");
    expect(WORKSPACE_LOG_EVENTS.baseBranchFetched).toBe("workspace.base_branch.fetched");
    expect(WORKSPACE_LOG_EVENTS.baseBranchFetchFailed).toBe("workspace.base_branch.fetch_failed");
    expect(WORKSPACE_LOG_EVENTS.cleanupCompleted).toBe("workspace.cleanup.completed");
    expect(WORKSPACE_LOG_EVENTS.cleanupFailed).toBe("workspace.cleanup.failed");
    expect(WORKSPACE_LOG_EVENTS.cleanupExit).toBe("workspace.cleanup.exit");
    expect(WORKSPACE_LOG_EVENTS.cleanupCancel).toBe("workspace.cleanup.cancel");
  });

  it("pins the three cleanup targets", () => {
    expect(WORKSPACE_CLEANUP_TARGETS).toEqual(["clone", "helper", "artifacts"]);
  });
});

describe("WorkspaceLogFieldsSchema: accepts well-formed events", () => {
  it("accepts clone.started", () => {
    const r = WorkspaceLogFieldsSchema.safeParse({
      event: WORKSPACE_LOG_EVENTS.cloneStarted,
      repo: "octo/repo",
      branch: "main",
      depth: 1,
    });
    expect(r.success).toBe(true);
  });

  it("accepts clone.completed with clone_ms", () => {
    const r = WorkspaceLogFieldsSchema.safeParse({
      event: WORKSPACE_LOG_EVENTS.cloneCompleted,
      repo: "octo/repo",
      branch: "main",
      clone_ms: 1234,
    });
    expect(r.success).toBe(true);
  });

  it("accepts clone.failed with err", () => {
    const r = WorkspaceLogFieldsSchema.safeParse({
      event: WORKSPACE_LOG_EVENTS.cloneFailed,
      repo: "octo/repo",
      branch: "feature",
      err: "fatal: could not read from remote",
    });
    expect(r.success).toBe(true);
  });

  it("accepts base_branch.fetched", () => {
    const r = WorkspaceLogFieldsSchema.safeParse({
      event: WORKSPACE_LOG_EVENTS.baseBranchFetched,
      baseBranch: "main",
      headBranch: "feature",
    });
    expect(r.success).toBe(true);
  });

  it("accepts base_branch.fetch_failed with err", () => {
    const r = WorkspaceLogFieldsSchema.safeParse({
      event: WORKSPACE_LOG_EVENTS.baseBranchFetchFailed,
      baseBranch: "main",
      headBranch: "feature",
      err: "fetch failed",
    });
    expect(r.success).toBe(true);
  });

  it("accepts cleanup.completed", () => {
    const r = WorkspaceLogFieldsSchema.safeParse({
      event: WORKSPACE_LOG_EVENTS.cleanupCompleted,
      workDir: "/tmp/clone/abc-123",
    });
    expect(r.success).toBe(true);
  });

  it("accepts cleanup.failed for each target", () => {
    for (const target of WORKSPACE_CLEANUP_TARGETS) {
      const r = WorkspaceLogFieldsSchema.safeParse({
        event: WORKSPACE_LOG_EVENTS.cleanupFailed,
        workDir: "/tmp/clone/abc-123",
        target,
        err: "EBUSY",
      });
      expect(r.success).toBe(true);
    }
  });

  it("accepts cleanup.exit with count and jobIds", () => {
    const r = WorkspaceLogFieldsSchema.safeParse({
      event: WORKSPACE_LOG_EVENTS.cleanupExit,
      count: 2,
      jobIds: ["o1", "o2"],
    });
    expect(r.success).toBe(true);
  });

  it("accepts cleanup.cancel", () => {
    const r = WorkspaceLogFieldsSchema.safeParse({
      event: WORKSPACE_LOG_EVENTS.cleanupCancel,
      workDir: "/tmp/clone/abc-123",
    });
    expect(r.success).toBe(true);
  });
});

describe("WorkspaceLogFieldsSchema: rejects drift and bad input", () => {
  it("rejects an unknown extra field (strict)", () => {
    const r = WorkspaceLogFieldsSchema.safeParse({
      event: WORKSPACE_LOG_EVENTS.cleanupCancel,
      workDir: "/tmp/clone/abc",
      surprise: "boo",
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown event literal", () => {
    const r = WorkspaceLogFieldsSchema.safeParse({
      event: "workspace.bogus",
      workDir: "/tmp/clone/abc",
    });
    expect(r.success).toBe(false);
  });

  it("rejects an invalid cleanup target", () => {
    const r = WorkspaceLogFieldsSchema.safeParse({
      event: WORKSPACE_LOG_EVENTS.cleanupFailed,
      workDir: "/tmp/clone/abc",
      target: "weird",
      err: "boom",
    });
    expect(r.success).toBe(false);
  });

  it("rejects clone.completed with a non-integer clone_ms", () => {
    const r = WorkspaceLogFieldsSchema.safeParse({
      event: WORKSPACE_LOG_EVENTS.cloneCompleted,
      repo: "octo/repo",
      branch: "main",
      clone_ms: 12.5,
    });
    expect(r.success).toBe(false);
  });

  it("rejects clone.failed missing err", () => {
    const r = WorkspaceLogFieldsSchema.safeParse({
      event: WORKSPACE_LOG_EVENTS.cloneFailed,
      repo: "octo/repo",
      branch: "main",
    });
    expect(r.success).toBe(false);
  });

  it("rejects cleanup.exit with a negative count", () => {
    const r = WorkspaceLogFieldsSchema.safeParse({
      event: WORKSPACE_LOG_EVENTS.cleanupExit,
      count: -1,
      jobIds: [],
    });
    expect(r.success).toBe(false);
  });

  it("rejects an empty workDir", () => {
    const r = WorkspaceLogFieldsSchema.safeParse({
      event: WORKSPACE_LOG_EVENTS.cleanupCancel,
      workDir: "",
    });
    expect(r.success).toBe(false);
  });
});
