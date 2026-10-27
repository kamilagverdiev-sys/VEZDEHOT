-- Run only in the disposable local PGlite database. CAS interleavings model two
-- devices; this single-session suite does not measure parallel lock scheduling.
begin;
set local statement_timeout='30s';
create temporary table bunker_fixture(label text primary key,uid uuid default gen_random_uuid()) on commit drop;
insert into bunker_fixture(label) values('main'),('free'),('empty'),('rollback'),('other'),('bad');
insert into auth.users(id,is_anonymous) select uid,false from bunker_fixture;
grant select on bunker_fixture to service_role,anon,authenticated;
create function pg_temp.b_assert(ok boolean,description text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Bunker assertion failed: %',description; end if; end $$;
create function pg_temp.b_reject(command text,expected text,description text) returns void language plpgsql as $$
declare code text;
begin begin execute command; exception when others then code:=sqlstate; end;
  perform pg_temp.b_assert(code=expected,description||' expected '||expected||', got '||coalesce(code,'success'));
end $$;
create function pg_temp.b_state(id uuid,kind text default 'active',stake integer default 100) returns jsonb language plpgsql as $$
declare players jsonb:='[]'; i integer; alive boolean; terminal boolean:=kind in ('win','loss','resigned');
begin
  for i in 0..5 loop
    alive:=case when kind in ('win','winReview') then i<3 when kind in ('loss','lossReview') then i>0 else true end;
    players:=players||jsonb_build_array(jsonb_build_object('alive',alive,'cards','[]'::jsonb));
  end loop;
  return jsonb_build_object('id',id,'version',2,'diff','normal','stake',stake,'round',case when kind in ('win','winReview') then 3 else 1 end,
    'phase',case when terminal then 'over' when kind in ('winReview','lossReview') then 'voteResult' else 'reveal' end,
    'players',players,'over',terminal,'resigned',kind='resigned','result',case when kind='win' then 'survived' when terminal then 'lost' else null end,
    'economy',jsonb_build_object('version',1,'stake',stake,'settled',terminal,
      'payout',case when stake=100 and kind='win' then 250 else 0 end,
      'xp',case when stake=100 and kind='win' then 120 when stake=100 and kind='loss' then 25 else 0 end,
      'outcome',case when kind='win' then 'win' when kind='loss' then 'loss' when kind='resigned' then 'resigned' else null end));
end $$;
create function pg_temp.b_commit(uid uuid,rev bigint,aid uuid,state jsonb,op text default 'action',action text default 'continue',extra jsonb default '{}')
returns jsonb language plpgsql as $$
declare req jsonb; response jsonb;
begin
  req:=jsonb_build_object('op',op,'actionId',aid,'expectedRevision',rev);
  if op='start' then req:=req||jsonb_build_object('difficulty','normal','scenarioChoice','random','stake',state->'economy'->'stake');
  else req:=req||jsonb_build_object('gameId',state->'id','action',jsonb_build_object('type',action)); end if;
  response:=jsonb_build_object('status','saved','revision',rev+1,'game',jsonb_build_object('id',state->'id','over',state->'over','result',state->'result','economy',state->'economy'));
  return public.server_bunker_commit(uid,rev,aid,req||extra,state,response);
end $$;
create function pg_temp.b_fail_receipt() returns trigger language plpgsql as $$
begin if new.request ? 'failReceipt' then raise exception 'Injected receipt failure' using errcode='P0001'; end if;return new;end $$;
create trigger bunker_fail_receipt before insert on vezdehot_private.server_bunker_receipts for each row execute function pg_temp.b_fail_receipt();

-- Every browser role is barred from private state, receipts and both RPCs.
do $$
declare role_name text;
begin
  foreach role_name in array array['anon','authenticated'] loop
    perform pg_temp.b_assert(not has_function_privilege(role_name,'public.server_bunker_read(uuid,uuid,jsonb)','execute'),'read RPC denied to '||role_name);
    perform pg_temp.b_assert(not has_function_privilege(role_name,'public.server_bunker_commit(uuid,bigint,uuid,jsonb,jsonb,jsonb)','execute'),'commit RPC denied to '||role_name);
    perform pg_temp.b_assert(not has_function_privilege(role_name,'vezdehot_private.server_wallet_apply_bunker(uuid,jsonb,jsonb,jsonb,jsonb)','execute'),'wallet helper denied to '||role_name);
    perform pg_temp.b_assert(not has_table_privilege(role_name,'vezdehot_private.server_bunker_games','select'),'state denied to '||role_name);
    perform pg_temp.b_assert(not has_table_privilege(role_name,'vezdehot_private.server_bunker_receipts','select'),'receipt denied to '||role_name);
  end loop;
end $$;
set local role anon;
select pg_temp.b_reject('select public.server_bunker_read(gen_random_uuid())','42501','anonymous RPC denied');
reset role;
set local role authenticated;
select pg_temp.b_reject('select public.server_bunker_read(gen_random_uuid())','42501','authenticated RPC denied');
reset role;
set local role service_role;
do $$
declare u uuid:=(select uid from pg_temp.bunker_fixture where label='main'); other_uid uuid:=(select uid from pg_temp.bunker_fixture where label='other');
  t uuid; aid uuid; s jsonb; r jsonb; old_receipt record; w jsonb; before jsonb; rev bigint:=0; kind text; previous_table uuid;
begin
  perform pg_temp.b_assert(public.server_bunker_read(u)=jsonb_build_object('revision',0,'state',null),'empty owner revision zero');
  foreach kind in array array['win','loss','resigned'] loop
    t:=gen_random_uuid();aid:=gen_random_uuid();s:=pg_temp.b_state(t);before:=public.server_wallet_read(u);
    r:=pg_temp.b_commit(u,rev,aid,s,'start');
    perform pg_temp.b_assert(r->'receipt'->>'status'='saved','entry saved');
    perform pg_temp.b_assert(pg_temp.b_commit(u,rev,aid,s,'start')=r,'entry replay stable');
    perform pg_temp.b_assert((public.server_wallet_read(u)->>'balance')::integer=(before->>'balance')::integer-100,'one entry debit');
    perform pg_temp.b_assert(public.server_bunker_read(other_uid)->'state'='null','other owner sees no state');
    perform pg_temp.b_assert(pg_temp.b_commit(u,rev,gen_random_uuid(),s,'start')->'conflict'='true','stale device conflicts');
    perform pg_temp.b_reject(format('select pg_temp.b_commit(%L,%s,%L,%L,%L,%L,%L)',u,rev,aid,s,'start','continue','{"different":true}'),'22023','UUID body reuse rejected');
    rev:=rev+1;
    perform pg_temp.b_reject(format('select pg_temp.b_commit(%L,%s,%L,%L,%L)',u,rev,gen_random_uuid(),pg_temp.b_state(gen_random_uuid()),'start'),'22023','active table cannot be replaced');
    perform pg_temp.b_reject(format('select pg_temp.b_commit(%L,%s,%L,%L)',u,rev,gen_random_uuid(),pg_temp.b_state(t,'active',0)),'22023','paid cannot become free');
    perform pg_temp.b_reject(format('select pg_temp.b_commit(%L,%s,%L,%L)',u,rev,gen_random_uuid(),pg_temp.b_state(t,'win')),'22023','cannot invent an early win');
    if kind<>'resigned' then
      s:=pg_temp.b_state(t,kind||'Review');perform pg_temp.b_commit(u,rev,gen_random_uuid(),s,'action','vote');rev:=rev+1;
      perform pg_temp.b_reject(format('select pg_temp.b_commit(%L,%s,%L,%L,%L,%L)',u,rev,gen_random_uuid(),pg_temp.b_state(t,kind)||'{"resigned":true}','action','resign'),'22023','earned outcome cannot become forfeit');
    end if;
    s:=pg_temp.b_state(t,kind);aid:=gen_random_uuid();before:=public.server_wallet_read(u);
    perform pg_temp.b_reject(format('select pg_temp.b_commit(%L,%s,%L,%L,%L,%L)',u,rev,gen_random_uuid(),jsonb_set(s,'{economy,payout}','249'),'action','resign'),'22023','wrong payout rejected');
    perform pg_temp.b_reject(format('select pg_temp.b_commit(%L,%s,%L,%L,%L,%L)',u,rev,gen_random_uuid(),jsonb_set(s,'{economy,xp}','119'),'action','resign'),'22023','wrong XP rejected');
    perform pg_temp.b_reject(format('select pg_temp.b_commit(%L,%s,%L,%L,%L,%L,%L)',u,rev,gen_random_uuid(),s,'action','resign','{"failReceipt":true}'),'P0001','failed settlement receipt rolls back reward');
    perform pg_temp.b_assert(public.server_wallet_read(u)-'serverTime'=before-'serverTime','failed settlement changes no wallet totals');
    perform pg_temp.b_assert((public.server_bunker_read(u)->>'revision')::bigint=rev,'failed settlement changes no revision');
    -- Resign at a completed vote must honor the already earned win/loss.
    r:=pg_temp.b_commit(u,rev,aid,s,'action','resign');w:=public.server_wallet_read(u);
    perform pg_temp.b_assert((w->>'balance')::integer=(before->>'balance')::integer+(s->'economy'->>'payout')::integer,'exact '||kind||' payout');
    perform pg_temp.b_assert((w->>'xp')::integer=(before->>'xp')::integer+(s->'economy'->>'xp')::integer,'exact '||kind||' XP');
    perform pg_temp.b_assert((w->>'games')::integer=(before->>'games')::integer+1,'game counted once');
    perform pg_temp.b_assert(pg_temp.b_commit(u,rev,aid,s,'action','resign')=r,'settlement replay stable');rev:=rev+1;
    perform pg_temp.b_reject(format('select pg_temp.b_commit(%L,%s,%L,%L)',u,rev,gen_random_uuid(),s),'22023','cannot settle twice with fresh UUID');
    perform pg_temp.b_reject(format('select pg_temp.b_commit(%L,%s,%L,%L,%L)',u,rev,gen_random_uuid(),pg_temp.b_state(t),'start'),'22023','same paid table ID cannot restart');
    if previous_table is not null then perform pg_temp.b_reject(format('select pg_temp.b_commit(%L,%s,%L,%L,%L)',u,rev,gen_random_uuid(),pg_temp.b_state(previous_table),'start'),'22023','older table ID cannot restart');end if;
    previous_table:=t;
  end loop;
  perform pg_temp.b_assert(w->'balance'='950' and w->'xp'='145' and w->'games'='3' and w->'wins'='1','exact aggregate totals');
  select * into old_receipt from vezdehot_private.server_bunker_receipts where user_id=u order by created_at limit 1;
  perform pg_temp.b_assert(public.server_bunker_read(u,old_receipt.action_id,old_receipt.request)->'receipt'=old_receipt.response,'old entry receipt survives later moves');
  perform pg_temp.b_assert(public.server_bunker_read(other_uid,old_receipt.action_id,old_receipt.request)->'receipt' is null,'receipts scoped to owner');
  perform pg_temp.b_reject(format('select public.server_bunker_read(%L,%L,%L)',u,old_receipt.action_id,old_receipt.request||'{"changed":true}'),'22023','read also rejects reused request ID');
end $$;
do $$
declare u uuid:=(select uid from pg_temp.bunker_fixture where label='free');t uuid:=gen_random_uuid();s jsonb;
begin
  perform pg_temp.b_commit(u,0,gen_random_uuid(),pg_temp.b_state(t,'active',0),'start');
  perform pg_temp.b_commit(u,1,gen_random_uuid(),pg_temp.b_state(t,'winReview',0),'action','vote');
  s:=pg_temp.b_state(t,'win',0);
  perform pg_temp.b_reject(format('select pg_temp.b_commit(%L,2,%L,%L)',u,gen_random_uuid(),jsonb_set(s,'{economy,xp}','120')),'22023','free practice earns no XP');
  perform pg_temp.b_commit(u,2,gen_random_uuid(),s);
  perform pg_temp.b_assert(not exists(select 1 from vezdehot_private.server_wallets where user_id=u),'free win never initializes wallet');
  t:=gen_random_uuid();perform pg_temp.b_commit(u,3,gen_random_uuid(),pg_temp.b_state(t,'active',0),'start');
  perform pg_temp.b_reject(format('select pg_temp.b_commit(%L,4,%L,%L)',u,gen_random_uuid(),pg_temp.b_state(t,'active',100)),'22023','free cannot become paid');
end $$;
-- The public receipt must describe the same result and exact economy metadata.
do $$
declare u uuid:=(select uid from pg_temp.bunker_fixture where label='bad');t uuid:=gen_random_uuid();aid uuid:=gen_random_uuid();s jsonb;
  req jsonb; response jsonb;
begin
  s:=pg_temp.b_state(t);req:=jsonb_build_object('op','start','actionId',aid,'expectedRevision',0,'difficulty','normal','stake',100);
  response:=jsonb_build_object('status','saved','revision',1,'game',jsonb_build_object('id',t,'economy',s->'economy','over',false,'result',null));
  perform pg_temp.b_reject(format('select public.server_bunker_commit(%L,0,%L,%L,%L,%L)',u,aid,req,s,jsonb_set(response,'{game,economy,stake}','0')),'22023','public stake cannot differ');
  perform pg_temp.b_reject(format('select public.server_bunker_commit(%L,0,%L,%L,%L,%L)',u,aid,req,s,jsonb_set(response,'{game,result}','"survived"')),'22023','public result cannot differ');
  perform pg_temp.b_reject(format('select public.server_bunker_commit(%L,0,%L,%L,%L,%L)',u,aid,req,s,jsonb_set(response,'{game,over}','true')),'22023','public completion cannot differ');
  perform pg_temp.b_reject(format('select public.server_bunker_commit(%L,0,%L,%L,%L,%L)',u,aid,req,jsonb_set(s,'{economy}',s->'economy'||'{"extra":1}'),response),'22023','unknown economy fields rejected');
  perform pg_temp.b_assert(not exists(select 1 from vezdehot_private.server_wallets where user_id=u),'invalid projections never initialize wallet');
end $$;
-- A receipt failure rolls back the game, debit AND first welcome grant.
do $$
declare u uuid:=(select uid from pg_temp.bunker_fixture where label='rollback');s jsonb:=pg_temp.b_state(gen_random_uuid());
begin
  perform pg_temp.b_reject(format('select pg_temp.b_commit(%L,0,%L,%L,%L,%L,%L)',u,gen_random_uuid(),s,'start','continue','{"failReceipt":true}'),'P0001','injected receipt failure');
  perform pg_temp.b_assert(not exists(select 1 from vezdehot_private.server_wallets where user_id=u),'failed receipt rolls back welcome');
  perform pg_temp.b_assert(not exists(select 1 from vezdehot_private.server_bunker_games where user_id=u),'failed receipt rolls back game');
  perform pg_temp.b_assert(not exists(select 1 from vezdehot_private.server_bunker_receipts where user_id=u),'failed receipt absent');
  perform pg_temp.b_reject(format('select pg_temp.b_commit(%L,0,%L,%L,%L,%L,%L)',u,gen_random_uuid(),s,'start','continue','{"expectedRevision":8}'),'22023','envelope revision bound');
  perform pg_temp.b_reject(format('select pg_temp.b_commit(%L,0,%L,%L,%L,%L,%L)',u,gen_random_uuid(),s,'start','continue',jsonb_build_object('actionId',gen_random_uuid())),'22023','envelope UUID bound');
end $$;
-- Insufficient funds leaves the previous table and receipts unchanged.
select public.server_wallet_read((select uid from pg_temp.bunker_fixture where label='empty'));
reset role;
update vezdehot_private.server_wallets set balance=99 where user_id=(select uid from pg_temp.bunker_fixture where label='empty');
set local role service_role;
do $$
declare u uuid:=(select uid from pg_temp.bunker_fixture where label='empty');s jsonb:=pg_temp.b_state(gen_random_uuid());
begin
  perform pg_temp.b_reject(format('select pg_temp.b_commit(%L,0,%L,%L,%L)',u,gen_random_uuid(),s,'start'),'P0001','insufficient funds');
  perform pg_temp.b_assert(public.server_bunker_read(u)->'revision'='0','no table after declined entry');
  perform pg_temp.b_assert((public.server_wallet_read(u))->'balance'='99','declined balance unchanged');
  perform pg_temp.b_assert(not exists(select 1 from vezdehot_private.server_bunker_receipts where user_id=u),'no receipt after declined entry');
end $$;
reset role;
rollback;
