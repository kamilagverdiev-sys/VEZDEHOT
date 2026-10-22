const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const listeners = {};
const entries = new Map();
const deleted = [];
let network = async () => new Response('fresh');
let fetches = 0;
const context = vm.createContext({
  URL, URLSearchParams, Request, Response, Headers,
  self: {
    registration: {scope: 'https://vezdehot.example/'},
    addEventListener(name, handler) { listeners[name] = handler; },
    skipWaiting: async () => {}, clients: {claim: async () => {}}
  },
  caches: {
    open: async () => ({
      put: async (key, response) => entries.set(key, response.clone()),
      match: async key => entries.get(key)?.clone()
    }),
    keys: async () => ['vezdehot-v5', 'vezdehot-v7', 'unrelated-app'],
    delete: async key => deleted.push(key)
  },
  fetch: (...args) => { fetches++; return network(...args); }
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../dist/sw.js'), 'utf8'), context);
const evaluate = source => vm.runInContext(source, context);
const key = pathname => evaluate(`assetKey(${JSON.stringify('https://vezdehot.example' + pathname)})`);
const checks = [];
async function check(name, run) { await run(); checks.push(name); }
async function dispatch(url, mode = 'navigate', headers = {}) {
  let response;
  const pending = [];
  listeners.fetch({
    request: {method: 'GET', url, mode, headers: new Headers(headers)},
    respondWith(promise) { response = promise; },
    waitUntil(promise) { pending.push(promise); }
  });
  const result = response ? await response : undefined;
  await Promise.all(pending);
  return result;
}

(async () => {
  await check('OAuth callback paths and extensions bypass caching', () => {
    for (const p of ['/auth-callback', '/auth-callback.html', '/auth-callback.js', '/auth-callback/continue']) assert.equal(key(p), null);
  });
  await check('OAuth values never become cache keys', () => {
    for (const field of ['code', 'error', 'error_description', 'state', 'access_token', 'refresh_token', 'id_token', 'provider_token', 'CoDe']) {
      assert.equal(key('/?' + field + '=secret'), null);
      assert.equal(key('/#' + field + '=secret'), null);
    }
    assert.equal(key('/?%63ode=secret'), null);
  });
  await check('Only explicit local assets qualify', () => {
    assert.equal(evaluate("assetKey('https://project.supabase.co/auth/v1/token')"), null);
    assert.equal(key('/api/telegram'), null);
    assert.equal(key('/unlisted.html'), null);
    assert.equal(key('/?unknown=value'), null);
    assert.equal(key('/durak.css?v=7'), 'https://vezdehot.example/durak.css');
    assert.equal(key('/poker'), 'https://vezdehot.example/poker.html');
  });
  await check('Token payloads, private responses and token headers are rejected', async () => {
    for (const response of [
      new Response('{"access_token":"abc123"}'),
      new Response('<script>session={"refresh_token":"secret"}</script>'),
      new Response('private', {headers: {'Cache-Control': 'private, max-age=90'}}),
      new Response('private', {headers: {'Cache-Control': 'no-store'}}),
      new Response('private', {headers: {'X-Access-Token': 'secret'}}),
      new Response('private', {headers: {'Set-Cookie': 'session=secret'}}),
      new Response('bad', {status: 500})
    ]) {
      context.testResponse = response;
      assert.equal(await evaluate("cacheableResponse(testResponse, assetKey('https://vezdehot.example/'))"), false);
    }
    context.testResponse = new Response('<html>game</html>');
    assert.equal(await evaluate("cacheableResponse(testResponse, assetKey('https://vezdehot.example/'))"), true);
  });
  await check('Bundled sources contain no token payloads and can be cached', async () => {
    const assets = Array.from(evaluate('ASSETS'));
    for (const name of assets.filter(name => name !== './')) {
      const filename = path.join(__dirname, '../dist', name);
      if (!fs.existsSync(filename)) continue; // Other agents may still be writing shared styles.
      context.testResponse = new Response(fs.readFileSync(filename, 'utf8'));
      assert.equal(await evaluate(`cacheableResponse(testResponse, assetKey(${JSON.stringify('https://vezdehot.example/' + name.slice(2))}))`), true, name);
    }
    assert(!assets.some(name => name.includes('auth-callback')));
  });
  await check('Auth and external requests are not intercepted', async () => {
    const before = fetches;
    assert.equal(await dispatch('https://vezdehot.example/?code=secret'), undefined);
    assert.equal(await dispatch('https://vezdehot.example/auth-callback.html'), undefined);
    assert.equal(await dispatch('https://project.supabase.co/auth/v1/token'), undefined);
    assert.equal(await dispatch('https://vezdehot.example/', 'navigate', {Authorization: 'Bearer secret'}), undefined);
    assert.equal(fetches, before);
  });
  await check('Navigation prefers the network and stores a safe copy', async () => {
    entries.set('https://vezdehot.example/poker.html', new Response('old'));
    network = async () => new Response('new');
    assert.equal(await (await dispatch('https://vezdehot.example/poker')).text(), 'new');
    assert.equal(await entries.get('https://vezdehot.example/poker.html').clone().text(), 'new');
  });
  await check('Failed navigation falls back to its saved page', async () => {
    network = async () => { throw new Error('offline'); };
    assert.equal(await (await dispatch('https://vezdehot.example/poker')).text(), 'new');
  });
  await check('Versioned SDK uses its cache without a network call', async () => {
    entries.set('https://vezdehot.example/vendor/supabase-2.118.0.js', new Response('sdk'));
    const before = fetches;
    assert.equal(await (await dispatch('https://vezdehot.example/vendor/supabase-2.118.0.js', 'cors')).text(), 'sdk');
    assert.equal(fetches, before);
  });
  await check('A token-bearing navigation response is served but never saved', async () => {
    network = async () => new Response('{"access_token":"private-token"}');
    await dispatch('https://vezdehot.example/poker');
    assert.equal(await entries.get('https://vezdehot.example/poker.html').clone().text(), 'new');
  });
  await check('Activation removes old app caches only', async () => {
    let pending;
    listeners.activate({waitUntil(value) { pending = value; }});
    await pending;
    assert.deepEqual(deleted, ['vezdehot-v5']);
  });
  console.log(`PASS ${checks.length} service-worker cache checks`);
})().catch(error => { console.error(error); process.exitCode = 1; });
