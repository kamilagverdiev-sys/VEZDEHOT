/* Server-authoritative Hold'em UI. No cards are dealt here and no wallet is changed. */
(()=>{
'use strict';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS=['fold','check','call','raise','continue','nextHand','close','resign'];
const STAGES={preflop:'Префлоп',flop:'Флоп',turn:'Тёрн',river:'Ривер'};
const card=c=>!!c&&typeof c==='object'&&['2','3','4','5','6','7','8','9','10','J','Q','K','A'].includes(c.rank)&&['♠','♥','♦','♣'].includes(c.suit)&&c.id===c.rank+c.suit;
const chips=n=>Number.isInteger(n)&&n>=0&&n<=4000;
const seat=n=>Number.isInteger(n)&&n>=0&&n<4;
function economyOf(g){
  const e=g.economy;if(e===undefined)return null;
  const fail=()=>{throw new Error('Расчёт стола не удалось проверить. Повтори загрузку.')};
  if(!e||typeof e!=='object'||Array.isArray(e)||e.version!==1||![0,100].includes(e.stake)||typeof e.settled!=='boolean'||!Number.isInteger(e.payout)||e.payout<0||e.payout>400||!Number.isInteger(e.xp)||e.xp<0||e.xp>90||![null,'win','draw','loss','resigned'].includes(e.outcome))fail();
  if(e.settled!==g.over||(!e.settled&&(e.payout!==0||e.xp!==0||e.outcome!==null))||(e.settled&&e.outcome===null))fail();
  if(e.stake===0){if(e.payout!==0||e.xp!==0)fail();}
  else if(e.settled){const payout=Math.floor(g.players[0].chips/10),outcome=payout>100?'win':payout===100?'draw':'loss',xp=payout>100?90:payout===100?40:20;if(!g.handOver||e.payout!==payout||e.xp!==xp||e.outcome!==outcome)fail();}
  else if(!g.handOver&&g.legal.actions.some(a=>a==='close'||a==='resign'))fail();
  return e;
}
function paidStartAvailability(walletState){
  if(walletState?.phase!=='saved'||!walletState.ready||walletState.busy||walletState.pending||!Number.isSafeInteger(walletState.wallet?.balance)||walletState.wallet.balance<0)return {allowed:false,reason:'Обнови серверный баланс или выбери бесплатную практику.'};
  if(walletState.wallet.balance<100)return {allowed:false,reason:'Для этого стола нужно 100 V. Можно забрать доступный бонус или играть бесплатно.'};
  return {allowed:true,reason:'100 V за весь стол. Следующие раздачи — без нового списания.'};
}
function projection(value){
  const fail=()=>{throw new Error('Состояние стола не удалось проверить. Повтори загрузку.')};
  if(!value||typeof value!=='object'||!Number.isSafeInteger(value.revision)||value.revision<0||!['saved','ok'].includes(value.status))fail();
  const g=value.game;if(g===null)return value;
  if(!g||!UUID.test(g.id)||!UUID.test(g.handId)||!['betting','review','over'].includes(g.phase)||!Object.hasOwn(STAGES,g.stage)||typeof g.over!=='boolean'||typeof g.handOver!=='boolean'||typeof g.showdown!=='boolean'||typeof g.tableClosed!=='boolean'||!Array.isArray(g.players)||g.players.length!==4||!Array.isArray(g.community)||![0,3,4,5].includes(g.community.length)||g.community.some(c=>!card(c))||Object.hasOwn(g,'deck')||Object.hasOwn(g,'burn'))fail();
  if(g.players.some((p,i)=>!p||typeof p.name!=='string'||p.name.length>80||!chips(p.chips)||!chips(p.roundBet)||!chips(p.totalBet)||typeof p.folded!=='boolean'||typeof p.sittingOut!=='boolean'||![0,2].includes(p.handCount)||(i===0?(!Array.isArray(p.hand)||p.hand.length!==p.handCount||p.hand.some(c=>!card(c))):(Object.hasOwn(p,'hand')&&(!g.handOver||!g.showdown||p.folded||!Array.isArray(p.hand)||p.hand.length!==p.handCount||p.hand.some(c=>!card(c)))))))fail();
  const exposed=[...g.community,...g.players.flatMap(p=>p.hand||[])];if(new Set(exposed.map(c=>c.id)).size!==exposed.length)fail();
  for(let i=0;i<g.players.length;i++){const p=g.players[i],c=p.combination;if(c!==undefined){const visible=new Set([...g.community,...(p.hand||[])].map(c=>c.id));if(i>0&&(!g.handOver||!g.showdown||p.folded)||!c||typeof c.name!=='string'||c.name.length>80||!Number.isInteger(c.category)||c.category<0||c.category>8||!Array.isArray(c.cards)||![0,5].includes(c.cards.length)||c.cards.some(id=>!visible.has(id))||!Array.isArray(c.parts)||c.parts.length>6||c.parts.some(n=>!Number.isInteger(n)||n<0||n>14))fail();}}
  if(g.tableHistory?.some(h=>!h||!Number.isInteger(h.number)||h.number<1||!Number.isInteger(h.net)||Math.abs(h.net)>4000||!chips(h.pot)||!Array.isArray(h.winners)||h.winners.length>4||h.winners.some(n=>typeof n!=='string'||n.length>80)))fail();
  if(!g.legal||!Array.isArray(g.legal.actions)||g.legal.actions.some(a=>!ACTIONS.includes(a))||new Set(g.legal.actions).size!==g.legal.actions.length||['callAmount','owed','minimum','maximum'].some(k=>!Number.isInteger(g.legal[k])||g.legal[k]<0||g.legal[k]>8000)||!chips(g.pot)||!chips(g.paidPot)||!Number.isInteger(g.handNumber)||g.handNumber<1||!seat(g.button)||!seat(g.smallBlind)||!seat(g.bigBlind)||!(g.toAct===-1||seat(g.toAct))||!Array.isArray(g.history)||g.history.length>30||g.history.some(x=>typeof x!=='string')||!Array.isArray(g.pots)||g.pots.length>4||g.pots.some(p=>!p||!chips(p.amount)||!Array.isArray(p.winners)||p.winners.some(i=>!seat(i))||typeof p.refund!=='boolean')||!Array.isArray(g.prizes)||![0,4].includes(g.prizes.length)||g.prizes.some(p=>!chips(p))||!Array.isArray(g.tableHistory)||g.tableHistory.length>12)fail();
  economyOf(g);return value;
}
function validFlight(value){
  if(!value||typeof value!=='object'||!UUID.test(value.actionId)||!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<0)return false;
  const keys=Object.keys(value);
  if(value.op==='start')return keys.every(k=>['op','actionId','expectedRevision','difficulty','stake'].includes(k))&&['easy','normal','hard'].includes(value.difficulty)&&(!Object.hasOwn(value,'stake')||[0,100].includes(value.stake));
  const a=value.action;
  return value.op==='action'&&keys.every(k=>['op','actionId','expectedRevision','gameId','action'].includes(k))&&UUID.test(value.gameId)&&a&&ACTIONS.includes(a.type)&&(a.type==='raise'?Object.keys(a).length===2&&Object.hasOwn(a,'amount')&&Number.isInteger(a.amount)&&a.amount>0&&a.amount<=4000:Object.keys(a).length===1);
}
function equityInput(g){
  if(!g||g.over||g.handOver||g.players[0].folded||g.players[0].hand.length!==2)return null;
  return {hand:g.players[0].hand.map(c=>c.id),board:g.community.map(c=>c.id),opponents:g.players.slice(1).filter(p=>!p.folded&&!p.sittingOut).length};
}
function createController(options){
  const key='vezdehot:server-poker:pending:v1:'+options.scope;
  let disposed=false,busy=false,sequence=0,flight=null,lastConfirmedRevision=-1,state={phase:'loading',revision:0,game:null,notice:'',ready:false};
  const current=()=>!disposed&&options.current()===true;
  const publish=()=>{if(current())options.onChange?.({...state,busy,pending:!!flight})};
  const own=()=>{if(!current())throw Object.assign(new Error('Управление передано другой вкладке или аккаунту.'),{code:'STALE_ACCOUNT'})};
  const clear=()=>{own();const raw=options.storage.getItem(key);if(raw!==JSON.stringify(flight))throw new Error('Сохранённый запрос изменился. Обнови страницу перед следующим ходом.');options.storage.removeItem(key);if(options.storage.getItem(key)!==null)throw new Error('Не удалось подтвердить ответ на устройстве. Повтори запрос.');flight=null;};
  const stage=body=>{own();const raw=JSON.stringify(body);options.storage.setItem(key,raw);if(options.storage.getItem(key)!==raw)throw new Error('Не удалось сохранить запрос. Освободи память браузера и повтори.');flight=JSON.parse(raw)};
  const call=async body=>{own();const result=await options.request(JSON.parse(JSON.stringify(body)));own();return result};
  const confirmWallet=(revision,force=false)=>{if(!current()||!force&&revision<=lastConfirmedRevision)return;lastConfirmedRevision=Math.max(lastConfirmedRevision,revision);try{Promise.resolve(options.onConfirmed?.()).catch(()=>{});}catch{}};
  const fetchState=async()=>{const response=await call({op:'load'});if(!response.ok)throw new Error(response.status===401?'Войди в аккаунт ещё раз, чтобы открыть стол.':'Сервер временно недоступен. Повтори загрузку.');const next=projection(response.data);if(next.revision<state.revision)throw new Error('Получена устаревшая версия стола. Повтори загрузку.');state={...state,revision:next.revision,game:next.game,phase:'saved',ready:true};confirmWallet(next.revision);};
  async function sendFlight(){
    if(!validFlight(flight))throw new Error('Сохранённый запрос повреждён. Открой эту партию на другом устройстве.');
    const response=await call(flight);
    if(!response.ok){
      if([400,409,422].includes(response.status)){const insufficient=response.status===422&&response.data?.error==='insufficient_funds';clear();state.notice=insufficient?'На серверном балансе недостаточно монет. Стол не открыт, списания нет. Обнови баланс, забери доступный бонус или выбери бесплатную практику.':'Этот ход не принят. Показан актуальный стол — выбери действие заново.';if(insufficient)confirmWallet(state.revision,true);await fetchState();return;}
      throw new Error(response.status===401?'Подтверди вход и повтори запрос. Он сохранён с тем же номером.':'Ответ не получен. Повтори запрос: один ход не будет применён дважды.');
    }
    if(response.data?.status==='conflict'){clear();state.notice='Стол уже изменился на другом устройстве. Загружена актуальная партия.';await fetchState();return;}
    if(response.data?.status!=='saved')throw new Error('Подтверждение хода неполное. Повтори тот же запрос.');
    const receipt=projection(response.data);
    if(!receipt.game||receipt.revision!==flight.expectedRevision+1||(flight.op==='action'&&receipt.game.id!==flight.gameId)||(flight.op==='start'&&(receipt.game.economy?.stake||0)!==(flight.stake||0)))throw new Error('Подтверждение хода не соответствует запросу. Повтори тот же запрос.');
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
    return work(async()=>{state.notice='';const body={...payload,actionId:options.uuid(),expectedRevision:state.revision};if(!validFlight(body))throw new Error('Это действие сейчас недоступно. Обнови стол и выбери действие заново.');stage(body);await sendFlight()});
  }
  return Object.freeze({load,start:(difficulty='normal',stake=0)=>state.game&&!state.game.over?Promise.resolve(false):mutate({op:'start',difficulty,...(stake===0?{}:{stake})}),act:action=>state.game&&!state.game.over?mutate({op:'action',gameId:state.game.id,action}):Promise.resolve(false),status:()=>({...state,busy,pending:!!flight}),destroy:()=>{disposed=true;sequence++;}});
}
window.VEZDEHOT_SERVER_POKER=Object.freeze({createController,projection,validFlight,equityInput,economyOf,paidStartAvailability});
if(!document.getElementById('app'))return;
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),fmt=n=>Number(n||0).toLocaleString('ru-RU');
let controller=null,owner=null,selectedRaise=0,raiseKey='',setupStake=0,setupDifficulty='normal',renderedGameId=null,view={phase:'loading',game:null,revision:0,ready:false,busy:true};
let equityKey='',equityTask=null,equityValue=null,equityError=false,lastConfirmedView=null;
const walletHost=document.getElementById('sp-wallet');let walletMount=null,walletSubscription=null;
const gate=()=>!!owner&&window.VEZDEHOT?.scopeKey()===owner&&window.VEZDEHOT?.account().user?.id===owner&&!window.VEZDEHOT.account().switching&&window.VEZDEHOT_TAB_SESSION?.canWrite()===true&&!document.hidden;
const writable=()=>gate()&&view.ready&&!view.busy&&!view.pending;
function face(c,extra=''){return c?`<span class="sp-card ${['♥','♦'].includes(c.suit)?'red':''} ${extra}" role="img" aria-label="${esc(c.rank+' '+c.suit)}"><span>${esc(c.rank)}<small>${esc(c.suit)}</small></span><b aria-hidden="true">${esc(c.suit)}</b><i aria-hidden="true">${esc(c.rank)}${esc(c.suit)}</i></span>`:'<span class="sp-card blank" aria-label="Карта ещё не открыта"><b aria-hidden="true">♠</b></span>';}
function winners(g){return [...new Set(g.pots.filter(p=>!p.refund).flatMap(p=>p.winners))]}
function resultTitle(g){if(g.tableClosed&&!g.handOver)return 'Стол завершён';const won=winners(g),main=g.pots.find(p=>!p.refund);if(won.length===1)return won[0]===0?'Ты выиграл раздачу':'Победитель — '+g.players[won[0]].name;if(won.length>1)return main?.winners.length===won.length?'Банк разделён':'У банков разные победители';return 'Раздача завершена';}
function resultReason(g){
  if(!g.showdown)return 'Остальные игроки сделали пас. Сравнивать комбинации не понадобилось.';
  const main=g.pots.find(p=>!p.refund);if(!main)return 'Ставки возвращены участникам.';
  if(winners(g).length>main.winners.length)return 'Основной банк — '+main.winners.map(i=>g.players[i].name).join(', ')+'. У побочных банков свои победители: распределение показано в разборе ниже.';
  if(main.winners.length>1)return 'Лучшие пять карт равны по старшинству. Основной банк делится между победителями.';
  const winner=g.players[main.winners[0]],best=winner.combination;
  if(!best)return 'Основной банк получает '+winner.name+'. Распределение фишек показано ниже.';
  const rest=g.players.filter((p,i)=>i!==main.winners[0]&&!p.folded&&!p.sittingOut&&p.combination).sort((a,b)=>{for(let i=0;i<6;i++){const delta=(b.combination.parts[i]||0)-(a.combination.parts[i]||0);if(delta)return delta}return 0});
  if(!rest.length)return winner.name+' — '+combination(winner)+'.';
  return best.category!==rest[0].combination.category?best.name+' старше, чем '+rest[0].combination.name.toLowerCase()+'. Лучшие пять карт показаны в разборе.':'Тип комбинации совпал. '+combination(winner)+' сильнее: '+combination(rest[0])+'.';
}
function statusTitle(g){if(view.busy)return 'Подтверждаем действие…';if(view.phase==='offline')return 'Ждём подтверждения';if(g.over&&!g.handOver)return 'Стол завершён';if(g.handOver)return resultTitle(g);if(g.phase==='review')return g.stage==='river'?'Время открыть карты':'Круг ставок завершён';if(g.toAct===0)return 'Твой ход';return 'Ход соперника';}
function statusMessage(g){if(g.over)return g.economy?.stake===100?'Стол завершён. Возврат монет и XP подтверждены сервером — итог показан выше.':g.tableClosed?'Этот стол закрыт. Можно открыть новый.':g.players[0].chips===0?'Фишки закончились. Новый стол начинается с 1 000 фишек.':'У тебя все фишки стола. Можно начать новую партию.';if(g.handOver)return 'Фишки сохранены. Следующая раздача продолжит этот же стол'+(g.economy?.stake===100?' без нового списания.':'.');if(g.phase==='review')return g.stage==='river'?'Ставки сделаны. Нажми кнопку, чтобы увидеть победителя и распределение банка.':'Посмотри на банк и ставки. Следующая общая карта откроется по кнопке.';if(g.toAct===0)return g.legal.actions.includes('call')?'Для продолжения нужно добавить '+fmt(g.legal.callAmount)+' фишек.':'Можно сделать чек или повысить ставку.';return g.players[g.toAct].name+' продолжит после нажатия кнопки. Таймера на решение нет.';}
function button(action,label,style=''){return `<button class="sp-button ${style}" data-action="${action}" ${!writable()?'disabled':''}>${label}</button>`;}
function controls(g){
  if(!view.ready)return `<button class="sp-button primary" data-retry ${view.busy||!gate()?'disabled':''}>${view.busy?'Подтверждаем…':view.pending?'Повторить этот запрос':'Загрузить стол'}</button>`;
  const actions=g.legal.actions;
  return `${actions.includes('fold')?button('fold','Пас','danger'):''}${actions.includes('check')?button('check','Чек','green'):''}${actions.includes('call')?button('call','Колл '+fmt(g.legal.callAmount),'green'):''}${actions.includes('raise')?button('raise',(g.players[0].roundBet+g.players[0].chips===selectedRaise?'Ва-банк до ':'Повысить до ')+fmt(selectedRaise),'primary'):''}${actions.includes('continue')?button('continue',g.phase==='review'?g.stage==='river'?'Показать результат →':({preflop:'Открыть флоп →',flop:'Открыть тёрн →',turn:'Открыть ривер →'})[g.stage]:'Продолжить ходы →','primary'):''}${actions.includes('nextHand')?button('nextHand','Следующая раздача →','primary'):''}`;
}
function raisePresets(g){const min=Math.min(g.legal.minimum,g.legal.maximum),max=g.legal.maximum,current=g.players[0].roundBet+g.legal.callAmount,afterCall=g.pot+g.legal.callAmount,clamp=n=>Math.max(min,Math.min(max,n));return [{n:min,label:min===max?'Ва-банк':'Мин.'},{n:clamp(current+Math.floor(afterCall/2)),label:'½ банка'},{n:clamp(current+afterCall),label:'Банк'},{n:max,label:'Ва-банк'}].filter((p,i,all)=>all.findIndex(q=>q.n===p.n)===i);}
function raisePanel(g){if(!g.legal.actions.includes('raise'))return '';const min=Math.min(g.legal.minimum,g.legal.maximum),max=g.legal.maximum;return `<div class="sp-raise"><label for="sp-raise">Ставка за круг <output for="sp-raise" id="sp-raise-value">${fmt(selectedRaise)}</output></label><input id="sp-raise" type="range" min="${min}" max="${max}" step="1" value="${selectedRaise}" ${!writable()?'disabled':''}><div class="sp-presets">${raisePresets(g).map(p=>`<button data-raise="${p.n}" ${!writable()?'disabled':''}>${p.label}</button>`).join('')}</div><p>До ${fmt(selectedRaise)} всего · добавить ${fmt(Math.max(0,selectedRaise-g.players[0].roundBet))} фишек</p></div>`;}
function equityMarkup(){const g=view.game;if(!g||g.over||g.handOver)return '';if(g.players[0].folded)return '<span class="sp-equity-caption">Ты сделал пас. Карты останутся закрытыми для соперников.</span>';if(equityError)return '<span class="sp-equity-caption">Оценка недоступна. Игру можно продолжать.</span>';const v=equityValue;return `<div class="sp-equity-main"><span>Победа без дележа</span><strong>${v?'≈ '+v.win.toFixed(0)+'%':'Считаем…'}</strong></div><div class="sp-equity-track" aria-hidden="true"><i style="width:${v?v.win:0}%"></i></div><span class="sp-equity-caption">${v?'Разделить банк: ≈ '+v.tie.toFixed(0)+'% · '+v.samples+' вариантов':'По твоим картам и открытому столу'}</span>`;}
function stopEquity(){equityTask?.abort();equityTask=null;equityKey='';equityValue=null;equityError=false;}
function refreshEquity(){
  const input=equityInput(view.game);if(!input||!gate()){stopEquity();return;}
  const key=owner+'|'+view.game.handId+'|'+JSON.stringify(input);if(key===equityKey)return;
  stopEquity();equityKey=key;const task=new AbortController();equityTask=task;
  const update=()=>{if(!task.signal.aborted&&equityKey===key&&gate()){const box=$('[data-equity]');if(box)box.innerHTML=equityMarkup()}};
  update();if(!window.PokerEquity){equityError=true;update();return;}
  window.PokerEquity.estimate({...input,samples:1600,signal:task.signal}).then(value=>{if(task.signal.aborted||equityKey!==key||!gate())return;equityValue=value;update()}).catch(()=>{if(task.signal.aborted||equityKey!==key)return;equityError=true;update()});
}
function equityPanel(g){return g.over||g.handOver?'':`<section class="sp-equity" aria-label="Вероятность победы"><div data-equity>${equityMarkup()}</div><details><summary>Что означает процент?</summary><p>Приблизительный шанс единолично собрать лучшую руку на вскрытии. Раздел банка показан отдельно. Оценка использует только твои две карты, общий стол и число оставшихся соперников.</p><p>Карты ботов неизвестны. Их возможные руки моделируются случайно; блеф, будущие решения и побочные банки в прогноз не входят.</p></details></section>`;}
function combination(p){const c=p.combination;if(!c)return '';const parts=c.parts||[],rank=n=>({14:'A',13:'K',12:'Q',11:'J'}[n]||String(n)),r=i=>rank(parts[i]);if(!parts.length)return c.name;switch(c.category){case 8:case 4:return c.name+' до '+r(1);case 7:return 'Каре '+r(1)+' · кикер '+r(2);case 6:return 'Фулл-хаус '+r(1)+' + '+r(2);case 5:return 'Флеш · '+parts.slice(1).map(rank).join(' ');case 3:return 'Тройка '+r(1)+' · кикеры '+parts.slice(2,4).map(rank).join(' ');case 2:return 'Две пары '+r(1)+' и '+r(2)+' · кикер '+r(3);case 1:return 'Пара '+r(1)+' · кикеры '+parts.slice(2,5).map(rank).join(' ');default:return 'Старшая '+r(1)+' · '+parts.slice(2).map(rank).join(' ')}}
function bestFive(p){const ids=p.combination?.cards||[];return ids.length?'<span class="sp-best-five" aria-label="Лучшая комбинация из пяти карт">'+ids.map(id=>'<i class="'+(['♥','♦'].includes(id.slice(-1))?'red':'')+'">'+esc(id)+'</i>').join('')+'</span>':'';}
function closeButton(g){return g.legal.actions.includes('close')?`<button class="sp-link" data-close ${!writable()?'disabled':''}>Завершить этот стол</button>`:'';}
function outcomeBanner(g){if(!g.handOver)return '';return `<section class="sp-outcome" aria-label="Победитель раздачи"><div><span class="sp-eyebrow">РАЗДАЧА №${g.handNumber} · ИТОГ</span><h2>${esc(resultTitle(g))}</h2><p>${esc(resultReason(g))}</p></div>${!g.over?`<div class="sp-outcome-actions">${controls(g)}${closeButton(g)}<small>Фишки сохраняются · следующая раздача без нового входа</small></div>`:''}</section>`;}
function announceTransition(g){
  if(!writable()||view.phase!=='saved')return;
  const previous=lastConfirmedView?.scope===owner?lastConfirmedView:null;
  const next={scope:owner,tableId:g.id,handId:g.handId,handOver:g.handOver,over:g.over};
  let target=null;
  if(g.over&&g.economy?.stake===100&&(!previous||previous.tableId!==g.id||!previous.over))target=$('.sp-settlement h2');
  else if(g.handOver&&(!previous||previous.handId!==g.handId||!previous.handOver))target=$('.sp-outcome h2');
  else if(!g.handOver&&previous?.handOver&&previous.handId!==g.handId)target=$('.sp-heading h1');
  lastConfirmedView=next;
  if(!target)return;target.tabIndex=-1;target.focus?.({preventScroll:true});
  const reduced=window.VEZDEHOT?.getProfile()?.reduceMotion||document.documentElement?.dataset.motion==='reduced'||window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView?.({block:'start',behavior:reduced?'auto':'smooth'});
}
function resultPanel(g){
  if(!g.handOver)return '';
  const won=winners(g),net=g.handProfit||0;return `<section class="sp-result"><span class="sp-eyebrow">РАЗДАЧА №${g.handNumber} · ИТОГ</span><h2>Разбор раздачи</h2><p>${esc(resultReason(g))}</p><div class="sp-result-stats"><div><span>За эту раздачу</span><strong class="${net>=0?'positive':'negative'}">${net>0?'+':''}${fmt(net)}</strong><small>фишек</small></div><div><span>Твой стек</span><strong>${fmt(g.players[0].chips)}</strong><small>фишек на столе</small></div></div><div class="sp-result-players">${g.players.map((p,i)=>`<div class="${won.includes(i)?'winner':''}"><span><b>${esc(p.name)}</b><small>${p.sittingOut?'Не участвовал':p.folded?'Пас':esc(combination(p)||(!g.showdown?'Без вскрытия':'Вскрытие'))}</small>${g.showdown&&!p.folded?bestFive(p):''}</span><strong>${g.prizes[i]?'+ '+fmt(g.prizes[i]):'—'}</strong></div>`).join('')}</div><ul class="sp-pot-list">${g.pots.map((p,i)=>`<li><span>${p.refund?'Возврат лишней ставки':i===0?'Основной банк':'Побочный банк '+i} · ${fmt(p.amount)}</span><b>${esc(p.winners.map(i=>g.players[i].name).join(', '))}</b></li>`).join('')}</ul><p class="sp-footnote">Получено из банка — до вычета собственных ставок. Изменение твоего стека показано выше. ${g.economy?.stake===100?'Итог в монетах и XP фиксируется при завершении всего стола.':'Это бесплатная практика: серверный баланс и XP не меняются.'}</p></section>`;
}
function walletStatus(){return window.VEZDEHOT_SERVER_WALLET?.status()||null;}
function updateSetup(){
  const start=$('[data-start]'),hint=$('[data-stake-hint]'),availability=paidStartAvailability(walletStatus());
  if(start){start.disabled=!writable()||(setupStake===100&&!availability.allowed);start.textContent=setupStake===100?'Открыть стол · 100 V':'Открыть стол · бесплатно';}
  if(hint)hint.textContent=setupStake===100?availability.reason:'Бесплатная практика. Серверный баланс и XP не меняются.';
  const free=$('[data-choose-free]');if(free)free.hidden=setupStake===0;
}
function connectWallet(){
  const wallet=window.VEZDEHOT_SERVER_WALLET;
  if(!wallet)return;
  if(walletHost&&!walletMount)walletMount=wallet.mount(walletHost);
  if(!walletSubscription)walletSubscription=wallet.subscribe(updateSetup);
}
function refreshConfirmedWallet(){if(!gate())return;return window.VEZDEHOT_SERVER_WALLET?.refresh();}
function economyPanel(g){
  const e=g.economy;if(!e?.stake)return '';
  if(!e.settled)return `<div class="sp-economy-note"><span>Вход <b>100 V</b> за весь стол</span><span>${g.handOver?'Можно продолжить или завершить стол с возвратом монет.':'Закрыть стол с возвратом можно после раздачи.'}</span></div>`;
  const net=e.payout-e.stake,title=e.outcome==='win'?'Стол в плюсе':e.outcome==='draw'?'Вход возвращён':'Стол завершён';
  return `<section class="sp-settlement" aria-label="Итог серверного стола"><span class="sp-eyebrow">РАСЧЁТ СТОЛА ПОДТВЕРЖДЁН</span><h2>${title}</h2><div class="sp-settlement-stats"><div><span>Возврат на баланс</span><strong>${fmt(e.payout)} <small>V</small></strong></div><div><span>Итог с учётом входа</span><strong class="${net>=0?'positive':'negative'}">${net>0?'+':''}${fmt(net)} <small>V</small></strong></div><div><span>Опыт</span><strong>+${fmt(e.xp)} <small>XP</small></strong></div></div><p>Вход: ${fmt(e.stake)} V за весь стол · раздач сыграно: ${fmt(g.handNumber)}. Возврат: 1 V за каждые 10 оставшихся фишек. Серверный баланс можно открыть выше.</p></section>`;
}
function setup(over=false){return `<section class="sp-setup"><span class="sp-eyebrow">TEXAS HOLD’EM · СЕРВЕРНЫЙ СТОЛ</span><div class="sp-setup-suits" aria-hidden="true">♠ <i>♥</i> ♣ <i>♦</i></div><h1>${over?'Новая история за столом':'Твой стол. На любом устройстве.'}</h1><p>Ты и три соперника. По 1 000 фишек у каждого. Сервер раздаёт карты, проверяет ставки и сохраняет каждую раздачу.</p><div class="sp-setup-options"><label class="sp-difficulty">Характер ботов<select id="sp-difficulty" ${!writable()?'disabled':''}>${[['easy','Мягкий'],['normal','Обычный'],['hard','Расчётливый']].map(([value,label])=>`<option value="${value}" ${setupDifficulty===value?'selected':''}>${label}</option>`).join('')}</select></label><label class="sp-difficulty">Режим стола<select id="sp-stake" aria-describedby="sp-stake-hint" ${!writable()?'disabled':''}><option value="0" ${setupStake===0?'selected':''}>Практика · бесплатно</option><option value="100" ${setupStake===100?'selected':''}>Серверные монеты · 100 V</option></select></label></div><p class="sp-stake-hint" id="sp-stake-hint" data-stake-hint></p><button class="sp-button primary" data-start disabled>Открыть стол · бесплатно</button><button class="sp-link sp-free-choice" data-choose-free hidden>Выбрать бесплатную практику</button><p class="sp-footnote">100 V списываются один раз за весь стол. После раздачи можно продолжить без доплаты или завершить стол: каждые 10 оставшихся фишек возвращают 1 V. Игровые монеты не имеют денежной стоимости.</p></section>`;}
function render(){
  const app=$('#app');if(!app)return;const a=window.VEZDEHOT?.account(),g=view.game,sameTable=!!g&&g.id===renderedGameId,opened=sameTable&&($('[data-journal]')?.open||false),rulesOpened=$('[data-rules]')?.open||false,journalScroll=sameTable?Array.from(document.querySelectorAll('[data-journal] ol'),n=>n.scrollTop):[];renderedGameId=g?.id||null;
  const header=`<header class="sp-header"><a class="sp-back" href="./index.html?view=lobby" aria-label="В лобби">‹</a><div><a class="sp-brand" href="./index.html?view=lobby">VEZDEHOT</a><span>Серверный покер</span></div><button class="sp-account" data-account>${esc(a?.user?window.VEZDEHOT.getProfile().nick:'Войти')}</button></header>`;
  const notice=view.notice?`<div class="sp-notice" role="status">${esc(view.notice)}</div>`:'';
  if(!a?.user){stopEquity();app.innerHTML=header+`<section class="sp-setup"><span class="sp-eyebrow">ОДИН СТОЛ · ТЕЛЕФОН И ПК</span><div class="sp-setup-suits" aria-hidden="true">♠ <i>♥</i> ♣ <i>♦</i></div><h1>Сыграй свою следующую руку</h1><p>Войди в аккаунт, чтобы сохранить стол на сервере и продолжить на другом устройстве. Выбирай бесплатную практику или стол за игровые монеты. Соперники — боты.</p><button class="sp-button primary" data-account ${a?.loading||a?.switching?'disabled':''}>Войти и открыть стол</button><a class="sp-link" href="./poker.html">Покер для гостя →</a></section>`;bind();return;}
  const stateTitle=!gate()?'Управление недоступно':view.busy?'Подтверждаем действие':view.phase==='saved'?'Стол сохранён':'Нужна связь';
  const sync=`<div class="sp-sync" role="status"><span class="sp-sync-dot ${view.phase==='saved'&&gate()?'saved':''}"></span><span>${stateTitle}</span><button data-retry ${view.busy||!gate()?'disabled':''}>${view.pending?'Повторить запрос':'Обновить'}</button></div>`;
  if(!g){stopEquity();app.innerHTML=header+sync+notice+setup();bind();return;}
  const legal=g.legal,key=g.handId+'|'+view.revision;if(raiseKey!==key){raiseKey=key;selectedRaise=Math.min(legal.minimum,legal.maximum)}
  const won=g.handOver?winners(g):[],me=g.players[0];
  const seats=g.players.slice(1).map((p,i)=>{const n=i+1,active=!g.handOver&&g.toAct===n;return `<article class="sp-seat ${active?'active':''} ${p.folded?'folded':''} ${won.includes(n)?'winner':''}"><div class="sp-seat-avatar">${esc(p.initial||p.name.slice(0,2))}</div><div class="sp-seat-name"><b>${esc(p.name)}</b>${g.button===n?'<span class="sp-dealer" aria-label="Дилер">D</span>':''}</div><div class="sp-seat-stack">${fmt(p.chips)} <small>ф.</small></div><div class="sp-seat-cards">${p.hand?p.hand.map(c=>face(c)).join(''):p.sittingOut?'<span class="sp-seat-out">Вне стола</span>':'<i class="sp-back-card" aria-label="Закрытая карта"></i><i class="sp-back-card" aria-label="Закрытая карта"></i>'}</div><small class="sp-seat-state">${won.includes(n)?'Получил банк':p.sittingOut?'Нет фишек':p.folded?'Пас':active?'Ход соперника':p.chips===0?'Ва-банк':p.roundBet?'Ставка '+fmt(p.roundBet):'В раздаче'}</small></article>`}).join('');
  const board=Array.from({length:5},(_,i)=>face(g.community[i])).join('');
  const showResult=g.handOver?resultPanel(g):'';
  app.innerHTML=header+sync+notice+(!gate()?'<div class="sp-notice">Продолжить можно в активной вкладке после загрузки аккаунта.</div>':'')+economyPanel(g)+`<div class="sp-heading"><div><span class="sp-eyebrow">${g.economy?.stake===100?'HOLD’EM · СЕРВЕРНЫЕ МОНЕТЫ':'HOLD’EM · БЕСПЛАТНАЯ ПРАКТИКА'}</span><h1>Покер <small>Раздача №${g.handNumber}</small></h1></div><span class="sp-entry">${g.economy?.stake===100?'100 V':'0 V'} <small>${g.economy?.stake===100?'вход за весь стол':'бесплатная практика'}</small></span></div>${outcomeBanner(g)}<nav class="sp-stages" aria-label="Этапы раздачи">${Object.entries(STAGES).map(([k,label],i)=>`<span class="${g.stage===k?'current':''}" ${g.stage===k?'aria-current="step"':''}><i>0${i+1}</i>${label}</span>`).join('')}</nav><div class="sp-layout"><section class="sp-table" aria-label="Покерный стол"><div class="sp-felt"><div class="sp-opponents">${seats}</div><div class="sp-pot"><span class="sp-chip" aria-hidden="true"></span><div><span>${g.handOver?'Банк разыгран':'Общий банк'}</span><strong>${fmt(g.handOver?g.paidPot:g.pot)} <small>фишек</small></strong></div></div><div class="sp-board" aria-label="Общие карты">${board}</div><div class="sp-yourself ${!g.handOver&&g.toAct===0?'active':''}"><div class="sp-your-info"><span class="sp-eyebrow">ТВОЯ РУКА ${g.button===0?'<i class="sp-dealer" aria-label="Дилер">D</i>':''}</span><b>${esc(me.name)}</b><strong>${fmt(me.chips)} <small>фишек</small></strong><span class="sp-combination">${me.folded?'Ты сделал пас':esc(combination(me))}</span></div><div class="sp-your-cards">${me.hand.map(c=>face(c)).join('')}</div></div></div></section><aside class="sp-command" aria-label="Управление столом"><div class="sp-turn" role="status"><span class="sp-eyebrow">${g.over?'СТОЛ ЗАВЕРШЁН':g.handOver?'РАЗДАЧА ЗАВЕРШЕНА':'ТВОЁ РЕШЕНИЕ'}</span><h2>${esc(statusTitle(g))}</h2><p>${esc(statusMessage(g))}</p></div>${equityPanel(g)}<div class="sp-actions">${g.handOver?'':controls(g)}</div>${raisePanel(g)}${g.handOver?'':closeButton(g)}<p class="sp-save-hint">${g.handOver&&!g.over?'Следующая раздача сохраняет фишки и меняет дилера.':'Каждый ход подтверждается сервером. Таймера нет.'}</p></aside>${showResult}</div>${g.over?setup(true):''}<details class="sp-rules" data-rules ${rulesOpened?'open':''}><summary>Как играть и что означают кнопки</summary><p>Собери лучшую комбинацию из любых пяти карт: двух своих и пяти общих. При равенстве банк делится. Малый блайнд — 20, большой — 40 фишек.</p><p><b>Пас</b> — выйти из этой раздачи. <b>Чек</b> — продолжить без ставки. <b>Колл</b> — уравнять ставку. <b>Повысить до</b> — довести общую ставку за круг до выбранной суммы.</p><p>Ва-банк сохраняет право только на часть банка, покрытую твоими фишками. Побочные банки показаны отдельно в результате.</p><p><b>Процент победы</b> — приблизительная оценка по твоим двум картам, открытым общим картам и числу соперников. Карты ботов не используются. Раздел банка считается отдельно; блеф, будущие решения и побочные банки в оценку не входят.</p><p>Фишки сохраняются между раздачами. Бесплатная практика не меняет серверный баланс. В режиме за 100 V вход оплачивается один раз за весь стол; после раздачи его можно завершить и вернуть 1 V за каждые 10 оставшихся фишек. За итог стола начисляется 90 XP при прибыли, 40 XP при возврате входа или 20 XP при убытке. Это игровые монеты без денежной стоимости.</p></details><details class="sp-journal" data-journal ${opened?'open':''}><summary>Ход раздачи <span>${g.history.length}</span></summary><ol>${g.history.map(line=>`<li>${esc(line)}</li>`).join('')}</ol>${g.tableHistory.length?`<h3>Предыдущие раздачи</h3><ol>${g.tableHistory.map(h=>`<li><b>№${esc(h.number)}</b> · банк ${fmt(h.pot)} · ${esc((h.winners||[]).join(', '))}<small>Твой результат: ${h.net>0?'+':''}${fmt(h.net)} фишек</small></li>`).join('')}</ol>`:''}</details><footer class="sp-footer"><p>Для перехода на другое устройство дождись статуса «Стол сохранён» и войди там в тот же аккаунт.</p><a class="sp-link" href="./index.html?view=lobby">Все игры →</a></footer>`;
  bind();document.querySelectorAll('[data-journal] ol').forEach((n,i)=>{n.scrollTop=journalScroll[i]||0});refreshEquity();announceTransition(g);
}
function bind(){
  document.querySelectorAll('[data-account]').forEach(b=>b.onclick=()=>window.VEZDEHOT.openAccount());
  document.querySelectorAll('[data-retry]').forEach(b=>b.onclick=()=>controller?.load());
  const difficulty=$('#sp-difficulty');if(difficulty)difficulty.onchange=()=>{setupDifficulty=difficulty.value};
  const stake=$('#sp-stake');if(stake)stake.onchange=()=>{setupStake=Number(stake.value);updateSetup()};
  const free=$('[data-choose-free]');if(free)free.onclick=()=>{setupStake=0;if(stake)stake.value='0';updateSetup();$('[data-start]')?.focus()};
  const start=$('[data-start]');if(start)start.onclick=()=>{if(!writable()||(setupStake===100&&!paidStartAvailability(walletStatus()).allowed))return;controller?.start(setupDifficulty,setupStake)};
  updateSetup();
  document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>{if(!writable())return;controller?.act(b.dataset.action==='raise'?{type:'raise',amount:selectedRaise}:{type:b.dataset.action})});
  function selectRaise(value){const g=view.game;if(!g||!writable())return;const min=Math.min(g.legal.minimum,g.legal.maximum);selectedRaise=Math.max(min,Math.min(g.legal.maximum,Math.floor(Number(value))));const output=$('#sp-raise-value');if(output)output.textContent=fmt(selectedRaise);const action=$('[data-action="raise"]');if(action)action.textContent=(selectedRaise===g.legal.maximum?'Ва-банк до ':'Повысить до ')+fmt(selectedRaise);const help=$('.sp-raise p');if(help)help.textContent='До '+fmt(selectedRaise)+' всего · добавить '+fmt(Math.max(0,selectedRaise-g.players[0].roundBet))+' фишек';}
  const slider=$('#sp-raise');if(slider)slider.oninput=()=>selectRaise(slider.value);
  document.querySelectorAll('[data-raise]').forEach(b=>b.onclick=()=>{selectRaise(b.dataset.raise);if(slider)slider.value=String(selectedRaise)});
  const close=$('[data-close]');if(close)close.onclick=()=>{
    if(!writable()||!view.game?.legal.actions.includes('close'))return;
    const id=view.game.id,revision=view.revision,scope=owner,paid=view.game.economy?.stake===100;
    close.outerHTML=`<div class="sp-close-confirm"><p>${paid?'Завершить стол и вернуть монеты? Сервер рассчитает возврат: 1 V за каждые 10 оставшихся фишек.':'Завершить этот стол?'} Продолжить этот стол больше не получится.</p><button class="sp-button" data-close-cancel>Остаться за столом</button><button class="sp-button danger" data-close-confirm>${paid?'Завершить и рассчитать':'Завершить'}</button></div>`;
    $('.sp-close-confirm [data-close-cancel]').onclick=()=>{render();$('[data-close]')?.focus()};
    $('.sp-close-confirm [data-close-confirm]').onclick=()=>{if(writable()&&owner===scope&&view.revision===revision&&view.game?.id===id&&view.game.legal.actions.includes('close'))controller?.act({type:'close'});else render()};
    $('.sp-close-confirm [data-close-cancel]').focus();
  };
}
function boot(){
  connectWallet();const a=window.VEZDEHOT?.account();if(!a)return;
  if(owner&&owner!==a.user?.id){controller?.destroy();controller=null;owner=null;setupStake=0;setupDifficulty='normal';stopEquity();view={phase:'loading',game:null,revision:0,ready:false,busy:false};}
  if(controller&&!gate()){controller.destroy();controller=null;stopEquity();view={...view,ready:false,busy:false};}
  if(!controller&&a.user&&!a.loading&&!a.switching&&window.VEZDEHOT_TAB_SESSION?.canWrite()===true&&!document.hidden){owner=a.user.id;controller=createController({scope:owner,current:gate,request:b=>window.VEZDEHOT.serverPokerRequest(b),storage:{getItem:key=>window.localStorage.getItem(key),setItem:(key,value)=>window.localStorage.setItem(key,value),removeItem:key=>window.localStorage.removeItem(key)},uuid:()=>{if(typeof crypto.randomUUID!=='function')throw new Error('Открой игру по защищённой ссылке HTTPS.');return crypto.randomUUID()},onChange:state=>{view=state;render()},onConfirmed:refreshConfirmedWallet});controller.load();}
  render();
}
Promise.resolve(window.VEZDEHOT?.ready).then(boot);
for(const event of ['vezdehot:profile','vezdehot:sessionactive'])document.addEventListener(event,boot);
for(const event of ['vezdehot:sessionpause','vezdehot:sessionlost'])document.addEventListener(event,()=>{controller?.destroy();controller=null;owner=null;stopEquity();view={...view,ready:false,busy:false};render()});
document.addEventListener('vezdehot:accountchange',()=>{controller?.destroy();controller=null;owner=null;setupStake=0;setupDifficulty='normal';stopEquity();view={phase:'loading',game:null,revision:0,ready:false,busy:false};render()});
window.addEventListener('online',()=>{if(gate()&&!view.busy)controller?.load()});
document.addEventListener('visibilitychange',()=>{if(document.hidden){controller?.destroy();controller=null;stopEquity();view={...view,ready:false,busy:false}}else boot()});
})();
