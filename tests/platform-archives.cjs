'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const read=name=>fs.readFileSync(path.join(__dirname,'../dist',name),'utf8'),plain=value=>JSON.parse(JSON.stringify(value));
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const GAMES=['durak','bunker','poker','mafia','monopoly'],prefix=scope=>'vezdehot:checkpoint:v1:'+scope+':archive:';
const profile=()=>({nick:'Игрок',balance:8100,xp:20,wins:1,games:1,bonusAt:0,avatar:'✦',durakPace:'calm',reduceMotion:false,history:[],resultIds:[]});
const heads=()=>({profile:2,games:Object.fromEntries(GAMES.map(game=>[game,1]))});
function archive(scope=A){return {version:1,createdAt:Date.parse('2026-10-26T09:00:00Z'),scope,snapshot:{format:'vezdehot-account-checkpoint',version:1,profile:profile(),games:{durak:{fixture:'durak',over:false,paused:false},bunker:null,poker:{fixture:'poker',version:3,over:true,tableClosed:false,players:[{chips:500},{chips:500}]},mafia:{fixture:'mafia',over:true},monopoly:null}},pendingResults:[],meta:{version:1,baseRevision:3,ackHeads:heads(),flight:null,updatedAt:'2026-10-26T08:00:00Z'}}}
function archiveHarness(entries=[]){
  const storage=new Map(entries),reads=[],calls=[],checks=[];let current=true,failKeys=false;
  const context={window:{},console};vm.createContext(context);vm.runInContext(read('cloud-checkpoint.js'),context);
  const instance=context.window.VEZDEHOT_CHECKPOINT.create({scope:A,read:()=>null,current:()=>current,
    archiveKeys:()=>{if(failKeys)throw Error('storage blocked');return [...storage.keys()]},readArchive:key=>{reads.push(key);return storage.get(key)??null},
    validate:(game,state,options)=>{checks.push({game,options});if(state!==null&&state.fixture!==game)throw Error('corrupt game');if(state)state.paused=true;return state},
    write:()=>{calls.push('write');throw Error('inspection wrote data')},rpc:()=>{calls.push('rpc');throw Error('inspection called network')},getStore:()=>{calls.push('store');throw Error('inspection captured live games')},
    getProfile:()=>{throw Error('inspection captured live profile')},pause:()=>{calls.push('pause');throw Error('inspection paused play')}
  });
  return {instance,storage,reads,calls,checks,setCurrent:value=>current=value,setFailKeys:value=>failKeys=value};
}
test('archive enumeration reads only current-account archive keys and never captures, writes or syncs',()=>{
  const original=archive(),h=archiveHarness([[prefix(A)+id(1),JSON.stringify(original)],[prefix(B)+id(2),JSON.stringify(archive(B))],['supabase.auth.token','private'],['vezdehot:server-wallet:'+A,'paid-wallet'],[prefix(A)+'../../other','bad']]);
  const before=plain([...h.storage]),state=plain(h.instance.status()),list=plain(h.instance.listArchives());
  assert.equal(list.ok,true);assert.equal(list.entries.length,1);assert.deepEqual(h.reads,[prefix(A)+id(1)]);
  assert.deepEqual(list.entries[0].games.map(row=>row.status),['active','empty','active','finished','empty']);
  assert.equal(list.entries[0].balance,8100);assert.deepEqual(plain([...h.storage]),before);assert.deepEqual(h.calls,[]);assert.deepEqual(plain(h.instance.status()),state);
  assert.deepEqual(h.checks.map(row=>row.game),GAMES);assert(h.checks.every(row=>row.options.remote));
});
test('archive export keeps the exact validated branch despite normalization by game codecs',()=>{
  const original=archive(),pending={id:'unconfirmed',game:'mafia',win:true,delta:100,xp:20,at:'2026-10-26T08:30:00Z'};
  original.pendingResults=[pending];original.snapshot.profile.history=[{...pending,synced:false}];original.snapshot.profile.resultIds=[pending.id];
  original.meta.flight={id:id(7),expectedRevision:3,heads:heads(),snapshot:plain(original.snapshot),results:[pending]};
  const h=archiveHarness([[prefix(A)+id(1),JSON.stringify(original)]]),exported=plain(h.instance.readArchive(id(1)));
  assert.deepEqual(exported,original);assert.equal(exported.snapshot.games.durak.paused,false);assert.equal(exported.snapshot.profile.history[0].synced,false);
  exported.snapshot.profile.balance=999999;assert.equal(h.instance.readArchive(id(1)).snapshot.profile.balance,8100);assert.deepEqual(h.calls,[]);
});
test('a branch archived by real cloud acceptance can be listed and downloaded after replacement',async()=>{
  const context={window:{},console};vm.createContext(context);vm.runInContext(read('cloud-checkpoint.js'),context);
  const storage=new Map(),empty=Object.fromEntries(GAMES.map(game=>[game,null]));let localProfile={...profile(),revision:1,dirty:true},localGames=plain(empty),revision=1;
  const incoming={status:'ok',revision:4,updatedAt:'2026-10-26T10:00:00Z',completedIds:[],snapshot:{format:'vezdehot-account-checkpoint',version:1,profile:{...profile(),nick:'From cloud',balance:12000},games:empty}};
  const instance=context.window.VEZDEHOT_CHECKPOINT.create({scope:A,current:()=>true,read:(key,fallback)=>storage.has(key)?JSON.parse(storage.get(key)):fallback,write:(key,value)=>{storage.set(key,JSON.stringify(value));return true},archiveKeys:()=>[...storage.keys()],readArchive:key=>storage.get(key)||null,
    getProfile:()=>plain(localProfile),getPendingResults:()=>[],getStore:()=>({exportAll:()=>({ok:true,games:plain(localGames),revisions:Object.fromEntries(GAMES.map(game=>[game,revision]))}),installAll:(_,games)=>{localGames=plain(games);revision++;return{ok:true}}}),
    validate:(_,state)=>{assert.equal(state,null);return null},rpc:async name=>{assert.equal(name,'load_player_checkpoint');return{data:plain(incoming)}},
    installProfile:value=>{localProfile={...plain(value),revision:2,dirty:false};return true},uuid:()=>id(42),now:()=>Date.parse('2026-10-26T11:00:00Z')
  });
  assert.equal(await instance.acceptCloud(),true);assert.equal(localProfile.balance,12000);
  const result=instance.listArchives();assert.equal(result.ok,true);assert.equal(result.skipped,0);assert.equal(result.entries[0].balance,8100);assert.equal(result.entries[0].id,id(42));
  assert.deepEqual(plain(instance.readArchive(id(42))),JSON.parse(storage.get(prefix(A)+id(42))));
});
test('invalid wrapper, owner, game, results and embedded flight are skipped without deleting data',()=>{
  const mutations=[v=>v.scope=B,v=>v.createdAt='yesterday',v=>v.snapshot.profile.balance=-1,v=>v.snapshot.games.durak.fixture='wrong',v=>v.snapshot.games.extra=null,v=>v.meta.token='should-never-export',v=>v.meta.ackHeads.games.poker=-1,v=>v.pendingResults=[{id:'missing'}],v=>v.meta.flight={token:'secret'},v=>v.snapshot.profile.resultIds=['duplicate','duplicate']];
  const entries=mutations.map((mutate,i)=>{const value=archive();mutate(value);return[prefix(A)+id(i+1),JSON.stringify(value)]});entries.push([prefix(A)+id(99),'{bad json']);
  const h=archiveHarness(entries),before=plain([...h.storage]),list=h.instance.listArchives();
  assert.equal(list.ok,true);assert.equal(list.entries.length,0);assert.equal(list.skipped,entries.length);assert.equal(h.instance.readArchive(id(1)),null);assert.deepEqual(plain([...h.storage]),before);assert.deepEqual(h.calls,[]);
});
test('archived mutation and history must agree and contain durable result identifiers',()=>{
  for(const corrupt of ['different-history','duplicate-pending','missing-id']){
    const value=archive(),row={id:'reward',game:'mafia',win:true,delta:100,xp:20,at:'2026-10-26T08:30:00Z'};
    value.pendingResults=[row];value.snapshot.profile.resultIds=[row.id];value.snapshot.profile.history=[{...row,synced:false}];
    if(corrupt==='different-history')value.snapshot.profile.history[0].delta=200;
    if(corrupt==='duplicate-pending')value.pendingResults.push({...row});
    if(corrupt==='missing-id')value.snapshot.profile.resultIds=[];
    const h=archiveHarness([[prefix(A)+id(1),JSON.stringify(value)]]);assert.equal(h.instance.readArchive(id(1)),null,corrupt);
  }
});
test('stale account, lost tab ownership and malformed archive IDs cannot inspect old data',()=>{
  const h=archiveHarness([[prefix(A)+id(1),JSON.stringify(archive())]]);
  for(const malformed of ['../'+id(1),prefix(B)+id(1),null,{},''])assert.equal(h.instance.readArchive(malformed),null);
  assert.equal(h.reads.length,0);h.setCurrent(false);assert.equal(h.instance.listArchives().ok,false);assert.equal(h.instance.readArchive(id(1)),null);assert.equal(h.reads.length,0);
  h.setCurrent(true);h.instance.invalidate();assert.equal(h.instance.readArchive(id(1)),null);
});
test('storage access errors and oversized copies stay read-only and visible as unavailable',()=>{
  const h=archiveHarness([[prefix(A)+id(1),' '.repeat(8*1024*1024+1)]]);assert.equal(h.instance.listArchives().skipped,1);assert.equal(h.instance.readArchive(id(1)),null);
  h.setFailKeys(true);assert.equal(h.instance.listArchives().ok,false);assert.deepEqual(h.calls,[]);
});
test('many archives have an explicit inspection limit and newest valid entries sort first',()=>{
  const entries=Array.from({length:105},(_,i)=>{const value=archive();value.createdAt+=i*1000;return[prefix(A)+id(i+1),JSON.stringify(value)]}),h=archiveHarness(entries),list=h.instance.listArchives();
  assert.equal(list.limited,true);assert.equal(list.entries.length,100);assert.equal(list.entries[0].id,id(100));assert.equal(h.reads.length,100);
});

// Minimal DOM for the actual dialog handlers. Native <details>/<summary> stays
// browser-owned; no fake click is used to claim a rendering or touch test.
function uiHarness(archiveApi){
  const store=new Map(),events=new Map(),downloads=[],blobs=new Map();let owned=true,blobIndex=0;
  const document={documentElement:{dataset:{}},activeElement:null,addEventListener:(type,fn)=>{const list=events.get(type)||[];list.push(fn);events.set(type,list)},dispatchEvent(){},querySelector:()=>null,getElementById:()=>null};
  class Node {
    constructor(tag){this.tagName=tag.toUpperCase();this.dataset={};this.children=[];this.style={};this.listeners={};this.fields=new Map();this.isConnected=false;this.hidden=false;this.disabled=false;this.inert=false;this.textContent='';}
    set innerHTML(value){this.html=value;this.fields.clear();this.downloadButtons=[...value.matchAll(/data-archive-download="([^"]+)"/g)].map(match=>{const button=new Node('button');button.dataset.archiveDownload=match[1];button.isConnected=true;return button});this.summaries=[...value.matchAll(/<summary>/g)].map(()=>new Node('summary'));}
    get innerHTML(){return this.html||'';}
    appendChild(node){node.isConnected=true;node.parent=this;this.children.push(node);return node}
    remove(){this.isConnected=false;if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this)}
    querySelector(selector){if(!this.fields.has(selector)){const node=new Node(selector==='.vh-close'?'button':'div');node.isConnected=true;this.fields.set(selector,node)}return this.fields.get(selector)}
    querySelectorAll(selector){if(selector==='[data-archive-download]')return this.downloadButtons||[];return[this.querySelector('.vh-close'),...(this.summaries||[]),...(this.downloadButtons||[])]}
    addEventListener(type,fn){this.listeners[type]=fn}
    contains(node){return node===this||this.children.includes(node)||[...this.fields.values()].includes(node)||(this.downloadButtons||[]).includes(node)||(this.summaries||[]).includes(node)}
    focus(){document.activeElement=this}
    getClientRects(){return[{}]}
    click(){if(this.tagName==='A')downloads.push({href:this.href,name:this.download});else this.onclick?.()}
  }
  document.createElement=tag=>new Node(tag);document.body=new Node('body');document.body.isConnected=true;
  const app=new Node('main'),trigger=new Node('button');document.body.appendChild(app);document.body.appendChild(trigger);trigger.focus();
  const context={window:{VEZDEHOT_AUTH_CONFIG:{checkpointsEnabled:true},VEZDEHOT_TAB_SESSION:{ownsLock:()=>owned},addEventListener(){}},document,
    localStorage:{getItem:key=>store.get(key)||null,setItem:()=>{throw Error('UI wrote data')}},
    location:{search:'',origin:'https://app.test',assign(){}},URLSearchParams,AbortController,crypto:require('node:crypto').webcrypto,console,Blob,
    URL:{createObjectURL:blob=>{const key='blob:'+ ++blobIndex;blobs.set(key,blob);return key},revokeObjectURL:()=>{}},setTimeout:()=>1,clearTimeout(){},CustomEvent:class{constructor(type){this.type=type}}};
  vm.createContext(context);
  const instrumented=read('platform.js').replace('init();\n})();',"window.__archivesTest={setAccount(id,api){scope=id;user=id==='guest'?null:{id};checkpoint=api;activationEpoch++;},markup:archiveEntryMarkup};\n})();");
  assert.notEqual(instrumented,read('platform.js'));vm.runInContext(instrumented,context);context.window.__archivesTest.setAccount(A,archiveApi);
  return {api:context.window.VEZDEHOT,hooks:context.window.__archivesTest,document,app,trigger,downloads,blobs,setOwned:value=>owned=value,dialog:()=>document.body.children.find(node=>node.id==='vh-archives')};
}
test('archive dialog escapes stored names and exports the selected exact copy without changing data',async()=>{
  const value=archive();value.snapshot.profile.nick='<img src=x onerror=1>';
  const h=archiveHarness([[prefix(A)+id(1),JSON.stringify(value)]]),ui=uiHarness(h.instance);ui.api.openArchives();
  const dialog=ui.dialog();assert.match(dialog.innerHTML,/&lt;img src=x onerror=1&gt;/);assert.doesNotMatch(dialog.innerHTML,/<img src=x/);assert.match(dialog.innerHTML,/<details class="vh-archive-entry"><summary>/);assert.match(dialog.innerHTML,/Баланс практики в копии/);assert.match(dialog.innerHTML,/Возврат архивной версии в игру ещё не поддерживается/);
  dialog.querySelectorAll('[data-archive-download]')[0].click();assert.equal(ui.downloads.length,1);assert.deepEqual(JSON.parse(await ui.blobs.get(ui.downloads[0].href).text()),value);assert.deepEqual(h.calls,[]);
});
test('an old archive download handler cannot export after account change or ownership loss',()=>{
  for(const stale of ['account','lock']){
    const h=archiveHarness([[prefix(A)+id(1),JSON.stringify(archive())]]),ui=uiHarness(h.instance);ui.api.openArchives();const button=ui.dialog().querySelectorAll('[data-archive-download]')[0],reads=h.reads.length;
    if(stale==='account')ui.hooks.setAccount(B,h.instance);else ui.setOwned(false);button.click();assert.equal(ui.downloads.length,0);assert.equal(h.reads.length,reads);assert.equal(ui.dialog(),undefined);
  }
});
test('guest archive view explains local-only progress and does not inspect any account',()=>{
  const ui=uiHarness({listArchives(){throw Error('guest inspected account')},readArchive(){throw Error('guest exported account')}});ui.hooks.setAccount('guest',null);ui.api.openArchives();
  assert.match(ui.dialog().innerHTML,/Гостевой прогресс остаётся здесь/);assert.equal(ui.dialog().querySelectorAll('[data-archive-download]').length,0);
});
test('archive dialog traps keyboard focus, closes on Escape and restores previous focus',()=>{
  const h=archiveHarness([[prefix(A)+id(1),JSON.stringify(archive())]]),ui=uiHarness(h.instance);ui.api.openArchives();const dialog=ui.dialog(),close=dialog.querySelector('.vh-close'),last=dialog.querySelectorAll('[data-archive-download]')[0];assert(ui.app.inert);assert.equal(ui.document.activeElement,close);
  last.focus();dialog.listeners.keydown({key:'Tab',shiftKey:false,stopPropagation(){},preventDefault(){}});assert.equal(ui.document.activeElement,close);
  dialog.listeners.keydown({key:'Tab',shiftKey:true,stopPropagation(){},preventDefault(){}});assert.equal(ui.document.activeElement,last);
  dialog.listeners.keydown({key:'Escape',stopPropagation(){},preventDefault(){}});assert.equal(ui.dialog(),undefined);assert.equal(ui.app.inert,false);assert.equal(ui.document.activeElement,ui.trigger);
});
