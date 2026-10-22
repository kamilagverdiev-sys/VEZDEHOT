create table public.telegram_identities (telegram_id bigint primary key check (telegram_id>0), user_id uuid not null unique references auth.users(id) on delete cascade, created_at timestamptz not null default now());
alter table public.telegram_identities enable row level security;
revoke all on public.telegram_identities from anon, authenticated;
grant select, insert on public.telegram_identities to service_role;
comment on table public.telegram_identities is 'Server-only mapping after Telegram Mini App signature verification';
