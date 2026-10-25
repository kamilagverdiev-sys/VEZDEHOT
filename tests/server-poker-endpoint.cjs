const {test}=require('node:test');
const assert=require('node:assert/strict');
const {isDeepStrictEqual}=require('node:util');
const handler=import('../supabase/functions/server-poker/index.ts');
const uid='fc296954-96db-41d7-a336-223fb510fb53';
const otherUid='90b4cb07-bf07-48be-af15-69b9296e8ef1';
const origin='https://vezdehot.vercel.app';
const token='Bearer fixture-user-token-with-sufficient-length';
const clone=x=>structuredClone(x);
const seeded=(seed=122345)=>()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
function request(body,options={}) {
 const method=options.method||'POST';
 return new Request('https://example.supabase.co/functions/v1/server-poker',{method,headers:{origin,'content-type':'application/json',authorization:token,...options.headers},...(['GET','OPTIONS'].includes(method)?{}:{body:options.raw===undefined?JSON.stringify(body):options.raw})});
}
function memoryService(options={}) {
 const store={revision:0,state:null,receipts:new Map()},calls=[];
 const fetcher=async(url,req)=>{
  const route=new URL(url).pathname,body=req.body?JSON.parse(req.body):null;calls.push({route,body,headers:req.headers});
  assert.equal(req.headers.apikey,'test-service-secret');assert.equal(req.redirect,'error');assert(req.signal instanceof AbortSignal);
  if(route==='/auth/v1/user') {
   assert.equal(req.headers.Authorization,token);
   const user=options.user??{id:uid,is_anonymous:!!options.anonymous,user_metadata:{full_name:'Тест',user_id:otherUid}};
   return Response.json(user,{status:options.authStatus||200});
  }
  assert.equal(req.headers.Authorization,'Bearer test-service-secret');assert.equal(body.p_user_id,uid);
  const receipt=body.p_action_id&&store.receipts.get(body.p_action_id.toLowerCase());
  if(receipt&&!isDeepStrictEqual(receipt.request,body.p_request))return Response.json({code:'22023'},{status:400});
  if(route.endsWith('/server_poker_read')) {
   if(options.readFailure)return Response.json({message:'private DB detail test-service-secret'},{status:500});
   return Response.json(receipt?{receipt:receipt.response}:{revision:store.revision,state:store.state});
  }
  if(route.endsWith('/server_poker_commit')) {
   if(receipt)return Response.json({receipt:receipt.response});
   if(options.insufficientFunds)return Response.json({code:'P0001',message:'insufficient_funds'},{status:400});
   if(options.conflictOnCommit){store.revision++;return Response.json({conflict:true,revision:store.revision,state:store.state});}
   if(body.p_expected_revision!==store.revision)return Response.json({conflict:true,revision:store.revision,state:store.state});
   assert.equal(body.p_response.revision,store.revision+1);assert.equal(body.p_response.status,'saved');assert.equal(body.p_response.game.id,body.p_state.id);
   store.state=clone(body.p_state);store.revision++;store.receipts.set(body.p_action_id.toLowerCase(),{request:clone(body.p_request),response:clone(body.p_response)});
   if(options.lostAck){options.lostAck=false;throw Error('lost response private test-service-secret');}
   return Response.json({receipt:body.p_response});
  }
  throw Error('unexpected route '+route);
 };
 return {store,calls,options,fetcher};
}
async function setup(options={}) {
 const service=memoryService(options),{createHandler}=await handler;
 let id=0;
 const uuid=()=>`c4d5bb0d-a917-4e6f-aa85-${String(++id).padStart(12,'0')}`;
 return {...service,handle:createHandler({env:name=>({SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-service-secret'}[name]),fetch:service.fetcher,random:seeded(options.seed),uuid})};
}
const start=revision=>({op:'start',actionId:crypto.randomUUID(),expectedRevision:revision,difficulty:'normal'});
const action=(revision,gameId,type,extra={})=>({op:'action',actionId:crypto.randomUUID(),expectedRevision:revision,gameId,action:{type,...extra}});
async function json(s,body){const response=await s.handle(request(body));return {status:response.status,data:await response.json()};}
function assertPrivateCardsAbsent(game) {
 if(!game)return;
 assert(!Object.hasOwn(game,'deck'));assert(!Object.hasOwn(game,'burn'));assert(!Object.hasOwn(game,'state'));
 const hand=game.hand&&typeof game.hand==='object'?game.hand:game;
 assert(!Object.hasOwn(hand,'deck'));assert(!Object.hasOwn(hand,'burn'));
 if(Array.isArray(hand.players))hand.players.slice(1).forEach(p=>{if(!hand.showdown||p.folded||p.sittingOut)assert(!Object.hasOwn(p,'hand'),'unrevealed opponents hands must stay private');});
}

test('poker endpoint verifies identity and rejects missing, expired and anonymous sessions before storage',async()=>{
 for(const options of [{anonymous:true},{authStatus:401},{user:{id:uid}},{user:{id:'malformed',is_anonymous:false}}]) {
  const s=await setup(options),result=await json(s,{op:'load'});assert.equal(result.status,401);assert.equal(s.calls.length,1);
 }
 const s=await setup();for(const authorization of ['', 'Bearer sb_publishable_fake', 'Basic anything'])assert.equal((await s.handle(request({op:'load'},{headers:{authorization}}))).status,401);
 // A syntactically token-like key may reach Auth, but never grants storage access without a verified user.
 assert.equal(s.calls.filter(c=>c.route.includes('/rpc/')).length,0);
});
test('poker endpoint uses only Auth verified UID and rejects body ownership/state/reward injection',async()=>{
 const s=await setup();for(const body of [{op:'load',userId:otherUid},{...start(0),state:{}},{...start(0),balance:900000},{...start(0),bots:1}])assert.equal((await json(s,body)).status,400);
 assert.equal(s.calls.length,0);
 const loaded=await json(s,{op:'load'});assert.equal(loaded.status,200);assert.deepEqual(loaded.data,{status:'ok',revision:0,game:null});
 const dbCall=s.calls.find(c=>c.route.endsWith('/server_poker_read'));assert.equal(dbCall.body.p_user_id,uid);assert.notEqual(dbCall.body.p_user_id,otherUid);
});
test('poker endpoint limits origin/method and handles allowed preflight without authentication',async()=>{
 const s=await setup();for(const invalidOrigin of ['https://attacker.invalid','null','https://vezdehot.vercel.app.attacker.invalid']){
  const response=await s.handle(request({op:'load'},{headers:{origin:invalidOrigin}}));assert.equal(response.status,403);assert.equal(response.headers.get('access-control-allow-origin'),null);
 }
 const preflight=await s.handle(request(null,{method:'OPTIONS',headers:{authorization:''}}));assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),origin);
 assert.equal((await s.handle(request(null,{method:'GET'}))).status,405);assert.equal(s.calls.length,0);
});
test('poker endpoint rejects malformed or oversized bodies and invalid revision/action IDs',async()=>{
 const s=await setup();
 for(const body of [null,[],{}, {op:'load',actionId:crypto.randomUUID()}, {...start(0),expectedRevision:-1},{...start(0),expectedRevision:1.5},{...start(0),expectedRevision:Number.MAX_SAFE_INTEGER+1},{...start(0),actionId:'not-a-uuid'},{...start(0),difficulty:'impossible'}])assert.equal((await json(s,body)).status,400);
 assert.equal((await s.handle(request(null,{raw:'{"op":'}))).status,400);
 assert.equal((await s.handle(request({op:'load'},{headers:{'content-type':'text/plain'}}))).status,415);
 assert.equal((await json(s,{op:'load',padding:'x'.repeat(5000)})).status,413);assert.equal(s.calls.length,0);
});
test('poker start is idempotent, rejects reused action ID with different body and protects active table',async()=>{
 const s=await setup(),body=start(0),first=await json(s,body);assert.equal(first.status,200);assert.equal(first.data.status,'saved');assert.equal(first.data.revision,1);assertPrivateCardsAbsent(first.data.game);
 const again=await json(s,body);assert.deepEqual(again,first);assert.equal(s.store.revision,1);
 assert.equal((await json(s,{...body,difficulty:'hard'})).status,409);
 const active=await json(s,start(1));assert.equal(active.status,422);assert.equal(active.data.error,'table_already_active');
 assert.equal(s.calls.filter(c=>c.route.endsWith('/server_poker_commit')).length,1);
});
test('poker stale CAS and table identity mismatch never apply a candidate action',async()=>{
 const s=await setup();const first=await json(s,start(0)),before=clone(s.store.state);
 const stale=await json(s,action(0,first.data.game.id,'resign'));assert.equal(stale.data.status,'conflict');assert.equal(stale.data.revision,1);assertPrivateCardsAbsent(stale.data.game);assert.deepEqual(s.store.state,before);
 const wrong=await json(s,action(1,crypto.randomUUID(),'resign'));assert.equal(wrong.status,422);assert.equal(wrong.data.error,'table_changed');assert.deepEqual(s.store.state,before);
});
test('poker commit race returns current public state instead of a guessed deal',async()=>{
 const s=await setup({conflictOnCommit:true}),result=await json(s,start(0));assert.equal(result.status,200);assert.deepEqual(result.data,{status:'conflict',revision:1,game:null});assert.equal(s.store.state,null);assert.equal(s.store.receipts.size,0);
});
test('poker service failures do not leak secrets or internal database messages',async()=>{
 const s=await setup({readFailure:true}),result=await json(s,{op:'load'});assert.equal(result.status,503);assert.deepEqual(result.data,{error:'server_unavailable'});
 const auth=await setup({authStatus:503});assert.equal((await json(auth,{op:'load'})).status,503);assert.equal(auth.calls.length,1);
});
test('poker optional stake accepts only fixed modes and paid start replays without a second entry',async()=>{
 const s=await setup();for(const stake of [null,-1,1,100.5,500,'100'])assert.equal((await json(s,{...start(0),stake})).status,400);assert.equal(s.calls.length,0);
 const body={...start(0),stake:100},first=await json(s,body);assert.equal(first.status,200);assert.equal(first.data.game.economy.stake,100);assert.equal(first.data.game.economy.settled,false);
 assert.deepEqual(await json(s,body),first);assert.equal(s.store.revision,1);assert.equal((await json(s,{...body,stake:0})).status,409);
 const before=clone(s.store.state),rejected=await json(s,action(1,first.data.game.id,'close'));assert.equal(rejected.status,422);assert.equal(rejected.data.error,'illegal_action');assert.deepEqual(s.store.state,before);assert.equal(s.store.revision,1);
 const hand=await finishHand(s,first.data);assert.equal(hand.game.economy.settled,false);
 const result=await json(s,action(hand.revision,hand.game.id,'close'));assert.equal(result.status,200);assert(result.data.game.economy.settled);assert.equal(result.data.game.economy.payout,Math.floor(result.data.game.players[0].chips/10));
});
test('poker insufficient balance returns an actionable rejection and does not commit the candidate deal',async()=>{
 const s=await setup({insufficientFunds:true}),body={...start(0),stake:100},result=await json(s,body);
 assert.equal(result.status,422);assert.deepEqual(result.data,{error:'insufficient_funds'});assert.equal(s.store.state,null);assert.equal(s.store.revision,0);assert.equal(s.store.receipts.size,0);
 s.options.insufficientFunds=false;assert.equal((await json(s,body)).status,200);assert.equal(s.store.revision,1);
});

async function finishHand(s,view) {
 let state=view;
 for(let step=0;!state.game.handOver&&step<150;step++){
  const legal=state.game.legal.actions;
  const type=legal.includes('fold')?'fold':legal.includes('continue')?'continue':legal.includes('check')?'check':'call';
  assert(legal.includes(type),'hand should expose a playable move');
  const response=await json(s,action(state.revision,state.game.id,type));assert.equal(response.status,200);assert.equal(response.data.status,'saved');state=response.data;
 }
 assert(state.game.handOver,'hand should finish');return state;
}
test('poker completed hand cannot reset the active table; next hand keeps table ID and table chips',async()=>{
 const s=await setup(),created=await json(s,start(0)),ended=await finishHand(s,created.data),id=ended.game.id;
 assert.equal(ended.game.over,false);assert(ended.game.legal.actions.includes('nextHand'));
 const reset=await json(s,start(ended.revision));assert.equal(reset.status,422);assert.equal(reset.data.error,'table_already_active');
 const before=ended.game.players.map(p=>p.chips),next=await json(s,action(ended.revision,id,'nextHand'));
 assert.equal(next.status,200);assert.equal(next.data.game.id,id);assert.notEqual(next.data.game.handId,ended.game.handId);assert.equal(next.data.game.handNumber,2);
 assert.deepEqual(s.store.state.game.handStartChips,before);assert.equal(next.data.game.players.reduce((n,p)=>n+p.chips,0)+next.data.game.pot,4000);
 const closed=await json(s,action(next.data.revision,id,'close'));assert.equal(closed.status,200);assert.equal(closed.data.game.over,true);
 const restarted=await json(s,start(closed.data.revision));assert.equal(restarted.status,200);assert.notEqual(restarted.data.game.id,id);assert.equal(restarted.data.revision,closed.data.revision+1);assert.equal(restarted.data.game.handNumber,1);
 assert.deepEqual(s.store.state.game.handStartChips,[1000,1000,1000,1000]);
});
test('poker illegal action/raise fields never change persisted state or create receipts',async()=>{
 const s=await setup(),created=await json(s,start(0)),before=clone(s.store.state),id=created.data.game.id;
 for(const move of [{type:'nextHand'},{type:'raise',amount:4001},{type:'raise',amount:1.5},{type:'raise',amount:'100'},{type:'raise',amount:100,actor:1},{type:'fold',amount:20},{type:'deal',cards:[]},{type:'continue',userId:otherUid}]){
  const result=await json(s,{...action(1,id,'fold'),action:move});assert([400,422].includes(result.status));assert.deepEqual(s.store.state,before);assert.equal(s.store.revision,1);assert.equal(s.store.receipts.size,1);
 }
});
test('poker lost acknowledgement replays original receipt after later saved action, without redealing',async()=>{
 const s=await setup({lostAck:true}),body=start(0),first=await json(s,body);assert.equal(first.status,503);assert.equal(s.store.revision,1);
 const original=await json(s,body);assert.equal(original.status,200);assert.equal(original.data.revision,1);
 const closed=await json(s,action(1,original.data.game.id,'close'));assert.equal(closed.status,200);assert.equal(closed.data.revision,2);
 const retry=await json(s,body);assert.deepEqual(retry,original);assert.equal(s.store.revision,2);
 const latest=await json(s,{op:'load'});assert.equal(latest.data.revision,2);assert(latest.data.game.tableClosed);assert.equal(latest.data.game.handId,original.data.game.handId);
});

function client(s) {
 const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
 const context={window:{},document:{getElementById:()=>null}};vm.createContext(context);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../dist/server-poker.js'),'utf8'),context);
 const storage=new Map(),requests=[];
 const api=context.window.VEZDEHOT_SERVER_POKER;
 const controller=api.createController({scope:uid,current:()=>true,uuid:()=>crypto.randomUUID(),storage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},request:async body=>{requests.push(clone(body));const r=await s.handle(request(body));return {ok:r.ok,status:r.status,data:await r.json()}}});
 return {controller,storage,requests};
}
const clean=value=>JSON.parse(JSON.stringify(value));
function view(controller){const state=controller.status();return clean({revision:state.revision,game:state.game,ready:state.ready,phase:state.phase});}
function playerMove(game){const available=game.legal.actions;const type=['fold','continue','check','call'].find(k=>available.includes(k));assert(type);return {type};}
test('two independent poker controllers transfer saved table, cards and stacks, and reload a concurrent conflict',async()=>{
 const s=await setup(),phone=client(s),pc=client(s);assert(await phone.controller.load());assert(await phone.controller.start());assert(await pc.controller.load());
 assert.deepEqual(view(phone.controller),view(pc.controller));const before=view(phone.controller);
 assert(await phone.controller.act(playerMove(before.game)));const after=view(phone.controller);assert.equal(after.revision,before.revision+1);
 // PC still holds the older revision and tries its own move. CAS rejects it;
 // the controller discards that request and reloads the authoritative state.
 assert(await pc.controller.act(playerMove(before.game)));assert.deepEqual(view(pc.controller),after);assert.match(pc.controller.status().notice,/другом устройстве/);
 assert.equal(s.store.revision,after.revision);assert.equal(phone.storage.size,0);assert.equal(pc.storage.size,0);
 phone.controller.destroy();pc.controller.destroy();
});
test('independent poker controllers recover exact nextHand retry after lost ACK and newer PC action',async()=>{
 const s=await setup(),phone=client(s),pc=client(s);await phone.controller.load();await phone.controller.start();
 for(let step=0;!phone.controller.status().game.handOver&&step<150;step++)assert(await phone.controller.act(playerMove(phone.controller.status().game)));
 const ended=view(phone.controller);assert(ended.game.handOver);assert(!ended.game.over);
 s.options.lostAck=true;assert.equal(await phone.controller.act({type:'nextHand'}),false);assert.equal(phone.controller.status().pending,true);assert.equal(phone.storage.size,1);
 const pending=JSON.parse([...phone.storage.values()][0]);assert.equal(pending.action.type,'nextHand');const handId=s.store.state.handId,nextRevision=s.store.revision;
 assert.equal(s.store.state.game.handNumber,2);assert.equal(nextRevision,ended.revision+1);
 // A separate device can see the committed deal despite the phone losing ACK.
 assert(await pc.controller.load());assert.equal(pc.controller.status().game.handId,handId);
 assert(await pc.controller.act(playerMove(pc.controller.status().game)));const latest=view(pc.controller);assert.equal(latest.revision,nextRevision+1);
 assert(await phone.controller.load());assert.deepEqual(view(phone.controller),latest);assert.equal(phone.storage.size,0);assert.equal(phone.controller.status().pending,false);
 assert.equal(s.store.state.handId,handId);assert.equal(s.store.state.game.handNumber,2);assert.equal(s.store.revision,latest.revision);
 const sent=phone.requests.filter(b=>b.actionId===pending.actionId);assert.equal(sent.length,2);assert.deepEqual(sent[0],sent[1]);
 assert.equal(s.calls.filter(c=>c.route.endsWith('/server_poker_commit')&&c.body.p_action_id===pending.actionId).length,1);
 phone.controller.destroy();pc.controller.destroy();
});
