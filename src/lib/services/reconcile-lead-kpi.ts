import { ALLOWED_RESPONSIBLE_USER_NAMES, AMO_STATUS, MAIN_PIPELINE_ID } from "@/lib/constants/amocrm";
import { fetchLead, fetchLeadKpiHistory, fetchUserName, patchLeadCustomFields } from "@/lib/amocrm/client";
import { isExcludedResponsibleUser, missingKpiHistoryStages, resolveManagerNameByUserId, shouldHandleAmoKpiStatus } from "@/lib/domain/amocrm-kpi";
import { buildSheetSyncJobs, deriveLeadKpiState } from "@/lib/domain/kpi";
import { enqueueSheetJobs, getDealState, markWebhookEventProcessed, upsertDealState } from "@/lib/repositories";
import { logInfo } from "@/lib/log";
import { WebhookEventRecord } from "@/lib/types";
import { isStaleWebhookEvent } from "@/lib/utils/webhook-events";

export async function reconcileLeadKpiEvent(event: WebhookEventRecord) {
  const previousState = await getDealState(event.lead_id);
  if (isStaleWebhookEvent(previousState, event.received_at)) {
    logInfo("Skipping stale KPI event", { dealId: event.lead_id, receivedAt: event.received_at });
    await markWebhookEventProcessed(event.id);
    return;
  }

  const lead = await fetchLead(event.lead_id);
  // The live lead may have advanced since this webhook was queued.
  if (lead.pipelineId !== MAIN_PIPELINE_ID || !shouldHandleAmoKpiStatus(lead.statusId) || isExcludedResponsibleUser(lead.responsibleUserId)) {
    logInfo("Skipping unsupported KPI lead", { dealId: lead.id, statusId: lead.statusId, pipelineId: lead.pipelineId });
    await markWebhookEventProcessed(event.id);
    return;
  }

  const managerName = resolveManagerNameByUserId(lead.responsibleUserId) ?? await fetchUserName(lead.responsibleUserId);
  const allowedManager = ALLOWED_RESPONSIBLE_USER_NAMES.has(managerName);
  if (!allowedManager && lead.statusId !== AMO_STATUS.REFUSED) {
    logInfo("Skipping KPI for unsupported responsible user", { dealId: lead.id, responsibleUserId: lead.responsibleUserId });
    await markWebhookEventProcessed(event.id);
    return;
  }

  if (missingKpiHistoryStages(lead, previousState).length > 0) {
    lead.stageHistory = await fetchLeadKpiHistory(lead);
  }
  const nextState = deriveLeadKpiState({ lead, previousState, processedAt: event.received_at, managerName });
  await patchLeadCustomFields(lead.id, nextState.amoFieldsPatch);

  if (allowedManager) {
    const jobs = buildSheetSyncJobs({ lead, previousState, nextState });
    await enqueueSheetJobs(jobs);
    // Sheet pointers describe confirmed writes, not jobs merely put in the queue.
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
    logInfo("Reconciled lead KPI", {
      dealId: lead.id, statusId: lead.statusId, eventType: event.event_type,
      updatedFieldIds: nextState.amoFieldsPatch.map((m) => m.fieldId), sheetJobs: jobs.length
    });
  }
  await markWebhookEventProcessed(event.id);
}
