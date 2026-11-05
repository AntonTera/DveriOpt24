grant usage on schema public to service_role;

grant select, insert, update, delete
on table public.dveri_opt_webhook_events, public.dveri_opt_sheet_jobs
to service_role;

grant select, insert, update
on table public.dveri_opt_deal_state
to service_role;

grant execute on function public.dveri_opt_claim_webhook_events(integer)
to service_role;
grant execute on function public.dveri_opt_claim_sheet_jobs(integer)
to service_role;
grant execute on function public.dveri_opt_cleanup_webhook_events(timestamptz, timestamptz, integer, integer)
to service_role;
grant execute on function public.dveri_opt_cleanup_sheet_jobs(timestamptz, timestamptz, integer, integer)
to service_role;
