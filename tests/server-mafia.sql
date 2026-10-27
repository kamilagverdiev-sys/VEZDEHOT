-- Run only in the disposable local PGlite database. CAS interleavings model two
-- devices; this single-session suite does not measure parallel lock scheduling.
begin;
set local statement_timeout='30s';
create temporary table mafia_fixture(label text primary key,uid uuid default gen_random_uuid()) on commit drop;
insert into mafia_fixture(label) values('main'),('free'),('empty'),('rollback'),('other'),('bad'),('mafia');
insert into auth.users(id,is_anonymous) select uid,false from mafia_fixture;
grant select on mafia_fixture to service_role,anon,authenticated;
create function pg_temp.m_assert(ok boolean,description text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Mafia assertion failed: %',description; end if; end $$;
create function pg_temp.m_reject(command text,expected text,description text) returns void language plpgsql as $$
declare code text;
begin begin execute command; exception when others then code:=sqlstate; end;
  perform pg_temp.m_assert(code=expected,description||' expected '||expected||', got '||coalesce(code,'success'));
end $$;
create function pg_temp.m_state(id uuid,kind text default 'active',stake integer default 100) returns jsonb language plpgsql as $$
declare players jsonb:='[]'; i integer; r text; terminal boolean:=kind in ('win','loss','draw','resigned','observerWin');
  team text:=case when kind in ('win','observerWin') then 'town' when kind='loss' then 'mafia' when kind='draw' then 'draw' else null end;
begin
  for i in 0..6 loop
    r:=case when i in (1,2) then 'mafia' when i=3 then 'detective' when i=4 then 'doctor' else 'civilian' end;
    players:=players||jsonb_build_array(jsonb_build_object('id',i,'role',r,'alive',true));
  end loop;
  return jsonb_build_object('id',id,'version',3,'diff','normal','stake',stake,'round',1,
    'phase',case when terminal then 'result' else 'night' end,'players',players,'over',terminal,'settled',terminal,
    'resigned',kind='resigned','winningTeam',team,'win',kind in ('win','observerWin'),'draw',kind='draw',
    'economy',jsonb_build_object('version',1,'stake',stake,'settled',terminal,
      'payout',case when stake=100 and kind in ('win','observerWin') then 250 when stake=100 and kind='draw' then 100 else 0 end,
      'xp',case when stake=100 and kind in ('win','observerWin') then 130 when stake=100 and kind='loss' then 25 when stake=100 and kind='draw' then 40 else 0 end,
      'outcome',case when kind in ('win','observerWin') then 'win' when terminal then kind else null end));
end $$;
create function pg_temp.m_commit(uid uuid,rev bigint,aid uuid,state jsonb,op text default 'action',action text default 'continue',extra jsonb default '{}')
returns jsonb language plpgsql as $$
declare req jsonb; response jsonb;
begin
  req:=jsonb_build_object('op',op,'actionId',aid,'expectedRevision',rev);
  if op='start' then req:=req||jsonb_build_object('difficulty','normal','stake',state->'economy'->'stake');
  else req:=req||jsonb_build_object('gameId',state->'id','action',jsonb_build_object('type',action)); end if;
  response:=jsonb_build_object('status','saved','revision',rev+1,'game',jsonb_build_object('id',state->'id','over',state->'over',
    'phase',state->'phase','winningTeam',state->'winningTeam','win',state->'win','draw',state->'draw','resigned',state->'resigned','economy',state->'economy'));
  return public.server_mafia_commit(uid,rev,aid,req||extra,state,response);
end $$;
-- Build legal, non-terminal phase transitions in a disposable fixture. The real
-- engine + SQL integration suite separately validates complete actual games.
create function pg_temp.m_step(uid uuid,action text,kill integer default null) returns jsonb language plpgsql as $$
declare current jsonb:=public.server_mafia_read(uid);s jsonb:=current->'state';phase text:=s->>'phase';
begin
  if kill is not null then s:=jsonb_set(s,array['players',kill::text,'alive'],'false'); end if;
  s:=jsonb_set(s,'{phase}',to_jsonb(case action when 'night' then 'dawn' when 'vote' then 'voteResult'
    else case phase when 'dawn' then 'day' when 'day' then 'vote' else 'night' end end));
  if phase='voteResult' then s:=jsonb_set(s,'{round}',to_jsonb((s->>'round')::integer+1)); end if;
  perform pg_temp.m_commit(uid,(current->>'revision')::bigint,gen_random_uuid(),s,'action',action);
  return s;
end $$;

create function pg_temp.m_fail_receipt() returns trigger language plpgsql as $$
begin if new.request ? 'failReceipt' then raise exception 'Injected receipt failure' using errcode='P0001'; end if;return new;end $$;
create trigger mafia_fail_receipt before insert on vezdehot_private.server_mafia_receipts for each row execute function pg_temp.m_fail_receipt();

-- Every browser role is barred from private state, receipts and both RPCs.
do $$
declare role_name text;
begin
  foreach role_name in array array['anon','authenticated'] loop
    perform pg_temp.m_assert(not has_function_privilege(role_name,'public.server_mafia_read(uuid,uuid,jsonb)','execute'),'read RPC denied to '||role_name);
    perform pg_temp.m_assert(not has_function_privilege(role_name,'public.server_mafia_commit(uuid,bigint,uuid,jsonb,jsonb,jsonb)','execute'),'commit RPC denied to '||role_name);
    perform pg_temp.m_assert(not has_function_privilege(role_name,'vezdehot_private.server_wallet_apply_mafia(uuid,jsonb,jsonb,jsonb,jsonb)','execute'),'wallet helper denied to '||role_name);
    perform pg_temp.m_assert(not has_table_privilege(role_name,'vezdehot_private.server_mafia_games','select'),'state denied to '||role_name);
    perform pg_temp.m_assert(not has_table_privilege(role_name,'vezdehot_private.server_mafia_receipts','select'),'receipt denied to '||role_name);
  end loop;
end $$;
set local role anon;
select pg_temp.m_reject('select public.server_mafia_read(gen_random_uuid())','42501','anonymous RPC denied');
reset role;
set local role authenticated;
select pg_temp.m_reject('select public.server_mafia_read(gen_random_uuid())','42501','authenticated RPC denied');
reset role;
set local role service_role;
do $$
declare u uuid:=(select uid from pg_temp.mafia_fixture where label='main'); other_uid uuid:=(select uid from pg_temp.mafia_fixture where label='other');
  t uuid; aid uuid; s jsonb; r jsonb; old_receipt record; w jsonb; before jsonb; rev bigint:=0; kind text; action text; previous_table uuid; i integer;
begin
  perform pg_temp.m_assert(public.server_mafia_read(u)=jsonb_build_object('revision',0,'state',null),'empty owner revision zero');
  foreach kind in array array['win','loss','draw','resigned','observerWin'] loop
    t:=gen_random_uuid();aid:=gen_random_uuid();s:=pg_temp.m_state(t);before:=public.server_wallet_read(u);
    r:=pg_temp.m_commit(u,rev,aid,s,'start');
    perform pg_temp.m_assert(r->'receipt'->>'status'='saved','entry saved');
    perform pg_temp.m_assert(pg_temp.m_commit(u,rev,aid,s,'start')=r,'entry replay stable');
    perform pg_temp.m_assert((public.server_wallet_read(u)->>'balance')::integer=(before->>'balance')::integer-100,'one entry debit');
    perform pg_temp.m_assert(public.server_mafia_read(other_uid)->'state'='null','other owner sees no state');
    perform pg_temp.m_assert(pg_temp.m_commit(u,rev,gen_random_uuid(),s,'start')->'conflict'='true','stale device conflicts');
    perform pg_temp.m_reject(format('select pg_temp.m_commit(%L,%s,%L,%L,%L,%L,%L)',u,rev,aid,s,'start','continue','{"different":true}'),'22023','UUID body reuse rejected');
    rev:=rev+1;
    perform pg_temp.m_reject(format('select pg_temp.m_commit(%L,%s,%L,%L,%L)',u,rev,gen_random_uuid(),pg_temp.m_state(gen_random_uuid()),'start'),'22023','active table cannot be replaced');
    perform pg_temp.m_reject(format('select pg_temp.m_commit(%L,%s,%L,%L)',u,rev,gen_random_uuid(),pg_temp.m_state(t,'active',0)),'22023','paid cannot become free');
    perform pg_temp.m_reject(format('select pg_temp.m_commit(%L,%s,%L,%L,%L,%L)',u,rev,gen_random_uuid(),pg_temp.m_state(t,'win'),'action','night'),'22023','cannot invent an early win');
    perform pg_temp.m_reject(format('select pg_temp.m_commit(%L,%s,%L,%L,%L,%L)',u,rev,gen_random_uuid(),pg_temp.m_state(t,'draw'),'action','continue'),'22023','cannot invent an early draw');
    perform pg_temp.m_reject(format('select pg_temp.m_commit(%L,%s,%L,%L,%L,%L)',u,rev,gen_random_uuid(),pg_temp.m_state(t,'win'),'action','finish'),'22023','living human cannot fast finish');
    if kind in ('win','loss') then
      perform pg_temp.m_step(u,'night',case when kind='loss' then 6 else null end);
      perform pg_temp.m_step(u,'continue');perform pg_temp.m_step(u,'continue');
      perform pg_temp.m_step(u,'vote',case when kind='win' then 2 else 5 end);
      perform pg_temp.m_step(u,'continue');
      if kind='win' then perform pg_temp.m_step(u,'night');perform pg_temp.m_step(u,'continue');perform pg_temp.m_step(u,'continue');end if;
    elsif kind='draw' then
      for i in 1..25 loop
        perform pg_temp.m_step(u,'night');perform pg_temp.m_step(u,'continue');perform pg_temp.m_step(u,'continue');perform pg_temp.m_step(u,'vote');
        if i<25 then perform pg_temp.m_step(u,'continue');end if;
      end loop;
    elsif kind='observerWin' then
      perform pg_temp.m_step(u,'night',0);
    end if;
    r:=public.server_mafia_read(u);rev:=(r->>'revision')::bigint;
    s:=pg_temp.m_state(t,kind)||jsonb_build_object('round',r->'state'->'round','players',r->'state'->'players');
    if kind='win' then s:=jsonb_set(s,'{players,1,alive}','false');action:='vote';
    elsif kind='loss' then s:=jsonb_set(s,'{players,4,alive}','false');action:='night';
    elsif kind='observerWin' then s:=jsonb_set(jsonb_set(s,'{players,1,alive}','false'),'{players,2,alive}','false');action:='finish';
    elsif kind='draw' then action:='continue';else action:='resign';end if;
    aid:=gen_random_uuid();before:=public.server_wallet_read(u);
    perform pg_temp.m_reject(format('select pg_temp.m_commit(%L,%s,%L,%L,%L,%L)',u,rev,gen_random_uuid(),jsonb_set(s,'{economy,payout}','249'),'action',action),'22023','wrong payout rejected');
    perform pg_temp.m_reject(format('select pg_temp.m_commit(%L,%s,%L,%L,%L,%L)',u,rev,gen_random_uuid(),jsonb_set(s,'{economy,xp}','129'),'action',action),'22023','wrong XP rejected');
    perform pg_temp.m_reject(format('select pg_temp.m_commit(%L,%s,%L,%L,%L,%L)',u,rev,gen_random_uuid(),jsonb_set(s,'{players,1,role}','"civilian"'),'action',action),'22023','cannot change hidden roles');
    if kind in ('win','observerWin') then
      perform pg_temp.m_reject(format('select pg_temp.m_commit(%L,%s,%L,%L,%L,%L)',u,rev,gen_random_uuid(),jsonb_set(s,'{winningTeam}','"mafia"'),'action',action),'22023','winner must match survivors');
    end if;
    perform pg_temp.m_reject(format('select pg_temp.m_commit(%L,%s,%L,%L,%L,%L,%L)',u,rev,gen_random_uuid(),s,'action',action,'{"failReceipt":true}'),'P0001','failed settlement receipt rolls back reward');
    perform pg_temp.m_assert(public.server_wallet_read(u)-'serverTime'=before-'serverTime','failed settlement changes no wallet totals');
    perform pg_temp.m_assert((public.server_mafia_read(u)->>'revision')::bigint=rev,'failed settlement changes no revision');
    r:=pg_temp.m_commit(u,rev,aid,s,'action',action);w:=public.server_wallet_read(u);
    perform pg_temp.m_assert((w->>'balance')::integer=(before->>'balance')::integer+(s->'economy'->>'payout')::integer,'exact '||kind||' payout');
    perform pg_temp.m_assert((w->>'xp')::integer=(before->>'xp')::integer+(s->'economy'->>'xp')::integer,'exact '||kind||' XP');
    perform pg_temp.m_assert((w->>'games')::integer=(before->>'games')::integer+1,'game counted once');
    perform pg_temp.m_assert(pg_temp.m_commit(u,rev,aid,s,'action',action)=r,'settlement replay stable');rev:=rev+1;
    perform pg_temp.m_reject(format('select pg_temp.m_commit(%L,%s,%L,%L)',u,rev,gen_random_uuid(),s),'22023','cannot settle twice with fresh UUID');
    perform pg_temp.m_reject(format('select pg_temp.m_commit(%L,%s,%L,%L,%L)',u,rev,gen_random_uuid(),pg_temp.m_state(t),'start'),'22023','same paid table ID cannot restart');
    if previous_table is not null then perform pg_temp.m_reject(format('select pg_temp.m_commit(%L,%s,%L,%L,%L)',u,rev,gen_random_uuid(),pg_temp.m_state(previous_table),'start'),'22023','older table ID cannot restart');end if;
    previous_table:=t;
  end loop;
  perform pg_temp.m_assert(w->'balance'='1100' and w->'xp'='325' and w->'games'='5' and w->'wins'='2','exact aggregate totals');
  select * into old_receipt from vezdehot_private.server_mafia_receipts where user_id=u order by created_at limit 1;
  perform pg_temp.m_assert(public.server_mafia_read(u,old_receipt.action_id,old_receipt.request)->'receipt'=old_receipt.response,'old entry receipt survives later moves');
  perform pg_temp.m_assert(public.server_mafia_read(other_uid,old_receipt.action_id,old_receipt.request)->'receipt' is null,'receipts scoped to owner');
  perform pg_temp.m_reject(format('select public.server_mafia_read(%L,%L,%L)',u,old_receipt.action_id,old_receipt.request||'{"changed":true}'),'22023','read also rejects reused request ID');
end $$;
do $$
declare u uuid:=(select uid from pg_temp.mafia_fixture where label='free');t uuid:=gen_random_uuid();s jsonb;rev bigint;
begin
  perform pg_temp.m_commit(u,0,gen_random_uuid(),pg_temp.m_state(t,'active',0),'start');
  perform pg_temp.m_step(u,'night',0);
  s:=jsonb_set(jsonb_set(jsonb_set(pg_temp.m_state(t,'observerWin',0),'{players,0,alive}','false'),'{players,1,alive}','false'),'{players,2,alive}','false');
  perform pg_temp.m_reject(format('select pg_temp.m_commit(%L,2,%L,%L,%L,%L)',u,gen_random_uuid(),jsonb_set(s,'{economy,xp}','130'),'action','finish'),'22023','free practice earns no XP');
  perform pg_temp.m_commit(u,2,gen_random_uuid(),s,'action','finish');
  perform pg_temp.m_assert(not exists(select 1 from vezdehot_private.server_wallets where user_id=u),'free win never initializes wallet');
  t:=gen_random_uuid();perform pg_temp.m_commit(u,3,gen_random_uuid(),pg_temp.m_state(t,'active',0),'start');
  perform pg_temp.m_reject(format('select pg_temp.m_commit(%L,4,%L,%L)',u,gen_random_uuid(),pg_temp.m_state(t,'active',100)),'22023','free cannot become paid');
end $$;

-- The same living-team calculation must also work when the human is mafia.
do $$
declare u uuid:=(select uid from pg_temp.mafia_fixture where label='mafia');t uuid:=gen_random_uuid();s jsonb;w jsonb;before jsonb;rev bigint;
begin
  s:=jsonb_set(jsonb_set(pg_temp.m_state(t),'{players,0,role}','"mafia"'),'{players,1,role}','"civilian"');
  perform pg_temp.m_commit(u,0,gen_random_uuid(),s,'start');
  before:=public.server_wallet_read(u);
  perform pg_temp.m_commit(u,1,gen_random_uuid(),s||'{"personalMarks":{"1":"suspect"}}','action','mark');
  perform pg_temp.m_assert(public.server_wallet_read(u)-'serverTime'=before-'serverTime','personal notes change no wallet totals or revision');
  perform pg_temp.m_reject(format('select pg_temp.m_commit(%L,2,%L,%L,%L,%L)',u,gen_random_uuid(),jsonb_set(s,'{win}','true'),'action','mark'),'22023','active win flag is invalid');
  perform pg_temp.m_reject(format('select pg_temp.m_commit(%L,2,%L,%L,%L,%L)',u,gen_random_uuid(),jsonb_set(s,'{phase}','"vote"'),'action','continue'),'22023','cannot skip night to voting');
  perform pg_temp.m_reject(format('select pg_temp.m_commit(%L,2,%L,%L,%L,%L)',u,gen_random_uuid(),jsonb_set(jsonb_set(s,'{phase}','"dawn"'),'{players,2,alive}','false'),'action','night'),'22023','night cannot eliminate mafia');
  s:=pg_temp.m_step(u,'night',6);
  perform pg_temp.m_reject(format('select pg_temp.m_commit(%L,3,%L,%L,%L,%L)',u,gen_random_uuid(),jsonb_set(jsonb_set(s,'{phase}','"day"'),'{players,6,alive}','true'),'action','continue'),'22023','cannot resurrect an eliminated player');
  perform pg_temp.m_step(u,'continue');perform pg_temp.m_step(u,'continue');perform pg_temp.m_step(u,'vote',5);perform pg_temp.m_step(u,'continue');
  s:=public.server_mafia_read(u);rev:=(s->>'revision')::bigint;s:=s->'state';
  s:=jsonb_set(s,'{players,4,alive}','false')||'{"phase":"result","over":true,"settled":true,"win":true,"winningTeam":"mafia","economy":{"version":1,"stake":100,"settled":true,"payout":250,"xp":130,"outcome":"win"}}';
  perform pg_temp.m_commit(u,rev,gen_random_uuid(),s,'action','night');
  w:=public.server_wallet_read(u);
  perform pg_temp.m_assert(w->'balance'='1150' and w->'xp'='130' and w->'games'='1' and w->'wins'='1','mafia human receives winning-team reward');
  before:=w;t:=gen_random_uuid();perform pg_temp.m_commit(u,rev+1,gen_random_uuid(),pg_temp.m_state(t,'active',0),'start');
  perform pg_temp.m_commit(u,rev+2,gen_random_uuid(),pg_temp.m_state(t,'resigned',0),'action','resign');
  perform pg_temp.m_assert(public.server_wallet_read(u)-'serverTime'=before-'serverTime','free game changes no existing wallet or stats');
end $$;
-- The public receipt must describe the same result and exact economy metadata.
do $$
declare u uuid:=(select uid from pg_temp.mafia_fixture where label='bad');t uuid:=gen_random_uuid();aid uuid:=gen_random_uuid();s jsonb;
  req jsonb; response jsonb;
begin
  s:=pg_temp.m_state(t);req:=jsonb_build_object('op','start','actionId',aid,'expectedRevision',0,'difficulty','normal','stake',100);
  response:=jsonb_build_object('status','saved','revision',1,'game',jsonb_build_object('id',t,'economy',s->'economy','over',false,'phase','night','winningTeam',null,'win',false,'draw',false,'resigned',false));
  perform pg_temp.m_reject(format('select public.server_mafia_commit(%L,0,%L,%L,%L,%L)',u,aid,req,s,jsonb_set(response,'{game,economy,stake}','0')),'22023','public stake cannot differ');
  perform pg_temp.m_reject(format('select public.server_mafia_commit(%L,0,%L,%L,%L,%L)',u,aid,req,s,jsonb_set(response,'{game,win}','true')),'22023','public result cannot differ');
  perform pg_temp.m_reject(format('select public.server_mafia_commit(%L,0,%L,%L,%L,%L)',u,aid,req,s,jsonb_set(response,'{game,over}','true')),'22023','public completion cannot differ');
  perform pg_temp.m_reject(format('select public.server_mafia_commit(%L,0,%L,%L,%L,%L)',u,aid,req,jsonb_set(s,'{economy}',s->'economy'||'{"extra":1}'),response),'22023','unknown economy fields rejected');
  perform pg_temp.m_assert(not exists(select 1 from vezdehot_private.server_wallets where user_id=u),'invalid projections never initialize wallet');
end $$;
-- A receipt failure rolls back the game, debit AND first welcome grant.
do $$
declare u uuid:=(select uid from pg_temp.mafia_fixture where label='rollback');s jsonb:=pg_temp.m_state(gen_random_uuid());
begin
  perform pg_temp.m_reject(format('select pg_temp.m_commit(%L,0,%L,%L,%L,%L,%L)',u,gen_random_uuid(),s,'start','continue','{"failReceipt":true}'),'P0001','injected receipt failure');
  perform pg_temp.m_assert(not exists(select 1 from vezdehot_private.server_wallets where user_id=u),'failed receipt rolls back welcome');
  perform pg_temp.m_assert(not exists(select 1 from vezdehot_private.server_mafia_games where user_id=u),'failed receipt rolls back game');
  perform pg_temp.m_assert(not exists(select 1 from vezdehot_private.server_mafia_receipts where user_id=u),'failed receipt absent');
  perform pg_temp.m_reject(format('select pg_temp.m_commit(%L,0,%L,%L,%L,%L,%L)',u,gen_random_uuid(),s,'start','continue','{"expectedRevision":8}'),'22023','envelope revision bound');
  perform pg_temp.m_reject(format('select pg_temp.m_commit(%L,0,%L,%L,%L,%L,%L)',u,gen_random_uuid(),s,'start','continue',jsonb_build_object('actionId',gen_random_uuid())),'22023','envelope UUID bound');
end $$;
-- Insufficient funds leaves the previous table and receipts unchanged.
select public.server_wallet_read((select uid from pg_temp.mafia_fixture where label='empty'));
reset role;
update vezdehot_private.server_wallets set balance=99 where user_id=(select uid from pg_temp.mafia_fixture where label='empty');
set local role service_role;
do $$
declare u uuid:=(select uid from pg_temp.mafia_fixture where label='empty');s jsonb:=pg_temp.m_state(gen_random_uuid());
begin
  perform pg_temp.m_reject(format('select pg_temp.m_commit(%L,0,%L,%L,%L)',u,gen_random_uuid(),s,'start'),'P0001','insufficient funds');
  perform pg_temp.m_assert(public.server_mafia_read(u)->'revision'='0','no table after declined entry');
  perform pg_temp.m_assert((public.server_wallet_read(u))->'balance'='99','declined balance unchanged');
  perform pg_temp.m_assert(not exists(select 1 from vezdehot_private.server_mafia_receipts where user_id=u),'no receipt after declined entry');
end $$;
reset role;
rollback;
