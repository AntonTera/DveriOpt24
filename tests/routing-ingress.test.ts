import { describe, expect, it } from "vitest";
import { parseRoutingWebhook } from "@/lib/routing/ingress";

const now = new Date("2026-11-05T10:15:30.125Z");
const delayed = "2026-11-05T10:16:30.125Z";
const formType = "application/x-www-form-urlencoded; charset=UTF-8";
const inbound = {
  id: "m-14",
  entity_id: "41",
  entity_type: "lead",
  origin: "com.wazzup24.wz",
  author: { type: "external", name: "Customer" },
  text: "private text"
};

function parseJson(payload: unknown) {
  return parseRoutingWebhook(JSON.stringify(payload), "application/json; charset=utf-8", now);
}

function parseForm(entries: Record<string, string>) {
  return parseRoutingWebhook(new URLSearchParams(entries).toString(), formType, now);
}

describe("parseRoutingWebhook", () => {
  it("parses nested JSON collections, deduplicates by event identity, and excludes PII and status events", () => {
    const jobs = parseJson([
      { leads: { status: [{ id: 99 }], add: { 0: [{ id: "41", name: "Customer" }], 3: { id: 41 } } } },
      { 1: { task: { add: [{ id: 41, text: "private task" }] } } },
      { tasks: { add: { id: 41 } }, message: { add: [inbound, { ...inbound, text: "edited text" }] } }
    ]);

    expect(jobs).toEqual([
      { dedupe_key: "lead:41", payload: { kind: "lead", leadId: 41 }, next_run_at: delayed },
      { dedupe_key: "task:41", payload: { kind: "task", taskId: 41 }, next_run_at: delayed },
      {
        dedupe_key: "message:m-14",
        payload: { kind: "message", leadId: 41, messageId: "m-14", channel: "wazzup" },
        next_run_at: now.toISOString()
      }
    ]);
  });

  it("accepts the legacy form paths, including nested message author and singular task", () => {
    expect(parseForm({
      "account[subdomain]": "irrelevant",
      "leads[add][0][id]": "41",
      "leads[status][0][id]": "99",
      "task[add][0][id]": "42",
      "tasks[add][4][id]": "42",
      "message[add][0][id]": "msg+17",
      "message[add][0][entity_id]": "41",
      "message[add][0][entity_type]": "leads",
      "message[add][0][origin]": "telegram",
      "message[add][0][author][type]": "external",
      "message[add][0][text]": "private text"
    })).toEqual([
      { dedupe_key: "lead:41", payload: { kind: "lead", leadId: 41 }, next_run_at: delayed },
      { dedupe_key: "task:42", payload: { kind: "task", taskId: 42 }, next_run_at: delayed },
      {
        dedupe_key: "message:msg+17",
        payload: { kind: "message", leadId: 41, messageId: "msg+17", channel: "telegram" },
        next_run_at: now.toISOString()
      }
    ]);
  });

  it("accepts VK and keeps distinct message IDs for the same lead", () => {
    const jobs = parseJson({ message: { add: [
      { ...inbound, id: "vk-1", origin: "vk", entity_id: 41 },
      { ...inbound, id: "vk-2", origin: "vk", entity_id: 41 }
    ] } });

    expect(jobs.map(({ dedupe_key }) => dedupe_key)).toEqual(["message:vk-1", "message:vk-2"]);
    expect(jobs[0]?.payload).toEqual({ kind: "message", leadId: 41, messageId: "vk-1", channel: "vk" });
  });

  it.each([
    { author: { type: "internal" } }, { author: {} }, { author: "external" },
    { entity_type: "contact" }, { entity_type: undefined }, { entity_id: "0" },
    { origin: "whatsapp" }, { origin: "constructor" }, { id: 14 }, { id: "   " }, { id: undefined }
  ])("ignores invalid message fields %j", (fields) => {
    expect(parseJson({ message: { add: [{ ...inbound, ...fields }] } })).toEqual([]);
  });

  it("rejects unsafe and non-decimal lead and task IDs", () => {
    const invalid = [0, -1, 1.25, Number.MAX_SAFE_INTEGER + 1, true, null,
      "", "0", "-1", "1.5", "1e3", "0x10", "9007199254740992", [1]].map((id) => ({ id }));

    expect(parseJson({ leads: { add: [...invalid, { id: Number.MAX_SAFE_INTEGER }] }, task: { add: invalid } }))
      .toEqual([{
        dedupe_key: `lead:${Number.MAX_SAFE_INTEGER}`,
        payload: { kind: "lead", leadId: Number.MAX_SAFE_INTEGER },
        next_run_at: delayed
      }]);
  });

  it("does not follow arbitrary JSON paths or accept unrelated webhook events", () => {
    expect(parseJson({
      leads: { status: [{ id: 11 }], add: { arbitrary: { id: 12 } } },
      task: { update: [{ id: 13 }] },
      wrapper: { leads: { add: [{ id: 14 }] } },
      message: { update: [inbound] }
    })).toEqual([]);
  });

  it("does not parse arbitrary, malformed, or prototype-sensitive form keys", () => {
    expect(parseForm({
      "__proto__[leads][add][0][id]": "51",
      "leads[add][constructor][prototype][id]": "52",
      "leads[add][__proto__][id]": "53",
      "leads[add][custom][id]": "54",
      "leads[add][0][id": "55",
      "message[add][0][id]": "invalid-author",
      "message[add][0][entity_id]": "41",
      "message[add][0][entity_type]": "lead",
      "message[add][0][origin]": "vk",
      "message[add][0][author][__proto__][type]": "external",
      "task[add][0][id]": "56"
    })).toEqual([{ dedupe_key: "task:56", payload: { kind: "task", taskId: 56 }, next_run_at: delayed }]);
    expect(Object.hasOwn(Object.prototype, "id")).toBe(false);
  });

  it("skips a form event with conflicting values for a routing field", () => {
    const rawBody = "leads[add][0][id]=41&leads[add][0][id]=42&task[add][0][id]=41&task[add][0][id]=41";

    expect(parseRoutingWebhook(rawBody, formType, now))
      .toEqual([{ dedupe_key: "task:41", payload: { kind: "task", taskId: 41 }, next_run_at: delayed }]);
  });

  it("rejects an oversized batch instead of silently dropping unique jobs", () => {
    const items = [{ id: 1 }, ...Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }))];
    const form = (batch: typeof items) => Object.fromEntries(batch.map(({ id }, index) => [`leads[add][${index}][id]`, String(id)]));
    expect(parseJson({ leads: { add: items } })).toHaveLength(100);
    expect(parseForm(form(items))).toHaveLength(100);
    items.push({ id: 101 });
    expect(() => parseJson({ leads: { add: items } })).toThrow(RangeError);
    expect(() => parseForm(form(items))).toThrow(RangeError);
  });

  it("skips over-deep paths without losing shallow events", () => {
    let nested: unknown = { id: 41 };
    for (let index = 0; index < 50; index += 1) nested = [nested];

    expect(parseJson({ leads: { add: [nested, { id: 42 }] } }).map((job) => job.dedupe_key)).toEqual(["lead:42"]);
    expect(parseForm({
      [`leads[add]${"[0]".repeat(50)}[id]`]: "41",
      "leads[add][1][id]": "42"
    }).map((job) => job.dedupe_key)).toEqual(["lead:42"]);
  });

  it("throws on malformed JSON instead of treating it as a form or an empty delivery", () => {
    expect(() => parseRoutingWebhook('{"leads":', "application/json", now)).toThrow(SyntaxError);
  });
});
