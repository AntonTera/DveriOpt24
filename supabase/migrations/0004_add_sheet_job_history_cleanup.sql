create or replace function public.dveri_opt_cleanup_sheet_jobs(
  processed_before timestamptz,
  failed_before timestamptz,
  processed_limit integer default 500,
  failed_limit integer default 100
)
returns table(deleted_processed integer, deleted_failed integer)
language plpgsql
as $$
declare
  deleted_processed_count integer := 0;
  deleted_failed_count integer := 0;
begin
  with processed_to_delete as (
    select id
    from public.dveri_opt_sheet_jobs
    where status = 'processed'
      and processed_at is not null
      and processed_at < processed_before
    order by processed_at asc
    limit processed_limit
  )
  delete from public.dveri_opt_sheet_jobs target
  using processed_to_delete
  where target.id = processed_to_delete.id;

  get diagnostics deleted_processed_count = row_count;

  with failed_to_delete as (
    select id
    from public.dveri_opt_sheet_jobs
    where status = 'failed'
      and updated_at < failed_before
    order by updated_at asc
    limit failed_limit
  )
  delete from public.dveri_opt_sheet_jobs target
  using failed_to_delete
  where target.id = failed_to_delete.id;

  get diagnostics deleted_failed_count = row_count;

  return query
  select deleted_processed_count, deleted_failed_count;
end;
$$;
