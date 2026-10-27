const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('dist/server-mafia.js','utf8'),ctx={window:{},document:{getElementById:()=>null},Object,JSON,Number,Set,Error,Promise};
vm.createContext(ctx);vm.runInContext(source,ctx);const {createController,projection,validFlight,paidStartAvailability}=ctx.window.VEZDEHOT_SERVER_MAFIA;
const ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',SCOPE='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',copy=v=>JSON.parse(JSON.stringify(v)),pendingKey='vezdehot:server-mafia:pending:v1:'+SCOPE;
let base,engine;
test.before(async()=>{engine=await import('../supabase/functions/server-mafia/engine.mjs');base=engine.projectGame(engine.createGame({id:ID},()=>.5));});
const game=()=>copy(base),response=(revision,g=game(),status='ok')=>({ok:true,status:200,data:{status,revision,game:g}});
function memory(){const values=new Map();return {values,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}}
function harness(request,store=memory(),options={}){let active=true;const events=[],controller=createController({scope:SCOPE,current:()=>active,storage:store,uuid:()=>ID,request,onChange:s=>events.push(copy(s)),...options});return {controller,store,events,deactivate:()=>active=false};}
const reveal={type:'mark',target:1,mark:'suspect'},flush=()=>new Promise(r=>setImmediate(r));

test('confirmed empty and same-revision loads refresh the wallet once',async()=>{
 let confirmed=0;const h=harness(async()=>response(6,null),memory(),{onConfirmed:()=>confirmed++});
 await h.controller.load();await h.controller.load();
 assert.equal(confirmed,1);assert.equal(h.controller.status().ready,true);assert.equal(h.controller.status().game,null);
});
test('insufficient funds refreshes the same-revision wallet and clears an uncharged entry',async()=>{
 const calls=[];let confirmed=0;
 const h=harness(async body=>{calls.push(copy(body));return body.op==='load'?response(6,null):{ok:false,status:422,data:{error:'insufficient_funds'}}},memory(),{onConfirmed:()=>confirmed++});
 await h.controller.load();assert.equal(confirmed,1);
 await h.controller.start('normal',100);
 assert.equal(confirmed,2);assert.equal(h.controller.status().game,null);assert.equal(h.controller.status().pending,false);assert.equal(h.controller.status().ready,true);assert.equal(h.store.getItem(pendingKey),null);
 assert.match(h.controller.status().notice,/списания нет|не списаны/);assert.match(h.controller.status().notice,/бесплатную практику/);assert.deepEqual(calls.map(body=>body.op),['load','start','load']);
});
test('valid ACK refreshes the wallet before stale or failed read and does not replay the accepted move',async()=>{
 for(const failure of ['stale','offline']){
  let revision=4,afterAck=false,confirmed=0;const calls=[];
  const h=harness(async body=>{calls.push(body.op);if(body.op==='load'){if(afterAck&&failure==='offline')throw Error('Read lost');return response(revision)}afterAck=true;return response(5,game(),'saved')},memory(),{onConfirmed:()=>{confirmed++;return Promise.reject(Error('Wallet offline'))}});
  await h.controller.load();await h.controller.load();assert.equal(confirmed,1);
  await h.controller.act(reveal);
  assert.equal(confirmed,2);assert.equal(h.controller.status().revision,5);assert.equal(h.controller.status().pending,false);assert.equal(h.controller.status().ready,false);assert.equal(h.store.getItem(pendingKey),null);
  afterAck=false;revision=5;await h.controller.load();assert.equal(confirmed,2);assert.equal(h.controller.status().ready,true);
  revision=6;await h.controller.load();assert.equal(confirmed,3);assert.equal(calls.filter(op=>op==='action').length,1);
 }
});
test('invalid acknowledgement never announces a wallet change',async()=>{
 for(const bad of [()=>response(2,null,'saved'),()=>response(3,game(),'saved'),()=>response(2,{...game(),id:SCOPE},'saved'),()=>response(2,game(),'ok')]){
  let confirmed=0;const h=harness(async body=>body.op==='load'?response(1):bad(),memory(),{onConfirmed:()=>confirmed++});
  await h.controller.load();await h.controller.act(reveal);
  assert.equal(confirmed,1);assert.equal(h.controller.status().pending,true);assert.equal(h.controller.status().revision,1);assert(h.store.getItem(pendingKey));
 }
});
test('account loss and destruction suppress late wallet callbacks and preserve pending actions',async()=>{
 for(const stop of ['deactivate','destroy']){
  let resolve,confirmed=0;const h=harness(body=>body.op==='load'?Promise.resolve(response(1)):new Promise(done=>resolve=done),memory(),{onConfirmed:()=>confirmed++});
  await h.controller.load();assert.equal(confirmed,1);const action=h.controller.act(reveal);await flush();const stored=h.store.getItem(pendingKey);assert(stored);
  if(stop==='destroy')h.controller.destroy();else h.deactivate();
  resolve(response(2,game(),'saved'));await action;
  assert.equal(confirmed,1);assert.equal(h.store.getItem(pendingKey),stored);assert.equal(h.controller.status().revision,1);
  let resolveLoad,lateConfirmed=0;const late=harness(()=>new Promise(done=>resolveLoad=done),memory(),{onConfirmed:()=>lateConfirmed++}),load=late.controller.load();await flush();
  if(stop==='destroy')late.controller.destroy();else late.deactivate();
  resolveLoad(response(6,null));await load;assert.equal(lateConfirmed,0);
 }
});
test('a synchronous wallet refresh failure does not block confirmed game restoration',async()=>{
 const h=harness(async()=>response(6),memory(),{onConfirmed:()=>{throw Error('Wallet unavailable')}});
 assert.equal(await h.controller.load(),true);assert.equal(h.controller.status().ready,true);assert.equal(h.controller.status().revision,6);
});

test('lost personal mark acknowledgement is replayed exactly once before reading the latest revision',async()=>{
 const store=memory(),calls=[],first=harness(async b=>{calls.push(copy(b));if(b.op==='load')return response(2);throw Error('Lost response')},store);
 await first.controller.load();await first.controller.act(reveal);const staged=store.getItem(pendingKey);assert(staged);assert.equal(first.controller.status().pending,true);await first.controller.act({type:'resign'});assert.equal(calls.filter(c=>c.op==='action').length,1);
 first.controller.destroy();const restored=[],second=harness(async b=>{restored.push(copy(b));return b.op==='load'?response(9):response(3,game(),'saved')},store);await second.controller.load();assert.deepEqual(restored,[JSON.parse(staged),{op:'load'}]);assert.equal(second.controller.status().revision,9);assert.equal(store.getItem(pendingKey),null);
});
test('changing account or tab ownership prevents late results and preserves the prior pending request',async()=>{
 let resolve;const h=harness(b=>b.op==='load'?Promise.resolve(response(1)):new Promise(r=>resolve=r));await h.controller.load();const task=h.controller.act(reveal);await flush();const stored=h.store.getItem(pendingKey),count=h.events.length;h.deactivate();resolve(response(2,game(),'saved'));await task;assert.equal(h.events.length,count);assert.equal(h.store.getItem(pendingKey),stored);assert.equal(h.controller.status().revision,1);
});
test('storage failure blocks mutation before any network action',async()=>{
 const calls=[],store=memory();store.setItem=()=>{throw Error('Quota')};const h=harness(async b=>{calls.push(copy(b));return response(1)},store);await h.controller.load();await h.controller.act(reveal);assert.deepEqual(calls.map(b=>b.op),['load']);assert.equal(h.controller.status().ready,false);
});
test('concurrent confirmation clicks submit only one night or vote decision',async()=>{
 const calls=[];let resolve;const h=harness(b=>{calls.push(copy(b));return b.op==='load'?Promise.resolve(response(calls.length>2?2:1)):new Promise(r=>resolve=r)});await h.controller.load();const first=h.controller.act(reveal);await h.controller.act(reveal);assert.equal(calls.filter(b=>b.op==='action').length,1);resolve(response(2,game(),'saved'));await first;assert.equal(h.controller.status().ready,true);
});
test('CAS conflict reloads without optimistic state or replaying the stale choice',async()=>{
 let loads=0;const calls=[],h=harness(async b=>{calls.push(copy(b));return b.op==='load'?response(++loads===1?4:7):{ok:true,status:200,data:{status:'conflict',revision:7}}});await h.controller.load();await h.controller.act(reveal);assert.equal(h.controller.status().revision,7);assert.match(h.controller.status().notice,/другом устройстве/);assert.deepEqual(calls.map(b=>b.op),['load','action','load']);assert.equal(calls[1].expectedRevision,4);assert.equal(h.store.getItem(pendingKey),null);
});
test('rejected choice clears only its own request and reads current state',async()=>{
 const h=harness(async b=>b.op==='load'?response(4):{ok:false,status:422,data:{error:'illegal_action'}});await h.controller.load();await h.controller.act(reveal);assert.equal(h.controller.status().ready,true);assert.equal(h.controller.status().pending,false);assert.match(h.controller.status().notice,/не принят/);
});
test('hidden living roles and private server internals are rejected before rendering',()=>{
 for(const mutate of [g=>g.nightTarget=1,g=>g.dayTarget=1,g=>g.lastDoctorTarget={2:1},g=>g.players[1].secret='mafia',g=>{g.players[0].role='civilian';g.players[1].role='doctor'},g=>{g.players[0].role='civilian';g.knowledge={1:'mafia'}},g=>{g.players[0].role='civilian';g.privateNotes=['secret']}]){const g=game();mutate(g);assert.throws(()=>projection(response(1,g).data));}
 assert.doesNotThrow(()=>projection(response(1).data));
});
test('malformed players, ballots, legal actions and economy fail closed',()=>{
 for(const mutate of [g=>g.players[0].name=5,g=>g.players[0].role='god',g=>g.players[1].id=4,g=>g.legal.targets=[7],g=>g.legal.actions=['deal'],g=>g.economy.payout=250,g=>g.economy.xp=130,g=>g.ballots=[{voter:0,target:0}],g=>g.round=26,g=>g.personalMarks={1:'certainty'},g=>g.voteFacts={rows:[],total:0,againstMafia:0,againstTown:0}]){const g=game();mutate(g);assert.throws(()=>projection(response(1,g).data));}
});
test('pending request replacement by another tab cannot be silently deleted',async()=>{
 let resolve;const h=harness(b=>b.op==='load'?Promise.resolve(response(1)):new Promise(r=>resolve=r));await h.controller.load();const task=h.controller.act(reveal);await flush();const replacement=JSON.stringify({op:'start',actionId:ID,expectedRevision:2,difficulty:'hard'});h.store.setItem(pendingKey,replacement);resolve(response(2,game(),'saved'));await task;assert.equal(h.store.getItem(pendingKey),replacement);assert.equal(h.controller.status().ready,false);
});
test('accepted ACK with failed read never repeats the accepted action and sets revision floor',async()=>{
 let revision=4;const calls=[],h=harness(async b=>{calls.push(copy(b));return b.op==='load'?response(revision):response(5,game(),'saved')});await h.controller.load();await h.controller.act(reveal);assert.equal(h.controller.status().revision,5);assert.equal(h.controller.status().ready,false);assert.equal(h.controller.status().pending,false);revision=7;await h.controller.load();assert.equal(h.controller.status().ready,true);assert.equal(calls.filter(b=>b.op==='action').length,1);
});
test('a malformed ACK keeps the exact mutation durable through connection loss',async()=>{
 for(const bad of [()=>response(2,null,'saved'),()=>response(3,game(),'saved'),()=>response(2,{...game(),id:SCOPE},'saved'),()=>response(2,game(),'ok')]){let mode='bad';const h=harness(async b=>{if(b.op==='load')return response(mode==='good'?2:1);if(mode==='offline')throw Error('offline');return mode==='good'?response(2,game(),'saved'):bad()});await h.controller.load();await h.controller.act(reveal);const staged=h.store.getItem(pendingKey);assert(staged);mode='offline';await h.controller.load();assert.equal(h.store.getItem(pendingKey),staged);mode='good';await h.controller.load();assert.equal(h.store.getItem(pendingKey),null);assert.equal(h.controller.status().ready,true);}
});
test('paid start cannot be acknowledged by a free game and has no client payout fields',async()=>{
 let paid=false;const h=harness(async b=>b.op==='load'?response(paid?1:0,paid?{...game(),economy:{...base.economy,stake:100}}:null):response(1,{...game(),economy:{...base.economy,stake:paid?100:0}},'saved'));await h.controller.load();await h.controller.start('hard',100);const staged=h.store.getItem(pendingKey);assert(staged);assert.deepEqual(JSON.parse(staged),{op:'start',difficulty:'hard',stake:100,actionId:ID,expectedRevision:0});paid=true;await h.controller.load();assert.equal(h.store.getItem(pendingKey),null);assert.equal(h.controller.status().ready,true);
});
test('insufficient server balance leaves no new game and allows free practice',async()=>{
 const h=harness(async b=>b.op==='load'?response(0,null):{ok:false,status:422,data:{error:'insufficient_funds'}});await h.controller.load();await h.controller.start('normal',100);assert.equal(h.controller.status().game,null);assert.equal(h.controller.status().pending,false);assert.equal(h.controller.status().ready,true);assert.match(h.controller.status().notice,/бесплатную практику/);
});
test('active party cannot be replaced, finished party starts against the lifetime revision',async()=>{
 const calls=[],h=harness(async b=>{calls.push(copy(b));return response(5)});await h.controller.load();assert.equal(await h.controller.start(),false);assert.deepEqual(calls.map(b=>b.op),['load']);
 let state=engine.createGame({id:ID},()=>.5);state=engine.applyAction(state,{type:'resign'},()=>.5);const old=engine.projectGame(state);let loads=0;const secondCalls=[],second=harness(async b=>{secondCalls.push(copy(b));return b.op==='load'?response(++loads===1?10:11,loads===1?old:game()):response(11,game(),'saved')});await second.controller.load();await second.controller.start('hard');assert.deepEqual(secondCalls[1],{op:'start',difficulty:'hard',actionId:ID,expectedRevision:10});assert.equal(second.controller.status().revision,11);
});
test('strict action envelopes reject actor injection, illegal target forms and forged payouts',()=>{
 const action={op:'action',actionId:ID,expectedRevision:1,gameId:ID};for(const a of [reveal,{type:'night',target:0},{type:'night'},{type:'vote',target:1},{type:'vote'},{type:'continue'},{type:'finish'},{type:'resign'}])assert.equal(validFlight({...action,action:a}),true);
 for(const a of [{type:'night',target:7},{type:'night',target:1,seat:1},{type:'vote',target:0},{type:'vote',target:1.5},{type:'mark',target:0,mark:'suspect'},{type:'mark',target:1,mark:'mafia'},{type:'continue',state:{}},{type:'resign',payout:250}])assert.equal(validFlight({...action,action:a}),false);
 const start={op:'start',actionId:ID,expectedRevision:0,difficulty:'normal'};assert(validFlight(start));for(const v of [99,'100',-100,100.5,null])assert.equal(validFlight({...start,stake:v}),false);assert.equal(validFlight({...start,role:'mafia'}),false);assert.equal(validFlight({...action,action:reveal,balance:1000}),false);
});
test('paid option needs a current confirmed wallet, while practice has no wallet prerequisite',()=>{
 const good={phase:'saved',ready:true,busy:false,pending:false,wallet:{balance:100}};assert(paidStartAvailability(good));for(const w of [null,{...good,busy:true},{...good,pending:true},{...good,ready:false},{...good,phase:'offline'},{...good,wallet:{balance:99}}])assert.equal(paidStartAvailability(w),false);
});
