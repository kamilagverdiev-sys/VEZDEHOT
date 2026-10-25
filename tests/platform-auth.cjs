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
  const store=options.store||new Map(),timers=new Set(),reads=[],histories=[],writes=[],inserts=[],events=[],navigation=[],requests=[],oauthCalls=[];
  const listeners={window:new Map(),document:new Map()};let authCallback,clientOptions,signOutCalls=0,verifyCalls=0;
  const listen=(target,type,fn)=>{const list=listeners[target].get(type)||[];list.push(fn);listeners[target].set(type,list)};
  const dispatch=(target,event)=>{events.push(event);for(const fn of listeners[target].get(event.type)||[])fn(event)};
  const timer=(fn,ms)=>{const delay=ms===700?60000:options.fastTimeout&&ms>=8000?20:ms;const id=setTimeout(()=>{timers.delete(id);fn()},delay);id.unref?.();timers.add(id);return id};
  const client={auth:{
    initialize:()=>Promise.resolve(options.initializeResponse||{error:null}),
    getSession:()=>options.getSession?options.getSession():options.sessionPromise||Promise.resolve({data:{session:options.session||null}}),
    onAuthStateChange:cb=>{authCallback=cb;return {data:{subscription:{unsubscribe(){}}}}},
    signOut:async()=>{signOutCalls++;return {}},
    signInWithOAuth:async data=>{oauthCalls.push(data);return options.oauthResponse||{data:{url:'https://project.supabase.co/auth/v1/authorize'}}},linkIdentity:async()=>({data:{}}),
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
    localStorage:{getItem:key=>{if(options.blockRead)throw new Error('Storage denied');return store.get(key)||null},setItem:(key,value)=>{if(options.blockWrite)throw new Error('Storage quota exceeded');store.set(key,value)}},
    document:{documentElement:{dataset:{}},addEventListener:(type,fn)=>listen('document',type,fn),dispatchEvent:event=>dispatch('document',event),querySelector:()=>null},
    CustomEvent:class{constructor(type,init){this.type=type;this.detail=init?.detail}},
    location:{search:options.search||'',hash:options.hash||'',origin:options.origin||'https://app.test',assign:url=>navigation.push(url)},
    fetch:async(input,opts)=>{requests.push({input,opts});if(options.fetch)return options.fetch(input,opts);return {ok:true,json:async()=>({external:{google:false}})}},
    setTimeout:timer,clearTimeout:id=>{clearTimeout(id);timers.delete(id)},URLSearchParams,AbortController,crypto:require('node:crypto').webcrypto,console
  };
  vm.createContext(context);vm.runInContext(source,context);
  return {api:context.window.VEZDEHOT,store,reads,histories,writes,inserts,events,navigation,requests,oauthCalls,context,
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


test('blocked browser storage cannot crash boot and session profile remains usable',async t=>{
  const h=harness({blockRead:true,blockWrite:true});t.after(()=>h.close());await h.api.ready;
  assert.equal(h.api.account().storagePersisted,false);assert.equal(h.api.getProfile().balance,10000);
  h.api.updateProfile({nick:'Session player',balance:9900});h.api.saveMainState({view:'durak',round:'temporary'});
  h.api.recordResult({id:'temporary-result',game:'durak',delta:250,xp:25,win:true});
  assert.equal(h.api.getProfile().balance,10150);assert.equal(h.api.loadMainState().round,'temporary');
  assert.equal(h.api.loadMainState().nick,'Session player');assert.equal(h.store.size,0);
});

test('quota failures do not silently reread old main state over the current session',async t=>{
  const store=new Map([['vezdehot:main:guest',JSON.stringify({view:'lobby',round:'old'})]]);
  const h=harness({store,blockWrite:true});t.after(()=>h.close());await h.api.ready;
  h.api.saveMainState({view:'bunker',round:'current'});
  assert.equal(h.api.loadMainState().round,'current');assert.equal(h.api.account().storagePersisted,false);
  assert.equal(JSON.parse(store.get('vezdehot:main:guest')).round,'old');
});

test('malformed cached profile and pending queue recover without blocking cloud hydration',async t=>{
  const store=new Map([['vezdehot:profile:'+A,'42'],['vezdehot:pending:'+A,'{"not":"a queue"}']]);
  const h=harness({store,session:session(A),profiles:{[A]:profile('Recovered',12345)}});t.after(()=>h.close());await h.api.ready;
  assert.equal(h.api.getProfile().nick,'Recovered');assert.equal(h.api.getProfile().balance,12345);
  assert.equal(h.api.account().status,'saved');assert.equal(h.api.account().loading,false);
});

test('pending operations reject corrupt entries and normalize string rewards before replay',async t=>{
  const store=new Map([['vezdehot:pending:'+A,JSON.stringify([null,{},'bad',{kind:'result',value:null},{kind:'unexpected',value:{}},{kind:'result',value:{id:'wrong',game:'unknown',delta:9000}},{kind:'result',value:{id:'valid',game:'durak',win:'false',delta:'250',xp:'25',at:'2026-10-23T12:00:00Z'}},{kind:'patch',value:{nick:'Offline name'}}])]]);
  const h=harness({store,session:session(A),profiles:{[A]:profile('Cloud',30000)}});t.after(()=>h.close());await h.api.ready;
  assert.equal(h.api.getProfile().balance,30250);assert.equal(h.api.getProfile().games,1);assert.equal(h.api.getProfile().wins,0);assert.equal(h.api.getProfile().xp,25);assert.equal(h.api.getProfile().nick,'Offline name');
});

test('an already open account panel unlocks saving and updates cloud status after hydration',async t=>{
  const h=harness({session:session(A)});t.after(()=>h.close());await tick();
  const fields=new Map(['[data-save-state]','[data-save-state-copy]','[data-profile-balance]','[data-sync-profile]','[data-save-profile]','[data-account-exit]','.vh-auth-message'].map(key=>[key,{dataset:{},disabled:true,hidden:false,textContent:'',innerHTML:''}]));
  h.context.document.querySelector=selector=>selector==='#vh-account'?{querySelector:key=>fields.get(key),querySelectorAll:()=>[]}:null;
  h.reads[0].resolve({data:profile('Loaded',12000)});await h.api.ready;
  assert.equal(fields.get('[data-save-profile]').disabled,false);assert.equal(fields.get('[data-account-exit]').disabled,false);
  assert.match(fields.get('[data-save-state-copy]').textContent,/синхронизирован/);assert.equal(fields.get('[data-save-state]').dataset.status,'saved');
  assert.equal(fields.get('[data-sync-profile]').hidden,true);assert.match(fields.get('[data-profile-balance]').innerHTML,/12/);
  h.api.updateProfile({nick:'Unsynced edit'});assert.equal(fields.get('[data-save-state]').dataset.status,'local');assert.match(fields.get('[data-save-state-copy]').textContent,/ожидает отправки/);
  await h.api.sync();assert.equal(fields.get('[data-save-state]').dataset.status,'saved');
});

test('Google discovery refreshes an already open provider button',async t=>{
  const settings=deferred(),h=harness({fetch:()=>settings.promise});t.after(()=>h.close());await h.api.ready;
  const fields=new Map(['[data-save-state]','[data-save-state-copy]','[data-profile-balance]','[data-sync-profile]','[data-save-profile]','[data-account-exit]','.vh-auth-message'].map(key=>[key,{dataset:{},disabled:false,hidden:false,textContent:'',innerHTML:''}]));
  const google={dataset:{provider:'google'},disabled:true,innerHTML:''};
  h.context.document.querySelector=selector=>selector==='#vh-account'?{querySelector:key=>fields.get(key),querySelectorAll:()=>[google]}:null;
  settings.resolve({ok:true,json:async()=>({external:{google:true}})});await tick();
  assert.equal(h.api.account().providers.google,true);assert.equal(google.disabled,false);assert.match(google.innerHTML,/Войти через Google/);
});

test('Google uses the current production origin and cannot start concurrent PKCE flows',async t=>{
  const pending=deferred(),h=harness({origin:'https://vezdehot.greysquid7.chatgpt.site',oauthResponse:pending.promise,fetch:async()=>({ok:true,json:async()=>({external:{google:true}})})});t.after(()=>h.close());await h.api.ready;await tick();
  const first=h.api.login('google');await tick();assert.equal(h.api.account().authPending,true);
  await assert.rejects(()=>h.api.login('google'),/уже выполняется/);
  assert.equal(h.oauthCalls.length,1);assert.equal(h.oauthCalls[0].options.redirectTo,'https://vezdehot.greysquid7.chatgpt.site/auth-callback.html');assert.equal(h.oauthCalls[0].options.skipBrowserRedirect,true);
  pending.resolve({data:{url:'https://project.supabase.co/auth/v1/authorize'}});await first;
  assert.deepEqual(h.navigation,['https://project.supabase.co/auth/v1/authorize']);assert.equal(h.api.account().authPending,false);
});

test('OAuth stays on the current page when its profile cannot survive a redirect',async t=>{
  const options={blockWrite:true,fetch:async()=>({ok:true,json:async()=>({external:{google:true}})})},h=harness(options);t.after(()=>h.close());await h.api.ready;await tick();
  h.api.updateProfile({nick:'Unsaved guest',balance:9876});
  await assert.rejects(()=>h.api.login('google'),/Разреши хранилище сайта/);
  assert.equal(h.oauthCalls.length,0);assert.equal(h.navigation.length,0);assert.equal(h.api.account().authPending,false);assert.equal(h.api.getProfile().balance,9876);
  options.blockWrite=false;await h.api.login('google');
  assert.equal(h.oauthCalls.length,1);assert.equal(JSON.parse(h.store.get('vezdehot:profile:guest')).balance,9876);assert.equal(h.api.account().storagePersisted,true);
});

test('the account panel gives a stable account reference for comparing devices',async t=>{
  const h=harness({session:session(A),profiles:{[A]:profile('Signed player')}});t.after(()=>h.close());await h.api.ready;
  const message={textContent:''};h.context.document.querySelector=selector=>selector==='#vh-account'?{querySelector:key=>key==='.vh-auth-message'?message:null,querySelectorAll:()=>[]}:null;
  h.event('document','vezdehot:telegramready');
  assert.match(message.textContent,/ID аккаунта: aaaaaaaa/);assert.match(message.textContent,/тем же способом/);assert.match(message.textContent,/Гостевой прогресс хранится отдельно/);assert.doesNotMatch(message.textContent,/-aaaa-/);
});

test('a late OAuth response cannot navigate after the active tab is lost',async t=>{
  const pending=deferred(),h=harness({oauthResponse:pending.promise,fetch:async()=>({ok:true,json:async()=>({external:{google:true}})})});t.after(()=>h.close());await h.api.ready;await tick();
  const first=h.api.login('google');h.context.window.VEZDEHOT_TAB_SESSION={canWrite:()=>false};
  pending.resolve({data:{url:'https://project.supabase.co/auth/v1/authorize'}});
  await assert.rejects(()=>first,/Активная вкладка/);assert.equal(h.navigation.length,0);assert.equal(h.api.account().authPending,false);
});

test('a late Telegram proof is not exchanged after another account takes over',async t=>{
  const pending=deferred(),h=harness({config:{telegramMiniAppEnabled:true,telegramAuthUrl:'https://project.supabase.co/functions/v1/telegram-auth'},telegram:{WebApp:{initData:'signed-proof'}},profiles:{[B]:profile('Current account')},fetch:async input=>String(input).includes('/functions/')?pending.promise:{ok:true,json:async()=>({external:{}})}});t.after(()=>h.close());await h.api.ready;
  const first=h.api.login('telegram');h.auth(B);await tick();
  pending.resolve({ok:true,json:async()=>({token_hash:'late-one-use-token',type:'magiclink'})});
  await assert.rejects(()=>first,/Активная вкладка/);assert.equal(h.verifyCalls,0);assert.equal(h.api.account().scope,B);assert.equal(h.api.account().authPending,false);
});

test('OAuth cancellation in a URL fragment stays visible without rendering provider text',async t=>{
  const h=harness({hash:'#error=access_denied&error_description=%3Cscript%3Eevil%3C%2Fscript%3E',session:session(A),profiles:{[A]:profile('Existing account')}});t.after(()=>h.close());await h.api.ready;
  assert.equal(h.api.account().user.id,A);assert.match(h.api.account().error,/Вход отменён/);assert.doesNotMatch(h.api.account().error,/script|evil/);
});

test('failed PKCE initialization is reported even if getSession returns an older account',async t=>{
  const h=harness({search:'?code=expired',initializeResponse:{error:{code:'bad_code_verifier'}},session:session(A),profiles:{[A]:profile('Existing account')}});t.after(()=>h.close());await h.api.ready;
  assert.equal(h.api.account().user.id,A);assert.match(h.api.account().error,/истекло или открыто в другом браузере/);
});

test('callback shows OAuth failure ahead of an older signed-in session and clears URL parameters',async()=>{
  const html=fs.readFileSync(path.join(__dirname,'../dist/auth-callback.html'),'utf8'),script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  const nodes={title:{textContent:''},status:{textContent:''}},replaced=[];
  const api={ready:Promise.resolve(),account:()=>({user:{id:A},status:'saved',error:'Подтверждение входа истекло.'})};
  const ctx={window:{VEZDEHOT:api},VEZDEHOT:api,document:{getElementById:id=>nodes[id]},history:{replaceState:(...args)=>replaced.push(args)},location:{pathname:'/auth-callback.html'}};
  vm.runInNewContext(script,ctx);await tick();
  assert.equal(nodes.title.textContent,'Вход не завершён');assert.match(nodes.status.textContent,/Ранее открытый аккаунт/);assert.equal(replaced[0][2],'/auth-callback.html');
});

for(const game of ['durak','poker']){
const configKey=game==='poker'?'serverPokerUrl':'serverDurakUrl',method=game==='poker'?'serverPokerRequest':'serverDurakRequest',path='/server-'+game;
test('server '+game+' uses only configured endpoint and keeps the access token inside transport',async t=>{
  const h=harness({config:{[configKey]:'https://project.supabase.co/functions/v1'+path},session:{...session(A),access_token:'fixture-token'},profiles:{[A]:profile('Signed player')},fetch:async input=>String(input).endsWith(path)?{ok:true,status:200,json:async()=>({state:null,revision:0})}:{ok:true,json:async()=>({external:{}})}});t.after(()=>h.close());await h.api.ready;
  const result=await h.api[method]({op:'load'}),request=h.requests.find(x=>String(x.input).endsWith(path));
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{ok:true,status:200,data:{state:null,revision:0}});assert.equal(request.opts.headers.Authorization,'Bearer fixture-token');assert.equal(request.opts.headers.apikey,'public');assert.deepEqual(JSON.parse(request.opts.body),{op:'load'});
  assert.equal(JSON.stringify([...h.store]).includes('fixture-token'),false);assert.equal(JSON.stringify(h.api.account()).includes('fixture-token'),false);
});

test('server '+game+' rejects guests and a configured foreign endpoint without making requests',async t=>{
  const guest=harness({config:{[configKey]:'https://project.supabase.co/functions/v1'+path}});t.after(()=>guest.close());await guest.api.ready;await assert.rejects(()=>guest.api[method]({op:'load'}),/войти|войди/);assert.equal(guest.requests.some(x=>String(x.input).endsWith(path)),false);
  const foreign=harness({config:{[configKey]:'https://foreign.test/functions/v1'+path},session:{...session(A),access_token:'fixture-token'},profiles:{[A]:profile('Signed')}});t.after(()=>foreign.close());await foreign.api.ready;await assert.rejects(()=>foreign.api[method]({op:'load'}),/недоступен/);assert.equal(foreign.requests.some(x=>String(x.input).includes('foreign.test')),false);
});

test('server '+game+' rejects a changed auth session before sending a bearer token',async t=>{
  const opts={config:{[configKey]:'https://project.supabase.co/functions/v1'+path},session:{...session(A),access_token:'fixture-A'},profiles:{[A]:profile('A')}};
  const h=harness(opts);t.after(()=>h.close());await h.api.ready;opts.getSession=async()=>({data:{session:{...session(B),access_token:'fixture-B'}}});
  await assert.rejects(()=>h.api[method]({op:'load'}),/Сессия входа истекла/);assert.equal(h.requests.some(x=>String(x.input).endsWith(path)),false);
});

test('server '+game+' drops a late response after tab ownership changes',async t=>{
  const pending=deferred(),h=harness({config:{[configKey]:'https://project.supabase.co/functions/v1'+path},session:{...session(A),access_token:'fixture-token'},profiles:{[A]:profile('A')},fetch:async input=>String(input).endsWith(path)?pending.promise:{ok:true,json:async()=>({external:{}})}});t.after(()=>h.close());await h.api.ready;
  const response=h.api[method]({op:'load'});await tick();h.context.window.VEZDEHOT_TAB_SESSION={canWrite:()=>false};pending.resolve({ok:true,status:200,json:async()=>({state:{private:'old account'}})});
  await assert.rejects(()=>response,error=>error.code==='STALE_ACCOUNT');
});

test('server '+game+' preserves structured server errors for the caller',async t=>{
  const h=harness({config:{[configKey]:'https://project.supabase.co/functions/v1'+path},session:{...session(A),access_token:'fixture-token'},profiles:{[A]:profile('A')},fetch:async input=>String(input).endsWith(path)?{ok:false,status:409,json:async()=>({error:'conflict',revision:9})}:{ok:true,json:async()=>({external:{}})}});t.after(()=>h.close());await h.api.ready;
  const response=await h.api[method]({op:'action'});assert.equal(response.ok,false);assert.equal(response.status,409);assert.equal(response.data.error,'conflict');assert.equal(response.data.revision,9);
});
}
