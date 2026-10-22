/* Run with: node tests/durak-engine.cjs. Uses the shipped inline engine, no dependencies. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../dist/index.html'), 'utf8');
const begin = source.indexOf('const DURAK_ENGINE_VERSION');
const end = source.indexOf('function bunkerRoom', begin);
assert(begin >= 0 && end > begin, 'locate production engine');
const engine = source.slice(begin, end);
function harness(seed = 1) {
  let randomSeed = seed, nextTimer = 0;
  const timers = new Map();
  const math = Object.create(Math);
  math.random = () => { randomSeed = (Math.imul(randomSeed, 1664525) + 1013904223) >>> 0; return randomSeed / 4294967296; };
  const context = { Math: math, document: { hidden: false }, setTimeout: (fn, delay) => { timers.set(++nextTimer, {fn, delay}); return nextTimer; }, clearTimeout: id => timers.delete(id), save() {}, render() {}, toast() {}, fmt: String };
  vm.createContext(context);
  vm.runInContext(`
    const suits=[['♠','black'],['♥','red'],['♦','red'],['♣','black']], ranks=['6','7','8','9','10','J','Q','K','A'];
    const avatars=['a','b','c'], botNames=['A','B','C'];
    let s={nick:'Tester',view:'game',balance:10000,xp:0,wins:0,games:0};
    function deck(){return suits.flatMap(([suit,color])=>ranks.map(rank=>({rank,suit,color,id:rank+suit})));}
    function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
    ${engine}
    function testState(){return s;}
  `, context);
  return {
    timers, context,
    run: code => vm.runInContext(code, context),
    state: () => vm.runInContext('testState()', context),
    tick() { const first = timers.entries().next().value; if (!first) return false; timers.delete(first[0]); first[1].fn(); return true; }
  };
}
function occupied(g) { return [...g.deck, ...g.players.flatMap(p => p.hand), ...g.table.flatMap(p => p.d ? [p.a,p.d] : [p.a])]; }
function check(h, discarded = new Set()) {
  const g=h.state().game, live=occupied(g), ids=live.map(c=>c.id);
  assert.equal(live.length+g.discardCount,36,'all 36 cards accounted for');
  assert.equal(new Set(ids).size,ids.length,'no duplicate card ownership');
  ids.forEach(id=>assert(!discarded.has(id),'discarded card cannot return'));
  assert(g.table.length <= 6,'six-pair attack limit');
  if(g.table.length && g.roundLimit !== null)assert(g.table.length <= g.roundLimit,'defender hand limit');
  g.finished.forEach(i=>{assert.equal(g.players[i].hand.length,0);assert.equal(g.deck.length,0);});
  assert(h.timers.size<=1,'at most one bot timer');
}
let fullGames = 0, maxActions = 0;
for (let bots=1;bots<=3;bots++) for(const diff of ['easy','normal','hard']) for(let seed=1;seed<=20;seed++) {
  const h=harness(seed*31+bots);
  h.run(`startGame({bots:${bots},diff:'${diff}',stake:0})`);
  const discarded=new Set();let actions=0;
  check(h,discarded);
  while(!h.state().game.over && actions++<3000) {
    const g=h.state().game, before=new Set(occupied(g).map(c=>c.id)), priorDiscard=g.discardCount;
    if(g.phase==='roundEnd'||g.phase==='resolve')h.run('continueRound()');
    else if(g.phase==='attack'&&g.attacker===0) {
      const i=g.players[0].hand.findIndex(c=>h.run(`canAddAttack(${JSON.stringify(c)},s.game)`));
      if(i>=0)h.run(`s.game.selected=${i};playAttack()`);else h.run('finishAttack()');
    } else if(g.phase==='defend'&&g.defender===0) {
      const i=g.players[0].hand.findIndex(c=>h.run(`beats(${JSON.stringify(c)},s.game.table[s.game.table.length-1].a,s.game)`));
      if(i>=0)h.run(`s.game.selected=${i};humanDefend()`);else h.run('humanTake()');
    } else assert(h.tick(),'automated phase has a scheduled action');
    if(g.discardCount>priorDiscard){const after=new Set(occupied(g).map(c=>c.id));const removed=[...before].filter(id=>!after.has(id));assert.equal(removed.length,g.discardCount-priorDiscard);removed.forEach(id=>discarded.add(id));}
    check(h,discarded);
  }
  assert(h.state().game.over,`${bots} bots / ${diff} / seed ${seed}: game terminates`);
  assert(actions<3000);maxActions=Math.max(maxActions,actions);fullGames++;
  const totals=JSON.stringify(h.state());h.run('settle(s.game);settle(s.game)');assert.equal(JSON.stringify(h.state()),totals,'settlement only once');
}
// Resolve and roundEnd are stable until an explicit user action, including repeated advance calls.
{
  const h=harness(14);h.run("startGame({bots:2,diff:'hard',stake:0});clearDurakTimer();s.game.attacker=0;s.game.defender=1;s.game.table=[{a:s.game.players[0].hand.pop(),d:null}];s.game.phase='defend';showResolve(s.game,true)");
  const g=h.state().game,handSize=g.players[1].hand.length;
  assert.equal(g.phase,'roundEnd');assert.equal(g.players[1].hand.length,handSize);
  const snapshot=JSON.stringify(g);h.run('advance();advance()');assert.equal(h.timers.size,0);assert.equal(JSON.stringify(g),snapshot);check(h);
  h.run('continueRound()');assert.equal(g.attacker,2,'taking skips defender in a three-player game');assert.equal(g.defender,0);check(h);
  const after=JSON.stringify(g);h.run('commitDurakRound(s.game)');assert.equal(JSON.stringify(g),after,'double continuation cannot transfer twice');
}
// A cancelled queued callback must not clear the handle of a newer timer.
{
  const h=harness(8);h.run("startGame({bots:2,diff:'normal',stake:0});clearDurakTimer();s.game.attacker=1;s.game.defender=2;s.game.phase='attack';advance()");
  assert.equal(h.timers.size,1);const old=h.timers.values().next().value.fn;
  h.run('advance()');assert.equal(h.timers.size,1);const snapshot=JSON.stringify(h.state().game);old();
  assert.equal(JSON.stringify(h.state().game),snapshot,'cancelled action does not run');
  h.run('clearDurakTimer()');assert.equal(h.timers.size,0,'old callback cannot orphan the replacement timer');
  h.run('advance();advance();advance()');assert.equal(h.timers.size,1,'repeated advance leaves one timer');
  const stale=h.timers.values().next().value.fn;h.run("startGame({bots:1,diff:'hard',stake:0})");const next=JSON.stringify(h.state().game);stale();assert.equal(JSON.stringify(h.state().game),next,'old game cannot affect a new game');
}
// Neither a paused game, hidden document nor leaving the table permits bot actions.
{
  const h=harness(9);h.run("startGame({bots:2,diff:'normal',stake:0});clearDurakTimer();s.game.attacker=1;s.game.defender=2;s.game.phase='attack';s.game.paused=true;advance()");assert.equal(h.timers.size,0);
  h.run('s.game.paused=false');h.context.document.hidden=true;h.run('advance()');assert.equal(h.timers.size,0);
  h.context.document.hidden=false;h.run('advance()');const snapshot=JSON.stringify(h.state().game);h.run("s.view='room'");h.tick();assert.equal(JSON.stringify(h.state().game),snapshot);
}
// Legacy prepared-take saves are normalized once, then transferred exactly once.
{
  const h=harness(3);h.run("startGame({bots:2,diff:'normal',stake:100});clearDurakTimer();s.game.attacker=0;s.game.defender=1;s.game.table=[{a:s.game.players[0].hand.pop(),d:null}];s.game.players[1].hand.push(s.game.table[0].a);s.game.phase='resolve';s.game.resolve={took:true,prepared:true};delete s.game.engineVersion;delete s.game.discardCount;delete s.game.trumpCard;normalizeDurakGame(s.game)");
  assert.equal(h.state().game.phase,'roundEnd');check(h);
  const snapshot=JSON.stringify(h.state().game);h.run('normalizeDurakGame(s.game)');assert.equal(JSON.stringify(h.state().game),snapshot,'normalization is idempotent');
  h.run('continueRound()');check(h);
  h.run('s.game.over=true;delete s.game.engineVersion;delete s.game.settled;normalizeDurakGame(s.game)');const balance=h.state().balance;h.run('settle(s.game)');assert.equal(h.state().balance,balance,'historical result is never paid twice');
}
// Trump is the bottom card of the pop-based deck, not the next card drawn.
{
  const h=harness(2);h.run("startGame({bots:3,diff:'normal',stake:0})");const g=h.state().game;assert.equal(g.trumpCard.id,g.deck[0].id);assert.equal(g.trump,g.deck[0].suit);
}
console.log(JSON.stringify({passed:true,fullGames,maxActions,checks:['card conservation','unique ownership','completed multiplayer games','manual round pause','take turn order','idempotent settlement','stale timers','navigation and pause','legacy saves','trump bottom']}));
