import { AmoCrmResponseError } from "@/lib/amocrm/client";
import { formatDisplayDate, formatDisplayTime } from "@/lib/utils/datetime";
import { getDutyConfig, isShiftRotationEnabled } from "./config";
import { createRoutingCrm } from "./crm";
import { handleRoutingWork } from "./handlers";
import { claimRoutingJob, cleanupRoutingJobs, enqueueRoutingJobs, finishRoutingJob, markReplyPosting } from "./repository";
import { createDutyLookup } from "./schedule";

function safeJobError(error: unknown, signal: AbortSignal) {
  if (signal.aborted) return "routing_time_budget_exhausted";
  if (error instanceof AmoCrmResponseError) return `amo_http_${error.status}`;
  return "routing_dependency_failed";
}

export async function processRoutingQueue(budgetMs: number) {
  const config = getDutyConfig();
  const signal = AbortSignal.timeout(budgetMs);
  const crm = createRoutingCrm(signal);
  const getDutyOwner = createDutyLookup(config, crm, signal);
  const stats = { processed: 0, skipped: 0, retry: 0, failed: 0, needs_review: 0, cleaned: 0 };
  const start = new Date();
  const rotationEnabled = isShiftRotationEnabled();
  if (rotationEnabled && /^03:0[0-4]$/.test(formatDisplayTime(start))) {
    const day = formatDisplayDate(start);
    await enqueueRoutingJobs([{
      dedupe_key: `shift:${day}:scan:1`, payload: { kind: "shift-scan", day, page: 1 },
      next_run_at: start.toISOString()
    }], signal);
  }

  for (let i = 0; i < 12 && !signal.aborted; i += 1) {
    const job = await claimRoutingJob(signal);
    if (!job) break;
    const now = new Date();
    let posting = false;
    const assertRunning = () => {
      signal.throwIfAborted();
      if (Date.now() >= Date.parse(job.lease_until)) throw new Error("Routing claim expired");
    };
    let result: Parameters<typeof finishRoutingJob>[1];
    try {
      const shiftJob = job.payload.kind === "shift-scan" || job.payload.kind === "shift-lead";
      result = shiftJob && !rotationEnabled
        ? { status: "skipped", reason: "shift_rotation_disabled" }
        : await handleRoutingWork(job.payload, {
          crm, now, dutyOwnerIds: config.dutyOwnerIds, getDutyOwner: () => getDutyOwner(now),
          enqueue: (jobs) => enqueueRoutingJobs(jobs, signal),
          beforeCreateReply: async () => {
            await markReplyPosting(job, signal);
            posting = true;
          },
          assertRunning
        });
    } catch (error) {
      result = {
        status: posting ? "needs_review" : job.attempts >= 5 ? "failed" : "retry",
        reason: safeJobError(error, signal)
      };
    }
    await finishRoutingJob(job, result);
    stats[result.status] += 1;
  }

  if (!signal.aborted) stats.cleaned = await cleanupRoutingJobs(signal);
  return stats;
}
