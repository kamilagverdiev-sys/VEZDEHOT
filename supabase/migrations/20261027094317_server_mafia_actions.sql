-- Server Mafia: private state, permanent request receipts and one protected
-- wallet transaction. Existing Durak/Poker settlement functions are unchanged.
alter table vezdehot_private.server_wallet_ledger
  drop constraint server_wallet_ledger_game_check,
  add constraint server_wallet_ledger_game_check check (game in ('durak','poker','bunker','mafia')),
  drop constraint server_wallet_ledger_xp_check,
  add constraint server_wallet_ledger_xp_check check (xp between 0 and 130);

create table vezdehot_private.server_mafia_games (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null check (revision between 1 and 9007199254740991),
  state jsonb not null check (jsonb_typeof(state)='object' and octet_length(state::text)<=65536),
  updated_at timestamptz not null default now()
);
create table vezdehot_private.server_mafia_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  action_id uuid not null,
  request jsonb not null check (jsonb_typeof(request)='object' and octet_length(request::text)<=4096),
  response jsonb not null check (jsonb_typeof(response)='object' and octet_length(response::text)<=65536),
  created_at timestamptz not null default now(),
  primary key(user_id,action_id)
);
alter table vezdehot_private.server_mafia_games enable row level security;
alter table vezdehot_private.server_mafia_receipts enable row level security;
create policy server_mafia_games_service on vezdehot_private.server_mafia_games
  for all to service_role using (true) with check (true);
create policy server_mafia_receipts_service on vezdehot_private.server_mafia_receipts
  for all to service_role using (true) with check (true);
revoke all on vezdehot_private.server_mafia_games,vezdehot_private.server_mafia_receipts
  from public,anon,authenticated,service_role;
grant select,insert,update on vezdehot_private.server_mafia_games to service_role;
grant select,insert on vezdehot_private.server_mafia_receipts to service_role;

-- Separate contract: Mafia win XP is 130. Do not widen the game-specific
-- Durak/Poker validation helper, whose maximum is intentionally still 90.
create function vezdehot_private.server_mafia_stake(e jsonb) returns integer
language plpgsql immutable security invoker set search_path='' as $$
begin
  if jsonb_typeof(e) is distinct from 'object' or e->'version' is distinct from '1'::jsonb
    or not e ?& array['version','stake','settled','payout','xp','outcome']
    or exists(select 1 from jsonb_object_keys(e) k where k not in ('version','stake','settled','payout','xp','outcome'))
    or e->'stake' not in ('0'::jsonb,'100'::jsonb) or jsonb_typeof(e->'settled') is distinct from 'boolean'
    or not vezdehot_private.server_wallet_integer(e->'payout',0,250)
    or not vezdehot_private.server_wallet_integer(e->'xp',0,130)
    or (e->'outcome'<>'null'::jsonb and (jsonb_typeof(e->'outcome') is distinct from 'string'
      or e->>'outcome' not in ('win','loss','draw','resigned'))) then
    raise exception 'Invalid Mafia economy' using errcode='22023';
  end if;
  return (e->>'stake')::integer;
end;
$$;

create function vezdehot_private.server_wallet_apply_mafia(
  p_user_id uuid,p_request jsonb,p_previous jsonb,p_state jsonb,p_response jsonb
) returns void language plpgsql security invoker set search_path='' as $$
declare
  v_stake integer; old_stake integer; alive_count integer; mafia_count integer; town_count integer; v_table uuid;
  is_start boolean; v_action text; v_team text; v_outcome text; own_team text;
  v_payout integer:=0; v_xp integer:=0; expected jsonb;
  w vezdehot_private.server_wallets%rowtype; v_now timestamptz;
begin
  if current_user<>'service_role' then raise exception 'Server access required' using errcode='42501'; end if;
  if p_user_id is null then raise exception 'Invalid Mafia owner' using errcode='22023'; end if;
  v_stake:=vezdehot_private.server_mafia_stake(p_state->'economy');
  old_stake:=case when p_previous is null then 0 else vezdehot_private.server_mafia_stake(p_previous->'economy') end;
  is_start:=p_request->>'op'='start'; v_action:=p_request->'action'->>'type';
  if p_state->'version' is distinct from '3'::jsonb
    or jsonb_typeof(p_state->'id') is distinct from 'string'
    or p_state->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or jsonb_typeof(p_state->'players') is distinct from 'array'
    or jsonb_typeof(p_state->'over') is distinct from 'boolean'
    or jsonb_typeof(p_state->'resigned') is distinct from 'boolean'
    or jsonb_typeof(p_state->'win') is distinct from 'boolean'
    or jsonb_typeof(p_state->'draw') is distinct from 'boolean'
    or p_state->'settled' is distinct from p_state->'over'
    or p_state->'stake' is distinct from to_jsonb(v_stake)
    or not vezdehot_private.server_wallet_integer(p_state->'round',1,25)
    or coalesce(p_state->>'phase','') not in ('night','dawn','day','vote','voteResult','result')
    or coalesce(p_state->>'diff','') not in ('easy','normal','hard') then
    raise exception 'Invalid Mafia game state' using errcode='22023';
  end if;
  if jsonb_array_length(p_state->'players')<>7
    or exists(select 1 from jsonb_array_elements(p_state->'players') with ordinality as p(value,n)
      where jsonb_typeof(value->'alive') is distinct from 'boolean' or value->'id' is distinct from to_jsonb(n-1)
        or coalesce(value->>'role','') not in ('mafia','doctor','detective','civilian'))
    or (select count(*) from jsonb_array_elements(p_state->'players') p where p->>'role'='mafia')<>2
    or (select count(*) from jsonb_array_elements(p_state->'players') p where p->>'role'='doctor')<>1
    or (select count(*) from jsonb_array_elements(p_state->'players') p where p->>'role'='detective')<>1 then
    raise exception 'Invalid Mafia seats or roles' using errcode='22023';
  end if;
  select count(*)::integer,count(*) filter(where p->>'role'='mafia')::integer into alive_count,mafia_count
    from jsonb_array_elements(p_state->'players') p where p->'alive'='true'::jsonb;
  town_count:=alive_count-mafia_count;
  if alive_count<1 then raise exception 'Invalid Mafia survivors' using errcode='22023'; end if;
  own_team:=case when p_state->'players'->0->>'role'='mafia' then 'mafia' else 'town' end;
  v_table:=(p_state->>'id')::uuid;
  if p_response->'game'->'economy' is distinct from p_state->'economy'
    or p_response->'game'->'over' is distinct from p_state->'over'
    or p_response->'game'->'phase' is distinct from p_state->'phase'
    or p_response->'game'->'winningTeam' is distinct from p_state->'winningTeam'
    or p_response->'game'->'win' is distinct from p_state->'win'
    or p_response->'game'->'draw' is distinct from p_state->'draw'
    or p_response->'game'->'resigned' is distinct from p_state->'resigned' then
    raise exception 'Mafia outcome projection mismatch' using errcode='22023';
  end if;
  if is_start then
    if coalesce(p_request->'stake','0'::jsonb) is distinct from to_jsonb(v_stake)
      or p_state->'diff' is distinct from p_request->'difficulty'
      or p_state->'over' is distinct from 'false'::jsonb or p_state->>'phase' is distinct from 'night'
      or p_state->'round' is distinct from '1'::jsonb or alive_count<>7
      or (p_previous is not null and (p_previous->'over' is distinct from 'true'::jsonb
        or p_previous->'economy'->'settled' is distinct from 'true'::jsonb or p_previous->'id'=p_state->'id')) then
      raise exception 'Invalid Mafia replacement' using errcode='22023';
    end if;
    if exists(select 1 from vezdehot_private.server_wallet_ledger where user_id=p_user_id and game='mafia' and table_id=v_table) then
      raise exception 'Mafia table ID was already used' using errcode='22023';
    end if;
  else
    if p_request->>'op' is distinct from 'action' or p_previous is null or old_stake<>v_stake
      or p_previous->'id' is distinct from p_state->'id' or p_request->'gameId' is distinct from p_state->'id'
      or p_previous->'over' is distinct from 'false'::jsonb or p_previous->'economy'->'settled' is distinct from 'false'::jsonb
      or p_state->'diff' is distinct from p_previous->'diff'
      or coalesce(v_action,'') not in ('night','vote','continue','finish','mark','resign')
      or (p_state->>'round')::integer<(p_previous->>'round')::integer
      or (v_action<>'finish' and (p_state->>'round')::integer>(p_previous->>'round')::integer+1)
      or exists(select 1 from jsonb_array_elements(p_state->'players') with ordinality as p(value,n)
        where value->'role' is distinct from p_previous->'players'->(n::integer-1)->'role'
          or (value->'alive'='true'::jsonb and p_previous->'players'->(n::integer-1)->'alive' is distinct from 'true'::jsonb)) then
      raise exception 'Invalid Mafia transition' using errcode='22023';
    end if;
    if v_stake=100 and (not exists(select 1 from vezdehot_private.server_wallet_ledger
        where user_id=p_user_id and game='mafia' and table_id=v_table and kind='entry')
      or exists(select 1 from vezdehot_private.server_wallet_ledger
        where user_id=p_user_id and game='mafia' and table_id=v_table and kind='settlement')) then
      raise exception 'Mafia entry is missing or already settled' using errcode='22023';
    end if;
    if v_action in ('mark','resign') and (p_state->'players' is distinct from p_previous->'players' or p_state->'round' is distinct from p_previous->'round')
      or v_action in ('night','vote') and p_state->'round' is distinct from p_previous->'round'
      or v_action='night' and p_previous->>'phase' is distinct from 'night'
      or v_action='vote' and p_previous->>'phase' is distinct from 'vote'
      or v_action='continue' and coalesce(p_previous->>'phase','') not in ('dawn','day','voteResult')
      or v_action='finish' and p_previous->'players'->0->'alive' is distinct from 'false'::jsonb
      or v_action in ('night','vote') and (select count(*) from jsonb_array_elements(p_state->'players') with ordinality as p(value,n)
        where value->'alive'='false'::jsonb and p_previous->'players'->(n::integer-1)->'alive'='true'::jsonb)>1
      or v_action='night' and exists(select 1 from jsonb_array_elements(p_state->'players') with ordinality as p(value,n)
        where value->>'role'='mafia' and value->'alive' is distinct from p_previous->'players'->(n::integer-1)->'alive') then
      raise exception 'Invalid Mafia action phase' using errcode='22023';
    end if;
  end if;
  if p_state->'over'='false'::jsonb then
    if p_state->>'phase'='result' or p_state->'resigned' is distinct from 'false'::jsonb
      or p_state->'winningTeam' is distinct from 'null'::jsonb or p_state->'win' is distinct from 'false'::jsonb
      or p_state->'draw' is distinct from 'false'::jsonb or mafia_count=0 or mafia_count>=town_count then
      raise exception 'Invalid active Mafia outcome' using errcode='22023';
    end if;
    if not is_start and (
      v_action in ('finish','resign')
      or v_action='night' and p_state->>'phase' is distinct from 'dawn'
      or v_action='vote' and p_state->>'phase' is distinct from 'voteResult'
      or v_action='mark' and p_state->'phase' is distinct from p_previous->'phase'
      or v_action='continue' and (p_state->'players' is distinct from p_previous->'players'
        or p_state->>'phase' is distinct from case p_previous->>'phase' when 'dawn' then 'day' when 'day' then 'vote' else 'night' end
        or (p_state->>'round')::integer<>(p_previous->>'round')::integer+case when p_previous->>'phase'='voteResult' then 1 else 0 end)) then
      raise exception 'Invalid active Mafia phase transition' using errcode='22023';
    end if;
    expected:=jsonb_build_object('version',1,'stake',v_stake,'settled',false,'payout',0,'xp',0,'outcome',null);
  else
    if is_start or p_state->>'phase' is distinct from 'result' or v_action='mark' then
      raise exception 'Invalid terminal Mafia transition' using errcode='22023';
    end if;
    if p_state->'resigned'='true'::jsonb then
      if v_action is distinct from 'resign' or p_state->'winningTeam' is distinct from 'null'::jsonb
        or p_state->'win' is distinct from 'false'::jsonb or p_state->'draw' is distinct from 'false'::jsonb then
        raise exception 'Invalid Mafia resignation' using errcode='22023';
      end if;
      v_outcome:='resigned';
    else
      if v_action='resign' then raise exception 'Resignation cannot award a Mafia win' using errcode='22023'; end if;
      v_team:=case when mafia_count=0 then 'town' when mafia_count>=town_count then 'mafia' else 'draw' end;
      if p_state->>'winningTeam' is distinct from v_team
        or p_state->'win' is distinct from to_jsonb(v_team=own_team)
        or p_state->'draw' is distinct from to_jsonb(v_team='draw')
        or (v_team='draw' and (p_state->'round' is distinct from '25'::jsonb
          or v_action not in ('continue','finish')
          or v_action='continue' and (p_previous->>'phase' is distinct from 'voteResult' or p_previous->'round' is distinct from '25'::jsonb)))
        or (v_action='continue' and (v_team<>'draw' or p_state->'players' is distinct from p_previous->'players')) then
        raise exception 'Invalid Mafia winner or draw' using errcode='22023';
      end if;
      v_outcome:=case when v_team='draw' then 'draw' when v_team=own_team then 'win' else 'loss' end;
      if v_stake=100 then
        v_payout:=case v_outcome when 'win' then 250 when 'draw' then 100 else 0 end;
        v_xp:=case v_outcome when 'win' then 130 when 'draw' then 40 else 25 end;
      end if;
    end if;
    expected:=jsonb_build_object('version',1,'stake',v_stake,'settled',true,'payout',v_payout,'xp',v_xp,'outcome',v_outcome);
  end if;
  if p_state->'economy' is distinct from expected then raise exception 'Incorrect Mafia settlement' using errcode='22023'; end if;
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
      values(p_user_id,w.revision,'entry','mafia',v_table,-100,0,w.balance,v_now);
  elsif p_state->'over'='true'::jsonb then
    update vezdehot_private.server_wallets set balance=balance+v_payout,xp=xp+v_xp,games=games+1,
      wins=wins+case when v_outcome='win' then 1 else 0 end,revision=revision+1,updated_at=v_now
      where user_id=p_user_id returning * into w;
    insert into vezdehot_private.server_wallet_ledger(user_id,revision,kind,game,table_id,delta,xp,outcome,balance,created_at)
      values(p_user_id,w.revision,'settlement','mafia',v_table,v_payout,v_xp,v_outcome,w.balance,v_now);
  end if;
end;
$$;


create function public.server_mafia_read(p_user_id uuid,p_action_id uuid default null,p_request jsonb default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare g vezdehot_private.server_mafia_games%rowtype; r vezdehot_private.server_mafia_receipts%rowtype; answer jsonb;
begin
  if current_user<>'service_role' then raise exception 'Server access required' using errcode='42501'; end if;
  if p_user_id is null or (p_action_id is null)<>(p_request is null)
    or (p_request is not null and (jsonb_typeof(p_request) is distinct from 'object' or octet_length(p_request::text)>4096)) then
    raise exception 'Invalid Mafia read' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('server-mafia:'||p_user_id::text,0));
  select * into g from vezdehot_private.server_mafia_games where user_id=p_user_id;
  answer:=jsonb_build_object('revision',coalesce(g.revision,0),'state',g.state);
  if p_action_id is not null then
    select * into r from vezdehot_private.server_mafia_receipts where user_id=p_user_id and action_id=p_action_id;
    if found then
      if r.request is distinct from p_request then raise exception 'Action ID reused with a different request' using errcode='22023'; end if;
      answer:=answer||jsonb_build_object('receipt',r.response);
    end if;
  end if;
  return answer;
end;
$$;

create function public.server_mafia_commit(p_user_id uuid,p_expected_revision bigint,p_action_id uuid,
  p_request jsonb,p_state jsonb,p_response jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare g vezdehot_private.server_mafia_games%rowtype; r vezdehot_private.server_mafia_receipts%rowtype;
  v_revision bigint; v_now timestamptz;
begin
  if current_user<>'service_role' then raise exception 'Server access required' using errcode='42501'; end if;
  if p_user_id is null or p_action_id is null or p_expected_revision is null
    or p_expected_revision not between 0 and 9007199254740990
    or jsonb_typeof(p_request) is distinct from 'object' or octet_length(p_request::text)>4096
    or lower(p_request->>'actionId') is distinct from p_action_id::text
    or p_request->'expectedRevision' is distinct from to_jsonb(p_expected_revision) then
    raise exception 'Invalid Mafia request' using errcode='22023';
  end if;
  -- Match every existing game writer: wallet lock first, game lock second.
  perform pg_advisory_xact_lock(hashtextextended('server-wallet:'||p_user_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('server-mafia:'||p_user_id::text,0));
  select * into r from vezdehot_private.server_mafia_receipts where user_id=p_user_id and action_id=p_action_id;
  if found then
    if r.request is distinct from p_request then raise exception 'Action ID reused with a different request' using errcode='22023'; end if;
    return jsonb_build_object('receipt',r.response);
  end if;
  select * into g from vezdehot_private.server_mafia_games where user_id=p_user_id;
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
    raise exception 'Invalid Mafia state or receipt' using errcode='22023';
  end if;
  perform vezdehot_private.server_wallet_apply_mafia(p_user_id,p_request,g.state,p_state,p_response);
  v_now:=clock_timestamp();
  insert into vezdehot_private.server_mafia_games(user_id,revision,state,updated_at)
    values(p_user_id,v_revision+1,p_state,v_now)
    on conflict(user_id) do update set revision=excluded.revision,state=excluded.state,updated_at=excluded.updated_at;
  insert into vezdehot_private.server_mafia_receipts(user_id,action_id,request,response,created_at)
    values(p_user_id,p_action_id,p_request,p_response,v_now);
  return jsonb_build_object('receipt',p_response);
end;
$$;

revoke all on function vezdehot_private.server_mafia_stake(jsonb),
  vezdehot_private.server_wallet_apply_mafia(uuid,jsonb,jsonb,jsonb,jsonb),
  public.server_mafia_read(uuid,uuid,jsonb),public.server_mafia_commit(uuid,bigint,uuid,jsonb,jsonb,jsonb)
  from public,anon,authenticated;
grant execute on function vezdehot_private.server_mafia_stake(jsonb),
  vezdehot_private.server_wallet_apply_mafia(uuid,jsonb,jsonb,jsonb,jsonb),
  public.server_mafia_read(uuid,uuid,jsonb),public.server_mafia_commit(uuid,bigint,uuid,jsonb,jsonb,jsonb)
  to service_role;

comment on table vezdehot_private.server_mafia_games is 'Server Mafia with hidden roles and private night actions; never exposed to browser roles.';
