-- VEZDEHOT core schema
-- The same schema is applied to the hosted project through Supabase MCP.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null default 'Игрок' check (char_length(nickname) between 2 and 24),
  balance integer not null default 10000 check (balance >= 0),
  xp integer not null default 0 check (xp >= 0),
  wins integer not null default 0 check (wins >= 0),
  games integer not null default 0 check (games >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.game_sessions (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references auth.users(id) on delete cascade,
  room_code text not null unique check (room_code ~ '^[A-Z0-9]{6}$'),
  game_type text not null check (game_type in ('durak','bunker','poker','mafia','monopoly')),
  status text not null default 'waiting' check (status in ('waiting','active','finished','cancelled')),
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.game_events (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.game_sessions(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists game_sessions_room_code_idx on public.game_sessions(room_code);
create index if not exists game_sessions_host_id_idx on public.game_sessions(host_id);
create index if not exists game_events_session_created_idx on public.game_events(session_id, created_at);

alter table public.profiles enable row level security;
alter table public.game_sessions enable row level security;
alter table public.game_events enable row level security;

grant select, insert, update on public.profiles to authenticated;
grant select, insert, update, delete on public.game_sessions to authenticated;
grant select, insert on public.game_events to authenticated;

create policy if not exists profiles_select_own on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy if not exists profiles_insert_own on public.profiles for insert to authenticated with check ((select auth.uid()) = id);
create policy if not exists profiles_update_own on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create policy if not exists sessions_select_host on public.game_sessions for select to authenticated using ((select auth.uid()) = host_id);
create policy if not exists sessions_insert_host on public.game_sessions for insert to authenticated with check ((select auth.uid()) = host_id);
create policy if not exists sessions_update_host on public.game_sessions for update to authenticated using ((select auth.uid()) = host_id) with check ((select auth.uid()) = host_id);
create policy if not exists sessions_delete_host on public.game_sessions for delete to authenticated using ((select auth.uid()) = host_id);
create policy if not exists events_select_session_host on public.game_events for select to authenticated using (exists (select 1 from public.game_sessions s where s.id = session_id and s.host_id = (select auth.uid())));
create policy if not exists events_insert_session_host on public.game_events for insert to authenticated with check (exists (select 1 from public.game_sessions s where s.id = session_id and s.host_id = (select auth.uid())));
