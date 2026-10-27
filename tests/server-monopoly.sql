-- Disposable local database only. CAS interleavings model two devices; this
-- single-session suite does not measure concurrent advisory-lock scheduling.
begin;
set local statement_timeout='30s';
create temporary table monopoly_fixture(label text primary key,uid uuid default gen_random_uuid()) on commit drop;
insert into monopoly_fixture(label) values('main'),('free'),('empty'),('rollback'),('other'),('bad'),('bankrupt'),('property'),('lastWin'),('lastLoss');
insert into auth.users(id,is_anonymous) select uid,false from monopoly_fixture;
grant select on monopoly_fixture to service_role,anon,authenticated;
create function pg_temp.mo_assert(ok boolean,description text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Monopoly assertion failed: %',description; end if; end $$;
create function pg_temp.mo_reject(command text,expected text,description text) returns void language plpgsql as $$
declare code text;
begin begin execute command; exception when others then code:=sqlstate; end;
  perform pg_temp.mo_assert(code=expected,description||' expected '||expected||', got '||coalesce(code,'success'));
end $$;
create function pg_temp.mo_state(id uuid,stake integer default 100) returns jsonb language plpgsql as $$
declare players jsonb:='[]';board jsonb:='[]';i integer;c jsonb;
  prices integer[]:=array[0,120,140,0,0,170,0,190,210,0,230,0,260,280,0,310,0,340,0,380];
  rents integer[]:=array[0,22,26,0,0,32,0,38,44,0,50,0,58,64,0,72,0,82,0,96];
  kinds text[]:=array['start','property','property','chance','tax','property','jail','property','property','chance','property','goto','property','property','tax','property','chance','property','bonus','property'];
  colors text[]:=array[null,'pink','pink',null,null,'blue',null,'blue','green',null,'green',null,'orange','orange',null,'purple',null,'purple',null,'purple'];
begin
  for i in 0..3 loop players:=players||jsonb_build_array(jsonb_build_object('id',i,'name','Seat '||i,'money',1500,'pos',0,'alive',true,'properties','[]'::jsonb,'skip',0));end loop;
  for i in 0..19 loop
    c:=jsonb_build_object('kind',kinds[i+1],'owner',null,'title','Cell '||i);
    if kinds[i+1]='property' then c:=c||jsonb_build_object('price',prices[i+1],'rent',rents[i+1],'color',colors[i+1]);end if;
    if i in (4,14,18) then c:=c||jsonb_build_object('amount',case i when 4 then 100 when 14 then 150 else 120 end);end if;
    board:=board||jsonb_build_array(c);
  end loop;
  return jsonb_build_object('id',id,'version',3,'diff','normal','stake',stake,'turn',0,'turnNumber',1,'maxTurns',80,
    'phase','ready','players',players,'board',board,'bank',0,'over',false,'settled',false,'resigned',false,
    'winner',null,'winners','[]'::jsonb,'finishKind',null,
    'economy',jsonb_build_object('version',1,'stake',stake,'settled',false,'payout',0,'xp',0,'outcome',null));
end $$;
create function pg_temp.mo_result(s jsonb,kind text,winners jsonb default '[]') returns jsonb language plpgsql as $$
declare won boolean:=winners @> '[0]'::jsonb;paid boolean:=s->'stake'='100';outcome text;
begin
  outcome:=case when kind='resigned' then 'resigned' when won then 'win' else 'loss' end;
  return s||jsonb_build_object('over',true,'settled',true,'phase','over','finishKind',kind,'resigned',kind='resigned',
    'winners',winners,'winner',case when won then 0 else null end,
    'economy',jsonb_build_object('version',1,'stake',s->'stake','settled',true,'outcome',outcome,
      'payout',case when paid and won then 250 else 0 end,'xp',case when not paid or kind='resigned' then 0 when won then 100 else 25 end));
end $$;
create function pg_temp.mo_commit(uid uuid,rev bigint,aid uuid,state jsonb,op text default 'action',action text default 'continue',extra jsonb default '{}')
returns jsonb language plpgsql as $$
declare req jsonb;response jsonb;
begin
  req:=jsonb_build_object('op',op,'actionId',aid,'expectedRevision',rev);
  if op='start' then req:=req||jsonb_build_object('difficulty','normal','stake',state->'economy'->'stake');
  else req:=req||jsonb_build_object('gameId',state->'id','action',jsonb_build_object('type',action));end if;
  response:=jsonb_build_object('status','saved','revision',rev+1,'game',jsonb_build_object('id',state->'id','over',state->'over',
    'phase',state->'phase','winner',state->'winner','winners',state->'winners','finishKind',state->'finishKind','resigned',state->'resigned','economy',state->'economy'));
  return public.server_monopoly_commit(uid,rev,aid,req||extra,state,response);
end $$;
-- Pure SQL action-boundary fixtures. Full random roll/chance/rent computation is
-- separately exercised by the real engine → Edge → SQL integration suite.
create function pg_temp.mo_walk(uid uuid,boost integer default null) returns jsonb language plpgsql as $$
declare current jsonb;s jsonb;action text;n integer;turn integer;
begin
  loop
    current:=public.server_monopoly_read(uid);s:=current->'state';n:=(s->>'turnNumber')::integer;turn:=(s->>'turn')::integer;
    exit when n=80 and s->>'phase'='review';
    if s->>'phase'='ready' then s:=s||'{"phase":"review"}';action:='roll';
    else turn:=(turn+1)%4;n:=n+1;s:=s||jsonb_build_object('turn',turn,'turnNumber',n,'phase',case when turn=0 then 'ready' else 'review' end);action:='continue';end if;
    if boost=turn and (n=77 and action='roll' or n=78 and turn=1) then
      s:=jsonb_set(s,array['players',turn::text,'money'],to_jsonb((s->'players'->turn->>'money')::integer+100));
      s:=jsonb_set(s,'{bank}',to_jsonb((s->>'bank')::integer-100));
    end if;
    perform pg_temp.mo_commit(uid,(current->>'revision')::bigint,gen_random_uuid(),s,'action',action);
  end loop;
  return s;
end $$;
create function pg_temp.mo_fail_receipt() returns trigger language plpgsql as $$
begin if new.request ? 'failReceipt' then raise exception 'Injected receipt failure' using errcode='P0001';end if;return new;end $$;
create trigger monopoly_fail_receipt before insert on vezdehot_private.server_monopoly_receipts for each row execute function pg_temp.mo_fail_receipt();

-- Browser and anonymous roles have neither table nor function access.
do $$
declare role_name text;
begin
  foreach role_name in array array['anon','authenticated'] loop
    perform pg_temp.mo_assert(not has_function_privilege(role_name,'public.server_monopoly_read(uuid,uuid,jsonb)','execute'),'read denied to '||role_name);
    perform pg_temp.mo_assert(not has_function_privilege(role_name,'public.server_monopoly_commit(uuid,bigint,uuid,jsonb,jsonb,jsonb)','execute'),'commit denied to '||role_name);
    perform pg_temp.mo_assert(not has_function_privilege(role_name,'vezdehot_private.server_wallet_apply_monopoly(uuid,jsonb,jsonb,jsonb,jsonb)','execute'),'wallet helper denied to '||role_name);
    perform pg_temp.mo_assert(not has_table_privilege(role_name,'vezdehot_private.server_monopoly_games','select'),'state denied to '||role_name);
    perform pg_temp.mo_assert(not has_table_privilege(role_name,'vezdehot_private.server_monopoly_receipts','select'),'receipt denied to '||role_name);
  end loop;
end $$;
set local role anon;
select pg_temp.mo_reject('select public.server_monopoly_read(gen_random_uuid())','42501','anon RPC');
reset role;set local role authenticated;
select pg_temp.mo_reject('select public.server_monopoly_read(gen_random_uuid())','42501','authenticated RPC');
reset role;set local role service_role;
do $$
declare u uuid:=(select uid from pg_temp.monopoly_fixture where label='main');other_uid uuid:=(select uid from pg_temp.monopoly_fixture where label='other');
  t uuid;aid uuid;s jsonb;r jsonb;w jsonb;before jsonb;rev bigint:=0;kind text;action text;previous_table uuid;old_receipt record;winners jsonb;
begin
  perform pg_temp.mo_assert(public.server_monopoly_read(u)=jsonb_build_object('revision',0,'state',null),'empty owner revision zero');
  foreach kind in array array['win','loss','tie','resigned'] loop
    t:=gen_random_uuid();aid:=gen_random_uuid();s:=pg_temp.mo_state(t);before:=public.server_wallet_read(u);
    r:=pg_temp.mo_commit(u,rev,aid,s,'start');
    perform pg_temp.mo_assert(r->'receipt'->>'status'='saved','entry saved');
    perform pg_temp.mo_assert(pg_temp.mo_commit(u,rev,aid,s,'start')=r,'entry replay stable');
    perform pg_temp.mo_assert((public.server_wallet_read(u)->>'balance')::integer=(before->>'balance')::integer-100,'entry debited once');
    perform pg_temp.mo_assert(public.server_monopoly_read(other_uid)->'state'='null','other owner has no state');
    perform pg_temp.mo_assert(pg_temp.mo_commit(u,rev,gen_random_uuid(),s,'start')->'conflict'='true','stale device conflicts');
    perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,%s,%L,%L,%L,%L,%L)',u,rev,aid,s,'start','continue','{"different":true}'),'22023','UUID body reuse rejected');
    rev:=rev+1;
    perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,%s,%L,%L,%L)',u,rev,gen_random_uuid(),pg_temp.mo_state(gen_random_uuid()),'start'),'22023','cannot replace active table');
    perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,%s,%L,%L,%L,%L)',u,rev,gen_random_uuid(),pg_temp.mo_state(t,0),'action','roll'),'22023','paid cannot become free');
    perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,%s,%L,%L,%L,%L)',u,rev,gen_random_uuid(),pg_temp.mo_result(s,'capital','[0]'),'action','roll'),'22023','cannot invent early capital win');
    perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,%s,%L,%L,%L,%L)',u,rev,gen_random_uuid(),s||'{"phase":"review"}','action','continue'),'22023','cannot continue before rolling');
    if kind='resigned' then s:=pg_temp.mo_result(s,'resigned');action:='resign';
    else
      s:=pg_temp.mo_walk(u,case kind when 'win' then 0 when 'loss' then 1 else null end);
      winners:=case kind when 'win' then '[0]'::jsonb when 'loss' then '[1]'::jsonb else '[0,1,2,3]'::jsonb end;
      if kind='tie' then
        perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,%s,%L,%L,%L,%L)',u,(public.server_monopoly_read(u)->>'revision')::bigint,gen_random_uuid(),pg_temp.mo_result(s,'resigned'),'action','resign'),'22023','final review cannot discard a decided capital outcome');
      end if;
      s:=pg_temp.mo_result(s,'capital',winners);action:=case when kind='tie' then 'resign' else 'continue' end;
    end if;
    rev:=(public.server_monopoly_read(u)->>'revision')::bigint;aid:=gen_random_uuid();before:=public.server_wallet_read(u);
    perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,%s,%L,%L,%L,%L)',u,rev,gen_random_uuid(),jsonb_set(s,'{economy,payout}','249'),'action',action),'22023','wrong payout rejected');
    perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,%s,%L,%L,%L,%L)',u,rev,gen_random_uuid(),jsonb_set(s,'{economy,xp}','99'),'action',action),'22023','wrong XP rejected');
    perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,%s,%L,%L,%L,%L)',u,rev,gen_random_uuid(),jsonb_set(s,'{economy,outcome}','"draw"'),'action',action),'22023','no draw settlement');
    if kind='tie' then
      perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,%s,%L,%L,%L,%L)',u,rev,gen_random_uuid(),jsonb_set(s,'{winners}','[0]'),'action',action),'22023','all capital ties must be included');
      perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,%s,%L,%L,%L,%L)',u,rev,gen_random_uuid(),jsonb_set(s,'{winner}','null'),'action',action),'22023','human capital tie is win');
    end if;
    perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,%s,%L,%L,%L,%L,%L)',u,rev,gen_random_uuid(),s,'action',action,'{"failReceipt":true}'),'P0001','receipt failure rolls back payout');
    perform pg_temp.mo_assert(public.server_wallet_read(u)-'serverTime'=before-'serverTime','failed settlement changes no wallet totals');
    perform pg_temp.mo_assert((public.server_monopoly_read(u)->>'revision')::bigint=rev,'failed settlement changes no game revision');
    r:=pg_temp.mo_commit(u,rev,aid,s,'action',action);w:=public.server_wallet_read(u);
    perform pg_temp.mo_assert((w->>'balance')::integer=(before->>'balance')::integer+(s->'economy'->>'payout')::integer,'exact '||kind||' payout');
    perform pg_temp.mo_assert((w->>'xp')::integer=(before->>'xp')::integer+(s->'economy'->>'xp')::integer,'exact '||kind||' XP');
    perform pg_temp.mo_assert((w->>'games')::integer=(before->>'games')::integer+1,'game counted once');
    perform pg_temp.mo_assert(pg_temp.mo_commit(u,rev,aid,s,'action',action)=r,'result replay stable');rev:=rev+1;
    perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,%s,%L,%L)',u,rev,gen_random_uuid(),s),'22023','fresh UUID cannot settle twice');
    perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,%s,%L,%L,%L)',u,rev,gen_random_uuid(),pg_temp.mo_state(t),'start'),'22023','cannot restart same table ID');
    if previous_table is not null then perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,%s,%L,%L,%L)',u,rev,gen_random_uuid(),pg_temp.mo_state(previous_table),'start'),'22023','cannot reuse old paid table ID');end if;
    previous_table:=t;
  end loop;
  perform pg_temp.mo_assert(w->'balance'='1100' and w->'xp'='225' and w->'games'='4' and w->'wins'='2','aggregate win/loss/tie/resign totals');
  select * into old_receipt from vezdehot_private.server_monopoly_receipts where user_id=u order by created_at limit 1;
  perform pg_temp.mo_assert(public.server_monopoly_read(u,old_receipt.action_id,old_receipt.request)->'receipt'=old_receipt.response,'old receipt survives later moves');
  perform pg_temp.mo_assert(public.server_monopoly_read(other_uid,old_receipt.action_id,old_receipt.request)->'receipt' is null,'receipt owner isolation');
  perform pg_temp.mo_reject(format('select public.server_monopoly_read(%L,%L,%L)',u,old_receipt.action_id,old_receipt.request||'{"changed":true}'),'22023','read rejects UUID reuse');
  before:=w;t:=gen_random_uuid();s:=pg_temp.mo_state(t,0);perform pg_temp.mo_commit(u,rev,gen_random_uuid(),s,'start');
  perform pg_temp.mo_commit(u,rev+1,gen_random_uuid(),pg_temp.mo_result(s,'resigned'),'action','resign');
  perform pg_temp.mo_assert(public.server_wallet_read(u)-'serverTime'=before-'serverTime','free game changes no existing wallet or stats');
end $$;

-- Exact purchases and independent property worth: buying a property preserves
-- capital. All four tied players must still win the capital comparison.
do $$
declare u uuid:=(select uid from pg_temp.monopoly_fixture where label='property');t uuid:=gen_random_uuid();s jsonb;bad jsonb;rev bigint;
begin
  s:=pg_temp.mo_state(t);perform pg_temp.mo_commit(u,0,gen_random_uuid(),s,'start');
  s:=jsonb_set(s,'{players,0,pos}','2')||'{"phase":"buy"}';perform pg_temp.mo_commit(u,1,gen_random_uuid(),s,'action','roll');
  bad:=jsonb_set(s,'{players,0,money}','1501')||'{"phase":"review"}';
  perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,2,%L,%L,%L,%L)',u,gen_random_uuid(),bad,'action','buy'),'22023','cash cannot be created');
  bad:=jsonb_set(jsonb_set(s,'{players,0,money}','1501'),'{bank}','-1')||'{"phase":"review"}';
  perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,2,%L,%L,%L,%L)',u,gen_random_uuid(),bad,'action','skip'),'22023','skip cannot change money');
  s:=jsonb_set(jsonb_set(jsonb_set(jsonb_set(s,'{players,0,money}','1360'),'{players,0,properties}','[2]'),'{board,2,owner}','0'),'{bank}','140')||'{"phase":"review"}';
  perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,2,%L,%L,%L,%L)',u,gen_random_uuid(),jsonb_set(s,'{players,0,properties}','[2,2]'),'action','buy'),'22023','duplicate property rejected');
  perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,2,%L,%L,%L,%L)',u,gen_random_uuid(),jsonb_set(s,'{board,2,price}','139'),'action','buy'),'22023','price mutation rejected');
  perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,2,%L,%L,%L,%L)',u,gen_random_uuid(),jsonb_set(s,'{board,2,owner}','1'),'action','buy'),'22023','ownership must match inventory');
  perform pg_temp.mo_commit(u,2,gen_random_uuid(),s,'action','buy');
  s:=pg_temp.mo_walk(u);rev:=(public.server_monopoly_read(u)->>'revision')::bigint;
  perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,%s,%L,%L,%L,%L)',u,rev,gen_random_uuid(),pg_temp.mo_result(s,'capital','[1,2,3]'),'action','continue'),'22023','cash ranking cannot omit full property price');
  perform pg_temp.mo_commit(u,rev,gen_random_uuid(),pg_temp.mo_result(s,'capital','[0,1,2,3]'),'action','continue');
  perform pg_temp.mo_assert(public.server_wallet_read(u)->'wins'='1','full property value creates winning tie');
end $$;
-- Bankruptcy is a loss; no live owner can retain property under a dead seat.
do $$
declare u uuid:=(select uid from pg_temp.monopoly_fixture where label='bankrupt');s jsonb:=pg_temp.mo_state(gen_random_uuid());bad jsonb;
begin
  perform pg_temp.mo_commit(u,0,gen_random_uuid(),s,'start');
  bad:=pg_temp.mo_result(s,'bankrupt');
  perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,1,%L,%L,%L,%L)',u,gen_random_uuid(),bad,'action','roll'),'22023','living human cannot claim bankruptcy');
  s:=jsonb_set(jsonb_set(jsonb_set(s,'{players,0,money}','0'),'{players,0,alive}','false'),'{bank}','1500');s:=pg_temp.mo_result(s,'bankrupt');
  perform pg_temp.mo_commit(u,1,gen_random_uuid(),s,'action','roll');
  perform pg_temp.mo_assert(public.server_wallet_read(u)->'balance'='900' and public.server_wallet_read(u)->'xp'='25','bankruptcy exact loss settlement');
end $$;
-- Only the mover can go bankrupt. A bot bankruptcy remains review until the
-- next living seat, and the last surviving bot can also win against the human.
do $$
declare kind text;u uuid;s jsonb;current jsonb;rev bigint;seat integer;action text;
begin
  foreach kind in array array['lastWin','lastLoss'] loop
    select uid into u from pg_temp.monopoly_fixture where label=kind;
    s:=pg_temp.mo_state(gen_random_uuid());perform pg_temp.mo_commit(u,0,gen_random_uuid(),s,'start');
    s:=s||'{"phase":"review"}';perform pg_temp.mo_commit(u,1,gen_random_uuid(),s,'action','roll');
    rev:=2;
    for seat in 1..3 loop
      s:=s||jsonb_build_object('turn',seat,'turnNumber',seat+1,'phase','review');
      if seat<3 or kind='lastWin' then
        s:=jsonb_set(jsonb_set(jsonb_set(s,array['players',seat::text,'money'],'0'),array['players',seat::text,'alive'],'false'),'{bank}',to_jsonb(seat*1500));
      end if;
      if seat=3 and kind='lastWin' then
        perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,%s,%L,%L,%L,%L)',u,rev,gen_random_uuid(),pg_temp.mo_result(s,'last-player','[3]'),'action','continue'),'22023','last-player winner must actually be alive');
        s:=pg_temp.mo_result(s,'last-player','[0]');
      end if;
      perform pg_temp.mo_commit(u,rev,gen_random_uuid(),s,'action','continue');rev:=rev+1;
    end loop;
    if kind='lastLoss' then
      s:=s||'{"turn":0,"turnNumber":5,"phase":"ready"}';perform pg_temp.mo_commit(u,rev,gen_random_uuid(),s,'action','continue');rev:=rev+1;
      s:=jsonb_set(jsonb_set(jsonb_set(s,'{players,0,money}','0'),'{players,0,alive}','false'),'{bank}','4500');
      s:=pg_temp.mo_result(s,'last-player','[3]');perform pg_temp.mo_commit(u,rev,gen_random_uuid(),s,'action','roll');
    end if;
    perform pg_temp.mo_assert(public.server_wallet_read(u)->'xp'=to_jsonb(case kind when 'lastWin' then 100 else 25 end),'last-player exact XP');
  end loop;
end $$;
-- A complete free win does not even create a protected wallet.
do $$
declare u uuid:=(select uid from pg_temp.monopoly_fixture where label='free');s jsonb:=pg_temp.mo_state(gen_random_uuid(),0);rev bigint;
begin
  perform pg_temp.mo_commit(u,0,gen_random_uuid(),s,'start');s:=pg_temp.mo_walk(u);rev:=(public.server_monopoly_read(u)->>'revision')::bigint;
  s:=pg_temp.mo_result(s,'capital','[0,1,2,3]');
  perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,%s,%L,%L)',u,rev,gen_random_uuid(),jsonb_set(s,'{economy,xp}','100')),'22023','free practice earns no XP');
  perform pg_temp.mo_commit(u,rev,gen_random_uuid(),s);
  perform pg_temp.mo_assert(not exists(select 1 from vezdehot_private.server_wallets where user_id=u),'free win never initializes wallet');
  s:=pg_temp.mo_state(gen_random_uuid(),0);perform pg_temp.mo_commit(u,rev+1,gen_random_uuid(),s,'start');
  perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,%s,%L,%L,%L,%L)',u,rev+2,gen_random_uuid(),pg_temp.mo_state((s->>'id')::uuid,100),'action','roll'),'22023','free cannot become paid');
end $$;
-- Projection and envelope mismatches cannot write either game or wallet.
do $$
declare u uuid:=(select uid from pg_temp.monopoly_fixture where label='bad');t uuid:=gen_random_uuid();aid uuid:=gen_random_uuid();s jsonb:=pg_temp.mo_state(t);req jsonb;response jsonb;k text;
begin
  req:=jsonb_build_object('op','start','actionId',aid,'expectedRevision',0,'difficulty','normal','stake',100);
  response:=jsonb_build_object('status','saved','revision',1,'game',jsonb_build_object('id',t,'economy',s->'economy','over',false,'phase','ready','winner',null,'winners','[]'::jsonb,'finishKind',null,'resigned',false));
  perform pg_temp.mo_reject(format('select public.server_monopoly_commit(%L,0,%L,%L,%L,%L)',u,aid,req,s,jsonb_set(response,'{game,economy,stake}','0')),'22023','public stake cannot differ');
  perform pg_temp.mo_reject(format('select public.server_monopoly_commit(%L,0,%L,%L,%L,%L)',u,aid,req,s,jsonb_set(response,'{game,winner}','0')),'22023','public winner cannot differ');
  perform pg_temp.mo_reject(format('select public.server_monopoly_commit(%L,0,%L,%L,%L,%L)',u,aid,req,jsonb_set(s,'{economy}',s->'economy'||'{"extra":1}'),response),'22023','unknown economy fields rejected');
  foreach k in array array['turn','bank','players','board','finishKind','winner'] loop
    perform pg_temp.mo_reject(format('select public.server_monopoly_commit(%L,0,%L,%L,%L,%L)',u,aid,req,s-k,response),'22023','missing required '||k);
  end loop;
  perform pg_temp.mo_assert(not exists(select 1 from vezdehot_private.server_wallets where user_id=u),'invalid projections never initialize wallet');
end $$;
do $$
declare u uuid:=(select uid from pg_temp.monopoly_fixture where label='rollback');s jsonb:=pg_temp.mo_state(gen_random_uuid());
begin
  perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,0,%L,%L,%L,%L,%L)',u,gen_random_uuid(),s,'start','continue','{"failReceipt":true}'),'P0001','entry receipt failure');
  perform pg_temp.mo_assert(not exists(select 1 from vezdehot_private.server_wallets where user_id=u),'failed receipt rolls back welcome');
  perform pg_temp.mo_assert(not exists(select 1 from vezdehot_private.server_monopoly_games where user_id=u),'failed receipt rolls back game');
  perform pg_temp.mo_assert(not exists(select 1 from vezdehot_private.server_monopoly_receipts where user_id=u),'failed receipt absent');
  perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,0,%L,%L,%L,%L,%L)',u,gen_random_uuid(),s,'start','continue','{"expectedRevision":8}'),'22023','envelope revision bound');
  perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,0,%L,%L,%L,%L,%L)',u,gen_random_uuid(),s,'start','continue',jsonb_build_object('actionId',gen_random_uuid())),'22023','envelope UUID bound');
end $$;
-- Insufficient funds does not create a game or receipt.
select public.server_wallet_read((select uid from pg_temp.monopoly_fixture where label='empty'));
reset role;
update vezdehot_private.server_wallets set balance=99 where user_id=(select uid from pg_temp.monopoly_fixture where label='empty');
set local role service_role;
do $$
declare u uuid:=(select uid from pg_temp.monopoly_fixture where label='empty');s jsonb:=pg_temp.mo_state(gen_random_uuid());
begin
  perform pg_temp.mo_reject(format('select pg_temp.mo_commit(%L,0,%L,%L,%L)',u,gen_random_uuid(),s,'start'),'P0001','insufficient funds');
  perform pg_temp.mo_assert(public.server_monopoly_read(u)->'revision'='0','declined entry leaves no game');
  perform pg_temp.mo_assert(public.server_wallet_read(u)->'balance'='99','declined balance unchanged');
  perform pg_temp.mo_assert(not exists(select 1 from vezdehot_private.server_monopoly_receipts where user_id=u),'declined entry leaves no receipt');
end $$;
reset role;
rollback;
