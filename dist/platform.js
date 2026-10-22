/* Shared identity and practice profile. A guest and every account have separate storage. */
(()=>{
'use strict';
const LEGACY='vezdehot_v2',PREFIX='vezdehot:profile:',ACTIVE='vezdehot:active';
const BASE={nick:'Игрок',balance:10000,xp:0,wins:0,games:0,bonusAt:0,avatar:'✦',durakPace:'calm',reduceMotion:false,history:[],resultIds:[],dirty:false,revision:0};
const config=window.VEZDEHOT_AUTH_CONFIG||{},esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const read=(k,f={})=>{try{return JSON.parse(localStorage.getItem(k))||f}catch{return f}};
const write=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v));return true}catch{return false}};
const num=(v,f=0)=>Number.isFinite(+v)?Math.max(0,Math.min(2000000000,Math.floor(+v))):f;
const timestamp=v=>Number.isFinite(+v)?Math.max(0,Math.min(Number.MAX_SAFE_INTEGER,Math.floor(+v))):0;
const avatars=['✦','◈','♠','✿','△','☾','✹','◇'];
const PROFILE_FIELDS=['nick','balance','xp','wins','games','bonusAt','avatar','durakPace','reduceMotion'];
const NETWORK_TIMEOUT=8000;
function clean(x={}){return {...BASE,nick:String(x.nick||x.nickname||'Игрок').trim().slice(0,24)||'Игрок',balance:num(x.balance,10000),xp:num(x.xp),wins:num(x.wins),games:num(x.games),bonusAt:timestamp(x.bonusAt),avatar:avatars.includes(x.avatar)?x.avatar:'✦',durakPace:['calm','normal','quick'].includes(x.durakPace)?x.durakPace:'calm',reduceMotion:!!x.reduceMotion,history:Array.isArray(x.history)?x.history.filter(v=>v&&typeof v==='object').slice(0,30).map(v=>({...v})):[],resultIds:Array.isArray(x.resultIds)?x.resultIds.map(String).slice(-300):[],dirty:!!x.dirty,revision:num(x.revision)}}
function bounded(promise){let timer;return Promise.race([Promise.resolve(promise),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Network timeout')),NETWORK_TIMEOUT+1000)})]).finally(()=>clearTimeout(timer))}
async function networkFetch(input,options={}){const controller=new AbortController(),upstream=options.signal||input?.signal;const abort=()=>controller.abort();if(upstream?.aborted)abort();else upstream?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,NETWORK_TIMEOUT);try{return await fetch(input,{...options,signal:controller.signal})}finally{clearTimeout(timer);upstream?.removeEventListener('abort',abort)}}

// The remembered scope enables offline play; it does not establish an authenticated session.
let scope=read(ACTIVE,'guest');if(typeof scope!=='string'||!/^([a-f0-9-]{36}|guest)$/.test(scope))scope='guest';
if(!localStorage.getItem(PREFIX+'guest'))write(PREFIX+'guest',clean(scope==='guest'?read(LEGACY,read('uniq_play_v1',BASE)):BASE));
let profile=clean(read(PREFIX+scope,BASE)),client=null,user=null,booted=false,syncTimer=null,syncFlight=null;
let cloudState='local',authError='',providers={google:!!config.googleEnabled,telegram:!!config.telegramEnabled};
let activationEpoch=0,activationFlight=null,hydrating=false,cloudHydrated=false,hydrationOps=read('vezdehot:pending:'+scope,[]),accountSwitching=false;
let resolveReady;const ready=new Promise(r=>resolveReady=r);
function current(id,epoch){return scope===id&&user?.id===id&&activationEpoch===epoch}
function compatibility(){const old=read(LEGACY,{});write(LEGACY,{...old,...getProfile()});write(PREFIX+scope,profile);write(ACTIVE,scope);document.documentElement.dataset.motion=profile.reduceMotion?'reduced':'full'}
function getProfile(){return {...profile,history:profile.history.map(x=>({...x})),resultIds:[...profile.resultIds]}}
function emit(){document.dispatchEvent(new CustomEvent('vezdehot:profile',{detail:getProfile()}))}
function applyPatch(target,patch){const next={...target};let changed=false;for(const key of PROFILE_FIELDS)if(patch[key]!==undefined&&patch[key]!==next[key]){next[key]=patch[key];changed=true}return changed?clean({...next,dirty:true,revision:target.revision+1}):target}
function applyResult(target,entry){if(target.resultIds.includes(entry.id))return target;return clean({...target,balance:Math.max(0,target.balance+entry.delta),xp:target.xp+entry.xp,wins:target.wins+(entry.win?1:0),games:target.games+1,history:[entry,...target.history],resultIds:[...target.resultIds,entry.id],dirty:true,revision:target.revision+1})}
function applyOperation(target,op){return op.kind==='patch'?applyPatch(target,op.value):applyResult(target,op.value)}
function mutate(op){if(accountSwitching)return getProfile();const next=applyOperation(profile,op);if(next===profile)return getProfile();if(scope!=='guest'&&(hydrating||!cloudHydrated)){hydrationOps.push(op);write('vezdehot:pending:'+scope,hydrationOps)}profile=next;compatibility();emit();queueSync();return getProfile()}
function updateProfile(patch={}){const safe={};for(const key of PROFILE_FIELDS)if(patch[key]!==undefined)safe[key]=patch[key];return mutate({kind:'patch',value:safe})}
function saveMainState(state){if(accountSwitching)return;const pp=getProfile();write('vezdehot:main:'+scope,{...state,...pp});write(LEGACY,{...state,...pp})}
function loadMainState(){const saved=read('vezdehot:main:'+scope,scope==='guest'?read(LEGACY,{}):{});return {...saved,...getProfile()}}
function recordResult(result){if(!result||!['durak','bunker','poker','mafia','monopoly'].includes(result.game))return getProfile();const id=String(result.id||crypto.randomUUID()).slice(0,100),delta=Math.max(-2000000,Math.min(2000000,Math.floor(Number(result.delta)||0)));return mutate({kind:'result',value:{id,game:result.game,win:!!result.win,delta,xp:num(result.xp),at:new Date().toISOString(),synced:false}})}
function canSync(){return !!(client&&user&&!user.is_anonymous&&scope===user.id&&cloudHydrated&&!hydrating&&!accountSwitching)}
function queueSync(){clearTimeout(syncTimer);if(canSync()&&profile.dirty)syncTimer=setTimeout(sync,700)}
function dbProfile(p,id){return {id,nickname:p.nick.length<2?p.nick+'!':p.nick,balance:p.balance,xp:p.xp,wins:p.wins,games:p.games,preferences:{avatar:p.avatar,durakPace:p.durakPace,reduceMotion:p.reduceMotion,bonusAt:p.bonusAt},updated_at:new Date().toISOString()}}
function sync(){
  if(syncFlight){const existing=syncFlight;return existing.promise.then(()=>{if(canSync()&&profile.dirty&&(scope!==existing.id||profile.revision!==existing.rev))return sync()})}
  if(!canSync()||!profile.dirty)return Promise.resolve();
  clearTimeout(syncTimer);const id=user.id,epoch=activationEpoch,rev=profile.revision,snapshot=getProfile(),job={id,rev,promise:null};syncFlight=job;cloudState='syncing';
  job.promise=(async()=>{try{
    const result=await bounded(client.from('profiles').upsert(dbProfile(snapshot,id),{onConflict:'id'}));
    if(!current(id,epoch))return;if(result.error)throw result.error;
    for(const item of snapshot.history.filter(x=>!x.synced)){
      if(!current(id,epoch))return;
      const q=await bounded(client.from('player_results').insert({user_id:id,id:item.id,game:item.game,win:item.win,delta:item.delta,xp:item.xp,played_at:item.at}));
      if(!current(id,epoch))return;if(q.error&&q.error.code!=='23505')throw q.error;
    }
    const ids=new Set(snapshot.history.map(x=>x.id));profile.history.forEach(x=>{if(ids.has(x.id))x.synced=true});
    if(profile.revision===rev)profile.dirty=false;compatibility();cloudState='saved';
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
  const epoch=++activationEpoch,changed=scope!==next;clearTimeout(syncTimer);write(PREFIX+scope,profile);
  if(changed){
    if(booted){accountSwitching=true;document.dispatchEvent(new CustomEvent('vezdehot:accountchange',{detail:{from:scope,to:next}}))}
    scope=next;profile=clean(read(PREFIX+scope,BASE));write(LEGACY,{...read('vezdehot:main:'+scope,{}),...profile,view:'lobby'});
  }
  user=nextUser;hydrating=!!user;cloudHydrated=!user;hydrationOps=read('vezdehot:pending:'+scope,[]);cloudState=user?'loading':'local';
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
  compatibility();if(!window.supabase||!config.url){cloudState=scope==='guest'?'local':'offline';booted=true;resolveReady();return}
  try{
    client=window.supabase.createClient(config.url,config.publishableKey,{auth:{flowType:'pkce',persistSession:true,autoRefreshToken:true,detectSessionInUrl:true},global:{fetch:networkFetch}});
    const params=new URLSearchParams(location.search);if(params.has('error'))authError='Вход отменён или не завершён. Гостевой прогресс сохранён.';
    client.auth.onAuthStateChange((event,session)=>{if(event==='SIGNED_IN'||event==='SIGNED_OUT'||event==='USER_UPDATED')setTimeout(()=>{activationFlight=activate(session)},0)});
    const epoch=activationEpoch;const {data,error}=await bounded(client.auth.getSession());if(error)throw error;
    if(epoch===activationEpoch)activationFlight=activate(data.session);
    while(activationFlight){const pending=activationFlight;await pending;if(activationFlight===pending)break}
  }catch{cloudState='offline';authError='Не удалось связаться с сервисом входа. Можно продолжить гостем.'}
  finally{booted=true;resolveReady();checkProviders();emit()}
}
function account(){refreshTelegramProvider();const identities=user?.identities?.map(x=>x.provider)||[];if(user?.app_metadata?.telegram_id&&!identities.includes('custom:telegram'))identities.push('custom:telegram');return {user:user?{id:user.id,email:user.email||'',providers:identities}:null,scope,status:cloudState,error:authError,loading:hydrating,switching:accountSwitching,providers:{...providers}}}
async function login(provider,link=false){
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
async function signOut(){if(!client||!user||accountSwitching)return;const id=user.id;await sync();if(user?.id!==id||scope!==id)return;const {error}=await bounded(client.auth.signOut({scope:'local'}));if(error)throw new Error('Не удалось выйти. Проверь соединение и повтори.');await activate(null)}
function canImportGuest(){return !!(user&&cloudHydrated&&!hydrating&&!accountSwitching&&profile.games===0&&profile.xp===0&&profile.wins===0&&profile.balance===BASE.balance&&!profile.history.length&&!read('vezdehot:guest-import:'+user.id,false)&&read(PREFIX+'guest',{}).games>0)}
function importGuest(){
  if(!canImportGuest())return false;const guest=clean(read(PREFIX+'guest',BASE)),marker='vezdehot:guest-import:'+user.id;
  // The import marker is deliberately outside clean(): profile normalization cannot erase it.
  if(!write(marker,{at:Date.now()}))return false;
  profile=clean({...profile,balance:guest.balance,xp:guest.xp,wins:guest.wins,games:guest.games,bonusAt:Math.max(profile.bonusAt,guest.bonusAt),history:guest.history.map(x=>({...x,synced:false})),resultIds:guest.resultIds,revision:profile.revision+1,dirty:true});
  compatibility();emit();queueSync();return true;
}
const names={durak:'Дурак',poker:'Покер',bunker:'Бункер',mafia:'Мафия',monopoly:'Монополия'};
function toast(message){let e=document.getElementById('vh-toast');if(!e){e=document.createElement('div');e.id='vh-toast';e.className='vh-toast';e.setAttribute('role','status');document.body.appendChild(e)}e.textContent=message;e.classList.add('show');clearTimeout(e._timer);e._timer=setTimeout(()=>e.classList.remove('show'),3500)}
function openAccount(){document.querySelector('#vh-account')?.remove();const p=getProfile(),a=account(),signed=!!a.user,m=document.createElement('div');m.id='vh-account';m.className='vh-overlay';m.innerHTML=`<section class="vh-modal" role="dialog" aria-modal="true" aria-labelledby="vh-account-title"><button class="vh-close" aria-label="Закрыть">×</button><span class="vh-kicker">ТВОЁ МЕСТО В КЛУБЕ</span><h2 id="vh-account-title">${signed?'Твой аккаунт':'Играй в своём стиле'}</h2><p class="vh-copy">${signed?'Имя, настройки и результаты — в одном профиле.':'Начни гостем. Для игры не нужны регистрация и ожидание других игроков.'}</p><div class="vh-profile-line"><span class="vh-avatar">${esc(p.avatar)}</span><div><b>${esc(p.nick)}</b><small>${signed?'Аккаунт подключён':'Гостевой профиль · на этом устройстве'}</small></div><span class="vh-level">LVL ${Math.floor(p.xp/300)+1}</span></div><label class="vh-label">Игровое имя<input class="vh-input" data-nickname maxlength="24" minlength="2" value="${esc(p.nick)}" autocomplete="nickname"></label><div class="vh-avatar-picker">${avatars.map(v=>`<button data-avatar="${v}" aria-label="Аватар ${v}" aria-pressed="${v===p.avatar}" class="${v===p.avatar?'selected':''}">${v}</button>`).join('')}</div><div class="vh-profile-stats"><div><b>${p.games}</b><small>партий</small></div><div><b>${p.wins}</b><small>побед</small></div><div><b>${p.xp}</b><small>опыта</small></div></div><label class="vh-toggle"><span>Меньше анимации</span><input type="checkbox" data-motion ${p.reduceMotion?'checked':''}></label><button class="vh-button primary" data-save-profile>Сохранить профиль</button><div class="vh-auth-divider">${signed?'Способы входа':'Войти и сохранить профиль в облаке'}</div><div class="vh-auth-buttons">${['google','telegram'].map(v=>providerMarkup(v,a)).join('')}</div><p class="vh-auth-message" role="status">${esc(accountMessage(a))}</p>${canImportGuest()?'<button class="vh-button" data-import>Перенести мой гостевой прогресс</button>':''}<button class="vh-button subtle" data-account-exit>${signed?'Выйти из аккаунта':'Продолжить гостем →'}</button></section>`;document.body.appendChild(m);const before=document.activeElement;const close=()=>{m.remove();before?.focus?.()};m.querySelector('.vh-close').onclick=close;m.onclick=e=>{if(e.target===m)close()};m.onkeydown=e=>{if(e.key==='Escape')close();if(e.key==='Tab'){const f=[...m.querySelectorAll('button:not(:disabled),input')],first=f[0],last=f[f.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}}};let avatar=p.avatar;m.querySelectorAll('[data-avatar]').forEach(b=>b.onclick=()=>{avatar=b.dataset.avatar;m.querySelectorAll('[data-avatar]').forEach(x=>{x.classList.toggle('selected',x===b);x.setAttribute('aria-pressed',String(x===b))});m.querySelector('.vh-avatar').textContent=avatar});m.querySelector('[data-save-profile]').onclick=()=>{const nick=m.querySelector('[data-nickname]').value.trim();if(nick.length<2)return toast('Имя — от 2 до 24 символов');updateProfile({nick,avatar,reduceMotion:m.querySelector('[data-motion]').checked});toast('Профиль сохранён');close()};m.querySelectorAll('[data-provider]').forEach(b=>b.onclick=async()=>{if(providerPresentation(b.dataset.provider,account()).openBot){window.open('https://t.me/VesdehotBot','_blank','noopener,noreferrer');m.querySelector('.vh-auth-message').textContent='В Telegram открой VesdehotBot и нажми «Играть», затем подтверди вход в игре.';return}b.disabled=true;try{await login(b.dataset.provider,signed)}catch(e){m.querySelector('.vh-auth-message').textContent=e.message;b.disabled=false}});m.querySelector('[data-account-exit]').onclick=async()=>{if(!signed)return close();try{await signOut()}catch(e){toast(e.message)}};m.querySelector('[data-import]')?.addEventListener('click',()=>{if(importGuest()){toast('Гостевой прогресс перенесён');close()}});m.querySelector('.vh-close').focus();checkProviders().then(refreshAccountProviders)}
function providerPresentation(v,a){
  const name=v==='google'?'Google':'Telegram',connected=a.user?.providers.includes(v==='telegram'?'custom:telegram':v);
  const openBot=v==='telegram'&&!a.user&&config.telegramMiniAppEnabled&&!hasMiniAppData()&&!config.telegramEnabled;
  const linkBlocked=!!a.user&&(!config.manualLinkingEnabled||(v==='telegram'&&hasMiniAppData()));
  return {openBot,text:connected?name+' подключён':openBot?'Открыть в Telegram':a.user?'Подключить '+name:'Войти через '+name,
    disabled:!!(a.loading||a.switching||connected||linkBlocked||(!a.providers[v]&&!openBot)),
    hint:connected?'':openBot?'Подтверждение внутри бота':linkBlocked?'Отдельный способ входа':!a.providers[v]?'Подключается':''};
}
function providerMarkup(v,a){const p=providerPresentation(v,a);return `<button class="vh-button provider" data-provider="${v}" ${p.disabled?'disabled':''}><span>${v==='google'?'G':'↗'}</span>${p.text}${p.hint?'<small>'+p.hint+'</small>':''}</button>`}
function accountMessage(a){if(authError)return authError;if(a.user)return cloudState==='saved'?'Профиль сохранён в облаке.':'Изменения сохранены на устройстве.';if(config.telegramMiniAppEnabled&&!hasMiniAppData()&&!config.telegramEnabled)return 'Вход через Telegram подтверждается в игре внутри бота. Гостевой прогресс остаётся отдельно.';return a.providers.google||a.providers.telegram?'Гостевые результаты остаются отдельно от аккаунта.':'Социальный вход скоро появится. Гостевой режим уже работает.'}
function refreshAccountProviders(){const modal=document.querySelector('#vh-account');if(!modal)return;const a=account();modal.querySelectorAll('[data-provider]').forEach(b=>{const v=b.dataset.provider,p=providerPresentation(v,a);b.disabled=p.disabled;b.innerHTML=`<span>${v==='google'?'G':'↗'}</span>${p.text}${p.hint?'<small>'+p.hint+'</small>':''}`})}
document.addEventListener('vezdehot:telegramready',()=>{refreshTelegramProvider();refreshAccountProviders();emit()});
window.VEZDEHOT={ready,getProfile,updateProfile,recordResult,scopeKey:()=>scope,saveMainState,loadMainState,account,openAccount,login,signOut,sync,importGuest,canImportGuest,toast,avatars};
window.addEventListener('online',()=>{if(user&&!cloudHydrated&&!hydrating&&!accountSwitching)activationFlight=activate({user});else queueSync()});document.addEventListener('visibilitychange',()=>{if(document.hidden&&profile.dirty)sync()});window.addEventListener('storage',e=>{if(!hydrating&&!accountSwitching&&e.key===PREFIX+scope){const latest=clean(read(e.key));if(latest.revision>profile.revision){profile=latest;compatibility();emit()}}});
init();
})();
