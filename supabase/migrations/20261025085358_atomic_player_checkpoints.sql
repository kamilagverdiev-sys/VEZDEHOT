-- One account revision covers its wallet, all five games, and result settlement.
-- Deploy with the checkpoint client: legacy direct writes are revoked at the end.
create schema if not exists vezdehot_private;
revoke all on schema vezdehot_private from public, anon, authenticated;
-- Public SECURITY INVOKER wrappers need to call the private entry points.
-- The schema is not exposed through PostgREST; no table privileges are granted.
grant usage on schema vezdehot_private to authenticated;

create table vezdehot_private.player_checkpoints (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  snapshot jsonb not null,
  updated_at timestamptz
);
create table vezdehot_private.checkpoint_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  mutation_id uuid not null,
  revision bigint not null check (revision > 0),
  request_hash text not null,
  updated_at timestamptz not null,
  primary key (user_id, mutation_id)
);
alter table vezdehot_private.player_checkpoints enable row level security;
alter table vezdehot_private.checkpoint_receipts enable row level security;
create policy checkpoints_read_own on vezdehot_private.player_checkpoints
  for select to authenticated using ((select auth.uid()) = user_id);
create policy receipts_read_own on vezdehot_private.checkpoint_receipts
  for select to authenticated using ((select auth.uid()) = user_id);
revoke all on vezdehot_private.player_checkpoints, vezdehot_private.checkpoint_receipts
  from public, anon, authenticated;

create function vezdehot_private.require_player() returns uuid
language plpgsql stable security invoker set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or coalesce(auth.jwt()->>'role', '') <> 'authenticated'
    or coalesce(auth.jwt()->>'is_anonymous', 'false') <> 'false' then
    raise exception 'A permanent authenticated account is required' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

create function vezdehot_private.has_shape(p_value jsonb, p_required text[], p_optional text[] default '{}')
returns boolean language plpgsql immutable security invoker set search_path = '' as $$
begin
  if jsonb_typeof(p_value) is distinct from 'object' then return false; end if;
  return p_value ?& p_required and not exists (
    select 1 from jsonb_object_keys(p_value) as k(key)
    where not (k.key = any(p_required || p_optional))
  );
end;
$$;

create function vezdehot_private.is_integer(p_value jsonb, p_min numeric, p_max numeric)
returns boolean language plpgsql immutable security invoker set search_path = '' as $$
declare v numeric;
begin
  if jsonb_typeof(p_value) is distinct from 'number' then return false; end if;
  v := (p_value #>> '{}')::numeric;
  return v between p_min and p_max and v = trunc(v);
end;
$$;

create function vezdehot_private.assert_result(p_value jsonb, p_history boolean default false)
returns void language plpgsql immutable security invoker set search_path = '' as $$
declare v_at timestamptz;
begin
  if not vezdehot_private.has_shape(p_value, array['id','game','win','delta','xp','at'],
      case when p_history then array['synced'] else array[]::text[] end)
    or jsonb_typeof(p_value->'id') is distinct from 'string'
    or char_length(p_value->>'id') not between 1 and 100
    or btrim(p_value->>'id') = '' or (p_value->>'id') ~ '[[:cntrl:]]'
    or jsonb_typeof(p_value->'game') is distinct from 'string'
    or (p_value->>'game') not in ('durak','bunker','poker','mafia','monopoly')
    or jsonb_typeof(p_value->'win') is distinct from 'boolean'
    or not vezdehot_private.is_integer(p_value->'delta', -2000000, 2000000)
    or not vezdehot_private.is_integer(p_value->'xp', 0, 2000000000)
    or jsonb_typeof(p_value->'at') is distinct from 'string'
    or (p_value->>'at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
    or (p_value ? 'synced' and jsonb_typeof(p_value->'synced') is distinct from 'boolean') then
    raise exception 'Invalid checkpoint result' using errcode = '22023';
  end if;
  begin
    v_at := (p_value->>'at')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'Invalid result timestamp' using errcode = '22023';
  end;
  if not isfinite(v_at) then raise exception 'Invalid result timestamp' using errcode = '22023'; end if;
end;
$$;

create function vezdehot_private.assert_snapshot(p_snapshot jsonb, p_results jsonb)
returns void language plpgsql immutable security invoker set search_path = '' as $$
declare p jsonb; v jsonb; k text; seen text[] := '{}'; result_ids text[] := '{}';
begin
  if p_snapshot is null or octet_length(p_snapshot::text) > 3145728
    or not vezdehot_private.has_shape(p_snapshot, array['format','version','profile','games'])
    or p_snapshot->>'format' is distinct from 'vezdehot-account-checkpoint'
    or p_snapshot->'version' is distinct from '1'::jsonb then
    raise exception 'Invalid checkpoint envelope' using errcode = '22023';
  end if;
  p := p_snapshot->'profile';
  if not vezdehot_private.has_shape(p, array['nick','balance','xp','wins','games','bonusAt','avatar','durakPace','reduceMotion','history','resultIds'])
    or jsonb_typeof(p->'nick') is distinct from 'string'
    or char_length(btrim(p->>'nick')) not between 1 and 24
    or (p->>'nick') <> btrim(p->>'nick') or (p->>'nick') ~ '[[:cntrl:]]'
    or jsonb_typeof(p->'avatar') is distinct from 'string'
    or (p->>'avatar') not in ('✦','◈','♠','✿','△','☾','✹','◇')
    or jsonb_typeof(p->'durakPace') is distinct from 'string'
    or (p->>'durakPace') not in ('calm','normal','quick')
    or jsonb_typeof(p->'reduceMotion') is distinct from 'boolean'
    or not vezdehot_private.is_integer(p->'bonusAt', 0, 9007199254740991) then
    raise exception 'Invalid checkpoint profile' using errcode = '22023';
  end if;
  foreach k in array array['balance','xp','wins','games'] loop
    if not vezdehot_private.is_integer(p->k, 0, 2000000000) then
      raise exception 'Invalid profile counter' using errcode = '22023';
    end if;
  end loop;
  if (p->>'wins')::integer > (p->>'games')::integer then
    raise exception 'Wins exceed completed games' using errcode = '22023';
  end if;
  if jsonb_typeof(p->'resultIds') is distinct from 'array' then
    raise exception 'Invalid result IDs' using errcode = '22023';
  end if;
  if jsonb_array_length(p->'resultIds') > 500 then
    raise exception 'Too many result IDs' using errcode = '22023';
  end if;
  for v in select value from jsonb_array_elements(p->'resultIds') loop
    if jsonb_typeof(v) is distinct from 'string' or char_length(v #>> '{}') not between 1 and 100
      or btrim(v #>> '{}') = '' or (v #>> '{}') ~ '[[:cntrl:]]' or (v #>> '{}') = any(result_ids) then
      raise exception 'Invalid or repeated result ID' using errcode = '22023';
    end if;
    result_ids := array_append(result_ids, v #>> '{}');
  end loop;
  if jsonb_typeof(p->'history') is distinct from 'array' then
    raise exception 'Invalid checkpoint history' using errcode = '22023';
  end if;
  if jsonb_array_length(p->'history') > 30 then raise exception 'Too much history' using errcode = '22023'; end if;
  for v in select value from jsonb_array_elements(p->'history') loop
    perform vezdehot_private.assert_result(v, true);
    if (v->>'id') = any(seen) or not ((v->>'id') = any(result_ids)) then
      raise exception 'Inconsistent history IDs' using errcode = '22023';
    end if;
    seen := array_append(seen, v->>'id');
  end loop;
  if not vezdehot_private.has_shape(p_snapshot->'games', array['durak','bunker','poker','mafia','monopoly']) then
    raise exception 'Invalid checkpoint games' using errcode = '22023';
  end if;
  for k, v in select key, value from jsonb_each(p_snapshot->'games') loop
    if jsonb_typeof(v) not in ('object','null') or octet_length(v::text) > 524288 then
      raise exception 'Invalid game checkpoint' using errcode = '22023';
    end if;
  end loop;
  if jsonb_typeof(p_results) is distinct from 'array' then
    raise exception 'Invalid results batch' using errcode = '22023';
  end if;
  if jsonb_array_length(p_results) > 500 or octet_length(p_results::text) > 524288 then
    raise exception 'Results batch is too large' using errcode = '22023';
  end if;
  seen := '{}';
  for v in select value from jsonb_array_elements(p_results) loop
    perform vezdehot_private.assert_result(v);
    if (v->>'id') = any(seen) or not ((v->>'id') = any(result_ids)) then
      raise exception 'Inconsistent settlement IDs' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(p->'history') h
      where h->>'id' = v->>'id' and (h - 'synced') <> v) then
      raise exception 'Result and history disagree' using errcode = '22023';
    end if;
    seen := array_append(seen, v->>'id');
  end loop;
end;
$$;

-- Used only by authenticated private cores. Never accepts a caller-supplied uid.
create function vezdehot_private.legacy_snapshot(p_uid uuid) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare p public.profiles%rowtype; h jsonb; ids jsonb; prefs jsonb;
begin
  select * into p from public.profiles where id = p_uid;
  prefs := coalesce(p.preferences, '{}'::jsonb);
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'game',r.game,'win',r.win,'delta',r.delta,'xp',r.xp,
      'at',to_char(r.played_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'synced',true)
      order by r.played_at desc, r.id), '[]'::jsonb),
    coalesce(jsonb_agg(to_jsonb(r.id) order by r.played_at desc, r.id), '[]'::jsonb)
    into h, ids from (select * from public.player_results where user_id = p_uid order by played_at desc, id limit 30) r;
  return jsonb_build_object('format','vezdehot-account-checkpoint','version',1,
    'profile',jsonb_build_object('nick',coalesce(p.nickname,'Игрок'),'balance',coalesce(p.balance,10000),
      'xp',coalesce(p.xp,0),'wins',coalesce(p.wins,0),'games',coalesce(p.games,0),
      'bonusAt',case when vezdehot_private.is_integer(prefs->'bonusAt',0,9007199254740991) then prefs->'bonusAt' else '0'::jsonb end,
      'avatar',case when prefs->>'avatar' in ('✦','◈','♠','✿','△','☾','✹','◇') then prefs->>'avatar' else '✦' end,
      'durakPace',case when prefs->>'durakPace' in ('calm','normal','quick') then prefs->>'durakPace' else 'calm' end,
      'reduceMotion',case when jsonb_typeof(prefs->'reduceMotion')='boolean' then prefs->'reduceMotion' else 'false'::jsonb end,
      'history',h,'resultIds',ids),
    'games',jsonb_build_object('durak',null,'bunker',null,'poker',null,'mafia',null,'monopoly',null));
end;
$$;

create function vezdehot_private.load_player_checkpoint(p_known_ids text[] default '{}') returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := vezdehot_private.require_player(); c vezdehot_private.player_checkpoints%rowtype;
  v_snapshot jsonb; v_updated timestamptz; v_completed jsonb;
begin
  if p_known_ids is null or cardinality(p_known_ids) > 500 or array_ndims(p_known_ids) > 1
    or exists (select 1 from unnest(p_known_ids) id where id is null or char_length(id) not between 1 and 100
      or btrim(id)='' or id ~ '[[:cntrl:]]') then
    raise exception 'Invalid known result IDs' using errcode = '22023';
  end if;
  -- Serialize the entire read against commits, including the initial revision 0.
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 271828));
  select * into c from vezdehot_private.player_checkpoints where user_id = v_uid;
  if found and c.revision > 0 then v_snapshot := c.snapshot; v_updated := c.updated_at;
  else
    v_snapshot := vezdehot_private.legacy_snapshot(v_uid);
    select updated_at into v_updated from public.profiles where id = v_uid;
  end if;
  select coalesce(jsonb_agg(to_jsonb(id) order by id), '[]'::jsonb) into v_completed from (
    select id from public.player_results where user_id=v_uid and id=any(p_known_ids)
    union select id from (select id from public.player_results where user_id=v_uid order by played_at desc,id limit 30) recent
  ) completed;
  return jsonb_build_object('status','ok','revision',coalesce(c.revision,0),'snapshot',v_snapshot,
    'updatedAt',v_updated,'completedIds',v_completed);
end;
$$;

create function vezdehot_private.commit_player_checkpoint(p_expected_revision bigint, p_mutation_id uuid,
  p_snapshot jsonb, p_results jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := vezdehot_private.require_player(); c vezdehot_private.player_checkpoints%rowtype;
  receipt vezdehot_private.checkpoint_receipts%rowtype; v_hash text; v_now timestamptz; v_revision bigint;
  p jsonb; v_snapshot jsonb;
begin
  if p_expected_revision is null or p_expected_revision < 0 or p_expected_revision >= 9007199254740991
    or p_mutation_id is null then raise exception 'Invalid checkpoint request' using errcode = '22023'; end if;
  perform vezdehot_private.assert_snapshot(p_snapshot,p_results);
  v_hash := encode(sha256(convert_to(jsonb_build_object('expectedRevision',p_expected_revision,
    'snapshot',p_snapshot,'results',p_results)::text,'UTF8')),'hex');
  -- The account-scoped lock also protects initial creation and receipt lookup.
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 271828));
  select * into receipt from vezdehot_private.checkpoint_receipts where user_id=v_uid and mutation_id=p_mutation_id;
  if found then
    if receipt.request_hash <> v_hash then raise exception 'Mutation ID was used for a different request' using errcode='22023'; end if;
    return jsonb_build_object('status','saved','revision',receipt.revision,'mutationId',p_mutation_id,'updatedAt',receipt.updated_at);
  end if;
  select * into c from vezdehot_private.player_checkpoints where user_id=v_uid for update;
  v_revision := coalesce(c.revision,0);
  if p_expected_revision <> v_revision then
    return jsonb_build_object('status','conflict','revision',v_revision,'mutationId',p_mutation_id,'updatedAt',c.updated_at);
  end if;
  if exists (select 1 from jsonb_array_elements(p_results) r join public.player_results old
      on old.user_id=v_uid and old.id=r->>'id') then
    return jsonb_build_object('status','duplicate_result','revision',v_revision,'mutationId',p_mutation_id,'updatedAt',c.updated_at);
  end if;
  v_now := clock_timestamp();
  -- All history now belongs to this accepted account snapshot; keep UI sync flags normalized.
  v_snapshot := jsonb_set(p_snapshot,'{profile,history}',coalesce((select jsonb_agg(h || '{"synced":true}'::jsonb order by ord)
    from jsonb_array_elements(p_snapshot#>'{profile,history}') with ordinality as entries(h,ord)), '[]'::jsonb));
  p := v_snapshot->'profile';
  insert into public.player_results(user_id,id,game,win,delta,xp,played_at)
    select v_uid,r->>'id',r->>'game',(r->>'win')::boolean,(r->>'delta')::integer,(r->>'xp')::integer,(r->>'at')::timestamptz
    from jsonb_array_elements(p_results) r;
  -- Snapshot totals already include settlements. Never add result.delta again here.
  insert into public.profiles(id,nickname,balance,xp,wins,games,preferences,updated_at)
    values(v_uid,case when char_length(p->>'nick')=1 then (p->>'nick')||'!' else p->>'nick' end,
      (p->>'balance')::integer,(p->>'xp')::integer,(p->>'wins')::integer,(p->>'games')::integer,
      jsonb_build_object('bonusAt',p->'bonusAt','avatar',p->'avatar','durakPace',p->'durakPace','reduceMotion',p->'reduceMotion'),v_now)
    on conflict(id) do update set nickname=excluded.nickname,balance=excluded.balance,xp=excluded.xp,
      wins=excluded.wins,games=excluded.games,preferences=excluded.preferences,updated_at=excluded.updated_at;
  insert into vezdehot_private.player_checkpoints(user_id,revision,snapshot,updated_at)
    values(v_uid,v_revision+1,v_snapshot,v_now)
    on conflict(user_id) do update set revision=excluded.revision,snapshot=excluded.snapshot,updated_at=excluded.updated_at;
  insert into vezdehot_private.checkpoint_receipts(user_id,mutation_id,revision,request_hash,updated_at)
    values(v_uid,p_mutation_id,v_revision+1,v_hash,v_now);
  return jsonb_build_object('status','saved','revision',v_revision+1,'mutationId',p_mutation_id,'updatedAt',v_now);
end;
$$;

create function public.load_player_checkpoint(p_known_ids text[] default '{}') returns jsonb
language sql volatile security invoker set search_path = '' as $$
  select vezdehot_private.load_player_checkpoint(p_known_ids);
$$;
create function public.commit_player_checkpoint(p_expected_revision bigint,p_mutation_id uuid,p_snapshot jsonb,p_results jsonb)
returns jsonb language sql volatile security invoker set search_path = '' as $$
  select vezdehot_private.commit_player_checkpoint(p_expected_revision,p_mutation_id,p_snapshot,p_results);
$$;

revoke execute on all functions in schema vezdehot_private from public, anon, authenticated;
grant execute on function vezdehot_private.load_player_checkpoint(text[]),
  vezdehot_private.commit_player_checkpoint(bigint,uuid,jsonb,jsonb) to authenticated;
revoke all on function public.load_player_checkpoint(text[]), public.commit_player_checkpoint(bigint,uuid,jsonb,jsonb)
  from public, anon, authenticated;
grant execute on function public.load_player_checkpoint(text[]), public.commit_player_checkpoint(bigint,uuid,jsonb,jsonb)
  to authenticated;

-- RLS SELECT policies remain intact. Removing direct writes makes older clients
-- fail safely instead of silently bypassing the shared revision and receipts.
revoke all on public.profiles, public.player_results from public, anon, authenticated;
grant select on public.profiles, public.player_results to authenticated;
comment on function public.commit_player_checkpoint(bigint,uuid,jsonb,jsonb) is
  'Atomic owner-only CAS checkpoint. Retry identical mutation IDs; conflicts and duplicate results make no writes.';
comment on table vezdehot_private.checkpoint_receipts is
  'Durable account-scoped idempotency receipts. Do not prune while clients may retry old mutations.';
