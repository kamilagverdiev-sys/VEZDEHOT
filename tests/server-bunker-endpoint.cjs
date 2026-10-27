const {test}=require('node:test');
const assert=require('node:assert/strict');
const {isDeepStrictEqual}=require('node:util');
const handler=import('../supabase/functions/server-bunker/index.ts');
const uid='fc296954-96db-41d7-a336-223fb510fb53';
const otherUid='90b4cb07-bf07-48be-af15-69b9296e8ef1';
const origin='https://vezdehot.vercel.app';
const token='Bearer fixture-user-token-with-sufficient-length';
const clone=x=>structuredClone(x);
const seeded=(seed=122345)=>()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
function request(body,options={}) {
 const method=options.method||'POST';
 return new Request('https://example.supabase.co/functions/v1/server-bunker',{method,headers:{origin,'content-type':'application/json',authorization:token,...options.headers},...(['GET','OPTIONS'].includes(method)?{}:{body:options.raw===undefined?JSON.stringify(body):options.raw})});
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
  if(route.endsWith('/server_bunker_read')) {
   if(options.readFailure)return Response.json({message:'private DB detail test-service-secret'},{status:500});
   return Response.json(receipt?{receipt:receipt.response}:{revision:store.revision,state:store.state});
  }
  if(route.endsWith('/server_bunker_commit')) {
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
const start=revision=>({op:'start',actionId:crypto.randomUUID(),expectedRevision:revision,difficulty:'normal',scenarioChoice:'random'});
const action=(revision,gameId,type,extra={})=>({op:'action',actionId:crypto.randomUUID(),expectedRevision:revision,gameId,action:{type,...extra}});
async function json(s,body){const response=await s.handle(request(body));return {status:response.status,data:await response.json()};}
function assertPrivacy(game){
 if(!game)return;
 for(const key of ['events','state','selectedCard','selectedVote'])assert(!Object.hasOwn(game,key));
 for(const p of game.players.slice(1))for(const c of p.cards)if(!c.revealed)assert.deepEqual(Object.keys(c).sort(),['icon','label','revealed','type']);
}
test('Bunker endpoint verifies permanent Auth identity before reading storage',async()=>{
 for(const options of [{anonymous:true},{authStatus:401},{user:{id:uid}},{user:{id:'bad',is_anonymous:false}}]){
  const s=await setup(options),result=await json(s,{op:'load'});assert.equal(result.status,401);assert.equal(s.calls.length,1);
 }
 const s=await setup();for(const authorization of ['', 'Basic anything','Bearer short'])assert.equal((await s.handle(request({op:'load'},{headers:{authorization}}))).status,401);assert.equal(s.calls.length,0);
});
test('Bunker ownership comes from Auth UID and body identity/state/reward injection is rejected',async()=>{
 const s=await setup();
 for(const body of [{op:'load',userId:otherUid},{...start(0),state:{}},{...start(0),balance:900000},{...start(0),bots:1}])assert.equal((await json(s,body)).status,400);
 assert.equal(s.calls.length,0);assert.deepEqual((await json(s,{op:'load'})).data,{status:'ok',revision:0,game:null});
 assert.equal(s.calls.find(c=>c.route.endsWith('/server_bunker_read')).body.p_user_id,uid);
});
test('Bunker endpoint allows only the two production origins and no unauthenticated mutations',async()=>{
 const s=await setup();
 for(const origin of ['https://attacker.invalid','null','https://vezdehot.vercel.app.attacker.invalid']){
  const response=await s.handle(request({op:'load'},{headers:{origin}}));assert.equal(response.status,403);assert.equal(response.headers.get('access-control-allow-origin'),null);
 }
 for(const allowed of [origin,'https://vezdehot.greysquid7.chatgpt.site']){
  const response=await s.handle(request(null,{method:'OPTIONS',headers:{origin:allowed,authorization:''}}));assert.equal(response.status,204);assert.equal(response.headers.get('access-control-allow-origin'),allowed);
 }
 assert.equal((await s.handle(request(null,{method:'GET'}))).status,405);assert.equal(s.calls.length,0);
});
test('Bunker rejects oversized or malformed bodies, revisions, scenarios and stakes before storage',async()=>{
 const s=await setup();
 for(const body of [null,[],{}, {op:'load',actionId:crypto.randomUUID()},{...start(0),expectedRevision:-1},{...start(0),expectedRevision:.5},{...start(0),expectedRevision:Number.MAX_SAFE_INTEGER+1},{...start(0),actionId:'bad'},{...start(0),difficulty:'other'},{...start(0),scenarioChoice:'__proto__'},{...start(0),scenarioChoice:null},...[null,-1,1,'100',100.5].map(stake=>({...start(0),stake}))])assert.equal((await json(s,body)).status,400);
 assert.equal((await s.handle(request(null,{raw:'{"op":'}))).status,400);
 assert.equal((await s.handle(request({op:'load'},{headers:{'content-type':'text/plain'}}))).status,415);
 assert.equal((await json(s,{op:'load',padding:'x'.repeat(5000)})).status,413);assert.equal(s.calls.length,0);
});
test('Bunker start receipt is idempotent, protected from changed-body reuse and active resets',async()=>{
 const s=await setup(),body={...start(0),scenarioChoice:'ASH / 05',stake:100},first=await json(s,body);
 assert.equal(first.status,200);assert.equal(first.data.status,'saved');assert.equal(first.data.revision,1);assert.equal(first.data.game.scenario.code,'ASH / 05');assert.equal(first.data.game.economy.stake,100);assertPrivacy(first.data.game);
 assert.deepEqual(await json(s,body),first);assert.equal(s.store.revision,1);assert.equal((await json(s,{...body,difficulty:'hard'})).status,409);
 const active=await json(s,start(1));assert.equal(active.status,422);assert.equal(active.data.error,'table_already_active');assert.equal(s.calls.filter(c=>c.route.endsWith('/server_bunker_commit')).length,1);
});
test('Bunker stale revision and wrong game ID cannot apply actions or disclose hidden state',async()=>{
 const s=await setup(),created=await json(s,start(0)),before=clone(s.store.state);
 const stale=await json(s,action(0,created.data.game.id,'reveal',{cardType:'profession'}));assert.equal(stale.data.status,'conflict');assert.equal(stale.data.revision,1);assertPrivacy(stale.data.game);
 const wrong=await json(s,action(1,crypto.randomUUID(),'resign'));assert.equal(wrong.status,422);assert.equal(wrong.data.error,'table_changed');assert.deepEqual(s.store.state,before);assert.equal(s.store.receipts.size,1);
});
test('Bunker commit race returns latest public snapshot and never fabricates a saved game',async()=>{
 const s=await setup({conflictOnCommit:true}),result=await json(s,start(0));assert.equal(result.status,200);assert.deepEqual(result.data,{status:'conflict',revision:1,game:null});assert.equal(s.store.state,null);assert.equal(s.store.receipts.size,0);
});
test('Bunker illegal actions and unexpected fields leave state and receipt count unchanged',async()=>{
 const s=await setup(),created=await json(s,start(0)),before=clone(s.store.state),id=created.data.game.id;
 for(const move of [{type:'continue'},{type:'vote',target:1},{type:'reveal',cardType:'unknown'},{type:'reveal',cardType:'profession',actor:1},{type:'vote',target:0},{type:'vote',target:'1'},{type:'resign',result:'survived'}]){
  const result=await json(s,{...action(1,id,'resign'),action:move});assert([400,422].includes(result.status));assert.deepEqual(s.store.state,before);assert.equal(s.store.revision,1);assert.equal(s.store.receipts.size,1);
 }
});
test('Bunker lost reveal acknowledgement replays original response without revealing another card',async()=>{
 const s=await setup(),created=await json(s,start(0)),body=action(1,created.data.game.id,'reveal',{cardType:'hobby'});
 s.options.lostAck=true;assert.equal((await json(s,body)).status,503);assert.equal(s.store.revision,2);assert.equal(s.store.state.phase,'vote');
 const recovered=await json(s,body);assert.equal(recovered.status,200);assert.equal(recovered.data.revision,2);assert.equal(s.store.revision,2);assertPrivacy(recovered.data.game);
 assert.equal(s.store.state.players[0].cards.filter(c=>c.revealed).length,1);assert.equal(s.store.state.players[0].cards.find(c=>c.revealed).type,'hobby');
 assert.equal((await json(s,{...body,action:{type:'reveal',cardType:'health'}})).status,409);
});
test('Bunker historical receipt does not change authoritative latest game after a later move',async()=>{
 const s=await setup(),startBody=start(0),created=await json(s,startBody);
 const reveal=await json(s,action(1,created.data.game.id,'reveal',{cardType:'profession'}));assert.equal(reveal.data.revision,2);
 assert.deepEqual(await json(s,startBody),created);const latest=await json(s,{op:'load'});assert.equal(latest.data.revision,2);assert.equal(latest.data.game.phase,'vote');assert.equal(s.store.revision,2);assertPrivacy(latest.data.game);
});
test('Bunker completed result persists exactly once and next game increments account revision',async()=>{
 const s=await setup({seed:123}),created=await json(s,{...start(0),stake:100});let current=created.data,finalBody;
 for(let n=0;!current.game.over&&n<10;n++){
  const legal=current.game.legal;
  const move=legal.actions.includes('reveal')?{type:'reveal',cardType:legal.cards[0]}:legal.actions.includes('vote')?{type:'vote',target:legal.targets[0]}:{type:'continue'};
  const body={...action(current.revision,current.game.id,move.type),action:move};
  const response=await json(s,body);assert.equal(response.status,200);current=response.data;assertPrivacy(current.game);if(current.game.over)finalBody=body;
 }
 assert(current.game.over);assert(current.game.economy.settled);assert.equal(current.game.economy.payout,current.game.result==='survived'?250:0);assert.equal(current.game.economy.xp,current.game.result==='survived'?120:25);
 const count=s.store.receipts.size;assert.deepEqual((await json(s,finalBody)).data,current);assert.equal(s.store.receipts.size,count);
 assert.equal((await json(s,action(current.revision,current.game.id,'continue'))).status,422);
 const next=await json(s,start(current.revision));assert.equal(next.data.revision,current.revision+1);assert.notEqual(next.data.game.id,current.game.id);assert.equal(next.data.game.phase,'reveal');assert.equal(next.data.game.economy.stake,0);
});
test('Bunker insufficient server funds rejects deal without persistence and allows safe retry',async()=>{
 const s=await setup({insufficientFunds:true}),body={...start(0),stake:100},result=await json(s,body);
 assert.equal(result.status,422);assert.deepEqual(result.data,{error:'insufficient_funds'});assert.equal(s.store.state,null);assert.equal(s.store.revision,0);assert.equal(s.store.receipts.size,0);
 s.options.insufficientFunds=false;assert.equal((await json(s,body)).status,200);assert.equal(s.store.revision,1);
});
test('Bunker internal service failures never expose database messages or credentials',async()=>{
 const s=await setup({readFailure:true}),result=await json(s,{op:'load'});assert.equal(result.status,503);assert.deepEqual(result.data,{error:'server_unavailable'});
 const auth=await setup({authStatus:503});assert.equal((await json(auth,{op:'load'})).status,503);assert.equal(auth.calls.length,1);
});
