import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/amocrm/client", () => ({
  fetchLead: vi.fn(),
  patchLeadCustomFields: vi.fn()
}));

vi.mock("@/lib/repositories", () => ({
  enqueueSheetJobs: vi.fn(),
  getDealState: vi.fn(),
  markWebhookEventFailed: vi.fn(),
  markWebhookEventProcessed: vi.fn(),
  upsertDealState: vi.fn()
}));

vi.mock("@/lib/domain/kpi", () => ({
  buildSheetSyncJobs: vi.fn()
}));

vi.mock("@/lib/log", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn()
}));

import { fetchLead, patchLeadCustomFields } from "@/lib/amocrm/client";
import { buildSheetSyncJobs } from "@/lib/domain/kpi";
import { logInfo } from "@/lib/log";
import {
  enqueueSheetJobs,
  getDealState,
  markWebhookEventProcessed,
  upsertDealState
} from "@/lib/repositories";
import { processBudgetWebhookEvent } from "@/lib/services/process-budget-webhook-events";

const fetchLeadMock = vi.mocked(fetchLead);
const patchLeadCustomFieldsMock = vi.mocked(patchLeadCustomFields);
const buildSheetSyncJobsMock = vi.mocked(buildSheetSyncJobs);
const logInfoMock = vi.mocked(logInfo);
const enqueueSheetJobsMock = vi.mocked(enqueueSheetJobs);
const getDealStateMock = vi.mocked(getDealState);
const markWebhookEventProcessedMock = vi.mocked(markWebhookEventProcessed);
const upsertDealStateMock = vi.mocked(upsertDealState);

describe("processBudgetWebhookEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildSheetSyncJobsMock.mockReturnValue([]);
    enqueueSheetJobsMock.mockResolvedValue(undefined);
    upsertDealStateMock.mockResolvedValue(undefined);
    markWebhookEventProcessedMock.mockResolvedValue(undefined);
    patchLeadCustomFieldsMock.mockResolvedValue(undefined);
  });

  it("skips recalculation for unknown deals", async () => {
    getDealStateMock.mockResolvedValue(null);

    await processBudgetWebhookEvent({
      id: "budget-1",
      lead_id: 12,
      pipeline_id: 4908391,
      status_id: 44423710,
      event_type: "budget_sync",
      received_at: "2026-05-15T10:00:00.000Z",
      payload_hash: "hash-budget-1",
      raw_payload: {},
      processing_status: "processing",
      process_attempts: 1,
      last_error: null
    });

    expect(fetchLeadMock).not.toHaveBeenCalled();
    expect(markWebhookEventProcessedMock).toHaveBeenCalledWith("budget-1");
  });

  it("skips recalculation when budget is unchanged", async () => {
    getDealStateMock.mockResolvedValue({
      deal_id: 12,
      object_type: "Входная",
      is_frozen: false,
      active_kpis: {
        measure: {
          stage: "measure",
          label: "Замер",
          amount: 10000,
          date: "12.05.2026",
          time: "10:00",
          manager: "Людмила"
        }
      },
      kp_rows: {},
      zp_rows: {},
      last_budget: 125000,
      last_status_id: 44423716,
      last_synced_at: "2026-05-14T10:00:00.000Z"
    });
    fetchLeadMock.mockResolvedValue({
      id: 12,
      name: "Сделка",
      budget: 125000,
      updatedAt: "2026-05-15T09:00:00.000Z",
      pipelineId: 4908391,
      statusId: 44423716,
      responsibleUserId: 12043998,
      objectType: "Входная",
      link: "https://dveriopt24.amocrm.ru/leads/detail/12"
    });

    await processBudgetWebhookEvent({
      id: "budget-2",
      lead_id: 12,
      pipeline_id: 4908391,
      status_id: 44423716,
      event_type: "budget_sync",
      received_at: "2026-05-15T10:00:00.000Z",
      payload_hash: "hash-budget-2",
      raw_payload: {},
      processing_status: "processing",
      process_attempts: 1,
      last_error: null
    });

    expect(patchLeadCustomFieldsMock).not.toHaveBeenCalled();
    expect(markWebhookEventProcessedMock).toHaveBeenCalledWith("budget-2");
  });

  it("recalculates amoCRM fields and sheet jobs when budget changes", async () => {
    getDealStateMock.mockResolvedValue({
      deal_id: 12,
      object_type: "Входная",
      is_frozen: false,
      active_kpis: {
        measure: {
          stage: "measure",
          label: "Замер",
          amount: 10000,
          date: "12.05.2026",
          time: "10:00",
          manager: "Людмила"
        },
        install: {
          stage: "install",
          label: "Монтаж",
          amount: 10000,
          date: "13.05.2026",
          time: "11:00",
          manager: "Людмила"
        }
      },
      kp_rows: {
        measure: {
          rowIndex: 4,
          payload: {
            stage: "measure",
            date: "12.05.2026",
            time: "10:00",
            kpiLabel: "Замер",
            leadName: "Сделка",
            amount: 10000,
            link: "https://dveriopt24.amocrm.ru/leads/detail/12",
            dealId: 12,
            installDate: null
          }
        }
      },
      zp_rows: {
        install: {
          rowIndex: 9,
          payload: {
            stage: "install",
            date: "13.05.2026",
            time: null,
            kpiLabel: "Монтаж",
            leadName: "Сделка",
            amount: 10000,
            link: "https://dveriopt24.amocrm.ru/leads/detail/12",
            dealId: 12,
            installDate: "13.05.2026"
          }
        }
      },
      last_budget: 125000,
      last_status_id: 44423716,
      last_synced_at: "2026-05-14T10:00:00.000Z"
    });
    fetchLeadMock.mockResolvedValue({
      id: 12,
      name: "Сделка",
      budget: 200000,
      updatedAt: "2026-05-15T09:00:00.000Z",
      pipelineId: 4908391,
      statusId: 44423716,
      responsibleUserId: 12043998,
      objectType: "Входная",
      link: "https://dveriopt24.amocrm.ru/leads/detail/12"
    });
    buildSheetSyncJobsMock.mockReturnValue([
      {
        deal_id: 12,
        sheet_name: "KP new",
        job_type: "upsert",
        row_key: "12:KP new:measure",
        payload: {
          stage: "measure",
          rowIndex: 4,
          row: {
            stage: "measure",
            date: "12.05.2026",
            time: "10:00",
            kpiLabel: "Замер",
            leadName: "Сделка",
            amount: 16000,
            link: "https://dveriopt24.amocrm.ru/leads/detail/12",
            dealId: 12,
            installDate: null
          }
        }
      }
    ]);

    await processBudgetWebhookEvent({
      id: "budget-3",
      lead_id: 12,
      pipeline_id: 4908391,
      status_id: 44423716,
      event_type: "budget_sync",
      received_at: "2026-05-15T10:00:00.000Z",
      payload_hash: "hash-budget-3",
      raw_payload: {},
      processing_status: "processing",
      process_attempts: 1,
      last_error: null
    });

    expect(patchLeadCustomFieldsMock).toHaveBeenCalledWith(12, [
      { fieldId: 1164535, value: 16000 },
      { fieldId: 1164541, value: 16000 }
    ]);
    expect(enqueueSheetJobsMock).toHaveBeenCalledTimes(1);
    expect(upsertDealStateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deal_id: 12,
        last_budget: 200000,
        last_status_id: 44423716
      })
    );
    expect(logInfoMock).toHaveBeenCalledWith(
      "Recalculated budget-driven KPI and salary",
      expect.objectContaining({
        dealId: 12,
        previousBudget: 125000,
        nextBudget: 200000,
        updatedFieldIds: [1164535, 1164541]
      })
    );
    expect(markWebhookEventProcessedMock).toHaveBeenCalledWith("budget-3");
  });
});
