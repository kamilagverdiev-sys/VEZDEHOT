-- Server Bunker: private state, permanent request receipts and one protected
-- wallet transaction. Existing Durak/Poker settlement functions are unchanged.
alter table vezdehot_private.server_wallet_ledger
  drop constraint server_wallet_ledger_game_check,
  add constraint server_wallet_ledger_game_check check (game in ('durak','poker','bunker')),
  drop constraint server_wallet_ledger_xp_check,
  add constraint server_wallet_ledger_xp_check check (xp between 0 and 120);

create table vezdehot_private.server_bunker_games (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null check (revision between 1 and 9007199254740991),
  state jsonb not null check (jsonb_typeof(state)='object' and octet_length(state::text)<=65536),
  updated_at timestamptz not null default now()
);
create table vezdehot_private.server_bunker_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  action_id uuid not null,
  request jsonb not null check (jsonb_typeof(request)='object' and octet_length(request::text)<=4096),
  response jsonb not null check (jsonb_typeof(response)='object' and octet_length(response::text)<=65536),
  created_at timestamptz not null default now(),
  primary key(user_id,action_id)
);
alter table vezdehot_private.server_bunker_games enable row level security;
alter table vezdehot_private.server_bunker_receipts enable row level security;
create policy server_bunker_games_service on vezdehot_private.server_bunker_games
  for all to service_role using (true) with check (true);
create policy server_bunker_receipts_service on vezdehot_private.server_bunker_receipts
  for all to service_role using (true) with check (true);
revoke all on vezdehot_private.server_bunker_games,vezdehot_private.server_bunker_receipts
  from public,anon,authenticated,service_role;
grant select,insert,update on vezdehot_private.server_bunker_games to service_role;
grant select,insert on vezdehot_private.server_bunker_receipts to service_role;

-- Separate contract: Bunker win XP is 120. Do not widen the game-specific
-- Durak/Poker validation helper, whose maximum is intentionally still 90.
create function vezdehot_private.server_bunker_stake(e jsonb) returns integer
language plpgsql immutable security invoker set search_path='' as $$
begin
  if jsonb_typeof(e) is distinct from 'object' or e->'version' is distinct from '1'::jsonb
    or not e ?& array['version','stake','settled','payout','xp','outcome']
    or exists(select 1 from jsonb_object_keys(e) k where k not in ('version','stake','settled','payout','xp','outcome'))
    or e->'stake' not in ('0'::jsonb,'100'::jsonb) or jsonb_typeof(e->'settled') is distinct from 'boolean'
    or not vezdehot_private.server_wallet_integer(e->'payout',0,250)
    or not vezdehot_private.server_wallet_integer(e->'xp',0,120)
    or (e->'outcome'<>'null'::jsonb and (jsonb_typeof(e->'outcome') is distinct from 'string'
      or e->>'outcome' not in ('win','loss','resigned'))) then
    raise exception 'Invalid Bunker economy' using errcode='22023';
  end if;
  return (e->>'stake')::integer;
end;
$$;

create function vezdehot_private.server_wallet_apply_bunker(
  p_user_id uuid,p_request jsonb,p_previous jsonb,p_state jsonb,p_response jsonb
) returns void language plpgsql security invoker set search_path='' as $$
declare
  v_stake integer; old_stake integer; alive_count integer; v_table uuid;
  is_start boolean; terminal_vote boolean; v_outcome text;
  v_payout integer:=0; v_xp integer:=0; expected jsonb;
  w vezdehot_private.server_wallets%rowtype; v_now timestamptz;
begin
  if current_user<>'service_role' then raise exception 'Server access required' using errcode='42501'; end if;
  if p_user_id is null then raise exception 'Invalid Bunker owner' using errcode='22023'; end if;
  v_stake:=vezdehot_private.server_bunker_stake(p_state->'economy');
  old_stake:=case when p_previous is null then 0 else vezdehot_private.server_bunker_stake(p_previous->'economy') end;
  is_start:=p_request->>'op'='start';
  if p_state->'version' is distinct from '2'::jsonb
    or jsonb_typeof(p_state->'id') is distinct from 'string'
    or p_state->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or jsonb_typeof(p_state->'players') is distinct from 'array'
    or jsonb_typeof(p_state->'over') is distinct from 'boolean'
    or jsonb_typeof(p_state->'resigned') is distinct from 'boolean'
    or p_state->'stake' is distinct from to_jsonb(v_stake)
    or not vezdehot_private.server_wallet_integer(p_state->'round',1,3)
    or coalesce(p_state->>'phase','') not in ('reveal','vote','voteResult','over')
    or coalesce(p_state->>'diff','') not in ('easy','normal','hard') then
    raise exception 'Invalid Bunker game state' using errcode='22023';
  end if;
  if jsonb_array_length(p_state->'players')<>6
    or exists(select 1 from jsonb_array_elements(p_state->'players') p where jsonb_typeof(p->'alive') is distinct from 'boolean') then
    raise exception 'Invalid Bunker candidates' using errcode='22023';
  end if;
  select count(*)::integer into alive_count from jsonb_array_elements(p_state->'players') p where p->'alive'='true'::jsonb;
  if alive_count not between 3 and 6 then raise exception 'Invalid Bunker survivors' using errcode='22023'; end if;
  v_table:=(p_state->>'id')::uuid;
  if p_response->'game'->'economy' is distinct from p_state->'economy'
    or p_response->'game'->'over' is distinct from p_state->'over'
    or p_response->'game'->'result' is distinct from p_state->'result' then
    raise exception 'Bunker outcome projection mismatch' using errcode='22023';
  end if;
  if is_start then
    if coalesce(p_request->'stake','0'::jsonb) is distinct from to_jsonb(v_stake)
      or p_state->'diff' is distinct from p_request->'difficulty'
      or p_state->'over' is distinct from 'false'::jsonb or p_state->>'phase' is distinct from 'reveal'
      or p_state->'round' is distinct from '1'::jsonb or alive_count<>6
      or (p_previous is not null and (p_previous->'over' is distinct from 'true'::jsonb
        or p_previous->'economy'->'settled' is distinct from 'true'::jsonb or p_previous->'id'=p_state->'id')) then
      raise exception 'Invalid Bunker replacement' using errcode='22023';
    end if;
    if exists(select 1 from vezdehot_private.server_wallet_ledger where user_id=p_user_id and game='bunker' and table_id=v_table) then
      raise exception 'Bunker table ID was already used' using errcode='22023';
    end if;
  else
    if p_request->>'op' is distinct from 'action' or p_previous is null or old_stake<>v_stake
      or p_previous->'id' is distinct from p_state->'id' or p_request->'gameId' is distinct from p_state->'id'
      or p_previous->'over' is distinct from 'false'::jsonb or p_previous->'economy'->'settled' is distinct from 'false'::jsonb
      or p_state->'diff' is distinct from p_previous->'diff' then
      raise exception 'Invalid Bunker transition' using errcode='22023';
    end if;
    if v_stake=100 and (not exists(select 1 from vezdehot_private.server_wallet_ledger
        where user_id=p_user_id and game='bunker' and table_id=v_table and kind='entry')
      or exists(select 1 from vezdehot_private.server_wallet_ledger
        where user_id=p_user_id and game='bunker' and table_id=v_table and kind='settlement')) then
      raise exception 'Bunker entry is missing or already settled' using errcode='22023';
    end if;
  end if;
  if p_state->'over'='false'::jsonb then
    if p_state->>'phase'='over' or p_state->'resigned'<>'false'::jsonb or p_state->'result' is distinct from 'null'::jsonb then
      raise exception 'Invalid active Bunker outcome' using errcode='22023';
    end if;
    expected:=jsonb_build_object('version',1,'stake',v_stake,'settled',false,'payout',0,'xp',0,'outcome',null);
  else
    if is_start or p_state->>'phase' is distinct from 'over'
      or p_state->'players' is distinct from p_previous->'players' or p_state->'round' is distinct from p_previous->'round'
      or coalesce(p_request->'action'->>'type','') not in ('continue','resign') then
      raise exception 'Invalid terminal Bunker transition' using errcode='22023';
    end if;
    terminal_vote:=p_previous->>'phase'='voteResult' and (alive_count=3 or p_state->'players'->0->'alive'='false'::jsonb);
    if terminal_vote then
      if p_state->'resigned' is distinct from 'false'::jsonb then
        raise exception 'Earned Bunker result cannot be forfeited' using errcode='22023';
      end if;
      if p_state->'players'->0->'alive'='true'::jsonb then
        if alive_count<>3 or p_state->>'result' is distinct from 'survived' then
          raise exception 'Invalid Bunker win' using errcode='22023';
        end if;
        v_outcome:='win'; if v_stake=100 then v_payout:=250; v_xp:=120; end if;
      else
        if p_state->>'result' is distinct from 'lost' then raise exception 'Invalid Bunker loss' using errcode='22023'; end if;
        v_outcome:='loss'; if v_stake=100 then v_xp:=25; end if;
      end if;
    else
      if p_request->'action'->>'type' is distinct from 'resign' or p_state->'resigned' is distinct from 'true'::jsonb
        or p_state->>'result' is distinct from 'lost' or p_state->'players'->0->'alive' is distinct from 'true'::jsonb
        or alive_count<=3 then
        raise exception 'Invalid Bunker resignation' using errcode='22023';
      end if;
      v_outcome:='resigned';
    end if;
    expected:=jsonb_build_object('version',1,'stake',v_stake,'settled',true,'payout',v_payout,'xp',v_xp,'outcome',v_outcome);
  end if;
  if p_state->'economy' is distinct from expected then raise exception 'Incorrect Bunker settlement' using errcode='22023'; end if;
  -- Free practice neither initializes a wallet nor increments statistics.
  if v_stake=0 then return; end if;
  perform vezdehot_private.server_wallet_ensure(p_user_id);
  select * into strict w from vezdehot_private.server_wallets where user_id=p_user_id for update;
  v_now:=clock_timestamp();
  if is_start then
    if w.balance<100 then raise exception 'insufficient_funds' using errcode='P0001'; end if;
    update vezdehot_private.server_wallets set balance=balance-100,revision=revision+1,updated_at=v_now
      where user_id=p_user_id returning * into w;
    insert into vezdehot_private.server_wallet_ledger(user_id,revision,kind,game,table_id,delta,xp,balance,created_at)
      values(p_user_id,w.revision,'entry','bunker',v_table,-100,0,w.balance,v_now);
  elsif p_state->'over'='true'::jsonb then
    update vezdehot_private.server_wallets set balance=balance+v_payout,xp=xp+v_xp,games=games+1,
      wins=wins+case when v_outcome='win' then 1 else 0 end,revision=revision+1,updated_at=v_now
      where user_id=p_user_id returning * into w;
    insert into vezdehot_private.server_wallet_ledger(user_id,revision,kind,game,table_id,delta,xp,outcome,balance,created_at)
      values(p_user_id,w.revision,'settlement','bunker',v_table,v_payout,v_xp,v_outcome,w.balance,v_now);
  end if;
end;
$$;

create function public.server_bunker_read(p_user_id uuid,p_action_id uuid default null,p_request jsonb default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare g vezdehot_private.server_bunker_games%rowtype; r vezdehot_private.server_bunker_receipts%rowtype; answer jsonb;
begin
  if current_user<>'service_role' then raise exception 'Server access required' using errcode='42501'; end if;
  if p_user_id is null or (p_action_id is null)<>(p_request is null)
    or (p_request is not null and (jsonb_typeof(p_request) is distinct from 'object' or octet_length(p_request::text)>4096)) then
    raise exception 'Invalid Bunker read' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('server-bunker:'||p_user_id::text,0));
  select * into g from vezdehot_private.server_bunker_games where user_id=p_user_id;
  answer:=jsonb_build_object('revision',coalesce(g.revision,0),'state',g.state);
  if p_action_id is not null then
    select * into r from vezdehot_private.server_bunker_receipts where user_id=p_user_id and action_id=p_action_id;
    if found then
      if r.request is distinct from p_request then raise exception 'Action ID reused with a different request' using errcode='22023'; end if;
      answer:=answer||jsonb_build_object('receipt',r.response);
    end if;
  end if;
  return answer;
end;
$$;

create function public.server_bunker_commit(p_user_id uuid,p_expected_revision bigint,p_action_id uuid,
  p_request jsonb,p_state jsonb,p_response jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare g vezdehot_private.server_bunker_games%rowtype; r vezdehot_private.server_bunker_receipts%rowtype;
  v_revision bigint; v_now timestamptz;
begin
  if current_user<>'service_role' then raise exception 'Server access required' using errcode='42501'; end if;
  if p_user_id is null or p_action_id is null or p_expected_revision is null
    or p_expected_revision not between 0 and 9007199254740990
    or jsonb_typeof(p_request) is distinct from 'object' or octet_length(p_request::text)>4096
    or lower(p_request->>'actionId') is distinct from p_action_id::text
    or p_request->'expectedRevision' is distinct from to_jsonb(p_expected_revision) then
    raise exception 'Invalid Bunker request' using errcode='22023';
  end if;
  -- Match every existing game writer: wallet lock first, game lock second.
  perform pg_advisory_xact_lock(hashtextextended('server-wallet:'||p_user_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('server-bunker:'||p_user_id::text,0));
  select * into r from vezdehot_private.server_bunker_receipts where user_id=p_user_id and action_id=p_action_id;
  if found then
    if r.request is distinct from p_request then raise exception 'Action ID reused with a different request' using errcode='22023'; end if;
    return jsonb_build_object('receipt',r.response);
  end if;
  select * into g from vezdehot_private.server_bunker_games where user_id=p_user_id;
  v_revision:=coalesce(g.revision,0);
  if v_revision<>p_expected_revision then
    -- Internal state only: the Edge projects this before replying to a player.
    return jsonb_build_object('conflict',true,'revision',v_revision,'state',g.state);
  end if;
  if jsonb_typeof(p_state) is distinct from 'object' or octet_length(p_state::text)>65536
    or jsonb_typeof(p_response) is distinct from 'object' or octet_length(p_response::text)>65536
    or p_response->'revision' is distinct from to_jsonb(v_revision+1)
    or p_response->>'status' is distinct from 'saved' or jsonb_typeof(p_response->'game') is distinct from 'object'
    or p_response->'game'->'id' is distinct from p_state->'id' then
    raise exception 'Invalid Bunker state or receipt' using errcode='22023';
  end if;
  perform vezdehot_private.server_wallet_apply_bunker(p_user_id,p_request,g.state,p_state,p_response);
  v_now:=clock_timestamp();
  insert into vezdehot_private.server_bunker_games(user_id,revision,state,updated_at)
    values(p_user_id,v_revision+1,p_state,v_now)
    on conflict(user_id) do update set revision=excluded.revision,state=excluded.state,updated_at=excluded.updated_at;
  insert into vezdehot_private.server_bunker_receipts(user_id,action_id,request,response,created_at)
    values(p_user_id,p_action_id,p_request,p_response,v_now);
  return jsonb_build_object('receipt',p_response);
end;
$$;

revoke all on function vezdehot_private.server_bunker_stake(jsonb),
  vezdehot_private.server_wallet_apply_bunker(uuid,jsonb,jsonb,jsonb,jsonb),
  public.server_bunker_read(uuid,uuid,jsonb),public.server_bunker_commit(uuid,bigint,uuid,jsonb,jsonb,jsonb)
  from public,anon,authenticated;
grant execute on function vezdehot_private.server_bunker_stake(jsonb),
  vezdehot_private.server_wallet_apply_bunker(uuid,jsonb,jsonb,jsonb,jsonb),
  public.server_bunker_read(uuid,uuid,jsonb),public.server_bunker_commit(uuid,bigint,uuid,jsonb,jsonb,jsonb)
  to service_role;

comment on table vezdehot_private.server_bunker_games is 'Server Bunker with hidden traits and future events; never exposed to browser roles.';
