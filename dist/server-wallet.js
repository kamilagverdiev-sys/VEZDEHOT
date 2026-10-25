/* Server wallet is independent of the practice profile and its checkpoints. */
(()=>{
'use strict';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v),integer=(v,min=0)=>Number.isSafeInteger(v)&&v>=min;
const instant=v=>typeof v==='string'&&v.length<64&&/(?:Z|[+-]00:00)$/.test(v)&&Number.isFinite(Date.parse(v));
const clone=v=>JSON.parse(JSON.stringify(v));
function projection(data){
  const w=data?.wallet;
  if(data?.status!=='ok'||!object(w)||w.version!==1||!['revision','balance','xp','games','wins'].every(k=>integer(w[k]))||w.wins>w.games||!instant(w.bonusAvailableAt)||!instant(w.serverTime)||!Array.isArray(w.history)||w.history.length>20)throw new Error('Серверный баланс не удалось проверить. Повтори загрузку.');
  const seen=new Set();
  for(const row of w.history){
    if(!object(row)||typeof row.id!=='string'||!row.id.length||row.id.length>100||seen.has(row.id)||!['welcome','daily','entry','settlement'].includes(row.kind)||!integer(row.delta,-Number.MAX_SAFE_INTEGER)||!integer(row.xp)||!integer(row.balance)||!instant(row.createdAt))throw new Error('История серверного баланса неполная. Повтори загрузку.');
    if(['entry','settlement'].includes(row.kind)?!['durak','poker'].includes(row.game)||typeof row.tableId!=='string'||!UUID.test(row.tableId):row.game!==null||row.tableId!==null)throw new Error('История серверного баланса неполная. Повтори загрузку.');
    seen.add(row.id);
  }
  // Copy only the public schema. Never accept client profile fields as wallet state.
  return {version:1,revision:w.revision,balance:w.balance,xp:w.xp,games:w.games,wins:w.wins,bonusAvailableAt:w.bonusAvailableAt,serverTime:w.serverTime,history:w.history.map(r=>({id:r.id,kind:r.kind,game:r.game,tableId:r.tableId,delta:r.delta,xp:r.xp,balance:r.balance,createdAt:r.createdAt}))};
}
function validFlight(f){return object(f)&&f.version===1&&integer(f.seenRevision)&&Object.keys(f).every(k=>['version','body','seenRevision'].includes(k))&&object(f.body)&&f.body.op==='claimDaily'&&UUID.test(f.body.actionId)&&Object.keys(f.body).length===2;}
function createController(options){
  const key='vezdehot:server-wallet:pending:v1:'+options.scope,clock=options.now||(()=>typeof performance!=='undefined'?performance.now():Date.now());
  let disposed=false,busy=false,ticket=0,flight=null,floor=0,receivedAt=0,serverAt=0;
  const waitingLoads=[];
  let state={phase:'loading',ready:false,wallet:null,notice:''};
  const current=()=>!disposed&&options.current()===true;
  const serverNow=()=>serverAt+Math.max(0,clock()-receivedAt);
  const status=()=>({...state,wallet:state.wallet?clone(state.wallet):null,busy,pending:!!flight,canClaim:!!(current()&&state.ready&&!busy&&!flight&&state.wallet&&serverNow()>=Date.parse(state.wallet.bonusAvailableAt)),serverNow:state.wallet?serverNow():null});
  const publish=()=>{if(current())options.onChange?.(status())};
  const own=()=>{if(!current())throw new Error('Аккаунт или активная вкладка изменились. Открой серверный баланс заново.')};
  const call=async body=>{own();let response;try{response=await options.request(clone(body))}catch{throw new Error('Нет ответа от сервера. Запрос бонуса, если он был отправлен, сохранён для повтора.')}own();return response};
  function stage(body){
    own();const record={version:1,body,seenRevision:state.wallet.revision},raw=JSON.stringify(record);
    try{options.storage.setItem(key,raw);if(options.storage.getItem(key)!==raw)throw new Error()}catch{throw new Error('Не удалось сохранить запрос бонуса. Разреши хранилище браузера или освободи место.')}
    flight=record;
  }
  function restore(){
    if(flight)return;
    let raw;try{raw=options.storage.getItem(key)}catch{throw new Error('Хранилище браузера недоступно. Разреши хранение данных и повтори.')}
    if(!raw)return;
    try{const saved=JSON.parse(raw);if(!validFlight(saved))throw new Error();flight=saved}catch{throw new Error('Сохранённый запрос бонуса повреждён. Его нельзя безопасно отправить повторно.')}
  }
  function clear(){
    own();try{if(options.storage.getItem(key)!==JSON.stringify(flight))throw new Error();options.storage.removeItem(key);if(options.storage.getItem(key)!==null)throw new Error()}catch{throw new Error('Ответ получен, но подтверждение не сохранено на устройстве. Повтори тот же запрос.')}
    flight=null;
  }
  async function fetchWallet(){
    const result=await call({op:'load'});
    if(!result.ok)throw new Error(result.status===401?'Войди в аккаунт ещё раз, чтобы открыть серверный баланс.':'Серверный баланс временно недоступен. Повтори загрузку.');
    const wallet=projection(result.data);
    if(wallet.revision<Math.max(floor,state.wallet?.revision||0))throw new Error('Получен устаревший баланс. Повтори загрузку перед игрой на монеты.');
    floor=wallet.revision;receivedAt=clock();serverAt=Date.parse(wallet.serverTime);state={...state,phase:'saved',ready:true,wallet};
  }
  async function sendFlight(){
    if(!validFlight(flight))throw new Error('Сохранённый запрос бонуса повреждён. Он не отправлен.');
    const result=await call(flight.body),ack=result?.data;
    if(!result.ok)throw new Error(result.status===401?'Подтверди вход и повтори запрос бонуса. Его номер сохранён.':'Бонус не подтверждён. Повтори сохранённый запрос.');
    if(!object(ack)||!['saved','cooldown'].includes(ack.status)||ack.actionId!==flight.body.actionId||((ack.status==='cooldown'||ack.availableAt!==undefined)&&!instant(ack.availableAt)))throw new Error('Подтверждение бонуса неполное. Повтори тот же запрос.');
    // A replayed receipt is not a current balance. Keep only a revision floor.
    floor=Math.max(floor,flight.seenRevision+(ack.status==='saved'?1:0));
    clear();state.notice=ack.status==='saved'?'Бонус +1 000 V подтверждён сервером.':'Бонус ещё восстанавливается. Время следующего получения указано ниже.';
    await fetchWallet();
  }
  async function work(fn){
    if(busy||!current())return false;
    busy=true;state={...state,phase:'loading',ready:false};publish();const sequence=++ticket;
    try{await fn();return current()&&sequence===ticket}catch(error){if(current()&&sequence===ticket)state={...state,phase:'offline',ready:false,notice:error?.message||'Серверный баланс недоступен.'};return false}finally{
      busy=false;
      if(current()&&sequence===ticket)publish();
      // A table can settle during a wallet read. Coalesce those requests into a
      // new read after the current response, so its old balance cannot linger.
      const waiting=waitingLoads.splice(0);
      if(waiting.length){if(current()&&sequence===ticket)load().then(value=>waiting.forEach(resolve=>resolve(value)));else waiting.forEach(resolve=>resolve(false));}
    }
  }
  const load=()=>busy&&current()?new Promise(resolve=>waitingLoads.push(resolve)):work(async()=>{state.notice='';restore();if(flight)await sendFlight();else await fetchWallet()});
  const claimDaily=()=>{
    if(!status().canClaim)return Promise.resolve(false);
    return work(async()=>{state.notice='';const actionId=options.uuid();if(!UUID.test(actionId))throw new Error('Не удалось создать безопасный номер запроса. Обнови страницу по HTTPS.');stage({op:'claimDaily',actionId});await sendFlight()});
  };
  return Object.freeze({load,claimDaily,status,destroy(){disposed=true;ticket++;}});
}

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),fmt=n=>Number(n).toLocaleString('ru-RU');
function waitText(state){
  if(!state.wallet||state.serverNow===null||state.serverNow===undefined)return '';
  const minutes=Math.max(0,Math.ceil((Date.parse(state.wallet.bonusAvailableAt)-state.serverNow)/60000));
  if(!minutes)return 'Бонус доступен';
  return 'Бонус через '+(minutes>=60?Math.floor(minutes/60)+' ч '+(minutes%60?minutes%60+' мин':''):minutes+' мин');
}
function walletMarkup(state,opened=false){
  const w=state.wallet,title=state.phase==='guest'?'Войди, чтобы играть на серверные монеты':state.phase==='readonly'?'Доступен в активной вкладке':state.busy?'Обновляем…':state.ready?'Подтверждён сервером':w?'Нужна связь · показана последняя версия':'Баланс пока не загружен';
  const summary=`<summary><span class="sw-heading"><b>Серверный баланс</b><small>${esc(title)}</small></span><strong class="sw-amount">${w?fmt(w.balance):'—'} <span>V</span></strong><span class="sw-expand" aria-hidden="true">+</span></summary>`;
  if(state.phase==='guest')return `<details class="sw-card" ${opened?'open':''}>${summary}<div class="sw-content"><p>Для серверных Дурака и Покера. Войди в аккаунт — получишь 1 000 V для первых партий.</p><button class="sw-button" data-wallet-login>Войти в аккаунт</button><p class="sw-note">Баланс практики и гостевые партии сохраняются отдельно.</p></div></details>`;
  const busy=state.busy||state.phase==='readonly';
  const labels={welcome:'Стартовые монеты',daily:'Ежедневный бонус',entry:'Вход за стол',settlement:'Расчёт стола'},games={durak:'Дурак',poker:'Покер'};
  const history=w?.history.length?`<div class="sw-history"><h3>Последние операции</h3><ol>${w.history.map(row=>`<li><span><b>${esc(labels[row.kind])}${row.game?' · '+games[row.game]:''}</b><time datetime="${esc(row.createdAt)}">${esc(new Date(row.createdAt).toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}))}</time></span><strong class="${row.delta<0?'is-debit':'is-credit'}">${row.delta>0?'+':''}${fmt(row.delta)} V${row.xp?`<small>+${fmt(row.xp)} XP</small>`:''}</strong></li>`).join('')}</ol></div>`:'';
  return `<details class="sw-card" ${opened?'open':''}>${summary}<div class="sw-content">${state.notice?`<p class="sw-notice" role="status">${esc(state.notice)}</p>`:''}<p class="sw-intro">Для серверных Дурака и Покера. Вход и итог партии подтверждает сервер.</p>${w?`<div class="sw-stats"><span><b>${fmt(w.xp)}</b> XP</span><span><b>${fmt(w.games)}</b> партий</span><span><b>${fmt(w.wins)}</b> побед</span></div>`:''}<div class="sw-bonus"><span><b>+1 000 V каждый день</b><small>${state.ready?esc(waitText(state)):'Время бонуса уточнится после загрузки'}</small></span>${state.pending?`<button class="sw-button" data-wallet-refresh ${busy?'disabled':''}>${busy?'Подтверждаем…':'Повторить запрос'}</button>`:state.ready?`<button class="sw-button" data-wallet-claim ${state.canClaim?'':'disabled'}>${state.canClaim?'Забрать бонус':'Бонус восстанавливается'}</button>`:`<button class="sw-button" data-wallet-refresh ${busy?'disabled':''}>${busy?'Обновляем…':'Загрузить баланс'}</button>`}</div>${w&&state.ready?'<button class="sw-refresh" data-wallet-refresh>Обновить баланс</button>':''}<p class="sw-note">Первый бонус — через 24 часа после стартовых монет. Баланс практики остаётся отдельным. Монеты не имеют денежной стоимости.</p>${history}</div></details>`;
}

let controller=null,owner=null,view={phase:'guest',ready:false,busy:false,pending:false,wallet:null,notice:'',canClaim:false,serverNow:null};
const subscribers=new Set(),mounts=new Map();
const account=()=>window.VEZDEHOT?.account?.();
const gate=()=>{const a=account();return !!owner&&a?.user?.id===owner&&window.VEZDEHOT.scopeKey()===owner&&!a.loading&&!a.switching&&!a.authPending&&window.VEZDEHOT_TAB_SESSION?.canWrite()===true&&!document.hidden};
function status(){return {...view,wallet:view.wallet?clone(view.wallet):null};}
function renderHost(root,entry){
  if(!root.isConnected){root.onclick=null;mounts.delete(root);return;}
  const opened=root.querySelector('.sw-card')?.open??entry.opened,focused=root.ownerDocument?.activeElement;
  const focusAction=focused&&root.contains(focused)?['data-wallet-login','data-wallet-claim','data-wallet-refresh'].find(name=>focused.hasAttribute?.(name)):null;
  root.innerHTML=walletMarkup(view,opened);entry.opened=opened;
  if(focusAction)root.querySelector('['+focusAction+']')?.focus?.({preventScroll:true});
}
function emit(){for(const [root,entry] of mounts)renderHost(root,entry);for(const fn of subscribers){try{fn(status())}catch{}}}
function clear(phase='loading'){
  controller?.destroy();controller=null;owner=null;view={phase,ready:false,busy:phase==='loading',pending:false,wallet:null,notice:'',canClaim:false,serverNow:null};emit();
}
function boot(){
  const a=account();
  if(!a||!a.user){if(owner||view.phase!=='guest')clear('guest');return;}
  if(owner&&owner!==a.user.id)clear();
  const active=!a.loading&&!a.switching&&!a.authPending&&window.VEZDEHOT_TAB_SESSION?.canWrite()===true&&!document.hidden;
  if(!active){const phase=a.loading||a.switching||a.authPending?'loading':'readonly';if(controller||view.phase!==phase)clear(phase);return;}
  if(controller)return;
  owner=a.user.id;
  controller=createController({scope:owner,current:gate,request:body=>window.VEZDEHOT.serverWalletRequest(body),storage:{getItem:key=>window.localStorage.getItem(key),setItem:(key,value)=>window.localStorage.setItem(key,value),removeItem:key=>window.localStorage.removeItem(key)},uuid:()=>crypto.randomUUID(),onChange:next=>{view=next;emit()}});
  controller.load();
}
function refresh(){boot();return controller?.load()||Promise.resolve(false);}
function claimDaily(){return controller?.claimDaily()||Promise.resolve(false);}
function subscribe(fn){if(typeof fn!=='function')throw new TypeError('Wallet subscriber must be a function');subscribers.add(fn);fn(status());return()=>subscribers.delete(fn);}
function mount(root){
  if(!root||typeof root.querySelector!=='function')return()=>{};
  for(const [old] of mounts)if(!old.isConnected){old.onclick=null;mounts.delete(old);}
  if(!mounts.has(root))mounts.set(root,{opened:root.dataset?.walletExpanded==='true'});
  root.onclick=event=>{const target=event.target?.closest?.('[data-wallet-login],[data-wallet-claim],[data-wallet-refresh]');if(!target||!root.contains(target)||target.disabled)return;if(target.hasAttribute('data-wallet-login'))window.VEZDEHOT?.openAccount?.();else if(target.hasAttribute('data-wallet-claim'))claimDaily();else refresh();};
  renderHost(root,mounts.get(root));
  return()=>{root.onclick=null;mounts.delete(root);};
}
window.VEZDEHOT_SERVER_WALLET=Object.freeze({createController,projection,validFlight,walletMarkup,waitText,mount,refresh,status,subscribe,claimDaily});
if(typeof document==='undefined'||typeof document.addEventListener!=='function')return;
Promise.resolve(window.VEZDEHOT?.ready).then(boot);
for(const event of ['vezdehot:profile','vezdehot:sessionactive'])document.addEventListener(event,boot);
for(const event of ['vezdehot:accountchange','vezdehot:sessionpause','vezdehot:sessionlost'])document.addEventListener(event,()=>clear(event==='vezdehot:accountchange'?'loading':'readonly'));
document.addEventListener('visibilitychange',()=>{if(document.hidden)clear('readonly');else boot()});
window.addEventListener('online',()=>refresh());
setInterval(()=>{if(document.hidden||!controller||!view.ready||!mounts.size)return;view=controller.status();emit();},30000);
})();
