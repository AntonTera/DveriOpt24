export type RoutingChannel = "wazzup" | "telegram" | "vk";

export type RoutingEvent =
  | { kind: "lead"; leadId: number }
  | { kind: "task"; taskId: number }
  | { kind: "message"; leadId: number; messageId: string; channel: RoutingChannel };

export interface RoutingIngressJob {
  dedupe_key: string;
  payload: RoutingEvent;
  next_run_at: string;
}

const SOURCES = ["leads", "task", "tasks", "message"] as const;
const MAX_JOBS = 100;
const MAX_INDEX_DEPTH = 12;
const MAX_BODY_LENGTH = 1024 * 1024;
const MAX_MESSAGE_ID_LENGTH = 255;
const DECIMAL = /^\d+$/;
const FORM_FIELD = new RegExp(String.raw`^(leads|tasks?|message)\[add\]((?:\[\d+\]){0,${MAX_INDEX_DEPTH}})(?:\[(id|entity_id|entity_type|origin)\]|\[author\]\[type\])$`);

type Source = (typeof SOURCES)[number];
type Field = "id" | "entity_id" | "entity_type" | "origin" | "author.type";
type Candidate = [source: Source, read: (field: Field) => unknown];
type JsonRecord = Record<string, unknown>;

function ownField(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key)
    ? (value as JsonRecord)[key]
    : undefined;
}

function* indexedRecords(value: unknown, depth = 0): Generator<[JsonRecord, number]> {
  if (depth > MAX_INDEX_DEPTH || value === null || typeof value !== "object") return;

  const record = value as JsonRecord;
  if (!Array.isArray(value)) yield [record, depth];
  if (depth === MAX_INDEX_DEPTH) return;

  for (const key of Object.keys(record)) {
    if (DECIMAL.test(key)) yield* indexedRecords(record[key], depth + 1);
  }
}

function* jsonCandidates(payload: unknown): Generator<Candidate> {
  for (const [root, depth] of indexedRecords(payload)) {
    for (const source of SOURCES) {
      const added = ownField(ownField(root, source), "add");
      for (const [item] of indexedRecords(added, depth)) {
        yield [source, (field) => field === "author.type"
          ? ownField(ownField(item, "author"), "type")
          : ownField(item, field)];
      }
    }
  }
}

function* formCandidates(rawBody: string): Generator<Candidate> {
  const items = new Map<string, { source: Source; fields: Map<string, string>; conflict: boolean }>();

  // Group only the fixed routing fields; never build an object from bracket keys.
  for (const [key, value] of new URLSearchParams(rawBody)) {
    const match = FORM_FIELD.exec(key);
    if (!match) continue;

    const source = match[1] as Source;
    const field = match[3] ?? "author.type";
    if (source !== "message" && field !== "id") continue;

    const path = `${source}${match[2]}`;
    let item = items.get(path);
    if (!item) {
      item = { source, fields: new Map(), conflict: false };
      items.set(path, item);
    }

    const previous = item.fields.get(field);
    if (previous !== undefined && previous !== value) item.conflict = true;
    item.fields.set(field, value);
  }

  for (const { source, fields, conflict } of items.values()) {
    if (!conflict) yield [source, (field) => fields.get(field)];
  }
}

function positiveId(value: unknown): number | null {
  const id = typeof value === "string" && DECIMAL.test(value) ? Number(value) : value;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

function routingChannel(origin: unknown): RoutingChannel | null {
  if (origin === "com.wazzup24.wz") return "wazzup";
  if (origin === "telegram" || origin === "vk") return origin;
  return null;
}

function toEvent([source, read]: Candidate): RoutingEvent | null {
  const id = read("id");
  if (source !== "message") {
    const entityId = positiveId(id);
    if (entityId === null) return null;
    return source === "leads" ? { kind: "lead", leadId: entityId } : { kind: "task", taskId: entityId };
  }

  if (typeof id !== "string" || id.length === 0 || id.length > MAX_MESSAGE_ID_LENGTH || id.trim() !== id ||
      /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(id) || read("author.type") !== "external") return null;

  const entityType = read("entity_type");
  if (entityType !== "lead" && entityType !== "leads") return null;

  const leadId = positiveId(read("entity_id"));
  const channel = routingChannel(read("origin"));
  return leadId !== null && channel !== null ? { kind: "message", leadId, messageId: id, channel } : null;
}

export function parseRoutingWebhook(rawBody: string, contentType: string, now: Date): RoutingIngressJob[] {
  if (rawBody.length > MAX_BODY_LENGTH) throw new Error("Routing webhook body is too large");

  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  const isJson = mediaType === "application/json" || mediaType.endsWith("+json");
  if (!isJson && mediaType !== "application/x-www-form-urlencoded" && mediaType !== "") return [];

  const candidates = isJson ? jsonCandidates(JSON.parse(rawBody)) : formCandidates(rawBody);
  const dueNow = now.toISOString();
  const dueLater = new Date(now.getTime() + 60_000).toISOString();
  const jobs = new Map<string, RoutingIngressJob>();

  for (const candidate of candidates) {
    const event = toEvent(candidate);
    if (!event) continue;

    const id = event.kind === "message" ? event.messageId : event.kind === "lead" ? event.leadId : event.taskId;
    const dedupeKey = `${event.kind}:${id}`;
    if (jobs.has(dedupeKey)) continue;

    jobs.set(dedupeKey, {
      dedupe_key: dedupeKey,
      payload: event,
      next_run_at: event.kind === "message" ? dueNow : dueLater
    });
    if (jobs.size > MAX_JOBS) throw new RangeError("Routing webhook event limit exceeded");
  }

  return [...jobs.values()];
}
