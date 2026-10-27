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
  if(g.trumpCard!==undefined&&g.trumpCard!==null&&(!card(g.trumpCard)||g.trumpCard.suit!==g.trump))throw new Error('Козырь стола не удалось проверить. Повтори загрузку.');
  if(g.roundLimit!==undefined&&g.roundLimit!==null&&(!Number.isInteger(g.roundLimit)||g.roundLimit<1||g.roundLimit>6||g.roundLimit<g.table.length))throw new Error('Лимит захода не удалось проверить. Повтори загрузку.');
  if(g.economy!==undefined){const e=g.economy,keys=['version','stake','settled','payout','xp','outcome'];if(!e||typeof e!=='object'||Array.isArray(e)||Object.keys(e).length!==keys.length||keys.some(k=>!Object.hasOwn(e,k))||e.version!==1||![0,100].includes(e.stake)||typeof e.settled!=='boolean'||e.settled!==g.over||!Number.isSafeInteger(e.payout)||e.payout<0||e.payout>400||!Number.isSafeInteger(e.xp)||e.xp<0||e.xp>80||(!e.settled&&(e.payout!==0||e.xp!==0||e.outcome!==null))||(e.settled&&!['win','draw','loss','resigned'].includes(e.outcome))||(e.stake===0&&(e.payout!==0||e.xp!==0)))throw new Error('Расчёт серверного стола не удалось проверить. Повтори загрузку.');}
  return value;
}
function validFlight(value){
  if(!value||typeof value!=='object'||!UUID.test(value.actionId)||!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<0)return false;
  const keys=Object.keys(value);
  if(value.op==='start')return keys.every(k=>['op','actionId','expectedRevision','bots','difficulty','stake'].includes(k))&&[1,2,3].includes(value.bots)&&['easy','normal','hard'].includes(value.difficulty)&&(!Object.hasOwn(value,'stake')||[0,100].includes(value.stake));
  const a=value.action;
  return value.op==='action'&&keys.every(k=>['op','actionId','expectedRevision','gameId','action'].includes(k))&&typeof value.gameId==='string'&&a&&ACTIONS.includes(a.type)&&Object.keys(a).every(k=>['type','cardId'].includes(k))&&(['attack','defend'].includes(a.type)?typeof a.cardId==='string':Object.keys(a).length===1);
}
// A tap or a drop is only an intent. The current server projection decides the move.
function cardAction(state,id){
  const g=state?.game;
  if(!state?.ready||state.busy||state.pending||!g||g.over||!g.players[0].hand.some(c=>c.id===id)||!g.legal.cards.includes(id))return null;
  const moves=g.legal.actions.filter(a=>a==='attack'||a==='defend');
  return moves.length===1?{type:moves[0],cardId:id}:null;
}
function createController(options){
  const key='vezdehot:server-durak:pending:v1:'+options.scope;
  let disposed=false,busy=false,sequence=0,flight=null,lastConfirmedRevision=-1,state={phase:'loading',revision:0,game:null,notice:'',ready:false};
  const current=()=>!disposed&&options.current()===true;
  const publish=()=>{if(current())options.onChange?.({...state,busy,pending:!!flight})};
  const own=()=>{if(!current())throw Object.assign(new Error('Управление передано другой вкладке или аккаунту.'),{code:'STALE_ACCOUNT'})};
  // Removal may have succeeded before its verification read failed. A missing
  // record is safe after the same acknowledged request; a replacement is not.
  const clear=()=>{own();const raw=options.storage.getItem(key);if(raw!==null&&raw!==JSON.stringify(flight))throw new Error('Сохранённый запрос изменился. Обнови страницу перед следующим ходом.');if(raw!==null){options.storage.removeItem(key);if(options.storage.getItem(key)!==null)throw new Error('Не удалось подтвердить ответ на устройстве. Повтори запрос.');}flight=null;};
  const stage=body=>{own();const raw=JSON.stringify(body);options.storage.setItem(key,raw);if(options.storage.getItem(key)!==raw)throw new Error('Не удалось сохранить запрос. Освободи память браузера и повтори.');flight=JSON.parse(raw)};
  const call=async body=>{own();const result=await options.request(JSON.parse(JSON.stringify(body)));own();return result};
  const confirmWallet=(revision,force=false)=>{if(!force&&revision<=lastConfirmedRevision)return;lastConfirmedRevision=Math.max(lastConfirmedRevision,revision);try{Promise.resolve(options.onConfirmed?.()).catch(()=>{});}catch{}};
  const fetchState=async()=>{const response=await call({op:'load'});if(!response.ok)throw new Error(response.status===401?'Войди в аккаунт ещё раз, чтобы открыть стол.':'Сервер временно недоступен. Повтори загрузку.');const next=projection(response.data);if(next.revision<state.revision)throw new Error('Получена устаревшая версия стола. Повтори загрузку.');state={...state,revision:next.revision,game:next.game,phase:'saved',ready:true};confirmWallet(next.revision);};
  async function sendFlight(){
    if(!validFlight(flight))throw new Error('Сохранённый запрос повреждён. Открой эту партию на другом устройстве.');
    const response=await call(flight);
    if(!response.ok){
      if([400,409,422].includes(response.status)){const insufficient=response.status===422&&response.data?.error==='insufficient_funds';clear();state.notice=insufficient?'Недостаточно серверных монет для входа. Монеты не списаны; можно выбрать бесплатную практику.':'Этот ход не принят. Показан актуальный стол — выбери действие заново.';if(insufficient)confirmWallet(state.revision,true);await fetchState();return;}
      throw new Error(response.status===401?'Подтверди вход и повтори запрос. Он сохранён с тем же номером.':'Ответ не получен. Повтори запрос: один ход не будет применён дважды.');
    }
    if(response.data?.status==='conflict'){clear();state.notice='Стол уже изменился на другом устройстве. Загружена актуальная партия.';await fetchState();return;}
    if(response.data?.status!=='saved')throw new Error('Подтверждение хода неполное. Повтори тот же запрос.');
    const receipt=projection(response.data);
    if(!receipt.game||receipt.revision!==flight.expectedRevision+1||(flight.op==='action'&&receipt.game.id!==flight.gameId))throw new Error('Подтверждение хода не соответствует запросу. Повтори тот же запрос.');
    if(flight.op==='start'&&flight.stake===100&&receipt.game.economy?.stake!==100)throw new Error('Сервер не подтвердил вход 100 V. Повтори тот же запрос.');
    clear();
    // The receipt proves this revision exists even when the next read fails.
    // Keep its floor without rendering an old receipt over a newer phone move.
    if(receipt.revision>state.revision)state.revision=receipt.revision;
    confirmWallet(receipt.revision);
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
  return Object.freeze({load,start:(bots=1,difficulty='normal',stake=0)=>![0,100].includes(stake)||state.game&&!state.game.over?Promise.resolve(false):mutate({op:'start',bots,difficulty,...(stake?{stake}:{})}),act:action=>state.game&&!state.game.over?mutate({op:'action',gameId:state.game.id,action}):Promise.resolve(false),status:()=>({...state,busy,pending:!!flight}),destroy:()=>{disposed=true;sequence++;}});
}
window.VEZDEHOT_SERVER_DURAK=Object.freeze({createController,projection,validFlight,cardAction});
if(!document.getElementById('app'))return;
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let controller=null,owner=null,selected=null,gestures=null,setupChoice=null,walletMounted=false,view={phase:'loading',game:null,revision:0,ready:false,busy:true};
const gate=()=>!!owner&&window.VEZDEHOT?.scopeKey()===owner&&window.VEZDEHOT?.account().user?.id===owner&&!window.VEZDEHOT.account().switching&&window.VEZDEHOT_TAB_SESSION?.canWrite()===true&&!document.hidden;
const writable=()=>gate()&&view.ready&&!view.busy&&!view.pending;
const tableKey=()=>[owner,view.game?.id,view.revision,view.game?.phase].join('|');
const stopGestures=()=>{gestures?.destroy();gestures=null;};
const walletState=()=>window.VEZDEHOT_SERVER_WALLET?.status();
function canPayStake(stake){const state=walletState();return stake===0||stake===100&&state?.ready===true&&!state.busy&&!state.pending&&Number.isSafeInteger(state.wallet?.balance)&&state.wallet.balance>=stake;}
function entryMessage(stake){if(!stake)return 'Бесплатная практика: монеты и XP не меняются.';const state=walletState();if(state?.phase==='offline')return 'Серверный баланс недоступен. Обнови его ниже или выбери бесплатную практику.';if(!state?.ready||state.busy||state.pending)return 'Проверяем серверный баланс перед входом…';if(!canPayStake(stake))return 'Для входа нужно 100 V на серверном балансе. Можно выбрать бесплатную практику.';return 'Серверный баланс: '+state.wallet.balance+' V. Вход 100 V списывается один раз на партию.';}
function playCard(id,key=tableKey()){
  if(!controller||!writable()||key!==tableKey())return false;
  const action=cardAction(controller.status(),id);if(!action)return false;
  selected=null;controller.act(action);return true;
}
const cardFace=(c,extra='')=>`<span class="sd-card ${['♥','♦'].includes(c.suit)?'red':''} ${extra}"><span>${esc(c.rank)}<small>${esc(c.suit)}</small></span><b aria-hidden="true">${esc(c.suit)}</b><i aria-hidden="true">${esc(c.rank)}${esc(c.suit)}</i></span>`;
// Older receipts omit the limit. Public hand count plus played defences gives
// the defender's starting count; this is display-only, never move authority.
function displayedRoundLimit(g){return Number.isInteger(g.roundLimit)?g.roundLimit:Math.min(6,Math.max(1,g.players[g.defender].handCount+g.table.filter(pair=>pair.d).length));}
function statusText(g){
  if(g.over)return resultSummary(g).title;
  if(view.busy)return 'Подтверждаем ход…';
  if(view.phase==='offline')return 'Ждём подтверждения';
  if(g.finished.includes(0))return 'Ты вышел без карт';
  if(g.legal.actions.includes('defend'))return 'Твоя защита';
  if(g.legal.actions.includes('take'))return 'Можно забрать карты';
  if(g.legal.actions.includes('finish')&&!g.legal.cards.length)return 'Все карты отбиты';
  if(g.legal.actions.includes('attack')&&g.legal.cards.length)return g.table.length?'Можно подкинуть':'Твой ход';
  return g.phase==='resolve'?'Карта отбита':'Раунд завершён';
}
function turnExplanation(g){if(view.ready&&!view.busy&&!view.pending){if(g.legal.actions.includes('finish')&&!g.legal.cards.length)return 'Нажми «Бито» — начнётся следующий заход.';if(g.legal.actions.includes('take')&&!g.legal.cards.length)return 'Отбить нечем. Забери карты, чтобы продолжить партию.';}return g.message;}
function actionButton(action,label,primary=false){return `<button class="sd-button ${primary?'primary':''}" data-action="${action}" ${!writable()?'disabled':''}>${label}</button>`;}
function controls(g){
  if(!view.ready)return `<button class="sd-button primary" data-retry ${view.busy||!gate()?'disabled':''}>${view.busy?'Подтверждаем…':view.pending?'Повторить этот запрос':'Загрузить стол'}</button>`;
  if(g.finished.includes(0))return g.legal.actions.includes('continue')?actionButton('continue','Завершить партию ботов',true):'<button class="sd-button primary" data-retry>Обновить итог партии</button>';
  const actions=g.legal.actions,move=g.legal.cards.length?(actions.includes('defend')?'defend':actions.includes('attack')?'attack':null):null,playable=selected&&writable()&&!!cardAction(view,selected);
  return `${move?`<button class="sd-button primary" data-play="${move}" ${!playable?'disabled':''}>${move==='defend'?'Отбить':'Положить'}${playable?' '+esc(selected):' карту'}</button>`:''}${actions.includes('take')?actionButton('take','Забрать карты',!move):''}${actions.includes('finish')?actionButton('finish','Бито · дальше',!move):''}${actions.includes('continue')?actionButton('continue',g.phase==='roundEnd'?'Следующий раунд →':'Продолжить атаку →',true):''}`;
}
function selectedCard(g){return selected?g.players[0].hand.find(c=>c.id===selected):null;}
function inspectReason(g,c){
  if(!gate())return 'Для хода верни управление этой вкладке. Карты останутся за столом.';
  if(!view.ready||view.busy||view.pending)return 'Дождись подтверждения хода. Карты обновятся после ответа сервера.';
  if(cardAction(view,c.id))return g.legal.actions.includes('defend')?'Эта карта отбивает атаку. Подтверди кнопкой «Отбить» или перетащи карту на стол.':'Эту карту можно сыграть. Подтверди кнопкой «Положить» или перетащи её на стол.';
  if(g.finished.includes(0))return 'Ты уже вышел без карт. Осталось дождаться итога партии.';
  const attack=g.table.find(pair=>!pair.d)?.a;
  if(g.defender===0&&attack){
    if(attack.suit===g.trump&&attack.rank==='A')return 'Атакует старший козырь '+attack.id+'. Его отбить нельзя — забери карты.';
    if(attack.suit===g.trump&&c.suit!==g.trump)return 'Атакует козырь '+attack.id+'. Его можно отбить только старшим козырем.';
    if(c.suit===attack.suit)return 'Эта карта не старше '+attack.id+'. Нужна старшая карта масти '+attack.suit+(attack.suit!==g.trump?' или козырь '+g.trump:'')+'.';
    return 'Нужна старшая карта масти '+attack.suit+' или козырь '+g.trump+'.';
  }
  if(g.legal.actions.includes('finish')&&!g.legal.cards.length){const limit=displayedRoundLimit(g);return g.table.length>=limit?(limit===6?'В этом заходе уже шесть пар.':`Лимит этого захода — ${limit}: столько карт было у защитника в начале.`)+' Нажми «Бито», чтобы продолжить партию.':'Подходящих карт для подкидывания нет. Заверши заход кнопкой «Бито».';}
  if(g.legal.actions.includes('attack')&&g.table.length){const ranks=[...new Set(g.table.flatMap(pair=>[pair.a.rank,...(pair.d?[pair.d.rank]:[])]))];return 'Подкинуть можно только достоинства, которые уже есть на столе: '+ranks.join(', ')+'.';}
  if(g.legal.actions.includes('finish'))return 'Все карты отбиты. Заверши заход кнопкой «Бито».';
  if(g.legal.actions.includes('continue'))return 'Сначала продолжи заход кнопкой. Карты останутся в твоей руке.';
  return 'Сейчас эту карту сыграть нельзя. Дождись своего хода.';
}
function selectionView(g){const c=selectedCard(g);if(!c&&!g.legal.cards.length)return '';if(!c)return '<span class="sd-selection-label">ВЫБЕРИ КАРТУ</span><b>Нажми на карту в руке</b><p>Светлые карты подходят для хода. Другую карту можно выбрать, чтобы узнать, почему она не подходит.</p>';const playable=!!cardAction(view,c.id);return `<span class="sd-selection-label ${playable?'is-legal':''}">${playable?'МОЖНО СЫГРАТЬ':'ОСМОТР КАРТЫ'}</span><b>Карта ${esc(c.id)}</b><p>${esc(inspectReason(g,c))}</p>`;}
function paintSelection(){
  const g=view.game;if(!g||g.over)return;
  document.querySelectorAll('[data-card]').forEach(node=>{const picked=node.dataset.card===selected;node.setAttribute('aria-pressed',String(picked));node.setAttribute('class','sd-hand-card'+(!g.legal.cards.includes(node.dataset.card)?' unavailable':'')+(picked?' selected':''));});
  const hint=$('[data-hand-hint]');if(hint)hint.innerHTML=esc(handHint(g));
  const info=$('[data-selection]');if(info)info.innerHTML=selectionView(g);
  const actions=$('.sd-actions');if(actions)actions.innerHTML=controls(g);
  bindPlayControls();
}
function playHelp(g){
  if(view.busy)return 'Сохраняем ход. Карты обновятся после подтверждения.';
  if(!view.ready)return 'Восстанови связь кнопкой выше, чтобы продолжить эту партию.';
  if(g.finished.includes(0))return 'Твои ходы закончены. Сервер доиграет оставшихся ботов по обычным правилам и сохранит итог этой партии.';
  if(g.legal.actions.includes('defend'))return 'Перетащи карту на стол или выбери её и нажми «Отбить». На решение нет таймера.';
  if(g.legal.actions.includes('attack'))return 'Перетащи карту на стол или выбери её и нажми «Положить». На решение нет таймера.';
  if(g.legal.actions.includes('continue'))return g.phase==='roundEnd'?'Заход завершён. Следующий раунд продолжит эту же партию.':'Карта отбита. Нажми «Продолжить атаку», чтобы увидеть следующие ходы.';
  if(g.legal.actions.includes('finish'))return 'Все карты отбиты. Нажми «Бито», чтобы закончить этот заход.';
  return 'Если отбиться нечем, забери карты. Партия продолжится за этим же столом.';
}
function handHint(g){
  if(g.finished.includes(0))return 'Твои ходы закончены';
  if(selected)return (g.legal.cards.includes(selected)?'Выбрана ':'Осмотр: ')+selected;
  if(g.legal.cards.length)return g.players[0].hand.length>7?'Листай карты вбок':'Светлые карты можно сыграть';
  if(g.legal.actions.includes('take'))return 'Нет карты для защиты';
  if(g.legal.actions.includes('continue'))return 'Продолжи заход кнопкой';
  if(g.legal.actions.includes('finish'))return 'Все карты отбиты';
  return 'Ход соперника';
}
function journal(g){
  const names=i=>g.players[i]?.name||'Игрок',c=x=>x?x.rank+x.suit:'';
  return g.journal.slice().reverse().map(e=>{const who=names(e.actor),line={start:who+' начинает партию',attack:who+' атакует '+c(e.card),defense:who+' отбивает '+c(e.against)+' картой '+c(e.card),take:who+' забирает '+e.count+' карт',discard:'Бито · '+e.count+' карт',draw:who+' добирает '+e.count+' карт',out:who+' вышел из игры без карт',end:'Партия завершена',next:'Следующий ход · '+who}[e.kind];return line?`<li><small>Раунд ${esc(e.round)}</small><span>${esc(line)}</span></li>`:''}).join('');
}
function rematchSettings(g){return {bots:g?g.players.length-1:1,difficulty:g&&['easy','normal','hard'].includes(g.difficulty)?g.difficulty:'normal',stake:g?.economy?.stake===100?100:0};}
function setupSettings(g){const key=[window.VEZDEHOT?.account().user?.id||'',g?.id||'setup'].join('|');if(!setupChoice||setupChoice.key!==key)setupChoice={key,...rematchSettings(g)};return setupChoice;}
function resultSummary(g){
  if(g.resigned)return {kind:'resigned',title:'Ты завершил стол',reason:'Партия остановлена досрочно. Победитель по картам не определён.'};
  if(g.draw)return {kind:'draw',title:'Ничья',reason:'Колода пуста, и ни у кого не осталось карт.'};
  const loser=Number.isInteger(g.loser)?g.players[g.loser]:null;
  if(g.loser===0)return {kind:'lost',title:'Ты остался с картами',reason:'В твоей руке осталось карт: '+g.players[0].handCount+'. Остальные игроки вышли без карт.'};
  if(g.finished.includes(0)||g.winner===0)return {kind:'won',title:'Ты выиграл!',reason:'Ты вышел без карт.'+(loser?' '+loser.name+' — последний игрок с картами: '+loser.handCount+'.':'')};
  return {kind:'ended',title:'Партия завершена',reason:g.message||'Результат партии получен от сервера.'};
}
function setup(over=false){const settings=setupSettings(over?view.game:null);return `<section class="sd-setup"><span class="sd-eyebrow">СЕРВЕРНЫЙ СТОЛ</span>${over?'<h2>Настройки новой партии</h2>':'<h1>Карты остаются за столом</h1><p>Начни здесь, продолжи с того же аккаунта на телефоне или ПК. Раздача, ходы и ответы ботов проверяются сервером.</p>'}<div class="sd-setup-options"><label>Соперники<select id="sd-bots" data-setup>${['Один бот','Два бота','Три бота'].map((label,i)=>`<option value="${i+1}" ${settings.bots===i+1?'selected':''}>${label}</option>`).join('')}</select></label><label>Характер ботов<select id="sd-difficulty" data-setup>${[['easy','Мягкий'],['normal','Обычный'],['hard','Расчётливый']].map(([value,label])=>`<option value="${value}" ${settings.difficulty===value?'selected':''}>${label}</option>`).join('')}</select></label><label class="sd-entry-choice">Режим<select id="sd-stake" data-setup><option value="0" ${settings.stake===0?'selected':''}>Бесплатная практика</option><option value="100" ${settings.stake===100?'selected':''}>Серверный вход · 100 V</option></select></label></div><p class="sd-entry-note" role="status">${entryMessage(settings.stake)}</p><button class="sd-button primary" data-start ${!writable()||!canPayStake(settings.stake)?'disabled':''}>Открыть стол · ${settings.stake?'100 V':'бесплатно'}</button><p class="sd-footnote">Серверный баланс отдельный. Монеты практики сохраняются; перевода между балансами нет. Все монеты игровые, без денежной стоимости.</p></section>`;}
function resultView(g){
  const summary=resultSummary(g),settings=rematchSettings(g),difficulty={easy:'Мягкий',normal:'Обычный',hard:'Расчётливый'}[settings.difficulty],e=g.economy;
  const players=g.players.map((p,i)=>`<li class="${!g.resigned&&!g.draw&&g.loser===i?'is-last':''}"><span aria-hidden="true">${esc(p.face||'♟')}</span><div><b>${esc(i===0?'Ты':p.name)}</b><small>${g.resigned?'Карт при остановке: '+p.handCount:g.draw?'Без карт · ничья':g.loser===i?'Осталось карт: '+p.handCount:'Вышел без карт'}</small></div></li>`).join('');
  const settlement=e?.stake&&e.settled?`<dl class="sd-settlement" aria-label="Серверный расчёт"><div><dt>Вход</dt><dd>${e.stake} V</dd></div><div><dt>Возвращено</dt><dd>${e.payout} V</dd></div><div><dt>Чистый итог</dt><dd>${e.payout-e.stake>0?'+':''}${e.payout-e.stake} V</dd></div><div><dt>Опыт</dt><dd>+${e.xp} XP</dd></div></dl><p class="sd-settlement-note">Расчёт подтверждён сервером. ${entryMessage(settings.stake)}</p>`:'';
  return `<section class="sd-result" data-outcome="${summary.kind}" aria-label="Результат партии"><span class="sd-result-symbol" aria-hidden="true">${summary.kind==='won'?'✦':summary.kind==='resigned'?'Ⅱ':summary.kind==='draw'?'=':'♠'}</span><span class="sd-eyebrow">ИТОГ ПАРТИИ</span><h1>${summary.title}</h1><p>${esc(summary.reason)}</p><dl class="sd-result-facts"><div><dt>Раундов</dt><dd>${esc(g.round)}</dd></div><div><dt>Соперников</dt><dd>${g.players.length-1}</dd></div><div><dt>Характер</dt><dd>${difficulty}</dd></div></dl><ol class="sd-final-players" aria-label="Как закончили игроки">${players}</ol>${settlement}<div class="sd-result-actions"><button class="sd-button primary" data-rematch ${!writable()||!canPayStake(settings.stake)?'disabled':''}>${view.busy?'Открываем стол…':'Ещё партия · '+(settings.stake?'100 V':'бесплатно')}</button></div><p class="sd-rematch-note">С тем же числом соперников и сложностью. ${settings.stake?'Новый вход — 100 V.':'Без ставки и XP.'}</p></section><details class="sd-rematch-settings" data-replay-settings><summary>Изменить настройки</summary>${setup(true)}</details>`;
}
function captureTableView(app,key){
  if(!key||app.dataset.tableKey!==key)return null;
  const active=document.activeElement;
  return {key,handScroll:app.querySelector('.sd-hand')?.scrollLeft||0,focusCard:app.contains(active)?active?.dataset?.card:null,focusSetup:app.contains(active)&&active?.hasAttribute('data-setup')?active.id:null,rulesOpen:!!app.querySelector('[data-rules]')?.open,journalOpen:!!app.querySelector('[data-journal]')?.open,replayOpen:!!app.querySelector('[data-replay-settings]')?.open,journalScroll:app.querySelector('.sd-journal ol')?.scrollTop||0};
}
function restoreTableView(app,key,memory){
  if(!memory||memory.key!==key)return;
  const hand=app.querySelector('.sd-hand');if(hand)hand.scrollLeft=memory.handScroll;
  for(const [selector,open] of [['[data-rules]',memory.rulesOpen],['[data-journal]',memory.journalOpen],['[data-replay-settings]',memory.replayOpen]]){const panel=app.querySelector(selector);if(panel)panel.open=open;}
  const log=app.querySelector('.sd-journal ol');if(log)log.scrollTop=memory.journalScroll;
  if(memory.focusCard){const card=[...app.querySelectorAll('[data-card]')].find(node=>node.dataset.card===memory.focusCard);if(card&&!card.disabled)card.focus({preventScroll:true});}
  else if(memory.focusSetup){const field=[...app.querySelectorAll('[data-setup]')].find(node=>node.id===memory.focusSetup);if(field&&!field.disabled)field.focus({preventScroll:true});}
}
function tableNotes(g){return `<details class="sd-rules" data-rules><summary>Правила этого стола</summary><p>В колоде 36 карт. Старшая карта той же масти отбивает младшую; козырь отбивает другую масть. Козырь можно отбить только старшим козырем.</p><p>Атакующий подкидывает карты того же достоинства, что уже есть на столе. В одном заходе не больше шести атак и не больше карт, чем было у защитника в начале захода.</p><p>Если отбиться нечем, забери карты. После завершения захода игроки добирают до шести. Когда колода пуста, освободи руку: последний игрок с картами проигрывает. После твоего выхода оставшиеся боты доигрывают автоматически.</p></details><details class="sd-journal" data-journal><summary>История ходов <span>${g.journal.length}</span></summary><ol>${journal(g)}</ol></details><footer class="sd-footer">${!g.over?`<p>Чтобы продолжить на другом устройстве, дождись статуса «Ходы сохранены» и войди там в тот же аккаунт.</p>${!g.finished.includes(0)?`<button class="sd-link" data-resign ${!writable()?'disabled':''}>Завершить этот стол</button>`:''}`:''}<a class="sd-link" href="./index.html?view=lobby">Все игры →</a></footer>`;}
function render(focusCard){
  stopGestures();
  const app=$('#app');if(!app)return;const a=window.VEZDEHOT?.account(),g=view.game,key=a?.user?[a.user.id,g?.id||'setup'].join('|'):'',memory=captureTableView(app,key);
  if(memory&&typeof focusCard==='string')memory.focusCard=focusCard;
  const paint=html=>{app.innerHTML=html;app.dataset.tableKey=key;bind();restoreTableView(app,key,memory);};
  const header=`<header class="sd-header"><a class="sd-back" href="./index.html?view=lobby" aria-label="В лобби">‹</a><div><a class="sd-brand" href="./index.html?view=lobby">VEZDEHOT</a><span>Дурак · серверный стол</span></div><button class="sd-account" data-account>${esc(a?.user?window.VEZDEHOT.getProfile().nick:'Войти')}</button></header>`;
  const notice=view.notice?`<div class="sd-notice" role="status">${esc(view.notice)}</div>`:'';
  if(!a?.user){paint(header+`<section class="sd-setup"><span class="sd-eyebrow">ОДНА ПАРТИЯ · РАЗНЫЕ УСТРОЙСТВА</span><h1>Твой стол ждёт тебя</h1><p>Войди в аккаунт: сервер сохранит карты и каждый подтверждённый ход. Соперник — бот, ставка не нужна.</p><button class="sd-button primary" data-account ${a?.loading||a?.switching?'disabled':''}>Войти и открыть стол</button><a class="sd-link" href="./index.html?view=lobby">Вернуться к играм для гостя →</a></section>`);return;}
  const stateTitle=!gate()?'Управление недоступно':view.busy?'Сохраняем ход…':view.phase==='saved'?'Ходы сохранены':'Нужна связь';
  const sync=`<div class="sd-sync" role="status"><span class="sd-sync-dot ${view.phase==='saved'&&gate()?'saved':''}"></span><span>${stateTitle}</span><button data-retry ${view.busy||!gate()?'disabled':''}>${view.pending?'Повторить запрос':'Обновить'}</button></div>`;
  if(!g){paint(header+sync+notice+setup());return;}
  if(g.over){paint(header+sync+notice+resultView(g)+tableNotes(g));return;}
  const legal=new Set(g.legal.cards),players=g.players.slice(1).map((p,i)=>{
    const seat=i+1,active=!g.over&&((g.phase==='defend'&&g.defender===seat)||(g.phase==='attack'&&g.attacker===seat)),finished=g.finished.includes(seat);
    return `<article class="sd-player ${active?'active':''} ${finished?'finished':''}"><div class="sd-seat"><span class="sd-avatar" aria-hidden="true">${esc(p.face||'♟')}</span><span class="sd-card-count" aria-label="${p.handCount} карт">${p.handCount}</span></div><b>${esc(p.name)}</b><small>${finished?'Без карт':g.defender===seat?'Защищается':g.attacker===seat?'Атакует':'За столом'}</small><span class="sd-hidden" aria-hidden="true"><i></i><i></i><i></i></span></article>`;
  }).join('');
  const board=g.table.length?g.table.map((p,i)=>`<div class="sd-pair ${p.d?'beaten':'unbeaten'}" aria-label="Пара ${i+1}${p.d?', отбита':', нужно отбить'}"><span class="sd-pair-number">${i+1}</span>${cardFace(p.a,'attack')}${p.d?cardFace(p.d,'defence'):'<span class="sd-wait" aria-hidden="true">↗</span>'}</div>`).join(''):`<div class="sd-empty-table"><span aria-hidden="true">♠</span><b>${g.finished.includes(0)?'Боты завершают партию':'Твой следующий ход'}</b><small>Сыгранные карты — здесь</small></div>`;
  const cards=g.players[0].hand,fan=cards.length<=7,center=(cards.length-1)/2;
  const hand=cards.map((c,i)=>`<button class="sd-hand-card ${!legal.has(c.id)?'unavailable':''} ${selected===c.id?'selected':''}" data-card="${esc(c.id)}" style="--angle:${fan?(i-center):0}deg;--lift:${fan?Math.abs(i-center)*.8:0}px;--order:${i}" aria-pressed="${selected===c.id}" data-legal="${legal.has(c.id)?1:0}" aria-describedby="sd-card-help" aria-label="${esc(c.rank+' '+c.suit)}${legal.has(c.id)?', можно сыграть':', нельзя сыграть. Нажми, чтобы узнать почему'}" ${!writable()?'disabled':''}>${cardFace(c)}</button>`).join('');
  const handArea=`<section class="sd-hand-dock" aria-label="Твоя рука"><div class="sd-hand-label"><b>Твоя рука <span>${cards.length}</span></b><span data-hand-hint>${esc(handHint(g))}</span></div><div class="sd-hand ${fan?'fan':'many'}" aria-label="Твои карты">${hand||'<p class="sd-hand-empty">Ты вышел без карт</p>'}</div></section>`;
  const command=`<aside class="sd-control" aria-label="Управление партией"><span class="sd-eyebrow">${g.finished.includes(0)?'ОЖИДАЕМ ИТОГ':'ТВОЁ РЕШЕНИЕ'}</span><div class="sd-turn" role="status"><span class="sd-turn-dot" aria-hidden="true"></span><div><h1>${statusText(g)}</h1><p>${esc(turnExplanation(g))}</p></div></div><div class="sd-selection" id="sd-card-help" data-selection role="status" aria-live="polite">${selectionView(g)}</div><div class="sd-actions">${controls(g)}</div>${g.legal.cards.length?`<p class="sd-help">${playHelp(g)}</p>`:''}<div class="sd-control-facts"><span>Козырь <b class="${['♥','♦'].includes(g.trump)?'red':''}">${esc(g.trump)}</b></span><span>На столе <b>${g.table.length} / ${displayedRoundLimit(g)}</b></span></div></aside>`;
  const stock=`<div class="sd-stock" aria-label="В колоде ${g.deckCount} карт. Козырь ${esc(g.trumpCard?g.trumpCard.rank+g.trump:g.trump)}"><div class="sd-deck-art" aria-hidden="true"><span class="sd-trump ${['♥','♦'].includes(g.trump)?'red':''}">${g.trumpCard?`<small>${esc(g.trumpCard.rank)}</small>`:''}${esc(g.trump||'—')}</span>${g.deckCount?'<span class="sd-pack"><i>V</i></span>':''}</div><div><b>${g.deckCount}</b><span>в колоде</span></div></div><div class="sd-discard"><b>${g.discardCount}</b><span>в отбое</span></div>`;
  paint(header+sync+notice+(!gate()?'<div class="sd-notice">Продолжить можно в активной вкладке после загрузки аккаунта.</div>':'')+`<section class="sd-shell"><div class="sd-table-meta"><span><i></i> ${g.economy?.stake===100?'ВХОД 100 V':'БЕСПЛАТНО'}</span><span>РАУНД ${esc(g.round)}</span></div><div class="sd-layout"><div class="sd-board"><div class="sd-felt"><div class="sd-opponents" style="--opponents:${g.players.length-1}">${players}</div><div class="sd-arena"><div class="sd-stock-rail">${stock}</div><div class="sd-battle" data-drop-zone data-count="${g.table.length}" aria-label="Игровой стол">${board}</div></div><div class="sd-table-caption">${esc(g.players[g.attacker]?.name)} атакует <span>·</span> ${esc(g.players[g.defender]?.name)} защищается</div></div>${handArea}</div>${command}</div></section>`+tableNotes(g));
}
function bindPlayControls(){
  document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>{if(!writable()||!view.game?.legal.actions.includes(b.dataset.action))return;selected=null;controller?.act({type:b.dataset.action})});
  const play=$('[data-play]');if(play)play.onclick=()=>{if(selected)playCard(selected)};
  document.querySelectorAll('.sd-actions [data-retry]').forEach(b=>b.onclick=()=>controller?.load());
}
function bind(){
  document.querySelectorAll('[data-account]').forEach(b=>b.onclick=()=>window.VEZDEHOT.openAccount());
  document.querySelectorAll('[data-retry]').forEach(b=>b.onclick=()=>controller?.load());
  document.querySelectorAll('[data-setup]').forEach(field=>field.onchange=()=>{const settings=setupSettings(view.game?.over?view.game:null);settings.bots=Number($('#sd-bots').value);settings.difficulty=$('#sd-difficulty').value;settings.stake=Number($('#sd-stake').value);render()});
  const start=$('[data-start]');if(start)start.onclick=()=>{const stake=Number($('#sd-stake').value);if(!writable()||!canPayStake(stake))return;selected=null;controller?.start(Number($('#sd-bots').value),$('#sd-difficulty').value,stake)};
  const rematch=$('[data-rematch]');if(rematch)rematch.onclick=()=>{if(!writable()||!view.game?.over)return;const current=controller?.status();if(!current?.game?.over||current.game.id!==view.game.id)return;const settings=rematchSettings(current.game);if(!canPayStake(settings.stake))return;selected=null;controller.start(settings.bots,settings.difficulty,settings.stake)};
  document.querySelectorAll('[data-card]').forEach(b=>b.onclick=()=>{const id=b.dataset.card;if(!writable()||!view.game?.players[0].hand.some(c=>c.id===id))return;selected=selected===id?null:id;paintSelection()});
  bindPlayControls();
  const root=$('.sd-shell'),key=tableKey();
  if(root&&window.VEZDEHOT_CARDS)gestures=window.VEZDEHOT_CARDS.bind({root,cardSelector:'.sd-hand-card',dropSelector:'[data-drop-zone]',getCardId:node=>node.dataset.card,getStateKey:tableKey,canStart:id=>writable()&&!!cardAction(view,id),canDrop:id=>writable()&&!!cardAction(view,id),onDrop:id=>playCard(id,key)});
  const resign=$('[data-resign]');if(resign)resign.onclick=()=>{if(!writable())return;stopGestures();resign.outerHTML='<div class="sd-resign"><p>Завершить эту партию? Карты этого стола больше нельзя будет доиграть.'+(view.game?.economy?.stake===100?' Вход 100 V не возвращается, XP за выход не начисляются.':'')+'</p><button class="sd-button" data-resign-cancel>Продолжить партию</button><button class="sd-button" data-resign-confirm>Завершить</button></div>';$('.sd-resign [data-resign-cancel]').onclick=render;$('.sd-resign [data-resign-confirm]').onclick=()=>{if(writable())controller?.act({type:'resign'})};$('.sd-resign [data-resign-cancel]').focus()};
}
function attachWallet(){
  const wallet=window.VEZDEHOT_SERVER_WALLET,host=$('#server-wallet');if(walletMounted||!wallet||!host)return;
  walletMounted=true;wallet.mount(host);wallet.subscribe(()=>{if(!view.game||view.game.over)render()});
}
function boot(){
  attachWallet();
  const a=window.VEZDEHOT?.account();if(!a)return;
  if(owner&&owner!==a.user?.id){controller?.destroy();controller=null;owner=null;selected=null;view={phase:'loading',game:null,revision:0,ready:false,busy:false};}
  if(controller&&!gate()){controller.destroy();controller=null;view={...view,ready:false,busy:false};}
  if(!controller&&a.user&&!a.loading&&!a.switching&&!document.hidden&&window.VEZDEHOT_TAB_SESSION?.canWrite()===true){owner=a.user.id;controller=createController({scope:owner,current:gate,request:b=>window.VEZDEHOT.serverDurakRequest(b),storage:{getItem:key=>window.localStorage.getItem(key),setItem:(key,value)=>window.localStorage.setItem(key,value),removeItem:key=>window.localStorage.removeItem(key)},uuid:()=>{if(typeof crypto.randomUUID!=='function')throw new Error('Открой игру по защищённой ссылке HTTPS.');return crypto.randomUUID()},onConfirmed:()=>window.VEZDEHOT_SERVER_WALLET?.refresh(),onChange:state=>{view=state;if(selected&&!state.game?.players[0]?.hand.some(c=>c.id===selected))selected=null;render()}});controller.load();}
  render();
}
Promise.resolve(window.VEZDEHOT?.ready).then(boot);
for(const event of ['vezdehot:profile','vezdehot:sessionactive'])document.addEventListener(event,boot);
for(const event of ['vezdehot:sessionpause','vezdehot:sessionlost'])document.addEventListener(event,()=>{controller?.destroy();controller=null;owner=null;view={...view,ready:false,busy:false};render()});
document.addEventListener('vezdehot:accountchange',()=>{controller?.destroy();controller=null;owner=null;selected=null;view={phase:'loading',game:null,revision:0,ready:false,busy:false};render()});
window.addEventListener('online',()=>{if(gate()&&!view.busy)controller?.load()});
document.addEventListener('visibilitychange',()=>{if(document.hidden){stopGestures();controller?.destroy();controller=null;view={...view,ready:false,busy:false}}else boot()});
})();
