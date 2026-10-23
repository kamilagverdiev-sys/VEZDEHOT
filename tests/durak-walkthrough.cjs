const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const html=fs.readFileSync('dist/index.html','utf8'),engine=html.slice(html.indexOf('    function deck(){'),html.indexOf('    const BUNKER_VERSION=2;'));
const clone=value=>JSON.parse(JSON.stringify(value));
function harness(){
  const touched=[],forbidden=name=>()=>{touched.push(name);throw Error('Forbidden tutorial effect: '+name)};
  const ctx={console,ranks:['6','7','8','9','10','J','Q','K','A'],suits:[['♠','black'],['♥','red'],['♦','red'],['♣','black']],Math:Object.assign(Object.create(Math),{random:forbidden('rng')}),Date:{now:forbidden('clock')},save:forbidden('save'),render:forbidden('render'),advance:forbidden('advance'),settle:forbidden('settle'),setTimeout:forbidden('timer'),clearTimeout:forbidden('clearTimer'),toast:forbidden('toast'),localStorage:{getItem:forbidden('storage read'),setItem:forbidden('storage write')},window:{VEZDEHOT:{recordResult:forbidden('result'),updateProfile:forbidden('profile')},VEZDEHOT_GAME_STORE:{load:forbidden('store load'),save:forbidden('store save')}}};
  Object.defineProperty(ctx,'s',{get:forbidden('live state'),set:forbidden('replace live state')});
  vm.createContext(ctx);vm.runInContext(engine+'\nthis.api={create:durakWalkthroughCreate,view:durakWalkthroughView,act:durakWalkthroughAct,adapter:durakWalkthrough,attack:durakApplyAttack,defend:durakApplyDefense,prepare:durakPrepareRound,commit:durakCommitRound,beats,canAddAttack};this.timerState=()=>[durakTimer,durakTimerTicket];',ctx);
  return {ctx,a:ctx.api,touched};
}
function invariant(state){
  const g=state.game,live=[...g.deck,...g.players.flatMap(p=>p.hand),...g.table.flatMap(pair=>pair.d?[pair.a,pair.d]:[pair.a])],all=[...live,...state.discard];
  assert.equal(all.length,36);assert.equal(new Set(all.map(c=>c.id)).size,36);assert.equal(g.discardCount,state.discard.length);assert.equal(live.length+g.discardCount,36);assert.equal(g.deck.length,0);assert.equal(g.stake,0);assert.equal(g.settled,false);assert(g.players.every(p=>p.hand.length<=8));assert.equal(g.table.filter(pair=>!pair.d).length,g.phase==='defend'||g.pendingRound?.took?1:0);
}
function positionKey(state){const g=state.game;return JSON.stringify({hands:g.players.map(p=>p.hand.map(c=>c.id)),table:g.table,attacker:g.attacker,defender:g.defender,phase:g.phase,discard:g.discardCount,over:g.over})}
let count=0;function test(name,fn){fn();count++;console.log('PASS '+name)}
test('create is repeatable JSON with four cards per player and 28 actual discarded cards',()=>{
  const h=harness(),first=h.a.create(),second=h.a.create();assert.deepEqual(clone(first),clone(second));assert.notEqual(first.game,second.game);assert.deepEqual(Array.from(first.game.players,p=>p.hand.length),[4,4]);assert.equal(first.discard.length,28);invariant(first);assert.equal(first.game.trump,'♥');assert.equal(first.game.trumpCard,null);assert.equal(first.game.journal.length,0);assert(h.a.view(first).feedback.text.includes('28 карт'));assert.deepEqual(h.touched,[]);
});
test('every offered branch completes a real endgame without cycles and preserves all 36 unique cards',()=>{
  const h=harness(),outcomes=new Set();let paths=0,maxActions=0,visits=0,takes=0,throws=0,defenses=0;
  function visit(state,path,ancestors){
    visits++;invariant(state);const before=JSON.stringify(state),view=h.a.view(state);assert.equal(JSON.stringify(state),before,'view is read only');assert(view.step>=1&&view.step<=view.total&&view.total===5);assert(view.choices.length<=8);assert(view.groups.every(group=>group.cards.length<=7));
    if(view.done){assert(state.game.over);assert.equal(state.game.phase,'over');assert.equal(view.step,5);assert.equal(view.choices.length,0);paths++;maxActions=Math.max(maxActions,path.length);outcomes.add(state.game.draw?'draw':state.game.loser===0?'loss':'win');return}
    assert(view.choices.length>0);const key=positionKey(state);assert(!ancestors.has(key),'no repeated position in a branch');assert(path.length<35,'short scenario');const nextAncestors=new Set(ancestors);nextAncestors.add(key);
    for(const choice of view.choices){const next=h.a.act(state,choice.id);assert.equal(JSON.stringify(state),before,'act leaves input untouched');assert.notEqual(next,state);if(choice.id==='take')takes++;if(choice.id.startsWith('attack:')&&state.game.table.length)throws++;if(choice.id.startsWith('defend:'))defenses++;visit(next,[...path,choice.id],nextAncestors)}
  }
  visit(h.a.create(),[],new Set());assert.equal(paths,23);assert.equal(maxActions,26);assert(visits>150);assert(takes&&throws&&defenses);assert.deepEqual([...outcomes].sort(),['draw','loss','win']);assert.deepEqual(h.touched,[]);assert.deepEqual(Array.from(h.ctx.timerState()),[null,0]);
});
test('attack and throw-in are legal core moves and cards wait for explicit round continuation',()=>{
  const h=harness();let state=h.a.create();state=h.a.act(state,'attack:6♠');assert.equal(state.game.phase,'defend');assert.equal(state.game.table[0].a.id,'6♠');assert.deepEqual(clone(h.a.view(state).groups.find(g=>g.label.startsWith('Защита')).cards),[{placeholder:true,label:'Ожидает защиты'}]);state=h.a.act(state,'bot');assert.equal(state.game.table[0].d.id,'7♠');assert.equal(state.game.phase,'resolve');assert(h.a.view(state).choices.some(c=>c.id==='attack:6♦'));state=h.a.act(state,'attack:6♦');assert.equal(state.game.table.length,2);assert.deepEqual(clone(h.a.view(state).groups.find(g=>g.label.startsWith('Защита')).cards),[{rank:'7',suit:'♠'},{placeholder:true,label:'Ожидает защиты'}]);state=h.a.act(state,'bot');assert.equal(state.game.table[1].d.id,'8♦');state=h.a.act(state,'finish');assert.equal(state.game.phase,'roundEnd');assert.equal(state.game.discardCount,28);assert.equal(state.game.table.length,2);state=h.a.act(state,'next');assert.equal(state.game.discardCount,32);assert.equal(state.game.table.length,0);assert.equal(state.game.attacker,1);assert.equal(state.game.defender,0);invariant(state);
});
test('taking transfers exactly the visible table after continue and skips the defender',()=>{
  const h=harness();let state=h.a.create();for(const id of ['attack:6♠','bot','attack:6♦','bot','finish','next','bot'])state=h.a.act(state,id);assert.equal(state.game.phase,'defend');assert.equal(state.game.table[0].a.id,'8♣');const hand=state.game.players[0].hand.length,discard=state.game.discardCount;state=h.a.act(state,'take');assert.equal(state.game.phase,'roundEnd');assert.equal(state.game.players[0].hand.length,hand);assert.equal(state.game.pendingRound.took,true);state=h.a.act(state,'next');assert.equal(state.game.players[0].hand.length,hand+1);assert.equal(state.game.discardCount,discard);assert.equal(state.game.attacker,1);assert(state.game.journal.some(e=>e.kind==='take'&&e.actor===0&&e.count===1));invariant(state);
});
test('round feedback uses second person for the human and third person for the opponent',()=>{
  const h=harness();let state=h.a.create();for(const id of ['attack:6♠','bot','attack:6♦','bot','finish','next'])state=h.a.act(state,id);
  assert.equal(state.game.message,'Учебный соперник отбился и начинает атаку');state=h.a.act(state,'bot');
  const taken=h.a.act(state,'take');assert(taken.game.message.startsWith('Ты забираешь карты.'));const continued=h.a.act(taken,'next');assert(continued.feedback.text.startsWith('Ты забираешь со стола 1 карту.'));assert.equal(continued.game.message,'Ты пропускаешь ход. Атакует Учебный соперник');
  state=h.a.act(state,'defend:9♣');state=h.a.act(state,'bot');state=h.a.act(state,'next');assert.equal(state.game.message,'Ты отбился и начинаешь атаку');assert(state.feedback.text.includes('Ты отбился и начинаешь атаку.'));assert(!state.feedback.text.includes('Ты отбился и начинает'));
});
test('view reads only human cards, the public table and the opponents card count',()=>{
  const h=harness(),state=h.a.create(),before=h.a.view(state);state.game.players[1].hand=new Proxy(Array(4),{get(target,key){if(key==='length')return 4;throw Error('Hidden hand read: '+String(key))}});assert.deepEqual(clone(h.a.view(state)),clone(before));assert(before.groups.find(g=>g.label.startsWith('Соперник')).cards.every(c=>c.hidden===true));
  const lost=h.a.create();lost.game.over=true;lost.game.phase='over';lost.game.loser=0;lost.game.players[1].hand=new Proxy(Array(3),{get(target,key){if(key==='length')return 3;throw Error('Hidden result hand read')}});assert.doesNotThrow(()=>h.a.view(lost));assert(h.a.view(lost).groups.find(g=>g.label.startsWith('Соперник')).cards.every(c=>c.hidden===true));
});
test('unavailable, malformed and repeated terminal actions cannot move or reward the example',()=>{
  const h=harness(),state=h.a.create();for(const id of ['attack:Q♦','defend:7♥','take','finish','next','bot','unknown'])assert.equal(h.a.act(state,id),state);let done=state;while(!done.game.over)done=h.a.act(done,h.a.view(done).choices.at(-1).id);const snapshot=JSON.stringify(done);assert.equal(h.a.act(done,'next'),done);assert.equal(JSON.stringify(done),snapshot);assert.deepEqual(h.touched,[]);
});
test('core actions reject wrong players and illegal cards without changing the supplied state',()=>{
  const h=harness(),g=h.a.create().game,before=JSON.stringify(g);assert.equal(h.a.attack(g,1,0),false);assert.equal(h.a.attack(g,0,99),false);assert.equal(h.a.defend(g,0,0),false);assert.equal(h.a.prepare(g,false),false);assert.equal(h.a.commit(g),false);assert.equal(JSON.stringify(g),before);assert(h.a.attack(g,0,0));const attackState=JSON.stringify(g);assert.equal(h.a.defend(g,0,0),false);assert.equal(h.a.defend(g,1,1),false);assert.equal(h.a.prepare(g,false),false);assert.equal(JSON.stringify(g),attackState);assert(h.a.defend(g,1,0));assert.deepEqual(h.touched,[]);
});
test('serializing a mid-example state preserves every branch and restarts never reuse mutable cards',()=>{
  const h=harness();let state=h.a.act(h.a.create(),'attack:6♠');state=h.a.act(state,'bot');const restored=clone(state);assert.deepEqual(clone(h.a.view(restored)),clone(h.a.view(state)));for(const choice of h.a.view(state).choices)assert.deepEqual(clone(h.a.act(restored,choice.id)),clone(h.a.act(state,choice.id)));state.game.players[0].hand[0].rank='X';assert(h.a.create().game.players[0].hand.every(c=>c.rank!=='X'));assert.deepEqual(h.touched,[]);
});
test('Durak room training button opens the isolated walkthrough tab without starting a paid game',()=>{
  const binding=html.slice(html.indexOf('    function bindRoom(){'),html.indexOf('    function confirmRestart')),button={},start={},calls=[];
  const ctx={s:{room:{mode:'durak'}},$:selector=>selector==='[data-durak-training]'?button:selector==='[data-start]'?start:null,$$:()=>[],openMainGuide:(...args)=>calls.push(args)};vm.createContext(ctx);vm.runInContext(binding+';bindRoom()',ctx);button.onclick();assert.deepEqual(calls,[['durak','walkthrough']]);assert(html.includes('data-durak-training>Учебная партия · без V'));assert(html.includes('],walkthrough:durakWalkthrough()'));
});
console.log(count+' Durak walkthrough checks passed');
