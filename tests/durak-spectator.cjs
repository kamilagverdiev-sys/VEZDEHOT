'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const engine=import('../supabase/functions/server-durak/engine.mjs'),coreModule=import('../supabase/functions/server-durak/core.mjs');
const ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',card=(rank,suit='♠')=>({rank,suit,id:rank+suit,color:['♥','♦'].includes(suit)?'red':'black'});
const seeded=(seed=1)=>()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
async function spectator(){const e=await engine,g=e.createGame({bots:2,id:ID,stake:100},seeded(8));Object.assign(g,{deck:[],trump:'♥',trumpCard:card('A','♥'),table:[],discardCount:33,attacker:1,defender:2,phase:'attack',finished:[0],roundLimit:null,resolve:null,pendingRound:null});g.players[0].hand=[];g.players[1].hand=[card('6')];g.players[2].hand=[card('7'),card('8','♦')];e.assertIntegrity(g);return g;}
test('finished human has only completion intent; old resign also finishes by rules and keeps the paid win',async()=>{
 const e=await engine,g=await spectator(),before=structuredClone(g);assert.deepEqual(e.legalActions(g),{cards:[],actions:['continue']});
 for(const type of ['continue','resign']){const result=e.applyAction(g,{type},seeded(9));assert.equal(result.over,true);assert.equal(result.resigned,undefined);assert.equal(result.loser,2);assert.equal(result.players[2].hand[0].id,'8♦');assert.equal(result.deck.length,0);assert.equal(result.table.length,0);assert.deepEqual(result.economy,{version:1,stake:100,settled:true,payout:300,xp:80,outcome:'win'});e.assertIntegrity(result);assert.throws(()=>e.applyAction(result,{type:'continue'}));}assert.deepEqual(g,before);
});
test('bot completion preserves an actual draw instead of inventing a human win',async()=>{
 const e=await engine,g=await spectator();g.players[2].hand.pop();g.discardCount=34;const result=e.applyAction(g,{type:'continue'},seeded(9));assert(result.over);assert(result.draw);assert.equal(result.loser,null);assert.deepEqual(result.economy,{version:1,stake:100,settled:true,payout:100,xp:40,outcome:'draw'});e.assertIntegrity(result);
});
test('the human final-round request includes remaining bots and one settled result',async()=>{
 const e=await engine,g=await spectator();g.finished=[];g.table=[{a:card('9','♣'),d:card('10','♣')}];g.discardCount-=2;g.phase='roundEnd';g.attacker=0;g.defender=1;g.pendingRound={attacker:0,defender:1,took:false};g.resolve={took:false,prepared:false};e.assertIntegrity(g);
 const result=e.applyAction(g,{type:'continue'},seeded(9));assert(result.over);assert(result.finished.includes(0));assert.equal(result.economy.outcome,'win');assert.equal(result.economy.payout,300);assert.equal(result.journal.filter(row=>row.kind==='end').length,1);e.assertIntegrity(result);
});
test('resolver budget leaves a valid resumable state and never acts for a live or paused human',async()=>{
 const e=await engine,{createCore}=await coreModule,core=createCore({random:seeded(9),id:ID,nick:'Test'}),g=await spectator();const before=structuredClone(g),zero=core.durakResolveBots(g,0);assert.deepEqual(zero,{steps:0,complete:false});assert.equal(g.phase,before.phase);assert.deepEqual(g.players,before.players);
 const one=core.durakResolveBots(g,1);assert.deepEqual(one,{steps:1,complete:false});assert.equal(g.phase,'defend');e.assertIntegrity(g);const result=e.applyAction(g,{type:'continue'},seeded(9));assert(result.over);assert.equal(result.economy.payout,300);
 for(const change of [game=>{game.paused=true},game=>{game.finished=[]},game=>{game.players[0].hand=[card('A','♣')]}]){const blocked=await spectator();change(blocked);const snapshot=JSON.stringify(blocked);assert.equal(core.durakResolveBots(blocked).steps,0);assert.equal(JSON.stringify(blocked),snapshot);}
});
test('180 seeded server games complete without human spectator review requests',async()=>{
 const e=await engine;let spectatorRequests=0;
 for(let bots=1;bots<=3;bots++)for(const difficulty of ['easy','normal','hard'])for(let seed=1;seed<=20;seed++){
  const random=seeded(seed*31+bots);let g=e.createGame({bots,difficulty,id:ID,stake:100},random),steps=0;
  while(!g.over&&steps++<3000){const legal=e.legalActions(g),type=legal.cards.length?legal.actions.find(t=>['attack','defend'].includes(t)):legal.actions.find(t=>t!=='resign');assert(type);if(g.finished.includes(0))spectatorRequests++;g=e.applyAction(g,{type,...(['attack','defend'].includes(type)?{cardId:legal.cards[0]}:{})},random);e.assertIntegrity(g);}
  assert(g.over);assert(['win','draw','loss'].includes(g.economy.outcome));assert.equal(g.economy.settled,true);
 }assert.equal(spectatorRequests,0);
});
function practice(){const html=fs.readFileSync('dist/index.html','utf8'),ctx={document:{hidden:false},Date,Math,s:{nick:'Test',view:'room',balance:1000,xp:0,wins:0,games:0},ranks:['6','7','8','9','10','J','Q','K','A'],suits:[['♠','black'],['♥','red'],['♦','red'],['♣','black']],botNames:['A','B','C'],avatars:['A','B','C'],save(){},render(){},fmt:String,toast(){},setTimeout(){return 1},clearTimeout(){}};ctx.deck=()=>ctx.suits.flatMap(([suit])=>ctx.ranks.map(rank=>card(rank,suit)));ctx.shuffle=x=>x;vm.createContext(ctx);vm.runInContext(html.slice(html.indexOf('    const DURAK_ENGINE_VERSION'),html.indexOf('    function bunkerRoom'))+'\napi={newGame,startGame,advance,continueRound,settle};',ctx);return ctx;}
test('practice resumes an old spectator once through normal settlement, respecting pause and hidden state',async()=>{
 const ctx=practice(),g=await spectator();g.stake=100;delete g.economy;ctx.s.game=g;ctx.s.view='game';const before=ctx.s.balance;g.paused=true;ctx.api.advance();assert(!g.over);g.paused=false;ctx.document.hidden=true;ctx.api.advance();assert(!g.over);ctx.document.hidden=false;ctx.api.advance();assert(g.over);assert(g.settled);assert.equal(ctx.s.balance,before+300);assert.equal(ctx.s.games,1);ctx.api.advance();ctx.api.continueRound();ctx.api.settle(g);assert.equal(ctx.s.balance,before+300);assert.equal(ctx.s.games,1);
});
test('rejected practice entry preserves the old table and balance; accepted volatile entry charges once',()=>{
 for(const accepted of [false,true]){const ctx=practice(),old=ctx.api.newGame({bots:2,diff:'normal',stake:0});ctx.s.game=old;const calls=[];ctx.window={VEZDEHOT:{updateProfile:change=>{calls.push(change);return {ok:accepted,persisted:false,balance:accepted?change.balance:1000}}}};ctx.api.startGame({bots:2,diff:'hard',stake:100});assert.equal(calls.length,1);assert.equal(calls[0].balance,900);if(accepted){assert.notEqual(ctx.s.game,old);assert.equal(ctx.s.balance,900);assert.equal(ctx.s.game.reserved,100);ctx.api.advance();assert.equal(calls.length,1)}else{assert.equal(ctx.s.game,old);assert.equal(ctx.s.balance,1000);assert.equal(ctx.s.view,'room')}}
});
