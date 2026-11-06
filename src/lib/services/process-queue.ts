import { getServerEnv } from "@/lib/env";
import { logError } from "@/lib/log";
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
  const startedAt = Date.now();
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

  const result = {
    processedWebhookEvents: webhookEvents.length,
    processedSheetJobs: sheetJobs.length,
    cleanup: {
      webhookEvents: webhookCleanup,
      sheetJobs: sheetCleanup
    }
  };
  if (process.env.CRM_ROUTING_ENABLED !== "true" && process.env.CRM_CLOSE_DATE_ENABLED !== "true") return result;

  const budgetMs = Math.min(20_000, 50_000 - (Date.now() - startedAt));
  if (budgetMs < 4_000) return { ...result, routing: { skipped: "cron_time_budget" } };
  try {
    const { processRoutingQueue } = await import("@/lib/routing/worker");
    return { ...result, routing: await processRoutingQueue(budgetMs) };
  } catch {
    logError("CRM routing queue failed", {});
    return { ...result, routing: { error: "routing_queue_failed" } };
  }
}
