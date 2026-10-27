'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('dist/server-durak.js','utf8'),ctx={window:{},document:{getElementById:()=>null},Object,JSON,Number,Set,Error,Promise};
vm.createContext(ctx);vm.runInContext(source,ctx);const {createController}=ctx.window.VEZDEHOT_SERVER_DURAK;
const ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',SCOPE='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const copy=v=>JSON.parse(JSON.stringify(v)),pendingKey='vezdehot:server-durak:pending:v1:'+SCOPE;
function memory(){const values=new Map();return {values,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}}
const card=(rank,suit='♠')=>({id:rank+suit,rank,suit,color:suit==='♥'||suit==='♦'?'red':'black'});
function game(){return {id:ID,phase:'attack',round:1,players:[{name:'Ты',hand:[card('6')],handCount:1},{name:'Бот',handCount:1}],table:[],legal:{cards:['6♠'],actions:['attack','resign']},over:false,deckCount:34,discardCount:0,attacker:0,defender:1,finished:[],journal:[]}}
const response=(revision,g=game(),status='ok')=>({ok:true,status:200,data:{status,revision,game:g}});
function harness(request,store=memory(),hooks={}){let active=true;const events=[];const controller=createController({scope:SCOPE,current:()=>active,storage:store,uuid:()=>ID,request,onChange:s=>events.push(copy(s)),...hooks});return {controller,store,events,deactivate:()=>active=false}}
const flush=()=>new Promise(r=>setImmediate(r));

test('lost acknowledgement persists the exact request, blocks fresh actions and replays before loading the latest table',async()=>{
 const store=memory(),calls=[];let applied=false;
 const one=harness(async b=>{calls.push(copy(b));if(b.op==='load')return response(2);applied=true;throw Error('Lost response')},store);
 await one.controller.load();await one.controller.act({type:'attack',cardId:'6♠'});assert(applied);const staged=store.getItem(pendingKey);assert(staged);assert.equal(one.controller.status().pending,true);await one.controller.act({type:'resign'});assert.equal(calls.filter(c=>c.op==='action').length,1);
 one.controller.destroy();const restored=[];const two=harness(async b=>{restored.push(copy(b));return b.op==='load'?response(9):response(3,game(),'saved')},store);
 await two.controller.load();assert.deepEqual(restored[0],JSON.parse(staged));assert.equal(restored[1].op,'load');assert.equal(two.controller.status().revision,9);assert.equal(store.getItem(pendingKey),null);assert.equal(two.controller.status().ready,true);
});
test('account or tab ownership changing in flight cannot install a late response or delete the former account request',async()=>{
 let resolve;const h=harness(b=>b.op==='load'?Promise.resolve(response(1)):new Promise(r=>resolve=r));await h.controller.load();const task=h.controller.act({type:'attack',cardId:'6♠'});await flush();const stored=h.store.getItem(pendingKey),before=h.events.length;h.deactivate();resolve(response(2,game(),'saved'));await task;assert.equal(h.events.length,before);assert.equal(h.store.getItem(pendingKey),stored);assert.equal(h.controller.status().revision,1);
});
test('durable staging failure never sends a mutation to the server',async()=>{
 const calls=[],store=memory();store.setItem=()=>{throw Error('Quota')};const h=harness(async b=>{calls.push(copy(b));return response(1)},store);await h.controller.load();await h.controller.act({type:'resign'});assert.deepEqual(calls.map(c=>c.op),['load']);assert.equal(h.controller.status().ready,false);
});
test('concurrent clicks submit only one mutation',async()=>{
 const calls=[];let resolve;const h=harness(b=>{calls.push(copy(b));return b.op==='load'?Promise.resolve(response(calls.length>2?2:1)):new Promise(r=>resolve=r)});await h.controller.load();const first=h.controller.act({type:'attack',cardId:'6♠'});await h.controller.act({type:'resign'});assert.equal(calls.filter(c=>c.op==='action').length,1);resolve(response(2,game(),'saved'));await first;assert.equal(h.controller.status().ready,true);
});
test('conflict reloads the remote table without an optimistic card change or second action',async()=>{
 let count=0;const calls=[],h=harness(async b=>{calls.push(copy(b));if(b.op==='load')return response(++count===1?4:7);return {ok:true,status:200,data:{status:'conflict',revision:7}}});await h.controller.load();await h.controller.act({type:'attack',cardId:'6♠'});assert.equal(h.controller.status().revision,7);assert.match(h.controller.status().notice,/другом устройстве/);assert.deepEqual(calls.map(c=>c.op),['load','action','load']);assert.equal(calls[1].expectedRevision,4);assert.equal(h.store.getItem(pendingKey),null);
});
test('a rejected illegal action clears its receipt attempt then reloads server state',async()=>{
 const h=harness(async b=>b.op==='load'?response(4):{ok:false,status:422,data:{error:'illegal_card'}});await h.controller.load();await h.controller.act({type:'attack',cardId:'9♦'});assert.equal(h.controller.status().ready,true);assert.equal(h.controller.status().pending,false);assert.match(h.controller.status().notice,/не принят/);
});
test('a projection containing hidden bot cards fails closed',async()=>{
 const g=game();g.players[1].hand=[card('A')];const h=harness(async()=>response(1,g));await h.controller.load();assert.equal(h.controller.status().ready,false);assert.equal(h.controller.status().game,null);
});
test('public round limits accept old receipts and valid limits but reject malformed or exceeded limits',async()=>{
 const {projection}=ctx.window.VEZDEHOT_SERVER_DURAK;
 for(const fields of [{},{roundLimit:null},...[1,2,3,4,5,6].map(roundLimit=>({roundLimit}))])assert.doesNotThrow(()=>projection(response(1,{...game(),...fields}).data));
 for(const roundLimit of [0,7,-1,1.5,'1',true,{}]){const h=harness(async()=>response(1,{...game(),roundLimit}));await h.controller.load();assert.equal(h.controller.status().ready,false);assert.equal(h.controller.status().game,null);assert.match(h.controller.status().notice,/Лимит захода/);}
 const g={...game(),roundLimit:1,table:[{a:card('7'),d:card('8')},{a:card('9'),d:card('10')}]};assert.throws(()=>projection(response(1,g).data),/Лимит захода/);
});
test('server revisions may not move backwards after a refresh',async()=>{
 let revision=8;const h=harness(async()=>response(revision));await h.controller.load();revision=5;await h.controller.load();assert.equal(h.controller.status().revision,8);assert.equal(h.controller.status().ready,false);assert.match(h.controller.status().notice,/устаревшая/);
});
test('unremovable pending receipt is retried with the same ID without creating another move',async()=>{
 const store=memory(),normalRemove=store.removeItem;let fail=true,loads=0;store.removeItem=k=>{if(fail)throw Error('Storage denied');normalRemove(k)};const calls=[],h=harness(async b=>{calls.push(copy(b));return response(b.op==='load'&&++loads===1?3:4,game(),b.op==='load'?'ok':'saved')},store);await h.controller.load();await h.controller.act({type:'attack',cardId:'6♠'});assert.equal(h.controller.status().pending,true);fail=false;await h.controller.load();const actions=calls.filter(c=>c.op==='action');assert.equal(actions.length,2);assert.deepEqual(actions[0],actions[1]);assert.equal(h.controller.status().pending,false);
});
test('damaged persistent action is never sent, including repeated retries',async()=>{
 const store=memory(),calls=[];store.setItem(pendingKey,JSON.stringify({op:'action',actionId:'wrong'}));const h=harness(async b=>{calls.push(b);return response(1)},store);await h.controller.load();await h.controller.load();assert.equal(calls.length,0);assert.equal(h.controller.status().ready,false);
});
test('a finished server table may open a new free table with the account lifetime revision',async()=>{
 const g=game();g.over=true;g.phase='over';g.legal={cards:[],actions:[]};let count=0;const calls=[],h=harness(async b=>{calls.push(copy(b));return b.op==='load'?response(++count===1?10:11,count===1?g:game()):response(11,game(),'saved')});await h.controller.load();await h.controller.start(2,'hard');assert.deepEqual(calls[1],{op:'start',bots:2,difficulty:'hard',actionId:ID,expectedRevision:10});assert.equal(h.controller.status().revision,11);
});
test('readonly ownership cannot load, start or mutate a server table',async()=>{
 const calls=[],h=harness(async b=>{calls.push(b);return response(1)});h.deactivate();await h.controller.load();await h.controller.start();await h.controller.act({type:'resign'});assert.equal(calls.length,0);
});

test('a load-shaped mutation acknowledgement keeps the exact durable move for retry',async()=>{
 const calls=[];let receipt=false;const h=harness(async b=>{calls.push(copy(b));if(b.op==='load')return response(receipt?5:4);return response(5,game(),receipt?'saved':'ok')});
 await h.controller.load();await h.controller.act({type:'attack',cardId:'6♠'});
 const staged=h.store.getItem(pendingKey);assert(staged);assert.equal(h.controller.status().pending,true);assert.equal(h.controller.status().ready,false);assert.match(h.controller.status().notice,/Подтверждение хода неполное/);assert.deepEqual(calls.map(b=>b.op),['load','action']);
 receipt=true;await h.controller.load();assert.deepEqual(calls[2],JSON.parse(staged));assert.equal(calls[3].op,'load');assert.equal(h.controller.status().pending,false);assert.equal(h.controller.status().revision,5);
});
test('card intent uses exactly one currently legal server action and checks card ownership',()=>{
 const {cardAction}=ctx.window.VEZDEHOT_SERVER_DURAK,state={ready:true,busy:false,pending:false,game:game()};
 assert.deepEqual(copy(cardAction(state,'6♠')),{type:'attack',cardId:'6♠'});
 assert.equal(cardAction(state,'A♥'),null);
 state.game.legal.cards.push('A♥');assert.equal(cardAction(state,'A♥'),null);
 state.game.legal.actions=['defend','take'];assert.deepEqual(copy(cardAction(state,'6♠')),{type:'defend',cardId:'6♠'});
 state.game.legal.actions=['attack','defend'];assert.equal(cardAction(state,'6♠'),null);
 state.game.legal.actions=['continue'];assert.equal(cardAction(state,'6♠'),null);
});
test('card intent cannot play while loading, awaiting a receipt or after a table finishes',()=>{
 const {cardAction}=ctx.window.VEZDEHOT_SERVER_DURAK,base={ready:true,busy:false,pending:false,game:game()};
 for(const change of [{ready:false},{busy:true},{pending:true},{game:null},{game:{...game(),over:true}}])assert.equal(cardAction({...base,...change},'6♠'),null);
 const fresh=game();fresh.legal.cards=[];assert.equal(cardAction({...base,game:fresh},'6♠'),null);
});
test('a malformed revealed trump cannot replace the current server table',async()=>{
 const g=game();g.trump='♠';g.trumpCard=card('A','♥');const h=harness(async()=>response(1,g));await h.controller.load();assert.equal(h.controller.status().ready,false);assert.equal(h.controller.status().game,null);
});
for(const [label,bad] of [
 ['missing game',()=>response(5,null,'saved')],
 ['old revision',()=>response(4,game(),'saved')],
 ['unrelated newer revision',()=>response(8,game(),'saved')],
 ['different table',()=>response(5,{...game(),id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'},'saved')]
])test('saved ACK with '+label+' keeps the durable action through retry and connection loss',async()=>{
 let mode='bad';const calls=[],latest={...game(),id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'};
 const h=harness(async b=>{calls.push(copy(b));if(b.op==='load')return response(mode==='good'?9:4,mode==='good'?latest:game());if(mode==='offline')throw Error('Disconnected');return mode==='good'?response(5,game(),'saved'):bad()});
 await h.controller.load();await h.controller.act({type:'attack',cardId:'6♠'});
 const staged=h.store.getItem(pendingKey);assert(staged);assert.equal(h.controller.status().pending,true);assert.equal(h.controller.status().ready,false);assert.equal(h.controller.status().revision,4);assert.deepEqual(calls.map(b=>b.op),['load','action']);
 mode='offline';await h.controller.load();assert.equal(h.store.getItem(pendingKey),staged);assert.equal(h.controller.status().pending,true);
 mode='good';await h.controller.load();assert.equal(h.store.getItem(pendingKey),null);assert.equal(h.controller.status().revision,9);assert.equal(h.controller.status().game.id,latest.id);assert.equal(h.controller.status().ready,true);
 assert.deepEqual(calls.filter(b=>b.op==='action'),Array.from({length:3},()=>JSON.parse(staged)));
});
test('a start ACK requires a game and accepts its newly allocated ID on the same durable retry',async()=>{
 let valid=false;const calls=[],created={...game(),id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'};
 const h=harness(async b=>{calls.push(copy(b));return b.op==='load'?response(valid?1:0,valid?created:null):response(1,valid?created:null,'saved')});
 await h.controller.load();await h.controller.start(3,'hard');const staged=h.store.getItem(pendingKey);assert(staged);assert.equal(h.controller.status().pending,true);assert.equal(h.controller.status().game,null);
 valid=true;await h.controller.load();assert.equal(h.controller.status().game.id,created.id);assert.equal(h.controller.status().ready,true);assert.equal(h.controller.status().pending,false);assert.deepEqual(calls.filter(b=>b.op==='start'),[JSON.parse(staged),JSON.parse(staged)]);
});
test('a stale read after an accepted ACK cannot reopen pre-action cards or replay the accepted move',async()=>{
 let revision=4;const calls=[],h=harness(async b=>{calls.push(copy(b));return b.op==='load'?response(revision):response(5,game(),'saved')});
 await h.controller.load();await h.controller.act({type:'attack',cardId:'6♠'});assert.equal(h.controller.status().revision,5);assert.equal(h.controller.status().ready,false);assert.equal(h.controller.status().pending,false);assert.match(h.controller.status().notice,/устаревшая/);
 revision=7;await h.controller.load();assert.equal(h.controller.status().ready,true);assert.equal(h.controller.status().revision,7);assert.equal(calls.filter(b=>b.op==='action').length,1);
});

const economy=(stake=100,settled=false,outcome=null)=>({version:1,stake,settled,payout:0,xp:0,outcome});
test('paid start retains the identical entry and action ID after a lost acknowledgement and page reload',async()=>{
 const store=memory(),calls=[],created={...game(),economy:economy()};let applied=false;
 const first=harness(async b=>{calls.push(copy(b));if(b.op==='load')return response(0,null);applied=true;throw Error('Lost ACK')},store);
 await first.controller.load();await first.controller.start(3,'hard',100);assert(applied);const staged=JSON.parse(store.getItem(pendingKey));assert.deepEqual(staged,{op:'start',bots:3,difficulty:'hard',stake:100,actionId:ID,expectedRevision:0});
 await first.controller.start(3,'hard',100);assert.equal(calls.filter(b=>b.op==='start').length,1);first.controller.destroy();
 const retry=[];const second=harness(async b=>{retry.push(copy(b));return response(1,created,b.op==='load'?'ok':'saved')},store);await second.controller.load();assert.deepEqual(retry,[staged,{op:'load'}]);assert.equal(second.controller.status().game.economy.stake,100);assert.equal(second.controller.status().pending,false);
});
test('only the supported optional entry survives durable-flight validation',()=>{
 const {validFlight}=ctx.window.VEZDEHOT_SERVER_DURAK,legacy={op:'start',bots:1,difficulty:'normal',actionId:ID,expectedRevision:0};
 assert(validFlight(legacy));for(const stake of [0,100])assert(validFlight({...legacy,stake}));for(const stake of [-100,1,200,'100',null,undefined])assert.equal(validFlight({...legacy,stake}),false);assert.equal(validFlight({...legacy,reward:1000}),false);
});
test('invalid paid entry never stages or sends a start, while explicit free entry keeps the legacy request',async()=>{
 const calls=[],h=harness(async b=>{calls.push(copy(b));return response(b.op==='load'?0:1,b.op==='load'?null:game(),b.op==='load'?'ok':'saved')});await h.controller.load();
 for(const stake of [-1,200,'100',null])assert.equal(await h.controller.start(1,'normal',stake),false);assert.deepEqual(calls,[{op:'load'}]);assert.equal(h.store.getItem(pendingKey),null);
 await h.controller.start(1,'normal',0);assert(!Object.hasOwn(calls[1],'stake'));
});
test('optional economy projection accepts legacy and complete server fields and rejects malformed calculations',()=>{
 const {projection}=ctx.window.VEZDEHOT_SERVER_DURAK;assert.doesNotThrow(()=>projection(response(1).data));assert.doesNotThrow(()=>projection(response(1,{...game(),economy:economy()}).data));
 const done={...game(),over:true,phase:'over',legal:{cards:[],actions:[]}};assert.doesNotThrow(()=>projection(response(2,{...done,economy:economy(0,true,'loss')}).data));
 for(const change of [{version:2},{stake:50},{payout:-1},{xp:81},{payout:100},{outcome:'win'},{settled:true},{extra:'ignored'}])assert.throws(()=>projection(response(1,{...game(),economy:{...economy(),...change}}).data));
 const missing=economy();delete missing.xp;assert.throws(()=>projection(response(1,{...game(),economy:missing}).data));assert.throws(()=>projection(response(2,{...done,economy:{...economy(0,true,'win'),xp:80}}).data));
});
test('insufficient funds clears the rejected entry, reports no charge and refreshes the same-revision wallet',async()=>{
 const calls=[];let confirmed=0;const h=harness(async b=>{calls.push(copy(b));return b.op==='load'?response(6,null):{ok:false,status:422,data:{error:'insufficient_funds'}}},memory(),{onConfirmed:()=>confirmed++});
 await h.controller.load();assert.equal(confirmed,1);await h.controller.start(2,'hard',100);assert.equal(confirmed,2);assert.equal(h.controller.status().pending,false);assert.equal(h.controller.status().ready,true);assert.equal(h.store.getItem(pendingKey),null);assert.match(h.controller.status().notice,/Недостаточно серверных монет/);assert.match(h.controller.status().notice,/не списаны/);assert.deepEqual(calls.map(b=>b.op),['load','start','load']);
});
test('wallet refresh follows confirmed revision changes once, including ACK followed by a stale load',async()=>{
 let revision=4,confirmed=0;const h=harness(async b=>response(b.op==='load'?revision:5,game(),b.op==='load'?'ok':'saved'),memory(),{onConfirmed:()=>{confirmed++;return Promise.reject(Error('Wallet offline'))}});
 await h.controller.load();await h.controller.load();assert.equal(confirmed,1);await h.controller.act({type:'attack',cardId:'6♠'});assert.equal(confirmed,2);assert.equal(h.controller.status().pending,false);assert.equal(h.controller.status().ready,false);revision=5;await h.controller.load();assert.equal(confirmed,2);assert.equal(h.controller.status().ready,true);revision=6;await h.controller.load();assert.equal(confirmed,3);
});
test('invalid acknowledgement never announces a confirmed wallet change',async()=>{
 let confirmed=0;const h=harness(async b=>response(b.op==='load'?1:9,game(),b.op==='load'?'ok':'saved'),memory(),{onConfirmed:()=>confirmed++});await h.controller.load();await h.controller.act({type:'resign'});assert.equal(confirmed,1);assert.equal(h.controller.status().pending,true);
});
for(const [label,badEconomy] of [['missing economy',undefined],['free economy',economy(0)]])test('paid start ACK with '+label+' keeps the entry pending until the same request confirms its stake',async()=>{
 let valid=false,confirmed=0;const calls=[],paid={...game(),economy:economy()},bad={...game(),...(badEconomy?{economy:badEconomy}:{})};
 const h=harness(async b=>{calls.push(copy(b));return b.op==='load'?response(valid?1:0,valid?paid:null):response(1,valid?paid:bad,'saved')},memory(),{onConfirmed:()=>confirmed++});
 await h.controller.load();await h.controller.start(2,'hard',100);const staged=h.store.getItem(pendingKey);assert(staged);assert.equal(h.controller.status().pending,true);assert.equal(h.controller.status().game,null);assert.equal(h.controller.status().revision,0);assert.equal(confirmed,1);assert.match(h.controller.status().notice,/не подтвердил вход 100 V/);
 valid=true;await h.controller.load();assert.deepEqual(calls.filter(b=>b.op==='start'),[JSON.parse(staged),JSON.parse(staged)]);assert.equal(h.controller.status().pending,false);assert.equal(h.controller.status().game.economy.stake,100);assert.equal(confirmed,2);
});

test('a verified ACK recovers after request removal succeeds but its verification read fails once',async()=>{
 for(const operation of ['start','action']){
  const store=memory(),read=store.getItem,remove=store.removeItem,calls=[];let failRead=false,failed=false,accepted=false;
  store.removeItem=key=>{remove(key);if(!failed)failRead=true};
  store.getItem=key=>{if(failRead){failRead=false;failed=true;throw Error('Transient storage read failure')}return read(key)};
  const h=harness(async body=>{calls.push(copy(body));if(body.op==='load')return response(accepted?7:4,accepted||operation==='action'?game():null);accepted=true;return response(5,game(),'saved')},store);
  await h.controller.load();await (operation==='start'?h.controller.start():h.controller.act({type:'attack',cardId:'6♠'}));
  assert.equal(failed,true);assert.equal(store.getItem(pendingKey),null);assert.equal(h.controller.status().pending,true);assert.equal(h.controller.status().ready,false);
  const sent=calls.find(body=>body.op===operation),count=calls.length;assert(sent);assert.equal(await h.controller.act({type:'attack',cardId:'6♠'}),false);assert.equal(await h.controller.start(),false);assert.equal(calls.length,count);
  assert.equal(await h.controller.load(),true);
  assert.deepEqual(calls.filter(body=>body.op===operation),[sent,sent]);assert.equal(sent.actionId,ID);assert.equal(sent.expectedRevision,4);assert.deepEqual(calls.map(body=>body.op),['load',operation,operation,'load']);
  assert.equal(h.controller.status().revision,7);assert.equal(h.controller.status().ready,true);assert.equal(h.controller.status().pending,false);assert.equal(store.getItem(pendingKey),null);
 }
});
test('a different pending request is preserved if it appears after a partial-clear failure',async()=>{
 const store=memory(),read=store.getItem,remove=store.removeItem,calls=[];let failRead=false,failed=false;
 store.removeItem=key=>{remove(key);if(!failed)failRead=true};
 store.getItem=key=>{if(failRead){failRead=false;failed=true;throw Error('Transient storage read failure')}return read(key)};
 const h=harness(async body=>{calls.push(copy(body));return body.op==='load'?response(4):response(5,game(),'saved')},store);
 await h.controller.load();await h.controller.act({type:'attack',cardId:'6♠'});assert.equal(failed,true);assert.equal(store.getItem(pendingKey),null);
 const replacement=JSON.stringify({op:'start',actionId:SCOPE,expectedRevision:7,difficulty:'hard'});
 store.setItem(pendingKey,replacement);assert.equal(await h.controller.load(),false);
 assert.equal(store.getItem(pendingKey),replacement);assert.equal(h.controller.status().pending,true);assert.equal(h.controller.status().ready,false);assert.equal(h.controller.status().revision,4);
 assert.deepEqual(calls.map(body=>body.op),['load','action','action']);assert.deepEqual(calls[2],calls[1]);assert.equal(await h.controller.act({type:'attack',cardId:'6♠'}),false);assert.equal(calls.length,3);
});
test('ownership loss during a partial-clear retry never clears missing, replaced or restored storage',async()=>{
 for(const stored of ['missing','replacement','original']){
  const store=memory(),read=store.getItem,remove=store.removeItem,calls=[];let failRead=false,failed=false,removeCount=0,sends=0,resolve,confirmed=0;
  store.removeItem=key=>{removeCount++;remove(key);if(!failed)failRead=true};
  store.getItem=key=>{if(failRead){failRead=false;failed=true;throw Error('Transient storage read failure')}return read(key)};
  const h=harness(body=>{calls.push(copy(body));if(body.op==='load')return Promise.resolve(response(4));if(++sends===1)return Promise.resolve(response(5,game(),'saved'));return new Promise(done=>resolve=done)},store,{onConfirmed:()=>confirmed++});
  await h.controller.load();await h.controller.act({type:'attack',cardId:'6♠'});assert.equal(store.getItem(pendingKey),null);assert.equal(removeCount,1);
  const before=stored==='missing'?null:stored==='original'?JSON.stringify(calls[1]):JSON.stringify({op:'start',actionId:SCOPE,expectedRevision:7,difficulty:'hard'});
  if(before!==null)store.setItem(pendingKey,before);
  const retry=h.controller.load();await flush();h.deactivate();resolve(response(5,game(),'saved'));await retry;
  assert.equal(store.getItem(pendingKey),before);assert.equal(removeCount,1);assert.equal(confirmed,1);assert.equal(h.controller.status().pending,true);assert.equal(h.controller.status().revision,4);assert.deepEqual(calls.map(body=>body.op),['load','action','action']);assert.deepEqual(calls[2],calls[1]);
 }
});
