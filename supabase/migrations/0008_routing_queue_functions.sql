create function public.dveri_opt_claim_routing_job()
returns setof public.dveri_opt_routing_jobs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  claim_time timestamptz;
begin
  -- Serialize claims even when no leased row exists yet.
  if not pg_try_advisory_xact_lock(hashtextextended('public.dveri_opt_routing_jobs', 0)) then
    return;
  end if;

  claim_time := clock_timestamp();
  update public.dveri_opt_routing_jobs
  set status = case
        when posting then 'needs_review'
        when attempts >= 5 then 'failed'
        else 'retry'
      end,
      last_error = case when posting then 'reply_creation_unconfirmed' else 'routing_lease_expired' end,
      claim_token = null,
      lease_until = null
  where status = 'processing' and lease_until <= claim_time;

  if exists (
    select 1 from public.dveri_opt_routing_jobs
    where status = 'processing' and lease_until > claim_time
  ) then
    return;
  end if;

  return query
  update public.dveri_opt_routing_jobs job
  set status = 'processing',
      attempts = job.attempts + 1,
      claim_token = gen_random_uuid(),
      lease_until = clock_timestamp() + interval '5 minutes',
      posting = false
  where job.id = (
    select ready.id from public.dveri_opt_routing_jobs ready
    where ready.status in ('pending', 'retry') and ready.attempts < 5
      and ready.next_run_at <= claim_time
    -- An overnight batch should not delay incoming deals, tasks, or messages.
    order by case when ready.payload->>'kind' in ('shift-scan', 'shift-lead') then 1 else 0 end,
      ready.next_run_at, ready.created_at, ready.id
    limit 1
    for update skip locked
  )
  returning job.*;
end;
$$;

create function public.dveri_opt_cleanup_routing_jobs(history_before timestamptz, batch_size integer)
returns integer
language sql
security invoker
set search_path = ''
as $$
  with expired as (
    select id from public.dveri_opt_routing_jobs
    -- Keep needs_review jobs until an operator resolves them.
    where status in ('processed', 'skipped', 'failed') and updated_at < history_before
    order by updated_at, id
    limit least(greatest(coalesce(batch_size, 0), 0), 1000)
    for update skip locked
  ), deleted as (
    delete from public.dveri_opt_routing_jobs job
    using expired
    where job.id = expired.id
    returning job.id
  )
  select count(*)::integer from deleted;
$$;

revoke all on function public.dveri_opt_claim_routing_job() from public, anon, authenticated;
revoke all on function public.dveri_opt_cleanup_routing_jobs(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.dveri_opt_claim_routing_job() to service_role;
grant execute on function public.dveri_opt_cleanup_routing_jobs(timestamptz, integer) to service_role;
