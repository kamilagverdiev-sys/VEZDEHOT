'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('dist/server-poker.js','utf8'),ctx={window:{},document:{getElementById:()=>null},Object,JSON,Number,Set,Error,Promise};
vm.createContext(ctx);vm.runInContext(source,ctx);const {createController,projection,validFlight,equityInput,economyOf,paidStartAvailability}=ctx.window.VEZDEHOT_SERVER_POKER;
const ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',SCOPE='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const copy=v=>JSON.parse(JSON.stringify(v)),pendingKey='vezdehot:server-poker:pending:v1:'+SCOPE;
function memory(){const values=new Map();return {values,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}}
const card=(rank,suit='♠')=>({id:rank+suit,rank,suit,color:suit==='♥'||suit==='♦'?'red':'black'});
function game(){return {id:ID,handId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',phase:'betting',stage:'preflop',handNumber:1,over:false,handOver:false,tableClosed:false,showdown:false,button:0,smallBlind:1,bigBlind:2,toAct:0,pot:60,paidPot:0,handProfit:0,players:[{name:'Ты',hand:[card('6'),card('K','♥')],handCount:2,chips:1000,roundBet:0,totalBet:0,folded:false,sittingOut:false},...['Лаки','Вегас','Даша'].map((name,i)=>({name,handCount:2,chips:1000-(i===0?20:i===1?40:0),roundBet:i===0?20:i===1?40:0,totalBet:i===0?20:i===1?40:0,folded:false,sittingOut:false}))],community:[],legal:{actions:['fold','call','raise','close'],callAmount:40,owed:40,minimum:80,maximum:1000},prizes:[],pots:[],history:[],tableHistory:[]}}
const response=(revision,g=game(),status='ok')=>({ok:true,status:200,data:{status,revision,game:g}});
function harness(request,store=memory()){let active=true;const events=[];const controller=createController({scope:SCOPE,current:()=>active,storage:store,uuid:()=>ID,request,onChange:s=>events.push(copy(s))});return {controller,store,events,deactivate:()=>active=false}}
const flush=()=>new Promise(r=>setImmediate(r));

test('lost acknowledgement persists the exact request, blocks fresh actions and replays before loading the latest table',async()=>{
 const store=memory(),calls=[];let applied=false;
 const one=harness(async b=>{calls.push(copy(b));if(b.op==='load')return response(2);applied=true;throw Error('Lost response')},store);
 await one.controller.load();await one.controller.act({type:'call'});assert(applied);const staged=store.getItem(pendingKey);assert(staged);assert.equal(one.controller.status().pending,true);await one.controller.act({type:'close'});assert.equal(calls.filter(c=>c.op==='action').length,1);
 one.controller.destroy();const restored=[];const two=harness(async b=>{restored.push(copy(b));return b.op==='load'?response(9):response(3,game(),'saved')},store);
 await two.controller.load();assert.deepEqual(restored[0],JSON.parse(staged));assert.equal(restored[1].op,'load');assert.equal(two.controller.status().revision,9);assert.equal(store.getItem(pendingKey),null);assert.equal(two.controller.status().ready,true);
});
test('account or tab ownership changing in flight cannot install a late response or delete the former account request',async()=>{
 let resolve;const h=harness(b=>b.op==='load'?Promise.resolve(response(1)):new Promise(r=>resolve=r));await h.controller.load();const task=h.controller.act({type:'call'});await flush();const stored=h.store.getItem(pendingKey),before=h.events.length;h.deactivate();resolve(response(2,game(),'saved'));await task;assert.equal(h.events.length,before);assert.equal(h.store.getItem(pendingKey),stored);assert.equal(h.controller.status().revision,1);
});
test('durable staging failure never sends a mutation to the server',async()=>{
 const calls=[],store=memory();store.setItem=()=>{throw Error('Quota')};const h=harness(async b=>{calls.push(copy(b));return response(1)},store);await h.controller.load();await h.controller.act({type:'close'});assert.deepEqual(calls.map(c=>c.op),['load']);assert.equal(h.controller.status().ready,false);
});
test('concurrent clicks submit only one mutation',async()=>{
 const calls=[];let resolve;const h=harness(b=>{calls.push(copy(b));return b.op==='load'?Promise.resolve(response(calls.length>2?2:1)):new Promise(r=>resolve=r)});await h.controller.load();const first=h.controller.act({type:'call'});await h.controller.act({type:'close'});assert.equal(calls.filter(c=>c.op==='action').length,1);resolve(response(2,game(),'saved'));await first;assert.equal(h.controller.status().ready,true);
});
test('conflict reloads the remote table without an optimistic card change or second action',async()=>{
 let count=0;const calls=[],h=harness(async b=>{calls.push(copy(b));if(b.op==='load')return response(++count===1?4:7);return {ok:true,status:200,data:{status:'conflict',revision:7}}});await h.controller.load();await h.controller.act({type:'call'});assert.equal(h.controller.status().revision,7);assert.match(h.controller.status().notice,/другом устройстве/);assert.deepEqual(calls.map(c=>c.op),['load','action','load']);assert.equal(calls[1].expectedRevision,4);assert.equal(h.store.getItem(pendingKey),null);
});
test('a rejected illegal action clears its receipt attempt then reloads server state',async()=>{
 const h=harness(async b=>b.op==='load'?response(4):{ok:false,status:422,data:{error:'illegal_card'}});await h.controller.load();await h.controller.act({type:'raise',amount:79});assert.equal(h.controller.status().ready,true);assert.equal(h.controller.status().pending,false);assert.match(h.controller.status().notice,/не принят/);
});
test('a projection containing hidden bot cards fails closed',async()=>{
 const g=game();g.players[1].hand=[card('A')];const h=harness(async()=>response(1,g));await h.controller.load();assert.equal(h.controller.status().ready,false);assert.equal(h.controller.status().game,null);
});
test('server revisions may not move backwards after a refresh',async()=>{
 let revision=8;const h=harness(async()=>response(revision));await h.controller.load();revision=5;await h.controller.load();assert.equal(h.controller.status().revision,8);assert.equal(h.controller.status().ready,false);assert.match(h.controller.status().notice,/устаревшая/);
});
test('unremovable pending receipt is retried with the same ID without creating another move',async()=>{
 const store=memory(),normalRemove=store.removeItem;let fail=true,loads=0;store.removeItem=k=>{if(fail)throw Error('Storage denied');normalRemove(k)};const calls=[],h=harness(async b=>{calls.push(copy(b));return response(b.op==='load'&&++loads===1?3:4,game(),b.op==='load'?'ok':'saved')},store);await h.controller.load();await h.controller.act({type:'call'});assert.equal(h.controller.status().pending,true);fail=false;await h.controller.load();const actions=calls.filter(c=>c.op==='action');assert.equal(actions.length,2);assert.deepEqual(actions[0],actions[1]);assert.equal(h.controller.status().pending,false);
});
test('damaged persistent action is never sent, including repeated retries',async()=>{
 const store=memory(),calls=[];store.setItem(pendingKey,JSON.stringify({op:'action',actionId:'wrong'}));const h=harness(async b=>{calls.push(b);return response(1)},store);await h.controller.load();await h.controller.load();assert.equal(calls.length,0);assert.equal(h.controller.status().ready,false);
});
test('a finished server table may open a new free table with the account lifetime revision',async()=>{
 const g=game();g.over=true;g.tableClosed=true;g.phase='over';g.legal={actions:[],callAmount:0,owed:0,minimum:0,maximum:0};let count=0;const calls=[],h=harness(async b=>{calls.push(copy(b));return b.op==='load'?response(++count===1?10:11,count===1?g:game()):response(11,game(),'saved')});await h.controller.load();await h.controller.start('hard');assert.deepEqual(calls[1],{op:'start',difficulty:'hard',actionId:ID,expectedRevision:10});assert.equal(h.controller.status().revision,11);
});
test('readonly ownership cannot load, start or mutate a server table',async()=>{
 const calls=[],h=harness(async b=>{calls.push(b);return response(1)});h.deactivate();await h.controller.load();await h.controller.start();await h.controller.act({type:'close'});assert.equal(calls.length,0);
});
test('a completed hand continues the same table instead of requiring a new table',async()=>{
 const g=game();g.handOver=true;g.phase='over';g.toAct=-1;g.legal={actions:['nextHand','close'],callAmount:0,owed:0,minimum:0,maximum:0};let count=0;
 const calls=[],h=harness(async b=>{calls.push(copy(b));return b.op==='load'?response(++count===1?10:11,count===1?g:game()):response(11,game(),'saved')});await h.controller.load();
 assert.equal(await h.controller.start('hard'),false);await h.controller.act({type:'nextHand'});assert.deepEqual(calls.map(c=>c.op),['load','action','load']);assert.equal(calls[1].action.type,'nextHand');assert.equal(calls[1].gameId,g.id);assert.equal(h.controller.status().ready,true);
});
test('folded opponents remain private at showdown; exposed nonfolded hands are accepted',()=>{
 const g=game();g.handOver=true;g.phase='over';g.toAct=-1;g.showdown=true;g.stage='river';g.community=[card('2'),card('3'),card('4'),card('5'),card('7')];g.players[1].hand=[card('Q','♦'),card('Q','♣')];
 assert.equal(projection(response(5,g).data).game,g);g.players[1].folded=true;assert.throws(()=>projection(response(5,g).data));delete g.players[1].hand;assert.doesNotThrow(()=>projection(response(5,g).data));
});
test('deck, burns, duplicates and malformed card counts fail closed',()=>{
 for(const mutate of [g=>g.deck=[],g=>g.burn=[],g=>g.players[0].hand[1]=g.players[0].hand[0],g=>g.players[0].handCount=1,g=>g.community=[card('5')],g=>g.legal.actions.push('reveal')]){const g=game();mutate(g);assert.throws(()=>projection(response(1,g).data));}
});
test('public equity inputs cannot include bot hands, deck, burns, stakes or server internals',()=>{
 const g=game();g.players[1].hand=[card('A'),card('K')];g.deck=[card('2')];g.burn=[card('3')];const input=copy(equityInput(g));assert.deepEqual(input,{hand:['6♠','K♥'],board:[],opponents:3});g.players[2].folded=true;assert.equal(equityInput(g).opponents,2);g.handOver=true;assert.equal(equityInput(g),null);g.handOver=false;g.players[0].folded=true;assert.equal(equityInput(g),null);
});
test('saved mutation format rejects foreign payloads and nonintegral raises before replay',()=>{
 const base={op:'action',gameId:ID,actionId:ID,expectedRevision:3};
 assert(validFlight({...base,action:{type:'raise',amount:1000}}));
 for(const action of [{type:'raise',amount:1.5},{type:'raise',amount:Infinity},{type:'call',amount:40},{type:'raise',amount:4001},{type:'attack',cardId:'A♠'}])assert.equal(validFlight({...base,action}),false);
 assert.equal(validFlight({...base,action:{type:'call'},state:game()}),false);
});
test('a pending request replaced by another tab cannot be silently cleared',async()=>{
 const store=memory();let resolve;const h=harness(b=>b.op==='load'?Promise.resolve(response(1)):new Promise(r=>resolve=r),store);await h.controller.load();const operation=h.controller.act({type:'call'});await flush();const replacement=JSON.stringify({op:'start',actionId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',expectedRevision:2,difficulty:'hard'});store.setItem(pendingKey,replacement);resolve(response(2,game(),'saved'));await operation;assert.equal(store.getItem(pendingKey),replacement);assert.equal(h.controller.status().ready,false);
});
test('a failed refresh after an acknowledged action never replays that accepted action',async()=>{
 let loads=0;const calls=[],h=harness(async b=>{calls.push(copy(b));if(b.op==='action')return response(2,game(),'saved');loads++;if(loads===2)throw Error('Disconnected');return response(loads===1?1:2)});await h.controller.load();await h.controller.act({type:'call'});assert.equal(h.controller.status().ready,false);assert.equal(h.controller.status().pending,false);await h.controller.load();assert.equal(calls.filter(b=>b.op==='action').length,1);assert.equal(h.controller.status().ready,true);
});
test('a bot combination cannot leak cards before showdown and malformed history is rejected',()=>{
 const g=game();g.players[1].combination={name:'Пара',category:1,cards:[],parts:[]};assert.throws(()=>projection(response(2,g).data));delete g.players[1].combination;g.tableHistory=[{number:1,net:0,pot:100,winners:'wrong'}];assert.throws(()=>projection(response(2,g).data));
});
test('an invalid local action is never persisted or sent',async()=>{
 const calls=[],h=harness(async b=>{calls.push(copy(b));return response(1)});await h.controller.load();await h.controller.act({type:'raise',amount:1.5});assert.deepEqual(calls.map(b=>b.op),['load']);assert.equal(h.store.getItem(pendingKey),null);await h.controller.load();assert.equal(h.controller.status().ready,true);
});
test('an unrecognized mutation acknowledgement keeps the exact pending request for retry',async()=>{
 const h=harness(async b=>response(b.op==='load'?1:2,game(),'ok'));await h.controller.load();await h.controller.act({type:'call'});assert.equal(h.controller.status().pending,true);assert.equal(h.controller.status().ready,false);assert(h.store.getItem(pendingKey));
});
for(const [label,bad] of [
 ['missing game',()=>response(5,null,'saved')],
 ['old revision',()=>response(4,game(),'saved')],
 ['unrelated newer revision',()=>response(8,game(),'saved')],
 ['different table',()=>response(5,{...game(),id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'},'saved')]
])test('saved ACK with '+label+' keeps the durable action through retry and connection loss',async()=>{
 let mode='bad';const calls=[],latest={...game(),id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'};
 const h=harness(async b=>{calls.push(copy(b));if(b.op==='load')return response(mode==='good'?9:4,mode==='good'?latest:game());if(mode==='offline')throw Error('Disconnected');return mode==='good'?response(5,game(),'saved'):bad()});
 await h.controller.load();await h.controller.act({type:'call'});
 const staged=h.store.getItem(pendingKey);assert(staged);assert.equal(h.controller.status().pending,true);assert.equal(h.controller.status().ready,false);assert.equal(h.controller.status().revision,4);assert.deepEqual(calls.map(b=>b.op),['load','action']);
 mode='offline';await h.controller.load();assert.equal(h.store.getItem(pendingKey),staged);assert.equal(h.controller.status().pending,true);
 mode='good';await h.controller.load();assert.equal(h.store.getItem(pendingKey),null);assert.equal(h.controller.status().revision,9);assert.equal(h.controller.status().game.id,latest.id);assert.equal(h.controller.status().ready,true);
 assert.deepEqual(calls.filter(b=>b.op==='action'),Array.from({length:3},()=>JSON.parse(staged)));
});
test('a start ACK requires a game and accepts its newly allocated ID on the same durable retry',async()=>{
 let valid=false;const calls=[],created={...game(),id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'};
 const h=harness(async b=>{calls.push(copy(b));return b.op==='load'?response(valid?1:0,valid?created:null):response(1,valid?created:null,'saved')});
 await h.controller.load();await h.controller.start('hard');const staged=h.store.getItem(pendingKey);assert(staged);assert.equal(h.controller.status().pending,true);assert.equal(h.controller.status().game,null);
 valid=true;await h.controller.load();assert.equal(h.controller.status().game.id,created.id);assert.equal(h.controller.status().ready,true);assert.equal(h.controller.status().pending,false);assert.deepEqual(calls.filter(b=>b.op==='start'),[JSON.parse(staged),JSON.parse(staged)]);
});
test('a stale read after an accepted ACK cannot reopen pre-action cards or replay the accepted move',async()=>{
 let revision=4;const calls=[],h=harness(async b=>{calls.push(copy(b));return b.op==='load'?response(revision):response(5,game(),'saved')});
 await h.controller.load();await h.controller.act({type:'call'});assert.equal(h.controller.status().revision,5);assert.equal(h.controller.status().ready,false);assert.equal(h.controller.status().pending,false);assert.match(h.controller.status().notice,/устаревшая/);
 revision=7;await h.controller.load();assert.equal(h.controller.status().ready,true);assert.equal(h.controller.status().revision,7);assert.equal(calls.filter(b=>b.op==='action').length,1);
});

function paidGame(){const g=game();g.legal.actions=g.legal.actions.filter(a=>a!=='close');g.economy={version:1,stake:100,settled:false,payout:0,xp:0,outcome:null};return g;}
function settledGame(chipCount){const g=paidGame();g.over=true;g.handOver=true;g.phase='over';g.toAct=-1;g.tableClosed=true;g.players[0].chips=chipCount;g.legal={actions:[],callAmount:0,owed:0,minimum:0,maximum:0};const payout=Math.floor(chipCount/10);g.economy={version:1,stake:100,settled:true,payout,xp:payout>100?90:payout===100?40:20,outcome:payout>100?'win':payout===100?'draw':'loss'};return g;}
test('start flights accept only optional 0 or 100 V and cannot carry a client wallet result',()=>{
 const base={op:'start',actionId:ID,expectedRevision:0,difficulty:'normal'};
 for(const body of [base,{...base,stake:0},{...base,stake:100}])assert.equal(validFlight(body),true);
 for(const stake of [-100,1,99,101,100.5,'100',null])assert.equal(validFlight({...base,stake}),false);
 for(const field of ['payout','xp','balance','wallet'])assert.equal(validFlight({...base,stake:100,[field]:1000}),false);
});
test('a paid start survives a lost ACK as the exact same entry request and installs only the latest load',async()=>{
 const store=memory(),firstCalls=[],first=harness(async b=>{firstCalls.push(copy(b));if(b.op==='load')return response(0,null);throw Error('Lost response')},store);
 await first.controller.load();await first.controller.start('hard',100);const staged=store.getItem(pendingKey);assert(staged);assert.deepEqual(JSON.parse(staged),{op:'start',difficulty:'hard',stake:100,actionId:ID,expectedRevision:0});assert.equal(first.controller.status().game,null);
 first.controller.destroy();const calls=[],latest=paidGame();latest.handNumber=2;const restored=harness(async b=>{calls.push(copy(b));return b.op==='load'?response(8,latest):response(1,paidGame(),'saved')},store);await restored.controller.load();
 assert.deepEqual(calls,[JSON.parse(staged),{op:'load'}]);assert.equal(restored.controller.status().revision,8);assert.equal(restored.controller.status().game.handNumber,2);assert.equal(store.getItem(pendingKey),null);
});
test('paid start cannot clear its pending request with a free or missing-economy ACK',async()=>{
 for(const make of [game,()=>({...game(),economy:{version:1,stake:0,settled:false,payout:0,xp:0,outcome:null}})]){
  const h=harness(async b=>b.op==='load'?response(0,null):response(1,make(),'saved'));await h.controller.load();await h.controller.start('normal',100);
  assert.equal(h.controller.status().pending,true);assert.equal(h.controller.status().ready,false);assert.equal(h.controller.status().game,null);assert.equal(JSON.parse(h.store.getItem(pendingKey)).stake,100);
 }
});
test('insufficient funds leaves no optimistic table and offers a recoverable free option',async()=>{
 const calls=[],h=harness(async b=>{calls.push(copy(b));return b.op==='load'?response(0,null):{ok:false,status:422,data:{error:'insufficient_funds'}}});await h.controller.load();await h.controller.start('normal',100);
 assert.equal(h.controller.status().game,null);assert.equal(h.controller.status().revision,0);assert.equal(h.controller.status().pending,false);assert.equal(h.controller.status().ready,true);assert.equal(h.store.getItem(pendingKey),null);assert.match(h.controller.status().notice,/бесплатную практику/);assert.match(h.controller.status().notice,/списания нет/);assert.deepEqual(calls.map(b=>b.op),['load','start','load']);
});
test('next hand on a paid table retains its table ID and never sends another stake',async()=>{
 const ended=paidGame();ended.handOver=true;ended.phase='over';ended.toAct=-1;ended.legal={actions:['nextHand','close'],callAmount:0,owed:0,minimum:0,maximum:0};const next=paidGame();next.handNumber=2;let loads=0;const calls=[],h=harness(async b=>{calls.push(copy(b));return b.op==='load'?response(++loads===1?5:6,loads===1?ended:next):response(6,next,'saved')});
 await h.controller.load();await h.controller.act({type:'nextHand'});assert.deepEqual(calls[1],{op:'action',gameId:ID,action:{type:'nextHand'},actionId:ID,expectedRevision:5});assert.equal(h.controller.status().game.economy.stake,100);assert.equal(h.controller.status().game.id,ID);assert.equal(h.controller.status().game.handNumber,2);
});
test('legacy practice, active economy and each exact current-chip settlement validate',()=>{
 assert.equal(economyOf(game()),null);
 const free=game();free.economy={version:1,stake:0,settled:false,payout:0,xp:0,outcome:null};assert.doesNotThrow(()=>projection(response(0,free).data));free.over=true;free.tableClosed=true;free.phase='over';free.legal.actions=[];free.economy.settled=true;free.economy.outcome='resigned';assert.doesNotThrow(()=>projection(response(1,free).data));
 assert.doesNotThrow(()=>projection(response(1,paidGame()).data));
 for(const n of [0,999,1000,1009,1010,4000]){const g=settledGame(n);assert.equal(projection(response(4,g).data).game.economy.payout,Math.floor(n/10));}
});
test('paid projection rejects premature payout, mid-hand cashout and inconsistent settlement rewards',()=>{
 for(const mutate of [g=>g.economy.stake=1,g=>g.economy.payout=10,g=>g.economy.xp=20,g=>g.economy.outcome='win',g=>g.economy.settled=true,g=>g.legal.actions.push('close'),g=>g.legal.actions.push('resign')]){const g=paidGame();mutate(g);assert.throws(()=>projection(response(1,g).data));}
 for(const mutate of [g=>g.economy.payout++,g=>g.economy.xp=40,g=>g.economy.outcome='draw',g=>g.handOver=false,g=>g.economy.settled=false,g=>g.players[0].chips=1100]){const g=settledGame(2000);mutate(g);assert.throws(()=>projection(response(8,g).data));}
 const free=settledGame(2000);free.economy.stake=0;assert.throws(()=>projection(response(8,free).data));
});
test('paid setup requires a current, idle server wallet and sufficient balance',()=>{
 const wallet={phase:'saved',ready:true,busy:false,pending:false,wallet:{balance:100}};assert.equal(paidStartAvailability(wallet).allowed,true);assert.equal(paidStartAvailability({...wallet,wallet:{balance:99}}).allowed,false);
 for(const change of [{phase:'offline'},{ready:false},{busy:true},{pending:true},{wallet:null},{wallet:{balance:'100'}},{wallet:{balance:-1}}])assert.equal(paidStartAvailability({...wallet,...change}).allowed,false);
 assert.equal(paidStartAvailability(null).allowed,false);assert.match(paidStartAvailability({...wallet,wallet:{balance:0}}).reason,/бесплатно/);
});
