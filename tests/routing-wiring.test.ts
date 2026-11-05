import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/webhooks/amocrm-routing/route";
import { GET as preview } from "@/app/api/routing/shift-preview/route";
import { processQueue } from "@/lib/services/process-queue";

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  processRouting: vi.fn(),
  claimWebhookEvents: vi.fn(),
  previewRoutingShift: vi.fn()
}));

vi.mock("@/lib/routing/repository", () => ({ enqueueRoutingJobs: mocks.enqueue }));
vi.mock("@/lib/routing/worker", () => ({ processRoutingQueue: mocks.processRouting }));
vi.mock("@/lib/routing/handlers", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/routing/handlers")>(),
  previewRoutingShift: mocks.previewRoutingShift
}));
vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({ WEBHOOK_EVENTS_RETENTION_DAYS: 1, SHEET_JOBS_RETENTION_DAYS: 1 })
}));
vi.mock("@/lib/repositories", () => ({
  claimWebhookEvents: mocks.claimWebhookEvents,
  claimSheetJobs: async () => [],
  cleanupWebhookEventHistory: async () => 0,
  cleanupSheetJobHistory: async () => 0
}));
vi.mock("@/lib/services/process-webhook-events", () => ({}));
vi.mock("@/lib/services/process-sheet-jobs", () => ({}));
vi.mock("@/lib/log", () => ({ logError: vi.fn() }));

function request(secret?: string, body = "leads[add][0][id]=42") {
  const url = new URL("https://example.test/api/webhooks/amocrm-routing");
  if (secret) url.searchParams.set("secret", secret);
  return new Request(url, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.claimWebhookEvents.mockResolvedValue([]);
  vi.stubEnv("CRM_ROUTING_ENABLED", "");
  vi.stubEnv("CRM_ROUTING_WEBHOOK_SECRET", "");
  vi.stubEnv("CRM_SHIFT_SPREADSHEET_ID", "test-spreadsheet");
  vi.stubEnv("CRM_SVETLANA_USER_ID", "");
  vi.stubEnv("CRON_SECRET", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("routing webhook", () => {
  it("does not accept events when disabled", async () => {
    vi.stubEnv("CRM_ROUTING_WEBHOOK_SECRET", "test-secret");
    expect((await POST(request("test-secret"))).status).toBe(404);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("requires the configured secret when enabled", async () => {
    vi.stubEnv("CRM_ROUTING_ENABLED", "true");
    expect((await POST(request())).status).toBe(401);
    vi.stubEnv("CRM_ROUTING_WEBHOOK_SECRET", "test-secret");
    expect((await POST(request("wrong-secret"))).status).toBe(401);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("queues only supported events and returns an error on persistence failure", async () => {
    vi.stubEnv("CRM_ROUTING_ENABLED", "true");
    vi.stubEnv("CRM_ROUTING_WEBHOOK_SECRET", "test-secret");
    const body = "leads[add][0][id]=42&leads[status][0][id]=43";
    expect(await (await POST(request("test-secret", body))).json()).toEqual({ ok: true, accepted: 1 });
    expect(mocks.enqueue).toHaveBeenCalledWith([expect.objectContaining({ dedupe_key: "lead:42" })]);
    mocks.enqueue.mockRejectedValueOnce(new Error("database unavailable"));
    expect((await POST(request("test-secret", body))).status).toBe(503);
  });
});

describe("routing cron and preview", () => {
  it("does not call the routing worker unless explicitly enabled", async () => {
    vi.stubEnv("CRM_ROUTING_ENABLED", "1");
    expect(await processQueue()).not.toHaveProperty("routing");
    expect(mocks.claimWebhookEvents).toHaveBeenCalled();
    expect(mocks.processRouting).not.toHaveBeenCalled();
  });

  it("isolates the routing worker failure from KPI processing", async () => {
    vi.stubEnv("CRM_ROUTING_ENABLED", "true");
    mocks.processRouting.mockRejectedValueOnce(new Error("database unavailable"));
    expect(await processQueue()).toMatchObject({
      processedWebhookEvents: 0, processedSheetJobs: 0, routing: { error: "routing_queue_failed" }
    });
  });

  it("requires authorization and allows read-only preview before enabling routing", async () => {
    const url = "https://example.test/api/routing/shift-preview";
    expect((await preview(new Request(url))).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const headers = { authorization: "Bearer test-cron-secret" };
    expect((await preview(new Request(url + "?page=0", { headers }))).status).toBe(400);
    expect(mocks.previewRoutingShift).not.toHaveBeenCalled();
    mocks.previewRoutingShift.mockResolvedValue({ page: 2, actions: [], ownerId: null, hasNext: false });
    expect((await preview(new Request(url + "?page=2", { headers }))).status).toBe(200);
    expect(mocks.previewRoutingShift).toHaveBeenCalledWith(expect.any(Object), 2);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
