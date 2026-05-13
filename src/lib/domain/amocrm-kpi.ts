import {
  AMO_KPI_MANAGER_NAME_BY_USER_ID,
  AMO_KPI_STAGE_BY_STATUS,
  AMO_KPI_SUPPORTED_STATUS_IDS,
  AMO_STATUS,
  EXCLUDED_RESPONSIBLE_USER_ID,
  KPI_FIELD_IDS,
  type AmoKpiStage
} from "@/lib/constants/amocrm";
import { AmoFieldMutation, AmoLeadSnapshot } from "@/lib/types";
import { formatDisplayDate } from "@/lib/utils/datetime";

export interface AmoKpiPatchResult {
  scenario: string;
  mutations: AmoFieldMutation[];
}

function calculateKpiAmount(budget: number): number {
  const normalizedBudget = Number.isFinite(budget) ? Math.max(0, budget) : 0;

  return Math.round(normalizedBudget * 0.08);
}

export function shouldHandleAmoKpiStatus(statusId: number | null): statusId is number {
  return statusId !== null && AMO_KPI_SUPPORTED_STATUS_IDS.has(statusId);
}

export function isExcludedResponsibleUser(userId: number | null): boolean {
  return userId === EXCLUDED_RESPONSIBLE_USER_ID;
}

export function resolveManagerNameByUserId(userId: number | null): string | null {
  if (!userId) {
    return null;
  }

  return AMO_KPI_MANAGER_NAME_BY_USER_ID[userId] ?? null;
}

function buildStageMutations(
  stage: AmoKpiStage,
  lead: AmoLeadSnapshot,
  managerName: string
): AmoFieldMutation[] {
  const amount = calculateKpiAmount(lead.budget);
  const dateValue = formatDisplayDate(lead.updatedAt);
  const fieldIds = KPI_FIELD_IDS[stage];

  return [
    {
      fieldId: fieldIds.date,
      value: dateValue
    },
    {
      fieldId: fieldIds.manager,
      value: managerName
    },
    {
      fieldId: fieldIds.money,
      value: amount
    }
  ];
}

function buildRecalculationMutations(lead: AmoLeadSnapshot): AmoFieldMutation[] {
  const amount = calculateKpiAmount(lead.budget);

  return [
    {
      fieldId: KPI_FIELD_IDS.work.money,
      value: amount
    },
    {
      fieldId: KPI_FIELD_IDS.measure.money,
      value: amount
    },
    {
      fieldId: KPI_FIELD_IDS.install.money,
      value: amount
    }
  ];
}

function buildRefusalMutations(): AmoFieldMutation[] {
  return [
    {
      fieldId: KPI_FIELD_IDS.work.money,
      value: 0
    },
    {
      fieldId: KPI_FIELD_IDS.measure.money,
      value: 0
    },
    {
      fieldId: KPI_FIELD_IDS.install.money,
      value: 0
    }
  ];
}

export function buildAmoKpiPatch(params: {
  lead: AmoLeadSnapshot;
  statusId: number;
  managerName: string | null;
}): AmoKpiPatchResult | null {
  const { lead, statusId, managerName } = params;

  if (!shouldHandleAmoKpiStatus(statusId)) {
    return null;
  }

  if (statusId === AMO_STATUS.SALARY_RECONCILED) {
    return {
      scenario: "salary_reconciled_recalculation",
      mutations: buildRecalculationMutations(lead)
    };
  }

  if (statusId === AMO_STATUS.REFUSED) {
    return {
      scenario: "refused_zero_amounts",
      mutations: buildRefusalMutations()
    };
  }

  if (!managerName) {
    return null;
  }

  const stage = AMO_KPI_STAGE_BY_STATUS[statusId];
  if (!stage) {
    return null;
  }

  return {
    scenario: `${stage}_kpi_capture`,
    mutations: buildStageMutations(stage, lead, managerName)
  };
}
