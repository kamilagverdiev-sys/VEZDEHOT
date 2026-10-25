-- Isolated server-authoritative Poker practice. No wallet, XP or checkpoint writes.
-- Only the Edge Function's service role can use these storage RPCs. Its verified
-- auth.getUser identity supplies p_user_id; browser-supplied identities are rejected
-- at the Edge boundary. These are NOT authenticated-player RPCs.
create schema if not exists vezdehot_private;
grant usage on schema vezdehot_private to service_role;

create table vezdehot_private.server_poker_games (
  user_id uuid primary key references auth.users(id) on delete cascade,
  -- This revision never resets when a finished table is replaced.
  revision bigint not null check (revision between 1 and 9007199254740991),
  state jsonb not null check (jsonb_typeof(state) = 'object' and octet_length(state::text) <= 65536),
  updated_at timestamptz not null default now()
);
create table vezdehot_private.server_poker_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  action_id uuid not null,
  request jsonb not null check (jsonb_typeof(request) = 'object' and octet_length(request::text) <= 4096),
  -- The Edge Function passes only its allowlisted public projection here.
  response jsonb not null check (jsonb_typeof(response) = 'object' and octet_length(response::text) <= 65536),
  created_at timestamptz not null default now(),
  primary key (user_id, action_id)
);
alter table vezdehot_private.server_poker_games enable row level security;
alter table vezdehot_private.server_poker_receipts enable row level security;
create policy server_poker_games_service on vezdehot_private.server_poker_games
  for all to service_role using (true) with check (true);
create policy server_poker_receipts_service on vezdehot_private.server_poker_receipts
  for all to service_role using (true) with check (true);
revoke all on vezdehot_private.server_poker_games, vezdehot_private.server_poker_receipts
  from public, anon, authenticated;
grant select, insert, update on vezdehot_private.server_poker_games to service_role;
grant select, insert on vezdehot_private.server_poker_receipts to service_role;

create function public.server_poker_read(
  p_user_id uuid, p_action_id uuid default null, p_request jsonb default null
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_game vezdehot_private.server_poker_games%rowtype;
  v_receipt vezdehot_private.server_poker_receipts%rowtype;
  v_result jsonb;
begin
  if current_user <> 'service_role' then
    raise exception 'Server access required' using errcode = '42501';
  end if;
  if p_user_id is null or (p_action_id is null) <> (p_request is null)
    or (p_request is not null and (jsonb_typeof(p_request) is distinct from 'object'
      or octet_length(p_request::text) > 4096)) then
    raise exception 'Invalid server Poker read' using errcode = '22023';
  end if;
  -- Serializes both the revision-zero case and receipt reads with commits.
  perform pg_advisory_xact_lock(hashtextextended('server-poker:' || p_user_id::text, 0));
  select * into v_game from vezdehot_private.server_poker_games where user_id = p_user_id;
  v_result := jsonb_build_object('revision', coalesce(v_game.revision, 0), 'state', v_game.state);
  if p_action_id is not null then
    select * into v_receipt from vezdehot_private.server_poker_receipts
      where user_id = p_user_id and action_id = p_action_id;
    if found then
      if v_receipt.request is distinct from p_request then
        raise exception 'Action ID reused with a different request' using errcode = '22023';
      end if;
      v_result := v_result || jsonb_build_object('receipt', v_receipt.response);
    end if;
  end if;
  return v_result;
end;
$$;

create function public.server_poker_commit(
  p_user_id uuid, p_expected_revision bigint, p_action_id uuid,
  p_request jsonb, p_state jsonb, p_response jsonb
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_game vezdehot_private.server_poker_games%rowtype;
  v_receipt vezdehot_private.server_poker_receipts%rowtype;
  v_revision bigint;
  v_now timestamptz;
begin
  if current_user <> 'service_role' then
    raise exception 'Server access required' using errcode = '42501';
  end if;
  if p_user_id is null or p_action_id is null or p_expected_revision is null
    or p_expected_revision not between 0 and 9007199254740990
    or jsonb_typeof(p_request) is distinct from 'object' or octet_length(p_request::text) > 4096 then
    raise exception 'Invalid server Poker request' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('server-poker:' || p_user_id::text, 0));
  select * into v_receipt from vezdehot_private.server_poker_receipts
    where user_id = p_user_id and action_id = p_action_id;
  if found then
    if v_receipt.request is distinct from p_request then
      raise exception 'Action ID reused with a different request' using errcode = '22023';
    end if;
    -- Retry always returns its original outcome, even after later actions.
    return jsonb_build_object('receipt', v_receipt.response);
  end if;
  select * into v_game from vezdehot_private.server_poker_games where user_id = p_user_id;
  v_revision := coalesce(v_game.revision, 0);
  if v_revision <> p_expected_revision then
    -- Private server-to-server data; the Edge Function must project before reply.
    return jsonb_build_object('conflict', true, 'revision', v_revision, 'state', v_game.state);
  end if;
  if jsonb_typeof(p_state) is distinct from 'object' or octet_length(p_state::text) > 65536
    or jsonb_typeof(p_state->'id') is distinct from 'string' or char_length(p_state->>'id') not between 1 and 100
    or jsonb_typeof(p_response) is distinct from 'object' or octet_length(p_response::text) > 65536
    or p_response->'revision' is distinct from to_jsonb(v_revision + 1)
    or p_response->>'status' is distinct from 'saved'
    or jsonb_typeof(p_response->'game') is distinct from 'object'
    or p_response->'game'->'id' is distinct from p_state->'id' then
    raise exception 'Invalid server Poker state or receipt' using errcode = '22023';
  end if;
  v_now := clock_timestamp();
  insert into vezdehot_private.server_poker_games(user_id, revision, state, updated_at)
    values (p_user_id, v_revision + 1, p_state, v_now)
    on conflict(user_id) do update set revision = excluded.revision,
      state = excluded.state, updated_at = excluded.updated_at;
  insert into vezdehot_private.server_poker_receipts(user_id, action_id, request, response, created_at)
    values (p_user_id, p_action_id, p_request, p_response, v_now);
  return jsonb_build_object('receipt', p_response);
end;
$$;

revoke all on function public.server_poker_read(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.server_poker_commit(uuid, bigint, uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.server_poker_read(uuid, uuid, jsonb) to service_role;
grant execute on function public.server_poker_commit(uuid, bigint, uuid, jsonb, jsonb, jsonb) to service_role;
