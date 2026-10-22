'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../dist/platform.js'),'utf8');
const A='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const profile=(name,balance=10000)=>({nickname:name,balance,xp:0,wins:0,games:0,preferences:{}});
const session=id=>({user:{id,identities:[],app_metadata:{}}});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
const tick=()=>new Promise(r=>setTimeout(r,4));
function harness(options={}){
  const store=options.store||new Map(),timers=new Set(),reads=[],histories=[],writes=[],inserts=[],events=[],navigation=[],requests=[];
  const listeners={window:new Map(),document:new Map()};let authCallback,clientOptions,signOutCalls=0,verifyCalls=0;
  const listen=(target,type,fn)=>{const list=listeners[target].get(type)||[];list.push(fn);listeners[target].set(type,list)};
  const dispatch=(target,event)=>{events.push(event);for(const fn of listeners[target].get(event.type)||[])fn(event)};
  const timer=(fn,ms)=>{const delay=ms===700?60000:options.fastTimeout&&ms>=8000?20:ms;const id=setTimeout(()=>{timers.delete(id);fn()},delay);id.unref?.();timers.add(id);return id};
  const client={auth:{
    getSession:()=>options.sessionPromise||Promise.resolve({data:{session:options.session||null}}),
    onAuthStateChange:cb=>{authCallback=cb;return {data:{subscription:{unsubscribe(){}}}}},
    signOut:async()=>{signOutCalls++;return {}},
    signInWithOAuth:async()=>({data:{}}),linkIdentity:async()=>({data:{}}),
    verifyOtp:async data=>{verifyCalls++;return options.verifyResponse||{data:{session:session(A)}}}
  },from:table=>({
    select(){return this},eq(key,id){this.id=id;return this},order(){return this},
    maybeSingle(){const d=deferred();reads.push({id:this.id,...d});if(options.profiles)d.resolve({data:options.profiles[this.id]??null});return d.promise},
    limit(){const d=deferred();histories.push({id:this.id,...d});if(!options.pauseHistory)d.resolve({data:[]});return d.promise},
    upsert(row){const d=deferred();writes.push({row,...d});if(!options.pauseWrites)d.resolve({});return d.promise},
    insert(row){inserts.push(row);return Promise.resolve({})}
  })};
  const context={
    window:{VEZDEHOT_AUTH_CONFIG:{url:'https://project.supabase.co',publishableKey:'public',googleEnabled:false,telegramEnabled:false,telegramProvider:'custom:telegram',...options.config},supabase:{createClient:(url,key,opts)=>{clientOptions=opts;return client}},addEventListener:(type,fn)=>listen('window',type,fn),Telegram:options.telegram},
    localStorage:{getItem:key=>store.get(key)||null,setItem:(key,value)=>store.set(key,value)},
    document:{documentElement:{dataset:{}},addEventListener:(type,fn)=>listen('document',type,fn),dispatchEvent:event=>dispatch('document',event),querySelector:()=>null},
    CustomEvent:class{constructor(type,init){this.type=type;this.detail=init?.detail}},
    location:{search:'',origin:'https://app.test',assign:url=>navigation.push(url)},
    fetch:async(input,opts)=>{requests.push({input,opts});if(options.fetch)return options.fetch(input,opts);return {ok:true,json:async()=>({external:{google:false}})}},
    setTimeout:timer,clearTimeout:id=>{clearTimeout(id);timers.delete(id)},URLSearchParams,AbortController,crypto:require('node:crypto').webcrypto,console
  };
  vm.createContext(context);vm.runInContext(source,context);
  return {api:context.window.VEZDEHOT,store,reads,histories,writes,inserts,events,navigation,requests,context,
    auth:(id,event='SIGNED_IN')=>authCallback(event,id?session(id):null),
    event:(target,type)=>dispatch(target,{type}),
    get clientOptions(){return clientOptions},get signOutCalls(){return signOutCalls},get verifyCalls(){return verifyCalls},
    close(){for(const id of timers)clearTimeout(id);timers.clear()}
  };
}

test('late account A response cannot overwrite account B; stale game actions freeze',async t=>{
  const h=harness();t.after(()=>h.close());await h.api.ready;
  h.auth(A);await tick();h.auth(B);await tick();
  h.reads.find(x=>x.id===B).resolve({data:profile('B private',222)});await tick();
  h.reads.find(x=>x.id===A).resolve({data:profile('A private',111)});await tick();
  assert.equal(h.api.account().scope,B);assert.equal(h.api.getProfile().nick,'B private');assert.equal(h.api.getProfile().balance,222);
  h.api.updateProfile({nick:'Old game'});h.api.recordResult({id:'old-round',game:'durak',delta:300,win:true});
  h.api.saveMainState({secret:'old game state'});
  assert.equal(h.api.getProfile().nick,'B private');assert.equal(h.api.getProfile().games,0);assert.equal(h.store.has('vezdehot:main:'+B),false);
});

test('late history uses captured account and cannot leak into next account',async t=>{
  const h=harness({pauseHistory:true});t.after(()=>h.close());await h.api.ready;
  h.auth(A);await tick();h.reads[0].resolve({data:profile('A')});await tick();
  h.auth(B);await tick();h.reads[1].resolve({data:profile('B')});await tick();
  assert.deepEqual(h.histories.map(x=>x.id),[A,B]);
  h.histories[1].resolve({data:[]});await tick();
  h.histories[0].resolve({data:[{id:'a-secret',game:'poker',delta:33,played_at:'2026-10-22'}]});await tick();
  assert.equal(h.api.getProfile().nick,'B');assert.equal(h.api.getProfile().history.length,0);
});

test('initial hydration buffers edits and rewards; no BASE upsert before cloud load',async t=>{
  const h=harness({session:session(A)});t.after(()=>h.close());await tick();
  const at=Date.parse('2026-10-22T12:00:00Z');
  h.api.updateProfile({nick:'Renamed',bonusAt:at});
  h.api.recordResult({id:'new-round',game:'durak',delta:250,xp:25,win:true});
  await h.api.sync();assert.equal(h.writes.length,0);
  h.reads[0].resolve({data:{...profile('Cloud',90000),xp:300,wins:5,games:9}});await h.api.ready;
  assert.equal(h.api.getProfile().nick,'Renamed');assert.equal(h.api.getProfile().balance,90250);assert.equal(h.api.getProfile().games,10);
  assert.equal(h.api.getProfile().bonusAt,at);assert.equal(h.api.getProfile().xp,325);
  await h.api.sync();assert.equal(h.writes.length,1);assert.equal(h.writes[0].row.balance,90250);
  assert.equal(h.writes[0].row.preferences.bonusAt,at);assert.equal(h.inserts[0].user_id,A);
});

test('duplicate SIGNED_IN cannot resolve ready before original hydration',async t=>{
  const h=harness({session:session(A)});t.after(()=>h.close());let ready=false;h.api.ready.then(()=>ready=true);await tick();
  h.auth(A);await tick();assert.equal(ready,false);assert.equal(h.reads.length,1);
  h.reads[0].resolve({data:profile('Hydrated',777)});await h.api.ready;
  assert.equal(h.api.getProfile().balance,777);
});

test('results are idempotent across reload; timestamps retain millisecond precision',async t=>{
  const h=harness();t.after(()=>h.close());await h.api.ready;
  const result={id:'stable-round',game:'bunker',delta:150,xp:30,win:true},at=Date.now();
  h.api.updateProfile({bonusAt:at});h.api.recordResult(result);h.api.recordResult(result);
  assert.equal(h.api.getProfile().games,1);assert.equal(h.api.getProfile().balance,10150);
  const next=harness({store:h.store});t.after(()=>next.close());await next.api.ready;next.api.recordResult(result);
  assert.equal(next.api.getProfile().games,1);assert.equal(next.api.getProfile().balance,10150);assert.equal(next.api.getProfile().bonusAt,at);
});

test('signOut waits for existing in-flight sync before replacing scope',async t=>{
  const h=harness({session:session(A),profiles:{[A]:profile('A')},pauseWrites:true});t.after(()=>h.close());await h.api.ready;
  h.api.updateProfile({nick:'Saved before exit'});const syncing=h.api.sync(),exiting=h.api.signOut();await tick();
  assert.equal(h.signOutCalls,0);assert.equal(h.writes.length,1);
  h.writes[0].resolve({});await syncing;await exiting;
  assert.equal(h.signOutCalls,1);assert.equal(h.api.account().scope,'guest');assert.equal(h.api.getProfile().nick,'Игрок');
});

test('sync callers wait for changes made during first request',async t=>{
  const h=harness({session:session(A),profiles:{[A]:profile('A')},pauseWrites:true});t.after(()=>h.close());await h.api.ready;
  h.api.updateProfile({nick:'First'});const first=h.api.sync();h.api.updateProfile({nick:'Second'});const second=h.api.sync();
  h.writes[0].resolve({});await first;await tick();assert.equal(h.writes.length,2);assert.equal(h.writes[1].row.nickname,'Second');
  h.writes[1].resolve({});await second;assert.equal(h.api.getProfile().dirty,false);
});

test('guest, account A and account B snapshots remain isolated across reloads',async t=>{
  const store=new Map([
    ['vezdehot:profile:guest',JSON.stringify({nick:'Guest own',balance:7000,games:2})],
    ['vezdehot:profile:'+A,JSON.stringify({nick:'A local',balance:15000,games:3})],
    ['vezdehot:profile:'+B,JSON.stringify({nick:'B local',balance:19000,games:4})],
    ['vezdehot:main:'+A,JSON.stringify({view:'durak',owner:'A'})],
    ['vezdehot:main:'+B,JSON.stringify({view:'bunker',owner:'B'})]
  ]);
  const a=harness({store,session:session(A),profiles:{}});t.after(()=>a.close());await a.api.ready;
  assert.equal(a.api.getProfile().balance,15000);assert.equal(a.api.loadMainState().owner,'A');
  // Another tab can write LEGACY; switching must not copy it into A's scoped main state.
  store.set('vezdehot_v2',JSON.stringify({owner:'B in another tab'}));a.auth(B);await tick();
  assert.equal(JSON.parse(store.get('vezdehot:main:'+A)).owner,'A');
  const b=harness({store,session:session(B),profiles:{}});t.after(()=>b.close());await b.api.ready;
  assert.equal(b.api.getProfile().balance,19000);assert.equal(b.api.loadMainState().owner,'B');
  const guest=harness({store,profiles:{}});t.after(()=>guest.close());await guest.api.ready;
  assert.equal(guest.api.getProfile().nick,'Guest own');assert.equal(guest.api.getProfile().balance,7000);
});

test('guest import has durable per-account marker and protects nonempty cloud profile',async t=>{
  const store=new Map([['vezdehot:profile:guest',JSON.stringify({nick:'Guest',balance:10500,games:3,wins:1,xp:10})]]);
  const h=harness({store,session:session(A),profiles:{[A]:profile('Account name')}});t.after(()=>h.close());await h.api.ready;
  assert.equal(h.api.canImportGuest(),true);assert.equal(h.api.importGuest(),true);assert.equal(h.api.importGuest(),false);
  assert.equal(h.api.getProfile().nick,'Account name');assert.equal(h.api.getProfile().games,3);assert.ok(store.has('vezdehot:guest-import:'+A));
  h.api.updateProfile({balance:10000,games:0,wins:0,xp:0});assert.equal(h.api.canImportGuest(),false);
  const b=harness({store,session:session(B),profiles:{[B]:profile('Existing B',12345)}});t.after(()=>b.close());await b.api.ready;
  assert.equal(b.api.importGuest(),false);assert.equal(b.api.getProfile().balance,12345);
});

test('timed-out first hydration retains pending operations for safe retry after reload',async t=>{
  const h=harness({session:session(A),fastTimeout:true});t.after(()=>h.close());await tick();h.api.updateProfile({nick:'Offline edit'});
  h.api.recordResult({id:'offline-round',game:'mafia',delta:150,xp:30,win:true});
  await new Promise(r=>setTimeout(r,35));await h.api.ready;await h.api.sync();assert.equal(h.writes.length,0);
  const retry=harness({store:h.store,session:session(A),profiles:{[A]:{...profile('Cloud account',30000),games:10}}});t.after(()=>retry.close());await retry.api.ready;
  assert.equal(retry.api.getProfile().nick,'Offline edit');assert.equal(retry.api.getProfile().balance,30150);assert.equal(retry.api.getProfile().games,11);
  await retry.api.sync();assert.equal(retry.writes[0].row.balance,30150);
});

test('SDK fetch is bounded and preserves an upstream abort signal',async t=>{
  const h=harness({fetch:async(input,opts)=>({ok:true,json:async()=>({external:{}})})});t.after(()=>h.close());await h.api.ready;
  assert.equal(typeof h.clientOptions.global.fetch,'function');const upstream=new AbortController();upstream.abort();
  await h.clientOptions.global.fetch('https://example.test',{signal:upstream.signal});
  assert.equal(h.requests.at(-1).opts.signal.aborted,true);
});

test('Telegram Mini App sends only signed initData and waits for server-verified session',async t=>{
  const h=harness({config:{telegramMiniAppEnabled:true,telegramAuthUrl:'https://project.supabase.co/functions/v1/telegram-auth'},telegram:{WebApp:{initData:'signed-proof',initDataUnsafe:{user:{id:999,name:'UNTRUSTED'}}}},profiles:{[A]:profile('Verified Telegram')},verifyResponse:{data:{session:{user:{...session(A).user,app_metadata:{telegram_id:'841234'}}}}},fetch:async input=>String(input).includes('/functions/')?{ok:true,json:async()=>({token_hash:'one-use-token',type:'magiclink'})}:{ok:true,json:async()=>({external:{google:false}})}});
  t.after(()=>h.close());await h.api.ready;assert.equal(h.api.account().providers.telegram,true);await h.api.login('telegram');
  const request=h.requests.find(x=>String(x.input).includes('/functions/'));
  assert.deepEqual(JSON.parse(request.opts.body),{initData:'signed-proof'});assert.equal(h.verifyCalls,1);
  assert.equal(h.api.getProfile().nick,'Verified Telegram');assert.ok(h.api.account().user.providers.includes('custom:telegram'));
});

test('invalid Telegram proof never creates a local signed-in identity',async t=>{
  const h=harness({config:{telegramMiniAppEnabled:true,telegramAuthUrl:'https://project.supabase.co/functions/v1/telegram-auth'},telegram:{WebApp:{initData:'bad-proof'}},fetch:async input=>String(input).includes('/functions/')?{ok:false,json:async()=>({error:'invalid_signature'})}:{ok:true,json:async()=>({external:{}})}});
  t.after(()=>h.close());await h.api.ready;await assert.rejects(()=>h.api.login('telegram'),/Telegram не подтвердил/);
  assert.equal(h.verifyCalls,0);assert.equal(h.api.account().user,null);assert.equal(h.api.account().scope,'guest');
});
