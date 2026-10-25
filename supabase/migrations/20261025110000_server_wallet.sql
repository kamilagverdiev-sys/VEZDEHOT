-- Protected practice currency, separate from legacy client checkpoints.
-- Verified Edge identities alone reach these service-role RPCs. Monetary changes
-- share the game-state/receipt transaction and one per-user wallet lock.
create table vezdehot_private.server_wallets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null check (revision between 1 and 9007199254740991),
  balance bigint not null check (balance between 0 and 2000000000),
  xp bigint not null default 0 check (xp between 0 and 2000000000),
  games bigint not null default 0 check (games between 0 and 2000000000),
  wins bigint not null default 0 check (wins between 0 and games),
  bonus_available_at timestamptz not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create table vezdehot_private.server_wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references vezdehot_private.server_wallets(user_id) on delete cascade,
  revision bigint not null check (revision between 1 and 9007199254740991),
  kind text not null check (kind in ('welcome','daily','entry','settlement')),
  game text check (game in ('durak','poker')),
  table_id uuid,
  delta integer not null check (delta between -100 and 1000),
  xp integer not null check (xp between 0 and 90),
  outcome text check (outcome in ('win','draw','loss','resigned')),
  balance bigint not null check (balance between 0 and 2000000000),
  created_at timestamptz not null,
  unique (user_id,revision),
  check ((kind in ('welcome','daily') and game is null and table_id is null and delta=1000 and xp=0 and outcome is null)
    or (kind='entry' and game is not null and table_id is not null and delta=-100 and xp=0 and outcome is null)
    or (kind='settlement' and game is not null and table_id is not null and delta between 0 and 400 and outcome is not null))
);
create unique index server_wallet_welcome_once on vezdehot_private.server_wallet_ledger(user_id)
  where kind='welcome';
create unique index server_wallet_game_event_once on vezdehot_private.server_wallet_ledger(user_id,game,table_id,kind)
  where game is not null;
create table vezdehot_private.server_wallet_receipts (
  user_id uuid not null references vezdehot_private.server_wallets(user_id) on delete cascade,
  action_id uuid not null,
  request jsonb not null check (jsonb_typeof(request)='object' and octet_length(request::text)<=4096),
  response jsonb not null check (jsonb_typeof(response)='object' and octet_length(response::text)<=4096),
  created_at timestamptz not null,
  primary key (user_id,action_id)
);
alter table vezdehot_private.server_wallets enable row level security;
alter table vezdehot_private.server_wallet_ledger enable row level security;
alter table vezdehot_private.server_wallet_receipts enable row level security;
create policy server_wallets_service on vezdehot_private.server_wallets for all to service_role using (true) with check (true);
create policy server_wallet_ledger_service on vezdehot_private.server_wallet_ledger for all to service_role using (true) with check (true);
create policy server_wallet_receipts_service on vezdehot_private.server_wallet_receipts for all to service_role using (true) with check (true);
revoke all on vezdehot_private.server_wallets,vezdehot_private.server_wallet_ledger,vezdehot_private.server_wallet_receipts from public,anon,authenticated,service_role;
grant select,insert,update on vezdehot_private.server_wallets to service_role;
grant select,insert on vezdehot_private.server_wallet_ledger,vezdehot_private.server_wallet_receipts to service_role;

create function vezdehot_private.server_wallet_time(p_time timestamptz) returns text
language sql immutable security invoker set search_path='' as $$
  select to_char(p_time at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;
create function vezdehot_private.server_wallet_integer(p_value jsonb,p_min numeric,p_max numeric) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare v numeric;
begin
  if jsonb_typeof(p_value) is distinct from 'number' then return false; end if;
  v := (p_value #>> '{}')::numeric;
  return v between p_min and p_max and v=trunc(v);
end;
$$;
create function vezdehot_private.server_wallet_ensure(p_user_id uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare v_now timestamptz;
begin
  if current_user <> 'service_role' then raise exception 'Server access required' using errcode='42501'; end if;
  if p_user_id is null then raise exception 'Invalid wallet owner' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('server-wallet:'||p_user_id::text,0));
  if exists(select 1 from vezdehot_private.server_wallets where user_id=p_user_id) then return; end if;
  v_now := clock_timestamp();
  insert into vezdehot_private.server_wallets(user_id,revision,balance,xp,games,wins,bonus_available_at,created_at,updated_at)
    values(p_user_id,1,1000,0,0,0,v_now+interval '24 hours',v_now,v_now);
  insert into vezdehot_private.server_wallet_ledger(user_id,revision,kind,delta,xp,balance,created_at)
    values(p_user_id,1,'welcome',1000,0,1000,v_now);
end;
$$;
create function public.server_wallet_read(p_user_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare w vezdehot_private.server_wallets%rowtype; h jsonb;
begin
  if current_user <> 'service_role' then raise exception 'Server access required' using errcode='42501'; end if;
  perform vezdehot_private.server_wallet_ensure(p_user_id);
  select * into strict w from vezdehot_private.server_wallets where user_id=p_user_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'game',game,'tableId',table_id,'delta',delta,'xp',xp,
      'balance',balance,'createdAt',vezdehot_private.server_wallet_time(created_at)) order by revision desc),'[]'::jsonb)
    into h from (select * from vezdehot_private.server_wallet_ledger where user_id=p_user_id order by revision desc limit 20) recent;
  return jsonb_build_object('version',1,'revision',w.revision,'balance',w.balance,'xp',w.xp,'games',w.games,'wins',w.wins,
    'bonusAvailableAt',vezdehot_private.server_wallet_time(w.bonus_available_at),
    'serverTime',vezdehot_private.server_wallet_time(clock_timestamp()),'history',h);
end;
$$;
create function public.server_wallet_claim(p_user_id uuid,p_action_id uuid,p_request jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare w vezdehot_private.server_wallets%rowtype; r vezdehot_private.server_wallet_receipts%rowtype;
  v_now timestamptz; response jsonb;
begin
  if current_user <> 'service_role' then raise exception 'Server access required' using errcode='42501'; end if;
  if p_user_id is null or p_action_id is null or jsonb_typeof(p_request) is distinct from 'object'
    or p_request->>'op' is distinct from 'claimDaily' or jsonb_typeof(p_request->'actionId') is distinct from 'string'
    or lower(p_request->>'actionId') is distinct from p_action_id::text
    or exists(select 1 from jsonb_object_keys(p_request) k where k not in ('op','actionId')) then
    raise exception 'Invalid daily bonus request' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('server-wallet:'||p_user_id::text,0));
  select * into r from vezdehot_private.server_wallet_receipts where user_id=p_user_id and action_id=p_action_id;
  if found then
    if r.request is distinct from p_request then raise exception 'Action ID reused with a different request' using errcode='22023'; end if;
    return r.response;
  end if;
  perform vezdehot_private.server_wallet_ensure(p_user_id);
  select * into strict w from vezdehot_private.server_wallets where user_id=p_user_id for update;
  v_now := clock_timestamp();
  if v_now < w.bonus_available_at then
    response := jsonb_build_object('status','cooldown','actionId',p_action_id,'availableAt',vezdehot_private.server_wallet_time(w.bonus_available_at));
  else
    update vezdehot_private.server_wallets set balance=balance+1000,revision=revision+1,
      bonus_available_at=v_now+interval '24 hours',updated_at=v_now where user_id=p_user_id returning * into w;
    insert into vezdehot_private.server_wallet_ledger(user_id,revision,kind,delta,xp,balance,created_at)
      values(p_user_id,w.revision,'daily',1000,0,w.balance,v_now);
    response := jsonb_build_object('status','saved','actionId',p_action_id);
  end if;
  insert into vezdehot_private.server_wallet_receipts(user_id,action_id,request,response,created_at)
    values(p_user_id,p_action_id,p_request,response,v_now);
  return response;
end;
$$;

-- Validate economy metadata separately from card rules. The Edge executes the
-- canonical game engine; SQL independently recomputes every monetary outcome.
create function vezdehot_private.server_wallet_economy_stake(e jsonb) returns integer
language plpgsql immutable security invoker set search_path='' as $$
begin
  if e is null then return 0; end if;
  if jsonb_typeof(e) is distinct from 'object' or e->'version' is distinct from '1'::jsonb
    or not e ?& array['version','stake','settled','payout','xp','outcome']
    or exists(select 1 from jsonb_object_keys(e) k where k not in ('version','stake','settled','payout','xp','outcome'))
    or e->'stake' not in ('0'::jsonb,'100'::jsonb) or jsonb_typeof(e->'settled') is distinct from 'boolean'
    or not vezdehot_private.server_wallet_integer(e->'payout',0,400)
    or not vezdehot_private.server_wallet_integer(e->'xp',0,90)
    or (e->'outcome' <> 'null'::jsonb and (jsonb_typeof(e->'outcome') is distinct from 'string' or e->>'outcome' not in ('win','draw','loss','resigned'))) then
    raise exception 'Invalid server economy' using errcode='22023';
  end if;
  if e->'stake'='0'::jsonb and (e->'payout'<>'0'::jsonb or e->'xp'<>'0'::jsonb) then
    raise exception 'Free game cannot pay' using errcode='22023';
  end if;
  return (e->>'stake')::integer;
end;
$$;
create function vezdehot_private.server_wallet_apply_game(p_user_id uuid,p_game text,p_request jsonb,p_previous jsonb,p_state jsonb,p_response jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare old_stake integer; new_stake integer; e jsonb; g jsonb; w vezdehot_private.server_wallets%rowtype;
  v_table uuid; v_now timestamptz; v_payout integer:=0; v_xp integer:=0; v_outcome text;
  is_start boolean; player_count integer; human_chips integer; expected jsonb; active_count integer; active_seat integer;
begin
  if current_user <> 'service_role' then raise exception 'Server access required' using errcode='42501'; end if;
  if p_game not in ('durak','poker') or p_user_id is null then raise exception 'Invalid game economy' using errcode='22023'; end if;
  old_stake := vezdehot_private.server_wallet_economy_stake(p_previous->'economy');
  new_stake := vezdehot_private.server_wallet_economy_stake(p_state->'economy');
  is_start := p_request->>'op'='start';
  -- A legacy free state may remain opaque. No legacy input can reach a wallet.
  if old_stake=0 and new_stake=0 then
    if coalesce(p_request->'stake','0'::jsonb)<>'0'::jsonb then raise exception 'Stake mismatch' using errcode='22023'; end if;
    if is_start and (p_state->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then
      if exists(select 1 from vezdehot_private.server_wallet_ledger where user_id=p_user_id and game=p_game and table_id=(p_state->>'id')::uuid) then
        raise exception 'Table ID was already used' using errcode='22023';
      end if;
    end if;
    return;
  end if;
  if (p_state->>'id') is null or (p_state->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'Invalid paid table ID' using errcode='22023';
  end if;
  v_table := (p_state->>'id')::uuid;
  if is_start then
    if coalesce(p_request->'stake','0'::jsonb) is distinct from to_jsonb(new_stake)
      or (p_previous is not null and (p_previous->'over' is distinct from 'true'::jsonb or p_previous->'id'=p_state->'id'))
      or (old_stake=100 and p_previous->'economy'->'settled' is distinct from 'true'::jsonb) then
      raise exception 'Invalid paid table replacement' using errcode='22023';
    end if;
    if exists(select 1 from vezdehot_private.server_wallet_ledger where user_id=p_user_id and game=p_game and table_id=v_table) then
      raise exception 'Table ID was already used' using errcode='22023';
    end if;
    if new_stake=0 then return; end if;
  else
    if p_request->>'op' is distinct from 'action' or old_stake<>100 or new_stake<>100
      or p_previous->'id' is distinct from p_state->'id' or p_request->'gameId' is distinct from p_state->'id'
      or p_previous->'over' is distinct from 'false'::jsonb or p_previous->'economy'->'settled' is distinct from 'false'::jsonb then
      raise exception 'Invalid paid table transition' using errcode='22023';
    end if;
    if not exists(select 1 from vezdehot_private.server_wallet_ledger where user_id=p_user_id and game=p_game and table_id=v_table and kind='entry')
      or exists(select 1 from vezdehot_private.server_wallet_ledger where user_id=p_user_id and game=p_game and table_id=v_table and kind='settlement') then
      raise exception 'Paid entry is missing or already settled' using errcode='22023';
    end if;
  end if;
  e := p_state->'economy';
  if p_response->'game'->'economy' is distinct from e or jsonb_typeof(p_state->'over') is distinct from 'boolean' then
    raise exception 'Economy projection mismatch' using errcode='22023';
  end if;
  if p_game='durak' then
    if jsonb_typeof(p_state->'players') is distinct from 'array' then raise exception 'Invalid Durak players' using errcode='22023'; end if;
    player_count := jsonb_array_length(p_state->'players');
    if player_count not between 2 and 4 or (not is_start and jsonb_array_length(p_previous->'players')<>player_count)
      or (is_start and (not vezdehot_private.server_wallet_integer(p_request->'bots',1,3) or (p_request->>'bots')::integer+1<>player_count)) then
      raise exception 'Invalid Durak player count' using errcode='22023';
    end if;
  end if;
  if p_state->'over'='false'::jsonb then
    expected := jsonb_build_object('version',1,'stake',100,'settled',false,'payout',0,'xp',0,'outcome',null);
  else
    if is_start then raise exception 'New paid table cannot be finished' using errcode='22023'; end if;
    if p_game='durak' then
      if jsonb_typeof(p_state->'draw') is distinct from 'boolean' or jsonb_typeof(p_state->'finished') is distinct from 'array'
        or jsonb_typeof(p_state->'players'->0->'hand') is distinct from 'array' or p_state->>'phase' is distinct from 'over' then
        raise exception 'Invalid terminal Durak state' using errcode='22023';
      end if;
      if exists(select 1 from jsonb_array_elements(p_state->'players') p where jsonb_typeof(p->'hand') is distinct from 'array') then
        raise exception 'Invalid Durak hands' using errcode='22023';
      end if;
      if p_state->'resigned' is distinct from 'true'::jsonb then
        select count(*)::integer,min((ord-1)::integer) into active_count,active_seat
          from jsonb_array_elements(p_state->'players') with ordinality p(value,ord) where jsonb_array_length(value->'hand')>0;
        if p_state->'deck' is distinct from '[]'::jsonb or p_state->'table' is distinct from '[]'::jsonb
          or active_count>1 or p_state->'draw' is distinct from to_jsonb(active_count=0)
          or p_state->'loser' is distinct from coalesce(to_jsonb(active_seat),'null'::jsonb)
          or jsonb_array_length(p_state->'finished')<>player_count-active_count then
          raise exception 'Inconsistent terminal Durak outcome' using errcode='22023';
        end if;
        if exists(select 1 from jsonb_array_elements(p_state->'finished') f where not vezdehot_private.server_wallet_integer(f,0,player_count-1)) then
          raise exception 'Invalid finished Durak seat' using errcode='22023';
        end if;
        if (select count(distinct f) from jsonb_array_elements(p_state->'finished') f)<>jsonb_array_length(p_state->'finished')
          or exists(select 1 from jsonb_array_elements(p_state->'finished') f where jsonb_array_length(p_state->'players'->(f::text)::integer->'hand')<>0) then
          raise exception 'Invalid finished Durak players' using errcode='22023';
        end if;
      end if;
      if p_state->'resigned'='true'::jsonb then v_outcome:='resigned';
      elsif p_state->'draw'='true'::jsonb then v_outcome:='draw'; v_payout:=100; v_xp:=40;
      elsif p_state->'finished' @> '[0]'::jsonb or p_state->'winner'='0'::jsonb then v_outcome:='win'; v_payout:=100*player_count; v_xp:=80;
      else v_outcome:='loss'; v_xp:=25;
      end if;
      if v_outcome in ('draw','win') and jsonb_array_length(p_state->'players'->0->'hand')<>0 then
        raise exception 'Durak winner still holds cards' using errcode='22023';
      end if;
    else
      g := p_state->'game';
      if jsonb_typeof(g) is distinct from 'object' or g->'over' is distinct from 'true'::jsonb
        or jsonb_typeof(g->'players') is distinct from 'array' then
        raise exception 'Paid Poker closes only after a hand' using errcode='22023';
      end if;
      if jsonb_array_length(g->'players')<>4 or not vezdehot_private.server_wallet_integer(g->'players'->0->'chips',0,4000) then
        raise exception 'Invalid Poker cashout' using errcode='22023';
      end if;
      if exists(select 1 from jsonb_array_elements(g->'players') p where not vezdehot_private.server_wallet_integer(p->'chips',0,4000)) then
        raise exception 'Invalid Poker chips' using errcode='22023';
      end if;
      if (select sum((p->>'chips')::integer) from jsonb_array_elements(g->'players') p)<>4000
        or (g->'tableClosed' is distinct from 'true'::jsonb and g->'players'->0->'chips'<>'0'::jsonb
          and g->'players'->0->'chips'<>'4000'::jsonb) then
        raise exception 'Invalid terminal Poker table' using errcode='22023';
      end if;
      human_chips := (g->'players'->0->>'chips')::integer;
      v_payout := human_chips/10;
      if v_payout>100 then v_outcome:='win'; v_xp:=90;
      elsif v_payout=100 then v_outcome:='draw'; v_xp:=40;
      else v_outcome:='loss'; v_xp:=20;
      end if;
    end if;
    expected := jsonb_build_object('version',1,'stake',100,'settled',true,'payout',v_payout,'xp',v_xp,'outcome',v_outcome);
  end if;
  if e is distinct from expected then raise exception 'Incorrect server settlement' using errcode='22023'; end if;
  perform vezdehot_private.server_wallet_ensure(p_user_id);
  select * into strict w from vezdehot_private.server_wallets where user_id=p_user_id for update;
  v_now := clock_timestamp();
  if is_start then
    if w.balance<100 then raise exception 'insufficient_funds' using errcode='P0001'; end if;
    update vezdehot_private.server_wallets set balance=balance-100,revision=revision+1,updated_at=v_now
      where user_id=p_user_id returning * into w;
    insert into vezdehot_private.server_wallet_ledger(user_id,revision,kind,game,table_id,delta,xp,balance,created_at)
      values(p_user_id,w.revision,'entry',p_game,v_table,-100,0,w.balance,v_now);
  elsif p_state->'over'='true'::jsonb then
    update vezdehot_private.server_wallets set balance=balance+v_payout,xp=xp+v_xp,games=games+1,
      wins=wins+case when v_outcome='win' then 1 else 0 end,revision=revision+1,updated_at=v_now
      where user_id=p_user_id returning * into w;
    insert into vezdehot_private.server_wallet_ledger(user_id,revision,kind,game,table_id,delta,xp,outcome,balance,created_at)
      values(p_user_id,w.revision,'settlement',p_game,v_table,v_payout,v_xp,v_outcome,w.balance,v_now);
  end if;
end;
$$;

revoke all on function vezdehot_private.server_wallet_time(timestamptz),vezdehot_private.server_wallet_integer(jsonb,numeric,numeric),
  vezdehot_private.server_wallet_ensure(uuid),vezdehot_private.server_wallet_economy_stake(jsonb),
  vezdehot_private.server_wallet_apply_game(uuid,text,jsonb,jsonb,jsonb,jsonb),public.server_wallet_read(uuid),public.server_wallet_claim(uuid,uuid,jsonb)
  from public,anon,authenticated;
grant execute on function vezdehot_private.server_wallet_time(timestamptz),vezdehot_private.server_wallet_integer(jsonb,numeric,numeric),
  vezdehot_private.server_wallet_ensure(uuid),vezdehot_private.server_wallet_economy_stake(jsonb),
  vezdehot_private.server_wallet_apply_game(uuid,text,jsonb,jsonb,jsonb,jsonb),public.server_wallet_read(uuid),public.server_wallet_claim(uuid,uuid,jsonb)
  to service_role;

-- Game commit replacements are appended below. All writers lock wallet first,
-- then the one game's lock. Reads never acquire a wallet lock after a game lock.

create or replace function public.server_durak_commit(
  p_user_id uuid, p_expected_revision bigint, p_action_id uuid,
  p_request jsonb, p_state jsonb, p_response jsonb
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_game vezdehot_private.server_durak_games%rowtype;
  v_receipt vezdehot_private.server_durak_receipts%rowtype;
  v_revision bigint;
  v_now timestamptz;
begin
  if current_user <> 'service_role' then
    raise exception 'Server access required' using errcode = '42501';
  end if;
  if p_user_id is null or p_action_id is null or p_expected_revision is null
    or p_expected_revision not between 0 and 9007199254740990
    or jsonb_typeof(p_request) is distinct from 'object' or octet_length(p_request::text) > 4096 then
    raise exception 'Invalid server Durak request' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('server-wallet:' || p_user_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('server-durak:' || p_user_id::text, 0));
  select * into v_receipt from vezdehot_private.server_durak_receipts
    where user_id = p_user_id and action_id = p_action_id;
  if found then
    if v_receipt.request is distinct from p_request then
      raise exception 'Action ID reused with a different request' using errcode = '22023';
    end if;
    -- Retry always returns its original outcome, even after later actions.
    return jsonb_build_object('receipt', v_receipt.response);
  end if;
  select * into v_game from vezdehot_private.server_durak_games where user_id = p_user_id;
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
    raise exception 'Invalid server Durak state or receipt' using errcode = '22023';
  end if;
  if (p_state->'economy'->'stake'='100'::jsonb or v_game.state->'economy'->'stake'='100'::jsonb)
    and (lower(p_request->>'actionId') is distinct from p_action_id::text or p_request->'expectedRevision' is distinct from to_jsonb(p_expected_revision)) then
    raise exception 'Paid request identity mismatch' using errcode='22023';
  end if;
  perform vezdehot_private.server_wallet_apply_game(p_user_id,'durak',p_request,v_game.state,p_state,p_response);
  v_now := clock_timestamp();
  insert into vezdehot_private.server_durak_games(user_id, revision, state, updated_at)
    values (p_user_id, v_revision + 1, p_state, v_now)
    on conflict(user_id) do update set revision = excluded.revision,
      state = excluded.state, updated_at = excluded.updated_at;
  insert into vezdehot_private.server_durak_receipts(user_id, action_id, request, response, created_at)
    values (p_user_id, p_action_id, p_request, p_response, v_now);
  return jsonb_build_object('receipt', p_response);
end;
$$;

create or replace function public.server_poker_commit(
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
  perform pg_advisory_xact_lock(hashtextextended('server-wallet:' || p_user_id::text, 0));
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
  if (p_state->'economy'->'stake'='100'::jsonb or v_game.state->'economy'->'stake'='100'::jsonb)
    and (lower(p_request->>'actionId') is distinct from p_action_id::text or p_request->'expectedRevision' is distinct from to_jsonb(p_expected_revision)) then
    raise exception 'Paid request identity mismatch' using errcode='22023';
  end if;
  perform vezdehot_private.server_wallet_apply_game(p_user_id,'poker',p_request,v_game.state,p_state,p_response);
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

comment on table vezdehot_private.server_wallets is 'Server-authoritative practice wallet, independent from legacy profile/checkpoints.';
comment on table vezdehot_private.server_wallet_ledger is 'Append-only wallet events. Entry and settlement are unique per owner, game and stable table ID.';
comment on table vezdehot_private.server_wallet_receipts is 'Permanent daily-bonus receipts, including cooldown outcomes; never prune while clients may retry.';
