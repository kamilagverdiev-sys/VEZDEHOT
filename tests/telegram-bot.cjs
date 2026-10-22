'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../api/telegram.js'), 'utf8');
const secret = 'test_webhook_secret_123456789';
const fakeToken = '123456:FAKE_TOKEN_FOR_LOCAL_TESTS_123456789';
const success = () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });

function harness(fetchImpl) {
  const calls = [], env = { TELEGRAM_BOT_TOKEN: fakeToken, TELEGRAM_WEBHOOK_SECRET: secret };
  const box = { module: { exports: {} }, require, Buffer, AbortSignal, process: { env }, fetch: async (...args) => {
    calls.push(args); return fetchImpl ? fetchImpl(...args) : success();
  } };
  vm.runInNewContext(source, box, { filename: 'api/telegram.js' });
  return { handler: box.module.exports, calls, env };
}
function update(id = 1, text = '/start', extra = {}) {
  return { update_id: id, message: { chat: { id: 123, type: 'private' }, from: { id: 123, is_bot: false }, text, ...extra } };
}
async function request(h, body = update(), options = {}) {
  const headers = { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret, ...options.headers };
  const req = options.stream ? Readable.from(options.stream) : {};
  Object.assign(req, { method: options.method || 'POST', headers });
  if (!options.stream) req.body = body;
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(text) { this.body = JSON.parse(text); } };
  await h.handler(req, res); return res;
}
let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log('✓ ' + name); }

(async () => {
  await check('secret required, constant-time verification, no outgoing work before authorization', async () => {
    const h = harness();
    assert.equal((await request(h, update(), { headers: { 'x-telegram-bot-api-secret-token': '' } })).statusCode, 401);
    assert.equal((await request(h, update(), { headers: { 'x-telegram-bot-api-secret-token': 'x'.repeat(secret.length) } })).statusCode, 401);
    assert.equal((await request(h, update(), { headers: { 'x-telegram-bot-api-secret-token': ['invalid', secret] } })).statusCode, 401);
    h.env.TELEGRAM_WEBHOOK_SECRET = '';
    assert.equal((await request(h)).statusCode, 503);
    assert.equal(h.calls.length, 0);
  });
  await check('method, JSON, parsed/raw/stream body bounds and invalid updates', async () => {
    const h = harness();
    assert.equal((await request(h, update(), { method: 'GET' })).statusCode, 405);
    assert.equal((await request(h, update(), { headers: { 'content-type': 'text/plain' } })).statusCode, 415);
    assert.equal((await request(h, update(), { headers: { 'content-length': '65537' } })).statusCode, 413);
    assert.equal((await request(h, ' '.repeat(65537))).statusCode, 413);
    assert.equal((await request(h, { payload: 'x'.repeat(65537) })).statusCode, 413);
    assert.equal((await request(h, null, { stream: [Buffer.alloc(64000), Buffer.alloc(2000)] })).statusCode, 413);
    assert.equal((await request(h, '{')).statusCode, 400);
    assert.equal((await request(h, {})).statusCode, 400);
    assert.equal((await request(h, { update_id: Number.MAX_SAFE_INTEGER + 1 })).statusCode, 400);
    assert.equal(h.calls.length, 0);
    assert.equal((await request(h, null, { stream: [JSON.stringify(update(99, '/help'))] })).statusCode, 200);
    assert.equal(h.calls.length, 1);
  });
  await check('groups, bots, mismatched users, edited messages and prose produce no reply', async () => {
    const h = harness();
    for (const data of [
      update(1, '/start', { chat: { id: -100, type: 'group' } }),
      update(2, '/start', { from: { id: 123, is_bot: true } }),
      update(3, '/start', { from: { id: 456, is_bot: false } }),
      { update_id: 4, edited_message: update().message },
      update(5, 'hello'), update(6, '/admin'), update(7, '/claim'), update(8, '/playevil')
    ]) assert.equal((await request(h, data)).statusCode, 200);
    assert.equal(h.calls.length, 0);
  });
  await check('all five commands, game deep links and profile stay on fixed HTTPS origin', async () => {
    const h = harness(); let id = 10;
    for (const command of ['/start', '/play', '/games', '/profile', '/help', '/play durak', '/play bunker', '/play poker', '/play mafia', '/play monopoly', '/start@VezdehotBot mafia']) {
      assert.equal((await request(h, update(id++, command))).statusCode, 200);
      const [url, options] = h.calls.at(-1), payload = JSON.parse(options.body);
      assert.equal(url, `https://api.telegram.org/bot${fakeToken}/sendMessage`);
      assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
      assert.equal(payload.chat_id, 123);
      for (const button of payload.reply_markup.inline_keyboard.flat()) assert.equal(new URL(button.web_app.url).origin, 'https://vezdehot.vercel.app');
      if (command === '/profile') {
        assert.match(payload.text, /не создаёт и не подтверждает аккаунт/);
        assert.match(payload.reply_markup.inline_keyboard[0][0].web_app.url, /profile=1$/);
      }
      if (command.startsWith('/play ') && ['durak', 'bunker'].includes(command.split(' ')[1])) assert.match(payload.reply_markup.inline_keyboard[0][0].web_app.url, /index.html\?game=/);
      assert.ok(!options.body.includes(fakeToken));
    }
  });
  await check('arbitrary command arguments cannot turn into links or prototype fields', async () => {
    const h = harness(); let id = 30;
    for (const slug of ['https://evil.example', '__proto__', 'constructor', 'toString']) {
      await request(h, update(id++, '/play ' + slug));
      const payload = JSON.parse(h.calls.at(-1)[1].body);
      assert.equal(payload.reply_markup.inline_keyboard.length, 4);
      assert.ok(!JSON.stringify(payload).includes('evil.example'));
    }
  });
  await check('completed and concurrent update replays send once in a warm instance', async () => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const h = harness(async () => { await gate; return success(); });
    const first = request(h, update(50)), second = request(h, update(50));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.calls.length, 1); release();
    assert.equal((await first).statusCode, 200); assert.equal((await second).statusCode, 200);
    assert.equal((await request(h, update(50))).statusCode, 200); assert.equal(h.calls.length, 1);
  });
  await check('delivery failure allows retry; blocked chats stop retrying; errors never echo secrets', async () => {
    let attempt = 0;
    const h = harness(async () => { if (!attempt++) throw new Error(fakeToken); return success(); });
    const failed = await request(h, update(60));
    assert.equal(failed.statusCode, 502); assert.ok(!JSON.stringify(failed).includes(fakeToken));
    assert.equal((await request(h, update(60))).statusCode, 200); assert.equal(h.calls.length, 2);
    const blocked = harness(async () => new Response('{}', { status: 403 }));
    assert.equal((await request(blocked, update(61))).statusCode, 200);
    await request(blocked, update(61)); assert.equal(blocked.calls.length, 1);
    const oversized = harness(async () => new Response('x'.repeat(65537)));
    assert.equal((await request(oversized, update(62))).statusCode, 502);
  });
  await check('Mini App SDK loads only with launch markers and never authenticates a profile', async () => {
    const bridge = fs.readFileSync(path.join(__dirname, '../dist/telegram.js'), 'utf8');
    function boot(hash, search = '', app, priorMarker = false) {
      const added = [], styles = {}, events = {}, counts = { ready: 0, expand: 0, back: 0 };
      const stored = new Map(priorMarker ? [['vezdehot:telegram-launch', '1']] : []);
      const tg = app ? { viewportStableHeight: 700, safeAreaInset: { top: 20 }, contentSafeAreaInset: { top: 44 }, ready: () => counts.ready++, expand: () => counts.expand++, isVersionAtLeast: () => true, onEvent: (n, fn) => events[n] = fn, BackButton: { onClick: fn => events.back = fn, show: () => counts.back++, hide() {} } } : undefined;
      const box = { URLSearchParams, URL, CustomEvent: function(type) { this.type = type; }, sessionStorage: { getItem: k => stored.get(k), setItem: (k,v) => stored.set(k,v) }, location: { hash, search, pathname: '/mafia.html', href: 'https://vezdehot.vercel.app/mafia.html', assign: url => { counts.destination = url; } }, window: { Telegram: tg ? { WebApp: tg } : undefined }, document: { dispatchEvent: event => { counts.dispatched = event.type; }, documentElement: { classList: { add() {} }, style: { setProperty: (n,v) => styles[n] = v } }, head: { appendChild: el => added.push(el) }, createElement: tag => ({ tag }) } };
      vm.runInNewContext(bridge, box); return { added, styles, events, counts, stored };
    }
    assert.equal(boot('').added.length, 0);
    assert.equal(boot('', '?source=telegram').added.length, 0);
    assert.equal(boot('#tgWebAppVersion=8.0').added.length, 0);
    const load = boot('#tgWebAppData=opaque'); assert.equal(load.added[0].src, 'https://telegram.org/js/telegram-web-app.js?64');
    assert.equal(load.stored.size, 1); assert.equal(load.stored.get('vezdehot:telegram-launch'), '1');
    assert.equal(boot('', '', false, true).added[0].src, 'https://telegram.org/js/telegram-web-app.js?64');
    const live = boot('#tgWebAppVersion=8.0&tgWebAppPlatform=ios', '', true);
    assert.equal(live.counts.ready, 1); assert.equal(live.counts.expand, 1); assert.equal(live.counts.back, 1);
    assert.equal(live.styles['--vh-tg-top'], '64px');
    assert.equal(live.counts.dispatched, 'vezdehot:telegramready');
    assert.ok(live.events.safeAreaChanged); live.events.back();
    assert.equal(live.counts.destination, 'https://vezdehot.vercel.app/index.html');
    assert.ok(!bridge.includes('initDataUnsafe')); assert.ok(!bridge.includes('updateProfile'));
  });
  console.log(`Telegram: ${checks} checks passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
