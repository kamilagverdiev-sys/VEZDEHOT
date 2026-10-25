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

test('server rules generated from tested local rules stay byte-identical',()=>execFileSync(process.execPath,['scripts/sync-server-durak-core.cjs','--check'],{cwd:root}));
test('server projection never exposes other hands or shuffled deck, including completed games',async()=>{
 const {createGame,projectGame}=await engine,g=createGame({bots:3,id:gameId},seeded()),p=projectGame(g);
 assert.equal(p.players[0].hand.length,g.players[0].hand.length);assert(!Object.hasOwn(p,'deck'));
 p.players.slice(1).forEach((opponent,i)=>{assert(!Object.hasOwn(opponent,'hand'));assert.equal(opponent.handCount,g.players[i+1].hand.length)});
 g.over=true;g.phase='over';assert(!Object.hasOwn(projectGame(g).players[1],'hand'));
 const keys=Object.keys(p);assert(!keys.includes('pendingRound'));assert(!keys.includes('state'));
});
test('illegal actor, card, phase, fields and action do not mutate source',async()=>{
 const {createGame,applyAction,legalActions}=await engine,g=createGame({bots:1,id:gameId},seeded()),before=clone(g);
 for(const bad of [{type:'bot'},{type:'take',actor:1},{type:'attack',cardId:'hacked'},{type:'defend',cardId:'A♣',actor:0},{type:'resign',cardId:'6♠'}]) assert.throws(()=>applyAction(g,bad));
 const opposite=legalActions(g).actions.includes('take')?'finish':'take';assert.throws(()=>applyAction(g,{type:opposite}));assert.deepEqual(g,before);
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
