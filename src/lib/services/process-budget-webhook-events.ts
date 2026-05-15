import { MAIN_PIPELINE_ID, KPI_FIELD_IDS, KPI_STAGE_ORDER } from "@/lib/constants/amocrm";
import { fetchLead, patchLeadCustomFields } from "@/lib/amocrm/client";
import { isExcludedResponsibleUser } from "@/lib/domain/amocrm-kpi";
import { buildSheetSyncJobs } from "@/lib/domain/kpi";
import {
  enqueueSheetJobs,
  getDealState,
  markWebhookEventFailed,
  markWebhookEventProcessed,
  upsertDealState
} from "@/lib/repositories";
import { logInfo } from "@/lib/log";
import {
  ActiveKpiRecord,
  AmoFieldMutation,
  KpiStage,
  LeadKpiState,
  SheetRowPointer,
  StoredDealState,
  WebhookEventRecord
} from "@/lib/types";

function calculateKpiAmount(budget: number): number {
  const normalizedBudget = Number.isFinite(budget) ? Math.max(0, budget) : 0;

  return Math.round(normalizedBudget * 0.08);
}

function updateActiveKpisAmounts(
  activeKpis: StoredDealState["active_kpis"],
  amount: number
): StoredDealState["active_kpis"] {
  const nextActiveKpis: StoredDealState["active_kpis"] = {};

  for (const stage of KPI_STAGE_ORDER) {
    const current = activeKpis[stage];
    if (!current) {
      continue;
    }

    nextActiveKpis[stage] = {
      ...current,
      amount
    } satisfies ActiveKpiRecord;
  }

  return nextActiveKpis;
}

function updateRowPointersAmounts(
  rows: Partial<Record<KpiStage, SheetRowPointer>>,
  activeKpis: StoredDealState["active_kpis"],
  amount: number
): Partial<Record<KpiStage, SheetRowPointer>> {
  const nextRows: Partial<Record<KpiStage, SheetRowPointer>> = {};

  for (const stage of KPI_STAGE_ORDER) {
    if (!activeKpis[stage]) {
      continue;
    }

    const current = rows[stage];
    if (!current) {
      continue;
    }

    nextRows[stage] = {
      rowIndex: current.rowIndex,
      payload: {
        ...current.payload,
        amount
      }
    };
  }

  return nextRows;
}

function buildBudgetRecalculationMutations(
  activeKpis: StoredDealState["active_kpis"],
  amount: number
): AmoFieldMutation[] {
  const mutations: AmoFieldMutation[] = [];

  for (const stage of KPI_STAGE_ORDER) {
    if (!activeKpis[stage]) {
      continue;
    }

    mutations.push({
      fieldId: KPI_FIELD_IDS[stage].money,
      value: amount
    });
  }

  return mutations;
}

function buildBudgetRecalculationState(
  previousState: StoredDealState,
  nextBudget: number
): LeadKpiState {
  const amount = calculateKpiAmount(nextBudget);
  const nextActiveKpis = updateActiveKpisAmounts(previousState.active_kpis, amount);
  const nextKpRows = updateRowPointersAmounts(previousState.kp_rows, nextActiveKpis, amount);
  const nextZpRows = updateRowPointersAmounts(previousState.zp_rows, nextActiveKpis, amount);

  return {
    dealId: previousState.deal_id,
    objectType: previousState.object_type,
    isFrozen: previousState.is_frozen,
    activeKpis: nextActiveKpis,
    amoFieldsPatch: buildBudgetRecalculationMutations(nextActiveKpis, amount),
    sheetRowsKpNew: Object.values(nextKpRows).map((pointer) => pointer.payload),
    sheetRowsZpNew: Object.values(nextZpRows).map((pointer) => pointer.payload),
  };
}

export async function processBudgetWebhookEvent(event: WebhookEventRecord) {
  const previousState = await getDealState(event.lead_id);

  if (!previousState) {
    logInfo("Skipping budget webhook for unknown deal state", {
      dealId: event.lead_id,
      statusId: event.status_id
    });
    await markWebhookEventProcessed(event.id);
    return;
  }

  const lead = await fetchLead(event.lead_id);

  if (lead.pipelineId !== MAIN_PIPELINE_ID) {
    logInfo("Skipping budget webhook from unsupported pipeline", {
      dealId: lead.id,
      pipelineId: lead.pipelineId
    });
    await markWebhookEventProcessed(event.id);
    return;
  }

  if (isExcludedResponsibleUser(lead.responsibleUserId)) {
    logInfo("Skipping budget webhook from excluded responsible user", {
      dealId: lead.id,
      responsibleUserId: lead.responsibleUserId,
      statusId: lead.statusId
    });
    await markWebhookEventProcessed(event.id);
    return;
  }

  const previousBudget = previousState.last_budget;
  const nextBudget = lead.budget;

  if (previousBudget !== null && previousBudget === nextBudget) {
    logInfo("Skipping budget webhook without budget change", {
      dealId: lead.id,
      statusId: lead.statusId,
      previousBudget,
      nextBudget
    });
    await markWebhookEventProcessed(event.id);
    return;
  }

  const recalculatedState = buildBudgetRecalculationState(previousState, nextBudget);

  if (recalculatedState.amoFieldsPatch.length > 0) {
    await patchLeadCustomFields(lead.id, recalculatedState.amoFieldsPatch);
  }

  const sheetJobs = buildSheetSyncJobs({
    lead,
    previousState: {
      ...previousState,
      kp_rows: previousState.kp_rows,
      zp_rows: previousState.zp_rows
    },
    nextState: recalculatedState
  });

  await enqueueSheetJobs(sheetJobs);
  await upsertDealState({
    ...previousState,
    active_kpis: recalculatedState.activeKpis,
    kp_rows: updateRowPointersAmounts(previousState.kp_rows, recalculatedState.activeKpis, calculateKpiAmount(nextBudget)),
    zp_rows: updateRowPointersAmounts(previousState.zp_rows, recalculatedState.activeKpis, calculateKpiAmount(nextBudget)),
    last_budget: nextBudget,
    last_status_id: lead.statusId,
    last_synced_at: new Date().toISOString()
  });

  logInfo("Recalculated budget-driven KPI and salary", {
    dealId: lead.id,
    statusId: lead.statusId,
    previousBudget,
    nextBudget,
    updatedFieldIds: recalculatedState.amoFieldsPatch.map((mutation) => mutation.fieldId),
    sheetJobs: sheetJobs.length
  });

  await markWebhookEventProcessed(event.id);
}

export async function safelyProcessBudgetWebhookEvent(event: WebhookEventRecord) {
  try {
    await processBudgetWebhookEvent(event);
  } catch (error) {
    await markWebhookEventFailed(
      event.id,
      event.process_attempts,
      error instanceof Error ? error.message : "Unknown budget webhook processing error"
    );
  }
}
