import { sha256 } from "@/lib/utils/hash";
import { JsonObject, JsonValue, LeadChangeEvent } from "@/lib/types";

function assignBracketNotation(target: Record<string, unknown>, key: string, value: string) {
  const segments = key.replace(/\]/g, "").split("[");
  let cursor: Record<string, unknown> = target;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const isLast = index === segments.length - 1;

    if (isLast) {
      cursor[segment] = value;
      return;
    }

    const current = cursor[segment];
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      cursor[segment] = {};
    }

    cursor = cursor[segment] as Record<string, unknown>;
  }
}

function parseFormEncodedBody(rawBody: string): JsonObject {
  const payload: Record<string, unknown> = {};
  const params = new URLSearchParams(rawBody);

  for (const [key, value] of params.entries()) {
    assignBracketNotation(payload, key, value);
  }

  return payload as JsonObject;
}

function toRecordArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"));
  }

  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort((left, right) => Number(left) - Number(right))
      .map((key) => (value as Record<string, Record<string, unknown>>)[key])
      .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"));
  }

  return [];
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function createEventHash(rawBody: string, eventType: string, leadId: number, index: number): string {
  return sha256(`${rawBody}:${eventType}:${leadId}:${index}`);
}

function extractLeadEvents(
  parsedPayload: JsonValue,
  rawBody: string,
  receivedAt: string
): LeadChangeEvent[] {
  if (!parsedPayload || typeof parsedPayload !== "object" || Array.isArray(parsedPayload)) {
    return [];
  }

  const leadsRoot = (parsedPayload as Record<string, unknown>).leads;
  if (!leadsRoot || typeof leadsRoot !== "object" || Array.isArray(leadsRoot)) {
    return [];
  }

  const events: LeadChangeEvent[] = [];

  for (const [eventType, collection] of Object.entries(leadsRoot as Record<string, unknown>)) {
    const items = toRecordArray(collection);

    items.forEach((item, index) => {
      const leadId = toNumber(item.id);
      if (!leadId) {
        return;
      }

      const pipelineId =
        toNumber(item.pipeline_id) ?? toNumber(item.old_pipeline_id) ?? toNumber(item.new_pipeline_id);
      const statusId =
        toNumber(item.status_id) ?? toNumber(item.old_status_id) ?? toNumber(item.new_status_id);

      events.push({
        lead_id: leadId,
        pipeline_id: pipelineId,
        status_id: statusId,
        event_type: eventType,
        received_at: receivedAt,
        payload_hash: createEventHash(rawBody, eventType, leadId, index),
        raw_payload: {
          source: parsedPayload,
          event: item,
          event_type: eventType
        } as JsonValue
      });
    });
  }

  return events;
}

export async function parseIncomingWebhook(request: Request) {
  const rawBody = await request.text();
  const receivedAt = new Date().toISOString();
  const contentType = request.headers.get("content-type") ?? "";

  let parsedPayload: JsonValue;
  if (contentType.includes("application/json")) {
    parsedPayload = JSON.parse(rawBody) as JsonValue;
  } else {
    parsedPayload = parseFormEncodedBody(rawBody);
  }

  const events = extractLeadEvents(parsedPayload, rawBody, receivedAt);

  return {
    rawBody,
    parsedPayload,
    events
  };
}
