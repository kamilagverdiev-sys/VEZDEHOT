'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const html = fs.readFileSync(path.join(__dirname, '../dist/mafia.html'), 'utf8');
const inline = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const section = name => html.split('// ' + name + '_START')[1].split('// ' + name + '_END')[0];
const engine = section('MAFIA_ENGINE'), ui = section('MAFIA_UI'), walkthrough = section('MAFIA_WALKTHROUGH');
const plain = value => JSON.parse(JSON.stringify(value));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const roleLabels = { detective: 'Комиссар', mafia: 'Мафия', doctor: 'Доктор', civilian: 'Мирный' };
const effects = [];
const forbidden = label => () => { effects.push(label); throw new Error('Isolated walkthrough touched ' + label); };
const isolated = vm.createContext({
  console, Math: Object.assign(Object.create(Math), { random: forbidden('global RNG') }), Date: { now: forbidden('clock') },
  localStorage: { getItem: forbidden('storage read'), setItem: forbidden('storage write'), removeItem: forbidden('storage delete') },
  setTimeout: forbidden('timer'), clearTimeout: forbidden('timer'), setInterval: forbidden('timer'), clearInterval: forbidden('timer'),
  window: new Proxy({}, { get: forbidden('window') }), document: new Proxy({}, { get: forbidden('document') })
});
vm.runInContext("'use strict';\n" + engine + '\n' + walkthrough + '\nthis.adapter=mafiaWalkthrough();this.rules={mafiaCore,validGame};', isolated);
const adapter = isolated.adapter, rules = isolated.rules;
const targetChoice = choice => /^(night|vote)-target:/.test(choice.id);
function coreAction(id) {
  if (id.startsWith('night-target:')) return ['chooseNight', Number(id.slice(13))];
  if (id.startsWith('vote-target:')) return ['chooseVote', Number(id.slice(12))];
  return [{ 'confirm-night': 'confirmNight', 'begin-day': 'beginDay', 'begin-vote': 'beginVote', 'confirm-vote': 'castVote', 'next-night': 'continueAfterVote' }[id]];
}

function invariant(state, run = adapter) {
  assert.equal(rules.validGame(state.game), true); assert.equal(state.kind, 'mafia-lesson-v1');
  assert.ok(Number.isInteger(state.seed) && state.seed >= 0 && state.seed < 2 ** 32);
  const before = JSON.stringify(state), view = run.view(freeze(state)), g = state.game;
  assert.equal(JSON.stringify(state), before, 'view must not mutate its state');
  assert.deepEqual(plain(state), plain(JSON.parse(before)), 'state must survive JSON serialization');
  assert.equal(typeof view.title, 'string'); assert.equal(typeof view.text, 'string');
  assert.ok(Number.isInteger(view.total) && view.total > 0 && view.total <= 30);
  assert.ok(Number.isInteger(view.step) && view.step >= 0 && view.step <= view.total);
  assert.equal(view.done, g.over); assert.ok(view.choices.length <= 8);
  assert.equal(new Set(view.choices.map(choice => choice.id)).size, view.choices.length);
  if (view.done) { assert.equal(view.choices.length, 0); assert.equal(view.step, view.total); }
  else assert.ok(view.choices.some(choice => !choice.disabled));
  assert.equal(view.people.length, 7);
  view.people.forEach((person, id) => {
    const player = g.players[id], known = g.knowledge[0]?.[id];
    assert.equal(person.name, player.name); assert.equal(person.alive, player.alive); assert.equal(person.self, id === 0);
    if (g.over || !player.alive || id === 0) assert.equal(person.badge, roleLabels[player.role]);
    else {
      assert.equal(person.badge, known ? 'Проверен тобой' : 'Роль неизвестна');
      assert.equal(person.detail, known ? 'Личная проверка: ' + (known === 'mafia' ? 'мафия' : 'не мафия') : '');
      assert.equal('role' in person || 'knowledge' in person, false);
    }
  });
  for (const choice of view.choices) {
    assert.equal(typeof choice.id, 'string'); assert.ok(choice.id); assert.equal(typeof choice.label, 'string');
    if (targetChoice(choice)) {
      const [method, id] = coreAction(choice.id), core = rules.mafiaCore(g, forbidden('view RNG'));
      assert.ok(core.targetable(g.players[id], method === 'chooseNight' ? g.players[0].role : 'vote', g.players[0]));
    }
  }
  assert.equal(g.settled, false, 'the disposable game never settles a real result');
  assert.deepEqual(effects, []);
  return view;
}

function apply(state, id, run = adapter) {
  const before = JSON.stringify(state), offered = run.view(state).choices.find(choice => choice.id === id && !choice.disabled);
  const next = run.act(freeze(state), id);
  assert.equal(JSON.stringify(state), before, 'act must not mutate its input'); invariant(next, run);
  if (offered) {
    const expected = plain(state.game), [method, ...args] = coreAction(id); let seed = state.seed;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    assert.equal(rules.mafiaCore(expected, random)[method](...args), true);
    assert.deepEqual(plain(next.game), plain(expected), 'adapter action must apply the shared rules: ' + id);
    assert.equal(next.seed, seed, 'adapter must consume exactly the rules engine RNG stream');
  }
  return next;
}

function play(run = adapter, offset = 0) {
  let state = run.create(), actions = 0;
  while (!run.view(state).done && actions++ < 30) {
    const choices = run.view(state).choices.filter(choice => !choice.disabled), targets = choices.filter(targetChoice);
    if (targets.length) state = run.act(state, targets[offset % targets.length].id);
    const advance = run.view(state).choices.find(choice => !choice.disabled && !targetChoice(choice));
    assert.ok(advance); state = run.act(state, advance.id);
  }
  assert.equal(run.view(state).done, true); return state;
}

function liveHarness() {
  const store = new Map(), counts = { reads: 0, writes: 0, profiles: 0, updates: 0, records: 0, random: 0, time: 0, timers: 0, renders: 0 };
  const profile = { nick: 'Живой игрок', balance: 10000, games: 0, wins: 0, xp: 0 };
  let seed = 1234, locked = false, owned = true, guide = null;
  const effect = key => { counts[key]++; if (locked) throw new Error('Lesson touched live ' + key); };
  const trigger = {}, rulesTrigger = {}, app = { style: {}, inert: false };
  const context = {
    console, Math: Object.assign(Object.create(Math), { random() { effect('random'); seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; } }),
    Date: { now() { effect('time'); return 1700000000000; } },
    localStorage: { getItem(key) { effect('reads'); return store.get(key) ?? null; }, setItem(key, value) { effect('writes'); store.set(key, String(value)); }, removeItem(key) { effect('writes'); store.delete(key); } },
    setTimeout() { effect('timers'); }, clearTimeout() { effect('timers'); }, setInterval() { effect('timers'); }, clearInterval() { effect('timers'); },
    document: {
      documentElement: { dataset: {} }, body: { dataset: {} }, getElementById: () => app,
      querySelector: selector => selector === '[data-mafia-training]' ? trigger : selector === '[data-rules]' ? rulesTrigger : null,
      querySelectorAll: selector => selector === '[data-mafia-training]' ? [trigger] : selector === '[data-rules]' ? [rulesTrigger] : []
    },
    window: { innerWidth: 1000, matchMedia: () => ({ matches: true }), VEZDEHOT_TAB_SESSION: { canWrite: () => owned }, VEZDEHOT_GUIDE: { open(options) { guide = options; } }, VEZDEHOT: {
      scopeKey: () => 'walk-test', getProfile() { effect('profiles'); return plain(profile); },
      updateProfile(patch) { effect('updates'); Object.assign(profile, plain(patch)); },
      recordResult(result) { effect('records'); profile.balance += result.delta; profile.xp += result.xp; profile.games++; profile.wins += Number(result.win); return { ok: true }; }
    } }
  };
  vm.createContext(context); vm.runInContext("'use strict';\n" + engine + '\n' + ui, context);
  context.render = () => { effect('renders'); }; context.renderSelection = () => { effect('renders'); };
  const run = code => vm.runInContext(code, context);
  const api = run('({start,chooseNight,confirmNight,beginDay,beginVote,chooseVote,castVote,continueAfterVote,saveState,restore,openMafiaGuide,mafiaWalkthrough})');
  return { context, api, trigger, store, profile, counts, guide: () => guide, seed(value) { seed = value; }, randomState: () => seed, lock() { locked = true; }, ownership(value) { owned = value; },
    snapshot() { return { game: plain(context.g), paused: context.paused, profile: plain(profile), store: [...store], counts: { ...counts }, seed }; } };
}

let checks = 0; const reachable = [];
function test(name, fn) { fn(); checks++; console.log('PASS ' + name); }

test('create is reproducible, disposable and explicitly discloses the prepared commissioner fragment', () => {
  const a = adapter.create(), b = adapter.create(), view = invariant(a);
  assert.deepEqual(plain(a), plain(b)); assert.notEqual(a.game, b.game); assert.notEqual(a.game.players, b.game.players);
  assert.equal(a.game.players[0].role, 'detective'); assert.equal(a.game.players.filter(player => player.alive).length, 5);
  assert.deepEqual(plain(a.game.revealed), [2, 3]); assert.equal(a.game.players[2].role, 'mafia'); assert.equal(a.game.players[3].role, 'doctor');
  assert.match(view.recap[0].text, /подготовленном фрагменте/); assert.match(view.recap[0].text, /уже выбыли/);
  assert.equal(adapter.label, 'Партия'); assert.equal(view.choices.find(choice => choice.id === 'confirm-night').disabled, true);
});

test('target selection and reselection disclose nothing or consume RNG before explicit confirmation', () => {
  const initial = adapter.create(), first = apply(initial, 'night-target:1'), changed = apply(first, 'night-target:4');
  assert.equal(first.game.phase, 'night'); assert.equal(changed.game.nightTarget, 4);
  assert.equal(changed.game.privateNotes.length, 0); assert.deepEqual(plain(changed.game.knowledge), {}); assert.equal(changed.seed, initial.seed);
  assert.deepEqual(plain(changed.game), plain(apply(initial, 'night-target:4').game));
  const dawn = apply(changed, 'confirm-night'); assert.equal(dawn.game.phase, 'dawn');
  assert.equal(dawn.game.privateNotes.length, 1); assert.equal(dawn.game.knowledge[0][4], 'town'); assert.equal(dawn.game.knowledge[0][1], undefined);
  assert.deepEqual(plain(adapter.act(dawn, 'confirm-night')), plain(dawn));
  let vote = apply(apply(dawn, 'begin-day'), 'begin-vote');
  const targets = adapter.view(vote).choices.filter(targetChoice);
  assert.ok(targets.length >= 2); const picked = apply(vote, targets[0].id), other = apply(picked, targets[1].id);
  assert.equal(other.game.voteHistory.length, 0); assert.equal(other.game.ballots.length, 0); assert.equal(other.seed, vote.seed);
  assert.deepEqual(plain(other.game), plain(apply(vote, targets[1].id).game));
});

test('every reachable phase branch follows the shared core, preserves secrecy and reaches a real team result', () => {
  let completed = 0, selections = 0, maxDepth = 0; const phases = new Set(), teams = new Set();
  const visit = (state, depth = 0) => {
    assert.ok(depth < 25); maxDepth = Math.max(maxDepth, depth); const view = invariant(state);
    reachable.push(plain(state)); phases.add(state.game.phase);
    if (view.done) { completed++; teams.add(state.game.winningTeam); assert.equal(state.game.win, state.game.winningTeam === 'town'); return; }
    const choices = view.choices.filter(choice => !choice.disabled), targets = choices.filter(targetChoice);
    if (targets.length) for (const choice of targets) {
      const selected = apply(state, choice.id); selections++;
      for (const alternate of targets) {
        const reselected = apply(selected, alternate.id), direct = apply(state, alternate.id);
        assert.deepEqual(plain(reselected.game), plain(direct.game)); assert.equal(reselected.seed, direct.seed);
      }
      const advance = adapter.view(selected).choices.find(item => !item.disabled && !targetChoice(item));
      visit(apply(selected, advance.id), depth + 2);
    } else for (const choice of choices) visit(apply(state, choice.id), depth + 1);
  };
  visit(adapter.create());
  assert.deepEqual([...phases].sort(), ['dawn', 'day', 'night', 'result', 'vote', 'voteResult']);
  assert.deepEqual([...teams].sort(), ['mafia', 'town']); assert.ok(completed >= 10 && selections >= 10);
  assert.ok(reachable.every(state => state.game.round <= 3)); assert.ok(maxDepth <= 20);
  console.log(`Walkthrough branch coverage: ${reachable.length} phase states, ${selections} selections, ${completed} completed paths`);
});

test('views ignore unchecked living roles, other detectives’ knowledge and legacy private state', () => {
  for (const state of reachable.filter(item => !item.game.over)) {
    const before = plain(adapter.view(state)), changed = plain(state), g = changed.game;
    const hidden = g.players.filter(player => player.id !== 0 && player.alive && !g.knowledge[0]?.[player.id]);
    if (hidden.length > 1) [hidden[0].role, hidden[1].role] = [hidden[1].role, hidden[0].role];
    g.knowledge[6] = { 1: 'mafia', 4: 'town' }; g.personalMarks = { 1: 'suspect', 4: 'trust' }; g.publicSuspicion = { 1: 999, 4: -999 };
    assert.deepEqual(plain(adapter.view(freeze(changed))), before);
  }
  const checked = apply(apply(adapter.create(), 'night-target:4'), 'confirm-night');
  const person = adapter.view(checked).people[4];
  if (checked.game.players[4].alive) { assert.equal(person.detail, 'Личная проверка: не мафия'); assert.notEqual(person.badge, 'Мирный'); }
});

test('disabled, invalid, stale and completed actions cannot skip a phase or change the example', () => {
  for (const state of reachable) {
    const view = adapter.view(state), allowed = new Set(view.choices.filter(choice => !choice.disabled).map(choice => choice.id));
    const invalid = ['unknown', '', 'night-target:0', 'night-target:2', 'night-target:3', 'night-target:99', 'night-target:1.5', 'vote-target:0', 'vote-target:2', 'vote-target:3', 'vote-target:-1', 'confirm-night', 'begin-day', 'begin-vote', 'confirm-vote', 'next-night'];
    for (const id of invalid.filter(id => !allowed.has(id))) assert.equal(adapter.act(freeze(state), id), state, id + ' must be ignored');
    for (const choice of view.choices.filter(choice => choice.disabled)) assert.equal(adapter.act(freeze(state), choice.id), state);
  }
  for (const state of [null, {}, { kind: 'wrong' }, { ...adapter.create(), seed: NaN }]) assert.equal(adapter.act(state, 'confirm-night'), state);
});

test('JSON-resumed examples produce exactly the same next state, RNG stream and public view', () => {
  for (const state of reachable) {
    const resumed = JSON.parse(JSON.stringify(state));
    assert.deepEqual(plain(adapter.view(resumed)), plain(adapter.view(state)));
    for (const choice of adapter.view(state).choices.filter(choice => !choice.disabled)) {
      const originalNext = apply(state, choice.id), resumedNext = apply(resumed, choice.id);
      assert.deepEqual(plain(resumedNext), plain(originalNext));
    }
  }
  assert.deepEqual(effects, []);
});

test('lobby training exposes the common adapter without creating or persisting a live game', () => {
  const h = liveHarness(); h.api.openMafiaGuide({ currentTarget: h.trigger }, 'walkthrough');
  assert.equal(h.guide().initialTab, 'walkthrough'); assert.equal(h.guide().walkthrough.label, 'Партия'); assert.equal(h.guide().trigger, h.trigger);
  assert.equal(h.guide().onClose, undefined); const before = h.snapshot(); h.lock();
  for (const offset of [0, 1, 2, 3]) play(h.guide().walkthrough, offset);
  assert.deepEqual(h.snapshot(), before); assert.equal(h.context.g, null); assert.equal(h.profile.balance, 10000);
  assert.equal(h.counts.records, 0); assert.equal(h.counts.timers, 0);
});

test('training leaves the saved paused live game, wallet, storage, RNG and timers untouched', () => {
  const h = liveHarness(); h.api.start(); assert.equal(h.profile.balance, 9900);
  const target = h.context.g.players.find(player => h.context.g.players[0].role === 'civilian' ? false : vm.runInContext('targetable', h.context)(player, h.context.g.players[0].role, h.context.g.players[0]));
  if (target) h.api.chooseNight(target.id);
  h.api.openMafiaGuide({ currentTarget: h.trigger }, 'walkthrough');
  assert.equal(h.context.paused, true); assert.equal(h.context.g.paused, true);
  const persisted = JSON.parse(h.store.get('vezdehot_mafia_v3_walk-test'));
  assert.equal(persisted.id, h.context.g.id); assert.equal(persisted.paused, true);
  const before = h.snapshot(); h.lock();
  for (const offset of [0, 1, 2, 3]) play(h.guide().walkthrough, offset);
  const restarted = h.guide().walkthrough.create(); invariant(restarted, h.guide().walkthrough);
  assert.deepEqual(h.snapshot(), before); assert.equal(h.counts.records, 0); assert.equal(h.counts.timers, 0);
});

test('production wrappers and the disposable adapter follow identical trajectories with the same random stream', () => {
  for (const offset of [0, 1, 2, 3]) {
    const h = liveHarness(); let state = adapter.create(); h.context.g = plain(state.game); h.seed(state.seed);
    const perform = id => {
      const next = apply(state, id), [method, ...args] = coreAction(id);
      assert.equal(h.api[method](...args), true);
      const actual = plain(h.context.g), expected = plain(next.game); delete actual.paused; delete expected.paused;
      actual.settled = false; assert.deepEqual(actual, expected); assert.equal(h.randomState(), next.seed); state = next;
    };
    let steps = 0;
    while (!adapter.view(state).done && steps++ < 25) {
      const targets = adapter.view(state).choices.filter(choice => !choice.disabled && targetChoice(choice));
      if (targets.length) perform(targets[offset % targets.length].id);
      perform(adapter.view(state).choices.find(choice => !choice.disabled && !targetChoice(choice)).id);
    }
    assert.equal(state.game.over, true); assert.equal(h.context.g.settled, true); assert.equal(h.counts.records, 1);
    assert.equal(h.profile.games, 1); assert.equal(h.counts.timers, 0);
  }
});

test('production pause and ownership still block actions, and round-25 draws settle and save once', () => {
  const h = liveHarness(); h.context.g = plain(adapter.create().game);
  h.context.paused = true; let before = h.snapshot();
  assert.equal(h.api.chooseNight(1), false); assert.equal(h.api.confirmNight(), false); assert.deepEqual(h.snapshot(), before);
  h.context.paused = false; h.ownership(false); before = h.snapshot();
  assert.equal(h.api.chooseNight(1), false); assert.equal(h.api.confirmNight(), false); assert.deepEqual(h.snapshot(), before);
  h.ownership(true); h.context.g.round = 25; h.context.g.phase = 'voteResult';
  const expected = plain(h.context.g), core = rules.mafiaCore(expected, forbidden('draw RNG'));
  assert.equal(core.continueAfterVote(), true); assert.equal(expected.draw, true);
  assert.equal(h.api.continueAfterVote(), true); assert.equal(h.context.g.settled, true); assert.equal(h.context.g.draw, true);
  assert.equal(h.profile.balance, 10100); assert.equal(h.profile.xp, 40); assert.equal(h.counts.records, 1);
  const saved = JSON.parse(h.store.get('vezdehot_mafia_v3_walk-test'));
  assert.equal(saved.phase, 'result'); assert.equal(saved.settled, true); assert.equal(saved.winningTeam, 'draw');
  assert.ok(h.counts.renders > 0); const settled = h.snapshot();
  assert.equal(h.api.continueAfterVote(), false); assert.deepEqual(h.snapshot(), settled);
  h.context.g = null; h.api.restore(); assert.equal(h.counts.records, 1); assert.equal(h.profile.balance, 10100);
});

assert.ok(html.includes('data-mafia-training'), 'the room must expose a walkthrough entry point');
new Function(inline);
assert.deepEqual(effects, []);
console.log(`${checks} Mafia walkthrough checks passed`);
