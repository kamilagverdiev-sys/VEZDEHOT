const test=require('node:test');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const path=require('node:path');
const ready=Promise.all([import('../supabase/functions/server-bunker/engine.mjs'),import('../supabase/functions/server-bunker/core.mjs')]);
const id='00000000-0000-4000-8000-000000000001';
const rng=(seed=12345)=>()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
const copy=x=>structuredClone(x);
const create=(e,seed=1,options={})=>e.createGame({id,nick:'Игрок',...options},rng(seed));
function move(e,g,random=rng(8)){
  const l=e.legalActions(g);
  const action=l.actions.includes('reveal')?{type:'reveal',cardType:l.cards[0]}:l.actions.includes('vote')?{type:'vote',target:l.targets[0]}:{type:'continue'};
  return e.applyAction(g,action,random);
}
function finish(e,g,random=rng(9)){
  let steps=0;
  while(!g.over&&steps++<10)g=move(e,g,random);
  assert(g.over);return g;
}
function privacy(e,g){
  const view=e.projectGame(g);
  assert(!Object.hasOwn(view,'events'));assert(!Object.hasOwn(view,'state'));assert(!Object.hasOwn(view,'selectedCard'));
  assert.deepEqual(view.currentEvent,g.events[g.round-1]);
  view.players.forEach((p,i)=>p.cards.forEach((c,index)=>{
    const original=g.players[i].cards[index];
    if(i&&!original.revealed)assert.deepEqual(c,{type:original.type,icon:original.icon,label:original.label,revealed:false});
    else {assert.equal(c.title,original.title);assert.equal(c.score,original.score);assert.deepEqual(c.tags,original.tags);assert(Number.isInteger(c.value));}
  }));
  return view;
}

test('server Bunker generated core matches canonical source byte for byte',()=>{
  execFileSync(process.execPath,[path.join(__dirname,'../scripts/sync-server-bunker-core.cjs'),'--check']);
});
test('server Bunker starts six unique dossiers, stable styles and three distinct secret events',async()=>{
  const [e]=await ready,g=create(e),view=privacy(e,g);
  assert.equal(g.players.length,6);assert.equal(g.round,1);assert.equal(g.phase,'reveal');assert.equal(g.id,id);
  for(const type of view.legal.cards)assert.equal(new Set(g.players.map(p=>p.cards.find(c=>c.type===type).title)).size,6);
  assert.equal(new Set(g.events.map(x=>x.title)).size,3);
  assert.deepEqual(g.players.slice(1).map(p=>p.botStyle),['pragmatic','team','focused','pragmatic','team']);
  assert.deepEqual(view.economy,{version:1,stake:0,settled:false,payout:0,xp:0,outcome:null});
  assert.deepEqual(view.legal.targets,[]);assert.equal(view.legal.cards.length,6);
});
test('server Bunker strictly validates setup while cleaning display name',async()=>{
  const [e]=await ready;
  for(const options of [{difficulty:'other'},{scenarioChoice:'__proto__'},{scenarioChoice:null},{stake:1},{stake:'100'},{id:'not-uuid'},{nick:{}}])assert.throws(()=>create(e,1,options),{code:'invalid_request',status:400});
  assert.equal(create(e,2,{nick:'\0  Игрок\n '}).players[0].name,'Игрок');
  for(const scenarioChoice of e.SCENARIO_CHOICES){const g=create(e,1,{scenarioChoice});assert.equal(g.scenarioChoice,scenarioChoice);if(scenarioChoice!=='random')assert.equal(g.scenario.code,scenarioChoice);}
});
test('one reveal opens exactly one card per living player without mutating input',async()=>{
  const [e]=await ready,g=create(e),before=copy(g),next=e.applyAction(g,{type:'reveal',cardType:'hobby'},rng(4));
  assert.deepEqual(g,before);assert.equal(next.phase,'vote');assert.equal(next.players[0].cards.find(c=>c.revealed).type,'hobby');
  for(const p of next.players){assert.equal(p.cards.filter(c=>c.revealed).length,1);assert.equal(p.cards.find(c=>c.revealed).revealedRound,1);}
  assert.throws(()=>e.applyAction(next,{type:'reveal',cardType:'health'}),{code:'illegal_action'});
  privacy(e,next);
});
test('malformed action and injected actor/state/reward fields are rejected',async()=>{
  const [e]=await ready,g=create(e),before=copy(g);
  for(const action of [null,[],{}, {type:'start'},{type:'reveal'},{type:'reveal',cardType:'unknown'},{type:'reveal',cardType:'profession',actor:1},{type:'vote',target:0},{type:'vote',target:1.5},{type:'vote',target:'1'},{type:'continue',result:'survived'},{type:'resign',payout:9999}])assert.throws(()=>e.applyAction(g,action),{code:'invalid_request',status:400});
  assert.throws(()=>e.applyAction(g,{type:'vote',target:1}),{code:'illegal_action'});assert.throws(()=>e.applyAction(g,{type:'continue'}),{code:'illegal_action'});assert.deepEqual(g,before);
});
test('voting records every live ballot and exact tally then waits for explicit continue',async()=>{
  const [e]=await ready;let g=move(e,create(e));const before=copy(g);g=e.applyAction(g,{type:'vote',target:1},rng(4));
  assert.equal(before.phase,'vote');assert.equal(g.phase,'voteResult');assert.equal(g.round,1);assert.equal(g.players.filter(p=>p.alive).length,5);
  const tally=Array(6).fill(0);assert.equal(g.lastVote.ballots.length,6);assert.equal(new Set(g.lastVote.ballots.map(b=>b.from)).size,6);
  for(const b of g.lastVote.ballots){assert.notEqual(b.from,b.to);tally[b.to]++;}
  assert.deepEqual(tally,g.votes);assert.deepEqual(g.voteLog[0].votes,tally);assert.equal(g.lastVote.count,Math.max(...tally));
  assert.throws(()=>e.applyAction(g,{type:'vote',target:2}),{code:'illegal_action'});
  const next=e.applyAction(g,{type:'continue'});assert.equal(next.round,next.over?1:2);if(!next.over)assert.equal(next.phase,'reveal');
  assert.throws(()=>e.applyAction(next,{type:'continue'}),{code:'illegal_action'});privacy(e,next);
});
test('canonical tie lottery includes the human and every tied leader symmetrically',async()=>{
  const [e,c]=await ready,g=move(e,create(e)),ballots=[{from:0,to:1},{from:1,to:0},{from:2,to:0},{from:3,to:0},{from:4,to:1},{from:5,to:1}];
  const first=copy(g),last=copy(g);
  c.createCore({random:()=>0}).bunkerResolveVotes(first,[3,3,0,0,0,0],ballots);
  c.createCore({random:()=>.999999}).bunkerResolveVotes(last,[3,3,0,0,0,0],ballots);
  e.assertIntegrity(first);e.assertIntegrity(last);assert.equal(first.lastVote.out,0);assert.equal(last.lastVote.out,1);assert.deepEqual(first.lastVote.tied,[0,1]);
});
test('projection withholds future events and every hidden bot field even after completion',async()=>{
  const [e]=await ready,g=create(e),before=privacy(e,g),other=copy(g);
  [other.events[1],other.events[2]]=[other.events[2],other.events[1]];
  for(let card=0;card<6;card++)[other.players[1].cards[card],other.players[2].cards[card]]=[other.players[2].cards[card],other.players[1].cards[card]];
  assert.deepEqual(e.projectGame(other),before);
  const ended=finish(e,g);privacy(e,ended);assert.equal(ended.over,true);
  const projected=e.projectGame(ended);projected.players[0].cards[0].tags.push('not-real');projected.scenario.name='changed';assert.notEqual(ended.scenario.name,'changed');assert(!ended.players[0].cards[0].tags.includes('not-real'));
});
test('server transitions preserve canonical reveal, vote and continuation results for all difficulties',async()=>{
  const [e,c]=await ready;
  for(const difficulty of ['easy','normal','hard'])for(let seed=1;seed<=20;seed++){
    let g=create(e,seed,{difficulty});const canonical=copy(g);const serverRandom=rng(seed+500),localRandom=rng(seed+500),core=c.createCore({random:localRandom});
    while(!g.over){
      if(g.phase==='reveal'){const cardType=e.legalActions(g).cards[0];core.reveal(canonical,cardType);g=e.applyAction(g,{type:'reveal',cardType},serverRandom);}
      else if(g.phase==='vote'){const target=e.legalActions(g).targets[0];core.vote(canonical,target);g=e.applyAction(g,{type:'vote',target},serverRandom);}
      else{core.continue(canonical);g=e.applyAction(g,{type:'continue'},serverRandom);}
      for(const key of ['phase','round','players','votes','voteLog','lastVote','eliminated','over','result'])assert.deepEqual(g[key],canonical[key],key+' matches canonical');
    }
  }
});
test('180 seeded games finish in at most three votes with dead players absent from later actions',async()=>{
  const [e]=await ready;let won=0,lost=0;
  for(let seed=1;seed<=180;seed++){
    let g=create(e,seed,{difficulty:['easy','normal','hard'][seed%3]});const random=rng(seed+900);let steps=0;
    while(!g.over&&steps++<10){
      const previous=copy(g);g=move(e,g,random);privacy(e,g);
      if(previous.phase==='reveal')for(let seat=0;seat<6;seat++)if(!previous.players[seat].alive)assert.deepEqual(g.players[seat].cards,previous.players[seat].cards);
      if(g.phase==='vote')for(const seat of g.eliminated)assert(!e.legalActions(g).targets.includes(seat));
      if(previous.phase==='vote')assert.equal(g.lastVote.ballots.length,previous.players.filter(p=>p.alive).length);
    }
    assert(g.over);assert(g.voteLog.length<=3);assert.equal(g.result,g.players[0].alive?'survived':'lost');g.result==='survived'?won++:lost++;
  }
  assert(won>0);assert(lost>0);
});
test('terminal review only offers continue, and stale resign cannot erase the earned outcome',async()=>{
  const [e]=await ready;let sawWin=false,sawLoss=false;
  for(let seed=1;seed<=100&&!(sawWin&&sawLoss);seed++){
    let g=create(e,seed,{stake:100});const random=rng(seed+300);
    while(!g.over){
      if(g.phase==='voteResult'&&(!g.players[0].alive||g.players.filter(p=>p.alive).length===3)){
        assert.deepEqual(e.legalActions(g).actions,['continue']);assert.equal(g.economy.settled,false);
        const next=e.applyAction(g,{type:'continue'}),resigned=e.applyAction(g,{type:'resign'});assert.deepEqual(resigned,next);assert.equal(next.resigned,false);
        if(next.result==='survived'){sawWin=true;assert.deepEqual(next.economy,{version:1,stake:100,settled:true,payout:250,xp:120,outcome:'win'});}else{sawLoss=true;assert.deepEqual(next.economy,{version:1,stake:100,settled:true,payout:0,xp:25,outcome:'loss'});}
        g=next;
      }else g=move(e,g,random);
    }
  }
  assert(sawWin&&sawLoss);
});
test('later rounds reject already disclosed own cards and eliminated vote targets',async()=>{
  const [e]=await ready;let g;
  for(let seed=1;seed<30;seed++){const candidate=move(e,move(e,create(e,seed),rng(5)),rng(6));if(candidate.players[0].alive){g=e.applyAction(candidate,{type:'continue'});break;}}
  assert(g);assert.equal(g.phase,'reveal');const disclosed=g.players[0].cards.find(c=>c.revealed).type;
  assert.throws(()=>e.applyAction(g,{type:'reveal',cardType:disclosed}),{code:'illegal_card'});
  g=e.applyAction(g,{type:'reveal',cardType:e.legalActions(g).cards[0]},rng(20));const before=copy(g);
  assert.throws(()=>e.applyAction(g,{type:'vote',target:g.eliminated[0]}),{code:'illegal_target'});assert.deepEqual(g,before);
});
test('resign ends a nonterminal game without changing cards or earning XP',async()=>{
  const [e]=await ready;
  for(const stake of [0,100]){let g=create(e,41,{stake});for(const phase of ['reveal','vote','voteResult']){
    while(g.phase!==phase&&!g.over)g=move(e,g,rng(62));if(g.over)break;
    if(g.phase==='voteResult'&&!e.legalActions(g).actions.includes('resign'))break;
    const next=e.applyAction(g,{type:'resign'});assert.equal(next.result,'lost');assert.equal(next.resigned,true);assert.deepEqual(next.players,g.players);assert.deepEqual(next.economy,{version:1,stake,settled:true,payout:0,xp:0,outcome:'resigned'});assert.deepEqual(e.legalActions(next),{actions:[],cards:[],targets:[]});assert.throws(()=>e.applyAction(next,{type:'continue'}),{code:'illegal_action'});
  }}
});
test('free completed games record outcome but never mint server coins or XP',async()=>{
  const [e]=await ready;
  for(let seed=1;seed<=20;seed++){const g=finish(e,create(e,seed),rng(seed+2));assert.equal(g.economy.stake,0);assert.equal(g.economy.payout,0);assert.equal(g.economy.xp,0);assert.equal(g.economy.settled,true);assert.throws(()=>e.applyAction(g,{type:'resign'}),{code:'illegal_action'});}
});
test('corrupt persisted dossiers, phases, histories and economy fail closed',async()=>{
  const [e]=await ready,g=create(e),vote=move(e,move(e,g,rng(2)),rng(3));
  for(const change of [x=>x.phase='over',x=>x.players[0].cards[0].score=999,x=>x.players[1].cards[0]={...x.players[0].cards[0]},x=>x.economy.payout=250,x=>x.economy.extra=true,x=>x.scenarioChoice='NOPE',x=>x.events.push(x.events[0]),x=>x.players[2].alive=false,x=>x.players[0].cards[0].revealedRound=1]){
    const bad=copy(g);change(bad);assert.throws(()=>e.projectGame(bad),{code:'invalid_server_state',status:503});
  }
  for(const change of [x=>x.voteLog[0].ballots[0].from=x.voteLog[0].ballots[1].from,x=>x.voteLog[0].votes[0]++,x=>x.lastVote.count++,x=>x.eliminated=[],x=>x.players[0].cards.find(c=>c.revealed).revealedRound=2]){const bad=copy(vote);change(bad);assert.throws(()=>e.applyAction(bad,{type:'continue'}),{code:'invalid_server_state'});}
});
test('JSONB object key reordering preserves public state and all phase transitions',async()=>{
  const [e]=await ready;
  const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.length-b.length||a.localeCompare(b)).map(([key,item])=>[key,reorder(item)])):value;
  let g=create(e,2,{stake:100});
  while(!g.over){
    const stored=reorder(g);assert.deepEqual(e.projectGame(stored),e.projectGame(g));
    const next=move(e,g,rng(g.round+20)),restored=move(e,stored,rng(g.round+20));assert.deepEqual(restored,next);g=next;
  }
  assert.deepEqual(e.projectGame(reorder(g)),e.projectGame(g));
});
test('a nonterminal vote result cannot masquerade as a finished null-result loss',async()=>{
  const [e]=await ready;let g;
  for(let seed=1;seed<30;seed++){const candidate=move(e,move(e,create(e,seed),rng(5)),rng(6));if(candidate.players[0].alive){g=candidate;break;}}
  assert(g);assert.equal(g.players.filter(p=>p.alive).length,5);
  for(const result of [null,'lost','survived']){
    const bad=copy(g);Object.assign(bad,{phase:'over',over:true,settled:true,result});bad.economy={version:1,stake:0,settled:true,payout:0,xp:0,outcome:result==='survived'?'win':'loss'};
    assert.throws(()=>e.assertIntegrity(bad),{code:'invalid_server_state',status:503});
  }
});
