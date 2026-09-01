import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import {
  deferLeasedWorkflowJob,
  ensureWorkflowJobQueued,
  leaseJob,
  processingListKey,
  type WorkflowRunQueuedJob,
} from "../../src/orchestrator/job-queue";
import { closeValkey, connectValkey, requireValkeyClient } from "../../src/orchestrator/valkey";

const instanceId = `outbox-test-${crypto.randomUUID()}`;
const receiptKeys: string[] = [];

function job(): WorkflowRunQueuedJob {
  return {
    kind: "workflow-run",
    deliveryId: crypto.randomUUID(),
    repoOwner: "acme",
    repoName: "widgets",
    entityNumber: 16,
    isPR: false,
    eventName: "issue_comment",
    triggerUsername: "maintainer",
    labels: ["bot:review"],
    triggerBodyPreview: "review this",
    enqueuedAt: 1_787_519_000_000,
    retryCount: 0,
    workflowRun: { runId: crypto.randomUUID(), workflowName: "review" },
  };
}

async function clearTestQueue(): Promise<void> {
  const valkey = requireValkeyClient();
  const receipts = receiptKeys.splice(0);
  await valkey.send("DEL", ["queue:jobs", processingListKey(instanceId), ...receipts]);
}

describe("durable workflow dispatch wake-up", () => {
  beforeAll(async () => {
    await connectValkey();
  });

  afterAll(async () => {
    await clearTestQueue();
    closeValkey();
  });

  beforeEach(clearTestQueue);

  it("restores one acknowledged item after Valkey loses it", async () => {
    const wake = job();
    const valkey = requireValkeyClient();

    expect(await ensureWorkflowJobQueued(wake, instanceId)).toBe(true);
    await valkey.send("DEL", ["queue:jobs"]);
    expect(await ensureWorkflowJobQueued(wake, instanceId)).toBe(true);
    expect(await valkey.send("LLEN", ["queue:jobs"])).toBe(1);
  });

  it("does not duplicate an item in either the queue or processing list", async () => {
    const wake = job();
    const valkey = requireValkeyClient();

    const inserts = await Promise.all(
      Array.from({ length: 10 }, () => ensureWorkflowJobQueued(wake, instanceId)),
    );
    expect(inserts.filter(Boolean)).toHaveLength(1);
    expect(await valkey.send("LLEN", ["queue:jobs"])).toBe(1);

    expect(await leaseJob(instanceId)).not.toBeNull();
    expect(await ensureWorkflowJobQueued(wake, instanceId)).toBe(false);
    expect(await valkey.send("LLEN", ["queue:jobs"])).toBe(0);
    expect(await valkey.send("LLEN", [processingListKey(instanceId)])).toBe(1);
  });

  it("keeps one byte-stable item through repeated capacity deferrals", async () => {
    const wake = job();
    const stableRaw = JSON.stringify(wake);
    const valkey = requireValkeyClient();
    await ensureWorkflowJobQueued(wake, instanceId);

    for (let index = 0; index < 5; index++) {
      // eslint-disable-next-line no-await-in-loop -- each cycle models one capacity-limited lease
      const leased = await leaseJob(instanceId);
      expect(leased?.raw).toBe(stableRaw);
      const deferralId = `capacity-${String(index)}-${crypto.randomUUID()}`;
      receiptKeys.push(`queue:workflow-deferral-receipt:${instanceId}:${deferralId}`);
      // eslint-disable-next-line no-await-in-loop -- the next lease must observe this exact move
      expect(await deferLeasedWorkflowJob(instanceId, stableRaw, wake, deferralId)).toEqual({
        status: "moved",
      });
    }

    expect(await valkey.send("LLEN", ["queue:jobs"])).toBe(1);
    expect(await valkey.send("LLEN", [processingListKey(instanceId)])).toBe(0);
    expect(await valkey.send("LINDEX", ["queue:jobs", "0"])).toBe(stableRaw);
  });
});
