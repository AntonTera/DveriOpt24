import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({
    AMOCRM_BASE_URL: "https://dveriopt24.amocrm.ru",
    AMOCRM_LONG_LIVED_TOKEN: "token",
    AMOCRM_MIN_REQUEST_INTERVAL_MS: 220,
    AMOCRM_MAX_RETRIES: 4,
    AMOCRM_RETRY_BASE_DELAY_MS: 500,
    AMOCRM_RETRY_MAX_DELAY_MS: 5000
  })
}));

vi.mock("@/lib/utils/sleep", () => ({
  sleep: vi.fn().mockResolvedValue(undefined)
}));

import { fetchLead, patchLeadCustomFields, resetAmoClientStateForTests } from "@/lib/amocrm/client";
import { createRoutingCrm } from "@/lib/routing/crm";
import { sleep } from "@/lib/utils/sleep";

const sleepMock = vi.mocked(sleep);

function makeJsonResponse(body: unknown, status = 200, headers?: Record<string, string>) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string) {
        return headers?.[name.toLowerCase()] ?? headers?.[name] ?? null;
      }
    },
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(typeof body === "string" ? body : JSON.stringify(body))
  } as unknown as Response;
}

describe("amocrm client retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAmoClientStateForTests();
  });

  it("retries temporary amoCRM errors and respects retry-after", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeJsonResponse("busy", 429, { "retry-after": "2" }))
      .mockResolvedValueOnce(
        makeJsonResponse({
          id: 42,
          name: "Deal",
          price: 100000,
          updated_at: 1776410000,
          pipeline_id: 4908391,
          status_id: 44423716,
          responsible_user_id: 12043998,
          custom_fields_values: []
        })
      );

    vi.stubGlobal("fetch", fetchMock);

    const lead = await fetchLead(42);

    expect(lead.id).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledWith(2000);
  });

  it("retries network failures before succeeding", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(makeJsonResponse({}, 200));

    vi.stubGlobal("fetch", fetchMock);

    await patchLeadCustomFields(42, [{ fieldId: 1164529, value: 0 }]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledWith(500);
  });

  it("does not retry non-retryable amoCRM responses", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(makeJsonResponse("bad request", 400));

    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchLead(42)).rejects.toThrow("amoCRM request failed (400)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([new TypeError("fetch failed"), makeJsonResponse("unavailable", 503)])(
    "does not retry an uncertain reply task creation: %s", async (failure) => {
      const fetchMock = vi.fn();
      if (failure instanceof Error) fetchMock.mockRejectedValue(failure);
      else fetchMock.mockResolvedValue(failure);
      vi.stubGlobal("fetch", fetchMock);
      await expect(createRoutingCrm().createReplyTask(42, 7268314, "Reply", 1776410000)).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1]).toMatchObject({
        method: "POST",
        body: JSON.stringify([{
          entity_type: "leads", entity_id: 42, responsible_user_id: 7268314, text: "Reply", complete_till: 1776410000
        }])
      });
    }
  );

  it("only confirms a reply task creation with an assigned task ID", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeJsonResponse({ _embedded: { tasks: [{ id: 5 }] } }))
      .mockResolvedValueOnce(makeJsonResponse({ _embedded: { tasks: [] } }));
    vi.stubGlobal("fetch", fetchMock);
    const crm = createRoutingCrm();
    await expect(crm.createReplyTask(42, 7268314, "Reply", 1776410000)).resolves.toBeUndefined();
    await expect(crm.createReplyTask(42, 7268314, "Reply", 1776410000)).rejects.toThrow("not confirmed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

it("reads existing KPI fields without losing zero amounts or Moscow dates", async () => {
  resetAmoClientStateForTests();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeJsonResponse({
    id:42,name:"Deal",price:12500,pipeline_id:4908391,status_id:44616259,responsible_user_id:7268314,
    custom_fields_values:[
      {field_id:1020845,values:[{value:"Входная"}]},
      {field_id:1164529,values:[{value:"0"}]},
      {field_id:1164537,values:[{value:1793307600}]},
      {field_id:1164539,values:[{value:"Филипп"}]},
      {field_id:1164541,values:[{value:"1000"}]}
    ]
  })));
  const lead = await fetchLead(42);
  expect(lead.kpiFields?.work?.amount).toBe(0);
  expect(lead.kpiFields?.install).toEqual({date:"30.10.2026",manager:"Филипп",amount:1000});
  expect(lead.kpiFields?.measure).toEqual({date:null,manager:null,amount:null});
});

it("paginates filtered stage history and resolves a skipped installation", async () => {
  const { fetchLeadKpiHistory } = await import("@/lib/amocrm/client");
  resetAmoClientStateForTests();
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(makeJsonResponse({_embedded:{events:[{
      id:"b",type:"lead_status_changed",created_at:1793346108,
      value_before:[{lead_status:{id:44423716,pipeline_id:4908391}}],
      value_after:[{lead_status:{id:44616259,pipeline_id:4908391}}]
    }]},_links:{next:{href:"ignored"}}}))
    .mockResolvedValueOnce(makeJsonResponse({_embedded:{events:[]}}));
  vi.stubGlobal("fetch",fetchMock);
  const result = await fetchLeadKpiHistory({id:42,name:"Deal",budget:12500,updatedAt:"2026-10-30T09:00:00Z",
    pipelineId:4908391,statusId:44616259,responsibleUserId:7268314,objectType:"Входная",link:""});
  expect(result.install).toEqual({occurredAt:"2026-10-30T07:41:48.000Z",manager:"Филипп"});
  const first = new URL(fetchMock.mock.calls[0][0]);
  const second = new URL(fetchMock.mock.calls[1][0]);
  expect(first.searchParams.getAll("filter[type][]")).toEqual(["lead_status_changed","entity_responsible_changed"]);
  expect(first.searchParams.get("filter[entity_id][]")).toBe("42");
  expect(second.searchParams.get("page")).toBe("2");
});
