import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/amocrm/client", () => ({
  fetchLead: vi.fn(),
  fetchUserName: vi.fn(),
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
  buildSheetSyncJobs: vi.fn(),
  deriveLeadKpiState: vi.fn()
}));

vi.mock("@/lib/log", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn()
}));

import { AMO_STATUS } from "@/lib/constants/amocrm";
import { fetchLead, fetchUserName, patchLeadCustomFields } from "@/lib/amocrm/client";
import { buildSheetSyncJobs, deriveLeadKpiState } from "@/lib/domain/kpi";
import { logInfo } from "@/lib/log";
import {
  enqueueSheetJobs,
  getDealState,
  markWebhookEventProcessed,
  upsertDealState
} from "@/lib/repositories";
import { processWebhookEvent } from "@/lib/services/process-webhook-events";

const fetchLeadMock = vi.mocked(fetchLead);
const fetchUserNameMock = vi.mocked(fetchUserName);
const patchLeadCustomFieldsMock = vi.mocked(patchLeadCustomFields);
const buildSheetSyncJobsMock = vi.mocked(buildSheetSyncJobs);
const deriveLeadKpiStateMock = vi.mocked(deriveLeadKpiState);
const logInfoMock = vi.mocked(logInfo);
const enqueueSheetJobsMock = vi.mocked(enqueueSheetJobs);
const getDealStateMock = vi.mocked(getDealState);
const markWebhookEventProcessedMock = vi.mocked(markWebhookEventProcessed);
const upsertDealStateMock = vi.mocked(upsertDealState);

describe("processWebhookEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDealStateMock.mockResolvedValue(null);
    fetchUserNameMock.mockResolvedValue("Людмила");
    deriveLeadKpiStateMock.mockReturnValue({
      dealId: 7,
      objectType: "Входная",
      isFrozen: false,
      activeKpis: {},
      amoFieldsPatch: [],
      sheetRowsKpNew: [],
      sheetRowsZpNew: []
    });
    buildSheetSyncJobsMock.mockReturnValue([]);
    enqueueSheetJobsMock.mockResolvedValue(undefined);
    upsertDealStateMock.mockResolvedValue(undefined);
    markWebhookEventProcessedMock.mockResolvedValue(undefined);
    patchLeadCustomFieldsMock.mockResolvedValue(undefined);
  });

  it("skips unsupported statuses before loading lead details", async () => {
    await processWebhookEvent({
      id: "evt-1",
      lead_id: 7,
      pipeline_id: 4908391,
      status_id: 111111,
      event_type: "status",
      received_at: "2026-05-13T10:00:00.000Z",
      payload_hash: "hash-1",
      raw_payload: {},
      processing_status: "processing",
      process_attempts: 1,
      last_error: null
    });

    expect(fetchLeadMock).not.toHaveBeenCalled();
    expect(markWebhookEventProcessedMock).toHaveBeenCalledWith("evt-1");
  });

  it("writes only zeroed money fields to amoCRM on refused status", async () => {
    fetchLeadMock.mockResolvedValue({
      id: 7,
      name: "Сделка",
      budget: 200000,
      updatedAt: "2026-05-13T09:00:00.000Z",
      pipelineId: 4908391,
      statusId: AMO_STATUS.REFUSED,
      responsibleUserId: 12043998,
      objectType: "Входная",
      link: "https://dveriopt24.amocrm.ru/leads/detail/7"
    });

    await processWebhookEvent({
      id: "evt-2",
      lead_id: 7,
      pipeline_id: 4908391,
      status_id: AMO_STATUS.REFUSED,
      event_type: "status",
      received_at: "2026-05-13T10:00:00.000Z",
      payload_hash: "hash-2",
      raw_payload: {},
      processing_status: "processing",
      process_attempts: 1,
      last_error: null
    });

    expect(patchLeadCustomFieldsMock).toHaveBeenCalledWith(7, [
      { fieldId: 1164529, value: 0 },
      { fieldId: 1164535, value: 0 },
      { fieldId: 1164541, value: 0 }
    ]);
    expect(logInfoMock).toHaveBeenCalledWith(
      "Updated amoCRM KPI fields",
      expect.objectContaining({
        dealId: 7,
        statusId: AMO_STATUS.REFUSED,
        scenario: "refused_zero_amounts",
        updatedFieldIds: [1164529, 1164535, 1164541]
      })
    );
    expect(markWebhookEventProcessedMock).toHaveBeenCalledWith("evt-2");
  });
});
