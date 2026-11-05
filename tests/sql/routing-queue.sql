-- Run with psql as the migration owner against an isolated database.
\set ON_ERROR_STOP on
begin;
truncate public.dveri_opt_routing_jobs;

do $$
declare
  role_name text;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.dveri_opt_routing_jobs'::regclass) then
    raise exception 'routing jobs must have RLS enabled';
  end if;

  foreach role_name in array array['anon', 'authenticated'] loop
    if has_table_privilege(role_name, 'public.dveri_opt_routing_jobs',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_function_privilege(role_name, 'public.dveri_opt_claim_routing_job()', 'EXECUTE')
      or has_function_privilege(role_name,
        'public.dveri_opt_cleanup_routing_jobs(timestamptz,integer)', 'EXECUTE') then
      raise exception '% unexpectedly has routing queue privileges', role_name;
    end if;
  end loop;
end;
$$;

set local role service_role;

do $$
declare
  job public.dveri_opt_routing_jobs%rowtype;
  old_token uuid;
  retry_token uuid := gen_random_uuid();
begin
  insert into public.dveri_opt_routing_jobs (dedupe_key, payload, next_run_at)
  values ('delayed', '{}', now() + interval '1 hour') returning * into job;
  if job.id is null or job.status is distinct from 'pending'
    or job.attempts is distinct from 0 or job.posting is distinct from false then
    raise exception 'routing job defaults are invalid';
  end if;

  begin
    insert into public.dveri_opt_routing_jobs (dedupe_key, payload) values ('delayed', '{}');
    raise exception 'duplicate dedupe_key was accepted';
  exception when unique_violation then
    null;
  end;

  if exists (select from public.dveri_opt_claim_routing_job()) then
    raise exception 'delayed job was claimed early';
  end if;

  insert into public.dveri_opt_routing_jobs (dedupe_key, payload, next_run_at, created_at, updated_at)
  values
    ('shift', '{"kind":"shift-lead"}', now() - interval '1 hour', now(), now()),
    ('first', '{}', now() - interval '2 minutes', now(), now() - interval '1 day'),
    ('second', '{}', now() - interval '1 minute', now() - interval '1 day', now()),
    ('third', '{}', now() - interval '1 minute', now(), now());

  select * into strict job from public.dveri_opt_claim_routing_job();
  if job.dedupe_key is distinct from 'first' or job.status is distinct from 'processing'
    or job.attempts is distinct from 1 or job.claim_token is null
    or job.lease_until is null or job.lease_until not between
      statement_timestamp() + interval '5 minutes' and clock_timestamp() + interval '5 minutes'
    or job.updated_at is distinct from now() then
    raise exception 'first claim has incorrect priority, ordering, token, lease, or timestamps';
  end if;
  old_token := job.claim_token;

  if exists (select from public.dveri_opt_claim_routing_job()) then
    raise exception 'an active lease did not prevent another claim';
  end if;

  update public.dveri_opt_routing_jobs set lease_until = now() - interval '1 second', posting = true
  where id = job.id;
  insert into public.dveri_opt_routing_jobs
    (dedupe_key, payload, status, attempts, lease_until, claim_token, next_run_at, posting)
  values
    ('expired-final', '{}', 'processing', 5, now() - interval '1 second', gen_random_uuid(), now(), false),
    ('expired-posting-final', '{}', 'processing', 5, now() - interval '1 second', gen_random_uuid(), now(), true),
    ('expired-retry', '{}', 'processing', 4, now() - interval '1 second', retry_token, now(), false),
    ('capped-pending', '{}', 'pending', 5, null, null, now() - interval '1 day', false),
    ('capped-retry', '{}', 'retry', 5, null, null, now() - interval '1 day', false);

  select * into strict job from public.dveri_opt_claim_routing_job();
  if job.dedupe_key is distinct from 'second' or job.claim_token is null or job.claim_token = old_token then
    raise exception 'claim did not skip capped jobs, sort ties by creation time, or issue a fresh token';
  end if;

  if (select count(*) from public.dveri_opt_routing_jobs
      where lease_until is null and claim_token is null and (
        (dedupe_key in ('first', 'expired-posting-final') and status = 'needs_review' and posting)
        or (dedupe_key = 'expired-final' and status = 'failed' and attempts = 5)
        or (dedupe_key = 'expired-retry' and status = 'retry' and attempts = 4)
      )) <> 4 then
    raise exception 'expired leases were not recovered safely';
  end if;

  update public.dveri_opt_routing_jobs set status = 'processed', lease_until = null, claim_token = null
  where dedupe_key = 'second';
  update public.dveri_opt_routing_jobs set next_run_at = now() - interval '1 hour'
  where dedupe_key = 'expired-retry';

  select * into strict job from public.dveri_opt_claim_routing_job();
  if job.dedupe_key is distinct from 'expired-retry' or job.attempts is distinct from 5
    or job.claim_token is null or job.claim_token = retry_token then
    raise exception 'retry was not claimed for its fifth attempt with a new token';
  end if;
end;
$$;

do $$
begin
  insert into public.dveri_opt_routing_jobs (dedupe_key, payload, status, updated_at)
  values
    ('old-processed', '{}', 'processed', now() - interval '4 days'),
    ('old-skipped', '{}', 'skipped', now() - interval '3 days'),
    ('old-failed', '{}', 'failed', now() - interval '2 days'),
    ('old-needs-review', '{}', 'needs_review', now() - interval '5 days'),
    ('old-pending', '{}', 'pending', now() - interval '5 days'),
    ('old-processing', '{}', 'processing', now() - interval '5 days'),
    ('old-retry', '{}', 'retry', now() - interval '5 days'),
    ('at-cutoff', '{}', 'processed', now() - interval '1 day');

  if public.dveri_opt_cleanup_routing_jobs(now() - interval '1 day', null) is distinct from 0
    or public.dveri_opt_cleanup_routing_jobs(now() - interval '1 day', 0) is distinct from 0
    or public.dveri_opt_cleanup_routing_jobs(now() - interval '1 day', -1) is distinct from 0 then
    raise exception 'cleanup accepted an invalid batch size';
  end if;

  if public.dveri_opt_cleanup_routing_jobs(now() - interval '1 day', 2) is distinct from 2 then
    raise exception 'cleanup did not honor the requested batch size';
  end if;
  if exists (select from public.dveri_opt_routing_jobs where dedupe_key in ('old-processed', 'old-skipped')) then
    raise exception 'cleanup did not delete the two oldest terminal rows';
  end if;
  if public.dveri_opt_cleanup_routing_jobs(now() - interval '1 day', 2) is distinct from 1 then
    raise exception 'cleanup did not delete exactly the remaining eligible row';
  end if;
  if (select count(*) from public.dveri_opt_routing_jobs where dedupe_key in
      ('old-needs-review', 'old-pending', 'old-processing', 'old-retry', 'at-cutoff', 'second')) <> 6 then
    raise exception 'cleanup removed an active, recent, or unresolved job';
  end if;

  insert into public.dveri_opt_routing_jobs (dedupe_key, payload, status, updated_at)
  select 'batch-' || i, '{}', 'processed', now() - interval '2 days' from generate_series(1, 1001) i;

  if public.dveri_opt_cleanup_routing_jobs(now() - interval '1 day', 2147483647) is distinct from 1000 then
    raise exception 'cleanup did not cap the batch at 1000 rows';
  end if;
  if (select count(*) from public.dveri_opt_routing_jobs where dedupe_key like 'batch-%') <> 1 then
    raise exception 'cleanup removed the row beyond the batch cap';
  end if;
end;
$$;

rollback;
