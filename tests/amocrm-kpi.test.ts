import { describe, expect, it } from "vitest";
import { AMO_STATUS, getStatusSort } from "@/lib/constants/amocrm";
import { missingKpiHistoryStages, resolveLeadStageHistory, shouldHandleAmoKpiStatus, type AmoHistoryEvent } from "@/lib/domain/amocrm-kpi";
import { AmoLeadSnapshot } from "@/lib/types";

const lead: AmoLeadSnapshot = {
  id: 30574649, name: "KPI regression", budget: 12500, updatedAt: "2026-10-30T07:41:48Z",
  pipelineId: 4908391, statusId: AMO_STATUS.AWAITING_COMMISSION,
  responsibleUserId: 7268314, objectType: "Входная", link: "https://dveriopt24.amocrm.ru/leads/detail/30574649"
};
function transition(id: string, at: number, before: number, after: number, pipelineId = 4908391): AmoHistoryEvent {
  return { id, type: "lead_status_changed", created_at: at,
    value_before: [{ lead_status: { id: before, pipeline_id: pipelineId } }],
    value_after: [{ lead_status: { id: after, pipeline_id: pipelineId } }] };
}

describe("KPI stage history", () => {
  it("recognizes all live pipeline stages in order", () => {
    const stages = [AMO_STATUS.NEW, AMO_STATUS.WORK, AMO_STATUS.NEED_IDENTIFIED, AMO_STATUS.MEASURE,
      AMO_STATUS.AWAITING_ARRIVAL, AMO_STATUS.MEASURE_COMPLETED, AMO_STATUS.INSTALL,
      AMO_STATUS.AWAITING_COMMISSION, AMO_STATUS.SALARY_RECONCILED, AMO_STATUS.COMMISSION_RECEIVED];
    expect(stages.every(shouldHandleAmoKpiStatus)).toBe(true);
    expect(stages.map(getStatusSort)).toEqual([10,20,30,40,50,60,70,80,90,10000]);
    expect(shouldHandleAmoKpiStatus(999999)).toBe(false);
    expect(shouldHandleAmoKpiStatus(null)).toBe(false);
  });

  it("recovers the installation date from a skipped-stage transition", () => {
    const result = resolveLeadStageHistory(lead, [
      transition("later", 1793346108, AMO_STATUS.MEASURE, AMO_STATUS.AWAITING_COMMISSION),
      transition("earlier", 1793185130, AMO_STATUS.WORK, AMO_STATUS.MEASURE)
    ]);
    expect(result?.install).toEqual({ occurredAt: "2026-10-30T07:41:48.000Z", manager: "Филипп" });
    expect(result?.measure?.occurredAt).toBe("2026-10-28T10:58:50.000Z");
  });

  it("uses the responsible manager at capture time rather than the event author or current manager", () => {
    const changed: AmoHistoryEvent = { id: "b", type: "entity_responsible_changed", created_at: 200,
      value_before: [{responsible_user: {id: 12043998}}], value_after: [{responsible_user: {id: 7268314}}] };
    const history = resolveLeadStageHistory(lead, [changed, transition("a", 100, AMO_STATUS.MEASURE, AMO_STATUS.INSTALL)]);
    expect(history?.install?.manager).toBe("Людмила");
  });

  it("does not use refusal or other pipelines as evidence that installation happened", () => {
    expect(resolveLeadStageHistory(lead, [
      transition("a", 100, AMO_STATUS.MEASURE, AMO_STATUS.REFUSED),
      transition("b", 200, AMO_STATUS.MEASURE, AMO_STATUS.INSTALL, 123)
    ])).toEqual({});
  });

  it("keeps the first capture date after a rollback and repeat transition", () => {
    const history = resolveLeadStageHistory(lead, [
      transition("a", 100, AMO_STATUS.MEASURE, AMO_STATUS.INSTALL),
      transition("b", 200, AMO_STATUS.INSTALL, AMO_STATUS.MEASURE),
      transition("c", 300, AMO_STATUS.MEASURE, AMO_STATUS.INSTALL)
    ]);
    expect(history?.install?.occurredAt).toBe("1970-01-01T00:01:40.000Z");
  });

  it("requests history only for eligible stages missing capture metadata", () => {
    expect(missingKpiHistoryStages(lead, null)).toEqual(["measure", "install"]);
    expect(missingKpiHistoryStages({...lead, kpiFields: { measure: { date: "28.10.2026", manager: "Филипп", amount: 0 } }}, null)).toEqual(["measure", "install"]);
    expect(missingKpiHistoryStages({...lead, statusId: AMO_STATUS.REFUSED}, null)).toEqual([]);
  });
});
