import { claimSheetJobs, claimWebhookEvents } from "@/lib/repositories";
import { safelyProcessSheetJob } from "@/lib/services/process-sheet-jobs";
import { safelyProcessWebhookEvent } from "@/lib/services/process-webhook-events";

export async function processQueue() {
  const webhookEvents = await claimWebhookEvents(10);
  for (const event of webhookEvents) {
    await safelyProcessWebhookEvent(event);
  }

  const sheetJobs = await claimSheetJobs(5);
  for (const job of sheetJobs) {
    await safelyProcessSheetJob(job);
  }

  return {
    processedWebhookEvents: webhookEvents.length,
    processedSheetJobs: sheetJobs.length
  };
}
