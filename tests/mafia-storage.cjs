'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const html = fs.readFileSync(path.join(__dirname, '../dist/mafia.html'), 'utf8');
const engine = html.split('// MAFIA_ENGINE_START')[1].split('// MAFIA_ENGINE_END')[0];
const bootstrap = html.split('// BOOTSTRAP')[1].split('})();')[0];
const storageSource = fs.readFileSync(path.join(__dirname, '../dist/game-store.js'), 'utf8');
const primary = 'vezdehot:session:v1:test-user:mafia', backup = primary + ':backup', legacy = 'vezdehot_mafia_v3_test-user';
function harness(data = new Map(), sharedProfile) {
  const profile = sharedProfile || { balance: 10000, xp: 0, games: 0, wins: 0, nick: 'Тест' };
  const seen = profile.seen || (profile.seen = new Set());
  const events = new Map(), app = { inert: false, style: {} };
  let blocked = false, owner = true, resultFailure = false, recordings = 0;
  const storage = { getItem: key => data.get(key) ?? null, setItem(key, value) { if (blocked) throw Error('quota'); data.set(key, value); }, removeItem(key) { if (blocked) throw Error('quota'); data.delete(key); } };
  const document = {
    getElementById: () => app, querySelector: () => null,
    addEventListener(name, fn) { const list = events.get(name) || []; list.push(fn); events.set(name, list); },
    dispatchEvent(event) { for (const fn of events.get(event.type) || []) fn(event); return true; }
  };
  const context = {
    console, Date, Math, Set, Map, Promise, document, localStorage: storage,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    addEventListener: document.addEventListener, dispatchEvent: document.dispatchEvent,
    render() {}, renderSelection() {},
    VEZDEHOT_TAB_SESSION: { canWrite: () => owner },
    VEZDEHOT: {
      ready: new Promise(() => {}), scopeKey: () => 'test-user', getProfile: () => ({ ...profile }),
      updateProfile: patch => Object.assign(profile, patch),
      recordResult(result) { if (resultFailure) throw Error('profile unavailable'); if (seen.has(result.id)) return; seen.add(result.id); recordings++; profile.balance += result.delta; profile.xp += result.xp; profile.games++; profile.wins += result.win ? 1 : 0; }
    }
  };
  context.window = context;
  vm.createContext(context);vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../dist/session-validation.js'),'utf8'),context); vm.runInContext(storageSource + '\n' + engine + '\n' + bootstrap, context);
  const run = code => vm.runInContext(code, context);
  return { context, data, profile, app, run, store: context.VEZDEHOT_GAME_STORE,
    block(value) { blocked = value; }, owner(value) { owner = value; }, failResults(value) { resultFailure = value; }, recordings: () => recordings,
    event(type) { document.dispatchEvent({ type }); }, fixture() { run('syncProfile();g=newGame();paused=false'); return context.g; } };
}
let count = 0;
function test(name, fn) { fn(); count++; console.log('PASS ' + name); }
test('the shipped page loads storage and tab coordination before the platform', () => {
  assert.ok(html.indexOf('src="./game-store.js"') < html.indexOf('src="./platform.js"'));
  assert.ok(html.indexOf('src="./tab-session.js"') < html.indexOf('src="./platform.js"'));
  assert.ok(html.indexOf('href="./session.css"') > html.indexOf('href="./platform.css"'));
  assert.ok(html.indexOf('src="./game-guide.js"') < html.indexOf('src="./platform.js"'));
  assert.ok(html.indexOf('href="./game-guide.css"') > html.indexOf('href="./session.css"'));
});
test('legacy migration restores exact phase, selected vote and journal without charging another entry', () => {
  const first = harness(), g = first.fixture();
  g.phase = 'vote'; g.dayTarget = 2; g.privateNotes = ['Ночь 1: проверка.'];
  first.data.set(legacy, JSON.stringify(g));
  const next = harness(first.data, first.profile), balance = next.profile.balance;
  next.run('restore()');
  assert.equal(next.context.g.id, g.id); assert.equal(next.context.g.phase, 'vote'); assert.equal(next.context.g.dayTarget, 2);
  assert.equal(next.context.g.privateNotes[0], 'Ночь 1: проверка.'); assert.equal(next.profile.balance, balance);
  assert.equal(JSON.parse(next.data.get(primary)).payload.id, g.id); assert.ok(next.data.has(legacy));
});
test('a corrupt primary recovers the previous validated phase and exposes recovery status', () => {
  const first = harness(); first.fixture(); first.run('saveState();g.phase="dawn";saveState()');
  const previous = first.data.get(backup); first.data.set(primary, '{interrupted');
  const next = harness(first.data, first.profile); next.run('restore()');
  assert.equal(next.context.g.phase, 'night'); assert.equal(next.store.status('mafia', 'test-user').status, 'recovered');
  assert.equal(next.data.get(backup), previous); assert.equal(next.data.get(primary), '{interrupted');
});
test('a parseable but malformed role, array or reference also recovers the backup', () => {
  for (const mutate of [g => g.players[1].role = 'broken', g => g.privateNotes = null, g => g.ballots = [{ voter: 1, target: 99 }], g => g.knowledge = { 0: null }, g => g.ballots = [{ voter: 1, target: 2 }, { voter: 1, target: 3 }], g => g.voteHistory = [1, 1].map(round => ({ round, ballots: [{ voter: 0, target: 1 }], message: 'Duplicate round' }))]) {
    const first = harness(); first.fixture(); first.run('saveState();g.phase="dawn";saveState()');
    const envelope = JSON.parse(first.data.get(primary)); mutate(envelope.payload); first.data.set(primary, JSON.stringify(envelope));
    const next = harness(first.data); next.run('restore()');
    assert.equal(next.context.g.phase, 'night'); assert.equal(next.store.status('mafia', 'test-user').status, 'recovered');
  }
});
test('invalid runtime state cannot replace either the primary or the backup', () => {
  const h = harness(); h.fixture(); h.run('saveState();g.phase="dawn";saveState()');
  const before = JSON.stringify([...h.data]); h.context.g.knowledge = { 0: null };
  assert.equal(h.run('saveState()').ok, false); assert.equal(JSON.stringify([...h.data]), before);
});
test('quota failures keep the current game in memory and retry writes the latest phase', () => {
  const h = harness(); h.fixture(); h.run('saveState()'); const durable = h.data.get(primary);
  h.block(true); h.context.g.phase = 'day'; assert.equal(h.run('saveState()').ok, false);
  h.run('g=null;restore()'); assert.equal(h.context.g.phase, 'day'); assert.equal(h.data.get(primary), durable);
  assert.equal(h.store.status('mafia', 'test-user').status, 'unavailable');
  h.block(false); assert.equal(h.store.retry('mafia', 'test-user').ok, true);
  const next = harness(h.data); next.run('restore()'); assert.equal(next.context.g.phase, 'day');
});
test('a handoff saves pause while owned, then blocks all stale actions and writes', () => {
  const h = harness(); h.fixture(); h.run('saveState()');
  h.event('vezdehot:sessionpause'); assert.equal(JSON.parse(h.data.get(primary)).payload.paused, true);
  h.owner(false); h.event('vezdehot:sessionlost'); const before = JSON.stringify([...h.data]), balance = h.profile.balance;
  h.run('confirmNight();togglePause();endGame("town","blocked");saveState();start();reset()');
  assert.equal(h.context.g.phase, 'night'); assert.equal(h.profile.balance, balance); assert.equal(JSON.stringify([...h.data]), before);
  assert.equal(h.app.inert, true); assert.equal(h.app.style.pointerEvents, 'none');
  const next = harness(h.data); next.run('restore()'); assert.equal(next.context.paused, true);
});
test('an unload or handoff before initial restore never clears existing progress', () => {
  const first = harness(); first.fixture(); first.run('saveState()'); const before = JSON.stringify([...first.data]);
  const next = harness(first.data); next.event('beforeunload'); next.event('vezdehot:sessionpause');
  assert.equal(JSON.stringify([...first.data]), before);
});
test('pending results survive reload, retry once and do not award again on a second reload', () => {
  const first = harness(); first.fixture(); first.failResults(true); first.run('endGame("town","Город победил.")');
  assert.equal(first.context.g.settled, false); assert.equal(JSON.parse(first.data.get(primary)).payload.settled, false);
  const next = harness(first.data, first.profile); next.run('restore()');
  assert.equal(next.context.g.settled, true); assert.equal(next.recordings(), 1);
  const again = harness(first.data, first.profile); again.run('restore()'); assert.equal(again.recordings(), 0); assert.equal(again.profile.games, 1);
});
test('a profile result rejected without throwing stays retryable while the game save succeeds', () => {
  const h = harness(); h.fixture(); const record = h.context.VEZDEHOT.recordResult;
  h.context.VEZDEHOT.recordResult = result => { record(result); return { ok: false, persisted: false }; };
  h.run('endGame("town","Город победил.")');
  assert.equal(h.context.g.settled, false); assert.equal(JSON.parse(h.data.get(primary)).payload.settled, false);
  assert.equal(h.profile.games, 1); const oldId = h.context.g.id;
  h.run('start();reset()'); assert.equal(h.context.g.id, oldId); assert.equal(h.profile.games, 1);
  h.context.VEZDEHOT.recordResult = result => { record(result); return { ok: true, persisted: true }; };
  assert.equal(h.run('settleResult()'), true); assert.equal(h.context.g.settled, true); assert.equal(h.profile.games, 1);
  assert.equal(JSON.parse(h.data.get(primary)).payload.settled, true);
});
test('explicit reset writes a tombstone so a retained legacy game cannot reappear', () => {
  const h = harness(), g = h.fixture(); h.data.set(legacy, JSON.stringify(g)); h.run('endGame("town","Город победил.");reset()');
  assert.equal(h.context.g, null); assert.equal(JSON.parse(h.data.get(primary)).payload, null);
  const next = harness(h.data); next.run('restore()'); assert.equal(next.context.g, null);
});
test('personal assumptions migrate from an older game, survive reload and reject malformed recovery', () => {
  const first = harness(), g = first.fixture(); delete g.personalMarks; first.data.set(legacy, JSON.stringify(g));
  const h = harness(first.data, first.profile); h.run('restore();markPlayer(2,"trust");markPlayer(3,"suspect")');
  assert.equal(h.context.g.id, g.id); assert.equal(h.profile.balance, 10000);
  const reloaded = harness(h.data, h.profile); reloaded.run('restore()');
  assert.equal(reloaded.context.g.personalMarks[2], 'trust'); assert.equal(reloaded.context.g.personalMarks[3], 'suspect');
  const corrupted = JSON.parse(h.data.get(primary)); corrupted.payload.personalMarks[3] = 'confirmed-mafia'; h.data.set(primary, JSON.stringify(corrupted));
  const recovered = harness(h.data, h.profile); recovered.run('restore()');
  assert.equal(recovered.store.status('mafia', 'test-user').status, 'recovered'); assert.equal(recovered.context.g.personalMarks[2], 'trust');
  assert.equal(recovered.context.g.personalMarks[3], undefined); assert.deepEqual(Object.keys(recovered.context.g.knowledge), []);
});
test('migrating legacy ballots never invents a no-elimination outcome for the factual review', () => {
  const first = harness(); const g = first.fixture(); first.run('endGame("town","Город победил.")');
  g.round = 3; g.votes = null; g.ballots = [{ voter: 0, target: 1 }]; delete g.voteHistory; delete g.eliminated;
  const data = new Map([[legacy, JSON.stringify(g)]]), next = harness(data, first.profile); next.run('restore()');
  const facts = next.run('playerVoteFacts()'); assert.equal(facts.rows.length, 1); assert.equal(facts.rows[0].round, 2);
  assert.equal(facts.rows[0].eliminated, undefined); assert.equal(next.context.g.voteHistory[0].eliminated, undefined);
});
test('rejected entry leaves setup or the completed result intact and does not create a game', () => {
 for(const rejected of [false,{ok:false,persisted:false}])for(const completed of [false,true]){
  const h=harness();if(completed){h.fixture();h.run('endGame("town","Город победил.")');}
  const previous=h.context.g,coins=h.profile.balance,before=JSON.stringify([...h.data]);h.context.VEZDEHOT.updateProfile=()=>rejected;h.run('start()');
  assert.equal(h.context.g,previous);assert.equal(h.profile.balance,coins);assert.equal(JSON.stringify([...h.data]),before);
 }
});
test('an accepted in-memory entry remains one entry when durable profile storage is unavailable', () => {
 const h=harness();let charges=0;h.context.VEZDEHOT.updateProfile=patch=>{charges++;Object.assign(h.profile,patch);return {ok:true,persisted:false}};
 h.run('start()');const id=h.context.g.id;assert.equal(h.profile.balance,9900);h.run('start()');assert.equal(h.context.g.id,id);assert.equal(charges,1);assert.equal(h.profile.balance,9900);
});
test('spectated pending result survives reload and retries settlement without another bot decision or entry', () => {
 const h=harness();h.fixture();h.context.g.players[0].alive=false;h.failResults(true);const coins=h.profile.balance;assert.equal(h.run('finishSpectating()'),true);assert.equal(h.context.g.over,true);assert.equal(h.context.g.settled,false);assert.equal(h.profile.balance,coins);
 const id=h.context.g.id,ballots=JSON.stringify(h.context.g.voteHistory),next=harness(h.data,h.profile);next.run('restore()');assert.equal(next.context.g.id,id);assert.equal(next.context.g.settled,true);assert.equal(JSON.stringify(next.context.g.voteHistory),ballots);assert.equal(next.recordings(),1);
 const again=harness(next.data,next.profile);again.run('restore()');assert.equal(again.recordings(),0);assert.equal(again.profile.games,1);
});
console.log(`${count} Mafia storage integration checks passed`);
