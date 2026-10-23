'use strict';
// Runs the shipped coordinator and identity layer together. Layout is covered in browser QA.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const sources=['tab-session.js','platform.js'].map(file=>fs.readFileSync(path.join(__dirname,'../dist',file),'utf8'));
const A='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}};
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
const session=id=>({user:{id,identities:[],app_metadata:{}}});
const cloud=(nickname,balance=10000)=>({nickname,balance,games:0,wins:0,xp:0,preferences:{}});
const plain=value=>JSON.parse(JSON.stringify(value));
class Target{
  constructor(){this.listeners=new Map()}
  addEventListener(type,fn){const list=this.listeners.get(type)||[];list.push(fn);this.listeners.set(type,list)}
  dispatchEvent(event){for(const fn of this.listeners.get(event.type)||[])fn(event);return true}
}
class Locks{
  constructor(){this.names=new Map()}
  request(name,options,callback){
    let state=this.names.get(name);if(!state){state={holder:null,queue:[]};this.names.set(name,state)}
    if(options.ifAvailable&&(state.holder||state.queue.length))return Promise.resolve().then(()=>callback(null));
    return new Promise((resolve,reject)=>{
      const job={callback,resolve,reject,options,started:false};
      job.abort=()=>{if(job.started)return;state.queue=state.queue.filter(x=>x!==job);if(state.holder===job)state.holder=null;reject(Object.assign(new Error('Aborted'),{name:'AbortError'}));this.next(state)};
      if(options.signal?.aborted){job.abort();return}
      options.signal?.addEventListener('abort',job.abort,{once:true});state.queue.push(job);this.next(state);
    });
  }
  next(state){
    if(state.holder||!state.queue.length)return;const job=state.queue.shift();state.holder=job;
    Promise.resolve().then(()=>{
      if(state.holder!==job)return;job.started=true;job.options.signal?.removeEventListener('abort',job.abort);
      return Promise.resolve(job.callback({name:'test'})).then(job.resolve,job.reject).finally(()=>{if(state.holder===job)state.holder=null;this.next(state)});
    }).catch(job.reject);
  }
}
function world({store=new Map(),remote=new Map()}={}){
  const locks=new Locks(),tabs=[],channels=new Set(),blockers=[];
  return {store,remote,locks,
    async block(scope){const held=deferred(),acquired=deferred();locks.request('vezdehot:writer:'+scope,{mode:'exclusive'},()=>{acquired.resolve();return held.promise});blockers.push(held);await acquired.promise;return ()=>held.resolve()},
    tab(options={}){
      const document=new Target(),window=new Target(),events=[],timers=new Set(),localWrites=[],reads=[],writes=[],inserts=[],navigation=[];
      let authCallback,blocked=!!options.blockWrite,ready=false;
      Object.assign(document,{body:null,hidden:false,documentElement:{dataset:{}},querySelector:()=>null,querySelectorAll:()=>[]});
      const originalDispatch=document.dispatchEvent.bind(document);document.dispatchEvent=event=>{events.push({type:event.type,detail:event.detail,writable:window.VEZDEHOT_TAB_SESSION?.canWrite(),ready});return originalDispatch(event)};
      const localStorage={getItem:key=>store.get(key)??null,setItem(key,value){if(blocked===true||typeof blocked==='function'&&blocked(key))throw new Error('Quota exceeded');const oldValue=store.get(key)??null;value=String(value);store.set(key,value);localWrites.push({key,value});for(const tab of tabs)if(tab.window!==window)queueMicrotask(()=>tab.window.dispatchEvent({type:'storage',key,oldValue,newValue:value}))}};
      class Channel{constructor(name){this.name=name;channels.add(this)}postMessage(data){for(const other of channels)if(other!==this&&other.name===this.name)queueMicrotask(()=>other.onmessage?.({data}))}close(){channels.delete(this)}}
      const timer=(fn,ms)=>{const id=setTimeout(()=>{timers.delete(id);fn()},ms===700?60000:ms);id.unref?.();timers.add(id);return id};
      const client={auth:{getSession:()=>options.sessionPromise||Promise.resolve({data:{session:options.session||null}}),onAuthStateChange:fn=>{authCallback=fn;return {data:{subscription:{unsubscribe(){}}}}},signOut:async()=>({}),signInWithOAuth:async()=>({}),linkIdentity:async()=>({})},from:table=>({
        select(){return this},eq(key,id){this.id=id;return this},order(){return this},
        maybeSingle(){const job={id:this.id,...deferred()};reads.push(job);if(!options.pauseReads)job.resolve({data:remote.get(this.id)??null});return job.promise},
        limit(){return Promise.resolve({data:[]})},
        upsert(row){const job={row:plain(row),...deferred()};writes.push(job);if(!options.pauseWrites)job.resolve({});return job.promise.then(result=>{if(!result.error)remote.set(row.id,{nickname:row.nickname,balance:row.balance,xp:row.xp,wins:row.wins,games:row.games,preferences:row.preferences});return result})},
        insert(row){inserts.push(plain(row));return Promise.resolve({})}
      })};
      Object.assign(window,{VEZDEHOT_AUTH_CONFIG:options.offline?{}:{url:'https://project.supabase.co',publishableKey:'public'},supabase:{createClient:()=>client}});
      const context={window,document,localStorage,navigator:{locks},BroadcastChannel:Channel,location:{search:'',origin:'https://app.test',assign:url=>navigation.push(url),reload:()=>navigation.push('reload')},crypto:require('node:crypto').webcrypto,
        CustomEvent:class{constructor(type,init){this.type=type;this.detail=init?.detail}},AbortController,URLSearchParams,fetch:async()=>({ok:true,json:async()=>({external:{}})}),setTimeout:timer,clearTimeout:id=>{clearTimeout(id);timers.delete(id)},console};
      vm.createContext(context);for(const source of sources)vm.runInContext(source,context);const api=window.VEZDEHOT;api.ready.then(()=>ready=true);
      const tab={window,document,context,api,coordinator:window.VEZDEHOT_TAB_SESSION,events,localWrites,reads,writes,inserts,navigation,get ready(){return ready},setBlocked:value=>{blocked=value},auth:id=>authCallback('SIGNED_IN',id?session(id):null),close(){window.dispatchEvent({type:'pagehide'});for(const timer of timers)clearTimeout(timer);timers.clear()}};
      tabs.push(tab);return tab;
    },
    close(){for(const tab of tabs)tab.close();for(const blocker of blockers)blocker.resolve()}
  };
}

test('waiting platform writes nothing, then reads the latest profile after acquiring the lock',async t=>{
  const w=world();t.after(()=>w.close());const a=w.tab({offline:true});await a.api.ready;a.api.updateProfile({nick:'Before wait',balance:9300});
  const b=w.tab({offline:true});await tick();assert.equal(b.ready,false);assert.equal(b.localWrites.length,0);assert.equal(b.coordinator.canWrite(),false);
  a.api.updateProfile({nick:'Latest owner',balance:8700});await b.coordinator.requestControl();await b.api.ready;
  assert.equal(b.api.getProfile().nick,'Latest owner');assert.equal(b.api.getProfile().balance,8700);assert.equal(a.coordinator.canWrite(),false);
  const snapshot=plain(a.api.getProfile()),count=a.localWrites.length;
  assert.equal(a.api.updateProfile({balance:1}).ok,false);assert.equal(a.api.recordResult({id:'stale',game:'poker',delta:500}).ok,false);assert.equal(a.api.saveMainState({stale:true}),false);await a.api.sync();
  assert.deepEqual(plain(a.api.getProfile()),snapshot);assert.equal(a.localWrites.length,count);
});

test('a hydration response after session loss cannot overwrite saved or in-memory profile',async t=>{
  const w=world({store:new Map([['vezdehot:active',JSON.stringify(A)],['vezdehot:profile:'+A,JSON.stringify({nick:'Local before load',balance:8123})]])});t.after(()=>w.close());
  const h=w.tab({session:session(A),pauseReads:true});await tick();assert.equal(h.reads.length,1);const before=plain(h.api.getProfile());h.window.dispatchEvent({type:'pagehide'});const count=h.localWrites.length;
  h.reads[0].resolve({data:cloud('Late server',99999)});await h.api.ready;
  assert.deepEqual(plain(h.api.getProfile()),before);assert.equal(h.localWrites.length,count);assert.equal(JSON.parse(w.store.get('vezdehot:profile:'+A)).balance,8123);
});

test('failed durable result saves retry the same accepted id without paying twice',async t=>{
  const w=world();t.after(()=>w.close());const h=w.tab({offline:true});await h.api.ready;const saved=w.store.get('vezdehot:profile:guest');h.setBlocked(true);
  const result={id:'durable-result',game:'poker',delta:140,xp:90,win:true};assert.equal(h.api.recordResult(result).ok,false);assert.equal(h.api.account().storagePersisted,false);
  assert.equal(h.api.getProfile().balance,10140);assert.equal(h.api.getProfile().games,1);assert.equal(w.store.get('vezdehot:profile:guest'),saved);
  assert.equal(h.api.recordResult(result).ok,false);assert.equal(h.api.getProfile().games,1);h.setBlocked(false);assert.equal(h.api.recordResult(result).ok,true);
  assert.equal(h.api.getProfile().balance,10140);assert.equal(h.api.getProfile().games,1);assert.equal(JSON.parse(w.store.get('vezdehot:profile:guest')).resultIds.filter(id=>id===result.id).length,1);
});

test('handoff holds the lock until cloud flush settles and new owner hydrates the saved profile',async t=>{
  const w=world({store:new Map([['vezdehot:active',JSON.stringify(A)]]),remote:new Map([[A,cloud('Cloud A',25000)]])});t.after(()=>w.close());
  const a=w.tab({session:session(A),pauseWrites:true});await a.api.ready;a.api.updateProfile({nick:'Saved before transfer'});
  const b=w.tab({session:session(A)});await tick();const transfer=b.coordinator.requestControl();await tick();
  assert.equal(a.writes.length,1);assert.equal(a.writes[0].row.nickname,'Saved before transfer');assert.equal(a.coordinator.status().ownsLock,true);assert.equal(a.coordinator.canWrite(),false);assert.equal(b.ready,false);
  assert.equal(a.api.recordResult({id:'during-transfer',game:'poker',delta:100}).ok,false);
  a.writes[0].resolve({});await transfer;await b.api.ready;
  assert.equal(a.coordinator.status().ownsLock,false);assert.equal(b.coordinator.canWrite(),true);assert.equal(b.api.getProfile().nick,'Saved before transfer');assert.equal(b.api.getProfile().balance,25000);
});

test('profile switch flushes the previous account before taking the next account lock',async t=>{
  const w=world({store:new Map([['vezdehot:active',JSON.stringify(A)]]),remote:new Map([[A,cloud('A',12000)],[B,cloud('B',34000)]])});t.after(()=>w.close());
  const h=w.tab({session:session(A),pauseWrites:true});await h.api.ready;h.api.updateProfile({nick:'A final edit'});h.auth(B);await tick();
  assert.equal(h.api.scopeKey(),A);assert.equal(h.coordinator.status().scope,A);assert.equal(h.writes.length,1);assert.equal(h.writes[0].row.id,A);
  h.writes[0].resolve({});await tick();await tick();
  assert.equal(h.api.scopeKey(),B);assert.equal(h.coordinator.status().scope,B);assert.equal(h.api.getProfile().balance,34000);assert.equal(JSON.parse(w.store.get('vezdehot:profile:'+A)).nick,'A final edit');
  assert.equal(h.api.recordResult({id:'old-page',game:'poker',delta:200}).ok,false);assert.ok(h.navigation.length>0);
});

test('unsaved local progress prevents transfer until retry succeeds',async t=>{
  const w=world();t.after(()=>w.close());const a=w.tab({offline:true});await a.api.ready;a.setBlocked(true);a.api.recordResult({id:'pending-result',game:'poker',delta:100});
  const b=w.tab({offline:true});await tick();const transfer=b.coordinator.requestControl();await tick();
  assert.equal(a.coordinator.status().state,'save-error');assert.equal(a.coordinator.status().ownsLock,true);assert.equal(b.ready,false);
  a.setBlocked(false);assert.equal(await a.coordinator.release('retry'),true);await transfer;await b.api.ready;
  assert.equal(b.api.getProfile().balance,10100);assert.equal(b.api.getProfile().games,1);
});

test('initial authenticated scope change never unlocks a game document already frozen by sessionlost',async t=>{
  const w=world({remote:new Map([[A,cloud('Signed-in A')]])});t.after(()=>w.close());const h=w.tab({session:session(A)});await h.api.ready;
  const frozeBeforeReady=h.events.some(event=>event.type==='vezdehot:sessionlost'&&!event.ready);
  assert.ok(!frozeBeforeReady||h.navigation.length>0,'initial scope change must reload or avoid freezing game listeners before ready');
});

test('superseded initial activation cannot resolve ready while the latest account is still locked',async t=>{
  const w=world({remote:new Map([[A,cloud('A')],[B,cloud('B')]])});t.after(()=>w.close());await w.block(A);const releaseB=await w.block(B);
  const h=w.tab({session:session(A)});await tick();assert.equal(h.ready,false);h.auth(B);await tick();await tick();
  assert.equal(h.coordinator.status().scope,B);assert.equal(h.coordinator.canWrite(),false);assert.equal(h.ready,false,'ready must follow the newest pending activation');
  releaseB();await h.coordinator.requestControl();await h.api.ready;assert.equal(h.api.scopeKey(),B);assert.equal(h.api.getProfile().nick,'B');
});

test('pagehide during a pending cloud handoff revokes even the privileged flush writes',async t=>{
  const w=world({store:new Map([['vezdehot:active',JSON.stringify(A)]]),remote:new Map([[A,cloud('A')]])});t.after(()=>w.close());
  const a=w.tab({session:session(A),pauseWrites:true});await a.api.ready;a.api.updateProfile({nick:'Unfinished cloud flush'});
  const b=w.tab({session:session(A)});await tick();const transfer=b.coordinator.requestControl();await tick();assert.equal(a.writes.length,1);
  a.window.dispatchEvent({type:'pagehide'});const count=a.localWrites.length;await transfer;await b.api.ready;
  b.api.updateProfile({nick:'Current owner'});a.writes[0].resolve({});await tick();
  assert.equal(a.localWrites.length,count,'an old flush must not retain privileged local write permission after pagehide');
  assert.equal(JSON.parse(w.store.get('vezdehot:profile:'+A)).nick,'Current owner');
});

test('external account change cannot replay a stale active-scope pointer from pending storage',async t=>{
  const w=world({store:new Map([['vezdehot:active',JSON.stringify(A)]]),remote:new Map([[A,cloud('A')]])});t.after(()=>w.close());
  const h=w.tab({session:session(A)});await h.api.ready;h.setBlocked(true);h.api.updateProfile({nick:'Pending A edit'});h.setBlocked(false);
  w.store.set('vezdehot:active',JSON.stringify(B));h.window.dispatchEvent({type:'storage',key:'vezdehot:active',oldValue:JSON.stringify(A),newValue:JSON.stringify(B)});
  assert.equal(h.coordinator.canWrite(),false);assert.equal(JSON.parse(w.store.get('vezdehot:active')),B,'synchronous pause recovery must not select the old account again');
});


test('a reward is not acknowledged until its hydration replay queue is durable',async t=>{
  const w=world({store:new Map([['vezdehot:active',JSON.stringify(A)]])});t.after(()=>w.close());const h=w.tab({session:session(A),pauseReads:true});await tick();
  h.setBlocked(key=>key==='vezdehot:pending:'+A);const result={id:'reward-during-hydration',game:'poker',delta:140,xp:90,win:true};
  assert.equal(h.api.recordResult(result).ok,false,'a profile snapshot alone cannot replace a pending hydration operation');
  assert.equal(h.api.getProfile().games,1);h.setBlocked(false);assert.equal(h.api.recordResult(result).ok,true);
  assert.equal(JSON.parse(w.store.get('vezdehot:pending:'+A)).filter(op=>op.value.id===result.id).length,1);
  h.reads[0].resolve({data:cloud('Cloud A',25000)});await h.api.ready;assert.equal(h.api.getProfile().balance,25140);assert.equal(h.api.getProfile().games,1);
});
