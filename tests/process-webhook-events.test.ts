import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/amocrm/client", () => ({ fetchLead: vi.fn(), fetchLeadKpiHistory: vi.fn(), fetchUserName: vi.fn(), patchLeadCustomFields: vi.fn() }));
vi.mock("@/lib/repositories", () => ({ enqueueSheetJobs: vi.fn(), getDealState: vi.fn(), markWebhookEventFailed: vi.fn(), markWebhookEventProcessed: vi.fn(), upsertDealState: vi.fn() }));
vi.mock("@/lib/log", () => ({ logInfo: vi.fn() }));
import { AMO_STATUS } from "@/lib/constants/amocrm";
import { fetchLead, fetchLeadKpiHistory, fetchUserName, patchLeadCustomFields } from "@/lib/amocrm/client";
import { enqueueSheetJobs, getDealState, markWebhookEventFailed, markWebhookEventProcessed, upsertDealState } from "@/lib/repositories";
import { processWebhookEvent, safelyProcessWebhookEvent } from "@/lib/services/process-webhook-events";
import { processBudgetWebhookEvent } from "@/lib/services/process-budget-webhook-events";
import { AmoLeadSnapshot, StoredDealState, WebhookEventRecord } from "@/lib/types";

const lead: AmoLeadSnapshot = {
  id: 30574649, name: "KPI regression", budget: 12500, updatedAt: "2026-10-30T07:42:12Z",
  pipelineId: 4908391, statusId: AMO_STATUS.AWAITING_COMMISSION, responsibleUserId: 7268314,
  objectType: "Входная", link: "https://dveriopt24.amocrm.ru/leads/detail/30574649",
  kpiFields: { work: {date:"28.10.2026",manager:"Филипп",amount:0}, measure: {date:"28.10.2026",manager:"Филипп",amount:1000} }
};
const measure = { stage: "measure", label: "Замер", amount: 1000, date: "28.10.2026", time: "13:58", manager: "Филипп" } as const;
const state: StoredDealState = {
  deal_id: lead.id, object_type: "Входная", is_frozen: false, active_kpis: {measure},
  kp_rows: {measure: {rowIndex: 1585, payload: {stage:"measure",date:measure.date,time:measure.time,kpiLabel:measure.label,
    leadName:lead.name,amount:1000,link:lead.link,dealId:lead.id,installDate:null}}}, zp_rows: {},
  last_budget: 12500, last_status_id: AMO_STATUS.MEASURE, last_event_received_at: null, last_synced_at: null
};
const event: WebhookEventRecord = {
  id:"evt-1",lead_id:lead.id,pipeline_id:4908391,status_id:AMO_STATUS.MEASURE,event_type:"status",
  received_at:"2026-10-30T10:00:00Z",payload_hash:"test",raw_payload:{},processing_status:"processing",process_attempts:1,last_error:null
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getDealState).mockResolvedValue(structuredClone(state));
  vi.mocked(fetchLead).mockResolvedValue(structuredClone(lead));
  vi.mocked(fetchLeadKpiHistory).mockResolvedValue({install:{occurredAt:"2026-10-30T07:41:48Z",manager:"Филипп"}});
  vi.mocked(fetchUserName).mockResolvedValue("Филипп");
});

for (const [name, handler] of [["status",processWebhookEvent],["budget",processBudgetWebhookEvent]] as const) {
  describe(`${name} KPI reconciliation`, () => {
    it("restores skipped installation even with unchanged budget, using the live stage", async () => {
      await handler({...event,event_type:name === "budget" ? "budget_sync" : "status"});
      expect(patchLeadCustomFields).toHaveBeenCalledWith(lead.id, [
        {fieldId:1164537,value:"30.10.2026"},{fieldId:1164539,value:"Филипп"},{fieldId:1164541,value:1000}
      ]);
      expect(enqueueSheetJobs).toHaveBeenCalledWith([expect.objectContaining({row_key:`${lead.id}:KP new:install`,payload:expect.objectContaining({row:expect.objectContaining({date:"30.10.2026",time:"10:41",amount:1000})})})]);
      expect(vi.mocked(upsertDealState).mock.calls[0][0].active_kpis).toEqual({measure,install:expect.objectContaining({amount:1000,manager:"Филипп"})});
    });

    it("initializes missing state when the budget arrives after skipped stages", async () => {
      vi.mocked(getDealState).mockResolvedValue(null);
      await handler(event);
      expect(vi.mocked(upsertDealState).mock.calls[0][0].active_kpis.install?.amount).toBe(1000);
      expect(vi.mocked(upsertDealState).mock.calls[0][0].active_kpis.work).toBeUndefined();
    });

    it("does not duplicate rows or reset capture metadata on repeat processing", async () => {
      await handler(event);
      const next = vi.mocked(upsertDealState).mock.calls[0][0];
      const jobs = vi.mocked(enqueueSheetJobs).mock.calls[0][0];
      for (const job of jobs) next.kp_rows[job.payload.stage] = {rowIndex:1600,payload:job.payload.row};
      vi.mocked(getDealState).mockResolvedValue(next);
      vi.mocked(fetchLead).mockResolvedValue({...lead,kpiFields:{...lead.kpiFields,install:{date:"30.10.2026",manager:"Филипп",amount:1000}}});
      vi.mocked(enqueueSheetJobs).mockClear();
      vi.mocked(patchLeadCustomFields).mockClear();
      await handler({...event,received_at:"2026-10-30T10:05:00Z"});
      expect(enqueueSheetJobs).toHaveBeenCalledWith([]);
      expect(patchLeadCustomFields).toHaveBeenCalledWith(lead.id,[]);
    });

    it("skips stale events before touching CRM or Sheets", async () => {
      vi.mocked(getDealState).mockResolvedValue({...state,last_event_received_at:"2026-10-30T11:00:00Z"});
      await handler(event);
      expect(fetchLead).not.toHaveBeenCalled();
      expect(upsertDealState).not.toHaveBeenCalled();
      expect(markWebhookEventProcessed).toHaveBeenCalledWith(event.id);
    });
  });
}

it("zeroes money on refusal while preserving captured dates and managers", async () => {
  vi.mocked(fetchLead).mockResolvedValue({...lead,statusId:AMO_STATUS.REFUSED});
  await processWebhookEvent(event);
  expect(patchLeadCustomFields).toHaveBeenCalledWith(lead.id,[{fieldId:1164535,value:0},{fieldId:1164541,value:0}]);
  expect(vi.mocked(upsertDealState).mock.calls[0][0].active_kpis).toEqual({});
  expect(vi.mocked(enqueueSheetJobs).mock.calls[0][0][0]).toMatchObject({job_type:"zero",payload:{row:{amount:0}}});
});

it("does not overwrite frozen amounts or object type on budget changes after commission", async () => {
  vi.mocked(getDealState).mockResolvedValue({...state,is_frozen:true,last_status_id:AMO_STATUS.COMMISSION_RECEIVED});
  vi.mocked(fetchLead).mockResolvedValue({...lead,statusId:AMO_STATUS.COMMISSION_RECEIVED,budget:99999,objectType:"Откосы"});
  await processBudgetWebhookEvent(event);
  expect(vi.mocked(upsertDealState).mock.calls[0][0]).toMatchObject({object_type:"Входная",active_kpis:{measure:{amount:1000}}});
  expect(fetchLeadKpiHistory).not.toHaveBeenCalled();
  expect(vi.mocked(patchLeadCustomFields).mock.calls[0][1].some(m => m.value === 8000)).toBe(false);
});

it("skips unsupported live statuses and excluded responsible users", async () => {
  for (const changed of [{statusId:999999},{responsibleUserId:8445565},{pipelineId:1}]) {
    vi.mocked(fetchLead).mockResolvedValue({...lead,...changed});
    await processWebhookEvent(event);
  }
  expect(patchLeadCustomFields).not.toHaveBeenCalled();
  expect(upsertDealState).not.toHaveBeenCalled();
});

it("records a retry if CRM history fails instead of inventing capture dates", async () => {
  vi.mocked(fetchLeadKpiHistory).mockRejectedValue(new Error("history unavailable"));
  await safelyProcessWebhookEvent(event);
  expect(patchLeadCustomFields).not.toHaveBeenCalled();
  expect(markWebhookEventFailed).toHaveBeenCalledWith(event.id,1,"history unavailable");
});

it("recalculates late budget for both stages, retaining historical dates and confirmed sheet pointers", async () => {
  const previous = structuredClone(state);
  previous.last_budget = 0;
  previous.active_kpis.measure!.amount = 0;
  previous.kp_rows.measure!.payload.amount = 0;
  vi.mocked(getDealState).mockResolvedValue(previous);
  vi.mocked(fetchLead).mockResolvedValue({...lead,kpiFields:{...lead.kpiFields,measure:{date:"28.10.2026",manager:"Филипп",amount:0}}});
  await processBudgetWebhookEvent(event);
  expect(patchLeadCustomFields).toHaveBeenCalledWith(lead.id,expect.arrayContaining([
    {fieldId:1164535,value:1000},{fieldId:1164541,value:1000}
  ]));
  const saved = vi.mocked(upsertDealState).mock.calls[0][0];
  expect(saved.active_kpis.measure).toEqual(measure);
  expect(saved.kp_rows.measure!.payload.amount).toBe(0);
  expect(vi.mocked(enqueueSheetJobs).mock.calls[0][0]).toHaveLength(2);
});

it("freezes the first commission calculation and queues salary rows for both eligible stages", async () => {
  vi.mocked(fetchLead).mockResolvedValue({...lead,statusId:AMO_STATUS.COMMISSION_RECEIVED});
  await processWebhookEvent(event);
  const next = vi.mocked(upsertDealState).mock.calls[0][0];
  expect(next.is_frozen).toBe(true);
  expect(next.active_kpis.measure?.amount).toBe(1000);
  expect(next.active_kpis.install?.amount).toBe(1000);
  const salaryJobs = vi.mocked(enqueueSheetJobs).mock.calls[0][0].filter(j => j.sheet_name === "ЗП new");
  expect(salaryJobs).toHaveLength(2);
  expect(salaryJobs.every(j => j.payload.row.amount === 1000)).toBe(true);
});

it("keeps entrance work at zero even when a nonzero budget is entered on the work stage", async () => {
  vi.mocked(getDealState).mockResolvedValue(null);
  vi.mocked(fetchLead).mockResolvedValue({...lead,statusId:AMO_STATUS.WORK,kpiFields:{work:{date:"28.10.2026",manager:"Филипп",amount:1000}}});
  await processWebhookEvent(event);
  expect(patchLeadCustomFields).toHaveBeenCalledWith(lead.id,expect.arrayContaining([{fieldId:1164529,value:0}]));
  expect(vi.mocked(upsertDealState).mock.calls[0][0].active_kpis).toEqual({});
  expect(enqueueSheetJobs).toHaveBeenCalledWith([]);
});
