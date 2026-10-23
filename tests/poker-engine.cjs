const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const src=fs.readFileSync(path.join(__dirname,'../dist/poker.html'),'utf8').split('// POKER_ENGINE_START')[1].split('// POKER_ENGINE_END')[0];
let seed=8844;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/2**32};
const ctx={PokerEquity:require('../dist/poker-equity.js'),Math:Object.assign(Object.create(Math),{random}),Date,console};vm.createContext(ctx);vm.runInContext(src+'\nthis.api={scoreFive,evaluate,pokerNewGame,pokerAction,pokerContinue,pokerFinish,splitPots,legalActions,pokerNext,contenders,botMove,makeDeck,pokerNextHand,pokerDeal,tableFinished,liveSeats,validPokerSave};',ctx);const a=ctx.api;
const cards=str=>str.split(' ').map(x=>{const suit=x.slice(-1),rank=x.slice(0,-1),v=['2','3','4','5','6','7','8','9','10','J','Q','K','A'].indexOf(rank)+2;return {rank,suit,v,id:x,red:suit==='♥'||suit==='♦'}});
let checks=0;function test(label,fn){fn();checks++;console.log('PASS '+label)}
function custom(hands,board,contributions){const g=a.pokerNewGame('Ты','normal');g.players=g.players.slice(0,hands.length);g.players.forEach((p,i)=>Object.assign(p,{hand:cards(hands[i]),totalBet:contributions[i],roundBet:contributions[i],chips:1000-contributions[i],folded:false,acted:false,actedAtBet:null}));g.community=cards(board);g.pot=contributions.reduce((n,x)=>n+x,0);g.phase='betting';g.toAct=0;return g}
function invariant(g){assert.equal(g.players.reduce((n,p)=>n+p.chips,0)+g.pot,4000);assert(g.players.every(p=>p.chips>=0&&p.roundBet>=0&&p.totalBet>=0));const ids=[...g.deck,...g.burn,...g.community,...g.players.flatMap(p=>p.hand)].map(c=>c.id);assert.equal(ids.length,52);assert.equal(new Set(ids).size,52)}
test('flush plus unrelated straight is not a straight flush',()=>{const h=a.evaluate(cards('A♠ K♠ Q♠ 9♠ 2♠ J♥ 10♦'));assert.equal(h.category,5);assert.equal(h.parts[1],14)});
test('double triples use best full house',()=>{const h=a.evaluate(cards('A♠ A♥ A♦ K♠ K♥ K♦ 2♣'));assert.equal(h.category,6);assert.equal(h.parts[1],14);assert.equal(h.parts[2],13)});
test('wheel straight flush is below six-high straight flush',()=>{const wheel=a.evaluate(cards('A♠ 2♠ 3♠ 4♠ 5♠ K♥ Q♦')),six=a.evaluate(cards('2♥ 3♥ 4♥ 5♥ 6♥ A♦ K♣'));assert.equal(wheel.category,8);assert.equal(wheel.parts[1],5);assert(wheel.value<six.value)});
test('pair third kicker and two-pair kicker break ties',()=>{assert(a.evaluate(cards('A♠ A♥ K♣ Q♦ J♠ 8♥ 2♣')).value>a.evaluate(cards('A♦ A♣ K♥ Q♠ 10♦ 9♥ 3♣')).value);assert(a.evaluate(cards('K♠ K♥ Q♠ Q♥ A♦ 8♣ 2♦')).value>a.evaluate(cards('K♦ K♣ Q♦ Q♣ J♥ 9♠ 3♥')).value)});
test('best five can be entirely on the board',()=>{const board=cards('A♠ K♠ Q♠ J♠ 10♠');assert.equal(a.evaluate(board.concat(cards('2♥ 3♥'))).value,a.evaluate(board.concat(cards('A♦ A♥'))).value)});
test('all nine hand categories are ordered correctly',()=>{const hands=['A♠ J♥ 8♣ 6♦ 2♠','A♠ A♥ 8♣ 6♦ 2♠','A♠ A♥ 8♣ 8♦ 2♠','A♠ A♥ A♣ 6♦ 2♠','A♠ 2♥ 3♣ 4♦ 5♠','A♠ J♠ 8♠ 6♠ 2♠','A♠ A♥ A♣ 6♦ 6♠','A♠ A♥ A♣ A♦ 2♠','9♠ 10♠ J♠ Q♠ K♠'];let prev=-1;hands.forEach((s,i)=>{const h=a.evaluate(cards(s));assert.equal(h.category,i);assert(h.value>prev);prev=h.value})});
test('human action advances turn and repeat click cannot act out of turn',()=>{const g=a.pokerNewGame('Ты','normal',1);assert.equal(g.toAct,0);assert(a.pokerAction(g,0,'call'));assert.notEqual(g.toAct,0);const pot=g.pot;assert.equal(a.pokerAction(g,0,'raise',500),false);assert.equal(g.pot,pot);invariant(g)});
test('short all-in calls stay eligible without another required action',()=>{const g=a.pokerNewGame('Ты','normal',1);g.players[0].chips=10;const before=g.pot;assert(a.pokerAction(g,0,'call'));assert.equal(g.players[0].chips,0);assert.equal(g.pot,before+10);assert(a.contenders(g).includes(0));assert.notEqual(g.toAct,0)});
test('main and side pots exclude folded players and conserve all contributions',()=>{const g=custom(['A♠ A♥','K♠ K♥','Q♠ Q♥','J♠ J♥'],'2♣ 3♦ 7♣ 8♦ 10♣',[100,300,700,700]);g.players[3].folded=true;const split=a.splitPots(g);assert.deepEqual(Array.from(split.prizes),[400,600,800,0]);assert.equal(split.prizes.reduce((n,x)=>n+x,0),1800)});
test('unmatched contribution returns to its owner',()=>{const g=custom(['A♠ A♥','K♠ K♥','Q♠ Q♥'],'2♣ 3♦ 7♣ 8♦ 10♣',[100,300,700]);const split=a.splitPots(g);assert.deepEqual(Array.from(split.prizes),[300,400,400]);assert(split.pots[2].refund)});
test('split odd chip goes clockwise after dealer',()=>{const g=custom(['A♥ K♥','2♥ 2♦','A♦ K♦','3♥ 3♦'],'Q♠ J♠ 10♣ 7♦ 8♣',[1,1,1,0]);g.button=1;[1,3].forEach(i=>g.players[i].folded=true);const split=a.splitPots(g);assert.deepEqual(Array.from(split.prizes),[1,0,2,0])});
test('short raise does not reopen betting; cumulative full raise does',()=>{const g=custom(['A♠ A♥','K♠ K♥','Q♠ Q♥','J♠ J♥'],'2♣ 3♦ 7♣ 8♦ 10♣',[100,100,100,100]);g.currentBet=100;g.minRaise=100;g.toAct=2;g.players.forEach((p,i)=>{p.acted=i<2;p.actedAtBet=i<2?100:null});g.players[2].chips=50;assert(a.pokerAction(g,2,'raise',150));g.toAct=0;assert.equal(a.legalActions(g,0).raise,false);g.toAct=3;g.players[3].chips=100;assert(a.pokerAction(g,3,'raise',200));g.toAct=0;assert.equal(a.legalActions(g,0).raise,true)});
test('cannot raise into an uncontested side pot',()=>{const g=custom(['A♠ A♥','K♠ K♥','Q♠ Q♥','J♠ J♥'],'2♣ 3♦ 7♣ 8♦ 10♣',[100,100,100,100]);g.currentBet=200;g.players.slice(1).forEach(p=>p.chips=0);g.toAct=0;const legal=a.legalActions(g,0);assert.equal(legal.call,true);assert.equal(legal.raise,false)});
test('all-in hand reveals each street only on continue then settles once',()=>{const g=a.pokerNewGame('Ты','normal',1);while(g.phase==='betting'){const i=g.toAct,legal=a.legalActions(g,i);assert(a.pokerAction(g,i,legal.raise?'raise':legal.call?'call':'check',legal.maximum))}assert.equal(g.phase,'review');assert.equal(g.community.length,0);for(const count of [3,4,5]){a.pokerContinue(g);assert.equal(g.community.length,count);assert.equal(g.over,false);assert.equal(g.phase,'review');invariant(g)}a.pokerContinue(g);assert(g.over);invariant(g);const stacks=g.players.map(p=>p.chips);a.pokerFinish(g);assert.deepEqual(g.players.map(p=>p.chips),stacks)});
test('folded field ends immediately without community cards',()=>{const g=a.pokerNewGame('Ты','normal',1);for(let n=0;n<3;n++){assert(a.pokerAction(g,g.toAct,'fold'))}assert(g.over);assert.equal(g.community.length,0);assert.equal(g.showdown,false);invariant(g)});
test('200 complete seeded games preserve chips/cards and always terminate',()=>{for(let trial=0;trial<200;trial++){const g=a.pokerNewGame('Ты',['easy','normal','hard'][trial%3],trial%4);g.players.forEach(p=>p.kind='bot');let steps=0;while(!g.over&&steps++<1000){invariant(g);if(g.phase==='review')a.pokerContinue(g);else assert(a.botMove(g),'bot action succeeds')}assert(g.over,'hand terminated');invariant(g);assert.equal(g.prizes.reduce((n,x)=>n+x,0),g.paidPot);assert.equal(g.payout,Math.floor(g.players[0].chips/10));assert(g.payout>=0&&g.payout<=400)}});
function dealStacks(stacks,button=0){const players=a.pokerNewGame('Ты','normal').players.map((p,i)=>({...p,chips:stacks[i]}));return a.pokerDeal(players,'normal',button,{handNumber:1,tableEntry:100,tableHistory:[]})}
function finishByCalling(g){let steps=0;while(!g.over&&steps++<100){if(g.phase==='review')assert(a.pokerContinue(g));else{const legal=a.legalActions(g,g.toAct);assert(legal.fold,'an eligible player has a turn');assert(a.pokerAction(g,g.toAct,legal.check?'check':'call'))}}assert(g.over,'calling/checking hand terminates');return g}
test('next hand keeps every stack, rotates dealer and resets only hand state',()=>{
  const g=finishByCalling(a.pokerNewGame('Ты','hard',0)),before=JSON.stringify(g),stacks=Array.from(g.players,p=>p.chips),next=a.pokerNextHand(g);
  assert(next);assert.notEqual(next.id,g.id);assert.equal(next.tableId,g.tableId);assert.equal(next.handNumber,2);assert.equal(next.button,1);assert.equal(next.difficulty,'hard');
  assert.deepEqual(Array.from(next.handStartChips),stacks);assert.deepEqual(Array.from(next.players,p=>p.chips+p.totalBet),stacks);assert.equal(next.pot,60);assert.equal(next.community.length,0);assert.equal(next.burn.length,0);assert.equal(next.over,false);assert.equal(next.settled,false);
  assert.equal(next.tableHistory.length,1);assert.equal(next.tableHistory[0].number,1);assert.equal(next.tableHistory[0].net,g.handProfit);assert.equal(next.tableHistory[0].pot,g.paidPot);assert.equal(JSON.stringify(g),before,'preparing next hand does not mutate the result');invariant(next);
});
test('a hand delta uses that hand starting stack instead of the original buy-in',()=>{
  const g=dealStacks([1500,1200,900,400],0),start=g.handStartChips[0];
  assert.equal(start,1500);finishByCalling(g);assert.equal(g.handProfit,g.players[0].chips-start);assert.equal(g.players.reduce((sum,p,i)=>sum+p.chips-g.handStartChips[i],0),0);
  const next=a.pokerNextHand(g);assert(next);assert.equal(next.handStartChips[0],g.players[0].chips);finishByCalling(next);assert.equal(next.handProfit,next.players[0].chips-next.handStartChips[0]);invariant(next);
});
test('eliminated seats receive no cards or blinds and dealer skips them',()=>{
  const g=finishByCalling(dealStacks([1800,0,1200,1000],0));assert.equal(g.players[1].hand.length,0);assert.equal(g.players[1].totalBet,0);assert(g.players[1].sittingOut);assert(!a.contenders(g).includes(1));
  const next=a.pokerNextHand(g);assert(next);assert.equal(next.button,2);assert.equal(next.smallBlind,3);assert.equal(next.bigBlind,0);assert.equal(next.toAct,2);assert.equal(next.players[1].chips,0);assert.equal(next.players[1].hand.length,0);assert.equal(next.players[1].roundBet,0);assert.deepEqual(Array.from(a.liveSeats(next.players)),[0,2,3]);invariant(next);
});
test('heads-up dealer posts small blind and acts first preflop, big blind first after flop',()=>{
  for(const button of [0,2]){const g=dealStacks([2000,0,2000,0],button),other=button===0?2:0;assert.equal(g.smallBlind,button);assert.equal(g.bigBlind,other);assert.equal(g.toAct,button);assert.equal(g.players[button].roundBet,20);assert.equal(g.players[other].roundBet,40);assert(a.pokerAction(g,button,'call'));assert.equal(g.toAct,other);assert(a.pokerAction(g,other,'check'));assert.equal(g.phase,'review');assert(a.pokerContinue(g));assert.equal(g.stage,'flop');assert.equal(g.toAct,other);invariant(g);finishByCalling(g);const next=a.pokerNextHand(g);assert(next);assert.equal(next.button,other);assert.equal(next.toAct,other)}
});
test('a heads-up short big blind never demands an unmatched call or stalls',()=>{
  for(const short of [1,10,20,30,39]){const g=dealStacks([4000-short,0,short,0],0);assert.equal(g.players[2].chips,0);assert.equal(g.currentBet,Math.max(20,short));if(short<=20){assert.equal(g.phase,'review');assert.equal(g.toAct,-1)}else{assert.equal(g.toAct,0);const legal=a.legalActions(g,0);assert.equal(legal.callAmount,short-20);assert.equal(legal.raise,false);assert(a.pokerAction(g,0,'call'));assert.equal(g.phase,'review')}finishByCalling(g);invariant(g);assert.equal(g.paidPot,Math.max(20,short)+short);assert(g.pots.filter(p=>!p.refund).every(p=>p.amount<=2*short))}
});
test('short small blind and multiple all-in blinds can run out the board',()=>{
  const g=dealStacks([10,0,3990,0],0);assert.equal(g.phase,'review');assert.equal(g.players[0].chips,0);assert.equal(g.toAct,-1);finishByCalling(g);invariant(g);assert(g.pots.some(p=>p.refund&&p.amount===30));
  const multi=dealStacks([3975,10,15,0],0);assert.equal(multi.smallBlind,1);assert.equal(multi.bigBlind,2);assert.equal(multi.toAct,0);const legal=a.legalActions(multi,0);assert.equal(legal.raise,false);assert(a.pokerAction(multi,0,'call'));finishByCalling(multi);invariant(multi);
});
test('next hand cannot start while active, after closing, or after table completion',()=>{
  const active=a.pokerNewGame('Ты','normal');assert.equal(a.pokerNextHand(active),null);assert.equal(a.pokerNextHand(null),null);
  const ended=finishByCalling(a.pokerNewGame('Ты','normal'));ended.tableClosed=true;assert.equal(a.pokerNextHand(ended),null);ended.tableClosed=false;ended.version=2;assert.equal(a.pokerNextHand(ended),null);ended.version=3;
  ended.players.forEach((p,i)=>p.chips=i===0?4000:0);assert(a.tableFinished(ended));assert.equal(a.pokerNextHand(ended),null);
  ended.players.forEach((p,i)=>p.chips=i===0?0:i===1?2000:1000);assert(a.tableFinished(ended));assert.equal(a.pokerNextHand(ended),null);
});
test('120 continuous seeded tables preserve all chips and cards across eliminations',()=>{
  let hands=0,eliminated=0,headsUp=0;
  for(let trial=0;trial<120;trial++){
    let g=a.pokerNewGame('Ты',['easy','normal','hard'][trial%3],trial%4);g.players.forEach(p=>p.kind='bot');const tableId=g.tableId;
    while(true){hands++;const start=Array.from(g.handStartChips);assert.equal(start.reduce((sum,n)=>sum+n,0),4000);assert.equal(g.tableId,tableId);if(start.filter(n=>n>0).length===2)headsUp++;
      g.players.forEach((p,i)=>{if(start[i]===0){eliminated++;assert.equal(p.hand.length,0);assert(p.sittingOut);assert(p.folded)}});
      let steps=0;while(!g.over&&steps++<150){invariant(g);if(g.phase==='review'){assert(a.pokerContinue(g));continue}const legal=a.legalActions(g,g.toAct);assert(legal.fold,'betting always has an available action');
        if(g.handNumber<3)assert(a.pokerAction(g,g.toAct,legal.check?'check':'call'));
        else if(g.handNumber>20||trial%3===0)assert(a.pokerAction(g,g.toAct,legal.raise?'raise':legal.check?'check':'call',legal.maximum));
        else assert(a.botMove(g));
      }
      assert(g.over,'each hand ends');invariant(g);assert.equal(g.handProfit,g.players[0].chips-start[0]);assert.equal(g.prizes.reduce((sum,n)=>sum+n,0),g.paidPot);assert(g.tableHistory.length<=12);
      if(a.tableFinished(g)){assert.equal(a.pokerNextHand(g),null);break}
      assert(g.handNumber<80,'table reaches a human bust or complete win');const after=Array.from(g.players,p=>p.chips),previousNumber=g.handNumber;
      g=a.pokerNextHand(g);assert(g);assert.equal(g.handNumber,previousNumber+1);assert.deepEqual(Array.from(g.handStartChips),after);assert.deepEqual(Array.from(g.players,p=>p.chips+p.totalBet),after);
    }
  }
  assert(hands>240,'exercise multiple hands per table');assert(eliminated>0,'exercise seats after busting');assert(headsUp>0,'exercise heads-up tables');console.log('Continuous table coverage: '+hands+' hands, '+eliminated+' eliminated-seat observations, '+headsUp+' heads-up hands');
});
test('save validation accepts every phase of genuine hands and rejects broken card/chip state',()=>{
  const clone=g=>JSON.parse(JSON.stringify(g));
  for(let trial=0;trial<20;trial++){
    const g=a.pokerNewGame('Игрок','normal',trial%4);let steps=0;
    while(!g.over&&steps++<100){assert.equal(a.validPokerSave(clone(g)),true,'valid live save');if(g.phase==='review')a.pokerContinue(g);else{const legal=a.legalActions(g,g.toAct);a.pokerAction(g,g.toAct,legal.check?'check':'call')}}
    assert.equal(a.validPokerSave(clone(g)),true,'valid complete save');
    const next=a.pokerNextHand(g);assert.equal(a.validPokerSave(clone(next)),true,'valid next hand');
    const duplicate=clone(g);duplicate.deck[0]=duplicate.community[0];assert.equal(a.validPokerSave(duplicate),false);
    const chips=clone(g);chips.players[0].chips+=1;assert.equal(a.validPokerSave(chips),false);
    const payout=clone(g);payout.payout+=100;assert.equal(a.validPokerSave(payout),false);
    const missing=clone(g);delete missing.players[1].hand;assert.equal(a.validPokerSave(missing),false);
    const badHistory=clone(g);badHistory.tableHistory=[{}];assert.equal(a.validPokerSave(badHistory),false);
  }
  for(const bad of [null,{},[],{version:3,players:[null,null,null,null]}])assert.equal(a.validPokerSave(bad),false);
});
test('the first postflop wager is logged as a bet rather than a raise',()=>{
  const g=a.pokerNewGame('Ты','normal',1);
  while(g.phase==='betting'){const legal=a.legalActions(g,g.toAct);assert(a.pokerAction(g,g.toAct,legal.check?'check':'call'))}
  assert(a.pokerContinue(g));const i=g.toAct;assert.equal(g.currentBet,0);assert(a.pokerAction(g,i,'raise',40));assert.match(g.lastAction,/ — ставка 40$/);
});
console.log(checks+' poker checks passed');
