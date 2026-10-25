-- Functional/security tests for the account-checkpoint RPCs.
-- Run in an isolated test database as postgres after the checkpoint migration,
-- in one connection, with
-- stop-on-error enabled (for psql: -v ON_ERROR_STOP=1 -f this-file.sql).
-- No pgTAP dependency. All fixture users, data and helpers are rolled back.
-- Do not run individual statements outside the BEGIN/ROLLBACK wrapper.

begin;
set local statement_timeout = '30s';
set local lock_timeout = '5s';

create temporary table vh_checkpoint_fixtures (
  label text primary key,
  user_id uuid not null unique default gen_random_uuid(),
  mutation_one uuid not null default gen_random_uuid(),
  mutation_two uuid not null default gen_random_uuid(),
  mutation_stale uuid not null default gen_random_uuid(),
  mutation_duplicate uuid not null default gen_random_uuid(),
  mutation_invalid uuid not null default gen_random_uuid(),
  mutation_dml_failure uuid not null default gen_random_uuid(),
  snapshot_one jsonb,
  snapshot_two jsonb,
  result_one jsonb,
  response_one jsonb
) on commit drop;
insert into vh_checkpoint_fixtures(label) values ('a'), ('b'), ('anonymous');
grant select, update on vh_checkpoint_fixtures to authenticated;
grant select on vh_checkpoint_fixtures to anon;

-- Random UUIDs and reserved .invalid addresses never reuse application users.
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, is_anonymous, created_at, updated_at
)
select user_id, '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated',
  'checkpoint-test-' || user_id::text || '@example.invalid', '',
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  label = 'anonymous', now(), now()
from vh_checkpoint_fixtures;

-- A represents an existing account without a checkpoint. Its oldest result is
-- deliberately outside the 30 visible history rows, but must remain dedupable.
insert into public.profiles(id, nickname, balance, xp, wins, games, preferences)
select user_id, 'Legacy A', 10000, 40, 1, 35,
  '{"avatar":"✦","durakPace":"calm","reduceMotion":false,"bonusAt":0}'::jsonb
from vh_checkpoint_fixtures where label = 'a'
on conflict(id) do update set nickname = excluded.nickname,
  balance = excluded.balance, xp = excluded.xp, wins = excluded.wins,
  games = excluded.games, preferences = excluded.preferences;
insert into public.player_results(user_id, id, game, win, delta, xp, played_at)
select user_id, 'legacy-old', 'durak', true, 250, 40, '2020-01-01T00:00:00Z'
from vh_checkpoint_fixtures where label = 'a';
insert into public.player_results(user_id, id, game, win, delta, xp, played_at)
select f.user_id, 'legacy-recent-' || n, 'mafia', false, 0, 0,
  now() - n * interval '1 minute'
from vh_checkpoint_fixtures f cross join generate_series(1, 34) n
where f.label = 'a';

create function pg_temp.check_true(value boolean, description text)
returns void language plpgsql security invoker as $$
begin
  if value is distinct from true then
    raise exception 'Checkpoint test failed: %', description;
  end if;
end;
$$;

-- These helpers remain SECURITY INVOKER: every RPC and table operation below
-- executes under the actual SET LOCAL ROLE, never a postgres definer helper.
create function pg_temp.use_actor(actor text, anonymous_claim boolean default false)
returns void language plpgsql security invoker as $$
declare actor_id uuid;
begin
  select user_id into strict actor_id from pg_temp.vh_checkpoint_fixtures where label = actor;
  perform set_config('request.jwt.claim.sub', actor_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', actor_id, 'role', 'authenticated', 'is_anonymous', anonymous_claim
  )::text, true);
end;
$$;

create function pg_temp.expect_rejected(command text, expected_code text, description text)
returns void language plpgsql security invoker as $$
declare actual_code text;
begin
  begin
    execute command;
  exception when others then
    actual_code := sqlstate;
  end;
  perform pg_temp.check_true(actual_code = expected_code,
    description || ' (expected SQLSTATE ' || expected_code || ', got ' || coalesce(actual_code, 'success') || ')');
end;
$$;

-- Failure injection is restricted to this transaction's random A fixture.
-- The temporary function and trigger are removed by the final ROLLBACK.
-- This runs after the RPC inserts results, proving rollback after real DML.
create function pg_temp.reject_checkpoint_fixture_profile()
returns trigger language plpgsql security invoker as $$
begin
  if new.nickname = 'RejectFixture' and new.id = (
    select user_id from pg_temp.vh_checkpoint_fixtures where label = 'a'
  ) then
    raise exception 'Deliberate fixture-only profile rejection' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger vh_checkpoint_test_reject_fixture_profile
before insert or update on public.profiles
for each row execute function pg_temp.reject_checkpoint_fixture_profile();

set local role authenticated;
select pg_temp.use_actor('a');

do $$
declare f record; loaded jsonb; snapshot jsonb; result jsonb; response jsonb;
begin
  select * into strict f from pg_temp.vh_checkpoint_fixtures where label = 'a';
  perform pg_temp.check_true(current_user = 'authenticated' and auth.uid() = f.user_id,
    'tests use the authenticated SQL role and fixture JWT sub');
  loaded := public.load_player_checkpoint(array['legacy-old', 'does-not-exist']);
  perform pg_temp.check_true(loaded->>'status' = 'ok' and (loaded->>'revision')::bigint = 0,
    'legacy account loads at revision zero');
  perform pg_temp.check_true(loaded ? 'updatedAt' and
    (loaded->>'updatedAt' is null or (loaded->>'updatedAt')::timestamptz is not null),
    'legacy timestamp is null or parseable');
  snapshot := loaded->'snapshot';
  perform pg_temp.check_true(snapshot->>'format' = 'vezdehot-account-checkpoint'
    and snapshot->>'version' = '1' and snapshot#>>'{profile,nick}' = 'Legacy A'
    and (snapshot#>>'{profile,balance}')::integer = 10000,
    'legacy profile is preserved in the checkpoint format');
  perform pg_temp.check_true(snapshot->'games' =
    '{"durak":null,"bunker":null,"poker":null,"mafia":null,"monopoly":null}'::jsonb,
    'legacy load has all five empty game slots');
  perform pg_temp.check_true(jsonb_array_length(snapshot#>'{profile,history}') = 30
    and not (snapshot#>'{profile,history}') @> '[{"id":"legacy-old"}]'::jsonb,
    'visible history keeps the latest 30');
  perform pg_temp.check_true((loaded->'completedIds') @> '["legacy-old","legacy-recent-1"]'::jsonb
    and not ((loaded->'completedIds') ? 'does-not-exist'),
    'known IDs are checked against the durable ledger, beyond visible history');
  perform pg_temp.expect_rejected(
    'select public.load_player_checkpoint(array(select ''test-'' || n::text from generate_series(1,501) n))',
    '22023', 'oversized known-ID batches are rejected');

  result := jsonb_build_object('id', 'shared-result-id', 'game', 'poker',
    'win', true, 'delta', 250, 'xp', 80, 'at', '2026-10-23T12:00:00Z');
  -- The snapshot already includes the payout. The RPC must not credit it again.
  snapshot := jsonb_set(snapshot, '{profile,balance}', '10250');
  snapshot := jsonb_set(snapshot, '{profile,xp}', '120');
  snapshot := jsonb_set(snapshot, '{profile,wins}', '2');
  snapshot := jsonb_set(snapshot, '{profile,games}', '36');
  snapshot := jsonb_set(snapshot, '{profile,history}', jsonb_build_array(result || '{"synced":true}'::jsonb));
  snapshot := jsonb_set(snapshot, '{profile,resultIds}', '["shared-result-id"]');
  snapshot := jsonb_set(snapshot, '{games,poker}', '{"id":"match-1","tableId":"table-1","turn":2}');
  response := public.commit_player_checkpoint(0, f.mutation_one, snapshot, jsonb_build_array(result));
  perform pg_temp.check_true(response->>'status' = 'saved'
    and (response->>'revision')::bigint = 1
    and response->>'mutationId' = f.mutation_one::text
    and nullif(response->>'updatedAt', '') is not null,
    'first CAS commit returns its revision, mutation ID and timestamp');
  perform pg_temp.check_true((response->>'updatedAt')::timestamptz is not null,
    'accepted timestamp is parseable');
  loaded := public.load_player_checkpoint(array['shared-result-id', 'legacy-old']);
  perform pg_temp.check_true((loaded->>'revision')::bigint = 1 and loaded->'snapshot' = snapshot,
    'profile and game snapshot are restored together');
  perform pg_temp.check_true((select balance = 10250 and xp = 120 and games = 36 and wins = 2
    from public.profiles where id = f.user_id), 'already-credited snapshot is not credited twice');
  perform pg_temp.check_true((select count(*) = 36 from public.player_results where user_id = f.user_id),
    'result is inserted once alongside the snapshot');
  update pg_temp.vh_checkpoint_fixtures set snapshot_one = snapshot,
    result_one = result, response_one = response where label = 'a';

  snapshot := jsonb_set(snapshot, '{games,poker,turn}', '3');
  response := public.commit_player_checkpoint(1, f.mutation_two, snapshot, '[]');
  perform pg_temp.check_true(response->>'status' = 'saved' and (response->>'revision')::bigint = 2,
    'matching expected revision advances the checkpoint');
  update pg_temp.vh_checkpoint_fixtures set snapshot_two = snapshot where label = 'a';
end;
$$;

do $$
declare f record; before_state jsonb; after_state jsonb; response jsonb; duplicate_batch jsonb; candidate jsonb;
begin
  select * into strict f from pg_temp.vh_checkpoint_fixtures where label = 'a';
  before_state := public.load_player_checkpoint(array['legacy-old', 'shared-result-id']);
  response := public.commit_player_checkpoint(0, f.mutation_one, f.snapshot_one, jsonb_build_array(f.result_one));
  perform pg_temp.check_true(response->>'status' = 'saved'
    and (response->>'revision')::bigint = 1
    and response->>'mutationId' = f.mutation_one::text
    and response->'updatedAt' = f.response_one->'updatedAt',
    'retry of an accepted mutation returns its original receipt after a later commit');
  perform pg_temp.check_true(public.load_player_checkpoint(array['legacy-old', 'shared-result-id']) = before_state,
    'durable retry never rolls revision two back to revision one');

  perform pg_temp.expect_rejected(format(
    'select public.commit_player_checkpoint(0, %L::uuid, %L::jsonb, %L::jsonb)',
    f.mutation_one, f.snapshot_two, jsonb_build_array(f.result_one)), '22023',
    'reusing a mutation ID for a different request is rejected');
  response := public.commit_player_checkpoint(1, f.mutation_stale, f.snapshot_one, '[]');
  perform pg_temp.check_true(response->>'status' = 'conflict' and (response->>'revision')::bigint = 2
    and response->>'mutationId' = f.mutation_stale::text
    and response->'updatedAt' = before_state->'updatedAt',
    'stale expected revision reports conflict instead of overwriting');

  -- A mixed batch makes partial inserts observable if duplicate detection is late.
  duplicate_batch := jsonb_build_array(
    jsonb_set(f.result_one, '{id}', '"must-not-be-inserted"'),
    jsonb_set(f.result_one, '{id}', '"legacy-old"'));
  candidate := jsonb_set(f.snapshot_two, '{profile,resultIds}',
    '["shared-result-id","must-not-be-inserted","legacy-old"]');
  response := public.commit_player_checkpoint(2, f.mutation_duplicate,
    jsonb_set(candidate, '{profile,balance}', '77777'), duplicate_batch);
  perform pg_temp.check_true(response->>'status' = 'duplicate_result'
    and (response->>'revision')::bigint = 2
    and response->>'mutationId' = f.mutation_duplicate::text
    and response->'updatedAt' = before_state->'updatedAt',
    'previously paid result outside recent history rejects a new mutation');
  after_state := public.load_player_checkpoint(array['legacy-old', 'shared-result-id']);
  perform pg_temp.check_true(after_state = before_state,
    'conflict and duplicate result leave the entire checkpoint unchanged');
  perform pg_temp.check_true((select balance = 10250 and xp = 120 and games = 36
    from public.profiles where id = f.user_id), 'rejected requests never overwrite profile counters');
  perform pg_temp.check_true((select count(*) = 36 from public.player_results where user_id = f.user_id)
    and not exists(select 1 from public.player_results where id = 'must-not-be-inserted'),
    'duplicate result rolls back the whole mixed result batch');

  candidate := jsonb_set(f.snapshot_two, '{profile,resultIds}',
    '["shared-result-id","valid-before-invalid"]');
  perform pg_temp.expect_rejected(format(
    'select public.commit_player_checkpoint(2, %L::uuid, %L::jsonb, %L::jsonb)',
    f.mutation_invalid, jsonb_set(candidate, '{profile,balance}', '88888'),
    jsonb_build_array(jsonb_set(f.result_one, '{id}', '"valid-before-invalid"'),
      jsonb_set(f.result_one, '{game}', '"unknown-game"'))), '22023',
    'invalid result shape rejects an entire mixed batch');
  perform pg_temp.expect_rejected(format(
    'select public.commit_player_checkpoint(2, %L::uuid, %L::jsonb, ''[]''::jsonb)',
    f.mutation_invalid, jsonb_set(f.snapshot_two, '{games,poker}', '[]')), '22023',
    'a game snapshot must be an object or null');
  perform pg_temp.expect_rejected(format(
    'select public.commit_player_checkpoint(2, %L::uuid, %L::jsonb, ''[]''::jsonb)',
    f.mutation_invalid, jsonb_set(f.snapshot_two, '{profile,balance}', '-1')), '22023',
    'negative profile balance is rejected');
  perform pg_temp.expect_rejected(format(
    'select public.commit_player_checkpoint(2, %L::uuid, %L::jsonb, ''[]''::jsonb)',
    f.mutation_invalid, jsonb_set(f.snapshot_two, '{format}', 'null')), '22023',
    'JSON null format is rejected rather than bypassing envelope validation');
  perform pg_temp.expect_rejected(format(
    'select public.commit_player_checkpoint(2, %L::uuid, %L::jsonb, ''[]''::jsonb)',
    f.mutation_invalid, jsonb_set(f.snapshot_two, '{version}', 'null')), '22023',
    'JSON null version is rejected rather than bypassing envelope validation');

  candidate := jsonb_set(f.snapshot_two, '{profile,resultIds}',
    '["shared-result-id","rollback-after-result-insert"]');
  candidate := jsonb_set(candidate, '{profile,nick}', '"RejectFixture"');
  candidate := jsonb_set(candidate, '{profile,balance}', '99999');
  perform pg_temp.expect_rejected(format(
    'select public.commit_player_checkpoint(2, %L::uuid, %L::jsonb, %L::jsonb)',
    f.mutation_dml_failure, candidate,
    jsonb_build_array(jsonb_set(f.result_one, '{id}', '"rollback-after-result-insert"'))), '23514',
    'a profile-write error rolls back the result insert from the same RPC');
  perform pg_temp.check_true(public.load_player_checkpoint(array['legacy-old', 'shared-result-id']) = before_state
    and (select balance = 10250 and nickname = 'Legacy A' and xp = 120 and games = 36
      from public.profiles where id = f.user_id)
    and (select count(*) = 36 from public.player_results where user_id = f.user_id)
    and not exists(select 1 from public.player_results
      where user_id = f.user_id and id = 'rollback-after-result-insert'),
    'validation and mid-write failures leave no partial snapshot, profile or result insert');
end;
$$;

-- Switch both the database role and JWT identity; postgres is not used to
-- simulate any user-level access check.
reset role;
set local role authenticated;
select pg_temp.use_actor('b');

do $$
declare a_id uuid; f record; loaded jsonb; snapshot jsonb; result jsonb; response jsonb;
begin
  select user_id into strict a_id from pg_temp.vh_checkpoint_fixtures where label = 'a';
  select * into strict f from pg_temp.vh_checkpoint_fixtures where label = 'b';
  loaded := public.load_player_checkpoint(array['legacy-old', 'shared-result-id']);
  perform pg_temp.check_true((loaded->>'revision')::bigint = 0
    and (loaded#>>'{snapshot,profile,balance}')::integer = 10000
    and loaded->'completedIds' = '[]'::jsonb,
    'fresh account cannot load another account checkpoint or completed IDs');
  perform pg_temp.check_true(not exists(select 1 from public.profiles where id = a_id)
    and not exists(select 1 from public.player_results where user_id = a_id),
    'RLS hides the other account profile and result ledger');
  perform pg_temp.expect_rejected('select * from vezdehot_private.player_checkpoints', '42501',
    'authenticated clients cannot read private checkpoint rows directly');
  perform pg_temp.expect_rejected('select * from vezdehot_private.checkpoint_receipts', '42501',
    'authenticated clients cannot read private mutation receipts');

  snapshot := loaded->'snapshot';
  result := jsonb_build_object('id', 'shared-result-id', 'game', 'mafia',
    'win', true, 'delta', 250, 'xp', 80, 'at', '2026-10-23T12:00:00Z');
  snapshot := jsonb_set(snapshot, '{profile,nick}', '"Fixture B"');
  snapshot := jsonb_set(snapshot, '{profile,balance}', '10250');
  snapshot := jsonb_set(snapshot, '{profile,xp}', '80');
  snapshot := jsonb_set(snapshot, '{profile,games}', '1');
  snapshot := jsonb_set(snapshot, '{profile,wins}', '1');
  snapshot := jsonb_set(snapshot, '{profile,history}', jsonb_build_array(result || '{"synced":true}'::jsonb));
  snapshot := jsonb_set(snapshot, '{profile,resultIds}', '["shared-result-id"]');
  response := public.commit_player_checkpoint(0, f.mutation_one, snapshot, jsonb_build_array(result));
  perform pg_temp.check_true(response->>'status' = 'saved' and (response->>'revision')::bigint = 1,
    'same result ID is independent across accounts');
  loaded := public.load_player_checkpoint(array['legacy-old', 'shared-result-id']);
  perform pg_temp.check_true(loaded->'completedIds' = '["shared-result-id"]'::jsonb,
    'completed IDs are still scoped after a same-ID result on another account');
  update pg_temp.vh_checkpoint_fixtures set snapshot_one = snapshot where label = 'b';

  perform pg_temp.expect_rejected(format(
    'update public.profiles set balance = 1 where id = %L::uuid', f.user_id), '42501',
    'direct own-profile updates cannot bypass checkpoint CAS');
  perform pg_temp.expect_rejected(format(
    'insert into public.profiles(id, nickname, balance) values (%L::uuid, ''Bypass'', 1) '
    'on conflict(id) do update set balance = 1', f.user_id), '42501',
    'direct profile upsert cannot bypass checkpoint CAS');
  perform pg_temp.expect_rejected(format(
    'update public.profiles set balance = 1 where id = %L::uuid', a_id), '42501',
    'cross-account direct updates are denied');
  perform pg_temp.expect_rejected(format(
    'insert into public.player_results(user_id,id,game,win,delta,xp) '
    'values (%L::uuid,''direct-bypass'',''durak'',true,999,1)', f.user_id), '42501',
    'direct result insertion cannot bypass atomic settlement');
  perform pg_temp.expect_rejected(format(
    'update public.player_results set delta = 999 where user_id = %L::uuid', f.user_id), '42501',
    'direct result updates are denied');
  perform pg_temp.expect_rejected(format(
    'delete from public.player_results where user_id = %L::uuid', f.user_id), '42501',
    'direct result deletion cannot erase durable deduplication');
  perform pg_temp.check_true(public.load_player_checkpoint(array['legacy-old', 'shared-result-id']) = loaded
    and (select balance = 10250 from public.profiles where id = f.user_id)
    and (select count(*) = 1 from public.player_results where user_id = f.user_id),
    'denied direct writes leave profile, ledger and checkpoint intact');
end;
$$;

reset role;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'anon', true);
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select pg_temp.expect_rejected('select public.load_player_checkpoint()', '42501',
  'unauthenticated SQL role cannot load a checkpoint');
select pg_temp.expect_rejected(format(
  'select public.commit_player_checkpoint(0, %L::uuid, %L::jsonb, ''[]''::jsonb)',
  mutation_one, snapshot_one), '42501', 'unauthenticated SQL role cannot commit a checkpoint')
from vh_checkpoint_fixtures where label = 'b';

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"role":"authenticated","is_anonymous":false}', true);
select pg_temp.expect_rejected('select public.load_player_checkpoint()', '42501',
  'authenticated role without a verified subject cannot load a checkpoint');
select pg_temp.expect_rejected(format(
  'select public.commit_player_checkpoint(0, %L::uuid, %L::jsonb, ''[]''::jsonb)',
  mutation_one, snapshot_one), '42501', 'authenticated role without a subject cannot commit a checkpoint')
from vh_checkpoint_fixtures where label = 'b';
select pg_temp.use_actor('anonymous', true);
select pg_temp.expect_rejected('select public.load_player_checkpoint()', '42501',
  'anonymous Auth user with authenticated SQL role cannot load a checkpoint');
select pg_temp.expect_rejected(format(
  'select public.commit_player_checkpoint(0, %L::uuid, %L::jsonb, ''[]''::jsonb)',
  mutation_one, snapshot_one), '42501', 'anonymous Auth user cannot commit a checkpoint')
from vh_checkpoint_fixtures where label = 'b';

-- Privileged inspection is only for final invariants on our random fixture IDs.
reset role;
do $$
declare a record; b record; anonymous_id uuid;
begin
  select * into strict a from pg_temp.vh_checkpoint_fixtures where label = 'a';
  select * into strict b from pg_temp.vh_checkpoint_fixtures where label = 'b';
  select user_id into strict anonymous_id from pg_temp.vh_checkpoint_fixtures where label = 'anonymous';
  perform pg_temp.check_true((select revision = 2 and snapshot = a.snapshot_two
    from vezdehot_private.player_checkpoints where user_id = a.user_id),
    'A remains at its accepted revision after all cross-account and rejection tests');
  perform pg_temp.check_true((select revision = 1 and snapshot = b.snapshot_one
    from vezdehot_private.player_checkpoints where user_id = b.user_id),
    'B has only its own accepted checkpoint');
  perform pg_temp.check_true((select count(*) = 2 from vezdehot_private.checkpoint_receipts where user_id = a.user_id)
    and (select count(*) = 1 from vezdehot_private.checkpoint_receipts where user_id = b.user_id),
    'only accepted mutations create receipts; retries and rejected requests do not');
  perform pg_temp.check_true(not exists(select 1 from vezdehot_private.checkpoint_receipts
      where user_id = a.user_id and mutation_id in (
        a.mutation_stale, a.mutation_duplicate, a.mutation_invalid, a.mutation_dml_failure)),
    'no failed mutation is accidentally remembered as accepted');
  perform pg_temp.check_true(not exists(select 1 from vezdehot_private.player_checkpoints where user_id = anonymous_id)
    and not exists(select 1 from vezdehot_private.checkpoint_receipts where user_id = anonymous_id),
    'anonymous rejection creates no checkpoint or receipt');
  perform pg_temp.check_true((select balance = 10250 and games = 36 from public.profiles where id = a.user_id)
    and (select count(*) = 36 from public.player_results where user_id = a.user_id),
    'other-account operations never alter A wallet or result ledger');
  raise notice 'cloud-checkpoint.sql: all functional and access-control assertions passed; rolling back fixtures';
end;
$$;

rollback;
