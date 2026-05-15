import { JsonValue, SheetJobPayload, SheetJobRecord, StoredDealState, WebhookEventRecord } from "@/lib/types";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

function parseDealState(row: Record<string, unknown>): StoredDealState {
  return {
    deal_id: Number(row.deal_id),
    object_type: (row.object_type as string | null) ?? null,
    is_frozen: Boolean(row.is_frozen),
    active_kpis: (row.active_kpis as StoredDealState["active_kpis"]) ?? {},
    kp_rows: (row.kp_rows as StoredDealState["kp_rows"]) ?? {},
    zp_rows: (row.zp_rows as StoredDealState["zp_rows"]) ?? {},
    last_budget:
      row.last_budget === null || row.last_budget === undefined
        ? null
        : Number.isFinite(Number(row.last_budget))
          ? Number(row.last_budget)
          : null,
    last_status_id: (row.last_status_id as number | null) ?? null,
    last_synced_at: (row.last_synced_at as string | null) ?? null
  };
}

function calculateNextRun(attempts: number): string {
  const delayMinutes = Math.min(60, 2 ** attempts);
  return new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();
}

export async function insertWebhookEvents(events: WebhookEventRecord[] | Omit<WebhookEventRecord, "id" | "processing_status" | "process_attempts" | "last_error">[]) {
  const supabase = getSupabaseAdmin();
  const rows = events.map((event) => ({
    lead_id: event.lead_id,
    pipeline_id: event.pipeline_id,
    status_id: event.status_id,
    event_type: event.event_type,
    received_at: event.received_at,
    payload_hash: event.payload_hash,
    raw_payload: event.raw_payload
  }));

  const { error } = await supabase
    .from("dveri_opt_webhook_events")
    .upsert(rows, { onConflict: "payload_hash", ignoreDuplicates: true });

  if (error) {
    throw new Error(`Failed to store webhook events: ${error.message}`);
  }
}

export async function claimWebhookEvents(limit: number): Promise<WebhookEventRecord[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("dveri_opt_claim_webhook_events", {
    batch_size: limit
  });

  if (error) {
    throw new Error(`Failed to claim webhook events: ${error.message}`);
  }

  return ((data ?? []) as WebhookEventRecord[]).map((row) => ({
    ...row,
    raw_payload: row.raw_payload as JsonValue
  }));
}

export async function markWebhookEventProcessed(id: string) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("dveri_opt_webhook_events")
    .update({
      processing_status: "processed",
      processed_at: new Date().toISOString(),
      last_error: null
    })
    .eq("id", id);

  if (error) {
    throw new Error(`Failed to mark webhook event processed: ${error.message}`);
  }
}

export async function markWebhookEventFailed(id: string, attempts: number, errorMessage: string) {
  const supabase = getSupabaseAdmin();
  const isTerminal = attempts >= 5;
  const { error } = await supabase
    .from("dveri_opt_webhook_events")
    .update({
      processing_status: isTerminal ? "failed" : "retry",
      last_error: errorMessage,
      next_run_at: isTerminal ? null : calculateNextRun(attempts)
    })
    .eq("id", id);

  if (error) {
    throw new Error(`Failed to mark webhook event failed: ${error.message}`);
  }
}

export async function getDealState(dealId: number): Promise<StoredDealState | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("dveri_opt_deal_state")
    .select("*")
    .eq("deal_id", dealId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch deal state: ${error.message}`);
  }

  return data ? parseDealState(data) : null;
}

export async function upsertDealState(state: StoredDealState) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("dveri_opt_deal_state").upsert({
    deal_id: state.deal_id,
    object_type: state.object_type,
    is_frozen: state.is_frozen,
    active_kpis: state.active_kpis,
    kp_rows: state.kp_rows,
    zp_rows: state.zp_rows,
    last_budget: state.last_budget,
    last_status_id: state.last_status_id,
    last_synced_at: state.last_synced_at ?? new Date().toISOString()
  });

  if (error) {
    throw new Error(`Failed to upsert deal state: ${error.message}`);
  }
}

export async function enqueueSheetJobs(
  jobs: Array<{
    deal_id: number;
    sheet_name: string;
    job_type: string;
    row_key: string;
    payload: SheetJobPayload;
  }>
) {
  if (jobs.length === 0) {
    return;
  }

  const supabase = getSupabaseAdmin();
  const rowKeys = [...new Set(jobs.map((job) => job.row_key))];
  const { data: existingRows, error: existingError } = await supabase
    .from("dveri_opt_sheet_jobs")
    .select("id, row_key, status")
    .in("row_key", rowKeys)
    .in("status", ["pending", "retry"]);

  if (existingError) {
    throw new Error(`Failed to load existing sheet jobs: ${existingError.message}`);
  }

  const existingByRowKey = new Map(
    ((existingRows ?? []) as Array<{ id: string; row_key: string; status: string }>).map((row) => [row.row_key, row])
  );

  const jobsToInsert = jobs.filter((job) => !existingByRowKey.has(job.row_key));
  const jobsToRefresh = jobs.filter((job) => existingByRowKey.has(job.row_key));

  if (jobsToInsert.length > 0) {
    const { error } = await supabase.from("dveri_opt_sheet_jobs").insert(
      jobsToInsert.map((job) => ({
        ...job,
        status: "pending",
        attempts: 0
      }))
    );

    if (error) {
      throw new Error(`Failed to enqueue sheet jobs: ${error.message}`);
    }
  }

  for (const job of jobsToRefresh) {
    const existing = existingByRowKey.get(job.row_key);
    if (!existing) {
      continue;
    }

    const { error } = await supabase
      .from("dveri_opt_sheet_jobs")
      .update({
        job_type: job.job_type,
        payload: job.payload,
        status: "pending",
        next_run_at: null,
        last_error: null
      })
      .eq("id", existing.id);

    if (error) {
      throw new Error(`Failed to refresh sheet job ${job.row_key}: ${error.message}`);
    }
  }
}

export async function claimSheetJobs(limit: number): Promise<SheetJobRecord[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("dveri_opt_claim_sheet_jobs", {
    batch_size: limit
  });

  if (error) {
    throw new Error(`Failed to claim sheet jobs: ${error.message}`);
  }

  return (data ?? []) as SheetJobRecord[];
}

export async function markSheetJobProcessed(id: string) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("dveri_opt_sheet_jobs")
    .update({
      status: "processed",
      processed_at: new Date().toISOString(),
      last_error: null
    })
    .eq("id", id);

  if (error) {
    throw new Error(`Failed to mark sheet job processed: ${error.message}`);
  }
}

export async function markSheetJobFailed(id: string, attempts: number, errorMessage: string) {
  const supabase = getSupabaseAdmin();
  const isTerminal = attempts >= 7;
  const { error } = await supabase
    .from("dveri_opt_sheet_jobs")
    .update({
      status: isTerminal ? "failed" : "retry",
      last_error: errorMessage,
      next_run_at: isTerminal ? null : calculateNextRun(attempts)
    })
    .eq("id", id);

  if (error) {
    throw new Error(`Failed to mark sheet job failed: ${error.message}`);
  }
}

export async function updateDealStateSheetPointer(
  dealId: number,
  bucket: "kp_rows" | "zp_rows",
  stage: string,
  pointer: unknown
) {
  const current = await getDealState(dealId);
  if (!current) {
    return;
  }

  const nextBucket = {
    ...(current[bucket] ?? {}),
    [stage]: pointer
  };

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("dveri_opt_deal_state")
    .update({
      [bucket]: nextBucket,
      last_synced_at: new Date().toISOString()
    })
    .eq("deal_id", dealId);

  if (error) {
    throw new Error(`Failed to update deal state sheet pointer: ${error.message}`);
  }
}
