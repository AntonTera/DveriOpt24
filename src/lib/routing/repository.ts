import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { RoutingEnqueueJob, RoutingWork } from "./handlers";

export type RoutingClaim = { id: string; payload: RoutingWork; attempts: number; claim_token: string; lease_until: string };
type RoutingFinish = {
  status: "processed" | "skipped" | "retry" | "failed" | "needs_review";
  reason?: string;
  queued?: number;
};

export async function enqueueRoutingJobs(jobs: RoutingEnqueueJob[], signal = AbortSignal.timeout(5_000)) {
  if (!jobs.length) return;
  const { error } = await getSupabaseAdmin().from("dveri_opt_routing_jobs")
    .upsert(jobs, { onConflict: "dedupe_key", ignoreDuplicates: true }).abortSignal(signal);
  if (error) throw new Error("Routing enqueue failed");
}

export async function claimRoutingJob(signal: AbortSignal): Promise<RoutingClaim | null> {
  const { data, error } = await getSupabaseAdmin().rpc("dveri_opt_claim_routing_job").abortSignal(signal);
  if (error) throw new Error("Routing claim failed");
  return data?.[0] ?? null;
}

async function updateClaim(job: RoutingClaim, patch: object, signal: AbortSignal) {
  const { data, error } = await getSupabaseAdmin().from("dveri_opt_routing_jobs")
    .update(patch).eq("id", job.id).eq("status", "processing").eq("claim_token", job.claim_token)
    .gt("lease_until", new Date().toISOString()).select("id").abortSignal(signal).maybeSingle();
  if (error || !data) throw new Error("Routing claim update failed");
}

export function markReplyPosting(job: RoutingClaim, signal: AbortSignal) {
  return updateClaim(job, { posting: true }, signal);
}

export function finishRoutingJob(job: RoutingClaim, result: RoutingFinish) {
  const retry = result.status === "retry";
  const error = retry || result.status === "failed" || result.status === "needs_review";
  return updateClaim(job, {
    status: result.status,
    result,
    claim_token: null,
    lease_until: null,
    last_error: error ? result.reason : null,
    ...(retry && { next_run_at: new Date(Date.now() + 60_000 * 2 ** (job.attempts - 1)).toISOString() })
  }, AbortSignal.timeout(3_000));
}

export async function cleanupRoutingJobs(signal: AbortSignal) {
  const historyBefore = new Date(Date.now() - 86_400_000).toISOString();
  const { data, error } = await getSupabaseAdmin().rpc("dveri_opt_cleanup_routing_jobs", {
    history_before: historyBefore, batch_size: 200
  }).abortSignal(signal);
  if (error) throw new Error("Routing cleanup failed");
  return Number(data ?? 0);
}
