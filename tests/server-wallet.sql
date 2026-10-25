-- Isolated PostgreSQL session as postgres, after checkpoint/game/wallet migrations.
-- Requests deliberately model stale devices and retries; PGlite is single-session,
-- so this suite verifies transactional/CAS invariants, not parallel lock scheduling.
begin;
set local statement_timeout='30s';
set local lock_timeout='5s';
create temporary table wallet_fixture(label text primary key,uid uuid default gen_random_uuid(),
  action_id uuid default gen_random_uuid(),table_id uuid default gen_random_uuid()) on commit drop;
insert into wallet_fixture(label) values('main'),('free'),('empty'),('rollback'),('other'),('race');
insert into auth.users(id,is_anonymous) select uid,false from wallet_fixture;
grant select on wallet_fixture to service_role,anon,authenticated;
create function pg_temp.w_assert(ok boolean,description text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Wallet assertion failed: %',description; end if; end $$;
create function pg_temp.w_reject(command text,expected text,description text) returns void language plpgsql as $$
declare code text;
begin
  begin execute command; exception when others then code:=sqlstate; end;
  perform pg_temp.w_assert(code=expected,description||' expected '||expected||', got '||coalesce(code,'success'));
end $$;
create function pg_temp.w_economy(stake integer default 100,settled boolean default false,payout integer default 0,xp integer default 0,outcome text default null)
returns jsonb language sql as $$ select jsonb_build_object('version',1,'stake',stake,'settled',settled,'payout',payout,'xp',xp,'outcome',outcome) $$;
create function pg_temp.w_durak(id uuid,kind text default 'active',seats integer default 3) returns jsonb language plpgsql as $$
declare players jsonb:='[]'; finished jsonb:='[]'; i integer; active integer;
begin
  active:=case kind when 'win' then seats-1 when 'loss' then 0 else -1 end;
  for i in 0..seats-1 loop
    players:=players||jsonb_build_array(jsonb_build_object('hand',case when kind in ('active','resigned') or i=active then '["card"]'::jsonb else '[]'::jsonb end));
    if kind not in ('active','resigned') and i<>active then finished:=finished||to_jsonb(i); end if;
  end loop;
  return jsonb_build_object('id',id,'over',kind<>'active','phase',case when kind='active' then 'attack' else 'over' end,
    'resigned',kind='resigned','draw',kind='draw','loser',case when active>=0 then active else null end,
    'finished',finished,'players',players,'deck','[]'::jsonb,'table','[]'::jsonb,
    'economy',case kind when 'active' then pg_temp.w_economy() when 'win' then pg_temp.w_economy(100,true,100*seats,80,'win')
      when 'draw' then pg_temp.w_economy(100,true,100,40,'draw') when 'loss' then pg_temp.w_economy(100,true,0,25,'loss')
      when 'resigned' then pg_temp.w_economy(100,true,0,0,'resigned') end);
end $$;
create function pg_temp.w_poker(id uuid,chips integer default 1000,closed boolean default false,hand_over boolean default false) returns jsonb language plpgsql as $$
declare payout integer:=chips/10;
begin return jsonb_build_object('id',id,'over',closed,'game',jsonb_build_object('over',hand_over,'tableClosed',closed,
  'payout',999999,'players',jsonb_build_array(jsonb_build_object('chips',chips),jsonb_build_object('chips',4000-chips),jsonb_build_object('chips',0),jsonb_build_object('chips',0))),
  'economy',case when not closed then pg_temp.w_economy() else pg_temp.w_economy(100,true,payout,
    case when payout>100 then 90 when payout=100 then 40 else 20 end,
    case when payout>100 then 'win' when payout=100 then 'draw' else 'loss' end) end);
end $$;
create function pg_temp.w_commit(game text,uid uuid,rev bigint,id uuid,state jsonb,start boolean default false,extra jsonb default '{}') returns jsonb language plpgsql as $$
declare req jsonb; response jsonb; answer jsonb;
begin
  req:=jsonb_build_object('op',case when start then 'start' else 'action' end,'expectedRevision',rev,'actionId',id)||extra;
  if start then req:=req||jsonb_build_object('stake',coalesce(state->'economy'->'stake','0'::jsonb),'bots',2,'difficulty','normal');
  else req:=req||jsonb_build_object('gameId',state->'id','action',jsonb_build_object('type','test')); end if;
  response:=jsonb_build_object('status','saved','revision',rev+1,'game',jsonb_build_object('id',state->'id','economy',state->'economy'));
  if game='durak' then answer:=public.server_durak_commit(uid,rev,id,req,state,response);
  else answer:=public.server_poker_commit(uid,rev,id,req,state,response); end if;
  return answer;
end $$;
create function pg_temp.w_fail_receipt() returns trigger language plpgsql as $$
begin if new.request ? 'failReceipt' then raise exception 'Injected receipt failure' using errcode='P0001'; end if; return new; end $$;
create trigger wallet_durak_fail before insert on vezdehot_private.server_durak_receipts for each row execute function pg_temp.w_fail_receipt();
create trigger wallet_poker_fail before insert on vezdehot_private.server_poker_receipts for each row execute function pg_temp.w_fail_receipt();

set local role service_role;
do $$
declare u uuid:=(select uid from pg_temp.wallet_fixture where label='main'); w jsonb; again jsonb; id uuid:=gen_random_uuid(); req jsonb;
begin
  w:=public.server_wallet_read(u); again:=public.server_wallet_read(u);
  perform pg_temp.w_assert(w->'balance'='1000' and w->'revision'='1' and w->'games'='0' and w->'xp'='0','one welcome balance');
  perform pg_temp.w_assert(again-'serverTime'=w-'serverTime','read idempotent');
  perform pg_temp.w_assert(jsonb_array_length(w->'history')=1 and w->'history'->0->>'kind'='welcome','one welcome ledger');
  perform pg_temp.w_assert(w->'history'->0->'game'='null' and w->'history'->0->'tableId'='null','grant has no game');
  perform pg_temp.w_assert((w->>'bonusAvailableAt')::timestamptz-(w->'history'->0->>'createdAt')::timestamptz=interval '24 hours','first bonus 24 hours');
  perform pg_temp.w_assert(w->>'serverTime' like '%Z' and w->>'bonusAvailableAt' like '%Z','UTC serialization');
  req:=jsonb_build_object('op','claimDaily','actionId',id);
  w:=public.server_wallet_claim(u,id,req);
  perform pg_temp.w_assert(w->>'status'='cooldown','first claim cooldown');
  perform pg_temp.w_assert(public.server_wallet_claim(u,id,req)=w,'cooldown replay stable');
  perform pg_temp.w_assert((public.server_wallet_read(u))->'revision'='1','cooldown changes no balance');
  perform pg_temp.w_reject(format('select public.server_wallet_claim(%L,%L,%L)',u,id,req||'{"amount":1000000}'),'22023','client cannot choose amount');
  perform pg_temp.w_reject(format('select public.server_wallet_claim(%L,%L,%L)',u,id,req||'{"now":0}'),'22023','client cannot choose clock');
  perform pg_temp.w_reject(format('select public.server_wallet_claim(%L,%L,%L)',u,id,jsonb_set(req,'{actionId}',to_jsonb(gen_random_uuid()))),'22023','claim identity bound');
  perform pg_temp.w_reject('select public.server_wallet_read(null)','22023','null wallet owner');
end $$;
reset role;
-- Change server time eligibility as database owner; clients have no clock input.
update vezdehot_private.server_wallets set bonus_available_at=clock_timestamp()-interval '1 second';
set local role service_role;
do $$
declare u uuid:=(select uid from pg_temp.wallet_fixture where label='main'); old record; id uuid:=gen_random_uuid(); req jsonb; r jsonb;
begin
  select * into old from vezdehot_private.server_wallet_receipts where user_id=u limit 1;
  perform pg_temp.w_assert(public.server_wallet_claim(u,old.action_id,old.request)=old.response,'old cooldown remains cooldown after eligibility');
  req:=jsonb_build_object('op','claimDaily','actionId',id); r:=public.server_wallet_claim(u,id,req);
  perform pg_temp.w_assert(r->>'status'='saved','eligible daily granted');
  perform pg_temp.w_assert(public.server_wallet_claim(u,id,req)=r,'daily replay same receipt');
  perform pg_temp.w_assert((public.server_wallet_read(u))->'balance'='2000' and (public.server_wallet_read(u))->'revision'='2','daily exactly once');
  id:=gen_random_uuid(); req:=jsonb_build_object('op','claimDaily','actionId',id);
  perform pg_temp.w_assert(public.server_wallet_claim(u,id,req)->>'status'='cooldown','second device cooldown');
  perform pg_temp.w_assert((public.server_wallet_read(u))->'balance'='2000','second device cannot double claim');
end $$;
-- Free legacy and explicit-free states do not initialize or modify wallets.
do $$
declare u uuid:=(select uid from pg_temp.wallet_fixture where label='free'); s jsonb; t uuid:=gen_random_uuid();
begin
  s:=jsonb_build_object('id',t,'over',false);
  perform pg_temp.w_commit('durak',u,0,gen_random_uuid(),s,true);
  s:=s||jsonb_build_object('over',true,'economy',pg_temp.w_economy(0,true,0,0,'win'));
  perform pg_temp.w_commit('durak',u,1,gen_random_uuid(),s);
  s:=jsonb_build_object('id',gen_random_uuid(),'over',false,'economy',pg_temp.w_economy(0));
  perform pg_temp.w_commit('poker',u,0,gen_random_uuid(),s,true);
  perform pg_temp.w_assert(not exists(select 1 from vezdehot_private.server_wallets where user_id=u),'free games never initialize wallet');
  perform pg_temp.w_reject(format('select pg_temp.w_commit(%L,%L,2,%L,%L,false)','durak',u,gen_random_uuid(),pg_temp.w_durak(t,'win')),'22023','free cannot become paid during action');
end $$;
-- Durak entry, replay, stale second device, every settlement outcome, wrong rewards.
do $$
declare u uuid:=(select uid from pg_temp.wallet_fixture where label='main'); t uuid; aid uuid; state jsonb; response jsonb; before jsonb; after jsonb;
  rev bigint:=0; kind text; expected_payout integer; expected_xp integer; previous_table uuid;
begin
  foreach kind in array array['win','draw','loss','resigned'] loop
    t:=gen_random_uuid(); aid:=gen_random_uuid(); state:=pg_temp.w_durak(t); before:=public.server_wallet_read(u);
    response:=pg_temp.w_commit('durak',u,rev,aid,state,true);
    perform pg_temp.w_assert(response->'receipt'->>'status'='saved','Durak start saved');
    perform pg_temp.w_assert(pg_temp.w_commit('durak',u,rev,aid,state,true)=response,'paid entry replay unchanged');
    perform pg_temp.w_assert((public.server_wallet_read(u)->>'balance')::integer=(before->>'balance')::integer-100,'entry charged once');
    perform pg_temp.w_assert(pg_temp.w_commit('durak',u,rev,gen_random_uuid(),pg_temp.w_durak(gen_random_uuid()),true)->'conflict'='true','second device stale start conflicts');
    rev:=rev+1;
    perform pg_temp.w_reject(format('select pg_temp.w_commit(%L,%L,%s,%L,%L,true)','durak',u,rev,gen_random_uuid(),pg_temp.w_durak(gen_random_uuid())),'22023','active paid table cannot be abandoned by replacement');
    perform pg_temp.w_reject(format('select pg_temp.w_commit(%L,%L,%s,%L,%L,false)','durak',u,rev,gen_random_uuid(),state-'economy'),'22023','paid economy cannot disappear');
    state:=pg_temp.w_durak(t,kind);
    perform pg_temp.w_reject(format('select pg_temp.w_commit(%L,%L,%s,%L,%L,false)','durak',u,rev,gen_random_uuid(),jsonb_set(state,'{economy,payout}','400')),'22023','wrong Durak payout rejected');
    before:=public.server_wallet_read(u); aid:=gen_random_uuid();
    response:=pg_temp.w_commit('durak',u,rev,aid,state);
    after:=public.server_wallet_read(u);
    expected_payout:=(state->'economy'->>'payout')::integer; expected_xp:=(state->'economy'->>'xp')::integer;
    perform pg_temp.w_assert((after->>'balance')::integer=(before->>'balance')::integer+expected_payout,'exact Durak payout '||kind);
    perform pg_temp.w_assert((after->>'xp')::integer=(before->>'xp')::integer+expected_xp,'exact Durak XP '||kind);
    perform pg_temp.w_assert((after->>'games')::integer=(before->>'games')::integer+1,'Durak game counted once');
    perform pg_temp.w_assert(pg_temp.w_commit('durak',u,rev,aid,state)=response,'settlement replay unchanged');
    rev:=rev+1;
    perform pg_temp.w_reject(format('select pg_temp.w_commit(%L,%L,%s,%L,%L,false)','durak',u,rev,gen_random_uuid(),state),'22023','another action cannot settle twice');
    perform pg_temp.w_reject(format('select pg_temp.w_commit(%L,%L,%s,%L,%L,true)','durak',u,rev,gen_random_uuid(),pg_temp.w_durak(t)),'22023','same paid table cannot be restarted');
    if previous_table is not null then
      perform pg_temp.w_reject(format('select pg_temp.w_commit(%L,%L,%s,%L,%L,true)','durak',u,rev,gen_random_uuid(),pg_temp.w_durak(previous_table)),'22023','older table ID cannot be reused');
    end if;
    previous_table:=t;
  end loop;
  after:=public.server_wallet_read(u);
  perform pg_temp.w_assert(after->'games'='4' and after->'wins'='1' and after->'xp'='145','all Durak outcome totals');
end $$;
-- Poker uses current chips, conserves entry across hands, and shares Durak wallet.
do $$
declare u uuid:=(select uid from pg_temp.wallet_fixture where label='main'); t uuid; state jsonb; before jsonb; after jsonb;
  rev bigint:=0; chips integer;
begin
  foreach chips in array array[1537,1000,0,4000] loop
    t:=gen_random_uuid(); state:=pg_temp.w_poker(t); before:=public.server_wallet_read(u);
    perform pg_temp.w_commit('poker',u,rev,gen_random_uuid(),state,true); rev:=rev+1;
    perform pg_temp.w_assert((public.server_wallet_read(u)->>'balance')::integer=(before->>'balance')::integer-100,'Poker shares same wallet');
    before:=public.server_wallet_read(u);
    -- A hand finish followed by another hand is still the same paid table.
    state:=pg_temp.w_poker(t,1537,false,true);
    perform pg_temp.w_commit('poker',u,rev,gen_random_uuid(),state); rev:=rev+1;
    state:=pg_temp.w_poker(t,1537,false,false);
    perform pg_temp.w_commit('poker',u,rev,gen_random_uuid(),state); rev:=rev+1;
    perform pg_temp.w_assert(public.server_wallet_read(u)-'serverTime'=before-'serverTime','new hands do not change wallet');
    state:=pg_temp.w_poker(t,chips,true,false);
    perform pg_temp.w_reject(format('select pg_temp.w_commit(%L,%L,%s,%L,%L,false)','poker',u,rev,gen_random_uuid(),state),'22023','paid cashout midhand forbidden');
    state:=pg_temp.w_poker(t,chips,true,true);
    if chips in (0,4000) then state:=jsonb_set(state,'{game,tableClosed}','false'); end if;
    perform pg_temp.w_commit('poker',u,rev,gen_random_uuid(),state); rev:=rev+1;
    after:=public.server_wallet_read(u);
    perform pg_temp.w_assert((after->>'balance')::integer=(before->>'balance')::integer+chips/10,'cashout floors current chips, ignores stale payout');
    perform pg_temp.w_assert((after->>'xp')::integer=(before->>'xp')::integer+(state->'economy'->>'xp')::integer,'Poker exact XP');
    perform pg_temp.w_assert((after->>'games')::integer=(before->>'games')::integer+1,'Poker one game per table');
  end loop;
  after:=public.server_wallet_read(u);
  perform pg_temp.w_assert(after->'games'='8' and after->'wins'='3' and after->'xp'='385','all game totals');
  perform pg_temp.w_assert(jsonb_array_length(after->'history')=18,'all welcome/daily/entry/settlement events visible');
end $$;
-- A failed receipt write must undo initialization, debit and game state together.
do $$
declare u uuid:=(select uid from pg_temp.wallet_fixture where label='rollback'); t uuid:=gen_random_uuid(); s jsonb;
begin
  s:=pg_temp.w_durak(t);
  perform pg_temp.w_reject(format('select pg_temp.w_commit(%L,%L,0,%L,%L,true,%L)','durak',u,gen_random_uuid(),s,'{"failReceipt":true}'),'P0001','injected entry receipt failure');
  perform pg_temp.w_assert(not exists(select 1 from vezdehot_private.server_wallets where user_id=u),'failed entry rolls back welcome and debit');
  perform pg_temp.w_assert(not exists(select 1 from vezdehot_private.server_wallet_ledger where user_id=u),'failed entry leaves no ledger');
  perform pg_temp.w_assert(not exists(select 1 from vezdehot_private.server_durak_games where user_id=u),'failed entry leaves no game');
  perform pg_temp.w_commit('durak',u,0,gen_random_uuid(),s,true);
  s:=pg_temp.w_durak(t,'win');
  perform pg_temp.w_reject(format('select pg_temp.w_commit(%L,%L,1,%L,%L,false,%L)','durak',u,gen_random_uuid(),s,'{"failReceipt":true}'),'P0001','injected settlement receipt failure');
  perform pg_temp.w_assert(public.server_wallet_read(u)->'balance'='900' and public.server_wallet_read(u)->'games'='0','failed settlement leaves funds and counters unchanged');
  perform pg_temp.w_assert((public.server_durak_read(u))->'revision'='1','failed settlement leaves prior game revision');
  perform pg_temp.w_assert(not exists(select 1 from vezdehot_private.server_wallet_ledger where user_id=u and kind='settlement'),'failed settlement leaves no ledger');
end $$;
-- The entry/settlement ledger cannot be rewritten even by service_role.
select pg_temp.w_reject('update vezdehot_private.server_wallet_ledger set delta=0','42501','ledger updates forbidden');
select pg_temp.w_reject('delete from vezdehot_private.server_wallet_ledger','42501','ledger deletes forbidden');
select pg_temp.w_reject('update vezdehot_private.server_wallet_receipts set response=''{}''','42501','receipt updates forbidden');
select pg_temp.w_reject('delete from vezdehot_private.server_wallet_receipts','42501','receipt deletes forbidden');
select public.server_wallet_read((select uid from wallet_fixture where label='empty'));
select public.server_wallet_read((select uid from wallet_fixture where label='race'));
reset role;
update vezdehot_private.server_wallets set balance=50 where user_id=(select uid from wallet_fixture where label='empty');
update vezdehot_private.server_wallets set balance=100 where user_id=(select uid from wallet_fixture where label='race');
set local role service_role;
do $$
declare u uuid:=(select uid from pg_temp.wallet_fixture where label='empty'); s jsonb:=pg_temp.w_poker(gen_random_uuid()); code text; msg text;
begin
  begin perform pg_temp.w_commit('poker',u,0,gen_random_uuid(),s,true);
  exception when others then code:=sqlstate; msg:=sqlerrm; end;
  perform pg_temp.w_assert(code='P0001' and msg='insufficient_funds','stable insufficient funds error');
  perform pg_temp.w_assert(public.server_wallet_read(u)->'balance'='50' and public.server_wallet_read(u)->'revision'='1','insufficient funds preserves wallet');
  perform pg_temp.w_assert(public.server_poker_read(u)->'revision'='0','insufficient funds preserves game');
  perform pg_temp.w_assert(not exists(select 1 from vezdehot_private.server_poker_receipts where user_id=u),'insufficient funds writes no receipt');
end $$;
reset role;
-- Model two different games competing for the last entry fee. Each has a
-- correct game revision, so only the shared wallet serialization prevents debt.
set local role service_role;
do $$
declare u uuid:=(select uid from pg_temp.wallet_fixture where label='race'); s jsonb;
begin
  s:=pg_temp.w_durak(gen_random_uuid());
  perform pg_temp.w_commit('durak',u,0,gen_random_uuid(),s,true);
  s:=pg_temp.w_poker(gen_random_uuid());
  perform pg_temp.w_reject(format('select pg_temp.w_commit(%L,%L,0,%L,%L,true)','poker',u,gen_random_uuid(),s),'P0001','second game cannot spend same last 100');
  perform pg_temp.w_assert(public.server_wallet_read(u)->'balance'='0','shared wallet never below zero');
  perform pg_temp.w_assert(public.server_poker_read(u)->'revision'='0','losing concurrent game stays unstarted');
  perform pg_temp.w_assert((select count(*) from vezdehot_private.server_wallet_ledger where user_id=u and kind='entry')=1,'one fee for two competing games');
end $$;
reset role;
-- Real legacy checkpoint accepts legacy balance changes, with no route to wallet.
select set_config('request.jwt.claim.sub',(select uid::text from wallet_fixture where label='main'),true);
select set_config('request.jwt.claims','{"role":"authenticated","is_anonymous":false}',true);
set local role authenticated;
do $$
declare snap jsonb; r jsonb;
begin
  snap:=public.load_player_checkpoint()->'snapshot';
  snap:=jsonb_set(snap,'{profile,balance}','1999999999');
  snap:=jsonb_set(snap,'{profile,xp}','1000000000');
  r:=public.commit_player_checkpoint(0,gen_random_uuid(),snap,'[]');
  perform pg_temp.w_assert(r->>'status'='saved','legacy checkpoint remains writable');
  perform pg_temp.w_reject(format('select public.commit_player_checkpoint(1,%L,%L,%L)',gen_random_uuid(),snap||'{"serverWallet":{"balance":2000000000}}','[]'),'22023','checkpoint rejects server-wallet injection');
  perform pg_temp.w_reject('select public.server_wallet_read(auth.uid())','42501','authenticated cannot invoke wallet');
  perform pg_temp.w_reject('select public.server_wallet_claim(auth.uid(),gen_random_uuid(),''{}'')','42501','authenticated cannot claim by RPC');
  perform pg_temp.w_reject('select * from vezdehot_private.server_wallets','42501','authenticated cannot read wallet table');
  perform pg_temp.w_reject('update vezdehot_private.server_wallets set balance=2000000000','42501','authenticated cannot modify wallet');
  perform pg_temp.w_reject('select vezdehot_private.server_wallet_ensure(auth.uid())','42501','authenticated cannot call private helpers');
  perform pg_temp.w_reject('select * from vezdehot_private.server_wallet_ledger','42501','authenticated cannot read ledger');
  perform pg_temp.w_reject('select * from vezdehot_private.server_wallet_receipts','42501','authenticated cannot read receipts');
end $$;
reset role;
set local role anon;
select pg_temp.w_reject('select public.server_wallet_read(gen_random_uuid())','42501','anon cannot invoke wallet');
select pg_temp.w_reject('select * from vezdehot_private.server_wallets','42501','anon cannot access wallet table');
reset role;
set local role service_role;
do $$
declare w jsonb:=public.server_wallet_read((select uid from pg_temp.wallet_fixture where label='main'));
begin
  perform pg_temp.w_assert(w->'balance'='2253' and w->'xp'='385' and w->'games'='8','legacy checkpoint did not change server wallet');
  perform pg_temp.w_assert((public.server_wallet_read((select uid from pg_temp.wallet_fixture where label='other')))->'balance'='1000','owners isolated');
end $$;
reset role;
-- Force 3 additional eligible days to exercise the bounded, newest-first history.
do $$
declare u uuid:=(select uid from pg_temp.wallet_fixture where label='main'); i integer; id uuid;
begin
  for i in 1..3 loop
    update vezdehot_private.server_wallets set bonus_available_at=clock_timestamp()-interval '1 second' where user_id=u;
    execute 'set local role service_role'; id:=gen_random_uuid();
    perform public.server_wallet_claim(u,id,jsonb_build_object('op','claimDaily','actionId',id));
    execute 'reset role';
  end loop;
end $$;
set local role service_role;
do $$
declare w jsonb:=public.server_wallet_read((select uid from pg_temp.wallet_fixture where label='main'));
begin
  perform pg_temp.w_assert(jsonb_array_length(w->'history')=20,'history bounded to latest 20');
  perform pg_temp.w_assert(w->'history'->0->>'kind'='daily' and w->'history'->0->'balance'=w->'balance','history newest first');
end $$;
reset role;
rollback;
