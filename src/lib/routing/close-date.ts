import { amoFetch, AmoCrmResponseError } from "@/lib/amocrm/client";
import { AMO_STATUS, MAIN_PIPELINE_ID } from "@/lib/constants/amocrm";
import { formatDisplayDate } from "@/lib/utils/datetime";
import type { RoutingEnqueueJob } from "./handlers";

const CLOSE_DATE_FIELD_ID = 1170151;
const EVENT_TYPE = `custom_field_${CLOSE_DATE_FIELD_ID}_value_changed`;
const EVENT_TOLERANCE_SECONDS = 2;
const MAX_JOBS = 100;
const CLOSE_DATE_NOTE = "\u0414\u0430\u0442\u0430 \u0437\u0430\u043a\u0440\u044b\u0442\u0438\u044f \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0430";

export type CloseDateJob = { kind: "close-date"; leadId: number; updatedAt: number };
type CloseDateLead = {
  id: number; pipelineId: number; statusId: number; customDate: number | null; closedAt: number | null;
};
type CloseDateChange = { occurredAt: number; value: number | null };
export type CloseDateCrm = {
  getCloseDateLead: (id: number) => Promise<CloseDateLead | null>;
  findCloseDateChanges: (id: number, updatedAt: number) => Promise<CloseDateChange[]>;
  setCloseDate: (id: number, closedAt: number) => Promise<void>;
  addCloseDateNote: (id: number) => Promise<void>;
};
type WriteGuard = { assertRunning: () => void; beforeWrite: () => Promise<void> };

function positiveInteger(value: unknown): number | null {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

function timestamp(value: unknown) {
  const seconds = positiveInteger(value);
  return seconds !== null && seconds < 10_000_000_000 ? seconds : null;
}

function* formUpdates(raw: string) {
  const rows = new Map<string, Record<string, unknown> | null>();
  for (const [key, value] of new URLSearchParams(raw)) {
    const match = /^leads\[update\]\[(\d+)\]\[(id|updated_at|last_modified)\]$/.exec(key);
    if (!match) continue;
    const [, index, field] = match;
    const row = rows.has(index) ? rows.get(index) : {};
    if (row) rows.set(index, row[field] !== undefined && row[field] !== value ? null : { ...row, [field]: value });
  }
  yield* rows.values();
}

function jsonUpdates(raw: string): unknown[] {
  const items = JSON.parse(raw)?.leads?.update;
  return items && typeof items === "object" ? Object.keys(items).filter((key) => /^\d+$/.test(key)).map((key) => items[key]) : [];
}

export function parseCloseDateWebhook(raw: string, contentType: string, now: Date): RoutingEnqueueJob[] {
  const media = contentType.split(";", 1)[0].trim().toLowerCase();
  const rows = media === "application/json" || media.endsWith("+json") ? jsonUpdates(raw)
    : media === "application/x-www-form-urlencoded" || !media ? formUpdates(raw) : [];
  const jobs = new Map<string, RoutingEnqueueJob>();
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  const nextRun = new Date(now.getTime() + 10_000).toISOString();

  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const { id, last_modified, updated_at } = row as Record<string, unknown>;
    const leadId = positiveInteger(id);
    const updatedAt = timestamp(updated_at ?? last_modified);
    if (leadId === null || updatedAt === null || updatedAt < nowSeconds - 86_400 || updatedAt > nowSeconds + 60 ||
        (last_modified != null && timestamp(last_modified) !== updatedAt)) continue;
    const key = `close-date:${leadId}:${updatedAt}`;
    jobs.set(key, { dedupe_key: key, payload: { kind: "close-date", leadId, updatedAt }, next_run_at: nextRun });
    if (jobs.size > MAX_JOBS) throw new RangeError("Close date webhook event limit exceeded");
  }
  return [...jobs.values()];
}

function isClosedInMainPipeline(lead: CloseDateLead | null): lead is CloseDateLead {
  return lead?.pipelineId === MAIN_PIPELINE_ID &&
    (lead.statusId === AMO_STATUS.COMMISSION_RECEIVED || lead.statusId === AMO_STATUS.REFUSED);
}

function sameDay(a: number | null, b: number) {
  return a !== null && formatDisplayDate(new Date(a * 1_000)) === formatDisplayDate(new Date(b * 1_000));
}

export async function syncCloseDate(job: CloseDateJob, crm: CloseDateCrm, { assertRunning, beforeWrite }: WriteGuard) {
  const skip = (reason: string) => ({ status: "skipped", reason } as const);
  const lead = await crm.getCloseDateLead(job.leadId);
  if (!isClosedInMainPipeline(lead)) return skip("lead_not_closed_in_main_pipeline");
  if (lead.customDate === null) return skip("custom_close_date_missing");
  if (sameDay(lead.closedAt, lead.customDate)) return skip("close_date_already_current");

  const changes = (await crm.findCloseDateChanges(job.leadId, job.updatedAt))
    .filter(({ occurredAt }) => Math.abs(occurredAt - job.updatedAt) <= EVENT_TOLERANCE_SECONDS);
  const latest = Math.max(...changes.map(({ occurredAt }) => occurredAt));
  const values = new Set(changes.filter(({ occurredAt }) => occurredAt === latest).map(({ value }) => value));
  if (values.size !== 1 || !values.has(lead.customDate)) return skip("close_date_change_not_confirmed");

  const current = await crm.getCloseDateLead(job.leadId);
  if (!isClosedInMainPipeline(current) || current.customDate !== lead.customDate) return skip("close_date_no_longer_current");
  if (sameDay(current.closedAt, current.customDate)) return skip("close_date_already_current");

  assertRunning();
  await beforeWrite();
  try {
    assertRunning();
    await crm.setCloseDate(current.id, current.customDate);
    const updated = await crm.getCloseDateLead(current.id);
    if (!isClosedInMainPipeline(updated) || !sameDay(updated.closedAt, current.customDate)) {
      return { status: "needs_review", reason: "close_date_update_unconfirmed" } as const;
    }
  } catch {
    return { status: "needs_review", reason: "close_date_update_unconfirmed" } as const;
  }
  try {
    assertRunning();
    await crm.addCloseDateNote(current.id);
  } catch {
    return { status: "needs_review", reason: "close_date_note_unconfirmed" } as const;
  }
  return { status: "processed" } as const;
}

type AmoCloseDateLead = {
  id: number; pipeline_id: number; status_id: number; closed_at?: unknown;
  custom_fields_values?: { field_id: number; values?: { value: unknown }[] }[] | null;
};
type AmoCloseDateEvent = {
  type: string; entity_id: number; entity_type: string; created_at: number;
  value_after?: { custom_field_value?: { field_id?: number; timestamp?: unknown; is_masked?: boolean } }[] | null;
};

export function createCloseDateCrm(signal: AbortSignal): CloseDateCrm {
  const init = { signal, redirect: "error" } as const;
  return {
    async getCloseDateLead(id) {
      try {
        const response = await amoFetch(`/api/v4/leads/${id}`, init);
        if (response.status === 204) return null;
        const lead = await response.json() as AmoCloseDateLead;
        if (lead.id !== id) return null;
        const values = lead.custom_fields_values?.find(({ field_id }) => field_id === CLOSE_DATE_FIELD_ID)?.values;
        return {
          id, pipelineId: lead.pipeline_id, statusId: lead.status_id, closedAt: timestamp(lead.closed_at),
          customDate: values?.length === 1 ? timestamp(values[0].value) : null
        };
      } catch (error) {
        if (error instanceof AmoCrmResponseError && error.status === 404) return null;
        throw error;
      }
    },
    async findCloseDateChanges(id, updatedAt) {
      const query = new URLSearchParams({
        "filter[entity]": "lead", "filter[entity_id]": String(id), "filter[type]": EVENT_TYPE,
        "filter[created_at][from]": String(updatedAt - EVENT_TOLERANCE_SECONDS),
        "filter[created_at][to]": String(updatedAt + EVENT_TOLERANCE_SECONDS), limit: "50"
      });
      const response = await amoFetch(`/api/v4/events?${query}`, init);
      if (response.status === 204) return [];
      const result = await response.json() as { _embedded?: { events?: AmoCloseDateEvent[] }; _links?: { next?: unknown } };
      if (result._links?.next) throw new Error("Too many close date events");
      return (result._embedded?.events ?? [])
        .filter((event) => event.type === EVENT_TYPE && event.entity_id === id && event.entity_type === "lead")
        .map((event) => {
          const field = event.value_after?.length === 1 ? event.value_after[0].custom_field_value : null;
          const value = field?.field_id === CLOSE_DATE_FIELD_ID && !field.is_masked ? timestamp(field.timestamp) : null;
          return { occurredAt: event.created_at, value };
        });
    },
    async setCloseDate(id, closedAt) {
      const response = await amoFetch(`/api/v4/leads/${id}`, {
        ...init, method: "PATCH", body: JSON.stringify({ closed_at: closedAt })
      }, { retry: false });
      await response.body?.cancel();
    },
    async addCloseDateNote(id) {
      const response = await amoFetch(`/api/v4/leads/${id}/notes`, {
        ...init, method: "POST", body: JSON.stringify([{ note_type: "common", params: { text: CLOSE_DATE_NOTE } }])
      }, { retry: false });
      const result = await response.json() as { _embedded?: { notes?: { id?: unknown }[] } };
      if (!positiveInteger(result._embedded?.notes?.[0]?.id)) throw new Error("Close date note was not confirmed");
    }
  };
}
