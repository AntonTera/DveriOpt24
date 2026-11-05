import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processRoutingQueue } from "@/lib/routing/worker";
import type { RoutingDependencies } from "@/lib/routing/handlers";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  finish: vi.fn(),
  posting: vi.fn(),
  enqueue: vi.fn(),
  cleanup: vi.fn(),
  handle: vi.fn()
}));

vi.mock("@/lib/routing/handlers", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/routing/handlers")>(),
  handleRoutingWork: mocks.handle
}));
vi.mock("@/lib/routing/repository", () => ({
  claimRoutingJob: mocks.claim,
  finishRoutingJob: mocks.finish,
  markReplyPosting: mocks.posting,
  enqueueRoutingJobs: mocks.enqueue,
  cleanupRoutingJobs: mocks.cleanup
}));

const message = {
  id: "job-1", claim_token: "claim-1", lease_until: "2026-11-05T00:05:00Z", attempts: 1,
  payload: { kind: "message", leadId: 42, messageId: "msg-1", channel: "vk" }
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-05T00:02:00Z"));
  vi.stubEnv("CRM_SHIFT_SPREADSHEET_ID", "test-sheet");
  vi.stubEnv("CRM_SVETLANA_USER_ID", "");
  vi.stubEnv("CRM_SHIFT_ROTATION_ENABLED", "false");
  mocks.claim.mockResolvedValue(null);
  mocks.cleanup.mockResolvedValue(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("routing worker", () => {
  it("only schedules a rotation during the Moscow window and uses one key for the day", async () => {
    vi.stubEnv("CRM_SHIFT_ROTATION_ENABLED", "true");
    await processRoutingQueue(10_000);
    vi.setSystemTime(new Date("2026-11-05T00:04:00Z"));
    await processRoutingQueue(10_000);
    vi.setSystemTime(new Date("2026-11-05T00:05:00Z"));
    await processRoutingQueue(10_000);
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(mocks.enqueue.mock.calls.map(([jobs]) => jobs[0].dedupe_key)).toEqual([
      "shift:05.11.2026:scan:1", "shift:05.11.2026:scan:1"
    ]);
  });

  it("does not execute a queued rotation when the separate flag is off", async () => {
    const job = { ...message, payload: { kind: "shift-scan", day: "05.11.2026", page: 1 } };
    mocks.claim.mockResolvedValueOnce(job);
    expect(await processRoutingQueue(10_000)).toMatchObject({ skipped: 1 });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.handle).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledWith(job, { status: "skipped", reason: "shift_rotation_disabled" });
  });

  it.each([[1, "retry"], [5, "failed"]])("handles ordinary errors on attempt %i as %s", async (attempts, status) => {
    const job = { ...message, attempts };
    mocks.claim.mockResolvedValueOnce(job);
    mocks.handle.mockRejectedValueOnce(new Error("dependency unavailable"));
    await processRoutingQueue(10_000);
    expect(mocks.finish).toHaveBeenCalledWith(job, { status, reason: "routing_dependency_failed" });
  });

  it("never retries a job after recording a reply task POST intent", async () => {
    mocks.claim.mockResolvedValueOnce(message);
    mocks.handle.mockImplementationOnce(async (_payload: unknown, deps: RoutingDependencies) => {
      await deps.beforeCreateReply();
      throw new Error("timeout");
    });
    expect(await processRoutingQueue(10_000)).toMatchObject({ needs_review: 1, retry: 0 });
    expect(mocks.posting).toHaveBeenCalledOnce();
    expect(mocks.finish).toHaveBeenCalledWith(message, { status: "needs_review", reason: "routing_dependency_failed" });
  });
});
