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
function harness(request,store=memory()){let active=true;const events=[];const controller=createController({scope:SCOPE,current:()=>active,storage:store,uuid:()=>ID,request,onChange:s=>events.push(copy(s))});return {controller,store,events,deactivate:()=>active=false}}
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
test('server revisions may not move backwards after a refresh',async()=>{
 let revision=8;const h=harness(async()=>response(revision));await h.controller.load();revision=5;await h.controller.load();assert.equal(h.controller.status().revision,8);assert.equal(h.controller.status().ready,false);assert.match(h.controller.status().notice,/устаревшая/);
});
test('unremovable pending receipt is retried with the same ID without creating another move',async()=>{
 const store=memory(),normalRemove=store.removeItem;let fail=true;store.removeItem=k=>{if(fail)throw Error('Storage denied');normalRemove(k)};const calls=[],h=harness(async b=>{calls.push(copy(b));return response(b.op==='load'?3:2,game(),b.op==='load'?'ok':'saved')},store);await h.controller.load();await h.controller.act({type:'attack',cardId:'6♠'});assert.equal(h.controller.status().pending,true);fail=false;await h.controller.load();const actions=calls.filter(c=>c.op==='action');assert.equal(actions.length,2);assert.deepEqual(actions[0],actions[1]);assert.equal(h.controller.status().pending,false);
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
