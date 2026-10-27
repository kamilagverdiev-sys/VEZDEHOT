'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('dist/server-wallet.js','utf8'),ctx={window:{},document:{},Object,JSON,Number,Set,Map,Error,Promise,Date};
vm.createContext(ctx);vm.runInContext(source,ctx);
const {createController,projection,walletMarkup,waitText}=ctx.window.VEZDEHOT_SERVER_WALLET;
const ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',SCOPE='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',OTHER='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const copy=v=>JSON.parse(JSON.stringify(v)),key='vezdehot:server-wallet:pending:v1:'+SCOPE;
const TIME='2026-10-25T12:00:00.000Z',LATER='2026-10-26T12:00:00.000Z';
function memory(){const values=new Map();return {values,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}}
function wallet(revision=1,extra={}){return {version:1,revision,balance:1000,xp:0,games:0,wins:0,bonusAvailableAt:TIME,serverTime:TIME,history:[{id:ID,kind:'welcome',game:null,tableId:null,delta:1000,xp:0,balance:1000,createdAt:TIME}],...extra}}
const response=(revision=1,extra={})=>({ok:true,status:200,data:{status:'ok',wallet:wallet(revision,extra)}});
const receipt=(status='saved',actionId=ID)=>({ok:true,status:200,data:{status,actionId,...(status==='cooldown'?{availableAt:LATER}:{})}});
function harness(request,store=memory(),extra={}){let active=true,clock=0;const events=[];const controller=createController({scope:SCOPE,current:()=>active,storage:store,now:()=>clock,uuid:()=>ID,request,onChange:s=>events.push(copy(s)),...extra});return {controller,store,events,deactivate:()=>active=false,advance:ms=>clock+=ms}}
const flush=()=>new Promise(r=>setImmediate(r));

test('lost acknowledgement survives reload with the same UUID and loads fresh wallet only after receipt',async()=>{
 const store=memory(),calls=[];const one=harness(async b=>{calls.push(copy(b));if(b.op==='load')return response(3);throw Error('Lost response')},store);
 await one.controller.load();await one.controller.claimDaily();const saved=store.getItem(key);assert(saved);assert.equal(one.controller.status().pending,true);await one.controller.claimDaily();assert.deepEqual(calls.map(b=>b.op),['load','claimDaily']);
 const persisted=JSON.parse(saved);assert.deepEqual(persisted.body,{op:'claimDaily',actionId:ID});assert.equal(persisted.seenRevision,3);one.controller.destroy();
 const retried=[],two=harness(async b=>{retried.push(copy(b));return b.op==='load'?response(9,{balance:1700,bonusAvailableAt:LATER}):receipt()},store);await two.controller.load();
 assert.deepEqual(retried,[persisted.body,{op:'load'}]);assert.equal(store.getItem(key),null);assert.equal(two.controller.status().wallet.balance,1700);assert.equal(two.controller.status().wallet.revision,9);assert.equal(two.controller.status().ready,true);
});

test('incomplete or wrong-ID acknowledgements retain the durable body and never install receipt wallet fields',async()=>{
 for(const data of [{status:'ok',actionId:ID},{status:'saved'},{status:'saved',actionId:OTHER},{status:'saved',actionId:ID,availableAt:'tomorrow'}]){
  const calls=[],h=harness(async b=>{calls.push(copy(b));return b.op==='load'?response(2):{ok:true,status:200,data:{...data,wallet:wallet(99,{balance:999999})}}});
  await h.controller.load();await h.controller.claimDaily();assert.equal(h.controller.status().pending,true);assert.equal(h.controller.status().ready,false);assert.equal(h.controller.status().wallet.balance,1000);assert.deepEqual(calls.map(b=>b.op),['load','claimDaily']);assert(h.store.getItem(key));
 }
});

test('even a valid receipt is not used as a current balance',async()=>{
 const h=harness(async b=>b.op==='load'?response(5):{...receipt(),data:{...receipt().data,wallet:wallet(999,{balance:1000000})}});
 await h.controller.load();await h.controller.claimDaily();assert.equal(h.controller.status().wallet.balance,1000);assert.equal(h.controller.status().wallet.revision,5);assert.equal(h.controller.status().ready,false);assert.match(h.controller.status().notice,/устаревший/);assert.equal(h.controller.status().pending,false);
});

test('load revisions never move backwards and paid play remains unavailable until fresh read',async()=>{
 let revision=8;const h=harness(async()=>response(revision));await h.controller.load();revision=7;await h.controller.load();assert.equal(h.controller.status().wallet.revision,8);assert.equal(h.controller.status().ready,false);revision=9;await h.controller.load();assert.equal(h.controller.status().ready,true);assert.equal(h.controller.status().wallet.revision,9);
});

test('a replayed saved receipt requires a revision newer than the revision before its mutation',async()=>{
 const store=memory();store.setItem(key,JSON.stringify({version:1,body:{op:'claimDaily',actionId:ID},seenRevision:7}));let revision=7;
 const h=harness(async b=>b.op==='load'?response(revision):receipt(),store);await h.controller.load();assert.equal(h.controller.status().ready,false);assert.equal(h.controller.status().wallet,null);assert.equal(store.getItem(key),null);revision=8;await h.controller.load();assert.equal(h.controller.status().ready,true);
});

test('cooldown receipt clears the attempt and accepts the same wallet revision without minting coins',async()=>{
 const calls=[],h=harness(async b=>{calls.push(copy(b));return b.op==='load'?response(4,{bonusAvailableAt:calls.length>1?LATER:TIME}):receipt('cooldown')});await h.controller.load();await h.controller.claimDaily();assert.equal(h.controller.status().ready,true);assert.equal(h.controller.status().canClaim,false);assert.equal(h.controller.status().wallet.balance,1000);assert.equal(h.controller.status().wallet.revision,4);assert.equal(h.store.getItem(key),null);assert.deepEqual(calls.map(b=>b.op),['load','claimDaily','load']);
});

test('cooldown without a valid UTC availableAt keeps the durable attempt until a complete receipt',async()=>{
 for(const availableAt of [undefined,null,'tomorrow','2026-10-26T12:00:00+02:00']){
  let complete=false;const calls=[],h=harness(async b=>{calls.push(copy(b));if(b.op==='load')return response(4,{bonusAvailableAt:complete?LATER:TIME});return complete?receipt('cooldown'):{ok:true,status:200,data:{status:'cooldown',actionId:ID,...(availableAt===undefined?{}:{availableAt})}}});
  await h.controller.load();await h.controller.claimDaily();const staged=h.store.getItem(key);assert(staged);assert.equal(h.controller.status().pending,true);assert.equal(h.controller.status().ready,false);assert.deepEqual(calls.map(b=>b.op),['load','claimDaily']);
  complete=true;await h.controller.load();assert.deepEqual(calls[2],JSON.parse(staged).body);assert.equal(calls[3].op,'load');assert.equal(h.store.getItem(key),null);assert.equal(h.controller.status().pending,false);assert.equal(h.controller.status().ready,true);assert.equal(h.controller.status().canClaim,false);
 }
});

test('storage write or readback failure never sends a claim',async()=>{
 for(const failReadback of [false,true]){const store=memory(),calls=[];store.setItem=()=>{if(!failReadback)throw Error('Quota')};const h=harness(async b=>{calls.push(copy(b));return response()},store);await h.controller.load();await h.controller.claimDaily();assert.deepEqual(calls,[{op:'load'}]);assert.equal(h.controller.status().ready,false);}
});

test('failure clearing an acknowledged attempt replays exactly that attempt before a fresh read',async()=>{
 const store=memory(),remove=store.removeItem,calls=[];let fail=true,reads=0;store.removeItem=k=>{if(fail)throw Error('Storage denied');remove(k)};
 const h=harness(async b=>{calls.push(copy(b));return b.op==='load'?response(++reads===1?4:5):receipt()},store);await h.controller.load();await h.controller.claimDaily();assert.equal(h.controller.status().pending,true);assert.equal(h.controller.status().ready,false);fail=false;await h.controller.load();assert.equal(h.controller.status().ready,true);assert.deepEqual(calls.filter(b=>b.op==='claimDaily'),[{op:'claimDaily',actionId:ID},{op:'claimDaily',actionId:ID}]);assert.equal(h.store.getItem(key),null);
});

test('corrupt persisted requests fail closed before any request, including repeated refresh',async()=>{
 for(const saved of ['not json',JSON.stringify({op:'claimDaily',actionId:ID}),JSON.stringify({version:1,body:{op:'claimDaily',actionId:ID,amount:1000},seenRevision:3})]){
  const store=memory(),calls=[];store.setItem(key,saved);const h=harness(async b=>{calls.push(copy(b));return response()},store);await h.controller.load();await h.controller.load();assert.equal(calls.length,0);assert.equal(h.controller.status().ready,false);assert.equal(store.getItem(key),saved);
 }
});

test('late receipt after account or tab ownership changes cannot clear the former account request',async()=>{
 let resolve;const h=harness(b=>b.op==='load'?Promise.resolve(response(3)):new Promise(r=>resolve=r));await h.controller.load();const task=h.controller.claimDaily();await flush();const saved=h.store.getItem(key),events=h.events.length;h.deactivate();resolve(receipt());await task;assert.equal(h.events.length,events);assert.equal(h.store.getItem(key),saved);assert.equal(h.controller.status().wallet.revision,3);assert.equal(h.controller.status().canClaim,false);
});

test('late initial loads are discarded after controller destruction',async()=>{
 let resolve;const h=harness(()=>new Promise(r=>resolve=r));const task=h.controller.load(),events=h.events.length;h.controller.destroy();resolve(response());await task;assert.equal(h.controller.status().wallet,null);assert.equal(h.events.length,events);
});

test('pending bonus belongs only to its own account and never crosses into another scope',async()=>{
 const store=memory(),saved=JSON.stringify({version:1,body:{op:'claimDaily',actionId:ID},seenRevision:1});store.setItem(key,saved);const calls=[],h=harness(async b=>{calls.push(copy(b));return response()},store,{scope:OTHER});await h.controller.load();assert.deepEqual(calls,[{op:'load'}]);assert.equal(store.getItem(key),saved);assert.equal(h.controller.status().pending,false);
});

test('concurrent bonus clicks use a single durable UUID',async()=>{
 let resolve,reads=0;const calls=[],h=harness(b=>{calls.push(copy(b));return b.op==='load'?Promise.resolve(response(++reads)):new Promise(r=>resolve=r)});await h.controller.load();const one=h.controller.claimDaily();await h.controller.claimDaily();assert.equal(calls.filter(b=>b.op==='claimDaily').length,1);resolve(receipt());await one;assert.equal(h.controller.status().ready,true);
});

test('a refresh requested during an existing read waits for one new read',async()=>{
 const resolvers=[],calls=[],h=harness(b=>{calls.push(copy(b));return new Promise(r=>resolvers.push(r))});const first=h.controller.load(),second=h.controller.load(),third=h.controller.load();assert.equal(calls.length,1);resolvers[0](response(1));await first;assert.equal(calls.length,2);resolvers[1](response(2,{balance:900}));await Promise.all([second,third]);assert.equal(calls.length,2);assert.equal(h.controller.status().wallet.balance,900);assert.equal(h.controller.status().wallet.revision,2);
});

test('server-clock cooldown uses monotonic elapsed time, and claim body never contains amount or local time',async()=>{
 const calls=[],h=harness(async b=>{calls.push(copy(b));return b.op==='load'?response(calls.length===1?1:2,{bonusAvailableAt:LATER}):receipt()});await h.controller.load();assert.equal(h.controller.status().canClaim,false);await h.controller.claimDaily();assert.equal(calls.length,1);h.advance(86400000-1);assert.equal(h.controller.status().canClaim,false);h.advance(1);assert.equal(h.controller.status().canClaim,true);await h.controller.claimDaily();assert.deepEqual(calls[1],{op:'claimDaily',actionId:ID});assert.equal(h.controller.status().canClaim,false);
});

test('malformed public wallets and ledger rows are rejected; legacy practice data is never accepted',()=>{
 for(const data of [{status:'ok',wallet:{balance:999999}},{status:'ok',wallet:wallet(1,{balance:-1})},{status:'ok',wallet:wallet(1,{wins:2,games:1})},{status:'ok',wallet:wallet(1,{history:[{...wallet().history[0],game:'durak'}]})},{status:'ok',wallet:wallet(1,{history:[{...wallet().history[0],delta:0.1}]})},{status:'ok',wallet:wallet(1,{history:[wallet().history[0],wallet().history[0]]})}])assert.throws(()=>projection(data));
 const output=copy(projection({status:'ok',profile:{balance:999999},wallet:{...wallet(),checkpoint:{balance:999999}}}));assert.equal(output.balance,1000);assert.equal('checkpoint' in output,false);
});

test('history accepts server game settlements and markup escapes untrusted notice',()=>{
 const w=projection({status:'ok',wallet:wallet(4,{balance:1200,games:1,wins:1,xp:80,history:[{id:OTHER,kind:'settlement',game:'durak',tableId:ID,delta:300,xp:80,balance:1200,createdAt:TIME}]})});const state={phase:'saved',ready:true,busy:false,pending:false,wallet:w,notice:'<img src=x onerror=alert(1)>',serverNow:Date.parse(TIME),canClaim:true},html=walletMarkup(state,true);assert.match(html,/Расчёт стола · Дурак/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img src=x/);assert.match(html,/Баланс практики/);assert.match(html,/data-wallet-claim/);assert.equal(waitText(state),'Бонус доступен');
});

test('guest and readonly markup do not offer a usable bonus action or misleading Google status',()=>{
 const guest=walletMarkup({phase:'guest',wallet:null});assert.match(guest,/data-wallet-login/);assert.doesNotMatch(guest,/data-wallet-claim/);assert.doesNotMatch(guest,/Google/);const readonly=walletMarkup({phase:'readonly',wallet:null});assert.match(readonly,/активной вкладке/);assert.match(readonly,/data-wallet-refresh disabled/);
});

function runtime(request){
 const listeners=new Map(),store=memory(),intervals=[];let userId=SCOPE,writable=true,clock=0;
 const document={hidden:false,addEventListener:(name,fn)=>{if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(fn)}},window={localStorage:store,addEventListener:()=>{},VEZDEHOT_TAB_SESSION:{canWrite:()=>writable},VEZDEHOT:{ready:Promise.resolve(),account:()=>({user:userId?{id:userId}:null,loading:false,switching:false,authPending:false}),scopeKey:()=>userId||'guest',serverWalletRequest:request}};
 const context={window,document,crypto:{randomUUID:()=>ID},performance:{now:()=>clock},setInterval:fn=>intervals.push(fn),Object,JSON,Number,Set,Map,Error,Promise,Date};vm.createContext(context);vm.runInContext(source,context);
 return {api:window.VEZDEHOT_SERVER_WALLET,document,store,dispatch:name=>{for(const fn of listeners.get(name)||[])fn()},account:id=>{userId=id},writable:value=>{writable=value},tick(ms=30000){clock+=ms;intervals.forEach(fn=>fn())}};
}

test('profile renders and subscribers do not cause a wallet refetch loop',async()=>{
 const calls=[],r=runtime(async b=>{calls.push(copy(b));return response()});await flush();assert.equal(r.api.status().ready,true);let updates=0;const unsubscribe=r.api.subscribe(()=>updates++);for(let n=0;n<10;n++)r.dispatch('vezdehot:profile');await flush();assert.equal(calls.length,1);assert.equal(updates,1);unsubscribe();await r.api.refresh();assert.equal(calls.length,2);assert.equal(updates,1);
});

test('runtime clears private balance immediately on account and tab changes, then discards late old response',async()=>{
 const resolvers=[],r=runtime(()=>new Promise(resolve=>resolvers.push(resolve)));await flush();resolvers.shift()(response(7,{balance:1300}));await flush();assert.equal(r.api.status().wallet.balance,1300);
 const oldRefresh=r.api.refresh();r.dispatch('vezdehot:accountchange');assert.equal(r.api.status().wallet,null);r.account(OTHER);r.dispatch('vezdehot:profile');assert.equal(resolvers.length,2);resolvers[1](response(1,{balance:1000}));await flush();resolvers[0](response(8,{balance:2300}));await oldRefresh;assert.equal(r.api.status().wallet.balance,1000);assert.equal(r.api.status().wallet.revision,1);
 r.writable(false);r.dispatch('vezdehot:sessionpause');assert.equal(r.api.status().wallet,null);assert.equal(r.api.status().phase,'readonly');r.account(null);r.dispatch('vezdehot:profile');assert.equal(r.api.status().phase,'guest');assert.equal(r.api.status().wallet,null);
});

function walletHost(document){
 const body={kind:'body'},host={isConnected:true,dataset:{walletExpanded:'true'},ownerDocument:document,onclick:null,replacements:0},nodes=new Map();let detail={open:true};document.activeElement=body;
 host.contains=node=>[...nodes.values()].includes(node);
 host.querySelector=selector=>{if(selector==='.sw-card')return detail;if(selector==='.sw-card summary')return nodes.get('summary');const match=selector.match(/^\[(data-wallet-[a-z]+)\]/),node=match&&nodes.get(match[1]);return node&&(!selector.includes(':not')||!node.disabled)?node:null};
 Object.defineProperty(host,'innerHTML',{set(markup){if(host.contains(document.activeElement))document.activeElement=body;host.replacements++;nodes.clear();detail={open:/<details[^>]*\sopen(?:\s|>)/.test(markup)};const add=(name,disabled=false)=>nodes.set(name,{kind:name,disabled,hasAttribute:attribute=>attribute===name,focus(){document.activeElement=this}});add('summary');for(const match of markup.matchAll(/<button\b[^>]*\b(data-wallet-[a-z]+)\b([^>]*)>/g))add(match[1],/\bdisabled\b/.test(match[2]));}});
 return {host,body,summary:()=>nodes.get('summary'),button:name=>nodes.get(name)};
}
test('wallet timer skips identical markup and preserves summary focus when countdown changes',async()=>{
 const r=runtime(async()=>response(1,{bonusAvailableAt:'2026-10-25T12:02:00.000Z'}));await flush();const h=walletHost(r.document);r.api.mount(h.host);const summary=h.summary();summary.focus();
 r.tick(30000);assert.equal(h.host.replacements,1);assert.equal(h.summary(),summary);assert.equal(r.document.activeElement,summary);
 r.tick(31000);assert.equal(h.host.replacements,2);assert.notEqual(h.summary(),summary);assert.equal(r.document.activeElement,h.summary());assert.equal(h.host.querySelector('.sw-card').open,true);
 const replacements=h.host.replacements;r.tick(1);assert.equal(h.host.replacements,replacements);
});
test('wallet refresh keeps a summary or action fallback focused and never steals outside focus',async()=>{
 const r=runtime(async()=>response());await flush();const h=walletHost(r.document);r.api.mount(h.host);h.summary().focus();await r.api.refresh();assert.equal(r.document.activeElement,h.summary());
 h.button('data-wallet-claim').focus();await r.api.refresh();assert.equal(r.document.activeElement,h.summary(),'disappearing or disabled action falls back to the disclosure');
 r.document.activeElement=h.body;await r.api.refresh();assert.equal(r.document.activeElement,h.body);
});

test('Bunker wallet receipt keeps its 120 XP and renders the correct game name',()=>{
 const w=projection({status:'ok',wallet:wallet(3,{balance:1150,xp:120,games:1,wins:1,history:[{id:OTHER,kind:'settlement',game:'bunker',tableId:ID,delta:250,xp:120,balance:1150,createdAt:TIME}]})});
 assert.equal(w.history[0].game,'bunker');assert.equal(w.history[0].xp,120);assert.equal(w.xp,120);
 const html=walletMarkup({phase:'saved',ready:true,busy:false,pending:false,wallet:w,notice:'',serverNow:Date.parse(TIME),canClaim:true},true);assert.match(html,/Расчёт стола · Бункер/);assert.doesNotMatch(html,/undefined/);
});
