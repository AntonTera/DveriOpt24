import { ALLOWED_RESPONSIBLE_USER_NAMES, MAIN_PIPELINE_ID } from "@/lib/constants/amocrm";
import { fetchLead, fetchUserName, patchLeadCustomFields } from "@/lib/amocrm/client";
import {
  buildAmoKpiPatch,
  isExcludedResponsibleUser,
  resolveManagerNameByUserId,
  shouldHandleAmoKpiStatus
} from "@/lib/domain/amocrm-kpi";
import { buildSheetSyncJobs, deriveLeadKpiState } from "@/lib/domain/kpi";
import { processBudgetWebhookEvent } from "@/lib/services/process-budget-webhook-events";
import {
  enqueueSheetJobs,
  getDealState,
  markWebhookEventFailed,
  markWebhookEventProcessed,
  upsertDealState
} from "@/lib/repositories";
import { logInfo } from "@/lib/log";
import { WebhookEventRecord } from "@/lib/types";
import { isStaleWebhookEvent } from "@/lib/utils/webhook-events";

export async function processWebhookEvent(event: WebhookEventRecord) {
  if (event.event_type === "budget_sync") {
    await processBudgetWebhookEvent(event);
    return;
  }

  if (!shouldHandleAmoKpiStatus(event.status_id)) {
    logInfo("Skipping webhook with unsupported status", {
      dealId: event.lead_id,
      statusId: event.status_id
    });
    await markWebhookEventProcessed(event.id);
    return;
  }

  const previousState = await getDealState(event.lead_id);
  if (isStaleWebhookEvent(previousState, event.received_at)) {
    logInfo("Skipping stale webhook event", {
      dealId: event.lead_id,
      statusId: event.status_id,
      receivedAt: event.received_at,
      lastEventReceivedAt: previousState?.last_event_received_at
    });
    await markWebhookEventProcessed(event.id);
    return;
  }

  const lead = await fetchLead(event.lead_id);

  if (lead.pipelineId !== MAIN_PIPELINE_ID) {
    logInfo("Skipping deal from unsupported pipeline", {
      dealId: lead.id,
      pipelineId: lead.pipelineId
    });
    await markWebhookEventProcessed(event.id);
    return;
  }

  if (isExcludedResponsibleUser(lead.responsibleUserId)) {
    logInfo("Skipping deal from excluded responsible user", {
      dealId: lead.id,
      responsibleUserId: lead.responsibleUserId,
      statusId: event.status_id
    });
    await markWebhookEventProcessed(event.id);
    return;
  }

  const mappedManagerName = resolveManagerNameByUserId(lead.responsibleUserId);
  const amoKpiPatch = buildAmoKpiPatch({
    lead,
    statusId: event.status_id,
    managerName: mappedManagerName
  });

  if (!amoKpiPatch) {
    logInfo("Skipping amoCRM KPI update due to unresolved manager or scenario", {
      dealId: lead.id,
      statusId: event.status_id,
      responsibleUserId: lead.responsibleUserId
    });
  } else {
    await patchLeadCustomFields(lead.id, amoKpiPatch.mutations);
    logInfo("Updated amoCRM KPI fields", {
      dealId: lead.id,
      statusId: event.status_id,
      responsibleUserId: lead.responsibleUserId,
      scenario: amoKpiPatch.scenario,
      updatedFieldIds: amoKpiPatch.mutations.map((mutation) => mutation.fieldId)
    });
  }

  const managerName = await fetchUserName(lead.responsibleUserId);

  if (!ALLOWED_RESPONSIBLE_USER_NAMES.has(managerName)) {
    logInfo("Skipping sheet sync for unsupported responsible user", {
      dealId: lead.id,
      statusId: event.status_id,
      responsibleUserId: lead.responsibleUserId,
      managerName
    });
    await markWebhookEventProcessed(event.id);
    return;
  }

  const nextState = deriveLeadKpiState({
    lead,
    previousState,
    processedAt: event.received_at,
    managerName
  });

  const sheetJobs = buildSheetSyncJobs({
    lead,
    previousState,
    nextState
  });

  await enqueueSheetJobs(sheetJobs);
  await upsertDealState({
    deal_id: lead.id,
    object_type: nextState.objectType,
    is_frozen: nextState.isFrozen,
    active_kpis: nextState.activeKpis,
    kp_rows: previousState?.kp_rows ?? {},
    zp_rows: previousState?.zp_rows ?? {},
    last_budget: lead.budget,
    last_status_id: lead.statusId,
    last_event_received_at: event.received_at,
    last_synced_at: new Date().toISOString()
  });

  await markWebhookEventProcessed(event.id);
}

export async function safelyProcessWebhookEvent(event: WebhookEventRecord) {
  try {
    await processWebhookEvent(event);
  } catch (error) {
    await markWebhookEventFailed(
      event.id,
      event.process_attempts,
      error instanceof Error ? error.message : "Unknown webhook processing error"
    );
  }
}
