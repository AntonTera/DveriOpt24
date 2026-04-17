create extension if not exists pgcrypto;

create table if not exists public.dveri_opt_webhook_events (
  id uuid primary key default gen_random_uuid(),
  lead_id bigint not null,
  pipeline_id bigint,
  status_id bigint,
  event_type text not null,
  received_at timestamptz not null default now(),
  payload_hash text not null unique,
  raw_payload jsonb not null,
  processing_status text not null default 'pending',
  process_attempts integer not null default 0,
  next_run_at timestamptz,
  processed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.dveri_opt_sheet_jobs (
  id uuid primary key default gen_random_uuid(),
  deal_id bigint not null,
  sheet_name text not null,
  job_type text not null,
  row_key text not null,
  payload jsonb not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  next_run_at timestamptz,
  processed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.dveri_opt_deal_state (
  deal_id bigint primary key,
  object_type text,
  is_frozen boolean not null default false,
  active_kpis jsonb not null default '{}'::jsonb,
  kp_rows jsonb not null default '{}'::jsonb,
  zp_rows jsonb not null default '{}'::jsonb,
  last_status_id bigint,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists dveri_opt_webhook_events_processing_idx
  on public.dveri_opt_webhook_events (processing_status, received_at);

create index if not exists dveri_opt_sheet_jobs_processing_idx
  on public.dveri_opt_sheet_jobs (status, next_run_at, created_at);

create or replace function public.dveri_opt_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists dveri_opt_webhook_events_set_updated_at on public.dveri_opt_webhook_events;
create trigger dveri_opt_webhook_events_set_updated_at
before update on public.dveri_opt_webhook_events
for each row
execute function public.dveri_opt_set_updated_at();

drop trigger if exists dveri_opt_sheet_jobs_set_updated_at on public.dveri_opt_sheet_jobs;
create trigger dveri_opt_sheet_jobs_set_updated_at
before update on public.dveri_opt_sheet_jobs
for each row
execute function public.dveri_opt_set_updated_at();

drop trigger if exists dveri_opt_deal_state_set_updated_at on public.dveri_opt_deal_state;
create trigger dveri_opt_deal_state_set_updated_at
before update on public.dveri_opt_deal_state
for each row
execute function public.dveri_opt_set_updated_at();

create or replace function public.dveri_opt_claim_webhook_events(batch_size integer default 10)
returns setof public.dveri_opt_webhook_events
language sql
as $$
  with claimed as (
    update public.dveri_opt_webhook_events
    set
      processing_status = 'processing',
      process_attempts = process_attempts + 1,
      updated_at = now()
    where id in (
      select id
      from public.dveri_opt_webhook_events
      where processing_status in ('pending', 'retry')
        and coalesce(next_run_at, now()) <= now()
      order by received_at asc
      limit batch_size
      for update skip locked
    )
    returning *
  )
  select * from claimed;
$$;

create or replace function public.dveri_opt_claim_sheet_jobs(batch_size integer default 5)
returns setof public.dveri_opt_sheet_jobs
language sql
as $$
  with claimed as (
    update public.dveri_opt_sheet_jobs
    set
      status = 'processing',
      attempts = attempts + 1,
      updated_at = now()
    where id in (
      select id
      from public.dveri_opt_sheet_jobs
      where status in ('pending', 'retry')
        and coalesce(next_run_at, now()) <= now()
      order by created_at asc
      limit batch_size
      for update skip locked
    )
    returning *
  )
  select * from claimed;
$$;
