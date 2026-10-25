const test=require('node:test');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const path=require('node:path');
const ready=Promise.all([import('../supabase/functions/server-poker/engine.mjs'),import('../supabase/functions/server-poker/core.mjs')]);
const tableId='00000000-0000-4000-8000-000000000001';
const rng=(seed=12345678)=>()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296};
const ids=()=>{let n=10;return()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`};
const create=(engine,seed=1,difficulty='normal')=>engine.createGame({id:tableId,nick:'Игрок',difficulty},rng(seed),ids());
const finishHand=(engine,state,random=rng(300),uuid=ids())=>{
  let count=0;
  while(!state.game.over&&!state.over&&count++<250){
    const legal=engine.legalActions(state);
    const type=legal.actions.includes('continue')?'continue':legal.actions.includes('check')?'check':'call';
    state=engine.applyAction(state,{type},random,uuid);
  }
  assert(state.game.over,'a hand terminates with legal calling/checking');return state;
};
const checkPrivacy=(engine,state)=>{
  const view=engine.projectGame(state),raw=JSON.stringify(view);
  for(const forbidden of ['deck','burn','game','handStartChips','payout','profit','settled','actedAtBet'])assert(!Object.hasOwn(view,forbidden),forbidden+' not public');
  for(let i=1;i<4;i++){
    const p=state.game.players[i],reveal=state.game.over&&state.game.showdown&&!p.folded&&!p.sittingOut;
    assert.equal(Object.hasOwn(view.players[i],'hand'),!!reveal);
    assert.equal(Object.hasOwn(view.players[i],'combination'),!!reveal);
    if(!reveal)for(const card of p.hand)assert(!raw.includes(JSON.stringify(card.id)),'hidden opponent card not serialized');
  }
  for(const card of [...state.game.deck,...state.game.burn])assert(!raw.includes(JSON.stringify(card.id)),'live deck and burns never serialized');
  assert.deepEqual(view.players[0].hand,state.game.players[0].hand);
  return view;
};

test('server poker core is generated exactly from canonical rules and estimator',()=>{
  execFileSync(process.execPath,[path.join(__dirname,'../scripts/sync-server-poker-core.cjs'),'--check']);
});

test('fresh table uses four fixed stacks, validated options and separate table/hand UUIDs',async()=>{
  const [e]=await ready,state=create(e),view=checkPrivacy(e,state);
  assert.equal(state.id,tableId);assert.notEqual(state.handId,state.id);
  assert.equal(view.handNumber,1);assert.equal(view.handOver,false);assert.equal(view.over,false);
  assert.equal(state.game.players.reduce((n,p)=>n+p.chips,0)+state.game.pot,4000);
  assert.deepEqual(state.game.handStartChips,[1000,1000,1000,1000]);
  assert.throws(()=>e.createGame({id:tableId,difficulty:'impossible'}),{code:'invalid_request',status:400});
  assert.throws(()=>e.createGame({id:'table-1'}),{code:'invalid_request'});
  assert.equal(e.createGame({id:tableId,nick:'\0  Тест\n '},rng(1),ids()).game.players[0].name,'Тест');
});

test('strict action validation rejects extra state, seat, fractional and malformed raises',async()=>{
  const [e]=await ready,state=create(e);
  for(const action of [null,[],{type:'call',seat:1},{type:'call',amount:40},{type:'raise'},{type:'raise',amount:80.5},{type:'raise',amount:'80'},{type:'raise',amount:4001},{type:'start'},{type:'fold',game:{chips:100000}}])
    assert.throws(()=>e.applyAction(state,action),{code:'invalid_request',status:400});
  assert.throws(()=>e.applyAction(state,{type:'check'}),{code:'illegal_action'});
  assert.throws(()=>e.applyAction(state,{type:'raise',amount:41}),{code:'illegal_action'});
  const before=JSON.stringify(state);e.applyAction(state,{type:'call'},rng(9));assert.equal(JSON.stringify(state),before);
});

test('ordinary hand completion preserves table, next hand stacks and dealer progression',async()=>{
  const [e]=await ready;let state=finishHand(e,create(e,4));
  assert.equal(state.over,false);assert.equal(state.game.over,true);
  const old=structuredClone(state),view=checkPrivacy(e,state),chips=state.game.players.map(p=>p.chips);
  assert.deepEqual(view.legal.actions,['nextHand','close']);
  state=e.applyAction(state,{type:'nextHand'},rng(61),()=> '00000000-0000-4000-8000-000000000999');
  assert.equal(state.id,old.id);assert.notEqual(state.handId,old.handId);assert.equal(state.game.handNumber,2);
  assert.deepEqual(state.game.handStartChips,chips);assert.equal(state.game.tableHistory.length,1);
  assert.equal(state.game.tableHistory[0].net,old.game.handProfit);assert.equal(state.game.button,1);
  assert.deepEqual(old.game.players.map(p=>p.chips),chips);assert.equal(state.game.over,false);checkPrivacy(e,state);
  assert.throws(()=>e.applyAction(state,{type:'nextHand'}),{code:'illegal_action'});
});

test('every street pauses for review and only an explicit continuation reveals it',async()=>{
  const [e]=await ready;let state=create(e,8),sawReview=0;
  while(!state.game.over){
    const before=state.game.community.length,legal=e.legalActions(state),review=state.game.phase==='review';
    if(review)sawReview++;
    const type=legal.actions.includes('continue')?'continue':legal.actions.includes('check')?'check':'call';
    const next=e.applyAction(state,{type},rng(16));
    if(!review)assert.equal(next.game.community.length,before,'bot/human betting cannot open a new street');
    state=next;
  }
  assert(sawReview>=1);checkPrivacy(e,state);
});

test('bot work is bounded and continuing a pending bot turn never accepts human bets',async()=>{
  const [e,c]=await ready,core=c.createCore({random:rng(99)});
  const g=core.pokerNewGame('Игрок','easy');g.id='00000000-0000-4000-8000-000000000002';g.tableId=tableId;
  // First actor for button 0 is seat 3, an actual bot. The wrapper must not allow seat 0 to bet yet.
  let state={version:1,id:tableId,handId:g.id,over:false,game:g};e.assertIntegrity(state);
  assert.equal(g.toAct,3);assert.deepEqual(e.legalActions(state).actions,['continue','close']);
  assert.throws(()=>e.applyAction(state,{type:'call'}),{code:'illegal_action'});
  state=e.applyAction(state,{type:'continue'},rng(50));
  assert.equal(state.game.community.length,0);
  const botActs=state.game.history.filter(x=>/ — (пас|чек|колл|ва-банк|рейз|ставка)/.test(x)).length;
  assert(botActs>=1&&botActs<=2);checkPrivacy(e,state);
});

test('projection hides all bot cards before showdown and all folded cards at showdown',async()=>{
  const [e]=await ready;let state=create(e,11);checkPrivacy(e,state);
  // Arrange a legal folded seat and use real transitions to settle the hand.
  state=finishHand(e,state,rng(18));const view=checkPrivacy(e,state);
  if(state.game.showdown)for(let i=1;i<4;i++)if(!state.game.players[i].folded){assert(view.players[i].hand);assert(view.players[i].combination.name)}
});

test('closing an active hand keeps chips conserved without inventing a winner or payout',async()=>{
  const [e]=await ready,state=create(e,25),closed=e.applyAction(state,{type:'close'}),view=checkPrivacy(e,closed);
  assert.equal(closed.over,true);assert.equal(view.tableClosed,true);assert.equal(view.handOver,false);
  assert.equal(view.phase,'over');assert.deepEqual(view.prizes,[]);assert.deepEqual(view.pots,[]);assert.deepEqual(view.legal.actions,[]);
  assert.equal(view.pot,state.game.pot);assert.deepEqual(closed.game.players,state.game.players);
  assert.throws(()=>e.applyAction(closed,{type:'nextHand'}),{code:'illegal_action'});
  assert.deepEqual(e.applyAction(state,{type:'resign'}),closed);
});

test('hidden opponent cards and live deck never affect a bot public-information estimate or decision',async()=>{
  const [e,c]=await ready,state=create(e,42),g=structuredClone(state.game),i=1;
  g.toAct=i;g.players[i].acted=false;g.players[i].actedAtBet=null;
  const alternate=structuredClone(g);
  [alternate.players[0].hand[0],alternate.deck[0]]=[alternate.deck[0],alternate.players[0].hand[0]];
  [alternate.players[2].hand[1],alternate.deck[1]]=[alternate.deck[1],alternate.players[2].hand[1]];
  const one=c.createCore({random:rng(72)}),two=c.createCore({random:rng(72)});
  assert.deepEqual(one.pokerBotEstimate(g,i),two.pokerBotEstimate(alternate,i));
  assert.deepEqual(one.pokerBotDecision(g,i),two.pokerBotDecision(alternate,i));
});

test('server randomness is isolated and does not call or mutate ambient Math.random',async()=>{
  const [e]=await ready,original=Math.random;
  Math.random=()=>{throw Error('ambient random must not be used');};
  try{const state=e.createGame({id:tableId},rng(12),ids());e.applyAction(state,{type:'call'},rng(9));e.projectGame(state);assert.notEqual(Math.random,original)}finally{Math.random=original}
  const value=e.secureRandom();assert(value>=0&&value<1);
});

test('corrupt stored cards, chips, identity and hand outcome fail closed',async()=>{
  const [e]=await ready,state=create(e,5);
  const mutations=[g=>g.game.players[0].chips++,g=>g.game.deck[0]=g.game.players[0].hand[0],g=>g.handId=tableId,g=>g.over=true,g=>g.game.toAct=-1,g=>g.game.history.push({cards:g.game.deck})];
  for(const mutate of mutations){const bad=structuredClone(state);mutate(bad);assert.throws(()=>e.projectGame(bad),{code:'invalid_server_state',status:503})}
  const ended=finishHand(e,state);ended.game.prizes[0]++;assert.throws(()=>e.applyAction(ended,{type:'nextHand'}),{code:'invalid_server_state'});
});

test('90 seeded continuous server tables preserve cards/chips through all difficulties and busts',async()=>{
  const [e]=await ready;let hands=0,steps=0,headsup=0;
  for(let trial=0;trial<90;trial++){
    const random=rng(trial+1000),uuid=ids();let state=e.createGame({id:tableId,difficulty:['easy','normal','hard'][trial%3]},random,uuid),count=0;
    while(!state.over&&count++<2500){
      e.assertIntegrity(state);const view=checkPrivacy(e,state),legal=view.legal;
      let action;
      if(legal.actions.includes('nextHand')){hands++;action={type:'nextHand'};if(state.game.players.filter(p=>p.chips>0).length===2)headsup++}
      else if(legal.actions.includes('continue'))action={type:'continue'};
      else if(legal.actions.includes('raise'))action={type:'raise',amount:legal.maximum};
      else action={type:legal.actions.includes('check')?'check':'call'};
      const before=JSON.stringify(state);state=e.applyAction(state,action,random,uuid);steps++;
      assert.notEqual(JSON.stringify(state),before);
    }
    assert(state.over,'a table terminates without stalling');assert(state.game.over);assert(state.game.players[0].chips===0||state.game.players.filter(p=>p.chips>0).length===1);
    checkPrivacy(e,state);assert.deepEqual(e.legalActions(state).actions,[]);
  }
  assert(hands>0);assert(steps>90);assert(headsup>0);
});
