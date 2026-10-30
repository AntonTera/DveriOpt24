import { reconcileLeadKpiEvent } from "@/lib/services/reconcile-lead-kpi";
import { markWebhookEventFailed } from "@/lib/repositories";
import { WebhookEventRecord } from "@/lib/types";

export const processWebhookEvent = reconcileLeadKpiEvent;

export async function safelyProcessWebhookEvent(event: WebhookEventRecord) {
  try {
    await processWebhookEvent(event);
  } catch (error) {
    await markWebhookEventFailed(event.id, event.process_attempts, error instanceof Error ? error.message : "Unknown webhook processing error");
  }
}
