import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processRoutingQueue } from "@/lib/routing/worker";
import type { RoutingDependencies } from "@/lib/routing/handlers";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  finish: vi.fn(),
  posting: vi.fn(),
  enqueue: vi.fn(),
  latestRotation: vi.fn(),
  getDutyOwner: vi.fn(),
  cleanup: vi.fn(),
  handle: vi.fn(),
  syncCloseDate: vi.fn()
}));

vi.mock("@/lib/routing/close-date", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/routing/close-date")>(),
  syncCloseDate: mocks.syncCloseDate
}));
vi.mock("@/lib/routing/handlers", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/routing/handlers")>(),
  handleRoutingWork: mocks.handle
}));
vi.mock("@/lib/routing/schedule", () => ({ createDutyLookup: () => mocks.getDutyOwner }));
vi.mock("@/lib/routing/repository", () => ({
  claimRoutingJob: mocks.claim,
  finishRoutingJob: mocks.finish,
  markRoutingPosting: mocks.posting,
  enqueueRoutingJobs: mocks.enqueue,
  getLatestShiftRotation: mocks.latestRotation,
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
  vi.stubEnv("CRM_ROUTING_ENABLED", "true");
  vi.stubEnv("CRM_CLOSE_DATE_ENABLED", "false");
  vi.stubEnv("CRM_SHIFT_ROTATION_ENABLED", "false");
  mocks.claim.mockResolvedValue(null);
  mocks.getDutyOwner.mockResolvedValue(7268314);
  mocks.latestRotation.mockResolvedValue(null);
  mocks.cleanup.mockResolvedValue(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("routing worker", () => {
  const dateJob = {
    ...message, id: "close-date-job",
    payload: { kind: "close-date", leadId: 42, updatedAt: 1793836920 }
  };

  it("does not process a date job when its switch is off", async () => {
    mocks.claim.mockResolvedValueOnce(dateJob);
    expect(await processRoutingQueue(10_000)).toMatchObject({ skipped: 1 });
    expect(mocks.syncCloseDate).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledWith(dateJob, { status: "skipped", reason: "close_date_disabled" });
  });

  it("processes a date job without a shift sheet and without enabling other routing", async () => {
    vi.stubEnv("CRM_ROUTING_ENABLED", "false");
    vi.stubEnv("CRM_CLOSE_DATE_ENABLED", "true");
    vi.stubEnv("CRM_SHIFT_SPREADSHEET_ID", "");
    vi.stubEnv("CRM_SHIFT_ROTATION_ENABLED", "true");
    mocks.claim.mockResolvedValueOnce(dateJob).mockResolvedValueOnce(message);
    mocks.syncCloseDate.mockResolvedValueOnce({ status: "processed" });
    expect(await processRoutingQueue(10_000)).toMatchObject({ processed: 1, skipped: 1 });
    expect(mocks.syncCloseDate).toHaveBeenCalledWith(dateJob.payload, expect.any(Object), expect.objectContaining({
      assertRunning: expect.any(Function), beforeWrite: expect.any(Function)
    }));
    expect(mocks.handle).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledWith(message, { status: "skipped", reason: "routing_disabled" });
  });

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

  it("does not restart a manual rotation for the already selected owner", async () => {
    vi.stubEnv("CRM_SHIFT_ROTATION_ENABLED", "true");
    vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
    const job = { ...message, payload: { kind: "shift-request", day: "05.11.2026", source: "manual" } };
    mocks.claim.mockResolvedValueOnce(job);
    mocks.latestRotation.mockResolvedValueOnce({
      payload: { day: "05.11.2026", ownerId: 7268314, rotationId: "previous" }, status: "processed"
    });
    expect(await processRoutingQueue(10_000)).toMatchObject({ skipped: 1 });
    expect(mocks.getDutyOwner).toHaveBeenCalledWith(expect.any(Date), true);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledWith(job, { status: "skipped", reason: "shift_owner_unchanged" });
  });

  it("queues a new rotation in each direction when the schedule changes twice in a day", async () => {
    vi.stubEnv("CRM_SHIFT_ROTATION_ENABLED", "true");
    vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
    const request = { ...message, lease_until: "2026-11-05T12:05:00Z",
      payload: { kind: "shift-request", day: "05.11.2026", source: "manual" } };
    mocks.claim.mockResolvedValueOnce({ ...request, id: "to-tatiana" })
      .mockResolvedValueOnce({ ...request, id: "back-to-philipp" });
    mocks.getDutyOwner.mockResolvedValueOnce(10985322).mockResolvedValueOnce(7268314);
    mocks.latestRotation
      .mockResolvedValueOnce({ payload: { ownerId: 7268314, rotationId: "nightly" }, status: "processed" })
      .mockResolvedValueOnce({ payload: { ownerId: 10985322, rotationId: "to-tatiana" }, status: "pending" });

    expect(await processRoutingQueue(10_000)).toMatchObject({ processed: 2 });
    expect(mocks.enqueue.mock.calls.map(([jobs]) => jobs[0])).toEqual([
      expect.objectContaining({
        dedupe_key: "shift:05.11.2026:to-tatiana:scan:1",
        payload: { kind: "shift-scan", day: "05.11.2026", page: 1, ownerId: 10985322, rotationId: "to-tatiana" }
      }),
      expect.objectContaining({
        dedupe_key: "shift:05.11.2026:back-to-philipp:scan:1",
        payload: { kind: "shift-scan", day: "05.11.2026", page: 1, ownerId: 7268314, rotationId: "back-to-philipp" }
      })
    ]);
  });

  it("skips jobs from superseded rotations even if the selected owner returns", async () => {
    vi.stubEnv("CRM_SHIFT_ROTATION_ENABLED", "true");
    vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
    const job = { ...message, payload: {
      kind: "shift-lead", day: "05.11.2026", leadId: 42, ownerId: 7268314, rotationId: "old"
    } };
    mocks.claim.mockResolvedValueOnce(job);
    mocks.latestRotation.mockResolvedValueOnce({ payload: { ownerId: 7268314, rotationId: "active" } });
    expect(await processRoutingQueue(10_000)).toMatchObject({ skipped: 1 });
    expect(mocks.handle).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledWith(job, { status: "skipped", reason: "shift_rotation_superseded" });
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
