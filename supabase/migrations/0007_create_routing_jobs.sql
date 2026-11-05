create table public.dveri_opt_routing_jobs (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique,
  payload jsonb not null,
  status text not null default 'pending' check (
    status in ('pending', 'processing', 'retry', 'processed', 'skipped', 'failed', 'needs_review')
  ),
  attempts integer not null default 0 check (attempts >= 0),
  next_run_at timestamptz not null default now(),
  lease_until timestamptz,
  claim_token uuid,
  posting boolean not null default false,
  result jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index dveri_opt_routing_jobs_ready_idx
  on public.dveri_opt_routing_jobs (
    (case when payload->>'kind' in ('shift-scan', 'shift-lead') then 1 else 0 end),
    next_run_at, created_at, id
  )
  where status in ('pending', 'retry') and attempts < 5;

create index dveri_opt_routing_jobs_leased_idx
  on public.dveri_opt_routing_jobs (lease_until)
  where status = 'processing';

create index dveri_opt_routing_jobs_history_idx
  on public.dveri_opt_routing_jobs (updated_at, id)
  where status in ('processed', 'skipped', 'failed');

create trigger dveri_opt_routing_jobs_set_updated_at
before update on public.dveri_opt_routing_jobs
for each row execute function public.dveri_opt_set_updated_at();

alter table public.dveri_opt_routing_jobs enable row level security;
create policy dveri_opt_routing_jobs_service_role on public.dveri_opt_routing_jobs
  for all to service_role using (true) with check (true);

revoke all on table public.dveri_opt_routing_jobs from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.dveri_opt_routing_jobs to service_role;
