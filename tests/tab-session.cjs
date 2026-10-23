'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../dist/tab-session.js'),'utf8');
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}};

class Target{
  constructor(){this.listeners=new Map()}
  addEventListener(type,fn,options){const handlers=this.listeners.get(type)||[];handlers.push({fn,once:options?.once});this.listeners.set(type,handlers)}
  removeEventListener(type,fn){this.listeners.set(type,(this.listeners.get(type)||[]).filter(x=>x.fn!==fn))}
  dispatchEvent(event){for(const item of [...(this.listeners.get(event.type)||[])]){item.fn(event);if(item.once)this.removeEventListener(event.type,item.fn)}return true}
}
class Element extends Target{
  constructor(tag,doc){super();this.tagName=tag.toUpperCase();this.doc=doc;this.children=[];this.attributes=new Map();this.dataset={};this.inert=false;this.hidden=false;this.disabled=false;this.isConnected=false;this.textContent=''}
  append(...nodes){for(const node of nodes){node.parent=this;node.isConnected=this.isConnected;this.children.push(node)}}
  setAttribute(key,value){this.attributes.set(key,String(value))}
  getAttribute(key){return this.attributes.get(key)??null}
  contains(node){return this===node||this.children.some(child=>child.contains(node))}
  focus(){this.doc.activeElement=this;this.doc.dispatchEvent({type:'focusin',target:this})}
  find(predicate){if(predicate(this))return this;for(const child of this.children){const found=child.find(predicate);if(found)return found}return null}
}
class Locks{
  constructor(){this.names=new Map();this.requests=[]}
  request(name,options,callback){
    this.requests.push({name,...options});
    if(options.steal)throw new Error('Stealing locks is forbidden');
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
    if(state.holder||!state.queue.length)return;
    const job=state.queue.shift();state.holder=job;
    Promise.resolve().then(()=>{
      if(state.holder!==job)return;
      job.started=true;job.options.signal?.removeEventListener('abort',job.abort);
      return Promise.resolve(job.callback({name:'test'})).then(job.resolve,job.reject).finally(()=>{if(state.holder===job)state.holder=null;this.next(state)});
    }).catch(job.reject);
  }
}
function world(options={}){
  const locks=new Locks(),tabs=[],store=new Map(),channels=new Set();
  return {
    locks,store,
    tab(tabOptions={}){
      const document=new Target();document.createElement=tag=>new Element(tag,document);document.body=document.createElement('body');document.body.isConnected=true;
      const app=document.createElement('main');document.body.append(app);const trigger=document.createElement('button');app.append(trigger);document.activeElement=trigger;
      const window=new Target(),events=[],timers=new Set();let reloads=0;
      const timer=(fn,ms)=>{const id=setTimeout(()=>{timers.delete(id);fn()},tabOptions.fastTimeout?Math.min(ms,25):ms);id.unref?.();timers.add(id);return id};
      const localStorage={getItem:key=>store.get(key)??null,setItem:(key,value)=>{if(tabOptions.storageBlocked)throw new Error('Storage denied');const oldValue=store.get(key)??null;store.set(key,value);if(!options.disableSignals)for(const tab of tabs)if(tab.window!==window)queueMicrotask(()=>tab.window.dispatchEvent({type:'storage',key,oldValue,newValue:value}))}};
      class Channel{
        constructor(name){this.name=name;this.closed=false;channels.add(this)}
        postMessage(data){if(options.disableSignals)return;for(const peer of channels)if(peer!==this&&!peer.closed&&peer.name===this.name)queueMicrotask(()=>peer.onmessage?.({data}))}
        close(){this.closed=true;channels.delete(this)}
      }
      const context={window,document,localStorage,navigator:tabOptions.noLocks?{}:{locks},location:{reload:()=>reloads++},crypto:require('node:crypto').webcrypto,
        BroadcastChannel:tabOptions.noChannel?undefined:Channel,AbortController,CustomEvent:class{constructor(type,init){this.type=type;this.detail=init?.detail}},setTimeout:timer,clearTimeout:id=>{clearTimeout(id);timers.delete(id)},console};
      vm.createContext(context);vm.runInContext(source,context);
      const api=window.VEZDEHOT_TAB_SESSION;
      for(const type of ['vezdehot:sessionpause','vezdehot:sessionlost','vezdehot:sessionactive'])document.addEventListener(type,event=>events.push({type:event.type,detail:event.detail,writable:api.canWrite()}));
      const tab={window,document,app,trigger,api,events,timers,context,storage:localStorage,get reloads(){return reloads},get overlay(){return document.body.find(x=>x.id==='vh-session-overlay')},
        get button(){return this.overlay?.find(x=>x.tagName==='BUTTON')},get title(){return this.overlay?.find(x=>x.id==='vh-session-title')},
        close(){window.dispatchEvent({type:'pagehide'});for(const id of timers)clearTimeout(id);timers.clear()}};
      tabs.push(tab);return tab;
    },
    close(){for(const tab of tabs)tab.close()}
  };
}

test('one writer: the second start remains pending with an accessible, focused dialog',async t=>{
  const w=world();t.after(()=>w.close());const a=w.tab(),b=w.tab();await a.api.start('guest');let booted=false;
  b.api.start('guest').then(()=>booted=true);await tick();
  assert.equal(a.api.canWrite(),true);assert.equal(b.api.canWrite(),false);assert.equal(booted,false);
  assert.equal(b.title.textContent,'Игра открыта в другой вкладке');assert.equal(b.app.inert,true);assert.equal(b.overlay.inert,false);
  assert.equal(b.overlay.find(x=>x.getAttribute('role')==='dialog').getAttribute('aria-modal'),'true');assert.equal(b.document.activeElement,b.button);
  assert.equal(w.locks.requests[1].ifAvailable,true);assert.equal(b.timers.size,0);
});

test('handoff saves while writable, awaits flush, then grants the next writer; old page reloads',async t=>{
  const w=world();t.after(()=>w.close());const a=w.tab(),b=w.tab(),flush=deferred();let flushCount=0;
  await a.api.start('guest',{beforeYield:()=>{flushCount++;return flush.promise}});const ready=b.api.start('guest');await tick();
  const first=b.api.requestControl(),duplicate=b.api.requestControl();assert.equal(first,duplicate);await tick();
  assert.equal(flushCount,1);assert.equal(a.api.canWrite(),false);assert.equal(b.api.canWrite(),false);assert.equal(a.api.status().ownsLock,true);
  const pause=a.events.find(x=>x.type==='vezdehot:sessionpause');assert.equal(pause.writable,true);assert.equal(pause.detail.scope,'guest');
  flush.resolve();await ready;await first;await tick();
  assert.equal(a.events.find(x=>x.type==='vezdehot:sessionlost').writable,false);assert.equal(b.api.canWrite(),true);assert.equal(b.app.inert,false);assert.equal(b.overlay.hidden,true);
  await a.api.requestControl();await tick();assert.equal(a.reloads,1);assert.equal(a.api.canWrite(),false);assert.equal(a.api.status().state,'reloading');assert.equal(b.api.canWrite(),false);
});

test('storage events provide handoff when BroadcastChannel is unavailable',async t=>{
  const w=world();t.after(()=>w.close());const a=w.tab({noChannel:true}),b=w.tab({noChannel:true});await a.api.start('guest');const ready=b.api.start('guest');await tick();
  await b.api.requestControl();await ready;assert.equal(b.api.canWrite(),true);assert.equal(a.api.canWrite(),false);
});

test('BroadcastChannel still works when localStorage writes are blocked',async t=>{
  const w=world();t.after(()=>w.close());const a=w.tab({storageBlocked:true}),b=w.tab({storageBlocked:true});await a.api.start('guest');const ready=b.api.start('guest');await tick();
  await b.api.requestControl();await ready;assert.equal(b.api.canWrite(),true);assert.equal(w.store.size,0);
});

test('an unresponsive owner is never stolen; timeout aborts the queue and permits retry',async t=>{
  const w=world({disableSignals:true});t.after(()=>w.close());const a=w.tab(),b=w.tab({fastTimeout:true});await a.api.start('guest');b.api.start('guest');await tick();
  assert.equal(await b.api.requestControl(),false);assert.equal(a.api.canWrite(),true);assert.equal(b.api.canWrite(),false);assert.equal(b.api.status().pending,false);assert.equal(b.button.disabled,false);assert.equal(b.button.textContent,'Попробовать ещё раз');assert.equal(b.timers.size,0);
  a.close();await tick();assert.equal(b.api.canWrite(),false);await b.api.requestControl();assert.equal(b.api.canWrite(),true);
});

test('missing Web Locks fails closed with a visible explanation and rejects startup',async t=>{
  const w=world();t.after(()=>w.close());const a=w.tab({noLocks:true});await assert.rejects(a.api.start('guest'),error=>error.code==='LOCKS_UNAVAILABLE');
  assert.equal(a.api.canWrite(),false);assert.equal(a.title.textContent,'Нужен современный браузер');assert.equal(a.button.disabled,false);assert.equal(a.app.inert,true);assert.equal(w.locks.requests.length,0);
});

test('pagehide saves synchronously, releases without waiting for a cloud flush; bfcache reloads',async t=>{
  const w=world();t.after(()=>w.close());const a=w.tab(),b=w.tab();let flushes=0;await a.api.start('guest',{beforeYield:()=>{flushes++;return new Promise(()=>{})}});
  b.api.start('guest');await tick();a.window.dispatchEvent({type:'pagehide'});assert.equal(a.events.find(x=>x.type==='vezdehot:sessionpause').writable,true);assert.equal(a.api.canWrite(),false);assert.equal(flushes,0);
  await b.api.requestControl();assert.equal(b.api.canWrite(),true);a.window.dispatchEvent({type:'pageshow',persisted:true});assert.equal(a.reloads,1);assert.equal(a.api.canWrite(),false);
});

test('external account changes pause the old scope and require reload without wrong-scope writes',async t=>{
  const w=world();t.after(()=>w.close());const a=w.tab();await a.api.start('guest');a.window.dispatchEvent({type:'storage',key:'vezdehot:active',newValue:'"guest"'});assert.equal(a.api.canWrite(),true);
  a.window.dispatchEvent({type:'storage',key:'vezdehot:active',newValue:'"account-b"'});assert.equal(a.api.canWrite(),false);const pause=a.events.find(x=>x.type==='vezdehot:sessionpause');assert.equal(pause.writable,true);assert.equal(pause.detail.scope,'guest');assert.equal(a.title.textContent,'Профиль изменился');
  await a.api.requestControl();assert.equal(a.reloads,1);assert.equal(a.api.canWrite(),false);
});

test('different profiles own different locks; unrelated handoff signals do not pause them',async t=>{
  const w=world();t.after(()=>w.close());const a=w.tab(),b=w.tab(),c=w.tab();await a.api.start('account-a');await b.api.start('account-b');c.api.start('account-a');await tick();await c.api.requestControl();
  assert.equal(b.api.canWrite(),true);assert.equal(b.events.some(x=>x.type==='vezdehot:sessionpause'),false);assert.equal(c.api.canWrite(),true);assert.equal(a.api.canWrite(),false);
});

test('failed beforeYield retains the lock and pauses writes until a successful retry',async t=>{
  const w=world();t.after(()=>w.close());const a=w.tab(),b=w.tab({fastTimeout:true});let fail=true;
  await a.api.start('guest',{beforeYield:async()=>{if(fail)throw new Error('offline')}});b.api.start('guest');await tick();const waiting=b.api.requestControl();await tick();
  assert.equal(a.api.status().state,'save-error');assert.equal(a.api.status().ownsLock,true);assert.equal(a.api.canWrite(),false);assert.equal(b.api.canWrite(),false);assert.equal(a.button.textContent,'Повторить сохранение');
  fail=false;await a.api.release('retry');await waiting;assert.equal(b.api.canWrite(),true);
  assert.deepEqual(a.events.filter(x=>x.type==='vezdehot:sessionpause').map(x=>x.writable),[true,true]);
});

test('explicit profile switch flushes the old scope and boots the new scope without reloading',async t=>{
  const w=world();t.after(()=>w.close());const a=w.tab(),flush=deferred();await a.api.start('guest',{beforeYield:()=>flush.promise});const switched=a.api.start('account-a');await tick();
  assert.equal(a.api.canWrite(),false);assert.equal(a.api.status().scope,'guest');assert.equal(a.events.find(x=>x.type==='vezdehot:sessionpause').detail.scope,'guest');flush.resolve();await switched;
  assert.equal(a.api.status().scope,'account-a');assert.equal(a.api.canWrite(),true);assert.equal(a.reloads,0);
});

test('a later explicit scope supersedes an earlier waiting scope without granting stale writes',async t=>{
  const w=world();t.after(()=>w.close());const blocker=w.tab(),a=w.tab();await blocker.api.start('account-a');const first=a.api.start('account-a');const rejected=assert.rejects(first,error=>error.code==='SESSION_SUPERSEDED');await tick();
  await a.api.start('account-b');await rejected;assert.equal(a.api.canWrite(),true);assert.equal(a.api.status().scope,'account-b');assert.equal(a.reloads,0);
});

test('initial guest-to-account hydration does not send game-loss events before boot',async t=>{
  const w=world();t.after(()=>w.close());const a=w.tab();let flushed=false;await a.api.start('guest',{beforeYield:()=>{flushed=true}});await a.api.start('account-a',{initial:true});
  assert.equal(flushed,true);assert.equal(a.api.status().scope,'account-a');assert.equal(a.api.canWrite(),true);assert.equal(a.events.some(x=>x.type==='vezdehot:sessionpause'||x.type==='vezdehot:sessionlost'),false);
});

test('a failed scope-switch flush stays pending and a synchronous-error retry finishes the switch',async t=>{
  const w=world();t.after(()=>w.close());const a=w.tab();let fail=true,finished=false;
  await a.api.start('guest',{beforeYield:()=>{if(fail)throw new Error('Disk unavailable')}});const switched=a.api.start('account-a').then(()=>finished=true);await tick();
  assert.equal(finished,false);assert.equal(a.api.status().state,'save-error');assert.equal(a.api.status().scope,'guest');assert.equal(a.api.canWrite(),false);
  fail=false;a.button.onclick();await switched;assert.equal(a.api.status().scope,'account-a');assert.equal(a.api.canWrite(),true);assert.equal(a.reloads,0);
});

test('superseding a switch during its flush only grants the latest desired profile',async t=>{
  const w=world();t.after(()=>w.close());const a=w.tab(),flush=deferred();await a.api.start('guest',{beforeYield:()=>flush.promise});
  const first=a.api.start('account-a'),rejected=assert.rejects(first,error=>error.code==='SESSION_SUPERSEDED');const second=a.api.start('account-b');flush.resolve();await second;await rejected;
  assert.equal(a.api.status().scope,'account-b');assert.equal(a.api.canWrite(),true);assert.equal(w.locks.requests.some(x=>x.name==='vezdehot:writer:account-a'),false);
});

test('pagehide before an initial lock callback prevents initialization and writes',async t=>{
  const w=world();t.after(()=>w.close());const a=w.tab();let booted=false;a.api.start('guest').then(()=>booted=true);a.window.dispatchEvent({type:'pagehide'});await tick();
  assert.equal(a.api.canWrite(),false);assert.equal(booted,false);assert.equal(a.events.some(x=>x.type==='vezdehot:sessionactive'),false);
});

test('dialog traps keyboard focus and restores prior inert state after acquisition',async t=>{
  const w=world();t.after(()=>w.close());const owner=w.tab(),a=w.tab();a.app.inert=true;await owner.api.start('guest');a.api.start('guest');await tick();let prevented=false;
  a.document.dispatchEvent({type:'keydown',key:'Tab',shiftKey:true,preventDefault:()=>prevented=true});assert.equal(prevented,true);assert.equal(a.document.activeElement,a.button);
  await a.api.requestControl();assert.equal(a.app.inert,true);assert.equal(a.overlay.hidden,true);
});
