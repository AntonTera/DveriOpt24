import { getServerEnv } from "@/lib/env";
import {
  claimSheetJobs,
  claimWebhookEvents,
  cleanupSheetJobHistory,
  cleanupWebhookEventHistory
} from "@/lib/repositories";
import { safelyProcessSheetJob } from "@/lib/services/process-sheet-jobs";
import { safelyProcessWebhookEvent } from "@/lib/services/process-webhook-events";

function getRetentionCutoff(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export async function processQueue() {
  const env = getServerEnv();
  const webhookEvents = await claimWebhookEvents(10);
  for (const event of webhookEvents) {
    await safelyProcessWebhookEvent(event);
  }

  const sheetJobs = await claimSheetJobs(5);
  for (const job of sheetJobs) {
    await safelyProcessSheetJob(job);
  }

  const webhookCleanup = await cleanupWebhookEventHistory(
    getRetentionCutoff(env.WEBHOOK_EVENTS_RETENTION_DAYS),
    getRetentionCutoff(env.WEBHOOK_EVENTS_RETENTION_DAYS),
    env.WEBHOOK_EVENTS_CLEANUP_BATCH_SIZE,
    env.WEBHOOK_EVENTS_FAILED_CLEANUP_BATCH_SIZE
  );

  const sheetCleanup = await cleanupSheetJobHistory(
    getRetentionCutoff(env.SHEET_JOBS_RETENTION_DAYS),
    getRetentionCutoff(env.SHEET_JOBS_RETENTION_DAYS),
    env.SHEET_JOBS_CLEANUP_BATCH_SIZE,
    env.SHEET_JOBS_FAILED_CLEANUP_BATCH_SIZE
  );

  return {
    processedWebhookEvents: webhookEvents.length,
    processedSheetJobs: sheetJobs.length,
    cleanup: {
      webhookEvents: webhookCleanup,
      sheetJobs: sheetCleanup
    }
  };
}
