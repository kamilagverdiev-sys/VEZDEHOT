'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),{performance}=require('node:perf_hooks');
const source=fs.readFileSync(path.join(__dirname,'../dist/poker.html'),'utf8').split('// POKER_ENGINE_START')[1].split('// POKER_ENGINE_END')[0];
const PokerEquity=require('../dist/poker-equity.js');let seed=43193,sequence=null,index=0;
const random=()=>sequence?sequence[index++%sequence.length]:(seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32;
const context=vm.createContext({Math:Object.assign(Object.create(Math),{random}),Date,console,PokerEquity});
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../dist/session-validation.js'),'utf8'),context);
vm.runInContext(source+'\nthis.api={pokerBotStyle,pokerBotEstimate,pokerBotPosition,pokerBotDecision,botMove,pokerNewGame,pokerNextHand,pokerContinue,pokerAction,legalActions,evaluate,makeDeck,validPokerSave};',context);const a=context.api;
const plain=value=>JSON.parse(JSON.stringify(value));
const cards=text=>text.split(' ').map(id=>({id,rank:id.slice(0,-1),suit:id.slice(-1),v:['2','3','4','5','6','7','8','9','10','J','Q','K','A'].indexOf(id.slice(0,-1))+2,red:['♥','♦'].includes(id.slice(-1))}));
const decide=(g,i=1,style=a.pokerBotStyle(i),draws=[.5,.7])=>{sequence=draws;index=0;try{return plain(a.pokerBotDecision(g,i,style))}finally{sequence=null}};
function setup(hand='A♠ A♥',board=''){
  const g=a.pokerNewGame('Ты','normal',0);g.toAct=1;g.community=board?cards(board):[];g.stage=board?'river':'preflop';g.currentBet=40;g.minRaise=40;g.pot=160;
  g.players.forEach((p,i)=>Object.assign(p,{roundBet:40,totalBet:40,chips:960,folded:false,acted:false,actedAtBet:null}));g.players[1].hand=cards(hand);return g;
}
let checks=0;function test(name,fn){fn();checks++;console.log('PASS '+name)}

test('seat-based styles survive serialization and every new hand without changing save schema',()=>{
  const g=a.pokerNewGame('Ты','normal');const before=[1,2,3].map(i=>a.pokerBotStyle(i).id);assert.equal(new Set(before).size,3);
  const restored=plain(g);assert.equal(a.validPokerSave(restored),true);assert.deepEqual([1,2,3].map(i=>a.pokerBotStyle(i).id),before);
  let steps=0;while(!restored.over&&steps++<100){if(restored.phase==='review')a.pokerContinue(restored);else{const legal=a.legalActions(restored,restored.toAct);a.pokerAction(restored,restored.toAct,legal.check?'check':'call')}}
  const next=a.pokerNextHand(restored);assert.ok(next);assert.equal(a.validPokerSave(plain(next)),true);assert.deepEqual([1,2,3].map(i=>a.pokerBotStyle(i).id),before);
});

test('a shared royal flush is a split, while a private royal flush has a real advantage',()=>{
  const shared=setup('2♥ 3♦','A♠ K♠ Q♠ J♠ 10♠'),privateRoyal=setup('A♠ K♠','Q♠ J♠ 10♠ 2♦ 3♥');
  const split=a.pokerBotEstimate(shared,1),nuts=a.pokerBotEstimate(privateRoyal,1);
  assert.equal(split.win,0);assert.equal(split.tie,100);assert.equal(split.equity,25);assert.equal(nuts.win,100);assert.equal(nuts.equity,100);
  for(const difficulty of ['easy','normal','hard'])for(const style of [1,2,3].map(a.pokerBotStyle)){shared.difficulty=difficulty;assert.equal(decide(shared,1,style,[.99,0]).action,'check','a guaranteed common split never becomes a value raise or bluff')}
});

test('a full house made only by the board is not valued like a private monster',()=>{
  const g=setup('3♣ 4♣','K♠ K♥ K♦ 2♠ 2♥'),value=a.pokerBotEstimate(g,1);
  assert.equal(a.evaluate(g.community.concat(g.players[1].hand)).category,6);assert.ok(value.equity<35,JSON.stringify(value));assert.ok(value.win<25,JSON.stringify(value));
  assert.equal(decide(g,1,a.pokerBotStyle(1)).action,'check');
});

test('the three styles make different decisions or sizes on the exact same visible situation',()=>{
  const g=setup(),before=JSON.stringify(g),plans=[1,2,3].map(i=>decide(g,1,a.pokerBotStyle(i)));
  assert.equal(new Set(plans.map(JSON.stringify)).size,3,JSON.stringify(plans));assert.equal(plans[0].action,'check');assert.equal(plans[1].action,'raise');assert.equal(plans[2].action,'raise');assert.ok(plans[1].amount>plans[2].amount);
  assert.equal(JSON.stringify(g),before,'analysis is pure and does not mutate cards, stacks, turns or history');
});

test('hidden cards, live deck, burn cards and deal identifiers never enter the estimator or decision seed',()=>{
  const g=setup('A♠ Q♥','A♦ 8♣ 3♠ 9♥ 2♦');g.currentBet=120;g.pot=400;g.players[2].roundBet=120;g.players[2].totalBet=120;
  const before=decide(g),altered=plain(g);altered.players.forEach((p,i)=>{if(i!==1)p.hand=cards(i===0?'2♣ 2♥':i===2?'K♣ K♥':'J♣ J♥')});altered.deck.reverse();altered.burn=cards('10♣ 10♥');altered.id='another-random-deal';altered.tableId='another-table';
  assert.deepEqual(decide(altered),before);
  for(const p of altered.players.filter((_,i)=>i!==1))Object.defineProperty(p,'hand',{get(){throw new Error('Opponent hand read')}});
  for(const key of ['deck','burn','id','tableId'])Object.defineProperty(altered,key,{get(){throw new Error('Hidden or opaque field read: '+key)}});
  assert.deepEqual(decide(altered),before);assert.deepEqual(plain(a.pokerBotEstimate(altered,1)),plain(a.pokerBotEstimate(g,1)));
});

test('botMove itself makes the same legal action with an identical random sequence after hidden cards change',()=>{
  const left=setup('A♠ Q♥','A♦ 8♣ 3♠ 9♥ 2♦'),right=plain(left);right.players.filter((_,i)=>i!==1).forEach(p=>p.hand=cards('K♣ K♥'));right.deck.reverse();
  for(const g of [left,right]){sequence=[.45,.6];index=0;assert.equal(a.botMove(g),true);sequence=null}
  assert.equal(left.lastAction,right.lastAction);assert.equal(left.currentBet,right.currentBet);assert.equal(left.toAct,right.toAct);assert.deepEqual(plain(left.players.map(p=>[p.chips,p.roundBet,p.folded])),plain(right.players.map(p=>[p.chips,p.roundBet,p.folded])));
});

test('call price and public side-pot eligibility matter without treating the whole pot as available',()=>{
  const cheap=setup('A♠ Q♥','A♦ 8♣ 3♠ 9♥ 2♦');cheap.currentBet=50;cheap.players[2].roundBet=50;cheap.players[2].totalBet=50;cheap.pot=170;
  assert.notEqual(decide(cheap,1,a.pokerBotStyle(1)).action,'fold');
  const expensive=setup('3♣ 4♣','K♠ K♥ K♦ 2♠ 2♥');expensive.currentBet=900;expensive.players[2].roundBet=900;expensive.players[2].totalBet=900;expensive.pot=1020;
  assert.equal(decide(expensive,1,a.pokerBotStyle(1)).action,'fold');
  const short=plain(expensive);short.players[1].chips=80;short.players[1].totalBet=20;short.players[1].roundBet=20;short.players[0].totalBet=900;short.players[3].totalBet=900;short.pot=2720;
  assert.equal(decide(short,1,a.pokerBotStyle(1)).action,'fold','inaccessible side pots must not make a losing short call look free');
});

test('raise sizes respect matching public stacks and incomplete all-in rules',()=>{
  const g=setup('A♠ K♠','Q♠ J♠ 10♠ 2♦ 3♥');g.players.filter((_,i)=>i!==1).forEach(p=>p.chips=70);
  const plan=decide(g,1,a.pokerBotStyle(2),[.5,0]);assert.equal(plan.action,'raise');assert.ok(plan.amount<=110);assert.ok(plan.amount>=a.legalActions(g,1).minimum);assert.equal(a.pokerAction(g,1,plan.action,plan.amount),true);
  const short=setup('A♠ K♠','Q♠ J♠ 10♠ 2♦ 3♥');short.players[1].chips=25;const allin=decide(short,1,a.pokerBotStyle(2),[.5,0]);assert.equal(allin.action,'raise');assert.equal(allin.amount,65);assert.equal(a.pokerAction(short,1,allin.action,allin.amount),true);
});

test('position follows the public action order, including heads-up and old saves without blind markers',()=>{
  const g=setup();g.players[0].folded=true;g.players[2].folded=true;g.button=1;g.bigBlind=3;
  assert.equal(a.pokerBotPosition(g,1),0);assert.equal(a.pokerBotPosition(g,3),1);g.stage='flop';assert.equal(a.pokerBotPosition(g,3),0);assert.equal(a.pokerBotPosition(g,1),1);
  delete g.bigBlind;g.stage='preflop';assert.ok(Number.isFinite(a.pokerBotPosition(g,1)));
});

test('difficulty changes bounded sampling and missing helper falls back without touching hidden data',()=>{
  const g=setup();const counts=[];for(const difficulty of ['easy','normal','hard']){g.difficulty=difficulty;counts.push(a.pokerBotEstimate(g,1).samples)}assert.deepEqual(counts,[48,96,160]);
  const previous=context.PokerEquity;delete context.PokerEquity;try{Object.defineProperty(g,'deck',{get(){throw new Error('Deck read')}});assert.equal(decide(g).action,'check')}finally{context.PokerEquity=previous}
});

const benchmark=setup('A♠ Q♥','A♦ 8♣ 3♠ 9♥ 2♦');benchmark.difficulty='hard';const times=[];
for(let i=0;i<120;i++){const start=performance.now();decide(benchmark);times.push(performance.now()-start)}times.sort((a,b)=>a-b);
console.log('Hard bot decision benchmark: median '+times[60].toFixed(2)+' ms, p95 '+times[114].toFixed(2)+' ms, max '+times.at(-1).toFixed(2)+' ms (Node runtime, not a mobile guarantee).');
console.log(checks+' poker bot checks passed');
