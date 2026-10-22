const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const path = require('node:path');

(async () => {
  const {BOT_ID, TELEGRAM_PUBLIC_KEY, ALLOWED_ORIGINS, verifyInitData, createHandler} = await import(pathToFileURL(path.resolve(__dirname, '../supabase/functions/telegram-auth/index.ts')).href);
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex');
  const timestamp = 1792670000000;
  const telegramId = 123456789;
  const userId = 'bd594ecb-c7b7-4d46-926c-342155a6d301';
  const otherUserId = '06687798-d64b-4e8f-a4fb-0a67055373d3';
  const origin = 'https://vezdehot.vercel.app';
  let count = 0;
  async function test(name, run) { await run(); count++; process.stdout.write(`✓ ${name}\n`); }
  async function signed({id = telegramId, authDate = timestamp / 1000, bot = BOT_ID, extra = {}} = {}) {
    const values = {auth_date: String(authDate), user: JSON.stringify({id, first_name: 'Лена', last_name: 'Игрок'}), ...extra};
    const data = bot + ':WebAppData\n' + Object.entries(values).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
    const signature = Buffer.from(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(data))).toString('base64url');
    return new URLSearchParams({...values, signature, hash: 'unused-by-ed25519'}).toString();
  }
  const valid = await signed();
  const verify = value => verifyInitData(value, {publicKey, now: timestamp});
  const denied = value => assert.rejects(() => verify(value), error => error.status === 401);
  function service(overrides = {}) {
    const calls = [];
    const canonical = {id: userId, email: `telegram-${telegramId}@users.vezdehot.invalid`, app_metadata: {telegram_id: String(telegramId), auth_provider: 'telegram'}};
    let row = overrides.unmapped ? null : {telegram_id: telegramId, user_id: userId};
    let createdUser = false;
    const fetcher = async (url, options) => {
      const route = new URL(url);
      const method = options.method;
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({url, method, body, options});
      assert.equal(options.headers.apikey, 'server-secret-fixture');
      assert.equal(options.headers.Authorization, 'Bearer server-secret-fixture');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      let status = 200, value;
      if (route.pathname === '/rest/v1/telegram_identities' && method === 'GET') {
        assert.equal(route.searchParams.get('telegram_id'), `eq.${telegramId}`);
        value = row ? [row] : [];
        if (overrides.mapReadFailsAfterCreate && createdUser) {status = 500; value = {error: 'unavailable'};}
      } else if (route.pathname === '/auth/v1/admin/users' && method === 'POST') {
        if (overrides.createConflict) { status = 422; value = {error: 'already_exists'}; if (overrides.concurrentMap) row = {telegram_id: telegramId, user_id: userId}; }
        else { value = canonical; createdUser = true; }
      } else if (route.pathname === '/rest/v1/telegram_identities' && method === 'POST') {
        if (overrides.mapThrow) throw new Error('network failure');
        if (overrides.mapConflict) { status = 409; value = {error: 'conflict'}; }
        else { row = body; value = [row]; }
      } else if (route.pathname === `/auth/v1/admin/users/${userId}` && method === 'DELETE') {
        assert.equal(createdUser, true); assert.equal(row, null); value = {};
      } else if (route.pathname === `/auth/v1/admin/users/${userId}`) {
        value = overrides.account || canonical;
      } else if (route.pathname === '/auth/v1/admin/generate_link') {
        value = {...(overrides.linkAccount || canonical), hashed_token: 'hash-fixture', verification_type: 'magiclink', email_otp: '123456', action_link: 'https://not-returned.example'};
      } else throw new Error('Unexpected endpoint');
      return new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});
    };
    let clock = timestamp;
    const handler = createHandler({publicKey, now: () => clock, fetch: fetcher, env: name => ({SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-secret-fixture'}[name])});
    return {calls, handler, advance: ms => {clock += ms;}, canonical};
  }
  function request(data = valid, options = {}) {
    const {method = 'POST', origin: reqOrigin = origin, body, headers = {}} = options;
    return new Request('https://fixture.supabase.co/functions/v1/telegram-auth', {method, headers: {origin: reqOrigin, 'Content-Type': 'application/json', ...headers}, ...(method === 'OPTIONS' || method === 'GET' ? {} : {body: body ?? JSON.stringify({initData: data})})});
  }
  await test('fixed production bot and Telegram public key, exact origins', () => {
    assert.equal(BOT_ID, '8412086640');
    assert.equal(TELEGRAM_PUBLIC_KEY, 'e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d');
    assert.deepEqual([...ALLOWED_ORIGINS], [origin, 'https://vezdehot.greysquid7.chatgpt.site']);
  });
  await test('valid Ed25519 signature yields signed identity', async () => assert.deepEqual(await verify(valid), {id: String(telegramId), name: 'Лена Игрок', authDate: timestamp / 1000}));
  await test('tampered user data and signature rejected', async () => {
    await denied(valid.replace(String(telegramId), '987654321'));
    const params = new URLSearchParams(valid); params.set('signature', 'A'.repeat(86)); await denied(params.toString());
  });
  await test('signature for a different bot rejected', async () => denied(await signed({bot: '8412086641'})));
  await test('production handler rejects a signature made with test key', async () => {
    await assert.rejects(() => verifyInitData(valid, {now: timestamp}), error => error.status === 401);
  });
  await test('stale data and more than 30 seconds in future rejected', async () => {
    await denied(await signed({authDate: timestamp / 1000 - 601}));
    await denied(await signed({authDate: timestamp / 1000 + 31}));
    await verify(await signed({authDate: timestamp / 1000 - 600}));
    await verify(await signed({authDate: timestamp / 1000 + 30}));
  });
  await test('duplicate decoded params and malformed encoding rejected', async () => {
    await denied(valid + '&auth_date=123');
    await denied(valid + '&%75ser=%7B%7D');
    await denied(valid + '&hash=x');
    await denied(valid + '&x=%E0%A4%A');
  });
  await test('unsafe, string, zero, negative and fractional Telegram IDs rejected', async () => {
    for (const id of [0, -1, 1.5, '123456789', Number.MAX_SAFE_INTEGER + 1, null]) await denied(await signed({id}));
  });
  await test('allowed CORS preflight needs no backend or credentials', async () => {
    const backend = service(); const response = await backend.handler(request(valid, {method: 'OPTIONS'}));
    assert.equal(response.status, 204); assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    assert.ok(response.headers.get('Access-Control-Allow-Headers').includes('apikey')); assert.equal(backend.calls.length, 0);
  });
  await test('foreign, null, missing and deceptive subdomain origins blocked', async () => {
    for (const reqOrigin of ['https://evil.test', 'null', '', 'https://vezdehot.vercel.app.evil.test']) {
      const backend = service(); const response = await backend.handler(request(valid, {origin: reqOrigin}));
      assert.equal(response.status, 403); assert.equal(response.headers.get('Access-Control-Allow-Origin'), null); assert.equal(backend.calls.length, 0);
    }
  });
  await test('invalid signature never reaches service role API', async () => {
    const backend = service(); const response = await backend.handler(request(valid + '&user=x'));
    assert.equal(response.status, 401); assert.equal(backend.calls.length, 0);
  });
  await test('body size, content type and unexpected fields rejected before backend', async () => {
    for (const [options, expected] of [
      [{body: JSON.stringify({initData: 'x'.repeat(17000)})}, 413],
      [{headers: {'content-length': '99999'}}, 413],
      [{headers: {'content-type': 'text/plain'}}, 415],
      [{body: JSON.stringify({initData: valid, user_id: otherUserId})}, 400],
      [{body: '{'}, 400],
    ]) { const backend = service(); const response = await backend.handler(request(valid, options)); assert.equal(response.status, expected); assert.equal(backend.calls.length, 0); }
  });
  await test('mapped exchange returns token hash only and targets authoritative account', async () => {
    const backend = service(); const response = await backend.handler(request());
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), {token_hash: 'hash-fixture', type: 'magiclink'});
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(backend.calls.length, 3);
    assert.deepEqual(backend.calls[2].body, {type: 'magiclink', email: backend.canonical.email});
  });
  await test('new account uses confirmed synthetic email and trusted server metadata', async () => {
    const backend = service({unmapped: true}); const response = await backend.handler(request());
    assert.equal(response.status, 200);
    const created = backend.calls.find(call => call.url.endsWith('/admin/users'));
    assert.deepEqual(created.body, {email: `telegram-${telegramId}@users.vezdehot.invalid`, email_confirm: true, user_metadata: {full_name: 'Лена Игрок', name: 'Лена Игрок'}, app_metadata: {telegram_id: String(telegramId), auth_provider: 'telegram'}});
    const mapped = backend.calls.find(call => call.method === 'POST' && call.url.endsWith('/telegram_identities'));
    assert.deepEqual(mapped.body, {telegram_id: String(telegramId), user_id: userId});
  });
  await test('email collision never adopts or looks up a preexisting account', async () => {
    const backend = service({unmapped: true, createConflict: true}); const response = await backend.handler(request());
    assert.equal(response.status, 409); assert.equal(backend.calls.filter(call => call.url.includes('generate_link')).length, 0);
    assert.equal(backend.calls.filter(call => call.method === 'GET' && call.url.includes('/auth/')).length, 0);
  });
  await test('concurrent creator is resolved only through authoritative mapping', async () => {
    const backend = service({unmapped: true, createConflict: true, concurrentMap: true}); const response = await backend.handler(request());
    assert.equal(response.status, 200); assert.equal(backend.calls.filter(call => call.url.includes('generate_link')).length, 1);
  });
  await test('failed mapping insert rolls back only this newly created unmapped user', async () => {
    const backend = service({unmapped: true, mapConflict: true}); const response = await backend.handler(request());
    assert.equal(response.status, 409); assert.equal(backend.calls.filter(call => call.url.includes('generate_link')).length, 0);
    assert.equal(backend.calls.filter(call => call.method === 'DELETE').length, 1);
  });
  await test('ambiguous insert network failure rechecks mapping before rollback', async () => {
    const backend = service({unmapped: true, mapThrow: true}); const response = await backend.handler(request());
    assert.equal(response.status, 409); assert.equal(backend.calls.filter(call => call.method === 'DELETE').length, 1);
  });
  await test('unavailable authoritative lookup never deletes an account', async () => {
    const backend = service({unmapped: true, mapThrow: true, mapReadFailsAfterCreate: true}); const response = await backend.handler(request());
    assert.equal(response.status, 503); assert.equal(backend.calls.filter(call => call.method === 'DELETE').length, 0);
  });
  await test('user metadata cannot impersonate trusted app metadata', async () => {
    const backend = service({account: {id: userId, email: 'victim@example.com', app_metadata: {}, user_metadata: {telegram_id: String(telegramId)}}});
    const response = await backend.handler(request()); assert.equal(response.status, 503);
    assert.equal(backend.calls.filter(call => call.url.includes('generate_link')).length, 0);
  });
  await test('mismatched mapped identity or returned user ID cannot issue a token', async () => {
    for (const account of [
      {id: userId, email: 'victim@example.com', app_metadata: {telegram_id: '999999'}},
      {id: otherUserId, email: 'victim@example.com', app_metadata: {telegram_id: String(telegramId)}},
    ]) { const backend = service({account}); const response = await backend.handler(request()); assert.equal(response.status, 503); assert.equal(backend.calls.filter(call => call.url.includes('generate_link')).length, 0); }
  });
  await test('generateLink target race cannot expose another account token', async () => {
    const backend = service({linkAccount: {id: otherUserId, email: 'victim@example.com', app_metadata: {telegram_id: String(telegramId)}}});
    const response = await backend.handler(request()); assert.equal(response.status, 503);
    assert.equal(JSON.stringify(await response.json()).includes('hash-fixture'), false);
  });
  await test('rate limit expires instead of permanently consuming initData', async () => {
    const backend = service(); assert.equal((await backend.handler(request())).status, 200);
    const limited = await backend.handler(request()); assert.equal(limited.status, 429); assert.equal(limited.headers.get('Retry-After'), '1');
    backend.advance(1001); assert.equal((await backend.handler(request())).status, 200);
  });
  process.stdout.write(`Telegram native auth: ${count} tests passed.\n`);
})().catch(error => { console.error(error); process.exitCode = 1; });
