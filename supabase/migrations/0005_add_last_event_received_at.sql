alter table public.dveri_opt_deal_state
add column if not exists last_event_received_at timestamptz;
