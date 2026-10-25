// Offline SQL security/regression suite. Never connects to the production database.
// Optional argument: absolute path to an installed @electric-sql/pglite package.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const packagePath = process.argv[2] || '@electric-sql/pglite';
const {PGlite} = require(packagePath);
const root = path.resolve(__dirname, '..');
(async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role;
      create schema auth;
      create table auth.users (
        id uuid primary key, instance_id uuid, aud text, role text, email text,
        encrypted_password text, raw_app_meta_data jsonb, raw_user_meta_data jsonb,
        is_anonymous boolean, created_at timestamptz, updated_at timestamptz
      );
    `);
    const dir = path.join(root, 'supabase/migrations');
    const migrations = fs.readdirSync(dir).filter(name => /^\d+_server_durak_actions\.sql$/.test(name));
    assert.equal(migrations.length, 1, 'Expected one canonical server Durak migration');
    await db.exec(fs.readFileSync(path.join(dir, migrations[0]), 'utf8'));
    await db.exec(fs.readFileSync(path.join(root, 'tests/server-durak.sql'), 'utf8'));
    for (const table of ['auth.users','vezdehot_private.server_durak_games','vezdehot_private.server_durak_receipts']) {
      assert.equal((await db.query('select count(*)::integer as n from '+table)).rows[0].n, 0, 'SQL fixtures must be rolled back');
    }
    console.log('PASS server-durak.sql: functional/security assertions; fixtures rolled back');
  } finally { await db.close(); }
})().catch(error => {console.error(error); process.exitCode = 1});
