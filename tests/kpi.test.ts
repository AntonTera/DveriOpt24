import { describe, expect, it } from "vitest";

import { deriveLeadKpiState, buildSheetSyncJobs } from "@/lib/domain/kpi";
import { AmoLeadSnapshot, StoredDealState } from "@/lib/types";

function buildLead(overrides: Partial<AmoLeadSnapshot>): AmoLeadSnapshot {
  return {
    id: 1,
    name: "Тестовая сделка",
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

    expect(state.activeKpis.work?.amount).toBe(500);
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
          amount: 500,
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
            amount: 500,
            link: "https://dveriopt24.amocrm.ru/leads/detail/1",
            dealId: 1,
            installDate: null
          }
        }
      },
      zp_rows: {},
      last_status_id: 44423710,
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
    expect(nextState.activeKpis.measure?.amount).toBe(1000);
    expect(nextState.activeKpis.install?.amount).toBe(1000);

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
          amount: 1000,
          date: "17.04.2026",
          time: "12:00",
          manager: "Людмила"
        },
        install: {
          stage: "install",
          label: "Монтаж",
          amount: 1000,
          date: "18.04.2026",
          time: "12:30",
          manager: "Людмила"
        }
      },
      kp_rows: {},
      zp_rows: {},
      last_status_id: 142,
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
    expect(state.activeKpis.measure?.amount).toBe(1000);
    expect(state.activeKpis.install?.amount).toBe(1000);
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
          amount: 1000,
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
            amount: 1000,
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
            amount: 1000,
            link: "https://dveriopt24.amocrm.ru/leads/detail/1",
            dealId: 1,
            installDate: "18.04.2026"
          }
        }
      },
      last_status_id: 142,
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
});
