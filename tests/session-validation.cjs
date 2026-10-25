'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), read = file => fs.readFileSync(path.join(root, file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const effects = [], forbidden = name => () => { effects.push(name); throw Error('Forbidden validator effect: ' + name); };
const isolatedWindow = {};
for (const key of ['VEZDEHOT', 'VEZDEHOT_GAME_STORE', 'VEZDEHOT_TAB_SESSION', 'localStorage', 'document']) {
  Object.defineProperty(isolatedWindow, key, { get: forbidden('window.' + key) });
}
const validationContext = {window: isolatedWindow, Math: Object.assign(Object.create(Math), {random: forbidden('rng')}), Date: {now: forbidden('clock')}, structuredClone,
  setTimeout: forbidden('timer'), clearTimeout: forbidden('timer cancellation')};
for (const key of ['localStorage', 'document', 'g', 's']) Object.defineProperty(validationContext, key, {get: forbidden(key)});
const validationSource = read('dist/session-validation.js');
vm.createContext(validationContext);
vm.runInContext(validationSource, validationContext);
const api = isolatedWindow.VEZDEHOT_SESSION_VALIDATION;
assert.equal(typeof api?.validate, 'function');
const validate = (game, payload, remote = false) => api.validate(game, payload, {remote});

function engineContext(seed = 98117) {
  const storage = new Map();
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const ctx = {console, Date: {now: () => 1700000000000}, Math: Object.assign(Object.create(Math), {random}),
    window: {}, document: {hidden: false},
    s: {nick: 'Snapshot', balance: 10000, wins: 0, games: 0, xp: 0, view: 'game'},
    ranks: ['6','7','8','9','10','J','Q','K','A'], suits: [['♠','black'],['♥','red'],['♦','red'],['♣','black']],
    botNames: ['A','B','C','D','E'], avatars: ['A','B','C','D','E'],
    localStorage: {getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
    save() {}, render() {}, renderSelection() {}, toast(message) {throw Error(message);}, fmt: String, esc: String, $: () => null,
    setTimeout: () => 1, clearTimeout() {}};
  vm.createContext(ctx); vm.runInContext(validationSource, ctx); return ctx;
}
function collectFixtures() {
  const games = Object.fromEntries(['durak','bunker','poker','mafia','monopoly'].map(game => [game, []]));
  const collect = (game, value, key = value.phase) => {if (!games[game].some(item => item.key === key)) games[game].push({key, state: plain(value)});};
  const mainHtml = read('dist/index.html'), main = engineContext();
  vm.runInContext(mainHtml.slice(mainHtml.indexOf('    function deck(){'), mainHtml.indexOf('    function canHumanAttack')) + '\nthis.a={newGame,playAttack,botAttack,humanDefend,humanTake,botDefend,finishAttack,continueRound,canAddAttack,beats,startBunker,bunkerHumanReveal,bunkerHumanVote,bunkerContinue};', main);
  const d = main.a.newGame({bots: 2, diff: 'normal', stake: 100}); main.s.game = d;
  let actions = 0;
  while (!d.over && actions++ < 10000) {
    collect('durak', d);
    if (['resolve','roundEnd'].includes(d.phase)) main.a.continueRound();
    else if (d.phase === 'attack') {
      if (d.attacker === 0) {d.selected = d.players[0].hand.findIndex(card => main.a.canAddAttack(card, d)); if (d.selected >= 0) main.a.playAttack(); else main.a.finishAttack();}
      else main.a.botAttack();
    } else if (d.defender === 0) {d.selected = d.players[0].hand.findIndex(card => main.a.beats(card, d.table.at(-1).a, d)); if (d.selected >= 0) main.a.humanDefend(); else main.a.humanTake();}
    else main.a.botDefend();
  }
  assert(d.over, 'actual Durak fixture terminates'); collect('durak', d);
  main.s.game = null; main.s.balance = 10000; main.a.startBunker({diff: 'hard', scenarioChoice: 'POLAR / 06'});
  const b = main.s.game;
  for (let rounds = 0; !b.over && rounds++ < 3;) {
    collect('bunker', b); main.a.bunkerHumanReveal(b.players[0].cards.findIndex(card => !card.revealed)); collect('bunker', b);
    main.a.bunkerHumanVote(b.players.findIndex((p, index) => index > 0 && p.alive)); collect('bunker', b); main.a.bunkerContinue();
  }
  assert(b.over); collect('bunker', b);

  const pokerHtml = read('dist/poker.html'), poker = engineContext();
  vm.runInContext(pokerHtml.split('// POKER_ENGINE_START')[1].split('// POKER_ENGINE_END')[0] + '\nthis.a={pokerNewGame,pokerAction,pokerContinue,legalActions,pokerNextHand};', poker);
  const p = poker.a.pokerNewGame('Snapshot', 'hard', 1);
  for (let actions = 0; !p.over && actions++ < 100;) {
    collect('poker', p, p.stage + ':' + p.phase);
    if (p.phase === 'review') poker.a.pokerContinue(p);
    else {const legal = poker.a.legalActions(p, p.toAct); assert(poker.a.pokerAction(p, p.toAct, legal.check ? 'check' : 'call'));}
  }
  assert(p.over); collect('poker', p, 'over'); collect('poker', poker.a.pokerNextHand(p), 'next-hand');

  const mafiaHtml = read('dist/mafia.html'), mafia = engineContext();
  vm.runInContext(mafiaHtml.split('// MAFIA_ENGINE_START')[1].split('// MAFIA_ENGINE_END')[0] + '\nthis.a={newGame,chooseNight,confirmNight,beginDay,beginVote,chooseVote,castVote,continueAfterVote,targetable};', mafia);
  const m = mafia.a.newGame(); mafia.g = m;
  for (let actions = 0; !m.over && actions++ < 200;) {
    collect('mafia', m);
    if (m.phase === 'night') {const me = m.players[0]; if (me.alive && me.role !== 'civilian') {const target = m.players.find(p => mafia.a.targetable(p, me.role, me)); if (target) mafia.a.chooseNight(target.id);} mafia.a.confirmNight();}
    else if (m.phase === 'dawn') mafia.a.beginDay();
    else if (m.phase === 'day') mafia.a.beginVote();
    else if (m.phase === 'vote') {if (m.players[0].alive) {const target = m.players.find(p => mafia.a.targetable(p, 'vote', m.players[0])); if (target) mafia.a.chooseVote(target.id);} mafia.a.castVote();}
    else mafia.a.continueAfterVote();
  }
  assert(m.over); collect('mafia', m);

  const monoHtml = read('dist/monopoly.html'), mono = engineContext();
  vm.runInContext(monoHtml.split("(function(){'use strict';")[1].split('// Engine ends here.')[0], mono);
  const city = mono.newGame(); mono.game = city; mono.initialized = true;
  for (let actions = 0; !city.over && actions++ < 400;) {
    collect('monopoly', city);
    if (city.phase === 'ready') mono.roll();
    else if (city.phase === 'rolling') mono.resolveRoll();
    else if (city.phase === 'buy') {if (city.players[0].money >= city.board[city.players[0].pos].price + 150) mono.buy(); else mono.skipBuy();}
    else mono.endTurn();
  }
  assert(city.over); collect('monopoly', city);
  return games;
}
const fixtures = collectFixtures(), first = game => plain(fixtures[game][0].state), final = game => plain(fixtures[game].find(item => item.state.over).state);
let count = 0;
function test(name, fn) {fn(); count++; console.log('PASS ' + name);}

test('real engines produce accepted current snapshots across every saved phase', () => {
  const seen = {};
  for (const [game, states] of Object.entries(fixtures)) {
    seen[game] = [...new Set(states.map(item => item.state.phase))];
    for (const {state} of states) {assert(validate(game, freeze(plain(state)))); assert(validate(game, freeze(plain(state)), true));}
  }
  assert.deepEqual(seen.durak.sort(), ['attack','defend','over','resolve','roundEnd']);
  assert.deepEqual(seen.bunker.sort(), ['over','reveal','vote','voteResult']);
  assert.deepEqual(seen.poker.sort(), ['betting','over','review']);
  assert.deepEqual(seen.mafia.sort(), ['dawn','day','night','result','vote','voteResult']);
  assert.deepEqual(seen.monopoly.sort(), ['buy','over','ready','review','rolling']);
});
test('remote imports pause active timers or actions without changing phase, cards, targets, roles or IDs', () => {
  for (const [game, states] of Object.entries(fixtures)) for (const {state} of states) {
    const before = JSON.stringify(state), restored = validate(game, state, true);
    assert.equal(JSON.stringify(state), before, 'input must not mutate'); assert.notEqual(restored, state);
    assert.equal(restored.id, state.id); assert.equal(restored.phase, state.phase); assert.equal(restored.settled, state.settled);
    if (!state.over && game !== 'bunker') assert.equal(restored.paused, true);
    if (game === 'bunker') assert.equal(restored.paused, state.paused, 'manual Bunker phases need no invented pause flag');
    if (game === 'poker' || game === 'durak') {
      assert.deepEqual(plain(restored.deck), state.deck);
      assert.deepEqual(plain(restored.players.map(p => p.hand)), state.players.map(p => p.hand));
    }
    if (game === 'poker') {assert.equal(restored.tableId, state.tableId); assert.deepEqual(plain(restored.burn), state.burn); assert.deepEqual(plain(restored.community), state.community);}
    if (game === 'mafia') {assert.deepEqual(plain(restored.players.map(p => p.role)), state.players.map(p => p.role)); assert.deepEqual(plain(restored.knowledge), state.knowledge); assert.equal(restored.nightTarget, state.nightTarget); assert.equal(restored.dayTarget, state.dayTarget);}
    if (game === 'bunker') {assert.deepEqual(plain(restored.players.map(p => p.cards)), state.players.map(p => p.cards)); assert.deepEqual(plain(restored.events), state.events);}
  }
});
test('validated states are detached deeply, including nested hidden data', () => {
  for (const game of Object.keys(fixtures)) {
    const input = first(game), before = JSON.stringify(input), result = validate(game, input, true);
    result.players[0].name = 'Changed detached output';
    if (game === 'durak' || game === 'poker') result.deck[0].rank = 'Changed';
    else if (game === 'mafia') result.players[1].role = 'Changed';
    else if (game === 'bunker') result.players[1].cards[0].tags.push('Changed');
    else result.board[1].price = -1;
    assert.equal(JSON.stringify(input), before);
  }
});
test('all twenty cross-game substitutions, unknown games and malformed payload types are rejected', () => {
  for (const game of Object.keys(fixtures)) {
    assert.equal(validate(game, null, true), null);
    for (const other of Object.keys(fixtures)) if (other !== game) assert.throws(() => validate(game, first(other), true), `${other} as ${game}`);
    for (const bad of [undefined, false, 4, 'state', [], {}]) assert.throws(() => validate(game, bad, true));
  }
  assert.throws(() => validate('unknown', first('poker'), true));
});
test('nested corruption is rejected before state reaches a game page', () => {
  const mutations = {
    durak: [g => g.deck.push(g.deck[0]), g => g.players[0].hand[0].id = 'fake', g => g.attacker = 99, g => g.phase = 'defend'],
    bunker: [g => g.players[0].cards[0].tags = ['unknown'], g => g.players[0].cards.pop(), g => g.events[0].focus = 'unknown', g => g.eliminated = [0]],
    poker: [g => g.deck[0] = g.deck[1], g => g.players[0].chips++, g => g.toAct = 99, g => g.tableId = 'bad'],
    mafia: [g => g.players[1].role = 'unknown', g => g.knowledge = {0: null}, g => g.ballots = [{voter: 1, target: 99}], g => g.over = true],
    monopoly: [g => g.players[0].money++, g => g.board[0].owner = 1, g => g.turn = 99, g => g.dice = [0, 7]]
  };
  for (const [game, changes] of Object.entries(mutations)) for (const change of changes) {const value = first(game); change(value); assert.throws(() => validate(game, value, true), game);}
});
test('current remote schemas require bounded stable IDs and reject legacy engine versions', () => {
  for (const game of Object.keys(fixtures)) {
    for (const id of [undefined, '', 'x'.repeat(101), 12]) {const value = first(game); if (id === undefined) delete value.id; else value.id = id; assert.throws(() => validate(game, value, true), game);}
    const value = first(game), field = game === 'durak' ? 'engineVersion' : 'version'; value[field]--; assert.throws(() => validate(game, value, true));
  }
  const poker = first('poker'); delete poker.tableId; assert.throws(() => validate('poker', poker, true));
  const next = fixtures.poker.find(item => item.key === 'next-hand').state; assert.notEqual(next.id, next.tableId);
  const restored = validate('poker', next, true); assert.equal(restored.id, next.id); assert.equal(restored.tableId, next.tableId);
});
test('pending payouts remain pending and already settled results retain their IDs and status', () => {
  for (const game of Object.keys(fixtures)) {
    const pending = final(game); pending.settled = false;
    const restored = validate(game, pending, true); assert.equal(restored.over, true); assert.equal(restored.settled, false); assert.equal(restored.id, pending.id);
    pending.settled = true; assert.equal(validate(game, pending, true).settled, true);
    for (const field of ['payout','paidPot','prizes','pots','winner','winners','win','draw','winningTeam','result']) if (pending[field] !== undefined) assert.deepEqual(plain(restored[field]), pending[field], game + ' ' + field);
  }
});
test('remote active games cannot claim a completed settlement or omit settlement status', () => {
  for (const game of Object.keys(fixtures)) {
    const paid = first(game); paid.settled = true; assert.throws(() => validate(game, paid, true), game);
    delete paid.settled; assert.throws(() => validate(game, paid, true), game);
  }
});
test('a remote Monopoly roll keeps its committed dice and destination work, and uses the canonical board', () => {
  const roll = plain(fixtures.monopoly.find(item => item.state.phase === 'rolling').state), before = JSON.stringify(roll);
  roll.board[1].price = 1; roll.board[1].rent = 999; roll.board[1].title = 'Untrusted metadata';
  const result = validate('monopoly', roll, true);
  assert.equal(result.phase, 'rolling'); assert.equal(result.paused, true); assert.equal(result.pendingSteps, roll.dice[0] + roll.dice[1]); assert.deepEqual(plain(result.dice), roll.dice);
  assert.equal(result.players[0].pos, roll.players[0].pos); assert.equal(result.board[1].price, 120); assert.equal(result.board[1].rent, 22); assert.equal(result.board[1].title, 'Маяк');
  assert.equal(JSON.stringify(fixtures.monopoly.find(item => item.state.phase === 'rolling').state), before);
});
test('local legacy Durak taken-card migration removes staged duplicates exactly once', () => {
  const legacy = first('durak'), card = legacy.players[legacy.attacker].hand.shift();
  legacy.engineVersion = 1; legacy.phase = 'resolve'; legacy.table = [{a: card, d: null}]; legacy.resolve = {took: true, prepared: true};
  legacy.players[legacy.defender].hand.push(plain(card)); delete legacy.discardCount;
  const before = JSON.stringify(legacy), once = validate('durak', legacy), twice = validate('durak', once);
  assert.equal(JSON.stringify(legacy), before); assert.equal(once.engineVersion, 3); assert.equal(once.phase, 'roundEnd'); assert.equal(once.pendingRound.took, true);
  const cards = [...once.deck, ...once.players.flatMap(p => p.hand), ...once.table.flatMap(pair => pair.d ? [pair.a, pair.d] : [pair.a])];
  assert.equal(cards.length + once.discardCount, 36); assert.equal(new Set(cards.map(c => c.id)).size, cards.length); assert.deepEqual(plain(twice), plain(once));
  assert.throws(() => validate('durak', legacy, true));
});
test('legacy local games receive deterministic IDs without clock or random access', () => {
  for (const game of ['durak','bunker']) {
    const value = first(game); delete value.id; delete value[game === 'durak' ? 'engineVersion' : 'version'];
    const before = JSON.stringify(value), a = validate(game, value), b = validate(game, value);
    assert.equal(JSON.stringify(value), before); assert.equal(a.id, b.id); assert.equal(typeof a.id, 'string'); assert(a.id.length > 0 && a.id.length <= 100); assert.deepEqual(plain(a), plain(b));
    assert.throws(() => validate(game, value, true));
  }
});
test('local historical result migrations do not manufacture a new pending payment', () => {
  for (const game of ['durak','bunker']) {
    const old = final(game); delete old[game === 'durak' ? 'engineVersion' : 'version']; delete old.settled;
    assert.equal(validate(game, old).settled, true);
  }
  const poker = final('poker'); poker.version = 2; delete poker.tableId; delete poker.handNumber; delete poker.handStartChips; delete poker.tableHistory;
  assert(validate('poker', poker)); assert.throws(() => validate('poker', poker, true));
});
test('legacy Mafia vote archive and local active pause semantics remain compatible', () => {
  const mafia = first('mafia'); mafia.phase = 'night'; mafia.round = 3; mafia.votes = null; mafia.ballots = [{voter: 0, target: 1}]; delete mafia.voteHistory;
  const restored = validate('mafia', mafia); assert.equal(restored.voteHistory[0].round, 2); assert.deepEqual(plain(restored.voteHistory[0].ballots), mafia.ballots);
  for (const game of ['durak','poker','mafia']) {const state = first(game); state.paused = false; assert.equal(!!validate(game, state).paused, false); assert.equal(validate(game, state, true).paused, true);}
});
test('loading and validating all fixtures never reads or changes environment state', () => {assert.deepEqual(effects, []);});
console.log(count + ' shared session validation checks passed');
