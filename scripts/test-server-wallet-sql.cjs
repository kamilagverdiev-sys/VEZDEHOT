// Offline PostgreSQL security/transaction tests. Never connects to production.
// Optional argument: an installed @electric-sql/pglite package path.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {PGlite} = require(process.argv[2] || '@electric-sql/pglite');
const root = path.resolve(__dirname, '..');
(async () => {
  const db = new PGlite();
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
    const dir = path.join(root,'supabase/migrations');
    for (const suffix of ['atomic_player_checkpoints','server_durak_actions','server_poker_actions','server_wallet']) {
      const files = fs.readdirSync(dir).filter(name => new RegExp('^\\d+_'+suffix+'\\.sql$').test(name));
      assert.equal(files.length,1,'One canonical migration: '+suffix);
      await db.exec(fs.readFileSync(path.join(dir,files[0]),'utf8'));
    }
    // Existing free-table behavior must also survive the RPC replacements.
    for (const file of ['server-durak.sql','server-poker.sql','server-wallet.sql']) {
      await db.exec(fs.readFileSync(path.join(root,'tests',file),'utf8'));
      console.log('PASS '+file);
    }
    for (const table of ['auth.users','public.profiles','public.player_results',
      'vezdehot_private.server_wallets','vezdehot_private.server_wallet_ledger',
      'vezdehot_private.server_wallet_receipts','vezdehot_private.player_checkpoints',
      'vezdehot_private.server_durak_games','vezdehot_private.server_poker_games',
      'vezdehot_private.server_durak_receipts','vezdehot_private.server_poker_receipts']) {
      assert.equal((await db.query('select count(*)::integer as n from '+table)).rows[0].n,0,'Rolled back: '+table);
    }
    console.log('PASS server wallet transactions, role permissions, checkpoint isolation and legacy games; all fixtures rolled back');
  } finally { await db.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
