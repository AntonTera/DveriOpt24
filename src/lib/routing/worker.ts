import { AmoCrmResponseError } from "@/lib/amocrm/client";
import { formatDisplayDate, formatDisplayTime } from "@/lib/utils/datetime";
import { createCloseDateCrm, syncCloseDate } from "./close-date";
import { getDutyConfig, isCloseDateEnabled, isRoutingEnabled, isShiftRotationEnabled } from "./config";
import { createRoutingCrm } from "./crm";
import { handleRoutingWork, type ShiftRequest } from "./handlers";
import { claimRoutingJob, cleanupRoutingJobs, enqueueRoutingJobs, finishRoutingJob, getLatestShiftRotation, markRoutingPosting, skipSupersededShiftJobs } from "./repository";
import { createDutyLookup } from "./schedule";

function safeJobError(error: unknown, signal: AbortSignal) {
  if (signal.aborted) return "routing_time_budget_exhausted";
  if (error instanceof AmoCrmResponseError) return `amo_http_${error.status}`;
  return "routing_dependency_failed";
}

function buildRoutingContext(signal: AbortSignal) {
  const config = getDutyConfig();
  const crm = createRoutingCrm(signal);
  return { config, crm, getDutyOwner: createDutyLookup(config, crm, signal) };
}

async function startShiftRotation(
  request: ShiftRequest,
  rotationId: string,
  now: Date,
  ownerId: number | null,
  signal: AbortSignal,
  assertRunning: () => void
): Promise<Parameters<typeof finishRoutingJob>[1]> {
  if (!ownerId) return { status: "skipped", reason: "no_duty_owner" };
  const latest = await getLatestShiftRotation(signal);
  if (latest?.payload.ownerId === ownerId && latest.payload.rotationId !== rotationId &&
      (request.source === "manual" || latest.payload.day === request.day) &&
      ["pending", "processing", "retry", "processed"].includes(latest.status)) {
    return { status: "skipped", reason: "shift_owner_unchanged" };
  }

  if (request.day !== formatDisplayDate(new Date())) return { status: "skipped", reason: "shift_date_changed" };
  assertRunning();
  if (latest?.payload.rotationId !== rotationId) {
    await enqueueRoutingJobs([{
      dedupe_key: `shift:${request.day}:${rotationId}:scan:1`,
      payload: { kind: "shift-scan", day: request.day, page: 1, ownerId, rotationId },
      next_run_at: now.toISOString()
    }], signal);
  }
  assertRunning();
  await skipSupersededShiftJobs(request.day, rotationId, signal);
  return { status: "processed", queued: 1 };
}

export async function processRoutingQueue(budgetMs: number) {
  const signal = AbortSignal.timeout(budgetMs);
  let routing: ReturnType<typeof buildRoutingContext> | undefined;
  const stats = { processed: 0, skipped: 0, retry: 0, failed: 0, needs_review: 0, cleaned: 0 };
  const start = new Date();
  const routingEnabled = isRoutingEnabled();
  const closeDateEnabled = isCloseDateEnabled();
  const rotationEnabled = routingEnabled && isShiftRotationEnabled();
  if (rotationEnabled && /^03:0[0-4]$/.test(formatDisplayTime(start))) {
    const day = formatDisplayDate(start);
    await enqueueRoutingJobs([{
      dedupe_key: `shift:${day}:scan:1`, payload: { kind: "shift-request", day, source: "nightly" },
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
    const beforeWrite = async () => {
      await markRoutingPosting(job, signal);
      posting = true;
    };
    let result: Parameters<typeof finishRoutingJob>[1];
    try {
      const work = job.payload;
      const rotationWork = work.kind === "shift-request" || work.kind === "shift-scan" || work.kind === "shift-lead";
      if (work.kind === "close-date") {
        result = closeDateEnabled
          ? await syncCloseDate(work, createCloseDateCrm(signal), { assertRunning, beforeWrite })
          : { status: "skipped", reason: "close_date_disabled" };
      } else if (!routingEnabled) {
        result = { status: "skipped", reason: "routing_disabled" };
      } else if (rotationWork && !rotationEnabled) {
        result = { status: "skipped", reason: "shift_rotation_disabled" };
      } else if (rotationWork && work.day !== formatDisplayDate(now)) {
        result = { status: "skipped", reason: "shift_date_changed" };
      } else if (work.kind === "shift-request") {
        const { getDutyOwner } = routing ??= buildRoutingContext(signal);
        result = await startShiftRotation(work, job.id, now, await getDutyOwner(now, true), signal, assertRunning);
      } else if ((work.kind === "shift-scan" || work.kind === "shift-lead") && work.rotationId &&
          work.rotationId !== (await getLatestShiftRotation(signal))?.payload.rotationId) {
        result = { status: "skipped", reason: "shift_rotation_superseded" };
      } else {
        const { config, crm, getDutyOwner } = routing ??= buildRoutingContext(signal);
        result = await handleRoutingWork(work, {
          crm, now, dutyOwnerIds: config.dutyOwnerIds, getDutyOwner: () => getDutyOwner(now),
          enqueue: (jobs) => enqueueRoutingJobs(jobs, signal),
          beforeCreateReply: beforeWrite,
          assertRunning
        });
      }
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
