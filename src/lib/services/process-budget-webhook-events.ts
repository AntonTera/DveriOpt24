import { reconcileLeadKpiEvent } from "@/lib/services/reconcile-lead-kpi";
import { markWebhookEventFailed } from "@/lib/repositories";
import { WebhookEventRecord } from "@/lib/types";

export const processBudgetWebhookEvent = reconcileLeadKpiEvent;

export async function safelyProcessBudgetWebhookEvent(event: WebhookEventRecord) {
  try {
    await processBudgetWebhookEvent(event);
  } catch (error) {
    await markWebhookEventFailed(event.id, event.process_attempts, error instanceof Error ? error.message : "Unknown budget webhook processing error");
  }
}
