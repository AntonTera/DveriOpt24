import { MAIN_PIPELINE_ID } from "@/lib/constants/amocrm";
import { fetchLead, fetchUserName, patchLeadCustomFields } from "@/lib/amocrm/client";
import { buildSheetSyncJobs, deriveLeadKpiState } from "@/lib/domain/kpi";
import {
  enqueueSheetJobs,
  getDealState,
  markWebhookEventFailed,
  markWebhookEventProcessed,
  upsertDealState
} from "@/lib/repositories";
import { logInfo } from "@/lib/log";
import { WebhookEventRecord } from "@/lib/types";

export async function processWebhookEvent(event: WebhookEventRecord) {
  const previousState = await getDealState(event.lead_id);
  const lead = await fetchLead(event.lead_id);

  if (lead.pipelineId !== MAIN_PIPELINE_ID) {
    logInfo("Skipping deal from unsupported pipeline", {
      dealId: lead.id,
      pipelineId: lead.pipelineId
    });
    await markWebhookEventProcessed(event.id);
    return;
  }

  const managerName = await fetchUserName(lead.responsibleUserId);
  const nextState = deriveLeadKpiState({
    lead,
    previousState,
    processedAt: event.received_at,
    managerName
  });

  await patchLeadCustomFields(lead.id, nextState.amoFieldsPatch);

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
    last_status_id: lead.statusId,
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
