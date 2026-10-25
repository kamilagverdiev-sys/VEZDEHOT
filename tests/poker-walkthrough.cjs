'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const html=fs.readFileSync(path.join(__dirname,'../dist/poker.html'),'utf8'),inline=html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const engine=inline.split('// POKER_ENGINE_START')[1].split('// POKER_ENGINE_END')[0],walk=inline.split('// POKER_WALKTHROUGH_START')[1].split('// POKER_WALKTHROUGH_END')[0];
const plain=value=>JSON.parse(JSON.stringify(value));
const forbidden=()=>{throw new Error('Walkthrough touched external randomness, time or storage')};
const isolated=vm.createContext({Math:Object.assign(Object.create(Math),{random:forbidden}),Date:{now:forbidden},localStorage:{getItem:forbidden,setItem:forbidden,removeItem:forbidden},console});
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../dist/session-validation.js'),'utf8'),isolated);
vm.runInContext(engine+'\n'+walk+'\nthis.adapter=pokerWalkthrough();this.engine={legalActions,evaluate,splitPots};',isolated);
const adapter=isolated.adapter;
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value)}return value};
function invariant(state){
  const g=state.game,cards=[...g.deck,...g.burn,...g.community,...g.players.flatMap(p=>p.hand)];
  assert.equal(cards.length,52);assert.equal(new Set(cards.map(card=>card.id)).size,52);assert.equal(g.players.reduce((sum,p)=>sum+p.chips,0)+g.pot,2000);
  assert.ok(g.players.every(p=>p.chips>=0&&p.roundBet>=0&&p.totalBet>=0));assert.equal(g.paused,false);
  if(g.over){assert.equal(g.prizes.reduce((sum,n)=>sum+n,0),g.paidPot);assert.equal(g.pots.reduce((sum,p)=>sum+p.amount,0),g.paidPot);assert.equal(g.pot,0)}
  else assert.equal(g.players.reduce((sum,p)=>sum+p.totalBet,0),g.pot);
  const view=adapter.view(state),their=view.groups[2].cards;
  assert.equal(view.done,g.over);assert.equal(view.total,5);assert.ok(view.step>=1&&view.step<=5);
  assert.equal(view.groups[1].cards.filter(card=>!card.hidden).length,g.community.length);
  if(g.over&&g.showdown)assert.deepEqual(plain(their.map(card=>card.rank+card.suit)),['K♥','K♦']);
  else assert.ok(their.every(card=>card.hidden&&!card.rank&&!card.suit),'opponent cards stay hidden until an actual showdown');
  if(g.over)assert.equal(view.choices.length,0);else assert.ok(view.choices.length>0,'every unfinished step has a usable action');
  return view;
}
function apply(state,id){const before=JSON.stringify(state),next=adapter.act(state,id);assert.equal(JSON.stringify(state),before,'act must not mutate its input');invariant(next);return next}
function callingLine(run=adapter){let state=run.create(),steps=0;while(!run.view(state).done&&steps++<20){const choices=run.view(state).choices;state=run.act(state,choices.some(choice=>choice.id==='continue')?'continue':choices.some(choice=>choice.id==='check')?'check':'call')}assert.equal(run.view(state).done,true);return state}
let checks=0;async function test(name,fn){await fn();checks++;console.log('PASS '+name)}
async function liveHarness(){
  const store=new Map(),timers=new Map(),listeners=new Map();let seed=9173,randomCalls=0,writes=0,records=0,guide=null,blockRandom=false,profile={nick:'Живой игрок',balance:10000,games:0,wins:0,xp:0,resultIds:[]};
  const rules={open:false,addEventListener(){},showModal(){this.open=true},close(){this.open=false}},app={style:{},inert:false},closeRules={};
  const doc={hidden:false,documentElement:{dataset:{},classList:{contains:()=>false}},body:{classList:{contains:()=>false}},querySelector:selector=>({'#rules':rules,'#app':app,'#close-rules':closeRules}[selector]||null),querySelectorAll:()=>[],addEventListener(type,fn){const list=listeners.get(type)||[];list.push(fn);listeners.set(type,list)}};
  const context={console,Date,Promise,AbortController,Math:Object.assign(Object.create(Math),{random(){if(blockRandom)throw new Error('Lesson consumed live RNG');randomCalls++;seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32}}),document:doc,
    localStorage:{getItem:key=>store.get(key)||null,setItem(key,value){writes++;store.set(key,String(value))},removeItem(key){writes++;store.delete(key)}},
    window:{VEZDEHOT_TAB_SESSION:{canWrite:()=>true},VEZDEHOT_GUIDE:{open:options=>guide=options},VEZDEHOT:{ready:Promise.resolve(),scopeKey:()=>'guest',getProfile:()=>plain(profile),updateProfile(patch){profile={...profile,...plain(patch)}},recordResult(){records++;throw new Error('Lesson attempted to record a real result')}},addEventListener(){},matchMedia:()=>({matches:true})},
    setTimeout(fn){const id=timers.size+1;timers.set(id,fn);return id},clearTimeout:id=>timers.delete(id)};
  vm.createContext(context);vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../dist/session-validation.js'),'utf8'),context);const expose="\nrender=function(){};window.__lessonTest={startHand,openPokerGuide,pokerWalkthrough,get game(){return g;}};boot();\n";
  vm.runInContext(inline.replace('\nboot();\n',expose),context);await Promise.resolve();await Promise.resolve();
  return {api:context.window.__lessonTest,store,timers,guide:()=>guide,profile:()=>plain(profile),writes:()=>writes,records:()=>records,randomCalls:()=>randomCalls,blockRandom:()=>{blockRandom=true}};
}
(async()=>{
  await test('create is deterministic, isolated and labels the prepared heads-up scenario before play',()=>{
    const first=adapter.create(),second=adapter.create();assert.deepEqual(plain(first),plain(second));assert.notEqual(first.game,second.game);assert.notEqual(first.game.players[0].hand,second.game.players[0].hand);const view=invariant(first);
    assert.match(view.text,/карты и ответы соперника заданы заранее/);assert.match(view.text,/один на один/);assert.match(view.text,/дилер.*малый блайнд.*первым/);assert.equal(first.game.toAct,0);assert.equal(first.game.pot,60);assert.equal(first.game.players[0].chips,980);
    assert.deepEqual(plain(view.choices.map(choice=>choice.id)),['fold','call','raise-min','all-in']);assert.match(view.choices.find(choice=>choice.id==='call').label,/20/);assert.match(view.feedback.text,/не связаны с профилем/);
  });
  await test('a check/call line visits all five stages and explains the real engine flush result',()=>{
    let state=adapter.create();state=apply(state,'call');assert.equal(state.game.pot,80);assert.equal(state.game.phase,'review');
    state=apply(state,'continue');assert.equal(state.game.stage,'flop');assert.deepEqual(plain(state.game.community.map(card=>card.id)),['Q♦','7♠','2♣']);assert.equal(state.game.currentBet,60);assert.equal(isolated.engine.legalActions(state.game,0).callAmount,60);
    state=apply(state,'call');state=apply(state,'continue');assert.equal(state.game.stage,'turn');assert.equal(state.game.community[3].id,'J♠');assert.ok(adapter.view(state).choices.some(choice=>choice.id==='check'));
    state=apply(state,'check');state=apply(state,'continue');assert.equal(state.game.stage,'river');assert.equal(state.game.community[4].id,'9♠');assert.equal(isolated.engine.legalActions(state.game,0).callAmount,120);
    state=apply(state,'call');assert.equal(state.game.over,false);state=apply(state,'continue');const view=adapter.view(state);assert.equal(view.step,5);assert.equal(view.done,true);assert.equal(state.game.showdown,true);
    assert.equal(state.game.paidPot,440);assert.deepEqual(plain(state.game.players.map(p=>p.chips)),[1220,780]);assert.equal(state.game.prizes[0],440);assert.match(view.recap[0].text,/Флеш/);assert.match(view.recap[0].text,/Пара/);assert.match(view.recap[0].text,/более старшая комбинация/);
    assert.deepEqual(plain(isolated.engine.splitPots(state.game).prizes),plain(state.game.prizes));
  });
  await test('all legal branches conserve all cards and chips, remain serializable and terminate',()=>{
    let visited=0,finished=0;const actions=new Set(),stages=new Set();const visit=(state,depth=0)=>{
      assert.ok(depth<15,'no tutorial loop');visited++;const view=invariant(state);stages.add(state.game.stage);assert.deepEqual(plain(state),plain(JSON.parse(JSON.stringify(state))));
      if(view.done){finished++;return}
      for(const choice of view.choices){assert.notEqual(choice.disabled,true);actions.add(choice.id);visit(apply(freeze(state),choice.id),depth+1)}
    };visit(adapter.create());assert.ok(visited>100);assert.ok(finished>30);assert.deepEqual([...actions].sort(),['all-in','call','check','continue','fold','raise-min']);assert.equal(stages.size,4);console.log('Walkthrough branch coverage: '+visited+' states / '+finished+' completed paths');
  });
  await test('fold is allowed on every betting street and never reveals the opponent cards',()=>{
    let state=adapter.create();for(const stage of ['preflop','flop','turn','river']){
      assert.equal(state.game.stage,stage);const folded=apply(state,'fold'),view=adapter.view(folded);assert.equal(view.done,true);assert.equal(folded.game.showdown,false);assert.match(view.text,/вскрытия не было/);assert.match(view.recap[0].text,/не оценка качества/);assert.ok(view.groups[2].cards.every(card=>card.hidden));
      if(stage==='preflop')assert.match(view.recap[1].text,/20 возвращено владельцу непокрытой ставки/);
      if(stage==='river')break;state=apply(state,adapter.view(state).choices.some(choice=>choice.id==='check')?'check':'call');state=apply(state,'continue');
    }
  });
  await test('minimum raises credit chips already committed and all-in still opens each board street explicitly',()=>{
    const raised=apply(adapter.create(),'raise-min');assert.equal(raised.game.currentBet,80);assert.equal(raised.game.players[0].totalBet,80);assert.equal(raised.game.players[0].chips,920);assert.equal(raised.game.pot,160);assert.match(raised.feedback.text,/добавив 60/);
    let state=apply(adapter.create(),'all-in');assert.equal(state.game.pot,2000);assert.equal(state.game.over,false);assert.deepEqual(plain(state.game.players.map(p=>p.chips)),[0,0]);
    for(const count of [3,4,5]){assert.deepEqual(plain(adapter.view(state).choices.map(choice=>choice.id)),['continue']);state=apply(state,'continue');assert.equal(state.game.community.length,count);assert.equal(state.game.over,false)}
    state=apply(state,'continue');assert.equal(state.game.players[0].chips,2000);assert.equal(state.game.over,true);
  });
  await test('invalid or stale actions cannot jump streets or change a completed example',()=>{
    const start=adapter.create();assert.equal(adapter.act(start,'continue'),start);assert.equal(adapter.act(start,'check'),start);assert.equal(adapter.act(start,'unknown'),start);
    const ended=callingLine();assert.equal(adapter.act(ended,'call'),ended);assert.equal(adapter.act(ended,'continue'),ended);assert.deepEqual(plain(adapter.create()),plain(start));
  });
  await test('opening and replaying the lesson from the lobby never charges or writes a result',async()=>{
    const h=await liveHarness();h.api.openPokerGuide({currentTarget:{}},'walkthrough');assert.equal(h.guide().initialTab,'walkthrough');assert.equal(h.guide().walkthrough.label,'Раздача');const before={profile:h.profile(),writes:h.writes(),random:h.randomCalls(),store:[...h.store]};h.blockRandom();
    for(let i=0;i<3;i++)callingLine(h.guide().walkthrough);
    assert.equal(h.api.game,null);assert.deepEqual(h.profile(),before.profile);assert.equal(h.profile().balance,10000);assert.equal(h.writes(),before.writes);assert.equal(h.randomCalls(),before.random);assert.deepEqual([...h.store],before.store);assert.equal(h.records(),0);
  });
  await test('lesson actions leave the paused real table, wallet, saves and random stream unchanged',async()=>{
    const h=await liveHarness();h.api.startHand();assert.equal(h.profile().balance,9900);h.api.openPokerGuide({currentTarget:{}},'walkthrough');assert.equal(h.api.game.paused,true);assert.equal(h.timers.size,0);
    const before={game:plain(h.api.game),profile:h.profile(),writes:h.writes(),store:[...h.store],random:h.randomCalls()};h.blockRandom();const run=h.guide().walkthrough;
    callingLine(run);run.act(run.create(),'fold');let state=run.act(run.create(),'all-in');while(!run.view(state).done)state=run.act(state,'continue');
    assert.deepEqual(plain(h.api.game),before.game);assert.deepEqual(h.profile(),before.profile);assert.equal(h.writes(),before.writes);assert.deepEqual([...h.store],before.store);assert.equal(h.randomCalls(),before.random);assert.equal(h.records(),0);assert.equal(h.timers.size,0);
  });
  new Function(inline);console.log(checks+' poker walkthrough checks passed');
})().catch(error=>{console.error(error.stack);process.exitCode=1});
