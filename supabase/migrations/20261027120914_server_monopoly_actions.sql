-- Server Monopoly: immutable board economics, private authoritative state and
-- atomic protected-wallet settlement. Existing game XP contracts stay unchanged.
alter table vezdehot_private.server_wallet_ledger
  drop constraint server_wallet_ledger_game_check,
  add constraint server_wallet_ledger_game_check check (game in ('durak','poker','bunker','mafia','monopoly'));

create table vezdehot_private.server_monopoly_games (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null check (revision between 1 and 9007199254740991),
  state jsonb not null check (jsonb_typeof(state)='object' and octet_length(state::text)<=65536),
  updated_at timestamptz not null default now()
);
create table vezdehot_private.server_monopoly_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  action_id uuid not null,
  request jsonb not null check (jsonb_typeof(request)='object' and octet_length(request::text)<=4096),
  response jsonb not null check (jsonb_typeof(response)='object' and octet_length(response::text)<=65536),
  created_at timestamptz not null default now(),
  primary key(user_id,action_id)
);
alter table vezdehot_private.server_monopoly_games enable row level security;
alter table vezdehot_private.server_monopoly_receipts enable row level security;
create policy server_monopoly_games_service on vezdehot_private.server_monopoly_games
  for all to service_role using (true) with check (true);
create policy server_monopoly_receipts_service on vezdehot_private.server_monopoly_receipts
  for all to service_role using (true) with check (true);
revoke all on vezdehot_private.server_monopoly_games,vezdehot_private.server_monopoly_receipts
  from public,anon,authenticated,service_role;
grant select,insert,update on vezdehot_private.server_monopoly_games to service_role;
grant select,insert on vezdehot_private.server_monopoly_receipts to service_role;

create function vezdehot_private.server_monopoly_stake(e jsonb) returns integer
language plpgsql immutable security invoker set search_path='' as $$
begin
  if jsonb_typeof(e) is distinct from 'object' or e->'version' is distinct from '1'::jsonb
    or not e ?& array['version','stake','settled','payout','xp','outcome']
    or exists(select 1 from jsonb_object_keys(e) k where k not in ('version','stake','settled','payout','xp','outcome'))
    or e->'stake' not in ('0'::jsonb,'100'::jsonb) or jsonb_typeof(e->'settled') is distinct from 'boolean'
    or not vezdehot_private.server_wallet_integer(e->'payout',0,250)
    or not vezdehot_private.server_wallet_integer(e->'xp',0,100)
    or (e->'outcome'<>'null'::jsonb and (jsonb_typeof(e->'outcome') is distinct from 'string'
      or e->>'outcome' not in ('win','loss','resigned'))) then
    raise exception 'Invalid Monopoly economy' using errcode='22023';
  end if;
  return (e->>'stake')::integer;
end;
$$;

-- The Edge executes moves. SQL independently checks board prices, ownership,
-- cash conservation, legal action boundaries and every terminal payout.
create function vezdehot_private.server_wallet_apply_monopoly(
  p_user_id uuid,p_request jsonb,p_previous jsonb,p_state jsonb,p_response jsonb
) returns void language plpgsql security invoker set search_path='' as $$
declare
  v_stake integer; old_stake integer; alive_count integer; v_table uuid;
  is_start boolean; v_action text; v_outcome text; v_winners jsonb:='[]';
  v_payout integer:=0; v_xp integer:=0; expected jsonb; v_win boolean:=false;
  p jsonb; c jsonb; old_p jsonb; i integer; j integer; next_seat integer; price integer;
  v_turn integer; v_number integer; capital bigint; maximum bigint:=-1; cash bigint:=0;
  prices integer[]:=array[0,120,140,0,0,170,0,190,210,0,230,0,260,280,0,310,0,340,0,380];
  rents integer[]:=array[0,22,26,0,0,32,0,38,44,0,50,0,58,64,0,72,0,82,0,96];
  kinds text[]:=array['start','property','property','chance','tax','property','jail','property','property','chance','property','goto','property','property','tax','property','chance','property','bonus','property'];
  colors text[]:=array[null,'pink','pink',null,null,'blue',null,'blue','green',null,'green',null,'orange','orange',null,'purple',null,'purple',null,'purple'];
  w vezdehot_private.server_wallets%rowtype; v_now timestamptz;
begin
  if current_user<>'service_role' then raise exception 'Server access required' using errcode='42501'; end if;
  if p_user_id is null then raise exception 'Invalid Monopoly owner' using errcode='22023'; end if;
  v_stake:=vezdehot_private.server_monopoly_stake(p_state->'economy');
  old_stake:=case when p_previous is null then 0 else vezdehot_private.server_monopoly_stake(p_previous->'economy') end;
  is_start:=p_request->>'op'='start'; v_action:=p_request->'action'->>'type';
  -- The final roll has already decided capital. A stale resign button cannot
  -- discard that result; the engine settles it exactly like Continue.
  if v_action='resign' and p_previous->>'phase'='review' and p_previous->'turnNumber'='80'::jsonb then v_action:='continue';end if;
  if p_state->'version' is distinct from '3'::jsonb
    or jsonb_typeof(p_state->'id') is distinct from 'string'
    or p_state->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or jsonb_typeof(p_state->'players') is distinct from 'array'
    or jsonb_typeof(p_state->'board') is distinct from 'array'
    or jsonb_typeof(p_state->'winners') is distinct from 'array'
    or jsonb_typeof(p_state->'over') is distinct from 'boolean'
    or jsonb_typeof(p_state->'resigned') is distinct from 'boolean'
    or p_state->'settled' is distinct from p_state->'over'
    or p_state->'stake' is distinct from to_jsonb(v_stake)
    or not vezdehot_private.server_wallet_integer(p_state->'turn',0,3)
    or not vezdehot_private.server_wallet_integer(p_state->'turnNumber',1,80)
    or not vezdehot_private.server_wallet_integer(p_state->'bank',-2000000000,2000000000)
    or p_state->'maxTurns' is distinct from '80'::jsonb
    or coalesce(p_state->>'phase','') not in ('ready','buy','review','over')
    or coalesce(p_state->>'diff','') not in ('easy','normal','hard') then
    raise exception 'Invalid Monopoly game state' using errcode='22023';
  end if;
  if jsonb_array_length(p_state->'players')<>4 or jsonb_array_length(p_state->'board')<>20 then
    raise exception 'Invalid Monopoly board or seats' using errcode='22023';
  end if;
  v_table:=(p_state->>'id')::uuid;v_turn:=(p_state->>'turn')::integer;v_number:=(p_state->>'turnNumber')::integer;
  for i in 0..3 loop
    p:=p_state->'players'->i;
    if jsonb_typeof(p) is distinct from 'object' or p->'id' is distinct from to_jsonb(i)
      or jsonb_typeof(p->'alive') is distinct from 'boolean'
      or not vezdehot_private.server_wallet_integer(p->'money',0,2000000000)
      or not vezdehot_private.server_wallet_integer(p->'pos',0,19)
      or not vezdehot_private.server_wallet_integer(p->'skip',0,1)
      or jsonb_typeof(p->'properties') is distinct from 'array' then
      raise exception 'Invalid Monopoly player' using errcode='22023';
    end if;
    if exists(select 1 from jsonb_array_elements(p->'properties') x where not vezdehot_private.server_wallet_integer(x,0,19)) then
      raise exception 'Invalid Monopoly property index' using errcode='22023';
    end if;
    if (select coalesce(jsonb_agg(x order by (x#>>'{}')::integer),'[]') from jsonb_array_elements(p->'properties') x)
      is distinct from (select coalesce(jsonb_agg(n-1 order by n),'[]') from jsonb_array_elements(p_state->'board') with ordinality b(value,n) where value->'owner'=to_jsonb(i))
      or (p->'alive'='false'::jsonb and (p->'money'<>'0'::jsonb or p->'properties'<>'[]'::jsonb)) then
      raise exception 'Invalid Monopoly ownership' using errcode='22023';
    end if;
    cash:=cash+(p->>'money')::bigint;
  end loop;
  for i in 0..19 loop
    c:=p_state->'board'->i;
    if jsonb_typeof(c) is distinct from 'object' or c->>'kind' is distinct from kinds[i+1]
      or not c ? 'owner' or (c->'owner'<>'null'::jsonb and not vezdehot_private.server_wallet_integer(c->'owner',0,3))
      or (kinds[i+1]='property' and (c->'price' is distinct from to_jsonb(prices[i+1])
        or c->'rent' is distinct from to_jsonb(rents[i+1]) or c->>'color' is distinct from colors[i+1]))
      or (kinds[i+1]<>'property' and c->'owner' is distinct from 'null'::jsonb)
      or (i in (4,14,18) and c->'amount' is distinct from to_jsonb(case i when 4 then 100 when 14 then 150 else 120 end)) then
      raise exception 'Invalid Monopoly board economics' using errcode='22023';
    end if;
    if c->'owner'<>'null'::jsonb and p_state->'players'->((c->>'owner')::integer)->'alive' is distinct from 'true'::jsonb then
      raise exception 'Bankrupt Monopoly owner' using errcode='22023';
    end if;
  end loop;
  if cash+(p_state->>'bank')::bigint<>6000 then raise exception 'Monopoly cash is not conserved' using errcode='22023'; end if;
  select count(*)::integer into alive_count from jsonb_array_elements(p_state->'players') seat where seat->'alive'='true'::jsonb;
  if alive_count<1 then raise exception 'Invalid Monopoly survivors' using errcode='22023'; end if;
  if exists(select 1 from unnest(array['economy','over','phase','resigned','winner','winners','finishKind']) k
    where p_response->'game'->k is distinct from p_state->k) then
    raise exception 'Monopoly outcome projection mismatch' using errcode='22023';
  end if;
  if is_start then
    if coalesce(p_request->'stake','0'::jsonb) is distinct from to_jsonb(v_stake)
      or p_state->'diff' is distinct from p_request->'difficulty'
      or p_state->'over' is distinct from 'false'::jsonb or p_state->>'phase' is distinct from 'ready'
      or v_turn<>0 or v_number<>1 or p_state->'bank' is distinct from '0'::jsonb or alive_count<>4
      or exists(select 1 from jsonb_array_elements(p_state->'players') seat where seat->'money' is distinct from '1500'::jsonb
        or seat->'pos' is distinct from '0'::jsonb or seat->'skip' is distinct from '0'::jsonb or seat->'properties' is distinct from '[]'::jsonb)
      or (p_previous is not null and (p_previous->'over' is distinct from 'true'::jsonb
        or p_previous->'economy'->'settled' is distinct from 'true'::jsonb or p_previous->'id'=p_state->'id')) then
      raise exception 'Invalid Monopoly replacement' using errcode='22023';
    end if;
    if exists(select 1 from vezdehot_private.server_wallet_ledger where user_id=p_user_id and game='monopoly' and table_id=v_table) then
      raise exception 'Monopoly table ID was already used' using errcode='22023';
    end if;
  else
    if p_request->>'op' is distinct from 'action' or p_previous is null or old_stake<>v_stake
      or p_previous->'id' is distinct from p_state->'id' or p_request->'gameId' is distinct from p_state->'id'
      or p_previous->'over' is distinct from 'false'::jsonb or p_previous->'economy'->'settled' is distinct from 'false'::jsonb
      or p_state->'diff' is distinct from p_previous->'diff'
      or coalesce(v_action,'') not in ('roll','buy','skip','continue','resign')
      or exists(select 1 from jsonb_array_elements(p_state->'board') with ordinality b(value,n)
        where value-'owner' is distinct from (p_previous->'board'->(n::integer-1))-'owner')
      or exists(select 1 from jsonb_array_elements(p_state->'players') with ordinality p(value,n)
        where value->'alive'='true'::jsonb and p_previous->'players'->(n::integer-1)->'alive' is distinct from 'true'::jsonb) then
      raise exception 'Invalid Monopoly transition' using errcode='22023';
    end if;
    if v_stake=100 and (not exists(select 1 from vezdehot_private.server_wallet_ledger
        where user_id=p_user_id and game='monopoly' and table_id=v_table and kind='entry')
      or exists(select 1 from vezdehot_private.server_wallet_ledger
        where user_id=p_user_id and game='monopoly' and table_id=v_table and kind='settlement')) then
      raise exception 'Monopoly entry is missing or already settled' using errcode='22023';
    end if;
    if (v_action<>'continue' and (p_state->'turnNumber' is distinct from p_previous->'turnNumber' or p_state->'turn' is distinct from p_previous->'turn'))
      or (v_action='roll' and (p_previous->>'phase' is distinct from 'ready' or v_turn<>0))
      or (v_action in ('buy','skip') and (p_previous->>'phase' is distinct from 'buy' or v_turn<>0 or p_state->>'phase' is distinct from 'review'))
      or (v_action='continue' and p_previous->>'phase' is distinct from 'review')
      or (v_action in ('skip','resign') and (p_state->'players' is distinct from p_previous->'players'
        or p_state->'board' is distinct from p_previous->'board' or p_state->'bank' is distinct from p_previous->'bank')) then
      raise exception 'Invalid Monopoly action phase' using errcode='22023';
    end if;
    if v_action='continue' then
      if (p_previous->>'turnNumber')::integer=80 then
        if p_state->'over' is distinct from 'true'::jsonb or p_state->>'finishKind' is distinct from 'capital'
          or v_number<>80 or p_state->'turn' is distinct from p_previous->'turn'
          or p_state->'players' is distinct from p_previous->'players' or p_state->'board' is distinct from p_previous->'board'
          or p_state->'bank' is distinct from p_previous->'bank' then
          raise exception 'Invalid Monopoly capital boundary' using errcode='22023';
        end if;
      else
        next_seat:=(p_previous->>'turn')::integer;
        for j in 1..4 loop next_seat:=(next_seat+1)%4;exit when p_previous->'players'->next_seat->'alive'='true'::jsonb;end loop;
        if v_number<>(p_previous->>'turnNumber')::integer+1 or v_turn<>next_seat
          or (next_seat=0 and (p_state->>'phase' is distinct from 'ready' or p_state->'players' is distinct from p_previous->'players'
            or p_state->'board' is distinct from p_previous->'board' or p_state->'bank' is distinct from p_previous->'bank'))
          or (next_seat<>0 and p_state->>'phase' not in ('review','over')) then
          raise exception 'Invalid Monopoly next turn' using errcode='22023';
        end if;
      end if;
    end if;
    if v_action='buy' then
      i:=(p_previous->'players'->0->>'pos')::integer;c:=p_previous->'board'->i;price:=(c->>'price')::integer;
      if c->>'kind' is distinct from 'property' or c->'owner' is distinct from 'null'::jsonb
        or (p_previous->'players'->0->>'money')::integer<price
        or p_state->'board' is distinct from jsonb_set(p_previous->'board',array[i::text,'owner'],'0')
        or p_state->'bank' is distinct from to_jsonb((p_previous->>'bank')::bigint+price) then
        raise exception 'Invalid Monopoly purchase' using errcode='22023';
      end if;
      expected:=jsonb_set(p_previous->'players','{0,money}',to_jsonb((p_previous->'players'->0->>'money')::integer-price));
      expected:=jsonb_set(expected,'{0,properties}',(p_previous->'players'->0->'properties')||to_jsonb(i));
      if p_state->'players' is distinct from expected then raise exception 'Invalid Monopoly purchase balance' using errcode='22023'; end if;
    end if;
    -- A roll resolves one mover. Rent can credit another seat but cannot move or
    -- eliminate them. Ownership cannot be gifted between unrelated players.
    if v_action='roll' or (v_action='continue' and v_number<>(p_previous->>'turnNumber')::integer and v_turn<>0) then
      for i in 0..3 loop
        p:=p_state->'players'->i;old_p:=p_previous->'players'->i;
        if i<>v_turn and (p->'pos' is distinct from old_p->'pos' or p->'skip' is distinct from old_p->'skip'
          or p->'alive' is distinct from old_p->'alive' or (p->>'money')::bigint<(old_p->>'money')::bigint) then
          raise exception 'Invalid Monopoly non-mover change' using errcode='22023';
        end if;
      end loop;
      for i in 0..19 loop
        c:=p_state->'board'->i;p:=p_previous->'board'->i;
        if c->'owner' is distinct from p->'owner'
          and not (p->'owner'='null'::jsonb and c->'owner'=to_jsonb(v_turn))
          and not (p->'owner'=to_jsonb(v_turn) and (c->'owner'='null'::jsonb or p_state->'players'->v_turn->'alive'='false'::jsonb)) then
          raise exception 'Invalid Monopoly property transfer' using errcode='22023';
        end if;
      end loop;
    end if;
  end if;
  if p_state->'over'='false'::jsonb then
    if p_state->>'phase'='over' or p_state->'resigned' is distinct from 'false'::jsonb
      or p_state->'winner' is distinct from 'null'::jsonb or p_state->'winners' is distinct from '[]'::jsonb
      or p_state->'finishKind' is distinct from 'null'::jsonb or alive_count<2
      or p_state->'players'->0->'alive' is distinct from 'true'::jsonb
      or (p_state->>'phase' in ('ready','buy') and v_turn<>0)
      or (not is_start and (v_action='resign' or v_action='roll' and p_state->>'phase' not in ('buy','review'))) then
      raise exception 'Invalid active Monopoly outcome' using errcode='22023';
    end if;
    if p_state->>'phase'='buy' then
      i:=(p_state->'players'->0->>'pos')::integer;c:=p_state->'board'->i;
      if c->>'kind' is distinct from 'property' or c->'owner' is distinct from 'null'::jsonb
        or (p_state->'players'->0->>'money')::bigint<(c->>'price')::bigint then
        raise exception 'Invalid Monopoly purchase offer' using errcode='22023';
      end if;
    end if;
    expected:=jsonb_build_object('version',1,'stake',v_stake,'settled',false,'payout',0,'xp',0,'outcome',null);
  else
    if is_start or p_state->>'phase' is distinct from 'over' or v_action in ('buy','skip') then
      raise exception 'Invalid terminal Monopoly transition' using errcode='22023';
    end if;
    if p_state->'resigned'='true'::jsonb then
      if v_action is distinct from 'resign' or p_state->>'finishKind' is distinct from 'resigned' then
        raise exception 'Invalid Monopoly resignation' using errcode='22023';
      end if;
      v_outcome:='resigned';
    else
      if v_action='resign' then raise exception 'Resignation cannot award a Monopoly win' using errcode='22023'; end if;
      case p_state->>'finishKind'
      when 'capital' then
        if v_action is distinct from 'continue' or v_number<>80 or p_previous->'turnNumber' is distinct from '80'::jsonb
          or alive_count<2 or p_state->'players'->0->'alive' is distinct from 'true'::jsonb then
          raise exception 'Invalid Monopoly capital result' using errcode='22023';
        end if;
        for i in 0..3 loop
          p:=p_state->'players'->i;
          if p->'alive'='true'::jsonb then
            select (p->>'money')::bigint+coalesce(sum((p_state->'board'->((x#>>'{}')::integer)->>'price')::bigint),0)
              into capital from jsonb_array_elements(p->'properties') x;
            if capital>maximum then maximum:=capital;v_winners:=jsonb_build_array(i);
            elsif capital=maximum then v_winners:=v_winners||to_jsonb(i);end if;
          end if;
        end loop;
      when 'last-player' then
        if alive_count<>1 then raise exception 'Invalid Monopoly last player' using errcode='22023'; end if;
        select jsonb_agg(seat->'id') into v_winners from jsonb_array_elements(p_state->'players') seat where seat->'alive'='true'::jsonb;
      when 'bankrupt' then
        if p_state->'players'->0->'alive' is distinct from 'false'::jsonb or alive_count<2 then
          raise exception 'Invalid Monopoly bankruptcy' using errcode='22023';
        end if;
      else raise exception 'Invalid Monopoly finish kind' using errcode='22023';
      end case;
      v_win:=v_winners @> '[0]'::jsonb;v_outcome:=case when v_win then 'win' else 'loss' end;
      if v_stake=100 then v_payout:=case when v_win then 250 else 0 end;v_xp:=case when v_win then 100 else 25 end;end if;
    end if;
    if p_state->'winners' is distinct from v_winners or p_state->'winner' is distinct from (case when v_win then '0'::jsonb else 'null'::jsonb end) then
      raise exception 'Incorrect Monopoly winners' using errcode='22023';
    end if;
    expected:=jsonb_build_object('version',1,'stake',v_stake,'settled',true,'payout',v_payout,'xp',v_xp,'outcome',v_outcome);
  end if;
  if p_state->'economy' is distinct from expected then raise exception 'Incorrect Monopoly settlement' using errcode='22023'; end if;
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
      values(p_user_id,w.revision,'entry','monopoly',v_table,-100,0,w.balance,v_now);
  elsif p_state->'over'='true'::jsonb then
    update vezdehot_private.server_wallets set balance=balance+v_payout,xp=xp+v_xp,games=games+1,
      wins=wins+case when v_outcome='win' then 1 else 0 end,revision=revision+1,updated_at=v_now
      where user_id=p_user_id returning * into w;
    insert into vezdehot_private.server_wallet_ledger(user_id,revision,kind,game,table_id,delta,xp,outcome,balance,created_at)
      values(p_user_id,w.revision,'settlement','monopoly',v_table,v_payout,v_xp,v_outcome,w.balance,v_now);
  end if;
end;
$$;
create function public.server_monopoly_read(p_user_id uuid,p_action_id uuid default null,p_request jsonb default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare g vezdehot_private.server_monopoly_games%rowtype; r vezdehot_private.server_monopoly_receipts%rowtype; answer jsonb;
begin
  if current_user<>'service_role' then raise exception 'Server access required' using errcode='42501'; end if;
  if p_user_id is null or (p_action_id is null)<>(p_request is null)
    or (p_request is not null and (jsonb_typeof(p_request) is distinct from 'object' or octet_length(p_request::text)>4096)) then
    raise exception 'Invalid Monopoly read' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('server-monopoly:'||p_user_id::text,0));
  select * into g from vezdehot_private.server_monopoly_games where user_id=p_user_id;
  answer:=jsonb_build_object('revision',coalesce(g.revision,0),'state',g.state);
  if p_action_id is not null then
    select * into r from vezdehot_private.server_monopoly_receipts where user_id=p_user_id and action_id=p_action_id;
    if found then
      if r.request is distinct from p_request then raise exception 'Action ID reused with a different request' using errcode='22023'; end if;
      answer:=answer||jsonb_build_object('receipt',r.response);
    end if;
  end if;
  return answer;
end;
$$;

create function public.server_monopoly_commit(p_user_id uuid,p_expected_revision bigint,p_action_id uuid,
  p_request jsonb,p_state jsonb,p_response jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare g vezdehot_private.server_monopoly_games%rowtype; r vezdehot_private.server_monopoly_receipts%rowtype;
  v_revision bigint; v_now timestamptz;
begin
  if current_user<>'service_role' then raise exception 'Server access required' using errcode='42501'; end if;
  if p_user_id is null or p_action_id is null or p_expected_revision is null
    or p_expected_revision not between 0 and 9007199254740990
    or jsonb_typeof(p_request) is distinct from 'object' or octet_length(p_request::text)>4096
    or lower(p_request->>'actionId') is distinct from p_action_id::text
    or p_request->'expectedRevision' is distinct from to_jsonb(p_expected_revision) then
    raise exception 'Invalid Monopoly request' using errcode='22023';
  end if;
  -- Match every existing game writer: wallet lock first, game lock second.
  perform pg_advisory_xact_lock(hashtextextended('server-wallet:'||p_user_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('server-monopoly:'||p_user_id::text,0));
  select * into r from vezdehot_private.server_monopoly_receipts where user_id=p_user_id and action_id=p_action_id;
  if found then
    if r.request is distinct from p_request then raise exception 'Action ID reused with a different request' using errcode='22023'; end if;
    return jsonb_build_object('receipt',r.response);
  end if;
  select * into g from vezdehot_private.server_monopoly_games where user_id=p_user_id;
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
    raise exception 'Invalid Monopoly state or receipt' using errcode='22023';
  end if;
  perform vezdehot_private.server_wallet_apply_monopoly(p_user_id,p_request,g.state,p_state,p_response);
  v_now:=clock_timestamp();
  insert into vezdehot_private.server_monopoly_games(user_id,revision,state,updated_at)
    values(p_user_id,v_revision+1,p_state,v_now)
    on conflict(user_id) do update set revision=excluded.revision,state=excluded.state,updated_at=excluded.updated_at;
  insert into vezdehot_private.server_monopoly_receipts(user_id,action_id,request,response,created_at)
    values(p_user_id,p_action_id,p_request,p_response,v_now);
  return jsonb_build_object('receipt',p_response);
end;
$$;

revoke all on function vezdehot_private.server_monopoly_stake(jsonb),
  vezdehot_private.server_wallet_apply_monopoly(uuid,jsonb,jsonb,jsonb,jsonb),
  public.server_monopoly_read(uuid,uuid,jsonb),public.server_monopoly_commit(uuid,bigint,uuid,jsonb,jsonb,jsonb)
  from public,anon,authenticated;
grant execute on function vezdehot_private.server_monopoly_stake(jsonb),
  vezdehot_private.server_wallet_apply_monopoly(uuid,jsonb,jsonb,jsonb,jsonb),
  public.server_monopoly_read(uuid,uuid,jsonb),public.server_monopoly_commit(uuid,bigint,uuid,jsonb,jsonb,jsonb)
  to service_role;

comment on table vezdehot_private.server_monopoly_games is 'Server Monopoly state and permanent action receipts; never exposed to browser roles.';
