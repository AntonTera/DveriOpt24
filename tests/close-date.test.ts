import { describe, expect, it, vi } from "vitest";
import { amoFetch } from "@/lib/amocrm/client";
import { createCloseDateCrm, parseCloseDateWebhook, syncCloseDate, type CloseDateCrm } from "@/lib/routing/close-date";

vi.mock("@/lib/amocrm/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/amocrm/client")>(),
  amoFetch: vi.fn()
}));

const now = new Date("2026-11-06T10:00:00Z");
const updatedAt = Math.floor(now.getTime() / 1000);
const sourceDate = Math.floor(new Date("2026-10-21T21:00:00Z").getTime() / 1000);
const previousDate = sourceDate - 86_400;
const job = { kind: "close-date", leadId: 42, updatedAt } as const;
const formType = "application/x-www-form-urlencoded";
const noteText = "\u0414\u0430\u0442\u0430 \u0437\u0430\u043a\u0440\u044b\u0442\u0438\u044f \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0430";
const controls = () => ({ assertRunning: vi.fn(), beforeWrite: vi.fn().mockResolvedValue(undefined) });

function makeCrm() {
  let closedAt = previousDate;
  return {
    findCloseDateChanges: vi.fn().mockResolvedValue([{ occurredAt: updatedAt, value: sourceDate }]),
    getCloseDateLead: vi.fn<CloseDateCrm["getCloseDateLead"]>(async () => ({
      id: 42, pipelineId: 4908391, statusId: 142, customDate: sourceDate, closedAt
    })),
    setCloseDate: vi.fn(async (_id: number, value: number) => { closedAt = value; }),
    addCloseDateNote: vi.fn().mockResolvedValue(undefined)
  } satisfies CloseDateCrm;
}

describe("close date webhook", () => {
  it("queues only lead updates, deduplicates delivery, and keeps no raw fields", () => {
    const form = new URLSearchParams({
      "leads[update][0][id]": "42",
      "leads[update][0][last_modified]": String(updatedAt),
      "leads[update][0][name]": "private",
      "leads[update][1][id]": "42",
      "leads[update][1][updated_at]": String(updatedAt),
      "leads[status][0][id]": "43",
      "leads[status][0][last_modified]": String(updatedAt)
    });
    expect(parseCloseDateWebhook(form.toString(), formType, now)).toEqual([{
      dedupe_key: `close-date:42:${updatedAt}`, payload: job,
      next_run_at: "2026-11-06T10:00:10.000Z"
    }]);
  });

  it("skips missing, conflicting, stale and future timestamps", () => {
    expect(parseCloseDateWebhook(JSON.stringify({ leads: { update: [
      { id: 42 }, { id: 43, updated_at: updatedAt, last_modified: updatedAt - 1 },
      { id: 44, last_modified: updatedAt - 86_401 }, { id: 45, updated_at: updatedAt + 61 }
    ] } }), "application/json", now)).toEqual([]);
  });

  it("ignores conflicting form duplicates and arbitrary bracket keys", () => {
    const form = `leads[update][0][id]=42&leads[update][0][id]=43&leads[update][0][updated_at]=${updatedAt}&leads[update][__proto__][id]=45&leads[update][__proto__][updated_at]=${updatedAt}`;
    expect(parseCloseDateWebhook(form, formType, now)).toEqual([]);
  });
});

describe("closing date sync", () => {
  it.each([142, 143])("changes only the system date on closed stage %i", async (statusId) => {
    const crm = makeCrm();
    const lead = { id: 42, pipelineId: 4908391, statusId, customDate: sourceDate, closedAt: previousDate };
    crm.getCloseDateLead.mockResolvedValueOnce(lead).mockResolvedValueOnce(lead)
      .mockResolvedValueOnce({ ...lead, closedAt: sourceDate });
    const guard = controls();
    await expect(syncCloseDate(job, crm, guard)).resolves.toMatchObject({ status: "processed" });
    expect(crm.setCloseDate).toHaveBeenCalledExactlyOnceWith(42, sourceDate);
    expect(crm.addCloseDateNote).toHaveBeenCalledExactlyOnceWith(42);
    expect(guard.beforeWrite).toHaveBeenCalledBefore(crm.setCloseDate);
    expect(crm.setCloseDate).toHaveBeenCalledBefore(crm.addCloseDateNote);
  });

  it.each([
    { statusId: 44423707 }, { pipelineId: 1 }, { customDate: null },
    { customDate: sourceDate + 86_400 }, { closedAt: sourceDate + 3600 }
  ])("preserves records outside scope or already current: %j", async (override) => {
    const crm = makeCrm();
    crm.getCloseDateLead.mockResolvedValue({ id: 42, pipelineId: 4908391, statusId: 142, customDate: sourceDate, closedAt: previousDate, ...override });
    await expect(syncCloseDate(job, crm, controls())).resolves.toMatchObject({ status: "skipped" });
    expect(crm.setCloseDate).not.toHaveBeenCalled();
    expect(crm.addCloseDateNote).not.toHaveBeenCalled();
  });

  it("does not write on an unrelated update or when the latest change cleared the field", async () => {
    const crm = makeCrm();
    crm.findCloseDateChanges.mockResolvedValueOnce([{ occurredAt: updatedAt - 3, value: sourceDate }]);
    await expect(syncCloseDate(job, crm, controls())).resolves.toMatchObject({ status: "skipped" });
    crm.findCloseDateChanges.mockResolvedValueOnce([
      { occurredAt: updatedAt, value: sourceDate }, { occurredAt: updatedAt + 1, value: null }
    ]);
    await expect(syncCloseDate(job, crm, controls())).resolves.toMatchObject({ status: "skipped" });
    expect(crm.setCloseDate).not.toHaveBeenCalled();
  });

  it("does not write if the lead reopens before the final read", async () => {
    const crm = makeCrm();
    crm.getCloseDateLead
      .mockResolvedValueOnce({ id: 42, pipelineId: 4908391, statusId: 142, customDate: sourceDate, closedAt: previousDate })
      .mockResolvedValueOnce({ id: 42, pipelineId: 4908391, statusId: 44423710, customDate: sourceDate, closedAt: previousDate });
    await expect(syncCloseDate(job, crm, controls())).resolves.toMatchObject({ reason: "close_date_no_longer_current" });
    expect(crm.setCloseDate).not.toHaveBeenCalled();
  });

  it("does not create a note when the date update was not confirmed", async () => {
    const crm = makeCrm();
    crm.setCloseDate.mockRejectedValueOnce(new Error("timeout"));
    await expect(syncCloseDate(job, crm, controls())).resolves.toEqual({
      status: "needs_review", reason: "close_date_update_unconfirmed"
    });
    expect(crm.addCloseDateNote).not.toHaveBeenCalled();
  });

  it("does not create a note if the API accepted the request but did not change the date", async () => {
    const crm = makeCrm();
    crm.setCloseDate.mockResolvedValueOnce(undefined);
    await expect(syncCloseDate(job, crm, controls())).resolves.toEqual({
      status: "needs_review", reason: "close_date_update_unconfirmed"
    });
    expect(crm.addCloseDateNote).not.toHaveBeenCalled();
  });

  it("flags an ambiguous note without repeating it when the date is already current", async () => {
    const crm = makeCrm();
    crm.addCloseDateNote.mockRejectedValueOnce(new Error("timeout"));
    await expect(syncCloseDate(job, crm, controls())).resolves.toEqual({
      status: "needs_review", reason: "close_date_note_unconfirmed"
    });
    crm.getCloseDateLead.mockResolvedValueOnce({
      id: 42, pipelineId: 4908391, statusId: 142, customDate: sourceDate, closedAt: sourceDate
    });
    await expect(syncCloseDate(job, crm, controls())).resolves.toMatchObject({ status: "skipped" });
    expect(crm.addCloseDateNote).toHaveBeenCalledTimes(1);
  });

  it("queries the specific field-change event, patches closed_at and posts the exact note", async () => {
    const eventType = "custom_field_1170151_value_changed";
    const record = {
      id: 42, pipeline_id: 4908391, status_id: 142, closed_at: previousDate,
      custom_fields_values: [{ field_id: 1170151, values: [{ value: sourceDate }] }]
    };
    const fetchMock = vi.mocked(amoFetch).mockReset()
      .mockResolvedValueOnce(Response.json(record))
      .mockResolvedValueOnce(Response.json({ _embedded: { events: [{
        type: eventType, entity_type: "lead", entity_id: 42, created_at: updatedAt,
        value_after: [{ custom_field_value: { field_id: 1170151, timestamp: String(sourceDate), is_masked: false } }]
      }] } }))
      .mockResolvedValueOnce(Response.json(record))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ ...record, closed_at: sourceDate }))
      .mockResolvedValueOnce(Response.json({ _embedded: { notes: [{ id: 513 }] } }, { status: 201 }));
    const crm = createCloseDateCrm(new AbortController().signal);
    await expect(syncCloseDate(job, crm, controls())).resolves.toEqual({ status: "processed" });
    const url = new URL(fetchMock.mock.calls[1][0], "https://example.test");
    expect(url.pathname).toBe("/api/v4/events");
    expect(url.searchParams.get("filter[type]")).toBe(eventType);
    expect(url.searchParams.get("filter[entity_id]")).toBe("42");
    expect(url.searchParams.get("filter[created_at][from]")).toBe(String(updatedAt - 2));
    expect(fetchMock.mock.calls[3]).toEqual([
      "/api/v4/leads/42", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ closed_at: sourceDate }) }),
      { retry: false }
    ]);
    expect(fetchMock.mock.calls[5]).toEqual([
      "/api/v4/leads/42/notes", expect.objectContaining({
        method: "POST", body: JSON.stringify([{ note_type: "common", params: { text: noteText } }])
      }),
      { retry: false }
    ]);
  });
});
