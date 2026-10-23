/* One writable page per profile. Web Locks owns the truth; messages only request a handoff. */
(()=>{
'use strict';
const LOCK_PREFIX='vezdehot:writer:',SIGNAL='vezdehot:tab-request',ACTIVE='vezdehot:active',WAIT_MS=12000;
const tabId=typeof crypto!=='undefined'&&typeof crypto.randomUUID==='function'?crypto.randomUUID():Math.random().toString(36).slice(2);
let scope=null,phase='idle',owned=false,yielding=false,everOwned=false,invalidated=false,hidden=false;
let requestedScope=null,scopeVersion=0,pendingScopeStart=null;
let startPromise,resolveStart,rejectStart,beforeYield,unlock=null,acquisition=null,yieldFlight=null,channel=null;
let overlay=null,panel,title,copy,note,button,previousFocus,observer,bodyPending=false,displayState=null;
const inertNodes=new Map();
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
const canWrite=()=>owned&&!yielding&&!invalidated&&!hidden&&phase==='active';
const status=()=>Object.freeze({scope,state:phase,canWrite:canWrite(),ownsLock:owned,pending:!!acquisition,needsReload:everOwned&&!canWrite()});
const emit=(type,reason)=>document.dispatchEvent(new CustomEvent(type,{detail:{scope,reason}}));

function inertBackground(){
  if(!overlay||!document.body)return;
  for(const node of document.body.children){
    if(node===overlay||['SCRIPT','STYLE','LINK'].includes(node.tagName))continue;
    if(!inertNodes.has(node))inertNodes.set(node,node.inert);
    node.inert=true;
  }
}
function ensureOverlay(){
  if(overlay)return true;
  if(!document.body){
    if(!bodyPending){bodyPending=true;document.addEventListener('DOMContentLoaded',()=>{bodyPending=false;if(displayState)show(displayState)},{once:true})}
    return false;
  }
  const element=(tag,cls,text)=>{const node=document.createElement(tag);node.className=cls;if(text)node.textContent=text;return node};
  overlay=element('div','vh-session-overlay');overlay.id='vh-session-overlay';
  panel=element('section','vh-session-card');panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-labelledby','vh-session-title');panel.setAttribute('aria-describedby','vh-session-copy vh-session-note');panel.tabIndex=-1;
  const artwork=element('div','vh-session-art');artwork.setAttribute('aria-hidden','true');artwork.append(element('span','vh-session-window'),element('span','vh-session-window vh-session-window-front','✦'));
  title=element('h2','vh-session-title');title.id='vh-session-title';
  copy=element('p','vh-session-copy');copy.id='vh-session-copy';
  note=element('p','vh-session-note');note.id='vh-session-note';note.setAttribute('role','status');note.setAttribute('aria-live','polite');
  button=element('button','vh-session-button');button.type='button';
  panel.append(artwork,element('p','vh-session-eyebrow','VEZDEHOT · ВАША ИГРА'),title,copy,note,button,element('p','vh-session-footnote','Один профиль — одна активная вкладка.'));
  overlay.append(panel);document.body.append(overlay);
  document.addEventListener('keydown',event=>{
    if(!overlay||overlay.hidden)return;
    if(event.key==='Tab'){event.preventDefault();(button.hidden||button.disabled?panel:button).focus()}
    if(event.key==='Escape')event.preventDefault();
  },true);
  document.addEventListener('focusin',event=>{
    if(overlay&&!overlay.hidden&&!overlay.contains(event.target))(button.hidden||button.disabled?panel:button).focus();
  },true);
  return true;
}
function show(state){
  displayState=state;if(hidden||!ensureOverlay())return;
  const wasHidden=overlay.hidden||!previousFocus;
  if(wasHidden)previousFocus=document.activeElement;
  overlay.hidden=false;overlay.dataset.state=phase;
  title.textContent=state.title;copy.textContent=state.copy;note.textContent=state.note||'';
  button.textContent=state.label||'Продолжить здесь';button.disabled=!!state.busy;button.hidden=!!state.noButton;
  button.onclick=state.action||(()=>{void requestControl()});
  inertBackground();
  if(!observer&&typeof MutationObserver==='function'){observer=new MutationObserver(inertBackground);observer.observe(document.body,{childList:true})}
  if(wasHidden||!overlay.contains(document.activeElement))(button.hidden||button.disabled?panel:button).focus();
}
function hide(){
  displayState=null;if(!overlay)return;overlay.hidden=true;
  observer?.disconnect();observer=null;
  for(const [node,value] of inertNodes)node.inert=value;inertNodes.clear();
  const focus=previousFocus;previousFocus=null;
  if(focus?.isConnected&&!focus.inert)focus.focus?.();
}
function showWaiting(timedOut=false){
  show({title:'Игра открыта в другой вкладке',copy:everOwned?'Эта вкладка на паузе. Верните управление, чтобы продолжить с последнего сохранения.':'Продолжите здесь — мы сохраним партию в другой вкладке и перенесём управление.',note:timedOut?'Другая вкладка пока не ответила. Откройте её или закройте, затем попробуйте ещё раз.':'Партии и баланс защищены от одновременных изменений.',label:timedOut?'Попробовать ещё раз':'Продолжить здесь'});
}
function showReload(){show({title:'Профиль изменился',copy:'В другой вкладке выбран другой профиль. Обновите страницу, чтобы загрузить его партии и баланс.',label:'Обновить страницу',action:()=>location.reload()})}
function clearAcquisition(job,result){
  if(job.timer)clearTimeout(job.timer);
  if(acquisition===job)acquisition=null;
  job.resolve(result);
}
function cancelAcquisition(){
  const job=acquisition;if(!job)return;
  acquisition=null;if(job.timer)clearTimeout(job.timer);job.controller?.abort();job.resolve(false);
}
function fail(error){
  phase='unavailable';owned=false;yielding=false;
  show({title:'Нужен современный браузер',copy:'Этот браузер не может безопасно защитить партию от изменений в нескольких вкладках.',note:'Откройте игру по HTTPS в актуальном Chrome, Safari, Firefox или Edge.',label:'Проверить ещё раз',action:()=>location.reload()});
  if(rejectStart){rejectStart(error);rejectStart=null;resolveStart=null}
}
function acquire(queued){
  if(acquisition)return acquisition.promise;
  if(invalidated||hidden||owned||phase==='unavailable')return Promise.resolve(false);
  const job={...deferred(),controller:queued?new AbortController():null,timer:null};acquisition=job;
  phase=queued?'requesting':'checking';
  if(queued){
    show({title:'Переносим управление',copy:'Сохраняем партию в другой вкладке. Игра продолжится здесь, как только сохранение будет готово.',note:'Это обычно занимает несколько секунд.',label:'Ожидаем сохранения…',busy:true});
    job.timer=setTimeout(()=>{
      if(acquisition!==job)return;
      cancelAcquisition();phase='waiting';showWaiting(true);
    },WAIT_MS);
  }
  const options=queued?{mode:'exclusive',signal:job.controller.signal}:{mode:'exclusive',ifAvailable:true};
  let request;
  try{request=navigator.locks.request(LOCK_PREFIX+scope,options,lock=>{
    if(acquisition!==job||invalidated||hidden){clearAcquisition(job,false);return}
    if(!lock){clearAcquisition(job,false);phase='waiting';showWaiting();return}
    const held=deferred();unlock=held.resolve;owned=true;yielding=false;
    clearAcquisition(job,true);
    if(everOwned){
      // The DOM and in-memory game may be stale. Hold the lock until reload/pagehide,
      // and never grant this old document permission to write again.
      phase='reloading';yielding=true;
      show({title:'Возвращаем вашу игру',copy:'Загружаем последнее сохранение и обновляем баланс.',label:'Обновляем страницу…',busy:true});
      location.reload();
    }else{
      everOwned=true;phase='active';hide();
      const resolve=resolveStart;resolveStart=null;rejectStart=null;resolve?.(status());
      emit('vezdehot:sessionactive','acquired');
    }
    return held.promise;
  })}catch(error){clearAcquisition(job,false);fail(error);return job.promise}
  Promise.resolve(request).catch(error=>{
    if(acquisition!==job)return;
    clearAcquisition(job,false);
    if(error?.name!=='AbortError')fail(error);
  });
  return job.promise;
}
function drop(reason,suppressEvents=false){
  const wasOwned=owned;owned=false;yielding=false;phase=invalidated?'account-changed':'waiting';
  // Permission is revoked before listeners run or the queued tab can acquire.
  if(wasOwned&&!suppressEvents)emit('vezdehot:sessionlost',reason);
  const release=unlock;unlock=null;release?.();
  if(!hidden){if(invalidated)showReload();else showWaiting()}
}
function pause(reason,suppressEvents=false){
  // Saves in these synchronous listeners are still authorized for this scope.
  if(canWrite()&&!suppressEvents)emit('vezdehot:sessionpause',reason);
  yielding=true;
}
function release(reason='released',suppressEvents=false){
  if(yieldFlight)return yieldFlight;
  if(!owned){cancelAcquisition();return Promise.resolve(false)}
  // Retry local snapshots only inside the synchronous pause dispatch, while the
  // same Web Lock is still held. Gameplay remains covered by the modal.
  if(phase==='save-error'&&!invalidated&&!hidden){yielding=false;phase='active'}
  pause(reason,suppressEvents);phase='yielding';
  show({title:'Сохраняем вашу игру',copy:'Передаём управление другой вкладке. Эта вкладка останется на паузе.',label:'Сохраняем…',busy:true});
  const ownerUnlock=unlock,flush=beforeYield;
  yieldFlight=Promise.resolve().then(async()=>{
    try{await flush?.();if(owned&&unlock===ownerUnlock)drop(reason,suppressEvents);return true}
    catch{
      // A failed flush is not permission to release unsaved state to another writer.
      if(owned&&unlock===ownerUnlock&&!hidden&&!invalidated){phase='save-error';show({title:'Не удалось завершить сохранение',copy:'Игра на паузе. Проверьте подключение и повторите сохранение перед переходом в другую вкладку.',label:'Повторить сохранение',action:()=>{void release(reason,suppressEvents)}})}
      return false;
    }finally{
      yieldFlight=null;
      const next=pendingScopeStart;
      if(next&&!owned&&!hidden){pendingScopeStart=null;if(next.version===scopeVersion)next.begin()}
    }
  });
  return yieldFlight;
}
function signalControl(){
  const message={type:'request-control',scope,from:tabId,id:tabId+':'+Date.now()+':'+Math.random().toString(36).slice(2)};
  try{channel?.postMessage(message)}catch{}
  // A signal is a request only: storage is never used as a substitute for a lock.
  try{localStorage.setItem(SIGNAL,JSON.stringify(message))}catch{}
}
function receive(message){
  if(!message||message.type!=='request-control'||message.scope!==scope||message.from===tabId||typeof message.id!=='string')return;
  if(owned&&!yielding&&!invalidated&&!hidden)void release('takeover');
}
function requestControl(){
  if(invalidated){location.reload();return Promise.resolve(false)}
  if(canWrite())return Promise.resolve(true);
  if(acquisition)return acquisition.promise;
  if(!scope||owned||hidden||phase==='unavailable')return Promise.resolve(false);
  const result=acquire(true);signalControl();return result;
}
function start(profileScope,options={}){
  if(typeof profileScope!=='string'||!profileScope.length||profileScope.length>120)return Promise.reject(new TypeError('A profile scope is required.'));
  if(startPromise&&profileScope===requestedScope)return startPromise;
  const version=++scopeVersion,changing=scope!==null;
  const superseded=new Error('A newer profile replaced this pending session.');superseded.code='SESSION_SUPERSEDED';
  rejectStart?.(superseded);cancelAcquisition();requestedScope=profileScope;
  startPromise=new Promise((resolve,reject)=>{resolveStart=resolve;rejectStart=reject});
  const begin=()=>{
    if(version!==scopeVersion||hidden)return;
    scope=profileScope;beforeYield=typeof options.beforeYield==='function'?options.beforeYield:null;
    everOwned=false;invalidated=false;yielding=false;phase='idle';
    try{if(!channel&&typeof BroadcastChannel==='function'){channel=new BroadcastChannel('vezdehot:tab-session:v1');channel.onmessage=event=>receive(event.data)}}catch{}
    if(typeof navigator==='undefined'||typeof navigator.locks?.request!=='function'){
      const error=new Error('Web Locks is required to protect game saves.');error.code='LOCKS_UNAVAILABLE';fail(error);
    }else void acquire(false);
  };
  if(changing&&(owned||yieldFlight)){
    // The platform calls this before replacing its old profile, so pause and its
    // beforeYield callback can finish against the old scope.
    pendingScopeStart={version,begin};void release('scope-change',options.initial===true);
  }else{pendingScopeStart=null;begin()}
  return startPromise;
}
window.addEventListener('storage',event=>{
  if(event.key===SIGNAL&&event.newValue){try{receive(JSON.parse(event.newValue))}catch{}}
  if(event.key!==ACTIVE||!scope)return;
  let next;try{next=JSON.parse(event.newValue)}catch{return}
  if(next===scope)return;
  // The old profile remains the target while the synchronous pause listeners save.
  pause('account-change');invalidated=true;cancelAcquisition();drop('account-change');
});
window.addEventListener('pagehide',()=>{
  // pagehide cannot await a cloud flush; local game saves must happen synchronously.
  pause('pagehide');hidden=true;cancelAcquisition();drop('pagehide');channel?.close();channel=null;
});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload()});
window.VEZDEHOT_TAB_SESSION=Object.freeze({start,canWrite,requestControl,release,status});
})();
