// Disposable local PostgreSQL only. Never connects to production.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {PGlite}=require(process.argv[2]||'@electric-sql/pglite');
const root=path.resolve(__dirname,'..');
(async()=>{
  const db=new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create table auth.users(id uuid primary key, instance_id uuid, aud text, role text,
        email text, encrypted_password text, raw_app_meta_data jsonb, raw_user_meta_data jsonb,
        is_anonymous boolean, created_at timestamptz, updated_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      create function auth.jwt() returns jsonb language sql stable as $$
        select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      grant usage on schema auth to anon,authenticated,service_role;
      create table public.profiles(id uuid primary key references auth.users(id),nickname text,
        balance integer,xp integer,wins integer,games integer,preferences jsonb,updated_at timestamptz);
      create table public.player_results(user_id uuid references auth.users(id),id text,game text,
        win boolean,delta integer,xp integer,played_at timestamptz,primary key(user_id,id));
    `);
    const dir=path.join(root,'supabase/migrations');
    for(const suffix of ['atomic_player_checkpoints','server_durak_actions','server_poker_actions','server_wallet','server_bunker_actions']){
      const files=fs.readdirSync(dir).filter(name=>new RegExp('^\\d+_'+suffix+'\\.sql$').test(name));
      assert.equal(files.length,1,'One canonical migration: '+suffix);
      await db.exec(fs.readFileSync(path.join(dir,files[0]),'utf8'));
    }
    for(const file of ['server-durak.sql','server-poker.sql','server-wallet.sql','server-bunker.sql']){
      await db.exec(fs.readFileSync(path.join(root,'tests',file),'utf8'));
      console.log('PASS '+file);
    }
    for(const table of ['auth.users','vezdehot_private.server_wallets','vezdehot_private.server_wallet_ledger',
      'vezdehot_private.server_wallet_receipts','public.profiles','public.player_results','vezdehot_private.player_checkpoints','vezdehot_private.server_bunker_games','vezdehot_private.server_bunker_receipts']){
      assert.equal((await db.query('select count(*)::integer as n from '+table)).rows[0].n,0,'Fixture rolled back: '+table);
    }
    const funcs=await db.query("select proname,prosecdef,proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where proname in ('server_bunker_read','server_bunker_commit','server_bunker_stake','server_wallet_apply_bunker')");
    assert.equal(funcs.rows.length,4);
    for(const fn of funcs.rows){assert.equal(fn.prosecdef,false,fn.proname+' is invoker');assert(fn.proconfig.includes('search_path=""'),fn.proname+' has empty search path');}
    const tables=await db.query("select relname,relrowsecurity from pg_class where relname in ('server_bunker_games','server_bunker_receipts')");
    assert.equal(tables.rows.length,2);assert(tables.rows.every(t=>t.relrowsecurity));
    console.log('PASS Bunker role isolation, CAS, permanent receipts, atomic rewards, earned results and rollback; all fixtures removed');
  } finally {await db.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
