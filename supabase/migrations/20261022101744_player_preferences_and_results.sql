alter table public.profiles add column if not exists preferences jsonb not null default '{}'::jsonb;
create table if not exists public.player_results (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null check (char_length(id) between 1 and 100),
  game text not null check (game in ('durak','bunker','poker','mafia','monopoly')),
  win boolean not null default false,
  delta integer not null default 0,
  xp integer not null default 0 check (xp>=0),
  played_at timestamptz not null default now(),
  primary key(user_id,id)
);
alter table public.player_results enable row level security;
grant select,insert on public.player_results to authenticated;
create policy results_select_own on public.player_results for select to authenticated using ((select auth.uid())=user_id);
create policy results_insert_own on public.player_results for insert to authenticated with check ((select auth.uid())=user_id);
create index if not exists player_results_recent on public.player_results(user_id,played_at desc);
