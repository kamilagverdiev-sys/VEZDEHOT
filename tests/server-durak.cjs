const {test}=require('node:test');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const path=require('node:path');
const root=path.join(__dirname,'..');
const engine=import('../supabase/functions/server-durak/engine.mjs');
const handler=import('../supabase/functions/server-durak/index.ts');
const uid='fc296954-96db-41d7-a336-223fb510fb53',gameId='c4d5bb0d-a917-4e6f-aa85-c0dc13124d15';
const origin='https://vezdehot.vercel.app';
const seeded=(seed=122345)=>()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
const clone=x=>structuredClone(x);
const req=(body,options={})=>new Request('https://example.supabase.co/functions/v1/server-durak',{method:'POST',headers:{origin,'content-type':'application/json',authorization:'Bearer fixture-user-token-with-sufficient-length',...options.headers},body:JSON.stringify(body)});
function memoryService(options={}) {
  const store={revision:0,state:null,receipts:new Map()},calls=[];
  const fetcher=async(url,request)=>{
    const route=new URL(url).pathname,body=request.body?JSON.parse(request.body):null;calls.push({route,body,headers:request.headers});
    assert.equal(request.headers.apikey,'test-service-secret');assert.equal(request.redirect,'error');assert(request.signal instanceof AbortSignal);
    if(route==='/auth/v1/user') {
      assert.equal(request.headers.Authorization,'Bearer fixture-user-token-with-sufficient-length');
      return new Response(JSON.stringify({id:uid,is_anonymous:!!options.anonymous,user_metadata:{full_name:'Тест'}}),{status:options.badAuth?401:200});
    }
    assert.equal(request.headers.Authorization,'Bearer test-service-secret');assert.equal(body.p_user_id,uid);
    const old=body.p_action_id&&store.receipts.get(body.p_action_id);
    if(old&&JSON.stringify(old.request)!==JSON.stringify(body.p_request))return new Response(JSON.stringify({code:'22023'}),{status:400});
    if(route.endsWith('server_durak_read'))return Response.json(old?{receipt:old.response}:{revision:store.revision,state:store.state});
    if(route.endsWith('server_durak_commit')){
      if(old)return Response.json({receipt:old.response});
      if(options.insufficientFunds)return Response.json({code:'P0001',message:'insufficient_funds'},{status:400});
      if(options.conflictOnCommit){store.revision++;return Response.json({conflict:true,revision:store.revision,state:store.state});}
      if(body.p_expected_revision!==store.revision)return Response.json({conflict:true,revision:store.revision,state:store.state});
      store.state=clone(body.p_state);store.revision++;store.receipts.set(body.p_action_id,{request:clone(body.p_request),response:clone(body.p_response)});
      if(options.lostAck){options.lostAck=false;throw Error('lost response');}
      return Response.json({receipt:body.p_response});
    }
    throw Error('unexpected route');
  };
  return {store,calls,options,fetcher};
}
async function setup(options={}) {
 const service=memoryService(options),{createHandler}=await handler;
 return {...service,handle:createHandler({env:n=>({SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-service-secret'}[n]),fetch:service.fetcher,random:seeded(),uuid:()=>gameId})};
}
const start=revision=>({op:'start',actionId:crypto.randomUUID(),expectedRevision:revision,bots:1,difficulty:'normal'});
const action=(revision,type,cardId)=>({op:'action',actionId:crypto.randomUUID(),expectedRevision:revision,gameId,action:{type,...(cardId?{cardId}:{})}});
function stateWithAction(e,wanted,bots=1){
 for(let seed=1;seed<=8;seed++){
  const random=seeded(seed*37+bots);let g=e.createGame({bots,id:gameId,stake:100},random);
  for(let step=0;!g.over&&step<1000;step++){
   const legal=e.legalActions(g);if(legal.actions.includes(wanted))return g;
   const type=legal.actions.includes('defend')?'defend':legal.actions.includes('attack')?'attack':['finish','take','continue'].find(t=>legal.actions.includes(t));
   g=e.applyAction(g,{type,...(['attack','defend'].includes(type)?{cardId:legal.cards[0]}:{})},random);
  }
 }
 assert.fail('real games should offer '+wanted);
}

test('server rules generated from tested local rules stay byte-identical',()=>execFileSync(process.execPath,['scripts/sync-server-durak-core.cjs','--check'],{cwd:root}));
test('server projection never exposes other hands or shuffled deck, including completed games',async()=>{
 const {createGame,projectGame}=await engine,g=createGame({bots:3,id:gameId},seeded()),p=projectGame(g);
 assert.equal(p.players[0].hand.length,g.players[0].hand.length);assert(!Object.hasOwn(p,'deck'));
 p.players.slice(1).forEach((opponent,i)=>{assert(!Object.hasOwn(opponent,'hand'));assert.equal(opponent.handCount,g.players[i+1].hand.length)});
 const ended=(await engine).applyAction(g,{type:'resign'});assert(!Object.hasOwn(projectGame(ended).players[1],'hand'));
 const keys=Object.keys(p);assert(!keys.includes('pendingRound'));assert(!keys.includes('state'));
});
test('illegal actor, card, phase, fields and action do not mutate source',async()=>{
 const {createGame,applyAction,legalActions}=await engine,g=createGame({bots:1,id:gameId},seeded()),before=clone(g);
 for(const bad of [{type:'bot'},{type:'take',actor:1},{type:'attack',cardId:'hacked'},{type:'defend',cardId:'A♣',actor:0},{type:'resign',cardId:'6♠'}]) assert.throws(()=>applyAction(g,bad));
 const opposite=legalActions(g).actions.includes('take')?'finish':'take';assert.throws(()=>applyAction(g,{type:opposite}));assert.deepEqual(g,before);
});
test('real endgames project their one- and two-card attack limits without revealing hands or changing legality',async()=>{
 const e=await engine,found=new Set();
 for(let seed=1;seed<=12&&found.size<2;seed++){
  const random=seeded(seed);let g=e.createGame({bots:2,id:gameId},random);
  for(let step=0;!g.over&&step<1000;step++){
   const legal=e.legalActions(g);
   if(g.attacker===0&&[1,2].includes(g.roundLimit)&&g.table.length===g.roundLimit&&legal.actions.includes('finish')){
    const before=clone(g),projected=e.projectGame(g);assert.equal(projected.roundLimit,g.roundLimit);assert.deepEqual(projected.legal,legal);assert.equal(projected.legal.cards.length,0);assert(!Object.hasOwn(projected,'deck'));projected.players.slice(1).forEach(p=>assert(!Object.hasOwn(p,'hand')));assert.deepEqual(g,before);found.add(g.roundLimit);
   }
   const type=legal.actions.includes('defend')?'defend':legal.actions.includes('attack')?'attack':['finish','take','continue'].find(t=>legal.actions.includes(t));g=e.applyAction(g,{type,...(['attack','defend'].includes(type)?{cardId:legal.cards[0]}:{})},random);
  }
 }
 assert.deepEqual([...found].sort(),[1,2]);
});
test('90 complete 2–4-player server games conserve every card and terminate without client bots',async()=>{
 const {createGame,applyAction,legalActions,assertIntegrity}=await engine;
 for(let bots=1;bots<=3;bots++)for(let trial=0;trial<30;trial++){
  const random=seeded(trial*33+bots+234);let g=createGame({bots,difficulty:['easy','normal','hard'][trial%3]},random),steps=0;
  while(!g.over&&steps++<5000){const legal=legalActions(g);let move;
   if(legal.actions.includes('defend'))move={type:'defend',cardId:legal.cards[0]};
   else if(legal.actions.includes('attack'))move={type:'attack',cardId:legal.cards[0]};
   else move={type:['take','finish','continue'].find(type=>legal.actions.includes(type))};
   assert(move.type,'server should always expose a useful action');g=applyAction(g,move,random);assertIntegrity(g);
  }
  assert(g.over,`bots ${bots} trial ${trial} should terminate`);assert(g.draw||Number.isInteger(g.loser));assert.equal(g.stake,0);
 }
});
test('one finish or take is equivalent to canonical prepare then the legacy continue transition',async()=>{
 const e=await engine,{createCore}=await import('../supabase/functions/server-durak/core.mjs');
 for(const bots of [1,2,3])for(const type of ['finish','take']){
  const g=stateWithAction(e,type,bots),before=clone(g),prepared=clone(g),core=createCore({random:seeded(864),id:g.id,nick:'Тест'});
  assert(type==='finish'?core.durakPrepareRound(prepared,false):core.durakApplyResolve(prepared,true));assert.equal(prepared.phase,'roundEnd');
  const expected=e.applyAction(prepared,{type:'continue'},seeded(864)),actual=e.applyAction(g,{type},seeded(864));
  assert.deepEqual(actual,expected);assert.deepEqual(g,before);e.assertIntegrity(actual);
  assert(actual.over||actual.round>g.round,'the requested round is committed');
  const cards=[...actual.deck,...actual.players.flatMap(p=>p.hand),...actual.table.flatMap(p=>p.d?[p.a,p.d]:[p.a])];assert.equal(cards.length+actual.discardCount,36);assert.equal(new Set(cards.map(c=>c.id)).size,cards.length);
  assert.equal(actual.journal.filter(entry=>entry.kind===(type==='take'?'take':'discard')&&entry.round===g.round).length,1);
 }
});
test('endpoint rejects missing, unverified and anonymous identities before private DB access',async()=>{
 for(const options of [{anonymous:true},{badAuth:true}]){const s=await setup(options),response=await s.handle(req({op:'load'}));assert.equal(response.status,401);assert.equal(s.calls.length,1);}
 const s=await setup(),response=await s.handle(req({op:'load'},{headers:{authorization:''}}));assert.equal(response.status,401);assert.equal(s.calls.length,0);
});
test('endpoint rejects caller ownership, snapshots and unauthorized origins',async()=>{
 const s=await setup();for(const body of [{op:'load',userId:uid},{...start(0),state:{}},{...start(0),payout:9000}]){assert.equal((await s.handle(req(body))).status,400);}
 assert.equal((await s.handle(req({op:'load'},{headers:{origin:'https://attacker.invalid'}}))).status,403);assert.equal(s.calls.length,0);
});
test('create, exact retry, conflicting payload and protected active table',async()=>{
 const s=await setup(),body=start(0);let response=await s.handle(req(body));assert.equal(response.status,200);const first=await response.json();assert.equal(first.revision,1);assert.equal(first.status,'saved');
 const again=await(await s.handle(req(body))).json();assert.deepEqual(again,first);assert.equal(s.store.revision,1);
 const reused=await s.handle(req({...body,bots:2}));assert.equal(reused.status,409);
 const active=await s.handle(req(start(1)));assert.equal(active.status,422);assert.equal((await active.json()).error,'table_already_active');
 assert(!Object.hasOwn(first.game,'deck'));assert.equal(s.calls.filter(c=>c.route.endsWith('server_durak_commit')).length,1);
});
test('stale revisions return current safe projection without applying a move',async()=>{
 const s=await setup();await s.handle(req(start(0)));const response=await(await s.handle(req(action(0,'resign')))).json();assert.equal(response.status,'conflict');assert.equal(response.revision,1);assert(!Object.hasOwn(response.game.players[1],'hand'));assert.equal(s.store.state.over,false);
});
test('lost acknowledgement retry returns original receipt even after later action',async()=>{
 const s=await setup({lostAck:true}),body=start(0);assert.equal((await s.handle(req(body))).status,503);assert.equal(s.store.revision,1);
 const first=await(await s.handle(req(body))).json();assert.equal(first.revision,1);
 const resigned=await(await s.handle(req(action(1,'resign')))).json();assert.equal(resigned.revision,2);assert(resigned.game.resigned);
 const old=await(await s.handle(req(body))).json();assert.deepEqual(old,first);assert.equal(s.store.revision,2);
 const latest=await(await s.handle(req({op:'load'}))).json();assert.equal(latest.revision,2);assert(latest.game.over);
});
test('legacy spectator exit commits its earned result once and replays that exact result after a lost ACK',async()=>{
 const e=await engine,s=await setup({lostAck:true}),c=(rank,suit='♠')=>({rank,suit,id:rank+suit,color:['♥','♦'].includes(suit)?'red':'black'}),g=e.createGame({bots:2,id:gameId,stake:100},seeded());
 Object.assign(g,{deck:[],trump:'♥',trumpCard:c('A','♥'),table:[],discardCount:33,attacker:1,defender:2,phase:'attack',finished:[0],roundLimit:null,resolve:null,pendingRound:null});g.players[0].hand=[];g.players[1].hand=[c('6')];g.players[2].hand=[c('7'),c('8','♦')];e.assertIntegrity(g);s.store.state=g;s.store.revision=7;
 const body=action(7,'resign');assert.equal((await s.handle(req(body))).status,503);assert.equal(s.store.revision,8);assert.equal(s.store.state.economy.outcome,'win');assert.equal(s.store.state.economy.payout,300);
 const retry=await(await s.handle(req(body))).json();assert.equal(retry.status,'saved');assert.equal(retry.revision,8);assert.equal(retry.game.resigned,false);assert.equal(retry.game.economy.payout,300);assert.equal(retry.game.economy.xp,80);assert.equal(s.store.receipts.size,1);assert.equal(s.calls.filter(c=>c.route.endsWith('server_durak_commit')).length,1);assert.equal((await s.handle(req(action(8,'continue')))).status,422);assert.equal(s.store.revision,8);
});
test('atomic take commits once and lost-ACK retry cannot take cards from the following round',async()=>{
 const e=await engine,s=await setup({lostAck:true}),g=stateWithAction(e,'take',1);s.store.state=clone(g);s.store.revision=9;
 const body=action(9,'take');assert.equal((await s.handle(req(body))).status,503);assert.equal(s.store.revision,10);const saved=clone(s.store.state);assert(saved.over||saved.round>g.round);
 const retry=await(await s.handle(req(body))).json();assert.equal(retry.status,'saved');assert.equal(retry.revision,10);assert.deepEqual(s.store.state,saved);assert.equal(s.store.receipts.size,1);assert.equal(s.calls.filter(c=>c.route.endsWith('server_durak_commit')).length,1);e.assertIntegrity(saved);
});
test('atomic final finish commits terminal cards and paid outcome in the same single receipt',async()=>{
 const e=await engine,s=await setup({lostAck:true}),c=rank=>({rank,suit:'♠',color:'black',id:rank+'♠'}),g=e.createGame({bots:1,id:gameId,stake:100},seeded());
 Object.assign(g,{deck:[],table:[{a:c('7'),d:c('8')}],discardCount:33,phase:'resolve',attacker:0,defender:1,finished:[],roundLimit:6,resolve:{took:false},pendingRound:null});g.players[0].hand=[];g.players[1].hand=[c('6')];e.assertIntegrity(g);s.store.state=g;s.store.revision=12;
 const body=action(12,'finish');assert.equal((await s.handle(req(body))).status,503);assert.equal(s.store.revision,13);assert(s.store.state.over);assert.equal(s.store.state.discardCount,35);assert.equal(s.store.state.economy.payout,200);assert.equal(s.store.state.economy.xp,80);
 const retry=await(await s.handle(req(body))).json();assert.equal(retry.status,'saved');assert(retry.game.over);assert.equal(retry.game.economy.settled,true);assert.equal(s.store.receipts.size,1);assert.equal(s.calls.filter(c=>c.route.endsWith('server_durak_commit')).length,1);assert.equal((await s.handle(req(action(13,'continue')))).status,422);assert.equal(s.store.revision,13);
});
test('foreign table ID is rejected without mutation; restart keeps revision monotonic',async()=>{
 const s=await setup();await s.handle(req(start(0)));
 assert.equal((await s.handle(req({...action(1,'resign'),gameId:crypto.randomUUID()}))).status,422);assert.equal(s.store.revision,1);
 await s.handle(req(action(1,'resign')));const restarted=await(await s.handle(req(start(2)))).json();assert.equal(restarted.revision,3);assert(!restarted.game.over);
});
test('CAS race returns only public projection and no guessed candidate state',async()=>{
 const s=await setup({conflictOnCommit:true});const response=await(await s.handle(req(start(0)))).json();assert.equal(response.status,'conflict');assert.equal(response.game,null);assert.equal(s.store.state,null);
});
test('oversized request and malformed action are denied',async()=>{
 const s=await setup();assert.equal((await s.handle(req({op:'load',padding:'x'.repeat(5000)}))).status,413);
 await s.handle(req(start(0)));assert.equal((await s.handle(req(action(1,'take','6♠')))).status,400);assert.equal(s.store.revision,1);
});

test('paid Durak settles every terminal outcome from the real round transition',async()=>{
 const e=await engine,c=(rank)=>({rank,suit:'♠',color:'black',id:rank+'♠'});
 for(const bots of [1,2,3])for(const outcome of ['win','draw','loss']){
  let g=e.createGame({bots,id:gameId,stake:100},seeded());
  // All but this final defended pair have reached the discard pile.
  Object.assign(g,{deck:[],table:[{a:c('7'),d:c('8')}],discardCount:outcome==='draw'?34:33,phase:'resolve',attacker:0,defender:1,finished:[],roundLimit:6,resolve:{took:false},pendingRound:null});
  g.players.forEach(p=>p.hand=[]);if(outcome!=='draw')g.players[outcome==='loss'?0:1].hand=[c('6')];
  e.assertIntegrity(g);assert.equal(g.economy.settled,false);
  g=e.applyAction(g,{type:'finish'},seeded());assert(g.over);e.assertIntegrity(g);
  assert.deepEqual(g.economy,{version:1,stake:100,settled:true,payout:outcome==='win'?100*(bots+1):outcome==='draw'?100:0,xp:{win:80,draw:40,loss:25}[outcome],outcome});
  assert.deepEqual(e.projectGame(g).economy,g.economy);
  assert.throws(()=>e.applyAction(g,{type:'continue'}),{code:'illegal_action'});
 }
});
test('Durak paid resignation has no reward, rejects economy corruption and preserves legacy free tables',async()=>{
 const e=await engine,g=e.createGame({id:gameId,stake:100},seeded()),before=clone(g);
 const resigned=e.applyAction(g,{type:'resign'});assert.deepEqual(g,before);
 assert.deepEqual(resigned.economy,{version:1,stake:100,settled:true,payout:0,xp:0,outcome:'resigned'});
 for(const mutate of [x=>x.stake=500,x=>x.payout=100,x=>x.xp=80,x=>x.settled=true,x=>x.outcome='win',x=>x.extra=1]){const bad=clone(g);mutate(bad.economy);assert.throws(()=>e.projectGame(bad),{code:'invalid_server_state'});}
 const legacy=clone(g);delete legacy.economy;assert.equal(e.projectGame(legacy).economy.stake,0);
 assert.deepEqual(e.applyAction(legacy,{type:'resign'}).economy,{version:1,stake:0,settled:true,payout:0,xp:0,outcome:'resigned'});
 for(const stake of [null,-1,1,100.5,500,'100'])assert.throws(()=>e.createGame({stake}),{code:'invalid_request'});
});
test('Durak endpoint allows only fixed optional stakes and keeps paid start retry exact',async()=>{
 const s=await setup();for(const stake of [null,-1,1,100.5,500,'100'])assert.equal((await s.handle(req({...start(0),stake}))).status,400);
 assert.equal(s.calls.length,0);
 const body={...start(0),stake:100},first=await(await s.handle(req(body))).json();assert.equal(first.game.economy.stake,100);assert.equal(first.game.economy.settled,false);
 assert.deepEqual(await(await s.handle(req(body))).json(),first);assert.equal(s.store.revision,1);
 assert.equal((await s.handle(req({...body,stake:0}))).status,409);
 const end=await(await s.handle(req(action(1,'resign')))).json();assert.equal(end.game.economy.payout,0);assert.equal(end.game.economy.xp,0);
});
test('Durak insufficient funds leaves the table and request receipt uncommitted',async()=>{
 const s=await setup({insufficientFunds:true}),body={...start(0),stake:100};
 const response=await s.handle(req(body));assert.equal(response.status,422);assert.deepEqual(await response.json(),{error:'insufficient_funds'});
 assert.equal(s.store.state,null);assert.equal(s.store.revision,0);assert.equal(s.store.receipts.size,0);
 s.options.insufficientFunds=false;assert.equal((await s.handle(req(body))).status,200);assert.equal(s.store.revision,1);
});
