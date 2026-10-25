const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const html = fs.readFileSync(path.join(__dirname, '../dist/mafia.html'), 'utf8');
const source = html.split('// MAFIA_ENGINE_START')[1].split('// MAFIA_ENGINE_END')[0];
const difficulties = ['easy', 'normal', 'hard'];
const roles = ['civilian', 'mafia', 'mafia', 'doctor', 'detective', 'civilian', 'civilian'];
const copy = value => JSON.parse(JSON.stringify(value));

function harness() {
  let seed = 1;
  const storage = new Map(), recorded = new Map();
  const profile = { nick: 'Тест', balance: 100000, xp: 0, games: 0, wins: 0 };
  const context = {
    console, Date,
    Math: Object.assign(Object.create(Math), { random() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; } }),
    render() {}, renderSelection() {},
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    window: { VEZDEHOT: {
      scopeKey: () => 'ai-test', getProfile: () => ({ ...profile }), updateProfile: patch => Object.assign(profile, patch),
      recordResult(result) {
        recorded.set(result.id, (recorded.get(result.id) || 0) + 1);
        profile.balance += result.delta; profile.xp += result.xp; profile.games++; profile.wins += Number(result.win);
        return { ok: true };
      }
    } }
  };
  vm.createContext(context);vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../dist/session-validation.js'),'utf8'),context); vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  const api = run('({newGame,start,alive,botObservation,botChoice,botNightChoice,botVote,statementReason,publicEvidence,playerVoteFacts,chooseNight,confirmNight,beginDay,beginVote,chooseVote,castVote,continueAfterVote,targetable,endGame,validGame,saveState,restore})');
  return { context, run, api, profile, storage, recorded, seed(value) { seed = value; } };
}

function fixture(h, diff = 'normal') {
  h.run('g=newGame();paused=false;accountChanging=false');
  const g = h.context.g;
  g.players.forEach((player, id) => { player.role = roles[id]; });
  g.diff = diff; g.round = 3; g.players[6].alive = false; g.revealed = [6];
  g.voteHistory = [{ round: 1, ballots: [{ voter: 1, target: 6 }, { voter: 2, target: 5 }, { voter: 3, target: 6 }, { voter: 4, target: 6 }, { voter: 5, target: 1 }], eliminated: 6, message: 'Открытое голосование.' }];
  g.knowledge = { 0: { 2: 'mafia' }, 4: { 3: 'town' } };
  return g;
}

function decision(h, actorId, seed) {
  const actor = h.context.g.players[actorId];
  h.seed(seed); const vote = h.api.botChoice(actor, h.api.alive())?.id ?? null;
  h.seed(seed); const night = actor.role === 'civilian' ? null : h.api.botNightChoice(actor, actor.role)?.id ?? null;
  return { view: copy(h.api.botObservation(actor)), vote, night, reason: h.api.statementReason(h.context.g.players[1], actor) };
}

let count = 0;
function test(name, fn) { fn(); count++; console.log('PASS ' + name); }

test('observations expose public roles, ballots and only the acting role’s permitted private facts', () => {
  const h = harness(), g = fixture(h);
  for (const actorId of [1, 3, 4, 5]) {
    const view = h.api.botObservation(g.players[actorId]);
    assert.equal(view.role, roles[actorId]);
    assert.ok(view.players.filter(player => player.alive).every(player => player.publicRole === null && !('role' in player)));
    assert.equal(view.players[6].publicRole, 'civilian');
    assert.deepEqual(copy(view.known), actorId === 4 ? { 3: 'town' } : {});
    assert.deepEqual(copy(view.allies), actorId === 1 ? [1, 2] : []);
    assert.deepEqual(copy(view.history[0].ballots), g.voteHistory[0].ballots);
    assert.equal('personalMarks' in view || 'privateNotes' in view || 'nightTarget' in view || 'dayTarget' in view, false);
  }
  const before = JSON.stringify(g), view = h.api.botObservation(g.players[4]);
  view.players[1].publicRole = 'mafia'; view.history[0].ballots[0].target = 2; view.known[3] = 'mafia';
  assert.equal(JSON.stringify(g), before, 'an observation must not share mutable state with the game');
});

test('hidden-role permutations preserve each actor’s observation and seeded decisions on every difficulty', () => {
  const h = harness();
  for (const diff of difficulties) for (const actorId of [1, 3, 4, 5]) {
    const base = copy(fixture(h, diff)), changed = copy(base);
    const pair = actorId === 1 ? [3, 4] : actorId === 4 ? [2, 5] : [1, 4];
    [changed.players[pair[0]].role, changed.players[pair[1]].role] = [changed.players[pair[1]].role, changed.players[pair[0]].role];
    for (let id = 0; id < 7; id++) if (id !== actorId) changed.knowledge[id] = { 0: 'mafia', 5: 'town' };
    for (let seed = 1; seed <= 64; seed++) {
      h.context.g = copy(base); const before = decision(h, actorId, seed);
      h.context.g = copy(changed);
      assert.deepEqual(decision(h, actorId, seed), before, `${diff}, actor ${actorId}, seed ${seed}`);
    }
  }
});

test('notes, personal marks, legacy suspicion and unconfirmed human selections cannot steer bots', () => {
  const h = harness();
  for (const diff of difficulties) {
    const base = copy(fixture(h, diff)), changed = copy(base);
    changed.privateNotes = ['Secret: the human believes player 1 is mafia.'];
    changed.personalMarks = { 1: 'trust', 2: 'suspect', 3: 'unsure' };
    changed.publicSuspicion = { 1: -1e9, 2: 1e9, 3: -1e9, 4: 1e9 };
    changed.dayTarget = 2; changed.nightTarget = 5;
    for (let seed = 1; seed <= 64; seed++) {
      h.context.g = copy(base); h.seed(seed); const votes = copy(h.api.botVote(h.api.alive()));
      const choices = [1, 3, 4, 5].map(id => decision(h, id, seed));
      h.context.g = copy(changed); h.seed(seed);
      assert.deepEqual(copy(h.api.botVote(h.api.alive())), votes);
      assert.deepEqual([1, 3, 4, 5].map(id => decision(h, id, seed)), choices);
      assert.deepEqual(copy(h.context.g), changed, 'reasoning must not mutate the live game');
    }
  }
  assert.equal(h.profile.balance, 100000); assert.equal(h.storage.size, 0); assert.equal(h.recorded.size, 0);
});

test('a detective uses its own confirmed result and never repeats a completed investigation', () => {
  const h = harness();
  for (const diff of difficulties) {
    const g = fixture(h, diff), detective = g.players[4];
    g.knowledge[4] = { 1: 'mafia', 3: 'town' };
    for (let seed = 1; seed <= 64; seed++) {
      h.seed(seed); assert.equal(h.api.botChoice(detective, h.api.alive()).id, 1);
      h.seed(seed); const target = h.api.botNightChoice(detective, 'detective');
      assert.ok(target.alive && ![1, 3, 4].includes(target.id));
    }
    assert.deepEqual(copy(h.api.botObservation(detective).known), { 1: 'mafia', 3: 'town' });
    g.knowledge[4] = { 1: 'town', 3: 'town' };
    for (let seed = 1; seed <= 64; seed++) {
      h.seed(seed); assert.ok(![1, 3].includes(h.api.botChoice(detective, h.api.alive()).id));
    }
  }
});

test('mafia ally knowledge changes with its team and excludes allies from day and night targets', () => {
  const h = harness();
  for (const diff of difficulties) for (const ally of [2, 5]) {
    const g = fixture(h, diff), mafia = g.players[1];
    if (ally === 5) [g.players[2].role, g.players[5].role] = [g.players[5].role, g.players[2].role];
    assert.deepEqual(copy(h.api.botObservation(mafia).allies), [1, ally]);
    for (let seed = 1; seed <= 64; seed++) {
      h.seed(seed); const vote = h.api.botChoice(mafia, h.api.alive());
      h.seed(seed); const attack = h.api.botNightChoice(mafia, 'mafia');
      assert.ok(vote.alive && vote.role !== 'mafia'); assert.ok(attack.alive && attack.role !== 'mafia');
    }
  }
});

test('the full night resolver chooses doctor protection independently of the human mafia’s victim', () => {
  const h = harness();
  for (const diff of difficulties) {
    const base = copy(fixture(h, diff));
    [base.players[0].role, base.players[1].role] = [base.players[1].role, base.players[0].role];
    for (let seed = 1; seed <= 64; seed++) {
      const protectedIds = [1, 4].map(target => {
        h.context.g = copy(base); h.context.g.nightTarget = target; h.seed(seed);
        h.api.confirmNight();
        assert.notEqual(h.context.g.phase, 'night');
        const protectedId = h.context.g.lastDoctorTarget[3];
        assert.ok(base.players[protectedId].alive);
        assert.equal(h.context.g.players[target].alive, protectedId === target);
        return protectedId;
      });
      assert.equal(protectedIds[0], protectedIds[1], `${diff}, seed ${seed}`);
    }
  }
});

test('changing public ballot evidence changes decisions without changing any hidden role', () => {
  const h = harness();
  for (const diff of difficulties) {
    const g = fixture(h, diff); g.round = 2;
    g.players[6].role = 'mafia'; g.players[2].role = 'civilian';
    const choose = trusted => {
      g.voteHistory = [{ round: 1, ballots: [{ voter: trusted, target: 6 }, { voter: trusted === 1 ? 2 : 1, target: 0 }], eliminated: 6, message: 'Роль мафии раскрыта.' }];
      h.seed(1234); return h.api.botChoice(g.players[5], [g.players[1], g.players[2]]).id;
    };
    assert.equal(choose(1), 2); assert.equal(choose(2), 1);
    const mafiaEvidence = copy(h.api.publicEvidence(g.players[2], h.api.botObservation(g.players[5])));
    assert.ok(mafiaEvidence.some(fact => fact.weight < 0));
    g.players[6].role = 'civilian';
    const townEvidence = copy(h.api.publicEvidence(g.players[2], h.api.botObservation(g.players[5])));
    assert.ok(townEvidence.some(fact => fact.weight > 0));
    assert.notDeepEqual(townEvidence, mafiaEvidence, 'disclosed roles are usable public evidence');
  }
});

test('postgame facts count only actual human ballots and preserve ties, other eliminations and missing outcomes', () => {
  const h = harness(), g = fixture(h); g.round = 5;
  g.voteHistory = [
    { round: 1, ballots: [{ voter: 0, target: 1 }, { voter: 3, target: 1 }], eliminated: 1, message: 'Исключена мафия.' },
    { round: 2, ballots: [{ voter: 0, target: 3 }, { voter: 2, target: 5 }], eliminated: null, message: 'Ничья.' },
    { round: 3, ballots: [{ voter: 0, target: 5 }, { voter: 2, target: 4 }], eliminated: 4, message: 'Выбыл другой житель.' },
    { round: 4, ballots: [{ voter: 0, target: 3 }], message: 'Старый архив.' },
    { round: 5, ballots: [{ voter: 2, target: 3 }], eliminated: null, message: 'Наблюдение.' }
  ];
  g.statements = [{ actor: 2, target: 3, text: 'Версия.' }]; g.dayTarget = 2;
  assert.equal(h.api.playerVoteFacts(), null, 'living roles must not enter a review before the game ends');
  g.players[0].alive = false; g.players[1].alive = false; g.players[2].alive = false; g.players[4].alive = false;
  h.api.endGame('town', 'Все участники мафии выбыли.');
  const facts = h.api.playerVoteFacts();
  assert.equal(facts.total, 4); assert.equal(facts.againstMafia, 1); assert.equal(facts.againstTown, 3);
  assert.deepEqual(Array.from(facts.rows, row => row.target), [1, 3, 5, 3]);
  assert.deepEqual(Array.from(facts.rows, row => row.eliminated), [1, null, 4, undefined]);
  assert.equal(facts.rows[2].outName, g.players[4].name); assert.equal(facts.rows[3].outName, null);
  const expected = copy(facts), balance = h.profile.balance;
  h.context.g = null; h.api.restore();
  assert.deepEqual(copy(h.api.playerVoteFacts()), expected); assert.equal(h.profile.balance, balance);
  assert.equal(h.recorded.get(g.id), 1);
  h.context.g.voteHistory = [];
  assert.deepEqual(copy(h.api.playerVoteFacts()), { rows: [], total: 0, againstMafia: 0, againstTown: 0 });
  h.context.g = null; assert.equal(h.api.playerVoteFacts(), null);
});

test('restore preserves the evidence, private knowledge, decisions and explicit pause without charging again', () => {
  const h = harness(), g = fixture(h, 'hard');
  g.phase = 'vote'; g.dayTarget = 2; g.personalMarks = { 1: 'suspect' }; g.publicSuspicion = { 1: 1e9 };
  g.knowledge[4] = { 1: 'mafia', 3: 'town' }; h.context.paused = true;
  const expected = [1, 3, 4, 5].map(id => decision(h, id, 867));
  const balance = h.profile.balance;
  assert.equal(h.api.saveState(), true);
  h.context.g = null; h.context.paused = false; h.api.restore();
  assert.equal(h.context.g.phase, 'vote'); assert.equal(h.context.g.dayTarget, 2); assert.equal(h.context.paused, true);
  assert.deepEqual([1, 3, 4, 5].map(id => decision(h, id, 867)), expected);
  assert.deepEqual(copy(h.context.g.personalMarks), { 1: 'suspect' });
  h.api.castVote(); assert.equal(h.context.g.phase, 'vote');
  assert.equal(h.profile.balance, balance); assert.equal(h.recorded.size, 0);
});

test('90 seeded games across all difficulties finish with legal choices, factual reviews and one settlement', () => {
  for (const [difficultyIndex, diff] of difficulties.entries()) {
    const h = harness(); h.profile.mafiaDiff = diff;
    for (let game = 0; game < 30; game++) {
      h.run('g=null;paused=false'); h.seed(1000 * (difficultyIndex + 1) + game); h.api.start();
      assert.equal(h.context.g.diff, diff); let steps = 0;
      while (!h.context.g.over && steps++ < 130) {
        const g = h.context.g, me = g.players[0];
        if (g.phase === 'night') {
          if (me.alive && me.role !== 'civilian') {
            const choices = g.players.filter(player => h.api.targetable(player, me.role, me));
            if (choices.length) h.api.chooseNight(choices[game % choices.length].id);
          }
          h.api.confirmNight();
        } else if (g.phase === 'dawn') h.api.beginDay();
        else if (g.phase === 'day') h.api.beginVote();
        else if (g.phase === 'vote') {
          const alive = new Set(g.players.filter(player => player.alive).map(player => player.id));
          if (me.alive) {
            const choices = g.players.filter(player => h.api.targetable(player, 'vote', me));
            h.api.chooseVote(choices[game % choices.length].id);
          }
          h.api.castVote(); assert.equal(g.ballots.length, alive.size);
          assert.equal(new Set(g.ballots.map(ballot => ballot.voter)).size, alive.size);
          for (const ballot of g.ballots) {
            assert.ok(alive.has(ballot.voter) && alive.has(ballot.target) && ballot.voter !== ballot.target);
            if (ballot.voter !== 0) {
              assert.equal(ballot.target, g.statements.find(statement => statement.actor === ballot.voter).target);
              if (g.players[ballot.voter].role === 'mafia') assert.notEqual(g.players[ballot.target].role, 'mafia');
            }
          }
        } else if (g.phase === 'voteResult') h.api.continueAfterVote();
        else assert.fail('Unexpected phase: ' + g.phase);
        assert.equal(h.api.validGame(g), true);
      }
      const g = h.context.g;
      assert.equal(g.over, true, `${diff}, game ${game} did not finish`); assert.equal(g.settled, true);
      const mafia = g.players.filter(player => player.alive && player.role === 'mafia').length;
      const town = g.players.filter(player => player.alive && player.role !== 'mafia').length;
      if (g.winningTeam === 'town') assert.equal(mafia, 0);
      else if (g.winningTeam === 'mafia') assert.ok(mafia >= town && mafia > 0);
      else { assert.equal(g.round, 25); assert.ok(mafia > 0 && mafia < town); }
      assert.equal(g.win, g.winningTeam === (g.players[0].role === 'mafia' ? 'mafia' : 'town'));
      const ballots = g.voteHistory.flatMap(round => round.ballots).filter(ballot => ballot.voter === 0);
      const facts = h.api.playerVoteFacts();
      assert.equal(facts.total, ballots.length);
      assert.equal(facts.againstMafia, ballots.filter(ballot => g.players[ballot.target].role === 'mafia').length);
      assert.equal(facts.againstMafia + facts.againstTown, facts.total);
      assert.equal(h.recorded.get(g.id), 1);
    }
    const g = h.context.g, facts = copy(h.api.playerVoteFacts()), balance = h.profile.balance;
    h.context.g = null; h.api.restore(); h.context.g = null; h.api.restore();
    assert.deepEqual(copy(h.api.playerVoteFacts()), facts); assert.equal(h.profile.balance, balance); assert.equal(h.recorded.get(g.id), 1);
  }
});

console.log(`${count} Mafia AI checks passed`);
