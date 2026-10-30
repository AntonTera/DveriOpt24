import { describe, expect, it } from "vitest";

import { deriveLeadKpiState, buildSheetSyncJobs } from "@/lib/domain/kpi";
import { AmoLeadSnapshot, StoredDealState } from "@/lib/types";

function buildLead(overrides: Partial<AmoLeadSnapshot>): AmoLeadSnapshot {
  return {
    id: 1,
    name: "Тестовая сделка",
    budget: 125000,
    updatedAt: "2026-04-17T09:00:00.000Z",
    pipelineId: 4908391,
    statusId: 44423710,
    responsibleUserId: 12043998,
    objectType: "Входная нестандарт",
    link: "https://dveriopt24.amocrm.ru/leads/detail/1",
    ...overrides
  };
}

describe("deriveLeadKpiState", () => {
  it("creates work KPI for non-standard entrance on work status", () => {
    const state = deriveLeadKpiState({
      lead: buildLead({ objectType: "Входная нестандарт", statusId: 44423710 }),
      previousState: null,
      processedAt: "2026-04-17T09:00:00.000Z",
      managerName: "Людмила"
    });

    expect(state.activeKpis.work?.amount).toBe(10000);
    expect(state.sheetRowsKpNew).toHaveLength(1);
    expect(state.sheetRowsKpNew[0].kpiLabel).toBe("В работу");
  });

  it("moves active KPI from work to measure/install after object type change", () => {
    const previousState: StoredDealState = {
      deal_id: 1,
      object_type: "Входная нестандарт",
      is_frozen: false,
      active_kpis: {
        work: {
          stage: "work",
          label: "В работу",
          amount: 10000,
          date: "17.04.2026",
          time: "12:00",
          manager: "Людмила"
        }
      },
      kp_rows: {
        work: {
          rowIndex: 10,
          payload: {
            stage: "work",
            date: "17.04.2026",
            time: "12:00",
            kpiLabel: "В работу",
            leadName: "Тестовая сделка",
            amount: 10000,
            link: "https://dveriopt24.amocrm.ru/leads/detail/1",
            dealId: 1,
            installDate: null
          }
        }
      },
      zp_rows: {},
      last_budget: 125000,
      last_status_id: 44423710,
      last_event_received_at: null,
      last_synced_at: null
    };

    const lead = buildLead({
      objectType: "Входная",
      statusId: 44616253
    });

    const nextState = deriveLeadKpiState({
      lead,
      previousState,
      processedAt: "2026-04-18T09:00:00.000Z",
      managerName: "Людмила"
    });

    expect(nextState.activeKpis.work).toBeUndefined();
    expect(nextState.activeKpis.measure?.amount).toBe(10000);
    expect(nextState.activeKpis.install?.amount).toBe(10000);

    const jobs = buildSheetSyncJobs({
      lead,
      previousState,
      nextState
    });

    const zeroWorkJob = jobs.find((job) => job.sheet_name === "KP new" && job.payload.stage === "work");
    expect(zeroWorkJob?.payload.row.amount).toBe(0);
  });

  it("freezes KPI after commission received", () => {
    const previousState: StoredDealState = {
      deal_id: 1,
      object_type: "Входная",
      is_frozen: true,
      active_kpis: {
        measure: {
          stage: "measure",
          label: "Замер",
          amount: 10000,
          date: "17.04.2026",
          time: "12:00",
          manager: "Людмила"
        },
        install: {
          stage: "install",
          label: "Монтаж",
          amount: 10000,
          date: "18.04.2026",
          time: "12:30",
          manager: "Людмила"
        }
      },
      kp_rows: {},
      zp_rows: {},
      last_budget: 125000,
      last_status_id: 142,
      last_event_received_at: null,
      last_synced_at: null
    };

    const state = deriveLeadKpiState({
      lead: buildLead({
        objectType: "Откосы",
        statusId: 142
      }),
      previousState,
      processedAt: "2026-04-19T09:00:00.000Z",
      managerName: "Филипп"
    });

    expect(state.objectType).toBe("Входная");
    expect(state.activeKpis.measure?.amount).toBe(10000);
    expect(state.activeKpis.install?.amount).toBe(10000);
  });

  it("zeroes monetary KPI on refusal but keeps no active stages", () => {
    const previousState: StoredDealState = {
      deal_id: 1,
      object_type: "Входная",
      is_frozen: true,
      active_kpis: {
        install: {
          stage: "install",
          label: "Монтаж",
          amount: 10000,
          date: "18.04.2026",
          time: "12:30",
          manager: "Людмила"
        }
      },
      kp_rows: {
        install: {
          rowIndex: 7,
          payload: {
            stage: "install",
            date: "18.04.2026",
            time: "12:30",
            kpiLabel: "Монтаж",
            leadName: "Тестовая сделка",
            amount: 10000,
            link: "https://dveriopt24.amocrm.ru/leads/detail/1",
            dealId: 1,
            installDate: "18.04.2026"
          }
        }
      },
      zp_rows: {
        install: {
          rowIndex: 11,
          payload: {
            stage: "install",
            date: "18.04.2026",
            time: null,
            kpiLabel: "Монтаж",
            leadName: "Тестовая сделка",
            amount: 10000,
            link: "https://dveriopt24.amocrm.ru/leads/detail/1",
            dealId: 1,
            installDate: "18.04.2026"
          }
        }
      },
      last_budget: 125000,
      last_status_id: 142,
      last_event_received_at: null,
      last_synced_at: null
    };

    const lead = buildLead({
      objectType: "Входная",
      statusId: 143
    });

    const nextState = deriveLeadKpiState({
      lead,
      previousState,
      processedAt: "2026-04-20T09:00:00.000Z",
      managerName: "Людмила"
    });

    expect(nextState.activeKpis.install).toBeUndefined();
    expect(nextState.amoFieldsPatch.some((entry) => entry.value === 0)).toBe(true);

    const jobs = buildSheetSyncJobs({
      lead,
      previousState,
      nextState
    });

    expect(jobs.filter((job) => job.payload.row.amount === 0)).toHaveLength(2);
  });

  it("does not create sheet jobs when rows are already synced and unchanged", () => {
    const previousState: StoredDealState = {
      deal_id: 1,
      object_type: "Входная",
      is_frozen: false,
      active_kpis: {
        measure: {
          stage: "measure",
          label: "Замер",
          amount: 10000,
          date: "17.04.2026",
          time: "12:00",
          manager: "Людмила"
        },
        install: {
          stage: "install",
          label: "Монтаж",
          amount: 10000,
          date: "17.04.2026",
          time: "12:00",
          manager: "Людмила"
        }
      },
      kp_rows: {
        measure: {
          rowIndex: 246,
          payload: {
            stage: "measure",
            date: "17.04.2026",
            time: "12:00",
            kpiLabel: "Замер",
            leadName: "Тестовая сделка",
            amount: 10000,
            link: "https://dveriopt24.amocrm.ru/leads/detail/1",
            dealId: 1,
            installDate: null
          }
        },
        install: {
          rowIndex: 247,
          payload: {
            stage: "install",
            date: "17.04.2026",
            time: "12:00",
            kpiLabel: "Монтаж",
            leadName: "Тестовая сделка",
            amount: 10000,
            link: "https://dveriopt24.amocrm.ru/leads/detail/1",
            dealId: 1,
            installDate: "17.04.2026"
          }
        }
      },
      zp_rows: {},
      last_budget: 125000,
      last_status_id: 44616253,
      last_event_received_at: null,
      last_synced_at: null
    };

    const lead = buildLead({
      objectType: "Входная",
      statusId: 44616253
    });

    const nextState = deriveLeadKpiState({
      lead,
      previousState,
      processedAt: "2026-04-17T09:00:00.000Z",
      managerName: "Людмила"
    });

    const jobs = buildSheetSyncJobs({
      lead,
      previousState,
      nextState
    });

    expect(jobs).toEqual([]);
  });
});

describe("CRM capture preservation", () => {
  it("preserves existing CRM date and manager when rebuilding missing internal state", () => {
    const state = deriveLeadKpiState({
      lead: buildLead({objectType:"Входная",statusId:44616259,budget:11700,
        kpiFields:{install:{date:"21.10.2026",manager:"Людмила",amount:936}},
        stageHistory:{install:{occurredAt:"2026-10-20T08:00:00Z",manager:"Филипп"}}}),
      previousState:null,processedAt:"2026-10-30T10:00:00Z",managerName:"Филипп"
    });
    expect(state.activeKpis.install).toMatchObject({date:"21.10.2026",manager:"Людмила",amount:936});
    expect(state.amoFieldsPatch.filter(m => [1164537,1164539,1164541].includes(m.fieldId))).toEqual([]);
  });

  it("keeps measure active on intermediate stages with no new salary rows", () => {
    for (const statusId of [62159506,44616250]) {
      const state = deriveLeadKpiState({lead:buildLead({objectType:"Входная",statusId}),previousState:null,
        processedAt:"2026-10-30T10:00:00Z",managerName:"Филипп"});
      expect(Object.keys(state.activeKpis)).toEqual(["measure"]);
      expect(state.sheetRowsZpNew).toEqual([]);
    }
  });
});

it("does not enqueue unchanged rows after JSONB reordered their properties", () => {
  const lead = buildLead({objectType:"Входная",statusId:44616259});
  const initial = deriveLeadKpiState({lead,previousState:null,processedAt:"2026-10-30T10:00:00Z",managerName:"Филипп"});
  const previousState: StoredDealState = {deal_id:lead.id,object_type:lead.objectType,is_frozen:false,
    active_kpis:initial.activeKpis,kp_rows:{},zp_rows:{},last_budget:lead.budget,last_status_id:lead.statusId,last_event_received_at:null,last_synced_at:null};
  for (const row of initial.sheetRowsKpNew) {
    previousState.kp_rows[row.stage]={rowIndex:123,payload:Object.fromEntries(Object.entries(row).reverse()) as typeof row};
  }
  const next = deriveLeadKpiState({lead,previousState,processedAt:"2026-10-30T11:00:00Z",managerName:"Филипп"});
  expect(buildSheetSyncJobs({lead,previousState,nextState:next})).toEqual([]);
});

it("still captures work date and manager for entrance doors while keeping money at zero", () => {
  const state = deriveLeadKpiState({lead:buildLead({objectType:"Входная",statusId:44423710,kpiFields:{},
    stageHistory:{work:{occurredAt:"2026-10-28T10:38:07Z",manager:"Филипп"}}}),previousState:null,
    processedAt:"2026-10-30T10:00:00Z",managerName:"Людмила"});
  expect(state.activeKpis).toEqual({});
  expect(state.amoFieldsPatch).toEqual(expect.arrayContaining([
    {fieldId:1164525,value:"28.10.2026"},{fieldId:1164527,value:"Филипп"},{fieldId:1164529,value:0}
  ]));
});
