-- Run in one isolated PostgreSQL session after server_durak_actions migration,
-- as postgres, with stop-on-error. Fixture users and triggers are rolled back.
begin;
set local statement_timeout = '30s';
set local lock_timeout = '5s';

create temporary table vh_durak_fixtures (
  label text primary key, uid uuid default gen_random_uuid(),
  first_action uuid default gen_random_uuid(), second_action uuid default gen_random_uuid(),
  stale_action uuid default gen_random_uuid(), failed_action uuid default gen_random_uuid(),
  request_one jsonb, request_two jsonb, state_one jsonb, state_two jsonb,
  response_one jsonb, response_two jsonb
) on commit drop;
insert into vh_durak_fixtures(label) values ('a'), ('b');
update vh_durak_fixtures set
  request_one = jsonb_build_object('action', 'create', 'expectedRevision', 0, 'actionId', first_action),
  request_two = jsonb_build_object('action', 'attack', 'expectedRevision', 1, 'actionId', second_action, 'gameId', 'server-fixture', 'cardId', '6♠'),
  state_one = '{"id":"server-fixture","deck":["SECRET"],"phase":"attack"}',
  state_two = '{"id":"server-fixture","deck":["SECRET"],"phase":"defend"}',
  response_one = '{"status":"saved","revision":1,"game":{"id":"server-fixture","deckCount":24}}',
  response_two = '{"status":"saved","revision":2,"game":{"id":"server-fixture","deckCount":24,"phase":"defend"}}';
grant select on vh_durak_fixtures to service_role, authenticated, anon;
insert into auth.users(id, instance_id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, is_anonymous, created_at, updated_at)
select uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'server-durak-' || uid::text || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, false, now(), now()
from vh_durak_fixtures;

create function pg_temp.vh_assert(value boolean, description text)
returns void language plpgsql security invoker as $$
begin
  if value is distinct from true then raise exception 'Server Durak test failed: %', description; end if;
end;
$$;
create function pg_temp.vh_rejected(command text, expected_code text, description text)
returns void language plpgsql security invoker as $$
declare actual_code text;
begin
  begin execute command;
  exception when others then actual_code := sqlstate;
  end;
  perform pg_temp.vh_assert(actual_code = expected_code,
    description || ' (expected ' || expected_code || ', got ' || coalesce(actual_code, 'success') || ')');
end;
$$;

-- Inject a failure after the game upsert, at the receipt write. The exception
-- must roll back BOTH statements, not leave a state without its retry receipt.
create function pg_temp.vh_durak_fail_receipt() returns trigger
language plpgsql security invoker as $$
begin
  if new.action_id = (select failed_action from pg_temp.vh_durak_fixtures where label = 'a') then
    raise exception 'Injected receipt failure' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger vh_durak_fail_receipt before insert on vezdehot_private.server_durak_receipts
  for each row execute function pg_temp.vh_durak_fail_receipt();

set local role service_role;
do $$
declare a record; b record; result jsonb;
begin
  select * into a from pg_temp.vh_durak_fixtures where label = 'a';
  select * into b from pg_temp.vh_durak_fixtures where label = 'b';
  perform pg_temp.vh_assert(public.server_durak_read(a.uid) = '{"revision":0,"state":null}', 'new player has revision zero');
  perform pg_temp.vh_rejected(format('select public.server_durak_read(%L, null, %L)', a.uid, '{}'), '22023', 'request must have action ID');
  perform pg_temp.vh_rejected(format('select public.server_durak_read(%L, %L, null)', a.uid, a.first_action), '22023', 'action ID must have request');
  perform pg_temp.vh_rejected('select public.server_durak_read(null)', '22023', 'null user rejected');
  perform pg_temp.vh_rejected(format('select public.server_durak_read(%L, %L, %L)', a.uid, a.first_action, '[]'), '22023', 'request must be object');
  perform pg_temp.vh_rejected(format('select public.server_durak_read(%L, %L, %L)', a.uid, a.first_action, jsonb_build_object('large', repeat('x', 4096))), '22023', 'oversized request rejected');

  result := public.server_durak_commit(a.uid, 0, a.first_action, a.request_one, a.state_one, a.response_one);
  perform pg_temp.vh_assert(result = jsonb_build_object('receipt', a.response_one), 'first commit returns only public receipt');
  perform pg_temp.vh_assert(result::text not like '%SECRET%', 'private state absent in commit response');
  perform pg_temp.vh_assert((public.server_durak_read(a.uid)->>'revision')::bigint = 1, 'first revision persists');
  perform pg_temp.vh_assert(public.server_durak_read(a.uid, a.first_action, a.request_one)->'receipt' = a.response_one, 'receipt found before recomputing action');
  perform pg_temp.vh_assert(public.server_durak_commit(a.uid, 0, a.first_action, a.request_one, null, null)->'receipt' = a.response_one, 'replay ignores newly computed candidate');
  perform pg_temp.vh_rejected(format('select public.server_durak_read(%L, %L, %L)', a.uid, a.first_action, a.request_one || '{"cardId":"A♠"}'), '22023', 'read rejects reused ID with different body');
  perform pg_temp.vh_rejected(format('select public.server_durak_commit(%L, 0, %L, %L, %L, %L)', a.uid, a.first_action, a.request_two, a.state_one, a.response_one), '22023', 'commit rejects reused ID with different body');

  result := public.server_durak_commit(a.uid, 1, a.second_action, a.request_two, a.state_two, a.response_two);
  perform pg_temp.vh_assert(result->'receipt' = a.response_two, 'second action increments revision');
  perform pg_temp.vh_assert(public.server_durak_commit(a.uid, 0, a.first_action, a.request_one, null, null)->'receipt' = a.response_one, 'old retry returns original response after later commit');
  result := public.server_durak_read(a.uid, a.first_action, a.request_one);
  perform pg_temp.vh_assert(result->'revision' = '2'::jsonb and result->'receipt' = a.response_one, 'receipt lookup retains current state revision separately');
  result := public.server_durak_commit(a.uid, 1, a.stale_action, a.request_two, a.state_two, a.response_two);
  perform pg_temp.vh_assert(result->'conflict' = 'true'::jsonb and result->'revision' = '2'::jsonb and result->'state' = a.state_two, 'stale CAS returns current private state only to service');
  perform pg_temp.vh_assert(not exists(select 1 from vezdehot_private.server_durak_receipts where user_id = a.uid and action_id = a.stale_action), 'conflict creates no success receipt');
  perform pg_temp.vh_assert(public.server_durak_read(b.uid, a.first_action, a.request_one) = '{"revision":0,"state":null}', 'different player cannot see receipt or state');
  perform pg_temp.vh_assert(public.server_durak_commit(b.uid, 0, a.first_action, a.request_one, b.state_one, b.response_one)->'receipt' = b.response_one, 'action IDs are scoped to owner');

  perform pg_temp.vh_rejected(format('select public.server_durak_commit(%L, -1, %L, %L, %L, %L)', a.uid, a.stale_action, '{}', a.state_two, a.response_two), '22023', 'negative revision rejected');
  perform pg_temp.vh_rejected(format('select public.server_durak_commit(%L, 9007199254740991, %L, %L, %L, %L)', a.uid, a.stale_action, '{}', a.state_two, a.response_two), '22023', 'unsafe next JS revision rejected');
  perform pg_temp.vh_rejected(format('select public.server_durak_commit(%L, 2, %L, %L, %L, %L)', a.uid, a.stale_action, '{}', a.state_two, a.response_two), '22023', 'receipt revision must equal next revision');
  perform pg_temp.vh_rejected(format('select public.server_durak_commit(%L, 2, %L, %L, %L, %L)', a.uid, a.stale_action, '{}', a.state_two, '{"status":"saved","revision":3,"game":{"id":"another-table"}}'), '22023', 'receipt and state table IDs agree');
  perform pg_temp.vh_rejected(format('select public.server_durak_commit(%L, 2, %L, %L, %L, %L)', a.uid, a.stale_action, '{}', a.state_two, '{"status":"conflict","revision":3,"game":{"id":"server-fixture"}}'), '22023', 'only saved receipt allowed');
  perform pg_temp.vh_rejected(format('select public.server_durak_commit(%L, 2, %L, %L, %L, %L)', a.uid, a.stale_action, '{}', jsonb_build_object('id', 'server-fixture', 'large', repeat('x', 65536)), '{"status":"saved","revision":3,"game":{"id":"server-fixture"}}'), '22023', 'oversized state rejected');
  perform pg_temp.vh_rejected(format('select public.server_durak_commit(%L, 2, %L, %L, %L, %L)', a.uid, a.failed_action, '{}', a.state_one, '{"status":"saved","revision":3,"game":{"id":"server-fixture"}}'), 'P0001', 'receipt insertion failure raised');
  result := public.server_durak_read(a.uid);
  perform pg_temp.vh_assert(result->'revision' = '2'::jsonb and result->'state' = a.state_two, 'failed receipt rolls back game update');
  perform pg_temp.vh_assert((select count(*) = 2 from vezdehot_private.server_durak_receipts where user_id = a.uid), 'only two successful receipts persist');
end;
$$;

set local role authenticated;
select pg_temp.vh_rejected('select public.server_durak_read(null)', '42501', 'authenticated cannot read private server state');
select pg_temp.vh_rejected('select public.server_durak_commit(null, 0, null, null, null, null)', '42501', 'authenticated cannot write server state');
select pg_temp.vh_rejected('select * from vezdehot_private.server_durak_games', '42501', 'authenticated cannot read raw tables');
select pg_temp.vh_rejected('select * from vezdehot_private.server_durak_receipts', '42501', 'authenticated cannot read receipts');
set local role anon;
select pg_temp.vh_rejected('select public.server_durak_read(null)', '42501', 'anon cannot read private server state');
select pg_temp.vh_rejected('select public.server_durak_commit(null, 0, null, null, null, null)', '42501', 'anon cannot write server state');
select pg_temp.vh_rejected('select * from vezdehot_private.server_durak_games', '42501', 'anon cannot read raw tables');
reset role;
select pg_temp.vh_assert((select bool_and(relrowsecurity) from pg_class where oid in ('vezdehot_private.server_durak_games'::regclass, 'vezdehot_private.server_durak_receipts'::regclass)), 'both private tables have RLS');
select pg_temp.vh_assert(not has_function_privilege('authenticated', 'public.server_durak_read(uuid,uuid,jsonb)', 'execute') and not has_function_privilege('anon', 'public.server_durak_commit(uuid,bigint,uuid,jsonb,jsonb,jsonb)', 'execute'), 'RPC ACLs closed to client roles');
do $$ begin raise notice 'server-durak.sql: all assertions passed; rolling back fixtures'; end; $$;
rollback;
