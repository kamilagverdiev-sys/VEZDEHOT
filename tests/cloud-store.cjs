'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const source = read('dist/game-store.js');
const names = ['durak', 'bunker', 'poker', 'mafia', 'monopoly'];
const plain = value => JSON.parse(JSON.stringify(value));
const key = (game, scope = 'account-a') => 'vezdehot:session:v1:' + scope + ':' + game;
const state = (game, turn = 1) => ({game, turn, version: 3, id: game + '-1', cards: []});
const bundle = (turn = 1) => Object.fromEntries(names.map(game => [game, state(game, turn)]));
const empty = () => Object.fromEntries(names.map(game => [game, null]));
const current = {contextCurrent: () => true};
function harness(store = new Map(), options = {}) {
  const writes = [], events = [], validations = [];
  const controls = {scope: 'account-a', owner: true, guard: true, failRead: false, failKey: null, failWrite: false, afterWrite: null};
  const storage = {
    getItem(name) {if (controls.failRead) throw Error('Storage denied'); return store.get(name) ?? null;},
    setItem(name, raw) {
      writes.push(name); if (controls.failWrite || controls.failKey === name) throw Error('QuotaExceededError');
      store.set(name, String(raw)); controls.afterWrite?.(name, String(raw));
    }
  };
  const validate = (game, value, flags) => {
    validations.push({game, remote: flags?.remote === true});
    if (!value || value.game !== game || !Number.isInteger(value.turn) || value.turn < 0 || !Array.isArray(value.cards)) throw Error('Invalid game');
    if (flags?.remote && value.version !== 3) throw Error('Old remote version');
    return {...plain(value), version: 3};
  };
  const window = {localStorage: storage, VEZDEHOT_SESSION_VALIDATION: {validate},
    VEZDEHOT_TAB_SESSION: {canWrite: () => controls.owner && controls.guard, ownsLock: () => controls.owner, status: () => ({scope: controls.scope})},
    document: {dispatchEvent: event => events.push(plain({type: event.type, detail: event.detail}))},
    CustomEvent: class {constructor(type, init) {this.type = type; this.detail = init.detail;}}};
  const context = {window, localStorage: storage, Date, console};
  vm.createContext(context);
  if (options.realValidation) vm.runInContext(read('dist/session-validation.js'), context);
  vm.runInContext(source, context);
  return {api: window.VEZDEHOT_GAME_STORE, window, store, writes, events, validations, controls, context};
}
function seed(h, turn = 1) {for (const game of names) assert.equal(h.api.save(game, h.controls.scope, state(game, turn)).ok, true);}
function disk(h, game) {return JSON.parse(h.store.get(key(game, h.controls.scope)));}
function realBundle() {
  const context = () => {
    let seed = 90117;
    const ctx = {console, Date: {now: () => 1700000000000}, Math: Object.assign(Object.create(Math), {random: () => {seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32;}}),
      window: {}, document: {hidden: false}, s: {nick: 'Checkpoint', balance: 10000, wins: 0, games: 0, xp: 0, view: 'game'},
      ranks: ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'], suits: [['♠', 'black'], ['♥', 'red'], ['♦', 'red'], ['♣', 'black']],
      botNames: ['A', 'B', 'C', 'D', 'E'], avatars: ['A', 'B', 'C', 'D', 'E'],
      localStorage: {getItem: () => null, setItem() {}, removeItem() {}}, save() {}, render() {}, renderSelection() {}, toast(message) {throw Error(message);},
      fmt: String, esc: String, $: () => null, setTimeout: () => 1, clearTimeout() {}};
    vm.createContext(ctx); vm.runInContext(read('dist/session-validation.js'), ctx); return ctx;
  };
  const result = {}, mainHtml = read('dist/index.html'), main = context();
  vm.runInContext(mainHtml.slice(mainHtml.indexOf('    function deck(){'), mainHtml.indexOf('    function canHumanAttack')) + '\nthis.a={newGame,startBunker};', main);
  result.durak = plain(main.a.newGame({bots: 2, diff: 'normal', stake: 100})); main.a.startBunker({diff: 'hard', scenarioChoice: 'POLAR / 06'}); result.bunker = plain(main.s.game);
  for (const [game, marker, constructor] of [['poker', 'POKER_ENGINE', "pokerNewGame('Checkpoint','normal',1)"], ['mafia', 'MAFIA_ENGINE', 'newGame()']]) {
    const html = read('dist/' + game + '.html'), ctx = context();
    vm.runInContext(html.split('// ' + marker + '_START')[1].split('// ' + marker + '_END')[0] + '\nthis.fixture=' + constructor + ';', ctx);
    result[game] = plain(ctx.fixture);
  }
  const mono = context(); vm.runInContext(read('dist/monopoly.html').split("(function(){'use strict';")[1].split('// Engine ends here.')[0] + '\nthis.fixture=newGame();', mono);
  result.monopoly = plain(mono.fixture); return result;
}

test('export returns all five durable game snapshots and independent local revisions', () => {
  const h = harness(); seed(h); h.api.save('poker', 'account-a', state('poker', 2));
  const result = h.api.exportAll('account-a');
  assert.equal(result.ok, true); assert.deepEqual(Object.keys(result.games), names);
  assert.deepEqual(plain(result.revisions), {durak: 1, bunker: 1, poker: 2, mafia: 1, monopoly: 1});
  result.games.poker.cards.push('changed'); assert.deepEqual(plain(h.api.peek('poker', 'account-a').state.cards), []);
  assert.equal(h.validations.some(x => x.remote), false);
});

test('clean empty sessions and authoritative tombstones export as null', () => {
  const h = harness(); h.api.clear('poker', 'account-a'); h.store.set('vezdehot_poker_v2_account-a', JSON.stringify(state('poker', 9)));
  const result = h.api.exportAll('account-a'); assert.equal(result.ok, true); assert.deepEqual(plain(result.games), empty());
  assert.equal(result.revisions.poker, 1); assert.equal(result.revisions.durak, 0);
});

test('export refuses pending, corrupt or unavailable state instead of omitting a game', () => {
  for (const mode of ['pending', 'corrupt', 'unavailable']) {
    const h = harness(); seed(h);
    if (mode === 'pending') {h.controls.failWrite = true; h.api.save('poker', 'account-a', state('poker', 2)); h.controls.failWrite = false;}
    if (mode === 'corrupt') h.store.set(key('poker'), '{broken');
    if (mode === 'unavailable') h.controls.failRead = true;
    const result = h.api.exportAll('account-a'); assert.equal(result.ok, false, mode); assert.deepEqual(plain(result.games), {}); assert.deepEqual(plain(result.revisions), {});
    assert(result.message.length > 0);
  }
});

test('export accepts a verified backup and leaves the corrupt primary as evidence', () => {
  const h = harness(); h.api.save('poker', 'account-a', state('poker', 1)); h.api.save('poker', 'account-a', state('poker', 2));
  h.store.set(key('poker'), '{broken'); const before = new Map(h.store);
  const result = h.api.exportAll('account-a'); assert.equal(result.ok, true); assert.equal(result.games.poker.turn, 1);
  assert.deepEqual(h.store, before); assert.equal(h.api.status('poker', 'account-a').status, 'recovered');
});

test('export migrates every scoped legacy source under a blocked cloud guard and preserves originals', () => {
  const h = harness(), old = bundle(); old.durak.version = 2;
  const originals = new Map([
    ['vezdehot:main:account-a', JSON.stringify({savedGames: {durak: old.durak, bunker: old.bunker}})],
    ['vezdehot_poker_v2_account-a', JSON.stringify(old.poker)],
    ['vezdehot_mafia_v3_account-a', JSON.stringify(old.mafia)],
    ['vezdehot_monopoly_v3_account-a', JSON.stringify(old.monopoly)]
  ]);
  for (const [name, raw] of originals) h.store.set(name, raw);
  h.controls.guard = false;
  const result = h.api.exportAll('account-a', current); assert.equal(result.ok, true);
  for (const game of names) {assert.equal(result.games[game].game, game); assert.equal(result.games[game].version, 3); assert.equal(result.revisions[game], 1);}
  for (const [name, raw] of originals) assert.equal(h.store.get(name), raw);
  assert.equal(h.api.save('poker', 'account-a', state('poker', 3)).ok, false);
});

test('guest-only bundle migration is isolated from signed-in scopes and recognizes the old active game', () => {
  const h = harness(); h.store.set('uniq_play_v1', JSON.stringify({game: {...state('durak'), deck: [], players: [{hand: []}]}}));
  assert.equal(h.api.exportAll('account-a').games.durak, null);
  h.controls.scope = 'guest'; const result = h.api.exportAll('guest'); assert.equal(result.ok, true); assert.equal(result.games.durak.game, 'durak');
  assert.equal(result.games.bunker, null); assert(h.store.has('uniq_play_v1'));
});

test('malformed old game snapshots fail export without silently producing an empty cloud game', () => {
  for (const [name, raw] of [
    ['vezdehot_poker_v2_account-a', '{bad'],
    ['vezdehot:main:account-a', JSON.stringify({savedGames: {durak: {bad: true}}})],
    ['vezdehot:main:account-a', JSON.stringify({game: {bad: true}})]
  ]) {
    const h = harness(new Map([[name, raw]])); assert.equal(h.api.exportAll('account-a').ok, false); assert.equal(h.store.get(name), raw);
  }
});

test('install validates all five snapshots and exact shape before any write or runtime fence', () => {
  for (const alter of [games => delete games.monopoly, games => games.extra = null, games => games.monopoly.turn = -1, games => games.monopoly.version = 2]) {
    const h = harness(); seed(h); h.api.load('poker', 'account-a'); const games = bundle(2); alter(games); h.writes.length = 0;
    assert.equal(h.api.installAll('account-a', games, current).ok, false); assert.equal(h.writes.length, 0);
    assert.equal(h.api.save('poker', 'account-a', state('poker', 3)).ok, true, 'rejected validation does not fence live state');
  }
});

test('import allocates new local revisions, retains previous valid backups, and emits saved status', () => {
  const h = harness(); seed(h, 4); h.api.save('poker', 'account-a', state('poker', 5)); const input = bundle(20), before = JSON.stringify(input);
  assert.equal(h.api.installAll('account-a', input, current).ok, true); assert.equal(JSON.stringify(input), before);
  for (const game of names) {
    assert.equal(disk(h, game).payload.turn, 20); assert.equal(disk(h, game).revision, game === 'poker' ? 3 : 2);
    assert.equal(JSON.parse(h.store.get(key(game) + ':backup')).payload.turn, game === 'poker' ? 5 : 4);
    assert(h.events.some(event => event.type === 'vezdehot:save-status' && event.detail.game === game && event.detail.revision === disk(h, game).revision && !event.detail.pending));
  }
  assert.equal(h.validations.filter(x => x.remote).length, 5);
});

test('imports preserve a damaged primary and damaged backup before replacing either', () => {
  const h = harness(); seed(h); h.store.set(key('poker'), '{broken-primary'); h.store.set(key('mafia') + ':backup', '{broken-backup');
  assert.equal(h.api.installAll('account-a', bundle(9), current).ok, true);
  assert([...h.store].some(([name, raw]) => name.startsWith(key('poker') + ':corrupt:') && raw === '{broken-primary'));
  assert([...h.store].some(([name, raw]) => name.startsWith(key('mafia') + ':backup:corrupt:') && raw === '{broken-backup'));
  assert.equal(JSON.parse(h.store.get(key('mafia') + ':backup')).payload.turn, 1);
});

test('import bypasses only the cloud guard; raw ownership, matching scope and current account context are mandatory', () => {
  const h = harness(); h.controls.guard = false; assert.equal(h.api.installAll('account-a', bundle(), current).ok, true);
  for (const prepare of [
    x => x.controls.owner = false,
    x => x.controls.scope = 'account-b',
    x => delete x.window.VEZDEHOT_TAB_SESSION,
    x => x.window.VEZDEHOT_TAB_SESSION.ownsLock = () => {throw Error('Denied');}
  ]) {const x = harness(); prepare(x); assert.equal(x.api.installAll('account-a', bundle(), current).ok, false); assert.equal(x.api.exportAll('account-a').ok, false); assert.equal(x.writes.length, 0);}
  for (const options of [{}, {contextCurrent: false}, {contextCurrent: () => false}, {contextCurrent: () => {throw Error('Old account');}}]) {
    const x = harness(); assert.equal(x.api.installAll('account-a', bundle(), options).ok, false); assert.equal(x.writes.length, 0);
  }
});

test('normal save and clear also reject a stale account scope without creating a pending action', () => {
  const h = harness(); seed(h); h.controls.scope = 'account-b'; h.writes.length = 0;
  assert.equal(h.api.save('poker', 'account-a', state('poker', 2)).ok, false); assert.equal(h.api.clear('poker', 'account-a').ok, false);
  assert.equal(h.writes.length, 0); assert.equal(h.api.status('poker', 'account-a').pending, false); assert.equal(JSON.parse(h.store.get(key('poker'))).payload.turn, 1);
});

test('losing the account epoch while preserving evidence prevents every later import write', () => {
  const h = harness(); seed(h); h.store.set(key('durak') + ':backup', '{broken'); let active = true;
  h.controls.afterWrite = () => {active = false;}; h.writes.length = 0;
  const result = h.api.installAll('account-a', bundle(2), {contextCurrent: () => active});
  assert.equal(result.ok, false); assert.equal(h.writes.length, 1); assert(h.writes[0].includes(':corrupt:'));
  assert.equal(disk(h, 'durak').payload.turn, 1); assert.equal(h.api.status('durak', 'account-a').pending, false);
});

test('quota interruption reports partial failure and a journal-driven repeated install can complete', () => {
  const h = harness(); seed(h); h.controls.failKey = key('poker');
  const imported = bundle(9); assert.equal(h.api.installAll('account-a', imported, current).ok, false);
  assert.equal(disk(h, 'durak').payload.turn, 9); assert.equal(disk(h, 'poker').payload.turn, 1); assert.equal(disk(h, 'mafia').payload.turn, 1);
  assert.equal(h.api.exportAll('account-a').ok, false); h.controls.failKey = null;
  assert.equal(h.api.installAll('account-a', imported, current).ok, true);
  for (const game of names) assert.equal(disk(h, game).payload.turn, 9);
});

test('runtime import fences stale saves, clears and retries until a new document, even after peek or another load', () => {
  const h = harness(); seed(h); const old = h.api.load('poker', 'account-a').state;
  assert.equal(h.api.installAll('account-a', bundle(8), current).ok, true); h.writes.length = 0;
  assert.equal(h.api.peek('poker', 'account-a').state.turn, 8); assert.equal(h.api.load('poker', 'account-a').state.turn, 8);
  assert.equal(h.api.save('poker', 'account-a', old).ok, false); assert.equal(h.api.clear('poker', 'account-a').ok, false); assert.equal(h.api.retry('poker', 'account-a').ok, false);
  assert.equal(h.writes.length, 0); assert.equal(h.api.status('poker', 'account-a').pending, false);
  const reopened = harness(h.store), restored = reopened.api.load('poker', 'account-a').state; restored.turn++;
  assert.equal(reopened.api.save('poker', 'account-a', restored).ok, true); assert.equal(disk(reopened, 'poker').payload.turn, 9);
});

test('boot imports before game load do not fence the initial game; cloud export is not a game load', () => {
  const h = harness(); assert.equal(h.api.exportAll('account-a').ok, true);
  assert.equal(h.api.installAll('account-a', bundle(2), current).ok, true);
  const loaded = h.api.load('poker', 'account-a').state; loaded.turn++;
  assert.equal(h.api.save('poker', 'account-a', loaded).ok, true);
});

test('external local head changes cannot be overwritten by stale memory, including after a read-only peek', () => {
  const h = harness(); seed(h); const old = h.api.load('poker', 'account-a').state;
  const other = harness(h.store); other.api.save('poker', 'account-a', state('poker', 10));
  h.api.peek('poker', 'account-a'); h.writes.length = 0;
  assert.equal(h.api.save('poker', 'account-a', old).ok, false); assert.equal(h.writes.length, 0); assert.equal(disk(h, 'poker').payload.turn, 10);
  const fresh = h.api.load('poker', 'account-a').state; fresh.turn++; assert.equal(h.api.save('poker', 'account-a', fresh).ok, true);
});

test('imported null is a durable tombstone and does not resurrect legacy data after reload', () => {
  const h = harness(); h.store.set('vezdehot_poker_v2_account-a', JSON.stringify(state('poker', 7)));
  assert.equal(h.api.installAll('account-a', empty(), current).ok, true);
  const reopened = harness(h.store), result = reopened.api.exportAll('account-a'); assert.equal(result.ok, true); assert.deepEqual(plain(result.games), empty());
  for (const game of names) assert.equal(result.revisions[game], 1);
  assert(h.store.has('vezdehot_poker_v2_account-a'));
});

test('missing shared validator fails closed, even when the requested checkpoint is empty', () => {
  const h = harness(); delete h.window.VEZDEHOT_SESSION_VALIDATION;
  assert.equal(h.api.exportAll('account-a').ok, false); assert.equal(h.api.installAll('account-a', empty(), current).ok, false); assert.equal(h.writes.length, 0);
});

test('real shared validation rejects malformed remote sessions before writing any game', () => {
  const h = harness(new Map(), {realValidation: true}); const games = empty(); games.monopoly = state('monopoly');
  assert.equal(h.api.installAll('account-a', games, current).ok, false); assert.equal(h.writes.length, 0);
  assert.equal(h.api.installAll('account-a', empty(), current).ok, true); assert.equal(h.api.exportAll('account-a').ok, true);
});

test('all five real engine sessions survive export and remote import with stable IDs, cards and paused timers', () => {
  const original = realBundle(), h = harness(new Map(), {realValidation: true});
  for (const game of names) assert.equal(h.api.save(game, 'account-a', original[game]).ok, true);
  const exported = h.api.exportAll('account-a'); assert.equal(exported.ok, true, exported.message);
  const receiver = harness(new Map(), {realValidation: true}); const imported = receiver.api.installAll('account-a', exported.games, current); assert.equal(imported.ok, true, imported.message);
  for (const game of names) {
    const received = receiver.api.load(game, 'account-a').state;
    assert.equal(received.id, original[game].id); assert.equal(received.phase, original[game].phase); assert.equal(received.settled, original[game].settled);
    assert.deepEqual(plain(received.players), original[game].players);
    if (game !== 'bunker') assert.equal(received.paused, true);
    assert.equal(receiver.api.save(game, 'account-a', received).ok, true);
  }
});

test('real tab ownership remains available to checkpoint recovery while an external guard blocks game writes', async () => {
  const target = () => {
    const listeners = new Map(); return {addEventListener(type, fn) {listeners.set(type, [...listeners.get(type) || [], fn]);},
      dispatchEvent(event) {for (const fn of listeners.get(event.type) || []) fn(event);}};
  };
  const h = harness(), window = Object.assign(target(), h.window), document = Object.assign(target(), {hidden: false});
  let released = false;
  const context = {window, document, localStorage: window.localStorage, navigator: {locks: {request: (_, options, callback) => Promise.resolve().then(() => callback({name: 'lock'})).then(() => {released = true;})}},
    crypto: {randomUUID: () => 'test-tab'}, location: {reload() {}}, CustomEvent: window.CustomEvent, setTimeout, clearTimeout, AbortController};
  vm.runInNewContext(read('dist/tab-session.js'), context); const tab = window.VEZDEHOT_TAB_SESSION;
  await tab.start('account-a'); assert.equal(tab.ownsLock(), true); assert.equal(tab.canWrite(), true);
  tab.setWriteGuard(() => false); assert.equal(tab.canWrite(), false); assert.equal(tab.ownsLock(), true); assert.equal(tab.status().needsReload, false);
  tab.setWriteGuard(() => {throw Error('Checkpoint uncertain');}); assert.equal(tab.canWrite(), false); assert.equal(tab.ownsLock(), true);
  tab.setWriteGuard(null); assert.equal(tab.canWrite(), true); assert.throws(() => tab.setWriteGuard(true));
  let pauses = 0; document.addEventListener('vezdehot:sessionpause', () => pauses++); tab.setWriteGuard(() => false);
  window.dispatchEvent({type: 'pagehide'}); await Promise.resolve(); await Promise.resolve();
  assert.equal(pauses, 1); assert.equal(tab.ownsLock(), false); assert.equal(tab.canWrite(), false); assert.equal(released, true);
});

test('a denied cloud-guard write or retry cannot poison the durable checkpoint used for restoration', () => {
  const h=harness();seed(h);const before=new Map(h.store);h.controls.guard=false;
  assert.equal(h.api.save('poker','account-a',state('poker',9)).ok,false);
  assert.equal(h.api.clear('mafia','account-a').ok,false);
  assert.equal(h.api.retry('durak','account-a').ok,false);
  const exported=h.api.exportAll('account-a',current);assert.equal(exported.ok,true);assert.equal(exported.games.poker.turn,1);assert.equal(exported.games.mafia.turn,1);
  assert.deepEqual(h.store,before);for(const game of names)assert.equal(h.api.status(game,'account-a').pending,false);
});
