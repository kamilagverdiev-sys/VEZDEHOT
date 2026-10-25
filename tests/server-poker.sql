-- Run in one isolated PostgreSQL session after server_poker_actions migration,
-- as postgres, with stop-on-error. Fixture users and triggers are rolled back.
begin;
set local statement_timeout = '30s';
set local lock_timeout = '5s';

create temporary table vh_poker_fixtures (
  label text primary key, uid uuid default gen_random_uuid(),
  game_id uuid default gen_random_uuid(), replacement_id uuid default gen_random_uuid(),
  first_action uuid default gen_random_uuid(), second_action uuid default gen_random_uuid(),
  third_action uuid default gen_random_uuid(),
  stale_action uuid default gen_random_uuid(), failed_action uuid default gen_random_uuid(),
  request_one jsonb, request_two jsonb, state_one jsonb, state_two jsonb,
  response_one jsonb, response_two jsonb
) on commit drop;
insert into vh_poker_fixtures(label) values ('a'), ('b');
update vh_poker_fixtures set
  request_one = jsonb_build_object('op', 'start', 'expectedRevision', 0, 'actionId', first_action, 'difficulty', 'normal'),
  request_two = jsonb_build_object('op', 'action', 'expectedRevision', 1, 'actionId', second_action, 'gameId', game_id, 'action', jsonb_build_object('type', 'call')),
  state_one = jsonb_build_object('id', game_id, 'deck', jsonb_build_array('SECRET'), 'phase', 'betting'),
  state_two = jsonb_build_object('id', game_id, 'deck', jsonb_build_array('SECRET'), 'phase', 'review'),
  response_one = jsonb_build_object('status', 'saved', 'revision', 1, 'game', jsonb_build_object('id', game_id, 'phase', 'betting')),
  response_two = jsonb_build_object('status', 'saved', 'revision', 2, 'game', jsonb_build_object('id', game_id, 'phase', 'review'));
grant select on vh_poker_fixtures to service_role, authenticated, anon;
insert into auth.users(id, instance_id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, is_anonymous, created_at, updated_at)
select uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'server-poker-' || uid::text || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, false, now(), now()
from vh_poker_fixtures;

create function pg_temp.vh_assert(value boolean, description text)
returns void language plpgsql security invoker as $$
begin
  if value is distinct from true then raise exception 'Server Poker test failed: %', description; end if;
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
create function pg_temp.vh_poker_fail_receipt() returns trigger
language plpgsql security invoker as $$
begin
  if new.action_id = (select failed_action from pg_temp.vh_poker_fixtures where label = 'a') then
    raise exception 'Injected receipt failure' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger vh_poker_fail_receipt before insert on vezdehot_private.server_poker_receipts
  for each row execute function pg_temp.vh_poker_fail_receipt();

set local role service_role;
do $$
declare a record; b record; result jsonb; replacement_request jsonb; replacement_state jsonb; replacement_response jsonb;
begin
  select * into a from pg_temp.vh_poker_fixtures where label = 'a';
  select * into b from pg_temp.vh_poker_fixtures where label = 'b';
  perform pg_temp.vh_assert(public.server_poker_read(a.uid) = '{"revision":0,"state":null}', 'new player has revision zero');
  perform pg_temp.vh_rejected(format('select public.server_poker_read(%L, null, %L)', a.uid, '{}'), '22023', 'request must have action ID');
  perform pg_temp.vh_rejected(format('select public.server_poker_read(%L, %L, null)', a.uid, a.first_action), '22023', 'action ID must have request');
  perform pg_temp.vh_rejected('select public.server_poker_read(null)', '22023', 'null user rejected');
  perform pg_temp.vh_rejected(format('select public.server_poker_read(%L, %L, %L)', a.uid, a.first_action, '[]'), '22023', 'request must be object');
  perform pg_temp.vh_rejected(format('select public.server_poker_read(%L, %L, %L)', a.uid, a.first_action, jsonb_build_object('large', repeat('x', 4096))), '22023', 'oversized request rejected');

  result := public.server_poker_commit(a.uid, 0, a.first_action, a.request_one, a.state_one, a.response_one);
  perform pg_temp.vh_assert(result = jsonb_build_object('receipt', a.response_one), 'first commit returns only public receipt');
  perform pg_temp.vh_assert(result::text not like '%SECRET%', 'private state absent in commit response');
  perform pg_temp.vh_assert((public.server_poker_read(a.uid)->>'revision')::bigint = 1, 'first revision persists');
  perform pg_temp.vh_assert(public.server_poker_read(a.uid, a.first_action, a.request_one)->'receipt' = a.response_one, 'receipt found before recomputing action');
  perform pg_temp.vh_assert(public.server_poker_commit(a.uid, 0, a.first_action, a.request_one, null, null)->'receipt' = a.response_one, 'replay ignores newly computed candidate');
  perform pg_temp.vh_rejected(format('select public.server_poker_read(%L, %L, %L)', a.uid, a.first_action, a.request_one || '{"difficulty":"hard"}'), '22023', 'read rejects reused ID with different body');
  perform pg_temp.vh_rejected(format('select public.server_poker_commit(%L, 0, %L, %L, %L, %L)', a.uid, a.first_action, a.request_two, a.state_one, a.response_one), '22023', 'commit rejects reused ID with different body');

  result := public.server_poker_commit(a.uid, 1, a.second_action, a.request_two, a.state_two, a.response_two);
  perform pg_temp.vh_assert(result->'receipt' = a.response_two, 'second action increments revision');
  perform pg_temp.vh_assert(public.server_poker_commit(a.uid, 0, a.first_action, a.request_one, null, null)->'receipt' = a.response_one, 'old retry returns original response after later commit');
  result := public.server_poker_read(a.uid, a.first_action, a.request_one);
  perform pg_temp.vh_assert(result->'revision' = '2'::jsonb and result->'receipt' = a.response_one, 'receipt lookup retains current state revision separately');
  result := public.server_poker_commit(a.uid, 1, a.stale_action, a.request_two, a.state_two, a.response_two);
  perform pg_temp.vh_assert(result->'conflict' = 'true'::jsonb and result->'revision' = '2'::jsonb and result->'state' = a.state_two, 'stale CAS returns current private state only to service');
  perform pg_temp.vh_assert(not exists(select 1 from vezdehot_private.server_poker_receipts where user_id = a.uid and action_id = a.stale_action), 'conflict creates no success receipt');
  perform pg_temp.vh_assert(public.server_poker_read(b.uid, a.first_action, a.request_one) = '{"revision":0,"state":null}', 'different player cannot see receipt or state');
  perform pg_temp.vh_assert(public.server_poker_commit(b.uid, 0, a.first_action, a.request_one, b.state_one, b.response_one)->'receipt' = b.response_one, 'action IDs are scoped to owner');
  perform pg_temp.vh_assert(public.server_poker_read(a.uid)->'state' = a.state_two, 'other player commit cannot replace first player state');

  perform pg_temp.vh_rejected(format('select public.server_poker_commit(%L, -1, %L, %L, %L, %L)', a.uid, a.stale_action, '{}', a.state_two, a.response_two), '22023', 'negative revision rejected');
  perform pg_temp.vh_rejected(format('select public.server_poker_commit(%L, 9007199254740991, %L, %L, %L, %L)', a.uid, a.stale_action, '{}', a.state_two, a.response_two), '22023', 'unsafe next JS revision rejected');
  perform pg_temp.vh_rejected(format('select public.server_poker_commit(%L, 2, %L, %L, %L, %L)', a.uid, a.stale_action, '{}', a.state_two, a.response_two), '22023', 'receipt revision must equal next revision');
  perform pg_temp.vh_rejected(format('select public.server_poker_commit(%L, 2, %L, %L, %L, %L)', a.uid, a.stale_action, '{}', a.state_two, '{"status":"saved","revision":3,"game":{"id":"another-table"}}'), '22023', 'receipt and state table IDs agree');
  perform pg_temp.vh_rejected(format('select public.server_poker_commit(%L, 2, %L, %L, %L, %L)', a.uid, a.stale_action, '{}', a.state_two, a.response_two || '{"status":"conflict","revision":3}'), '22023', 'only saved receipt allowed');
  perform pg_temp.vh_rejected(format('select public.server_poker_commit(%L, 2, %L, %L, %L, %L)', a.uid, a.stale_action, '{}', a.state_two || jsonb_build_object('large', repeat('x', 65536)), a.response_two || '{"revision":3}'), '22023', 'oversized state rejected');
  perform pg_temp.vh_rejected(format('select public.server_poker_commit(%L, 2, %L, %L, %L, %L)', a.uid, a.stale_action, '{}', a.state_two, a.response_two || jsonb_build_object('revision', 3, 'large', repeat('x', 65536))), '22023', 'oversized receipt rejected');
  perform pg_temp.vh_rejected(format('select public.server_poker_commit(%L, 2, %L, %L, %L, %L)', a.uid, a.stale_action, jsonb_build_object('large', repeat('x', 4096)), a.state_two, a.response_two || '{"revision":3}'), '22023', 'oversized commit request rejected');
  perform pg_temp.vh_rejected(format('select public.server_poker_commit(%L, 2, %L, %L, %L, %L)', a.uid, a.stale_action, '{}', 'null', a.response_two || '{"revision":3}'), '22023', 'JSON null state rejected');
  perform pg_temp.vh_rejected(format('select public.server_poker_commit(%L, 2, %L, %L, %L, %L)', a.uid, a.stale_action, '{}', a.state_two, 'null'), '22023', 'JSON null receipt rejected');
  perform pg_temp.vh_rejected(format('select public.server_poker_commit(%L, 2, %L, %L, %L, %L)', a.uid, a.stale_action, 'null', a.state_two, a.response_two || '{"revision":3}'), '22023', 'JSON null request rejected');
  perform pg_temp.vh_rejected(format('select public.server_poker_commit(%L, 2, %L, %L, %L, %L)', a.uid, a.failed_action, '{}', a.state_one, a.response_one || '{"revision":3}'), 'P0001', 'receipt insertion failure raised');
  result := public.server_poker_read(a.uid);
  perform pg_temp.vh_assert(result->'revision' = '2'::jsonb and result->'state' = a.state_two, 'failed receipt rolls back game update');
  perform pg_temp.vh_assert((select count(*) = 2 from vezdehot_private.server_poker_receipts where user_id = a.uid), 'only two successful receipts persist');

  -- Storage accepts opaque server-validated tables. Starting a replacement is
  -- gated by the Edge engine; here we verify revision/receipt continuity only.
  replacement_request := jsonb_build_object('op', 'start', 'expectedRevision', 2, 'actionId', a.third_action, 'difficulty', 'hard');
  replacement_state := a.state_one || jsonb_build_object('id', a.replacement_id);
  replacement_response := jsonb_build_object('status', 'saved', 'revision', 3, 'game', jsonb_build_object('id', a.replacement_id, 'phase', 'betting'));
  result := public.server_poker_commit(a.uid, 2, a.third_action, replacement_request, replacement_state, replacement_response);
  perform pg_temp.vh_assert(result->'receipt' = replacement_response, 'new table continues account revision');
  perform pg_temp.vh_assert(public.server_poker_read(a.uid)->'revision' = '3'::jsonb, 'new table never resets revision');
  perform pg_temp.vh_assert(public.server_poker_commit(a.uid, 0, a.first_action, a.request_one, null, null)->'receipt' = a.response_one, 'old table receipt survives replacement');
  perform pg_temp.vh_assert(public.server_poker_read(a.uid)->'state' = replacement_state, 'old table retry cannot roll back replacement');
  perform pg_temp.vh_rejected(format('delete from vezdehot_private.server_poker_receipts where user_id = %L', a.uid), '42501', 'service cannot delete permanent receipts');
  perform pg_temp.vh_rejected(format('update vezdehot_private.server_poker_receipts set response = %L where user_id = %L', '{}', a.uid), '42501', 'service cannot rewrite permanent receipts');
end;
$$;

set local role authenticated;
select pg_temp.vh_rejected('select public.server_poker_read(null)', '42501', 'authenticated cannot read private server state');
select pg_temp.vh_rejected('select public.server_poker_commit(null, 0, null, null, null, null)', '42501', 'authenticated cannot write server state');
select pg_temp.vh_rejected('select * from vezdehot_private.server_poker_games', '42501', 'authenticated cannot read raw tables');
select pg_temp.vh_rejected('select * from vezdehot_private.server_poker_receipts', '42501', 'authenticated cannot read receipts');
select pg_temp.vh_rejected('update vezdehot_private.server_poker_games set revision = 99', '42501', 'authenticated cannot alter table revisions');
select pg_temp.vh_rejected('delete from vezdehot_private.server_poker_receipts', '42501', 'authenticated cannot delete receipts');
set local role anon;
select pg_temp.vh_rejected('select public.server_poker_read(null)', '42501', 'anon cannot read private server state');
select pg_temp.vh_rejected('select public.server_poker_commit(null, 0, null, null, null, null)', '42501', 'anon cannot write server state');
select pg_temp.vh_rejected('select * from vezdehot_private.server_poker_games', '42501', 'anon cannot read raw tables');
select pg_temp.vh_rejected('select * from vezdehot_private.server_poker_receipts', '42501', 'anon cannot read receipts');
reset role;
select pg_temp.vh_assert((select bool_and(relrowsecurity) from pg_class where oid in ('vezdehot_private.server_poker_games'::regclass, 'vezdehot_private.server_poker_receipts'::regclass)), 'both private tables have RLS');
select pg_temp.vh_assert(not has_function_privilege('authenticated', 'public.server_poker_read(uuid,uuid,jsonb)', 'execute') and not has_function_privilege('anon', 'public.server_poker_commit(uuid,bigint,uuid,jsonb,jsonb,jsonb)', 'execute'), 'RPC ACLs closed to client roles');
do $$ begin raise notice 'server-poker.sql: all assertions passed; rolling back fixtures'; end; $$;
rollback;
