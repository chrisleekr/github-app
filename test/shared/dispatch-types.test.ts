import { describe, expect, it } from "bun:test";

import {
  DISPATCH_REASONS,
  DISPATCH_TARGETS,
  DispatchReasonSchema,
  DispatchTargetSchema,
  isDispatchReason,
  isDispatchTarget,
} from "../../src/shared/dispatch-types";

describe("DispatchTarget", () => {
  it("exposes the shared-daemon and isolated-runner protocols", () => {
    expect(DISPATCH_TARGETS).toEqual(["daemon", "workflow-runner"]);
  });

  it("Zod schema accepts 'daemon'", () => {
    expect(DispatchTargetSchema.safeParse("daemon").success).toBe(true);
    expect(DispatchTargetSchema.safeParse("workflow-runner").success).toBe(true);
  });

  it("Zod schema rejects removed legacy targets", () => {
    for (const bogus of ["inline", "shared-runner", "isolated-job", "auto", "ephemeral-job"]) {
      expect(DispatchTargetSchema.safeParse(bogus).success).toBe(false);
    }
  });

  it("Zod schema rejects non-strings and unknown values", () => {
    for (const bogus of ["", "DAEMON", " daemon", 42, null, undefined, {}]) {
      expect(DispatchTargetSchema.safeParse(bogus).success).toBe(false);
    }
  });

  it("isDispatchTarget accepts both current protocols and rejects everything else", () => {
    expect(isDispatchTarget("daemon")).toBe(true);
    expect(isDispatchTarget("workflow-runner")).toBe(true);
    for (const bogus of ["inline", "shared-runner", "isolated-job", "", 42, null, {}, []]) {
      expect(isDispatchTarget(bogus)).toBe(false);
    }
  });
});

describe("DispatchReason", () => {
  it("exposes every canonical reason in documented order", () => {
    expect(DISPATCH_REASONS).toEqual([
      "persistent-daemon",
      "ephemeral-daemon-triage",
      "ephemeral-daemon-overflow",
      "ephemeral-spawn-failed",
      "workflow-runner",
    ]);
  });

  it("Zod schema accepts every canonical value", () => {
    for (const reason of DISPATCH_REASONS) {
      expect(DispatchReasonSchema.safeParse(reason).success).toBe(true);
    }
  });

  it("Zod schema rejects legacy reasons from the pre-collapse era", () => {
    for (const bogus of [
      "label",
      "keyword",
      "triage",
      "default-fallback",
      "triage-error-fallback",
      "static-default",
      "capacity-rejected",
      "infra-absent",
    ]) {
      expect(DispatchReasonSchema.safeParse(bogus).success).toBe(false);
    }
  });

  it("isDispatchReason narrows and rejects non-canonical values", () => {
    for (const reason of DISPATCH_REASONS) {
      expect(isDispatchReason(reason)).toBe(true);
    }
    for (const bogus of ["label", "", "PERSISTENT-DAEMON", 42, null, undefined, {}]) {
      expect(isDispatchReason(bogus)).toBe(false);
    }
  });
});
