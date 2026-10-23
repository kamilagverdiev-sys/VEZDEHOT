'use strict';
// Lifecycle and real event-binding checks. DOM layout is verified separately in a browser.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const html = fs.readFileSync(path.join(__dirname, '../dist/poker.html'), 'utf8');
const inline = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const PROFILE = 'poker-test-profile', SESSION = 'vezdehot_poker_v2_guest';
const plain = value => JSON.parse(JSON.stringify(value));

async function harness({ store = new Map(), failRecord = false, scope = 'guest' } = {}) {
  const events = new Map(), groups = new Map(), timers = new Map();
  let nextTimer = 0, seed = 88091, renderCount = 0, recordCalls = 0, profileOpens = 0;
  const initial = { nick: 'Игрок', balance: 10000, games: 0, wins: 0, xp: 0, resultIds: [], history: [] };
  let profile = JSON.parse(store.get(PROFILE) || JSON.stringify(initial));
  const persistProfile = () => store.set(PROFILE, JSON.stringify(profile));
  const rules = { open: false, addEventListener() {}, showModal() { this.open = true; }, close() { this.open = false; } };
  const app = { style: {}, inert: false }, closeRules = {};
  const selectors = new Map([['#app', app], ['#rules', rules], ['#close-rules', closeRules]]);
  for (const selector of ['[data-start]', '[data-new]', '[data-next]', '[data-cashout]', '[data-settings]', '[data-account]', '[data-resolve]']) groups.set(selector, [{}]);
  const platform = {
    ready: Promise.resolve(), scopeKey: () => scope,
    getProfile: () => plain(profile),
    updateProfile(patch) { profile = { ...profile, ...plain(patch) }; persistProfile(); },
    recordResult(entry) {
      recordCalls++;
      if (failRecord) throw new Error('Simulated local write failure');
      if (profile.resultIds.includes(entry.id)) return plain(profile);
      profile = { ...profile, balance: profile.balance + entry.delta, games: profile.games + 1,
        wins: profile.wins + (entry.win ? 1 : 0), xp: profile.xp + entry.xp,
        resultIds: [...profile.resultIds, entry.id], history: [plain(entry), ...profile.history] };
      persistProfile(); return plain(profile);
    },
    openAccount() { profileOpens++; }
  };
  const document = {
    hidden: false, rendered: '', documentElement: { dataset: {}, classList: { contains: () => false } }, body: { classList: { contains: () => false } },
    querySelector: selector => selectors.get(selector) || null,
    querySelectorAll: selector => groups.get(selector) || [],
    addEventListener(name, fn) { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); }
  };
  const context = {
    console, Date, Promise, AbortController,
    Math: Object.assign(Object.create(Math), { random() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; } }),
    document,
    window: { VEZDEHOT: platform, matchMedia: () => ({ matches: true }), addEventListener(name, fn) { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); } },
    localStorage: { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) },
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    __rendered() { renderCount++; }
  };
  // Replace only DOM patching, retaining shipped lifecycle functions, controls and event handlers.
  const exposure = `
render = function () { document.rendered = g ? controls() : intro(); bind(); __rendered(); };
window.__poker = { get g() { return g; }, get error() { return error; }, get accountChanging() { return accountChanging; },
  startHand, nextHand, closeTable, syncResult, commitUI, saveHand, controls, notice, bind, boot,
  pokerNewGame, pokerAction, pokerFinish, pokerContinue, legalActions, tableFinished,
  resultTitle, resultReason, resultDetails, outcomeBanner, finishWatching, raisePresets, raiseLabel, raisePreview, view, setRaise(value) { selectedRaise=value; } };
boot();`;
  assert.ok(inline.includes('\nboot();\n'), 'Expected the shipped bootstrap call');
  vm.createContext(context); vm.runInContext(inline.replace('\nboot();\n', '\n' + exposure + '\n'), context, { filename: 'poker.html' });
  await Promise.resolve(); await Promise.resolve();
  return {
    api: context.window.__poker, context, store, timers, app, groups,
    profile: () => plain(profile), output: () => document.rendered, recordCalls: () => recordCalls,
    renderCount: () => renderCount, profileOpens: () => profileOpens,
    setFailRecord(value) { failRecord = value; },
    setProfile(patch) { Object.assign(profile, patch); persistProfile(); },
    dispatch(name, event = {}) { for (const fn of events.get(name) || []) fn(event); },
    click(selector) { const button = groups.get(selector)?.[0]; assert.equal(typeof button?.onclick, 'function', 'Missing real binding: ' + selector); button.onclick({ currentTarget: button }); }
  };
}

function finishWithHumanWinner(h) {
  const g = h.api.g; g.paused = false;
  let actions = 0;
  while (!g.over && actions++ < 20) {
    assert.equal(g.phase, 'betting');
    const i = g.toAct, legal = h.api.legalActions(g, i);
    assert.ok(h.api.pokerAction(g, i, i === 0 ? (legal.check ? 'check' : 'call') : 'fold'));
  }
  assert.ok(g.over); h.api.commitUI(); return g;
}

let count = 0;
async function test(name, fn) { await fn(); count++; console.log('PASS ' + name); }
(async () => {
  await test('sitting down charges once, and an active table rejects a second entry', async () => {
    const h = await harness(); h.click('[data-start]'); const id = h.api.g.id;
    assert.equal(h.profile().balance, 9900); assert.equal(h.api.g.version, 3); assert.equal(h.api.g.handNumber, 1);
    h.click('[data-start]'); h.click('[data-new]');
    assert.equal(h.api.g.id, id); assert.equal(h.profile().balance, 9900); assert.equal(h.profile().games, 0);
  });
  await test('next hand preserves the table, every stack and wallet without another setup or fee', async () => {
    const h = await harness(); h.click('[data-start]'); const first = finishWithHumanWinner(h);
    const stacks = plain(first.players.map(p => p.chips)), wallet = h.profile().balance;
    assert.equal(h.recordCalls(), 0); assert.equal(h.profile().games, 0); assert.equal(first.settled, false);
    assert.match(h.output(), /data-next/); assert.match(h.output(), /data-cashout/);
    h.click('[data-next]');
    assert.notEqual(h.api.g.id, first.id); assert.equal(h.api.g.tableId, first.tableId); assert.equal(h.api.g.handNumber, 2);
    assert.deepEqual(plain(h.api.g.handStartChips), stacks); assert.equal(h.profile().balance, wallet);
    assert.equal(h.api.g.difficulty, first.difficulty); assert.equal(h.api.g.tableHistory.length, 1);
    const secondId = h.api.g.id; h.click('[data-next]');
    assert.equal(h.api.g.id, secondId); assert.equal(h.api.g.handNumber, 2); assert.equal(h.profile().balance, wallet);
  });
  await test('cashout is unavailable during a hand and preserves the active table', async () => {
    const h = await harness(); h.click('[data-start]'); const id = h.api.g.id;
    assert.ok(!h.output().includes('data-cashout')); h.click('[data-cashout]');
    assert.equal(h.api.g.id, id); assert.equal(h.api.g.tableClosed, false); assert.equal(h.profile().balance, 9900); assert.equal(h.recordCalls(), 0);
  });
  await test('cashout credits the completed table once and repeated clicks cannot create another result', async () => {
    const h = await harness(); h.click('[data-start]'); const g = finishWithHumanWinner(h), payout = g.payout;
    h.click('[data-cashout]'); h.click('[data-cashout]'); h.api.syncResult();
    assert.equal(h.profile().balance, 9900 + payout); assert.equal(h.profile().games, 1); assert.equal(h.recordCalls(), 1);
    assert.equal(h.profile().history[0].id, g.tableId); assert.equal(h.api.g.settled, true); assert.equal(h.api.g.tableClosed, true);
    const restored = await harness({ store: h.store });
    assert.equal(restored.profile().balance, 9900 + payout); assert.equal(restored.profile().games, 1); assert.equal(restored.recordCalls(), 0);
    assert.ok(!restored.output().includes('data-next')); assert.match(restored.output(), /data-new/);
  });
  await test('reload of an unfinished table resumes paused without charging or cashing out', async () => {
    const h = await harness(); h.click('[data-start]'); const id = h.api.g.id;
    const restored = await harness({ store: h.store });
    assert.equal(restored.api.g.id, id); assert.equal(restored.api.g.paused, true); assert.equal(restored.profile().balance, 9900);
    assert.equal(restored.recordCalls(), 0); assert.equal(restored.timers.size, 0);
  });
  await test('failed cashout remains retryable after reload and never discards its payout', async () => {
    const h = await harness({ failRecord: true }); h.click('[data-start]'); const g = finishWithHumanWinner(h);
    h.click('[data-cashout]');
    assert.equal(h.api.g.settled, false); assert.equal(h.api.g.tableClosed, true); assert.equal(h.profile().balance, 9900);
    assert.match(h.api.error, /повторить/); assert.match(h.output(), /data-cashout/);
    const restored = await harness({ store: h.store });
    assert.equal(restored.api.g.settled, true); assert.equal(restored.profile().balance, 9900 + g.payout); assert.equal(restored.profile().games, 1);
  });
  await test('profile deduplication recovers a crash after payout but before the table settled flag was saved', async () => {
    const h = await harness(); h.click('[data-start]'); const g = finishWithHumanWinner(h); h.click('[data-cashout]');
    const saved = JSON.parse(h.store.get(SESSION)); saved.settled = false; h.store.set(SESSION, JSON.stringify(saved));
    const restored = await harness({ store: h.store });
    assert.equal(restored.profile().balance, 9900 + g.payout); assert.equal(restored.profile().games, 1); assert.equal(restored.recordCalls(), 1);
    assert.equal(restored.api.g.settled, true); assert.equal(restored.profile().history.length, 1);
  });
  await test('a human bust settles a zero payout and prevents another hand at the same table', async () => {
    const h = await harness(); h.click('[data-start]'); const g = finishWithHumanWinner(h);
    g.players[1].chips += g.players[0].chips; g.players[0].chips = 0;
    Object.assign(g, { payout: 0, profit: -100, win: false, draw: false, handProfit: -g.handStartChips[0] });
    h.api.commitUI();
    assert.equal(h.profile().balance, 9900); assert.equal(h.profile().games, 1); assert.equal(h.api.g.tableClosed, true);
    assert.equal(h.api.g.settled, true); assert.ok(!h.output().includes('data-next'));
    h.click('[data-next]'); assert.equal(h.api.g.id, g.id);
  });
  await test('completed legacy v2 saves do not pay again and new-table action enters directly', async () => {
    const h = await harness(); h.click('[data-start]'); const g = finishWithHumanWinner(h);
    Object.assign(g, { version: 2, settled: true }); h.api.saveHand();
    h.setProfile({ balance: 10000 + g.profit, games: 1, resultIds: [g.id] });
    const restored = await harness({ store: h.store }); const balance = restored.profile().balance;
    assert.equal(restored.recordCalls(), 0); assert.equal(restored.profile().games, 1);
    restored.click('[data-new]');
    assert.equal(restored.api.g.version, 3); assert.notEqual(restored.api.g.id, g.id); assert.equal(restored.profile().balance, balance - 100);
  });
  await test('an unfinished legacy hand can complete under its old payout contract exactly once', async () => {
    const h = await harness(); h.click('[data-start]'); h.api.g.version = 2; h.api.saveHand();
    const restored = await harness({ store: h.store }); const g = finishWithHumanWinner(restored);
    assert.equal(restored.profile().balance, 9900 + g.payout); assert.equal(restored.profile().games, 1);
    assert.equal(restored.profile().history[0].id, g.id); assert.equal(restored.api.g.settled, true);
    restored.api.syncResult(); assert.equal(restored.profile().games, 1); assert.equal(restored.recordCalls(), 1);
  });
  await test('account changes block stale next-hand, cashout and new-table handlers', async () => {
    const h = await harness(); h.click('[data-start]'); const g = finishWithHumanWinner(h);
    h.dispatch('vezdehot:accountchange'); h.setProfile({ nick: 'Другой аккаунт', balance: 777 });
    h.click('[data-next]'); h.click('[data-cashout]'); h.click('[data-new]'); h.api.syncResult();
    assert.equal(h.api.g.id, g.id); assert.equal(h.profile().balance, 777); assert.equal(h.recordCalls(), 0);
    assert.equal(h.app.inert, true); assert.equal(h.app.style.pointerEvents, 'none'); assert.equal(h.timers.size, 0);
  });
  await test('opening account pauses the active hand and insufficient entry preserves the completed result', async () => {
    const h = await harness(); h.click('[data-start]'); h.click('[data-account]');
    assert.equal(h.api.g.paused, true); assert.equal(h.profileOpens(), 1); assert.equal(h.timers.size, 0);
    const g = finishWithHumanWinner(h); h.click('[data-cashout]'); h.setProfile({ balance: 50 }); h.click('[data-new]');
    assert.equal(h.api.g.id, g.id); assert.equal(h.profile().balance, 50); assert.match(h.api.error, /100 V/);
  });
  await test('an unmatched-bet refund is never announced as a winning bank and player names are escaped', async () => {
    const h = await harness(); h.click('[data-start]'); const g = finishWithHumanWinner(h);
    g.pots = [{ amount: 80, winners: [1], refund: false }, { amount: 20, winners: [0], refund: true }];
    g.players[1].name = '<img src=x onerror="alert(1)">';
    assert.match(h.api.resultTitle(), /^Победитель — /); assert.ok(!h.api.resultTitle().includes('Ты выиграл'));
    assert.ok(!h.api.outcomeBanner().includes('<img')); assert.match(h.api.outcomeBanner(), /&lt;img/);
    const recap = h.api.resultDetails(); assert.match(recap, /Возврат лишней ставки/); assert.ok(!recap.includes('<img'));
  });
  await test('a shared board combination explains the split and shows five winning cards for every contender', async () => {
    const h = await harness(); h.click('[data-start]'); const g = h.api.g;
    const cards = text => text.split(' ').map(id => ({ id, rank: id.slice(0, -1), suit: id.slice(-1),
      v: ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'].indexOf(id.slice(0, -1)) + 2,
      red: ['♥', '♦'].includes(id.slice(-1)) }));
    g.community = cards('A♠ K♠ Q♠ J♠ 10♠');
    ['2♥ 3♥', '4♥ 5♥', '6♥ 7♥', '8♥ 9♥'].forEach((hand, i) => Object.assign(g.players[i], {
      hand: cards(hand), chips: 900, totalBet: 100, roundBet: 100, folded: false
    }));
    g.pot = 400; h.api.pokerFinish(g);
    assert.equal(h.api.resultTitle(), 'Банк разделён'); assert.match(h.api.resultReason(), /равны по старшинству/);
    const recap = h.api.resultDetails(); assert.equal((recap.match(/class="pk-five"/g) || []).length, 4);
    assert.equal((recap.match(/A♠/g) || []).length, 4); assert.equal(g.handProfit, 0);
  });
  await test('skip-to-result is permitted only after folding and never auto-starts another hand', async () => {
    const h = await harness(); h.click('[data-start]'); const g = h.api.g, id = g.id;
    h.api.finishWatching(); assert.equal(g.over, false); assert.equal(g.id, id);
    let guard = 0;
    while (g.toAct !== 0 && guard++ < 10) {
      const legal = h.api.legalActions(g, g.toAct);
      assert.ok(h.api.pokerAction(g, g.toAct, legal.check ? 'check' : 'call'));
    }
    assert.ok(h.api.pokerAction(g, 0, 'fold')); h.api.commitUI();
    assert.match(h.output(), /data-resolve/); h.click('[data-resolve]');
    assert.equal(g.over, true); assert.equal(h.api.g.id, id); assert.equal(h.api.g.handNumber, 1);
    assert.equal(h.profile().balance, 9900); assert.equal(h.profile().games, 0); assert.equal(h.timers.size, 0);
  });
  await test('bank-size presets include the call and preview the actual chip debit', async () => {
    const h=await harness();h.click('[data-start]');const g=h.api.g;
    g.toAct=0;g.currentBet=100;g.pot=400;Object.assign(g.players[0],{roundBet:20,totalBet:20,chips:980,actedAtBet:null});
    const legal=h.api.legalActions(g,0),presets=plain(h.api.raisePresets(legal));
    assert.equal(presets.find(x=>x.label==='½ банка').value,340);
    assert.equal(presets.find(x=>x.label==='Банк').value,580);
    h.api.setRaise(340);assert.match(h.api.raisePreview(),/Добавишь <b>320<\/b>/);assert.match(h.api.raisePreview(),/Останется <b>660<\/b>/);
    assert.equal(h.api.raiseLabel(),'Рейз до 340');assert.ok(h.api.pokerAction(g,0,'raise',340));assert.equal(g.players[0].chips,660);
    g.currentBet=0;h.api.setRaise(40);assert.equal(h.api.raiseLabel(),'Ставка · 40');
    h.api.setRaise(g.players[0].roundBet+g.players[0].chips);assert.match(h.api.raiseLabel(),/^Ва-банк/);
  });
  await test('a damaged saved hand shows recovery text without crashing, charging or paying', async () => {
    const h=await harness();h.click('[data-start]');const damaged=JSON.parse(h.store.get(SESSION));delete damaged.community;
    h.store.set(SESSION,JSON.stringify(damaged));const restored=await harness({store:h.store});
    assert.equal(restored.api.g,null);assert.equal(restored.profile().balance,9900);assert.equal(restored.recordCalls(),0);
    assert.match(restored.output(),/Сохранённый стол повреждён/);assert.equal(JSON.parse(h.store.get(SESSION)).id,damaged.id,'corrupt snapshot remains intact until a new table is requested');
  });
  await test('betting view identifies both blinds and exposes touch-friendly wager feedback', async () => {
    const h=await harness();h.click('[data-start]');h.api.g.toAct=0;
    const markup=h.api.view();assert.match(markup,/aria-label="Малый блайнд"/);assert.match(markup,/aria-label="Большой блайнд"/);
    assert.match(markup,/data-raise-preview aria-live="polite"/);assert.match(markup,/Ползунок выбирает сумму/);assert.match(markup,/aria-pressed=/);
  });
  await test('back-forward cache return shows a paused hand instead of a bot turn with no timer', async () => {
    const h=await harness();h.click('[data-start]');const id=h.api.g.id;
    h.dispatch('pagehide');assert.equal(h.api.g.paused,true);assert.equal(h.timers.size,0);
    h.dispatch('pageshow',{persisted:true});assert.equal(h.api.g.id,id);assert.match(h.output(),/Продолжить игру/);
    assert.equal(h.profile().balance,9900);assert.equal(h.recordCalls(),0);
  });
  new Function(inline);
  console.log(`${count} poker lifecycle UI checks passed`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
