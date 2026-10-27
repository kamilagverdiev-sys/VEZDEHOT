const {test}=require('node:test');
const assert=require('node:assert/strict');
const {isDeepStrictEqual}=require('node:util');
const handler=import('../supabase/functions/server-wallet/index.ts');
const uid='fc296954-96db-41d7-a336-223fb510fb53';
const otherUid='90b4cb07-bf07-48be-af15-69b9296e8ef1';
const origin='https://vezdehot.vercel.app',token='Bearer fixture-user-token-with-sufficient-length';
const clone=x=>structuredClone(x),iso=ms=>new Date(ms).toISOString(),DAY=86400000;
function wallet(now=Date.parse('2026-10-25T10:00:00Z')) {
 return {version:1,revision:1,balance:1000,xp:0,games:0,wins:0,bonusAvailableAt:iso(now+DAY),serverTime:iso(now),history:[{id:crypto.randomUUID(),kind:'welcome',game:null,tableId:null,delta:1000,xp:0,balance:1000,createdAt:iso(now)}]};
}
function request(body,options={}) {
 const method=options.method||'POST';
 return new Request('https://example.supabase.co/functions/v1/server-wallet',{method,headers:{origin,'content-type':'application/json',authorization:token,...options.headers},...(['GET','OPTIONS'].includes(method)?{}:{body:options.raw===undefined?JSON.stringify(body):options.raw})});
}
function memoryService(options={}) {
 const store={wallet:wallet(),receipts:new Map(),now:Date.parse('2026-10-25T10:00:00Z')},calls=[];
 const fetcher=async(url,req)=>{
  const route=new URL(url).pathname,body=req.body?JSON.parse(req.body):null;calls.push({route,body,headers:req.headers});
  assert.equal(req.headers.apikey,'test-service-secret');assert.equal(req.redirect,'error');assert(req.signal instanceof AbortSignal);
  if(options.networkFailure)throw Error('private test-service-secret network error');
  if(route==='/auth/v1/user') {
   assert.equal(req.headers.Authorization,token);
   return Response.json(options.user??{id:uid,is_anonymous:!!options.anonymous,user_metadata:{id:otherUid}},{status:options.authStatus||200});
  }
  assert.equal(req.headers.Authorization,'Bearer test-service-secret');assert.equal(body.p_user_id,uid);
  if(options.rpcFailure)return Response.json({code:options.rpcFailure,message:'private test-service-secret DB detail'},{status:400});
  if(route==='/rest/v1/rpc/server_wallet_read') {
   store.wallet.serverTime=iso(store.now);
   return Response.json(options.loadReply??store.wallet);
  }
  if(route==='/rest/v1/rpc/server_wallet_claim') {
   const id=body.p_action_id.toLowerCase(),old=store.receipts.get(id);
   if(old)return isDeepStrictEqual(old.request,body.p_request)?Response.json(old.response):Response.json({code:'22023'},{status:400});
   if(options.claimReply)return Response.json(options.claimReply);
   const availableAt=store.wallet.bonusAvailableAt;
   let response;
   if(Date.parse(availableAt)>store.now)response={status:'cooldown',actionId:body.p_action_id,availableAt};
   else {
    store.wallet.balance+=1000;store.wallet.revision++;store.wallet.bonusAvailableAt=iso(store.now+DAY);store.wallet.serverTime=iso(store.now);
    store.wallet.history.unshift({id:crypto.randomUUID(),kind:'daily',game:null,tableId:null,delta:1000,xp:0,balance:store.wallet.balance,createdAt:iso(store.now)});
    response={status:'saved',actionId:body.p_action_id,availableAt:store.wallet.bonusAvailableAt};
   }
   store.receipts.set(id,{request:clone(body.p_request),response:clone(response)});
   if(options.lostAck){options.lostAck=false;throw Error('private test-service-secret lost response');}
   return Response.json(response);
  }
  throw Error('unexpected RPC path');
 };
 return {store,calls,options,fetcher};
}
async function setup(options={}) {
 const service=memoryService(options),{createHandler}=await handler;
 return {...service,handle:createHandler({env:name=>({SUPABASE_URL:options.projectUrl??'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-service-secret'}[name]),fetch:service.fetcher})};
}
const claim=()=>({op:'claimDaily',actionId:crypto.randomUUID()});
async function json(s,body,options){const response=await s.handle(request(body,options));return{status:response.status,data:await response.json(),headers:response.headers};}

test('wallet uses only freshly verified permanent Auth identity for the private RPC',async()=>{
 const s=await setup(),r=await json(s,{op:'load'});assert.equal(r.status,200);assert.equal(r.data.status,'ok');assert.equal(r.data.wallet.balance,1000);
 assert.deepEqual(s.calls.map(c=>c.route),['/auth/v1/user','/rest/v1/rpc/server_wallet_read']);assert.deepEqual(s.calls[1].body,{p_user_id:uid});
 assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('x-content-type-options'),'nosniff');
 assert.equal(r.headers.get('access-control-allow-origin'),origin);assert.equal(r.headers.get('vary'),'Origin');
});
test('wallet denies missing, expired, anonymous and malformed identities before any wallet access',async()=>{
 for(const options of [{anonymous:true},{authStatus:401},{user:{id:uid}},{user:{id:otherUid,is_anonymous:true}},{user:{id:'not-a-uuid',is_anonymous:false}}]){
  const s=await setup(options),r=await json(s,{op:'load'});assert.equal(r.status,401);assert.equal(s.calls.length,1);
 }
 const s=await setup();for(const authorization of ['', 'Basic abc', 'Bearer short']){const r=await json(s,{op:'load'},{headers:{authorization}});assert.equal(r.status,401);}assert.equal(s.calls.length,0);
 const upstream=await setup({authStatus:503}),r=await json(upstream,{op:'load'});assert.equal(r.status,503);assert.equal(upstream.calls.length,1);
});
test('wallet rejects caller UIDs, amounts, timestamps and unknown operations before Auth',async()=>{
 const s=await setup();for(const body of [{op:'load',userId:otherUid},{op:'load',p_user_id:otherUid},{...claim(),balance:9000},{...claim(),amount:1000},{...claim(),xp:100},{...claim(),now:'2030-01-01T00:00:00Z'},{...claim(),wallet:{}},{op:'settle',actionId:crypto.randomUUID()}])assert.equal((await json(s,body)).status,400);
 assert.equal(s.calls.length,0);
});
test('wallet limits exact origins and methods while allowing authenticated-free preflight',async()=>{
 const s=await setup();for(const bad of ['', 'null','https://evil.invalid','https://vezdehot.vercel.app.evil.invalid']){
  const r=await json(s,{op:'load'},{headers:{origin:bad}});assert.equal(r.status,403);assert.equal(r.headers.get('access-control-allow-origin'),null);
 }
 for(const allowed of [origin,'https://vezdehot.greysquid7.chatgpt.site']){
  const r=await s.handle(request(null,{method:'OPTIONS',headers:{origin:allowed,authorization:''}}));assert.equal(r.status,204);assert.equal(r.headers.get('access-control-allow-origin'),allowed);
 }
 assert.equal((await s.handle(request(null,{method:'GET'}))).status,405);assert.equal(s.calls.length,0);
});
test('wallet rejects malformed requests, action IDs, UTF-8 and oversized bodies',async()=>{
 const s=await setup();for(const body of [null,[],{}, {op:'load',actionId:crypto.randomUUID()},{op:'claimDaily'},{op:'claimDaily',actionId:'bad'},{op:'claimDaily',actionId:null}])assert.equal((await json(s,body)).status,400);
 assert.equal((await json(s,null,{raw:'{"op":'})).status,400);
 assert.equal((await json(s,null,{raw:new Uint8Array([255])})).status,400);
 assert.equal((await json(s,{op:'load'},{headers:{'content-type':'text/plain'}})).status,415);
 assert.equal((await json(s,{op:'load',padding:'x'.repeat(5000)})).status,413);assert.equal(s.calls.length,0);
});
test('wallet projection allowlists fields rather than leaking service-only columns',async()=>{
 const w=wallet();w.user_id=uid;w.private_note='never expose';w.history[0].request={secret:'never expose'};w.history[0].user_id=uid;
 const s=await setup({loadReply:w}),r=await json(s,{op:'load'});assert.equal(r.status,200);assert(!Object.hasOwn(r.data.wallet,'user_id'));assert(!Object.hasOwn(r.data.wallet,'private_note'));assert(!Object.hasOwn(r.data.wallet.history[0],'request'));assert(!Object.hasOwn(r.data.wallet.history[0],'user_id'));
 const played=wallet();played.games=1;played.wins=1;played.xp=80;played.history.unshift({id:crypto.randomUUID(),kind:'settlement',game:'durak',tableId:crypto.randomUUID(),delta:200,xp:80,balance:1100,createdAt:played.serverTime});
 assert.equal((await json(await setup({loadReply:played}),{op:'load'})).status,200);
});
test('wallet fails closed on corrupt counter, date, ledger or ownership references',async()=>{
 for(const mutate of [w=>w.balance=-1,w=>w.revision=1.5,w=>w.xp=Number.MAX_SAFE_INTEGER+1,w=>w.wins=2,w=>w.serverTime='yesterday',w=>w.bonusAvailableAt=null,w=>w.history=Array(21).fill(w.history[0]),w=>w.history.push(clone(w.history[0])),w=>w.history[0].game='durak',w=>w.history[0].tableId=uid,w=>w.history[0].delta='1000',w=>w.history[0].kind='secret',w=>w.history[0].createdAt='broken']){
  const w=wallet();mutate(w);const r=await json(await setup({loadReply:w}),{op:'load'});assert.equal(r.status,503);assert.deepEqual(r.data,{error:'server_unavailable'});
 }
});
test('wallet daily claim uses server clock and immutable cooldown receipt',async()=>{
 const s=await setup(),body=claim(),first=await json(s,body);assert.equal(first.data.status,'cooldown');assert.equal(first.data.actionId,body.actionId);assert.equal(s.store.wallet.balance,1000);
 s.store.now+=DAY+1;
 assert.deepEqual((await json(s,body)).data,first.data);assert.equal(s.store.wallet.balance,1000,'retry of a cooldown request never becomes a later grant');
 const next=claim(),granted=await json(s,next);assert.equal(granted.data.status,'saved');assert.equal(granted.data.actionId,next.actionId);assert.equal(s.store.wallet.balance,2000);assert.equal(s.store.wallet.revision,2);
 assert(!Object.hasOwn(granted.data,'wallet'));assert(!Object.hasOwn(granted.data,'balance'));
 assert.deepEqual((await json(s,next)).data,granted.data);assert.equal(s.store.wallet.balance,2000);
});
test('lost daily acknowledgement retries exact receipt without a second grant and loads latest balance',async()=>{
 const s=await setup({lostAck:true});s.store.now+=DAY;const body=claim();const lost=await json(s,body);assert.equal(lost.status,503);assert.deepEqual(lost.data,{error:'server_unavailable'});assert.equal(s.store.wallet.balance,2000);
 const retry=await json(s,body);assert.equal(retry.data.status,'saved');assert.equal(s.store.wallet.balance,2000);assert.equal(s.store.receipts.size,1);
 s.store.wallet.balance=2100;s.store.wallet.revision=3;
 assert.equal((await json(s,{op:'load'})).data.wallet.balance,2100);assert.equal((await json(s,body)).data.status,'saved');assert.equal(s.store.wallet.revision,3);
});
test('reused request UUID with a different stored body returns conflict, never a new bonus',async()=>{
 const s=await setup(),body=claim();s.store.now+=DAY;await json(s,body);
 const changed={...body,actionId:body.actionId.toUpperCase()};assert.notEqual(changed.actionId,body.actionId);
 const r=await json(s,changed);assert.equal(r.status,409);assert.deepEqual(r.data,{error:'request_id_reused'});assert.equal(s.store.wallet.balance,2000);
});
test('wallet rejects mismatched or incomplete receipts and strips nonpublic receipt fields',async()=>{
 const body=claim();for(const reply of [{status:'ok',actionId:body.actionId},{status:'saved',actionId:crypto.randomUUID()},{status:'cooldown',actionId:body.actionId},{status:'saved',actionId:body.actionId,availableAt:'not-a-time'}]){
  const r=await json(await setup({claimReply:reply}),body);assert.equal(r.status,503);assert.deepEqual(r.data,{error:'server_unavailable'});
 }
 const r=await json(await setup({claimReply:{status:'saved',actionId:body.actionId,user_id:uid,wallet:{private:'no'}}}),body);assert.deepEqual(r.data,{status:'saved',actionId:body.actionId});
});
test('private DB and transport errors are generic; unsupported project hosts never receive credentials',async()=>{
 for(const options of [{rpcFailure:'XX000'},{networkFailure:true},{projectUrl:'https://evil.invalid'}]){
  const s=await setup(options),r=await json(s,{op:'load'});assert.equal(r.status,503);assert.deepEqual(r.data,{error:'server_unavailable'});assert(!JSON.stringify(r.data).includes('secret'));if(options.projectUrl)assert.equal(s.calls.length,0);
 }
});
test('outbound wallet requests use an 8-second AbortSignal deadline',async()=>{
 const {createHandler}=await handler,original=global.setTimeout,deadlines=[];
 global.setTimeout=(fn,delay,...args)=>{deadlines.push(delay);return original(fn,0,...args);};
 try {
  const handle=createHandler({env:n=>({SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-service-secret'}[n]),fetch:async(_url,options)=>new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted')), {once:true}))});
  const r=await handle(request({op:'load'}));assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:'server_unavailable'});assert.deepEqual(deadlines,[8000]);
 } finally {global.setTimeout=original;}
});

test('wallet accepts the Bunker settlement alongside other games without dropping XP or exposing private fields',async()=>{
 const w=wallet();Object.assign(w,{balance:1150,xp:120,games:1,wins:1});
 w.history.unshift({id:crypto.randomUUID(),kind:'settlement',game:'bunker',tableId:crypto.randomUUID(),delta:250,xp:120,balance:1150,createdAt:w.serverTime,private_state:'hidden'});
 const result=await json(await setup({loadReply:w}),{op:'load'});assert.equal(result.status,200);assert.equal(result.data.wallet.history[0].game,'bunker');assert.equal(result.data.wallet.xp,120);assert.equal(result.data.wallet.history[0].xp,120);assert.equal(result.data.wallet.history[0].delta,250);assert.equal('private_state' in result.data.wallet.history[0],false);
});
