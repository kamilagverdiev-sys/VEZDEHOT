'use strict';
// Lifecycle and real event-binding checks. DOM layout is verified separately in a browser.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const html = fs.readFileSync(path.join(__dirname, '../dist/poker.html'), 'utf8');
const inline = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const PROFILE = 'poker-test-profile', SESSION = 'vezdehot_poker_v2_guest';
const plain = value => JSON.parse(JSON.stringify(value));

async function harness({ store = new Map(), failRecord = false, failDebit = false, scope = 'guest', sharedStore = true, failStorage = false, owner = true, guide = true } = {}) {
  const events = new Map(), groups = new Map(), timers = new Map();
  let nextTimer = 0, seed = 88091, renderCount = 0, recordCalls = 0, profileOpens = 0, guideConfig = null, guideOpens = 0;
  const initial = { nick: 'Игрок', balance: 10000, games: 0, wins: 0, xp: 0, resultIds: [], history: [] };
  let profile = JSON.parse(store.get(PROFILE) || JSON.stringify(initial));
  const persistProfile = () => store.set(PROFILE, JSON.stringify(profile));
  const rules = { open: false, addEventListener() {}, showModal() { this.open = true; }, close() { this.open = false; } };
  const app = { style: {}, inert: false }, closeRules = {};
  const selectors = new Map([['#app', app], ['#rules', rules], ['#close-rules', closeRules]]);
  for (const selector of ['[data-start]', '[data-new]', '[data-next]', '[data-cashout]', '[data-settings]', '[data-account]', '[data-resolve]', '[data-rules]', '[data-pause]']) groups.set(selector, [{}]);
  const platform = {
    ready: Promise.resolve(), scopeKey: () => scope,
    getProfile: () => plain(profile),
    updateProfile(patch) { if (failDebit) return {ok:false}; profile = { ...profile, ...plain(patch) }; persistProfile(); },
    recordResult(entry) {
      recordCalls++;
      if (failRecord === 'return') return { ok: false };
      if (failRecord) throw new Error('Simulated local write failure');
      if (profile.resultIds.includes(entry.id)) return plain(profile);
      profile = { ...profile, balance: profile.balance + entry.delta, games: profile.games + 1,
        wins: profile.wins + (entry.win ? 1 : 0), xp: profile.xp + entry.xp,
        resultIds: [...profile.resultIds, entry.id], history: [plain(entry), ...profile.history] };
      persistProfile(); return plain(profile);
    },
    openAccount() { profileOpens++; },
    renderSaveNotice(game, id) { const state = context.window.VEZDEHOT_GAME_STORE?.status(game, id); return state && ['unavailable', 'corrupt', 'recovered'].includes(state.status) ? `<div role="status">${state.message}</div>` : ''; }
  };
  const document = {
    hidden: false, rendered: '', documentElement: { dataset: {}, classList: { contains: () => false } }, body: { classList: { contains: () => false } },
    querySelector: selector => selectors.get(selector) || null,
    querySelectorAll: selector => groups.get(selector) || [],
    addEventListener(name, fn) { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); },
    dispatchEvent(event) { for (const fn of events.get(event.type) || []) fn(event); }
  };
  const context = {
    console, Date, Promise, AbortController, CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    Math: Object.assign(Object.create(Math), { random() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; } }),
    document,
    window: { PokerEquity: require('../dist/poker-equity.js'), VEZDEHOT: platform, VEZDEHOT_TAB_SESSION: { canWrite: () => owner }, matchMedia: () => ({ matches: true }), addEventListener(name, fn) { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); } },
    localStorage: { getItem: key => store.get(key) || null, setItem(key, value) { if (failStorage) { const error = new Error('Quota exceeded'); error.name = 'QuotaExceededError'; throw error; } store.set(key, String(value)); }, removeItem(key) { if (failStorage) throw new Error('Storage unavailable'); store.delete(key); } },
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    __rendered() { renderCount++; }
  };
  // Replace only DOM patching, retaining shipped lifecycle functions, controls and event handlers.
  const exposure = `
render = function () { document.rendered = saveNotice() + (g ? controls() : intro()); bind(); __rendered(); };
window.__poker = { get g() { return g; }, get error() { return error; }, get accountChanging() { return accountChanging; },
  startHand, nextHand, closeTable, syncResult, commitUI, saveHand, saveNotice, controls, notice, bind, boot, takeAction, continueHand, togglePause, canPlay,
  pokerNewGame, pokerAction, pokerFinish, pokerContinue, legalActions, tableFinished,
  resultTitle, resultReason, resultDetails, outcomeBanner, finishWatching, raisePresets, raiseLabel, raisePreview, view, top, practiceBalance, pokerOpponents, pokerBotStyle, pokerContext, pokerLessons, pokerJournal, pokerJournals, openPokerGuide, evaluate, splitPots, setRaise(value) { selectedRaise=value; } };
boot();`;
  assert.ok(inline.includes('\nboot();\n'), 'Expected the shipped bootstrap call');
  vm.createContext(context);vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../dist/session-validation.js'),'utf8'),context);
  if (guide) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../dist/game-guide.js'), 'utf8'), context, { filename: 'game-guide.js' });
    context.window.VEZDEHOT_GUIDE = { ...context.window.VEZDEHOT_GUIDE, open(config) { guideConfig=config;guideOpens++; } };
  }
  if (sharedStore) vm.runInContext(fs.readFileSync(path.join(__dirname, '../dist/game-store.js'), 'utf8'), context, { filename: 'game-store.js' });
  vm.runInContext(inline.replace('\nboot();\n', '\n' + exposure + '\n'), context, { filename: 'poker.html' });
  await Promise.resolve(); await Promise.resolve();
  return {
    api: context.window.__poker, context, store, timers, app, groups, selectors,
    profile: () => plain(profile), output: () => document.rendered, recordCalls: () => recordCalls,
    renderCount: () => renderCount, profileOpens: () => profileOpens, guideConfig: () => guideConfig, guideOpens: () => guideOpens, rules, closeGuide() { guideConfig?.onClose?.(); },
    setFailRecord(value) { failRecord = value; },
    setFailStorage(value) { failStorage = value; },
    setOwner(value) { owner = value; },
    saves: context.window.VEZDEHOT_GAME_STORE,
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
  await test('a refused entry debit cannot create a table or consume practice coins', async () => {
    const h=await harness({failDebit:true}),before=h.profile();h.click('[data-start]');
    assert.equal(h.api.g,null);assert.deepEqual(h.profile(),before);assert.equal(h.recordCalls(),0);assert.equal(h.timers.size,0);assert.match(h.api.error,/сохранить вход/);
    assert.equal(h.store.has(SESSION),false);h.click('[data-start]');assert.equal(h.api.g,null);assert.deepEqual(h.profile(),before);
  });
  await test('practice balance stays clearly labelled after profile updates without losing its coin markup', async () => {
    const h=await harness(),attributes={},balance={setAttribute:(key,value)=>attributes[key]=value};h.selectors.set('.pk-bankroll',balance);assert.match(h.api.top(),/Баланс практики/);assert.match(h.api.top(),/>Практика</);
    h.setProfile({balance:7654});h.dispatch('vezdehot:profile');assert.match(balance.innerHTML,/>Практика</);assert.match(balance.innerHTML,/<i aria-hidden="true">V<\/i>/);assert.equal(attributes['aria-label'],'Баланс практики: '+Number(7654).toLocaleString('ru-RU')+' игровых монет');
  });
  await test('primary decisions precede the equity explanation so mobile actions stay close to the hand', async () => {
    const h=await harness();h.click('[data-start]');let steps=0;while(h.api.g.toAct!==0&&steps++<10){const legal=h.api.legalActions(h.api.g,h.api.g.toAct);h.api.pokerAction(h.api.g,h.api.g.toAct,legal.check?'check':'call')}
    const markup=h.api.view();assert(markup.indexOf('class="pk-actions"')<markup.indexOf('class="pk-equity"'));assert.match(markup,/Победа без дележа/);assert.match(markup,/data-action="(?:check|call)"/);
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
    const saved = plain(h.api.g); saved.settled = false; h.saves.save('poker', 'guest', saved);
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
    const h = await harness({sharedStore:false}); h.click('[data-start]'); const g = finishWithHumanWinner(h);
    Object.assign(g, { version: 2, settled: true }); h.api.saveHand();
    h.setProfile({ balance: 10000 + g.profit, games: 1, resultIds: [g.id] });
    const restored = await harness({ store: h.store }); const balance = restored.profile().balance;
    assert.equal(restored.recordCalls(), 0); assert.equal(restored.profile().games, 1);
    restored.click('[data-new]');
    assert.equal(restored.api.g.version, 3); assert.notEqual(restored.api.g.id, g.id); assert.equal(restored.profile().balance, balance - 100);
  });
  await test('an unfinished legacy hand can complete under its old payout contract exactly once', async () => {
    const h = await harness({sharedStore:false}); h.click('[data-start]'); h.api.g.version = 2; h.api.saveHand();
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
    const h=await harness();h.click('[data-start]');const damaged=plain(h.api.g);delete damaged.community;
    const damagedStore=new Map([[PROFILE,h.store.get(PROFILE)],[SESSION,JSON.stringify(damaged)]]);const restored=await harness({store:damagedStore});
    assert.equal(restored.api.g,null);assert.equal(restored.profile().balance,9900);assert.equal(restored.recordCalls(),0);
    assert.match(restored.output(),/поврежд|восстанов/i);assert.equal(JSON.parse(damagedStore.get(SESSION)).id,damaged.id,'corrupt snapshot remains intact until a new table is requested');
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
  await test('legacy scoped tables migrate into the shared store without entry fees or lost chips', async () => {
    const old=await harness({sharedStore:false});old.click('[data-start]');const id=old.api.g.id,legacy=old.store.get(SESSION);
    const migrated=await harness({store:old.store});
    assert.equal(migrated.api.g.id,id);assert.equal(migrated.api.g.paused,true);assert.equal(migrated.profile().balance,9900);
    assert.equal(migrated.recordCalls(),0);assert.equal(migrated.store.get(SESSION),legacy,'migration preserves the legacy recovery source');
    assert.ok(migrated.store.has('vezdehot:session:v1:guest:poker'));
    const other=await harness({store:old.store,scope:'other-profile'});assert.equal(other.api.g,null,'a different profile cannot import the guest table');
  });
  await test('a corrupt current snapshot restores a verified previous hand and explains recovery', async () => {
    const h=await harness();h.click('[data-start]');const id=h.api.g.id;
    h.api.togglePause();const primary='vezdehot:session:v1:guest:poker';h.store.set(primary,'{broken-json');
    const restored=await harness({store:h.store});
    assert.equal(restored.api.g.id,id);assert.equal(restored.api.g.paused,true);assert.equal(restored.profile().balance,9900);
    assert.equal(restored.recordCalls(),0);assert.equal(restored.timers.size,0);assert.match(restored.output(),/восстанов|резерв/i);
    assert.equal(restored.store.get(primary),'{broken-json','recovery does not overwrite the damaged evidence automatically');
  });
  await test('quota failures stay visible and a retry saves the latest in-memory hand', async () => {
    const h=await harness();h.click('[data-start]');const primary='vezdehot:session:v1:guest:poker',durable=h.store.get(primary);
    h.setFailStorage(true);h.api.togglePause();
    assert.equal(h.saves.status('poker','guest').pending,true);assert.equal(h.store.get(primary),durable);
    assert.match(h.output(),/памят|сохран|закрыв/i);assert.equal(h.api.g.paused,true);
    h.setFailStorage(false);assert.equal(h.saves.retry('poker','guest').ok,true);
    const restored=await harness({store:h.store});assert.equal(restored.api.g.id,h.api.g.id);assert.equal(restored.api.g.paused,true);
    assert.equal(restored.profile().balance,9900);assert.equal(restored.recordCalls(),0);
  });
  await test('retrying a failed snapshot never invents a settled payout', async () => {
    const h=await harness({failRecord:'return'});h.click('[data-start]');const g=finishWithHumanWinner(h);
    h.click('[data-cashout]');assert.equal(g.settled,false);assert.equal(h.profile().balance,9900);assert.match(h.output(),/data-cashout/);
    h.setFailStorage(true);h.api.saveHand();h.setFailStorage(false);assert.equal(h.saves.retry('poker','guest').ok,true);
    assert.equal(h.saves.peek('poker','guest').state.settled,false);assert.equal(h.profile().games,0);
    h.setFailRecord(false);h.click('[data-cashout]');h.click('[data-cashout]');
    assert.equal(g.settled,true);assert.equal(h.api.error,'');assert.equal(h.profile().balance,9900+g.payout);assert.equal(h.profile().games,1);
    const restored=await harness({store:h.store});assert.equal(restored.profile().games,1);assert.equal(restored.recordCalls(),0);
  });
  await test('legacy payout failures keep an honest pending result until a successful retry', async () => {
    const old=await harness({sharedStore:false});old.click('[data-start]');old.api.g.version=2;old.api.saveHand();
    const h=await harness({store:old.store,failRecord:'return'});finishWithHumanWinner(h);
    assert.equal(h.api.g.settled,false);assert.match(h.api.notice()[0],/ожидает/);assert.match(h.output(),/data-cashout/);
    h.setFailRecord(false);h.click('[data-cashout]');assert.equal(h.api.g.settled,true);assert.equal(h.api.error,'');assert.equal(h.profile().games,1);
  });
  await test('ownership transfer first saves a pause, then blocks all stale gameplay', async () => {
    const h=await harness();h.click('[data-start]');const id=h.api.g.id;
    h.dispatch('vezdehot:sessionpause');assert.equal(h.api.g.paused,true);assert.equal(h.saves.peek('poker','guest').state.paused,true);assert.equal(h.timers.size,0);
    h.setOwner(false);h.dispatch('vezdehot:sessionlost');const snapshot=JSON.stringify(h.api.g),entries=JSON.stringify([...h.store]);
    h.click('[data-next]');h.click('[data-cashout]');h.click('[data-new]');h.api.togglePause();h.api.continueHand();h.api.takeAction('fold');h.api.commitUI();h.api.saveHand();
    assert.equal(JSON.stringify(h.api.g),snapshot);assert.equal(JSON.stringify([...h.store]),entries);assert.equal(h.api.g.id,id);
    assert.equal(h.app.inert,true);assert.equal(h.app.style.pointerEvents,'none');assert.equal(h.recordCalls(),0);
  });
  await test('lost ownership blocks already queued bot callbacks before a UI event arrives', async () => {
    const h=await harness();h.click('[data-start]');const queued=[...h.timers.values()];assert.ok(queued.length);
    const snapshot=JSON.stringify(h.api.g),entries=JSON.stringify([...h.store]);h.setOwner(false);for(const callback of queued)callback();
    h.api.saveHand();h.api.startHand();h.api.syncResult();assert.equal(JSON.stringify(h.api.g),snapshot);assert.equal(JSON.stringify([...h.store]),entries);
    assert.equal(h.profile().balance,9900);assert.equal(h.recordCalls(),0);
  });
  await test('opening lessons pauses and saves the current hand without changing cards, chips or wallet', async () => {
    const h=await harness();h.click('[data-start]');const before=plain(h.api.g),wallet=h.profile(),queued=[...h.timers.values()];
    h.click('[data-rules]');assert.equal(h.guideOpens(),1);assert.equal(h.guideConfig().game,'poker');assert.equal(h.guideConfig().lessons.length,3);
    assert.equal(h.api.g.paused,true);assert.equal(h.saves.peek('poker','guest').state.paused,true);assert.equal(h.timers.size,0);
    assert.deepEqual({...plain(h.api.g),paused:before.paused},before);assert.deepEqual(h.profile(),wallet);assert.equal(h.recordCalls(),0);
    for(const callback of queued)callback();h.closeGuide();assert.equal(h.api.g.paused,true);assert.equal(h.timers.size,0);assert.match(h.output(),/Продолжить игру/);
    h.click('[data-pause]');assert.equal(h.api.g.paused,false);assert.ok(h.timers.size>0);
  });
  await test('intro and completed-hand lessons never start a hand or settle the table', async () => {
    const h=await harness();h.click('[data-rules]');assert.equal(h.api.g,null);assert.equal(h.profile().balance,10000);assert.equal(h.guideOpens(),1);
    h.click('[data-start]');const ended=finishWithHumanWinner(h),snapshot=plain(ended),wallet=h.profile();h.click('[data-rules]');
    assert.deepEqual(plain(h.api.g),snapshot);assert.deepEqual(h.profile(),wallet);assert.equal(h.recordCalls(),0);
    h.setOwner(false);h.api.openPokerGuide();assert.equal(h.guideOpens(),2);
  });
  await test('fallback rules also remain paused until the player explicitly continues', async () => {
    const h=await harness({guide:false});h.click('[data-start]');h.click('[data-rules]');assert.equal(h.rules.open,true);assert.equal(h.api.g.paused,true);
    h.rules.close();assert.equal(h.api.g.paused,true);assert.equal(h.timers.size,0);assert.match(h.output(),/Продолжить игру/);
  });
  await test('context explains committed chips and remains unchanged when only hidden bot cards change', async () => {
    const h=await harness();h.click('[data-start]');const g=h.api.g;g.toAct=0;g.currentBet=100;g.minRaise=40;Object.assign(g.players[0],{roundBet:20,totalBet:20,chips:980,actedAtBet:null});h.api.setRaise(340);
    const hint=plain(h.api.pokerContext());assert.match(hint.text,/колл добавит 80/);assert.match(hint.text,/Рейз до 340.*добавит 320/);
    g.toAct=1;const waiting=plain(h.api.pokerContext());g.players.slice(1).forEach(player=>player.hand=[{id:'unknown-hidden-card'}]);assert.deepEqual(plain(h.api.pokerContext()),waiting);g.toAct=0;assert.deepEqual(plain(h.api.pokerContext()),hint);
    g.paused=true;h.api.view();assert.deepEqual(plain(h.api.pokerContext()),hint,'pausing the real view preserves the chosen raise and its visible action math');
    g.players[0].chips=30;assert.match(h.api.pokerContext().text,/колл добавит 30/);assert.match(h.api.pokerContext().text,/короткий ва-банк/);assert.ok(!h.api.pokerContext().text.includes('Рейз до'));
    Object.assign(g.players[0],{roundBet:0,chips:1000});h.api.setRaise(340);const uncommitted=h.api.pokerContext().text;assert.match(uncommitted,/Рейз до 340.*добавит 340 фишек\./);assert.ok(!uncommitted.includes('а не'),'a new wager does not contrast identical amounts');
  });
  await test('mini-lesson solutions agree with the shipped call, best-five and side-pot engines', async () => {
    const h=await harness(),lessons=h.api.pokerLessons();assert.equal(new Set(lessons.map(x=>x.id)).size,3);assert.ok(lessons.every(x=>x.choices.filter(choice=>choice.correct).length===1&&x.choices.every(choice=>choice.feedback)));
    const call=h.api.pokerNewGame('Ты','normal',1);call.currentBet=100;call.minRaise=40;Object.assign(call.players[0],{roundBet:20,totalBet:20,chips:980,actedAtBet:null});
    const raise=plain(call);assert.equal(h.api.legalActions(call,0).callAmount,80);assert.equal(h.api.pokerAction(call,0,'call'),true);assert.equal(call.players[0].chips,900);
    assert.equal(h.api.pokerAction(raise,0,'raise',340),true);assert.equal(raise.players[0].chips,660);
    const cards=text=>text.split(' ').map(id=>({id,rank:id.slice(0,-1),suit:id.slice(-1),v:['2','3','4','5','6','7','8','9','10','J','Q','K','A'].indexOf(id.slice(0,-1))+2}));
    const board=cards('A♠ K♠ Q♠ J♠ 10♠');assert.equal(h.api.evaluate(board.concat(cards('A♥ A♦'))).value,h.api.evaluate(board.concat(cards('2♥ 3♥'))).value);
    const pots=h.api.pokerNewGame('Ты','normal');pots.community=cards('2♣ 3♦ 7♣ 8♦ 10♣');['A♠ A♥','K♠ K♥','Q♠ Q♥','J♠ J♥'].forEach((hand,i)=>Object.assign(pots.players[i],{hand:cards(hand),totalBet:[100,300,300,0][i],folded:i===3}));
    const split=h.api.splitPots(pots);assert.deepEqual(plain(split.pots.map(pot=>pot.amount)),[300,400]);assert.deepEqual(plain(split.prizes),[300,400,0,0]);assert.ok(!split.pots[1].winners.includes(0));
    assert.match(lessons[0].choices.find(x=>x.correct).label,/80.*320/);assert.match(lessons[1].choices.find(x=>x.correct).label,/разделится/);assert.match(lessons[2].choices.find(x=>x.correct).label,/300.*400/);
  });
  await test('journals expose every retained event, keep newest first and include the just-finished hand', async () => {
    const h=await harness();h.click('[data-start]');const g=h.api.g;g.history=Array.from({length:30},(_,i)=>'Событие '+(30-i));
    const logs=h.api.pokerJournals();assert.deepEqual([...logs.matchAll(/Событие (\d+)</g)].map(match=>Number(match[1])),Array.from({length:30},(_,i)=>30-i));assert.match(logs,/30 событий/);assert.match(logs,/data-key="journal-poker-hand-history"/);
    g.history=['<img src=x onerror=alert(1)>'];const single=h.api.pokerJournals();assert.match(single,/1 событие/);assert.ok(!single.includes('<img'));assert.match(single,/&lt;img/);
    finishWithHumanWinner(h);assert.match(h.api.pokerJournals(),/Раздача №1/);h.api.nextHand();const next=h.api.pokerJournals();assert.equal((next.match(/Раздача №1/g)||[]).length,1);
  });
  await test('opponent style labels are stable, readable and never reveal hidden hand strength', async () => {
    const h=await harness();h.click('[data-start]');const g=h.api.g,markup=h.api.pokerOpponents();
    for(const label of ['Осторожный','Напористый','Позиционный'])assert.ok(markup.includes(label));
    assert.match(markup,/data-key="poker-opponents"/);assert.match(markup,/Соперники за столом/);assert.match(markup,/приблизительный расчёт/);assert.match(markup,/будущая колода им недоступны/);
    g.players.slice(1).forEach(player=>Object.defineProperty(player,'hand',{configurable:true,get(){throw new Error('Opponent explanation read hidden hand')}}));assert.equal(h.api.pokerOpponents(),markup);
    g.players[1].name='<img src=x onerror=alert(1)>';const escaped=h.api.pokerOpponents();assert.ok(!escaped.includes('<img'));assert.match(escaped,/&lt;img/);
  });
  new Function(inline);
  console.log(`${count} poker lifecycle UI checks passed`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
