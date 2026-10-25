/* Server-only Durak client. This module never deals cards, runs bots or mutates a wallet. */
(()=>{
'use strict';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS=['attack','defend','take','finish','continue','resign'];
const card=c=>!!c&&typeof c==='object'&&['6','7','8','9','10','J','Q','K','A'].includes(c.rank)&&['♠','♥','♦','♣'].includes(c.suit)&&c.id===c.rank+c.suit;
function projection(value){
  if(!value||typeof value!=='object'||!Number.isSafeInteger(value.revision)||value.revision<0||!['saved','ok'].includes(value.status))throw new Error('Сервер прислал неполный ответ. Повтори загрузку.');
  const g=value.game;if(g===null)return value;
  if(!g||typeof g.id!=='string'||!['attack','defend','resolve','roundEnd','over'].includes(g.phase)||!Array.isArray(g.players)||g.players.length<2||g.players.length>4||!Array.isArray(g.table)||g.table.length>6||!g.legal||!Array.isArray(g.legal.cards)||!Array.isArray(g.legal.actions)||typeof g.over!=='boolean')throw new Error('Состояние стола не удалось проверить. Повтори загрузку.');
  if(g.players.some((p,i)=>!p||typeof p.name!=='string'||!Number.isInteger(p.handCount)||p.handCount<0||p.handCount>36||(i===0?(!Array.isArray(p.hand)||p.hand.some(c=>!card(c))||p.hand.length!==p.handCount):Object.hasOwn(p,'hand')))||g.table.some(p=>!p||!card(p.a)||(p.d!==null&&!card(p.d)))||g.legal.actions.some(a=>!ACTIONS.includes(a))||g.legal.cards.some(id=>!g.players[0].hand.some(c=>c.id===id))||!Number.isInteger(g.deckCount)||g.deckCount<0||g.deckCount>36||!Number.isInteger(g.discardCount)||g.discardCount<0||g.discardCount>36||!Number.isInteger(g.attacker)||!g.players[g.attacker]||!Number.isInteger(g.defender)||!g.players[g.defender]||!Array.isArray(g.finished)||g.finished.some(i=>!Number.isInteger(i)||!g.players[i])||!Array.isArray(g.journal)||g.journal.length>80||g.journal.some(e=>!e||typeof e!=='object'))throw new Error('Состояние стола не удалось проверить. Повтори загрузку.');
  return value;
}
function validFlight(value){
  if(!value||typeof value!=='object'||!UUID.test(value.actionId)||!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<0)return false;
  const keys=Object.keys(value);
  if(value.op==='start')return keys.every(k=>['op','actionId','expectedRevision','bots','difficulty'].includes(k))&&[1,2,3].includes(value.bots)&&['easy','normal','hard'].includes(value.difficulty);
  const a=value.action;
  return value.op==='action'&&keys.every(k=>['op','actionId','expectedRevision','gameId','action'].includes(k))&&typeof value.gameId==='string'&&a&&ACTIONS.includes(a.type)&&Object.keys(a).every(k=>['type','cardId'].includes(k))&&(['attack','defend'].includes(a.type)?typeof a.cardId==='string':Object.keys(a).length===1);
}
function createController(options){
  const key='vezdehot:server-durak:pending:v1:'+options.scope;
  let disposed=false,busy=false,sequence=0,flight=null,state={phase:'loading',revision:0,game:null,notice:'',ready:false};
  const current=()=>!disposed&&options.current()===true;
  const publish=()=>{if(current())options.onChange?.({...state,busy,pending:!!flight})};
  const own=()=>{if(!current())throw Object.assign(new Error('Управление передано другой вкладке или аккаунту.'),{code:'STALE_ACCOUNT'})};
  const clear=()=>{own();const raw=options.storage.getItem(key);if(raw!==JSON.stringify(flight))throw new Error('Сохранённый запрос изменился. Обнови страницу перед следующим ходом.');options.storage.removeItem(key);if(options.storage.getItem(key)!==null)throw new Error('Не удалось подтвердить ответ на устройстве. Повтори запрос.');flight=null;};
  const stage=body=>{own();const raw=JSON.stringify(body);options.storage.setItem(key,raw);if(options.storage.getItem(key)!==raw)throw new Error('Не удалось сохранить запрос. Освободи память браузера и повтори.');flight=JSON.parse(raw)};
  const call=async body=>{own();const result=await options.request(JSON.parse(JSON.stringify(body)));own();return result};
  const fetchState=async()=>{const response=await call({op:'load'});if(!response.ok)throw new Error(response.status===401?'Войди в аккаунт ещё раз, чтобы открыть стол.':'Сервер временно недоступен. Повтори загрузку.');const next=projection(response.data);if(next.revision<state.revision)throw new Error('Получена устаревшая версия стола. Повтори загрузку.');state={...state,revision:next.revision,game:next.game,phase:'saved',ready:true};};
  async function sendFlight(){
    if(!validFlight(flight))throw new Error('Сохранённый запрос повреждён. Открой эту партию на другом устройстве.');
    const response=await call(flight);
    if(!response.ok){
      if([400,409,422].includes(response.status)){clear();state.notice='Этот ход не принят. Показан актуальный стол — выбери действие заново.';await fetchState();return;}
      throw new Error(response.status===401?'Подтверди вход и повтори запрос. Он сохранён с тем же номером.':'Ответ не получен. Повтори запрос: один ход не будет применён дважды.');
    }
    if(response.data?.status==='conflict'){clear();state.notice='Стол уже изменился на другом устройстве. Загружена актуальная партия.';await fetchState();return;}
    projection(response.data);clear();
    // A receipt can predate a newer phone/PC move. Always fetch the current revision.
    await fetchState();
  }
  async function work(fn){
    if(busy||!current())return false;busy=true;state.phase='loading';state.ready=false;publish();const ticket=++sequence;
    try{await fn();return current()&&ticket===sequence}catch(error){if(current()&&ticket===sequence){state.phase='offline';state.ready=false;state.notice=error?.message||'Нет связи с сервером. Повтори запрос.'}return false}finally{if(current()&&ticket===sequence){busy=false;publish()}}
  }
  const load=()=>work(async()=>{state.notice='';if(!flight){let raw;try{raw=options.storage.getItem(key)}catch{throw new Error('Память браузера недоступна. Разреши хранение данных и повтори.')}if(raw){try{flight=JSON.parse(raw)}catch{throw new Error('Сохранённый запрос повреждён. Открой эту партию на другом устройстве.')}if(!validFlight(flight))throw new Error('Сохранённый запрос повреждён. Открой эту партию на другом устройстве.');}}
    if(flight)await sendFlight();else await fetchState();});
  function mutate(payload){
    if(!current()||busy||flight||!state.ready)return Promise.resolve(false);
    return work(async()=>{state.notice='';stage({...payload,actionId:options.uuid(),expectedRevision:state.revision});await sendFlight()});
  }
  return Object.freeze({load,start:(bots=1,difficulty='normal')=>state.game&&!state.game.over?Promise.resolve(false):mutate({op:'start',bots,difficulty}),act:action=>state.game&&!state.game.over?mutate({op:'action',gameId:state.game.id,action}):Promise.resolve(false),status:()=>({...state,busy,pending:!!flight}),destroy:()=>{disposed=true;sequence++;}});
}
window.VEZDEHOT_SERVER_DURAK=Object.freeze({createController,projection,validFlight});
if(!document.getElementById('app'))return;
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let controller=null,owner=null,selected=null,view={phase:'loading',game:null,revision:0,ready:false,busy:true};
const gate=()=>!!owner&&window.VEZDEHOT?.scopeKey()===owner&&window.VEZDEHOT?.account().user?.id===owner&&!window.VEZDEHOT.account().switching&&window.VEZDEHOT_TAB_SESSION?.canWrite()===true&&!document.hidden;
const cardFace=(c,extra='')=>`<span class="sd-card ${['♥','♦'].includes(c.suit)?'red':''} ${extra}"><span>${esc(c.rank)}<small>${esc(c.suit)}</small></span><b aria-hidden="true">${esc(c.suit)}</b><i aria-hidden="true">${esc(c.rank)}${esc(c.suit)}</i></span>`;
function statusText(g){
  if(g.over)return g.resigned?'Стол завершён':g.draw?'Ничья':g.finished.includes(0)?'Ты выиграл':'Партия завершена';
  if(view.busy)return 'Подтверждаем ход…';
  if(view.phase==='offline')return 'Ждём подтверждения';
  if(g.legal.actions.includes('defend'))return 'Твоя защита';
  if(g.legal.actions.includes('take'))return 'Можно забрать карты';
  if(g.legal.actions.includes('attack'))return g.table.length?'Можно подкинуть':'Твой ход';
  return g.phase==='resolve'?'Карта отбита':'Раунд завершён';
}
function actionButton(action,label,primary=false){return `<button class="sd-button ${primary?'primary':''}" data-action="${action}" ${!gate()||!view.ready?'disabled':''}>${label}</button>`;}
function controls(g){
  if(!view.ready)return `<button class="sd-button primary" data-retry ${view.busy||!gate()?'disabled':''}>${view.busy?'Подтверждаем…':view.pending?'Повторить этот запрос':'Загрузить стол'}</button>`;
  const actions=g.legal.actions,move=actions.includes('defend')?'defend':actions.includes('attack')?'attack':null;
  return `${move?`<button class="sd-button primary" data-play="${move}" ${!selected||!gate()?'disabled':''}>${move==='defend'?'Отбить':'Положить'}${selected?' '+esc(selected):' карту'}</button>`:''}${actions.includes('take')?actionButton('take','Забрать карты'):''}${actions.includes('finish')?actionButton('finish','Бито · завершить',!move):''}${actions.includes('continue')?actionButton('continue',g.phase==='roundEnd'?'Следующий раунд →':'Продолжить атаку →',true):''}`;
}
function journal(g){
  const names=i=>g.players[i]?.name||'Игрок',c=x=>x?x.rank+x.suit:'';
  return g.journal.slice().reverse().map(e=>{const who=names(e.actor),line={start:who+' начинает партию',attack:who+' атакует '+c(e.card),defense:who+' отбивает '+c(e.against)+' картой '+c(e.card),take:who+' забирает '+e.count+' карт',discard:'Бито · '+e.count+' карт',draw:who+' добирает '+e.count+' карт',out:who+' вышел из игры без карт',end:'Партия завершена',next:'Следующий ход · '+who}[e.kind];return line?`<li><small>Раунд ${esc(e.round)}</small><span>${esc(line)}</span></li>`:''}).join('');
}
function setup(over=false){return `<section class="sd-setup"><span class="sd-eyebrow">СЕРВЕРНЫЙ СТОЛ · БЕЗ СТАВКИ</span><h1>${over?'Ещё одну партию?':'Карты остаются за столом'}</h1><p>Начни здесь, продолжи с того же аккаунта на телефоне или ПК. Раздача, ходы и ответы ботов проверяются сервером.</p><div class="sd-setup-options"><label>Соперники<select id="sd-bots"><option value="1">Один бот</option><option value="2">Два бота</option><option value="3">Три бота</option></select></label><label>Характер ботов<select id="sd-difficulty"><option value="easy">Мягкий</option><option value="normal" selected>Обычный</option><option value="hard">Расчётливый</option></select></label></div><button class="sd-button primary" data-start ${!gate()||!view.ready?'disabled':''}>Открыть стол · бесплатно</button><p class="sd-footnote">Пилотный режим: без списания монет, наград и XP. Партия сохраняется отдельно от обычного Дурака.</p></section>`;}
function render(){
  const app=$('#app');if(!app)return;const a=window.VEZDEHOT?.account(),g=view.game,opened=$('[data-journal]')?.open||false;
  const header=`<header class="sd-header"><a class="sd-back" href="./index.html" aria-label="В лобби">‹</a><div><a class="sd-brand" href="./index.html">VEZDEHOT</a><span>Серверный Дурак</span></div><button class="sd-account" data-account>${esc(a?.user?window.VEZDEHOT.getProfile().nick:'Войти')}</button></header>`;
  const notice=view.notice?`<div class="sd-notice" role="status">${esc(view.notice)}</div>`:'';
  if(!a?.user){app.innerHTML=header+`<section class="sd-setup"><span class="sd-eyebrow">ОДНА ПАРТИЯ · РАЗНЫЕ УСТРОЙСТВА</span><h1>Твой стол ждёт тебя</h1><p>Войди в аккаунт: сервер сохранит карты и каждый подтверждённый ход. Соперник — бот, ставка не нужна.</p><button class="sd-button primary" data-account ${a?.loading||a?.switching?'disabled':''}>Войти и открыть стол</button><a class="sd-link" href="./index.html">Вернуться к играм для гостя →</a></section>`;bind();return;}
  const stateTitle=!gate()?'Управление недоступно':view.busy?'Проверяем сервер':view.phase==='saved'?'Ходы сохранены':'Нужна связь';
  const sync=`<div class="sd-sync" role="status"><span class="sd-sync-dot ${view.phase==='saved'&&gate()?'saved':''}"></span><span>${stateTitle}</span><button data-retry ${view.busy||!gate()?'disabled':''}>${view.pending?'Повторить запрос':'Обновить'}</button></div>`;
  if(!g){app.innerHTML=header+sync+notice+setup();bind();return;}
  const writable=gate()&&view.ready,legal=new Set(g.legal.cards),players=g.players.slice(1).map((p,i)=>{const seat=i+1,active=!g.over&&((g.phase==='defend'&&g.defender===seat)||(g.phase==='attack'&&g.attacker===seat));return `<article class="sd-player ${active?'active':''}"><span class="sd-avatar">${esc(p.face||'♟')}</span><div><b>${esc(p.name)}</b><small>${g.finished.includes(seat)?'Вышел без карт':p.handCount+' карт'}${active?' · ход':''}</small></div><span class="sd-hidden" aria-hidden="true">▥</span></article>`}).join('');
  const board=g.table.length?g.table.map((p,i)=>`<div class="sd-pair"><span class="sd-pair-number">${i+1}</span>${cardFace(p.a,'attack')}${p.d?cardFace(p.d,'defence'):'<span class="sd-wait" aria-label="Карта ещё не отбита">···</span>'}</div>`).join(''):'<p class="sd-empty-table">Новый заход<small>Карты появятся здесь</small></p>';
  const hand=g.players[0].hand.map(c=>`<button class="sd-hand-card ${selected===c.id?'selected':''}" data-card="${esc(c.id)}" aria-pressed="${selected===c.id}" aria-label="${esc(c.rank+' '+c.suit)}${legal.has(c.id)?', можно сыграть':', сейчас недоступна'}" ${!writable||!legal.has(c.id)?'disabled':''}>${cardFace(c)}</button>`).join('');
  const over=g.over?`<section class="sd-result"><span class="sd-eyebrow">ПАРТИЯ ЗАВЕРШЕНА</span><h1>${statusText(g)}</h1><p>${esc(g.message)}</p><small>Ставок и начислений в этом режиме нет.</small></section>${setup(true)}`:'';
  app.innerHTML=header+sync+notice+(!gate()?'<div class="sd-notice">Продолжить можно в активной вкладке после загрузки аккаунта.</div>':'')+`<section class="sd-shell"><div class="sd-table-meta"><span>БЕЗ СТАВКИ</span><span>РАУНД ${esc(g.round)}</span></div><div class="sd-felt"><div class="sd-opponents" style="--opponents:${g.players.length-1}">${players}</div><div class="sd-stock"><span>В колоде <b>${g.deckCount}</b></span><span>Козырь <b class="${['♥','♦'].includes(g.trump)?'red':''}">${esc(g.trump)}</b></span><span>Бито <b>${g.discardCount}</b></span></div><div class="sd-battle">${board}</div><div class="sd-table-caption">${esc(g.players[g.attacker]?.name)} атакует · ${esc(g.players[g.defender]?.name)} защищается</div></div>${!g.over?`<div class="sd-control"><div class="sd-turn"><span class="sd-eyebrow">${view.busy?'ЗАПРОС ОТПРАВЛЕН':'ТВОЁ РЕШЕНИЕ'}</span><h1>${statusText(g)}</h1><p>${esc(g.message)}</p></div><div class="sd-hand-label"><b>Твои карты · ${g.players[0].handCount}</b><span>${selected?'Выбрана '+esc(selected):g.legal.cards.length?'Выбери светлую карту':'Карты остаются у тебя'}</span></div><div class="sd-hand">${hand||'<p>У тебя не осталось карт.</p>'}</div><div class="sd-actions">${controls(g)}</div><p class="sd-help">После выбора карты подтверди ход кнопкой. Таймера на решение нет.</p></div>`:''}</section>${over}<details class="sd-rules"><summary>Правила этого стола</summary><p>В колоде 36 карт. Старшая карта той же масти отбивает младшую; козырь отбивает другую масть. Козырь можно отбить только старшим козырем.</p><p>Атакующий подкидывает карты того же достоинства, что уже есть на столе. В одном заходе не больше шести атак и не больше карт, чем было у защитника в начале захода.</p><p>Если отбиться нечем, забери карты. После завершения захода игроки добирают до шести. Когда колода пуста, освободи руку: последний игрок с картами проигрывает.</p></details><details class="sd-journal" data-journal ${opened?'open':''}><summary>История ходов <span>${g.journal.length}</span></summary><ol>${journal(g)}</ol></details><footer class="sd-footer"><p>Чтобы продолжить на другом устройстве, дождись статуса «Ходы сохранены» и войди там в тот же аккаунт.</p>${!g.over?`<button class="sd-link" data-resign ${!writable?'disabled':''}>Завершить этот стол</button>`:''}<a class="sd-link" href="./index.html">Все игры →</a></footer>`;bind();
}
function bind(){
  document.querySelectorAll('[data-account]').forEach(b=>b.onclick=()=>window.VEZDEHOT.openAccount());
  document.querySelectorAll('[data-retry]').forEach(b=>b.onclick=()=>controller?.load());
  const start=$('[data-start]');if(start)start.onclick=()=>{selected=null;controller?.start(Number($('#sd-bots').value),$('#sd-difficulty').value)};
  document.querySelectorAll('[data-card]').forEach(b=>b.onclick=()=>{if(!gate()||!view.ready)return;const id=b.dataset.card;selected=selected===id?null:id;render();document.querySelectorAll('[data-card]').forEach(node=>{if(node.dataset.card===id)node.focus({preventScroll:true})})});
  document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>{selected=null;controller?.act({type:b.dataset.action})});
  const play=$('[data-play]');if(play)play.onclick=()=>{if(!selected||!gate())return;const cardId=selected;selected=null;controller?.act({type:play.dataset.play,cardId})};
  const resign=$('[data-resign]');if(resign)resign.onclick=()=>{if(!gate()||!view.ready)return;resign.outerHTML='<div class="sd-resign"><p>Завершить эту партию? Карты этого стола больше нельзя будет доиграть.</p><button class="sd-button" data-resign-cancel>Продолжить партию</button><button class="sd-button" data-resign-confirm>Завершить</button></div>';$('.sd-resign [data-resign-cancel]').onclick=render;$('.sd-resign [data-resign-confirm]').onclick=()=>controller?.act({type:'resign'});$('.sd-resign [data-resign-cancel]').focus()};
}
function boot(){
  const a=window.VEZDEHOT?.account();if(!a)return;
  if(owner&&owner!==a.user?.id){controller?.destroy();controller=null;owner=null;selected=null;view={phase:'loading',game:null,revision:0,ready:false,busy:false};}
  if(controller&&!gate()){controller.destroy();controller=null;view={...view,ready:false,busy:false};}
  if(!controller&&a.user&&!a.loading&&!a.switching&&window.VEZDEHOT_TAB_SESSION?.canWrite()===true){owner=a.user.id;controller=createController({scope:owner,current:gate,request:b=>window.VEZDEHOT.serverDurakRequest(b),storage:{getItem:key=>window.localStorage.getItem(key),setItem:(key,value)=>window.localStorage.setItem(key,value),removeItem:key=>window.localStorage.removeItem(key)},uuid:()=>{if(typeof crypto.randomUUID!=='function')throw new Error('Открой игру по защищённой ссылке HTTPS.');return crypto.randomUUID()},onChange:state=>{view=state;if(selected&&!state.game?.legal.cards.includes(selected))selected=null;render()}});controller.load();}
  render();
}
Promise.resolve(window.VEZDEHOT?.ready).then(boot);
for(const event of ['vezdehot:profile','vezdehot:sessionactive'])document.addEventListener(event,boot);
for(const event of ['vezdehot:sessionpause','vezdehot:sessionlost'])document.addEventListener(event,()=>{controller?.destroy();controller=null;owner=null;view={...view,ready:false,busy:false};render()});
document.addEventListener('vezdehot:accountchange',()=>{controller?.destroy();controller=null;owner=null;selected=null;view={phase:'loading',game:null,revision:0,ready:false,busy:false};render()});
window.addEventListener('online',()=>{if(gate()&&!view.busy)controller?.load()});
document.addEventListener('visibilitychange',()=>{if(document.hidden){controller?.destroy();controller=null;view={...view,ready:false,busy:false}}else boot()});
})();
