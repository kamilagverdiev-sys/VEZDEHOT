/* Shared identity and practice profile. A guest and every account have separate storage. */
(()=>{
'use strict';
const LEGACY='vezdehot_v2',PREFIX='vezdehot:profile:',ACTIVE='vezdehot:active';
const BASE={nick:'Игрок',balance:10000,xp:0,wins:0,games:0,bonusAt:0,avatar:'✦',durakPace:'calm',reduceMotion:false,history:[],resultIds:[],dirty:false,revision:0};
const config=window.VEZDEHOT_AUTH_CONFIG||{},esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let storageFailed=false,handoffFlush=false,activePointerStale=false;const memoryStore=new Map(),ephemeralKeys=new Set();
function ownsProfile(){return window.VEZDEHOT_TAB_SESSION?.canWrite()!==false}
const stored=k=>{if(ephemeralKeys.has(k))return memoryStore.get(k)||null;try{return localStorage.getItem(k)}catch{storageFailed=true;return memoryStore.get(k)||null}};
const read=(k,f={})=>{try{return JSON.parse(stored(k))??f}catch{return f}};
const write=(k,v)=>{if((!ownsProfile()&&!handoffFlush)||(k===ACTIVE&&activePointerStale))return false;let value;try{value=JSON.stringify(v)}catch{return false}memoryStore.set(k,value);try{localStorage.setItem(k,value);ephemeralKeys.delete(k);storageFailed=ephemeralKeys.size>0;return true}catch{ephemeralKeys.add(k);storageFailed=true;return false}};
const num=(v,f=0)=>Number.isFinite(+v)?Math.max(0,Math.min(2000000000,Math.floor(+v))):f;
const timestamp=v=>Number.isFinite(+v)?Math.max(0,Math.min(Number.MAX_SAFE_INTEGER,Math.floor(+v))):0;
const avatars=['✦','◈','♠','✿','△','☾','✹','◇'];
const PROFILE_FIELDS=['nick','balance','xp','wins','games','bonusAt','avatar','durakPace','reduceMotion'];
const NETWORK_TIMEOUT=8000;
function clean(x={}){x=x&&typeof x==='object'&&!Array.isArray(x)?x:{};return {...BASE,nick:String(x.nick||x.nickname||'Игрок').trim().slice(0,24)||'Игрок',balance:num(x.balance,10000),xp:num(x.xp),wins:num(x.wins),games:num(x.games),bonusAt:timestamp(x.bonusAt),avatar:avatars.includes(x.avatar)?x.avatar:'✦',durakPace:['calm','normal','quick'].includes(x.durakPace)?x.durakPace:'calm',reduceMotion:!!x.reduceMotion,history:Array.isArray(x.history)?x.history.filter(v=>v&&typeof v==='object').slice(0,30).map(v=>({...v})):[],resultIds:Array.isArray(x.resultIds)?x.resultIds.map(String).slice(-300):[],dirty:!!x.dirty,revision:num(x.revision)}}
function bounded(promise){let timer;return Promise.race([Promise.resolve(promise),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Network timeout')),NETWORK_TIMEOUT+1000)})]).finally(()=>clearTimeout(timer))}
async function networkFetch(input,options={}){const controller=new AbortController(),upstream=options.signal||input?.signal;const abort=()=>controller.abort();if(upstream?.aborted)abort();else upstream?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,NETWORK_TIMEOUT);try{return await fetch(input,{...options,signal:controller.signal})}finally{clearTimeout(timer);upstream?.removeEventListener('abort',abort)}}

// The remembered scope enables offline play; it does not establish an authenticated session.
let scope=read(ACTIVE,'guest');if(typeof scope!=='string'||!/^([a-f0-9-]{36}|guest)$/.test(scope))scope='guest';
let profile=clean(read(PREFIX+scope,BASE)),client=null,user=null,booted=false,syncTimer=null,syncFlight=null;
let cloudState='local',authError='',providers={google:!!config.googleEnabled,telegram:!!config.telegramEnabled};
let activationEpoch=0,activationRequest=0,activationFlight=null,hydrating=false,cloudHydrated=false,hydrationOps=pendingOperations(scope),accountSwitching=false;
let resolveReady;const ready=new Promise(r=>resolveReady=r);
function current(id,epoch){return (ownsProfile()||handoffFlush)&&scope===id&&user?.id===id&&activationEpoch===epoch}
function compatibility(){if(!ownsProfile()&&!handoffFlush)return false;const saved=write(PREFIX+scope,profile);write(ACTIVE,scope);document.documentElement.dataset.motion=profile.reduceMotion?'reduced':'full';return saved&&ephemeralKeys.size===0}
function getProfile(){return {...profile,history:profile.history.map(x=>({...x})),resultIds:[...profile.resultIds]}}
function emit(){document.dispatchEvent(new CustomEvent('vezdehot:profile',{detail:getProfile()}));refreshAccountProviders()}
function applyPatch(target,patch){const next={...target};let changed=false;for(const key of PROFILE_FIELDS)if(patch[key]!==undefined&&patch[key]!==next[key]){next[key]=patch[key];changed=true}return changed?clean({...next,dirty:true,revision:target.revision+1}):target}
function applyResult(target,entry){if(target.resultIds.includes(entry.id))return target;return clean({...target,balance:Math.max(0,target.balance+entry.delta),xp:target.xp+entry.xp,wins:target.wins+(entry.win?1:0),games:target.games+1,history:[entry,...target.history],resultIds:[...target.resultIds,entry.id],dirty:true,revision:target.revision+1})}
function pendingOperations(id){const saved=read('vezdehot:pending:'+id,[]);if(!Array.isArray(saved))return [];return saved.filter(op=>op&&typeof op==='object'&&op.value&&typeof op.value==='object'&&!Array.isArray(op.value)&&(op.kind==='patch'||(op.kind==='result'&&typeof op.value.id==='string'&&op.value.id.length&&['durak','bunker','poker','mafia','monopoly'].includes(op.value.game)))).map(op=>op.kind==='patch'?{kind:'patch',value:op.value}:{kind:'result',value:{...op.value,id:op.value.id.slice(0,100),win:op.value.win===true,delta:Math.max(-2000000,Math.min(2000000,Math.floor(Number(op.value.delta)||0))),xp:num(op.value.xp),synced:false}})}
function applyOperation(target,op){return op.kind==='patch'?applyPatch(target,op.value):applyResult(target,op.value)}
function mutate(op){if(accountSwitching||!ownsProfile())return {...getProfile(),ok:false,persisted:false};retryLocalProfile();const next=applyOperation(profile,op);if(next===profile){const persisted=compatibility();return {...getProfile(),ok:true,persisted}}if(scope!=='guest'&&(hydrating||!cloudHydrated)){hydrationOps.push(op);write('vezdehot:pending:'+scope,hydrationOps)}profile=next;if(user&&cloudHydrated)cloudState='local';const persisted=compatibility();emit();queueSync();return {...getProfile(),ok:true,persisted}}
function updateProfile(patch={}){const safe={};for(const key of PROFILE_FIELDS)if(patch[key]!==undefined)safe[key]=patch[key];return mutate({kind:'patch',value:safe})}
function saveMainState(state){if(accountSwitching||!ownsProfile())return false;return write('vezdehot:lobby:v1:'+scope,{...state,...getProfile()})}
function loadMainState(){const saved=read('vezdehot:lobby:v1:'+scope,read('vezdehot:main:'+scope,scope==='guest'?read(LEGACY,{}):{}));return {...saved,...getProfile()}}
function recordResult(result){if(!result||!['durak','bunker','poker','mafia','monopoly'].includes(result.game))return {...getProfile(),ok:false};const id=String(result.id||crypto.randomUUID()).slice(0,100),delta=Math.max(-2000000,Math.min(2000000,Math.floor(Number(result.delta)||0)));const resultState=mutate({kind:'result',value:{id,game:result.game,win:!!result.win,delta,xp:num(result.xp),at:new Date().toISOString(),synced:false}});return {...resultState,ok:resultState.ok&&resultState.persisted}}
function canSync(){return !!((ownsProfile()||handoffFlush)&&client&&user&&!user.is_anonymous&&scope===user.id&&cloudHydrated&&!hydrating&&!accountSwitching)}
function queueSync(){clearTimeout(syncTimer);if(canSync()&&profile.dirty)syncTimer=setTimeout(sync,700)}
function dbProfile(p,id){return {id,nickname:p.nick.length<2?p.nick+'!':p.nick,balance:p.balance,xp:p.xp,wins:p.wins,games:p.games,preferences:{avatar:p.avatar,durakPace:p.durakPace,reduceMotion:p.reduceMotion,bonusAt:p.bonusAt},updated_at:new Date().toISOString()}}
function sync(){
  if(syncFlight){const existing=syncFlight;return existing.promise.then(()=>{if(canSync()&&profile.dirty&&(scope!==existing.id||profile.revision!==existing.rev))return sync()})}
  if(!canSync()||!profile.dirty)return Promise.resolve();
  clearTimeout(syncTimer);const id=user.id,epoch=activationEpoch,rev=profile.revision,snapshot=getProfile(),job={id,rev,promise:null};syncFlight=job;cloudState='syncing';refreshAccountProviders();
  job.promise=(async()=>{try{
    const result=await bounded(client.from('profiles').upsert(dbProfile(snapshot,id),{onConflict:'id'}));
    if(!current(id,epoch))return;if(result.error)throw result.error;
    for(const item of snapshot.history.filter(x=>!x.synced)){
      if(!current(id,epoch))return;
      const q=await bounded(client.from('player_results').insert({user_id:id,id:item.id,game:item.game,win:item.win,delta:item.delta,xp:item.xp,played_at:item.at}));
      if(!current(id,epoch))return;if(q.error&&q.error.code!=='23505')throw q.error;
    }
    const ids=new Set(snapshot.history.map(x=>x.id));profile.history.forEach(x=>{if(ids.has(x.id))x.synced=true});
    if(profile.revision===rev)profile.dirty=false;compatibility();cloudState=profile.dirty?'local':'saved';
  }catch{if(current(id,epoch))cloudState='offline'}finally{
    if(syncFlight===job)syncFlight=null;
    // An old account's completion must never change the active account's profile or status.
    if(current(id,epoch))emit();
    if(canSync()&&profile.dirty&&(scope!==id||profile.revision!==rev))queueSync();
  }})();return job.promise;
}
function activate(session){
  const nextUser=session?.user&&!session.user.is_anonymous?session.user:null,next=nextUser?.id||'guest';
  if(scope===next&&(user?.id||null)===(nextUser?.id||null)&&(hydrating||cloudHydrated)){user=nextUser;emit();return hydrating&&activationFlight?activationFlight:Promise.resolve()}
  activationFlight=performActivate(nextUser,next);return activationFlight;
}
async function performActivate(nextUser,next){
  const request=++activationRequest,changed=scope!==next;clearTimeout(syncTimer);write(PREFIX+scope,profile);
  if(changed&&window.VEZDEHOT_TAB_SESSION){await window.VEZDEHOT_TAB_SESSION.start(next,{beforeYield:flushBeforeYield,initial:!booted});if(request!==activationRequest)return}
  const epoch=++activationEpoch;
  if(changed){
    if(booted){accountSwitching=true;document.dispatchEvent(new CustomEvent('vezdehot:accountchange',{detail:{from:scope,to:next}}))}
    scope=next;profile=clean(read(PREFIX+scope,BASE));
  }
  user=nextUser;hydrating=!!user;cloudHydrated=!user;hydrationOps=pendingOperations(scope);cloudState=user?'loading':'local';
  compatibility();emit();
  if(nextUser){const id=nextUser.id,initial=getProfile();try{
    const q=await bounded(client.from('profiles').select('nickname,balance,xp,wins,games,preferences').eq('id',id).maybeSingle());
    if(!current(id,epoch))return;if(q.error)throw q.error;
    let base=initial;
    if(q.data&&!(initial.dirty&&read('vezdehot:cloud-known:'+id,false))){
      const pendingIds=new Set(hydrationOps.filter(op=>op.kind==='result').map(op=>op.value.id));
      base=clean({...initial,...q.data,...q.data.preferences,nick:q.data.nickname,dirty:false,resultIds:initial.resultIds.filter(value=>!pendingIds.has(value)),history:initial.history.filter(value=>!pendingIds.has(value.id))});
      const history=await bounded(client.from('player_results').select('id,game,win,delta,xp,played_at').eq('user_id',id).order('played_at',{ascending:false}).limit(30));
      if(!current(id,epoch))return;
      if(!history.error){base.history=(history.data||[]).map(x=>({...x,at:x.played_at,synced:true}));base.resultIds=[...new Set([...base.resultIds,...base.history.map(x=>x.id)])].slice(-300)}
    }else if(!q.data){base=clean({...initial,dirty:true,nick:initial.nick==='Игрок'?String(nextUser.user_metadata?.name||nextUser.user_metadata?.full_name||'Игрок').slice(0,24):initial.nick})}
    if(!current(id,epoch))return;
    // Replay only edits made while this account was loading, onto its own cloud snapshot.
    profile=hydrationOps.reduce(applyOperation,base);cloudHydrated=true;write('vezdehot:cloud-known:'+id,true);write('vezdehot:pending:'+id,[]);cloudState=profile.dirty?'local':'saved';
  }catch{if(!current(id,epoch))return;cloudState='offline'}
  if(!current(id,epoch))return;
  }
  if(epoch!==activationEpoch)return;
  hydrating=false;if(cloudHydrated)hydrationOps=[];compatibility();if(user&&profile.dirty)queueSync();emit();
  if(booted&&changed)location.assign('./index.html');
}
function hasMiniAppData(){return !!(config.telegramMiniAppEnabled&&config.telegramAuthUrl&&typeof window.Telegram?.WebApp?.initData==='string'&&window.Telegram.WebApp.initData.length)}
function refreshTelegramProvider(){providers.telegram=!!config.telegramEnabled||hasMiniAppData()}
async function checkProviders(){refreshTelegramProvider();if(!config.url)return;try{const r=await bounded(networkFetch(config.url+'/auth/v1/settings',{headers:{apikey:config.publishableKey}}));if(r.ok){const x=await bounded(r.json());providers.google=!!x.external?.google;refreshTelegramProvider()}}catch{}}
async function init(){
  try{if(window.VEZDEHOT_TAB_SESSION)await window.VEZDEHOT_TAB_SESSION.start(scope,{beforeYield:flushBeforeYield})}catch{cloudState='offline';authError='Эта вкладка не получила управление игрой.';return}
  // Another tab may have changed the profile while this page was waiting for its lock.
  if(scope==='guest'&&!stored(PREFIX+'guest'))write(PREFIX+'guest',clean(read(LEGACY,read('uniq_play_v1',BASE))));
  profile=clean(read(PREFIX+scope,BASE));hydrationOps=pendingOperations(scope);
  compatibility();if(!window.supabase||!config.url){cloudState=scope==='guest'?'local':'offline';booted=true;resolveReady();return}
  try{
    client=window.supabase.createClient(config.url,config.publishableKey,{auth:{flowType:'pkce',persistSession:true,autoRefreshToken:true,detectSessionInUrl:true},global:{fetch:networkFetch}});
    const params=new URLSearchParams(location.search);if(params.has('error'))authError='Вход отменён или не завершён. Гостевой прогресс сохранён.';
    client.auth.onAuthStateChange((event,session)=>{if(event==='SIGNED_IN'||event==='SIGNED_OUT'||event==='USER_UPDATED')setTimeout(()=>{if(!ownsProfile()&&booted)return;activationFlight=activate(session);activationFlight.catch(()=>{})},0)});
    const epoch=activationEpoch,request=activationRequest;const {data,error}=await bounded(client.auth.getSession());if(error)throw error;
    if(epoch===activationEpoch&&request===activationRequest)activationFlight=activate(data.session);
    while(activationFlight){const pending=activationFlight;try{await pending}catch(error){if(error?.code==='SESSION_SUPERSEDED'&&activationFlight!==pending)continue;throw error}if(activationFlight===pending)break}
  }catch{cloudState='offline';authError='Не удалось связаться с сервисом входа. Можно продолжить гостем.'}
  finally{booted=true;resolveReady();checkProviders();emit()}
}
function account(){refreshTelegramProvider();const identities=user?.identities?.map(x=>x.provider)||[];if(user?.app_metadata?.telegram_id&&!identities.includes('custom:telegram'))identities.push('custom:telegram');return {user:user?{id:user.id,email:user.email||'',providers:identities}:null,scope,status:cloudState,error:authError,loading:hydrating,switching:accountSwitching,providers:{...providers},storagePersisted:!storageFailed}}
async function login(provider,link=false){
  if(!ownsProfile())throw new Error('Продолжи игру в активной вкладке.');
  if(accountSwitching||hydrating)throw new Error('Профиль загружается. Подожди немного.');
  if(!client)throw new Error('Нет соединения с сервисом входа. Попробуй позже.');
  refreshTelegramProvider();
  if(!['google','telegram'].includes(provider)||!providers[provider])throw new Error('Этот способ входа ещё подключается. Играй гостем — прогресс сохранится на устройстве.');
  if(provider==='telegram'&&hasMiniAppData()){
    if(user||link)throw new Error('Для входа через Telegram сначала выйди из текущего аккаунта. Профили останутся отдельно.');
    const response=await bounded(networkFetch(config.telegramAuthUrl,{method:'POST',headers:{'Content-Type':'application/json',apikey:config.publishableKey},body:JSON.stringify({initData:window.Telegram.WebApp.initData})}));
    const payload=await bounded(response.json());
    if(!response.ok||typeof payload.token_hash!=='string'||payload.type!=='magiclink')throw new Error('Telegram не подтвердил вход. Открой игру заново через бота или продолжи гостем.');
    const result=await bounded(client.auth.verifyOtp({token_hash:payload.token_hash,type:'magiclink'}));
    if(result.error||!result.data?.session)throw new Error('Не удалось завершить вход через Telegram. Попробуй открыть игру через бота ещё раз.');
    await activate(result.data.session);return;
  }
  if(link&&(!user||!config.manualLinkingEnabled))throw new Error('Подключение второго способа входа ещё не включено.');
  const id=scope;write(PREFIX+scope,profile);if(user)await sync();if(scope!==id||accountSwitching)return;
  const options={redirectTo:location.origin+'/auth-callback.html'},p=provider==='telegram'?config.telegramProvider:'google';
  const result=await bounded(link?client.auth.linkIdentity({provider:p,options}):client.auth.signInWithOAuth({provider:p,options}));
  if(result.error)throw new Error('Вход не завершён. Попробуй ещё раз или продолжи гостем.');
}
async function signOut(){if(!ownsProfile()||!client||!user||accountSwitching)return;const id=user.id;await sync();if(!ownsProfile()||user?.id!==id||scope!==id)return;const {error}=await bounded(client.auth.signOut({scope:'local'}));if(error)throw new Error('Не удалось выйти. Проверь соединение и повтори.');await activate(null)}
function canImportGuest(){return !!(ownsProfile()&&user&&cloudHydrated&&!hydrating&&!accountSwitching&&profile.games===0&&profile.xp===0&&profile.wins===0&&profile.balance===BASE.balance&&!profile.history.length&&!read('vezdehot:guest-import:'+user.id,false)&&read(PREFIX+'guest',{}).games>0)}
function importGuest(){
  if(!canImportGuest())return false;const guest=clean(read(PREFIX+'guest',BASE)),marker='vezdehot:guest-import:'+user.id;
  // The import marker is deliberately outside clean(): profile normalization cannot erase it.
  if(!write(marker,{at:Date.now()}))return false;
  profile=clean({...profile,balance:guest.balance,xp:guest.xp,wins:guest.wins,games:guest.games,bonusAt:Math.max(profile.bonusAt,guest.bonusAt),history:guest.history.map(x=>({...x,synced:false})),resultIds:guest.resultIds,revision:profile.revision+1,dirty:true});
  cloudState='local';compatibility();emit();queueSync();return true;
}
const names={durak:'Дурак',poker:'Покер',bunker:'Бункер',mafia:'Мафия',monopoly:'Монополия'};
const recoveryNotices=new Map(),acknowledgedRecovery=new Set();
function retryLocalProfile(){
  if(!ownsProfile()&&!handoffFlush)return false;
  for(const key of [...ephemeralKeys]){try{if(key===ACTIVE){const durable=JSON.parse(localStorage.getItem(ACTIVE));if(activePointerStale||durable&&durable!==scope){ephemeralKeys.delete(key);memoryStore.delete(key);continue}}localStorage.setItem(key,memoryStore.get(key));ephemeralKeys.delete(key)}catch{}}
  storageFailed=ephemeralKeys.size>0;return !storageFailed;
}
async function flushBeforeYield(){
  // Web Lock is still held, but gameplay permission has already been suspended.
  handoffFlush=true;
  try{
    clearTimeout(syncTimer);await sync();retryLocalProfile();
    if(ephemeralKeys.size||Object.keys(names).some(game=>window.VEZDEHOT_GAME_STORE?.status(game,scope).pending))throw new Error('Unsaved local progress');
  }finally{handoffFlush=false}
}
function renderSaveNotice(game,id=scope){
  const actual=window.VEZDEHOT_GAME_STORE?.status(game,id)||{status:'empty'},recovery=recoveryNotices.get(id+':'+game);
  const status=recovery&&!['corrupt','unavailable'].includes(actual.status)?{...actual,status:'recovered',message:recovery}:actual,warning=(['corrupt','unavailable'].includes(status.status)||status.status==='recovered'&&!acknowledgedRecovery.has(id+':'+game))||storageFailed;
  const title=status.status==='recovered'?'Партия восстановлена':status.status==='corrupt'?'Не удалось прочитать сохранение':'Не удалось сохранить прогресс';
  const message=storageFailed?'Браузер не разрешил записать данные. Прогресс пока доступен в этой вкладке; не закрывай её до успешного сохранения.':status.message;
  return `<aside class="vh-game-save" data-game-save="${esc(game)}" data-save-scope="${esc(id)}" data-status="${esc(status.status)}" role="status" aria-live="polite" ${warning?'':'hidden'}><span class="vh-game-save-mark" aria-hidden="true">${status.status==='recovered'?'↻':'!'}</span><div><strong>${title}</strong><p>${esc(message)}</p></div>${status.pending||storageFailed?'<button type="button" data-retry-game-save>Повторить сохранение</button>':status.status==='recovered'?'<button type="button" data-dismiss-game-save>Понятно</button>':''}</aside>`;
}
function refreshSaveNotices(){
  document.querySelectorAll?.('[data-game-save]').forEach(node=>{if(node.dataset.saveScope===scope)node.outerHTML=renderSaveNotice(node.dataset.gameSave,scope)});
}
function bindSaveNotice(){refreshSaveNotices()}
document.addEventListener('vezdehot:save-status',event=>{if(event.detail?.status==='recovered'){const key=event.detail.scope+':'+event.detail.game;recoveryNotices.set(key,event.detail.message);acknowledgedRecovery.delete(key)}refreshSaveNotices()});
document.addEventListener('click',event=>{
  const button=event.target?.closest?.('[data-retry-game-save], [data-dismiss-game-save]'),notice=button?.closest('[data-game-save]');
  if(!notice||notice.dataset.saveScope!==scope||!ownsProfile())return;
  if(button.hasAttribute('data-dismiss-game-save')){const key=scope+':'+notice.dataset.gameSave;recoveryNotices.delete(key);acknowledgedRecovery.add(key);refreshSaveNotices();return}
  retryLocalProfile();window.VEZDEHOT_GAME_STORE?.retry(notice.dataset.gameSave,scope);refreshSaveNotices();refreshAccountProviders();
});
document.addEventListener('vezdehot:sessionpause',event=>{
  if(event.detail?.reason==='account-change'){activePointerStale=true;ephemeralKeys.delete(ACTIVE);memoryStore.delete(ACTIVE)}
  clearTimeout(syncTimer);retryLocalProfile();
  for(const game of Object.keys(names))if(window.VEZDEHOT_GAME_STORE?.status(game,scope).pending)window.VEZDEHOT_GAME_STORE.retry(game,scope);
});
document.addEventListener('vezdehot:sessionlost',()=>{handoffFlush=false;clearTimeout(syncTimer);activationEpoch++;activeDialog?.close(false)});
function toast(message){let e=document.getElementById('vh-toast');if(!e){e=document.createElement('div');e.id='vh-toast';e.className='vh-toast';e.setAttribute('role','status');document.body.appendChild(e)}e.textContent=message;e.classList.add('show');clearTimeout(e._timer);e._timer=setTimeout(()=>e.classList.remove('show'),3500)}
const gameMarks={durak:'♠',poker:'♦',bunker:'◈',mafia:'☾',monopoly:'▦'};
const avatarNames=['Искра','Кристалл','Пика','Цветок','Треугольник','Луна','Солнце','Ромб'];
const prettyNumber=value=>Number(value||0).toLocaleString('ru-RU');
let activeDialog=null;
function normalizeHistoryFilters(options={}){return {game:Object.hasOwn(names,options.game)?options.game:'all',outcome:['win','other'].includes(options.outcome)?options.outcome:'all'}}
function getHistory(options={}){
  const filters=normalizeHistoryFilters(options);
  return profile.history.filter(entry=>Object.hasOwn(names,entry.game)).map((entry,index)=>{
    const time=typeof entry.at==='string'?Date.parse(entry.at):NaN;
    return {id:String(entry.id||'entry-'+index),game:entry.game,win:entry.win===true,delta:Number.isFinite(Number(entry.delta))?Math.max(-2000000,Math.min(2000000,Math.floor(Number(entry.delta)))):0,xp:num(entry.xp),at:Number.isFinite(time)?new Date(time).toISOString():'',synced:entry.synced===true};
  }).filter(entry=>(filters.game==='all'||entry.game===filters.game)&&(filters.outcome==='all'||(filters.outcome==='win'?entry.win:!entry.win)))
    .sort((a,b)=>(b.at?Date.parse(b.at):-Infinity)-(a.at?Date.parse(a.at):-Infinity));
}
function getHistorySummary(options={}){
  const entries=getHistory(options),wins=entries.filter(entry=>entry.win).length;
  return {total:entries.length,wins,other:entries.length-wins,credited:entries.reduce((sum,entry)=>sum+Math.max(0,entry.delta),0),xp:entries.reduce((sum,entry)=>sum+entry.xp,0),winRate:entries.length?Math.round(wins/entries.length*100):0,
    byGame:Object.entries(names).map(([game,label])=>({game,label,count:entries.filter(entry=>entry.game===game).length,wins:entries.filter(entry=>entry.game===game&&entry.win).length})),
    lifetime:{games:profile.games,wins:profile.wins,xp:profile.xp,balance:profile.balance},retainedLimit:30};
}
function mountDialog(id,content,extraClass=''){
  const returnFocus=activeDialog?.returnFocus||document.activeElement;activeDialog?.close(false);
  const overlay=document.createElement('div');overlay.id=id;overlay.className='vh-overlay';
  overlay.innerHTML=`<section class="vh-modal ${extraClass}" role="dialog" aria-modal="true" aria-labelledby="${id}-title" tabindex="-1">${content}</section>`;
  const previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';document.body.appendChild(overlay);
  const backgrounds=[...document.body.children].filter(node=>node!==overlay&&node.id!=='vh-toast').map(node=>({node,inert:node.inert}));backgrounds.forEach(item=>item.node.inert=true);
  const cleanup=[];const dialog={overlay,returnFocus,cleanup,close(restore=true){cleanup.forEach(fn=>fn());overlay.remove();document.body.style.overflow=previousOverflow;backgrounds.forEach(item=>item.node.inert=item.inert);if(activeDialog===dialog)activeDialog=null;if(restore&&returnFocus?.isConnected!==false)returnFocus?.focus?.()}};activeDialog=dialog;
  overlay.querySelector('.vh-close').onclick=()=>dialog.close();
  overlay.addEventListener('click',event=>{if(event.target===overlay)dialog.close()});
  overlay.addEventListener('keydown',event=>{
    event.stopPropagation();
    if(event.key==='Escape'){event.preventDefault();dialog.close();return}
    if(event.key!=='Tab')return;
    const focusable=[...overlay.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')].filter(node=>!node.hidden&&node.getClientRects().length);
    const first=focusable[0],last=focusable.at(-1);if(!first){event.preventDefault();overlay.querySelector('.vh-modal').focus();return}
    if(event.shiftKey&&(document.activeElement===first||!overlay.contains(document.activeElement))){event.preventDefault();last.focus()}
    else if(!event.shiftKey&&(document.activeElement===last||!overlay.contains(document.activeElement))){event.preventDefault();first.focus()}
  });
  overlay.querySelector('.vh-close').focus();return dialog;
}
function modalHeading(id,kicker,title,description){return `<header class="vh-sheet-header"><div class="vh-sheet-heading"><span class="vh-kicker">${kicker}</span><h2 id="${id}-title">${title}</h2><p class="vh-copy">${description}</p></div><button class="vh-close" type="button" aria-label="Закрыть окно">×</button></header>`}
function historyDateParts(entry){
  if(!entry.at)return {key:'undated',label:'Без даты',time:'Время не сохранено',full:'Дата не сохранена'};
  const date=new Date(entry.at),today=new Date(),day=new Date(date.getFullYear(),date.getMonth(),date.getDate()),todayDay=new Date(today.getFullYear(),today.getMonth(),today.getDate()),yesterday=new Date(todayDay);yesterday.setDate(yesterday.getDate()-1);
  const label=+day===+todayDay?'Сегодня':+day===+yesterday?'Вчера':date.toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:date.getFullYear()===today.getFullYear()?undefined:'numeric'});
  return {key:[date.getFullYear(),date.getMonth(),date.getDate()].join('-'),label,time:date.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}),full:date.toLocaleString('ru-RU',{day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'})};
}
function historyEntryMarkup(entry){
  const date=historyDateParts(entry),unit=entry.game==='poker'?'Стол завершён':'Партия завершена',amount=entry.delta>0?'+'+prettyNumber(entry.delta):entry.delta<0?'−'+prettyNumber(Math.abs(entry.delta)):'0',outcome=entry.win?'Победа':'Без победы',payoutLabel=entry.delta<0?'Списано':'Начислено';
  return `<details class="vh-history-entry" data-history-id="${esc(entry.id)}"><summary><span class="vh-game-mark" data-game="${entry.game}" aria-hidden="true">${gameMarks[entry.game]}</span><span class="vh-history-title"><strong>${names[entry.game]}</strong><span><time datetime="${esc(entry.at)}">${esc(date.time)}</time><span class="vh-dot-separator" aria-hidden="true">·</span><span class="vh-outcome ${entry.win?'is-win':''}">${outcome}</span></span></span><span class="vh-history-payout ${entry.delta>0?'is-credit':''}"><b>${amount}</b><small>${payoutLabel.toLowerCase()}</small></span><span class="vh-entry-chevron" aria-hidden="true">⌄</span></summary><div class="vh-history-detail"><p class="vh-entry-kind">${unit}</p><dl><div><dt>Результат</dt><dd>${outcome}</dd></div><div><dt>Опыт</dt><dd>+${prettyNumber(entry.xp)} XP</dd></div><div><dt>${payoutLabel}</dt><dd>${amount} игровых монет</dd></div><div><dt>Когда</dt><dd>${esc(date.full)}</dd></div><div><dt>Сохранение</dt><dd>${user&&entry.synced?'В облачном профиле':storageFailed?'Только в этой вкладке':'На этом устройстве'}</dd></div></dl><p>${entry.game==='poker'?'Один результат покера — завершённый стол, который может включать несколько раздач. ':''}Начислено — возврат после игры, включая остаток входа. Это не чистая прибыль: вход был списан отдельно.</p></div></details>`;
}
function historyGroupsMarkup(entries){
  const groups=[];for(const entry of entries){const date=historyDateParts(entry);let group=groups.at(-1);if(!group||group.key!==date.key){group={key:date.key,label:date.label,entries:[]};groups.push(group)}group.entries.push(entry)}
  return groups.map(group=>`<section class="vh-history-day" aria-label="${esc(group.label)}"><div class="vh-day-heading"><h3>${esc(group.label)}</h3><span>${group.entries.length}</span></div>${group.entries.map(historyEntryMarkup).join('')}</section>`).join('');
}
function openHistory(options={}){
  let filters=normalizeHistoryFilters(options);const all=getHistory(),summary=getHistorySummary();
  const dialog=mountDialog('vh-history',modalHeading('vh-history','ТВОЙ ПУТЬ В КЛУБЕ','История партий','До 30 последних результатов. В покере один результат — целый завершённый стол.')+`<div class="vh-sheet-content"><div class="vh-history-context"><span><i class="vh-status-dot" aria-hidden="true"></i>${esc(profile.nick)} <span class="vh-context-mode">· ${user?'аккаунт':'гость'}</span></span><span>Всего партий <b data-history-lifetime>${prettyNumber(summary.lifetime.games)}</b></span></div><div class="vh-history-summary" data-history-summary aria-label="Статистика выбранных результатов"></div><div class="vh-history-filters"><label class="vh-label vh-game-filter">Игра<select class="vh-select" data-history-game><option value="all">Все игры · ${all.length}</option>${Object.entries(names).map(([game,label])=>`<option value="${game}" ${filters.game===game?'selected':''}>${label} · ${all.filter(entry=>entry.game===game).length}</option>`).join('')}</select></label><div class="vh-outcome-filter"><span class="vh-label">Результат</span><div class="vh-segments" role="group" aria-label="Фильтр по результату">${[['all','Все'],['win','Победы'],['other','Без победы']].map(([value,label])=>`<button type="button" data-history-outcome="${value}" aria-pressed="${filters.outcome===value}">${label}</button>`).join('')}</div></div></div><div class="vh-results-caption"><span data-history-count role="status" aria-live="polite"></span><button class="vh-text-button" type="button" data-history-reset>Сбросить фильтры</button></div><div data-history-results></div><p class="vh-history-note">История содержит последние сохранённые результаты. Общая статистика профиля учитывает все завершённые партии.</p></div>`,'vh-history-modal');
  const overlay=dialog.overlay;
  const render=()=>{
    const expanded=new Set([...overlay.querySelectorAll('[data-history-id][open]')].map(node=>node.dataset.historyId));
    const focusedEntry=overlay.contains(document.activeElement)?document.activeElement.closest('[data-history-id]')?.dataset.historyId:null;
    const entries=getHistory(filters),stats=getHistorySummary(filters),allEntries=getHistory();
    for(const option of overlay.querySelector('[data-history-game]').options){option.textContent=(option.value==='all'?'Все игры':names[option.value])+' · '+allEntries.filter(entry=>option.value==='all'||entry.game===option.value).length}
    overlay.querySelector('[data-history-lifetime]').textContent=prettyNumber(stats.lifetime.games);
    overlay.querySelector('[data-history-summary]').innerHTML=`<div><span>В выборке</span><strong>${prettyNumber(stats.total)}</strong><small>партий</small></div><div><span>Победы</span><strong>${prettyNumber(stats.wins)}<em>${stats.total?stats.winRate+'%':'—'}</em></strong><small>по результату игры</small></div><div><span>Начислено</span><strong>${prettyNumber(stats.credited)}</strong><small>игровых монет</small></div><div><span>Получено опыта</span><strong>${prettyNumber(stats.xp)}<em>XP</em></strong><small>за эти партии</small></div>`;
    overlay.querySelector('[data-history-count]').textContent=`Показано ${entries.length} из ${getHistory().length}`;
    overlay.querySelector('[data-history-reset]').hidden=filters.game==='all'&&filters.outcome==='all';
    overlay.querySelector('[data-history-results]').innerHTML=entries.length?historyGroupsMarkup(entries):`<div class="vh-empty-history" data-history-empty><span class="vh-empty-mark" aria-hidden="true">${getHistory().length?'⌕':'♧'}</span><h3>${getHistory().length?'Таких партий пока нет':'Первая партия впереди'}</h3><p>${getHistory().length?'Выбери другую игру или сбрось фильтры, чтобы увидеть остальные результаты.':'Заверши любую игру — здесь появятся её результат, начисления и полученный опыт.'}</p><button type="button" class="vh-button ${getHistory().length?'':'primary'}" data-history-empty-action>${getHistory().length?'Показать все результаты':'Вернуться к игре'}</button></div>`;
    overlay.querySelectorAll('[data-history-id]').forEach(node=>{if(expanded.has(node.dataset.historyId))node.open=true;if(focusedEntry===node.dataset.historyId)node.querySelector('summary').focus()});
    overlay.querySelector('[data-history-empty-action]')?.addEventListener('click',()=>{if(getHistory().length)reset();else dialog.close()});
    overlay.querySelectorAll('[data-history-outcome]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.historyOutcome===filters.outcome)));
  };
  const reset=()=>{filters={game:'all',outcome:'all'};overlay.querySelector('[data-history-game]').value='all';render();overlay.querySelector('[data-history-game]').focus()};
  overlay.querySelector('[data-history-game]').addEventListener('change',event=>{filters.game=event.target.value;render()});
  overlay.querySelectorAll('[data-history-outcome]').forEach(button=>button.addEventListener('click',()=>{filters.outcome=button.dataset.historyOutcome;render()}));
  overlay.querySelector('[data-history-reset]').addEventListener('click',reset);
  const onProfile=()=>{if(overlay.isConnected)render()};document.addEventListener('vezdehot:profile',onProfile);dialog.cleanup.push(()=>document.removeEventListener('vezdehot:profile',onProfile));render();
}
function openAccount(){
  const p=getProfile(),a=account(),signed=!!a.user,level=Math.floor(p.xp/300)+1,currentXp=p.xp%300,winRate=p.games?Math.round(p.wins/p.games*100):0;
  const dialog=mountDialog('vh-account',modalHeading('vh-account','ПРОФИЛЬ КЛУБА',signed?'Твоё место за столом':'Начни свою историю',signed?'Игровой образ, результаты и настройки — в одном месте.':'Играй гостем или подключи аккаунт, чтобы сохранить профиль в облаке.')+`<div class="vh-sheet-content"><div class="vh-profile-hero"><span class="vh-avatar" aria-hidden="true">${esc(p.avatar)}</span><div><span class="vh-profile-kind"><i class="vh-status-dot" aria-hidden="true"></i>${signed?'Аккаунт подключён':'Гость · это устройство'}</span><h3>${esc(p.nick)}</h3><span class="vh-profile-xp">${prettyNumber(p.xp)} XP за всё время</span></div><span class="vh-level">УРОВЕНЬ <b>${prettyNumber(level)}</b></span></div><div class="vh-level-progress"><div><span>${currentXp} / 300 XP</span><span>Ещё ${300-currentXp} до уровня ${prettyNumber(level+1)}</span></div><progress max="300" value="${currentXp}" aria-label="Опыт до следующего уровня">${currentXp} из 300</progress></div><div class="vh-profile-stats"><div><b>${prettyNumber(p.games)}</b><small>партий</small></div><div><b>${prettyNumber(p.wins)}</b><small>побед</small></div><div><b>${p.games?winRate+'%':'—'}</b><small>доля побед</small></div></div><div class="vh-wallet"><span><small>Игровой баланс</small><strong data-profile-balance>${prettyNumber(p.balance)} <em>V</em></strong></span><p>Бесплатные монеты клуба<br>Без денежных ставок и вывода</p></div><div class="vh-save-state" data-save-state role="status" aria-live="polite"><span class="vh-save-indicator" aria-hidden="true"></span><span data-save-state-copy>${esc(savingMessage(a))}</span><button type="button" class="vh-text-button" data-sync-profile ${!signed||a.loading||a.switching||a.status!=='offline'?'hidden':''}>Повторить</button></div><button class="vh-history-shortcut" type="button" data-open-history><span class="vh-shortcut-icon" aria-hidden="true">↗</span><span><strong>История партий</strong><small>${getHistory().length?'Сохранено результатов: '+getHistory().length:'Здесь начнётся твой игровой архив'}</small></span><span aria-hidden="true">→</span></button><section class="vh-profile-settings" aria-labelledby="vh-settings-title"><div class="vh-section-heading"><h3 id="vh-settings-title">Твой игровой образ</h3><span>01</span></div><label class="vh-label">Имя за столом<input class="vh-input" data-nickname maxlength="24" minlength="2" value="${esc(p.nick)}" autocomplete="nickname" spellcheck="false" aria-describedby="vh-name-help vh-name-error"></label><div class="vh-field-meta"><span id="vh-name-help">От 2 до 24 символов</span><span data-nickname-count>${p.nick.length}/24</span></div><p class="vh-field-error" id="vh-name-error" role="alert" hidden></p><fieldset class="vh-avatar-fieldset"><legend class="vh-label">Выбери символ</legend><div class="vh-avatar-picker">${avatars.map((value,index)=>`<button type="button" data-avatar="${value}" aria-label="${avatarNames[index]}" aria-pressed="${value===p.avatar}" class="${value===p.avatar?'selected':''}">${value}</button>`).join('')}</div></fieldset><div class="vh-section-heading"><h3>Комфортная игра</h3><span>02</span></div><label class="vh-toggle"><span><strong>Меньше анимации</strong><small>Спокойные переходы и минимум движения</small></span><input type="checkbox" role="switch" data-motion ${p.reduceMotion?'checked':''}></label><fieldset class="vh-pace-fieldset"><legend class="vh-label">Темп ботов в «Дураке»</legend><div class="vh-segments" role="group" aria-label="Темп ботов">${[['calm','Спокойно'],['normal','Обычно'],['quick','Быстро']].map(([value,label])=>`<button type="button" data-pace="${value}" aria-pressed="${value===p.durakPace}">${label}</button>`).join('')}</div></fieldset><button class="vh-button primary vh-save-profile" type="button" data-save-profile ${a.loading||a.switching?'disabled':''}>Сохранить изменения <span aria-hidden="true">↗</span></button></section><section class="vh-profile-auth" aria-labelledby="vh-auth-title"><div class="vh-section-heading"><h3 id="vh-auth-title">${signed?'Способы входа':'Сохранить профиль в облаке'}</h3><span>03</span></div><div class="vh-auth-buttons">${['google','telegram'].map(value=>providerMarkup(value,a)).join('')}</div><p class="vh-auth-message" role="status">${esc(accountMessage(a))}</p>${canImportGuest()?'<button class="vh-button" type="button" data-import>Перенести мой гостевой прогресс</button>':''}<button class="vh-button subtle" type="button" data-account-exit>${signed?'Выйти из аккаунта':'Продолжить гостем →'}</button></section></div>`,'vh-account-modal');
  const overlay=dialog.overlay;let avatar=p.avatar,pace=p.durakPace;
  const nameInput=overlay.querySelector('[data-nickname]');nameInput.addEventListener('input',()=>{overlay.querySelector('[data-nickname-count]').textContent=nameInput.value.length+'/24';nameInput.removeAttribute('aria-invalid');overlay.querySelector('#vh-name-error').hidden=true});
  overlay.querySelector('[data-sync-profile]').onclick=async()=>{if(user&&!cloudHydrated&&!hydrating&&!accountSwitching)await activate({user});else await sync();refreshAccountProviders()};
  overlay.querySelector('[data-open-history]').addEventListener('click',()=>openHistory());
  overlay.querySelectorAll('[data-avatar]').forEach(button=>button.onclick=()=>{avatar=button.dataset.avatar;overlay.querySelectorAll('[data-avatar]').forEach(item=>{item.classList.toggle('selected',item===button);item.setAttribute('aria-pressed',String(item===button))});overlay.querySelector('.vh-avatar').textContent=avatar});
  overlay.querySelectorAll('[data-pace]').forEach(button=>button.onclick=()=>{pace=button.dataset.pace;overlay.querySelectorAll('[data-pace]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)))});
  overlay.querySelector('[data-save-profile]').onclick=()=>{const input=overlay.querySelector('[data-nickname]'),nick=input.value.trim();if(nick.length<2||nick.length>24){const error=overlay.querySelector('#vh-name-error');error.textContent='Введи имя от 2 до 24 символов.';error.hidden=false;input.setAttribute('aria-invalid','true');input.focus();return}updateProfile({nick,avatar,durakPace:pace,reduceMotion:overlay.querySelector('[data-motion]').checked});toast(storageFailed?'Профиль обновлён в этой вкладке. Браузер не разрешил сохранить его.':'Твой профиль обновлён');dialog.close()};
  overlay.querySelectorAll('[data-provider]').forEach(button=>button.onclick=async()=>{if(providerPresentation(button.dataset.provider,account()).openBot){window.open('https://t.me/VesdehotBot','_blank','noopener,noreferrer');overlay.querySelector('.vh-auth-message').textContent='В Telegram открой VesdehotBot и нажми «Играть», затем подтверди вход в игре.';return}button.disabled=true;try{await login(button.dataset.provider,signed)}catch(error){if(!overlay.isConnected)return;refreshAccountProviders();overlay.querySelector('.vh-auth-message').textContent=error.message}});
  overlay.querySelector('[data-account-exit]').onclick=async()=>{if(!signed)return dialog.close();try{await signOut()}catch(error){toast(error.message)}};
  overlay.querySelector('[data-import]')?.addEventListener('click',()=>{if(importGuest()){toast('Гостевой прогресс перенесён');dialog.close()}});
  refreshAccountProviders();checkProviders().then(refreshAccountProviders);
}
function providerPresentation(v,a){
  const name=v==='google'?'Google':'Telegram',connected=a.user?.providers.includes(v==='telegram'?'custom:telegram':v);
  const openBot=v==='telegram'&&!a.user&&config.telegramMiniAppEnabled&&!hasMiniAppData()&&!config.telegramEnabled;
  const linkBlocked=!!a.user&&(!config.manualLinkingEnabled||(v==='telegram'&&hasMiniAppData()));
  return {openBot,text:connected?name+' подключён':openBot?'Открыть в Telegram':a.user?'Подключить '+name:'Войти через '+name,
    disabled:!!(a.loading||a.switching||connected||linkBlocked||(!a.providers[v]&&!openBot)),
    hint:connected?'':openBot?'Подтверждение внутри бота':linkBlocked?'Отдельный способ входа':!a.providers[v]?'Подключается':''};
}
function providerMarkup(v,a){const p=providerPresentation(v,a);return `<button class="vh-button provider" data-provider="${v}" ${p.disabled?'disabled':''}><span>${v==='google'?'G':'↗'}</span>${p.text}${p.hint?'<small>'+p.hint+'</small>':''}</button>`}
function savingMessage(a){if(!a.storagePersisted)return 'Браузер не разрешил сохранить данные на устройстве. Прогресс в этой вкладке может пропасть после её закрытия.';if(!a.user)return 'Гостевой прогресс сохранён на этом устройстве.';if(a.loading)return 'Загружаем твой облачный профиль…';if(a.status==='syncing')return 'Сохраняем изменения в облаке…';if(a.status==='saved')return 'Профиль синхронизирован с облаком. Партия сохраняется на этом устройстве.';if(a.status==='offline')return 'Нет связи с облаком. Изменения сохранены на устройстве; можно повторить синхронизацию.';return 'Изменения сохранены на устройстве. Синхронизация с облаком ожидает отправки.'}
function accountMessage(a){if(authError)return authError;if(a.user)return 'Гостевой прогресс и прогресс аккаунта хранятся отдельно.';if(config.telegramMiniAppEnabled&&!hasMiniAppData()&&!config.telegramEnabled)return 'Вход через Telegram подтверждается в игре внутри бота. Гостевой прогресс остаётся отдельно.';return a.providers.google||a.providers.telegram?'Гостевые результаты остаются отдельно от аккаунта.':'Социальный вход скоро появится. Гостевой режим уже работает.'}
function refreshAccountProviders(){const modal=document.querySelector('#vh-account');if(!modal)return;const a=account(),state=modal.querySelector('[data-save-state]');if(state){state.dataset.status=!a.storagePersisted?'warning':a.loading?'loading':a.status;modal.querySelector('[data-save-state-copy]').textContent=savingMessage(a);modal.querySelector('[data-profile-balance]').innerHTML=prettyNumber(profile.balance)+' <em>V</em>';const retry=modal.querySelector('[data-sync-profile]');retry.hidden=!a.user||a.loading||a.switching||a.status!=='offline';retry.disabled=a.loading||a.switching;modal.querySelector('[data-save-profile]').disabled=a.loading||a.switching;modal.querySelector('[data-account-exit]').disabled=a.loading||a.switching}const message=modal.querySelector('.vh-auth-message');if(message)message.textContent=accountMessage(a);modal.querySelectorAll('[data-provider]').forEach(b=>{const v=b.dataset.provider,p=providerPresentation(v,a);b.disabled=p.disabled;b.innerHTML=`<span>${v==='google'?'G':'↗'}</span>${p.text}${p.hint?'<small>'+p.hint+'</small>':''}`})}
document.addEventListener('vezdehot:accountchange',()=>activeDialog?.close(false));
document.addEventListener('vezdehot:telegramready',()=>{refreshTelegramProvider();refreshAccountProviders();emit()});
window.VEZDEHOT={ready,getProfile,updateProfile,recordResult,scopeKey:()=>scope,saveMainState,loadMainState,account,openAccount,openHistory,getHistory,getHistorySummary,login,signOut,sync,importGuest,canImportGuest,renderSaveNotice,bindSaveNotice,toast,avatars};
window.addEventListener('online',()=>{if(!ownsProfile())return;if(user&&!cloudHydrated&&!hydrating&&!accountSwitching){activationFlight=activate({user});activationFlight.catch(()=>{})}else queueSync()});document.addEventListener('visibilitychange',()=>{if(document.hidden&&profile.dirty)sync()});window.addEventListener('storage',e=>{if(ownsProfile()&&!hydrating&&!accountSwitching&&e.key===PREFIX+scope){const latest=clean(read(e.key));if(latest.revision>profile.revision){profile=latest;emit()}}});
init();
})();
