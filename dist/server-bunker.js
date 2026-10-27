/* Server-authoritative Bunker. This client submits choices; it never deals, votes for bots or pays rewards. */
(()=>{
'use strict';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TYPES=['profession','health','hobby','baggage','phobia','fact'],ACTIONS=['reveal','vote','continue','resign'];
const TAGS={medical:'медицина',technical:'техника',food:'еда',survival:'выживание',social:'команда'};
const SCENARIOS=[['STORM / 07','После большого шторма'],['BLACKOUT / 03','Город без электричества'],['WINTER / 11','Долгая зима'],['ASH / 05','Пепельное небо'],['STATION / 09','Последняя станция'],['PASS / 14','Перевал закрыт'],['DEPTH / 02','Подземный город'],['HARVEST / 08','Пустые склады'],['POLAR / 06','Полярный рейс'],['SHORE / 12','Новый берег']];
const scenarioChoice=v=>v==='random'||SCENARIOS.some(s=>s[0]===v);
const seat=v=>Number.isInteger(v)&&v>=0&&v<6;
const obj=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const string=(v,max=400)=>typeof v==='string'&&v.length<=max;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function validFlight(v){
 if(!obj(v)||!UUID.test(v.actionId)||!Number.isSafeInteger(v.expectedRevision)||v.expectedRevision<0)return false;
 if(v.op==='start')return Object.keys(v).every(k=>['op','actionId','expectedRevision','difficulty','scenarioChoice','stake'].includes(k))&&['easy','normal','hard'].includes(v.difficulty)&&scenarioChoice(v.scenarioChoice)&&(!Object.hasOwn(v,'stake')||[0,100].includes(v.stake));
 const a=v.action;
 return v.op==='action'&&Object.keys(v).every(k=>['op','actionId','expectedRevision','gameId','action'].includes(k))&&UUID.test(v.gameId)&&obj(a)&&ACTIONS.includes(a.type)&&(a.type==='reveal'?Object.keys(a).length===2&&TYPES.includes(a.cardType):a.type==='vote'?Object.keys(a).length===2&&seat(a.target)&&a.target>0:Object.keys(a).length===1);
}
function projection(v){
 const fail=()=>{throw new Error('Состояние бункера не удалось проверить. Повтори загрузку.')};
 if(!obj(v)||!Number.isSafeInteger(v.revision)||v.revision<0||!['saved','ok'].includes(v.status))fail();
 const g=v.game;if(g===null)return v;
 if(!obj(g)||!UUID.test(g.id)||g.version!==2||!['reveal','vote','voteResult','over'].includes(g.phase)||!Number.isInteger(g.round)||g.round<1||g.round>3||typeof g.over!=='boolean'||g.over!==(g.phase==='over')||typeof g.resigned!=='boolean'||!['easy','normal','hard'].includes(g.difficulty)||!scenarioChoice(g.scenarioChoice)||![null,'survived','lost'].includes(g.result)||Object.hasOwn(g,'events'))fail();
 if(!obj(g.scenario)||!SCENARIOS.some(s=>s[0]===g.scenario.code)||!Object.hasOwn(TAGS,g.scenario.focus)||!string(g.scenario.name)||!string(g.scenario.text,1000)||!string(g.scenario.duration)||!obj(g.currentEvent)||!Object.hasOwn(TAGS,g.currentEvent.focus)||!string(g.currentEvent.title)||!string(g.currentEvent.text,1000)||!string(g.message,1000))fail();
 if(!Array.isArray(g.players)||g.players.length!==6)fail();
 for(const [i,p] of g.players.entries()){
  if(!obj(p)||!string(p.name,80)||typeof p.alive!=='boolean'||!Array.isArray(p.cards)||p.cards.length!==6||new Set(p.cards.map(c=>c?.type)).size!==6||!Number.isFinite(p.score)||p.score<0||p.score>120)fail();
  for(const c of p.cards){
   if(!obj(c)||!TYPES.includes(c.type)||!string(c.icon,12)||!string(c.label,80)||typeof c.revealed!=='boolean')fail();
   if(i>0&&!c.revealed){if(Object.keys(c).some(k=>!['type','icon','label','revealed'].includes(k)))fail();continue;}
   if(!string(c.title,300)||!Number.isFinite(c.score)||c.score<0||c.score>10||!Number.isFinite(c.value)||c.value<0||c.value>15||!Array.isArray(c.tags)||c.tags.length>5||c.tags.some(t=>!Object.hasOwn(TAGS,t))||(c.revealed&&(!Number.isInteger(c.revealedRound)||c.revealedRound<1||c.revealedRound>g.round)))fail();
  }
 }
 const record=r=>obj(r)&&seat(r.out)&&Number.isInteger(r.round)&&r.round>=1&&r.round<=g.round&&Number.isInteger(r.count)&&r.count>=1&&r.count<=6&&Array.isArray(r.tied)&&r.tied.length>=1&&r.tied.every(seat)&&r.tied.includes(r.out)&&Array.isArray(r.ballots)&&r.ballots.length>=4&&r.ballots.length<=6&&r.ballots.every(b=>obj(b)&&seat(b.from)&&seat(b.to)&&b.from!==b.to)&&new Set(r.ballots.map(b=>b.from)).size===r.ballots.length;
 if((g.votes!==null&&(!Array.isArray(g.votes)||g.votes.length!==6||g.votes.some(n=>!Number.isInteger(n)||n<0||n>6)))||(g.lastVote!==null&&!record(g.lastVote))||!Array.isArray(g.voteLog)||g.voteLog.length>3||g.voteLog.some(r=>!record(r))||!Array.isArray(g.eliminated)||g.eliminated.length>3||g.eliminated.some(i=>!seat(i)))fail();
 const l=g.legal;if(!obj(l)||!Array.isArray(l.actions)||l.actions.some(a=>!ACTIONS.includes(a))||new Set(l.actions).size!==l.actions.length||!Array.isArray(l.cards)||l.cards.some(t=>!TYPES.includes(t)||g.players[0].cards.find(c=>c.type===t)?.revealed)||!Array.isArray(l.targets)||l.targets.some(i=>!seat(i)||i===0||!g.players[i].alive))fail();
 if(g.over&&(l.actions.length||l.cards.length||l.targets.length)||!g.over&&g.result!==null||g.over&&!g.resigned&&g.result==='lost'&&g.players[0].alive)fail();
 const e=g.economy;if(!obj(e)||Object.keys(e).length!==6||e.version!==1||![0,100].includes(e.stake)||e.settled!==g.over||!Number.isInteger(e.payout)||e.payout<0||e.payout>250||!Number.isInteger(e.xp)||e.xp<0||e.xp>120||![null,'win','loss','resigned'].includes(e.outcome))fail();
 const outcome=!g.over?null:g.resigned?'resigned':g.result==='survived'?'win':'loss';
 if(e.outcome!==outcome||e.payout!==(e.stake&&outcome==='win'?250:0)||e.xp!==(e.stake?({win:120,loss:25}[outcome]||0):0)||g.over&&(g.result===null||g.result==='survived'&&(!g.players[0].alive||g.players.filter(p=>p.alive).length!==3)))fail();
 return v;
}
function paidStartAvailability(w){return !!w&&w.ready===true&&!w.busy&&!w.pending&&w.phase==='saved'&&Number.isSafeInteger(w.wallet?.balance)&&w.wallet.balance>=100;}
function createController(options){
  const key='vezdehot:server-bunker:pending:v1:'+options.scope;
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
      if([400,409,422].includes(response.status)){clear();state.notice=response.data?.error==='insufficient_funds'?'На серверном балансе недостаточно монет. Стол не открыт, списания нет. Обнови баланс, забери доступный бонус или выбери бесплатную практику.':'Этот ход не принят. Показан актуальный стол — выбери действие заново.';await fetchState();return;}
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
  return Object.freeze({load,start:(difficulty='normal',scenarioChoice='random',stake=0)=>state.game&&!state.game.over?Promise.resolve(false):mutate({op:'start',difficulty,scenarioChoice,...(stake===0?{}:{stake})}),act:action=>state.game&&!state.game.over?mutate({op:'action',gameId:state.game.id,action}):Promise.resolve(false),status:()=>({...state,busy,pending:!!flight}),destroy:()=>{disposed=true;sequence++;}});
}
const voteWord=n=>n===1?'голос':n>=2&&n<=4?'голоса':'голосов';
function selectedIntent(state,selected){
 const g=state?.game;if(!state?.ready||state.busy||state.pending||!g||g.over)return null;
 if(g.phase==='reveal'&&g.legal.actions.includes('reveal')&&g.legal.cards.includes(selected))return {type:'reveal',cardType:selected};
 if(g.phase==='vote'&&g.legal.actions.includes('vote')&&g.legal.targets.includes(selected))return {type:'vote',target:selected};
 return null;
}
function selectionText(g,selected){
 if(g.phase==='reveal'){const c=g.players[0].cards.find(c=>c.type===selected);return c?'Ты откроешь «'+c.title+'». Соперники увидят эту характеристику до конца партии.':'Выбери одну из своих закрытых характеристик.';}
 if(g.phase==='vote'){const p=g.legal.targets.includes(selected)?g.players[selected]:null;return p?'Ты выбрал: '+p.name+'. Подтверди голос, чтобы узнать решение остальных.':'Выбери кандидата, который должен покинуть бункер.';}
 if(g.phase==='voteResult')return !g.players[0].alive||g.players.filter(p=>p.alive).length===3?'Голосование определило твой результат. Нажми «Завершить партию», чтобы сохранить итог.':'Решение принято. Следующий раунд откроет новый приоритет.';
 return 'Результат партии сохранён.';
}
function cardMarkup(c,g,selectable=false,selected=null){
 const bonus=(c.tags.includes(g.scenario.focus)?2:0)+(c.tags.includes(g.currentEvent.focus)?3:0);
 return `<${selectable?'button':'article'} class="sb-trait ${c.revealed?'revealed':''} ${selected===c.type?'selected':''}" ${selectable?`type="button" data-trait="${esc(c.type)}" aria-pressed="${selected===c.type}"`:''}><span class="sb-trait-top"><span>${esc(c.icon)} / ${esc(c.label)}</span><i>${c.revealed?'Открыто · '+c.revealedRound:'Только тебе'}</i></span><strong>${esc(c.title)}</strong><span class="sb-trait-value">${c.value}<small>пользы сейчас</small>${bonus?`<em>+${bonus} бонус</em>`:''}</span><span class="sb-trait-tags">${c.tags.length?c.tags.map(t=>esc(TAGS[t])).join(' · '):'Без навыка для бонуса'}</span><span class="sb-trait-base">База ${c.score} · сценарий +${c.tags.includes(g.scenario.focus)?2:0} · событие +${c.tags.includes(g.currentEvent.focus)?3:0}</span></${selectable?'button':'article'}>`;
}
function candidateMarkup(p,i,g,canChoose=false,selected=null){
 const opened=p.cards.filter(c=>c.revealed),style={pragmatic:'Практик',team:'Командный',focused:'Специалист'}[p.botStyle]||'Соперник';
 return `<article class="sb-candidate ${!p.alive?'out':''} ${selected===i?'selected':''}"><div class="sb-person"><span class="sb-avatar" aria-hidden="true">${esc(p.face||p.name.slice(0,1))}</span><div><h3>${esc(p.name)}${i===0?' · ты':''}</h3><small>${p.alive?(i===0?'Твои открытые характеристики':style):'Покинул бункер'}</small></div><strong class="sb-score">${p.score}<small>польза</small></strong></div><div class="sb-public-traits">${opened.length?opened.map(c=>`<div><span>${esc(c.label)}</span><b>${esc(c.title)}</b><i>+${c.value}</i></div>`).join(''):'<p>Характеристики ещё не открыты</p>'}</div><div class="sb-candidate-bottom"><span>Скрыто: ${6-opened.length} из 6</span>${canChoose?`<button class="sb-button small ${selected===i?'selected':''}" data-target="${i}" aria-pressed="${selected===i}">${selected===i?'Выбран для голоса':'Голосовать против'}</button>`:''}</div></article>`;
}
function voteResultMarkup(g,v=g.lastVote){
 if(!v)return '';const p=g.players[v.out],tied=v.tied.length>1;
 return `<section class="sb-vote-result" aria-label="Результат голосования"><span class="sb-eyebrow">ГОЛОСОВАНИЕ · РАУНД ${v.round}</span><h2>${v.out===0?'Ты покидаешь бункер':esc(p.name)+' покидает бункер'}</h2><p>${v.count} ${voteWord(v.count)} против.${tied?' Равенство голосов: '+v.tied.map(i=>esc(g.players[i].name)).join(', ')+'. Равная жеребьёвка определила выбывшего.':' Больше голосов, чем у остальных кандидатов.'}</p><details class="sb-ballots"><summary>Кто за кого голосовал</summary><ul>${v.ballots.map(b=>`<li><span>${esc(g.players[b.from].name)}${b.from===0?' · ты':''}</span><span aria-hidden="true">→</span><b>${esc(g.players[b.to].name)}</b></li>`).join('')}</ul></details></section>`;
}
function outcomeMarkup(g){
 const e=g.economy,title=g.resigned?'Ты завершил партию':g.result==='survived'?'Твоё место в бункере':'В этот раз — за дверью';
 const reason=g.resigned?'Эта партия закрыта по твоему решению.':g.result==='survived'?'В финальной тройке: '+g.players.filter(p=>p.alive).map(p=>p.name).join(', ')+'.':'Группа проголосовала против тебя.'+(g.lastVote?.tied.length>1?' При равенстве голосов результат решила жеребьёвка.':'');
 return `<section class="sb-outcome"><span class="sb-eyebrow">ПАРТИЯ ЗАВЕРШЕНА · ИТОГ СОХРАНЁН</span><h2 tabindex="-1" data-outcome-title>${title}</h2><p>${esc(reason)}</p>${e.stake?`<div class="sb-settlement"><div><span>Возврат на баланс</span><b>${e.payout} V</b></div><div><span>С учётом входа 100 V</span><b>${e.payout-e.stake>0?'+':''}${e.payout-e.stake} V</b></div><div><span>Опыт</span><b>+${e.xp} XP</b></div></div>`:'<p class="sb-practice-note">Бесплатная практика · монеты и XP не меняются.</p>'}<button class="sb-button primary" data-rematch>Ещё партия · ${e.stake?'100 V':'бесплатно'}</button><a class="sb-link" href="#sb-new-game">Изменить настройки</a><p class="sb-rematch-note" data-rematch-note>Тот же сценарий и сложность, новые характеристики.</p></section>`;
}
window.VEZDEHOT_SERVER_BUNKER=Object.freeze({createController,projection,validFlight,paidStartAvailability,selectedIntent,selectionText,cardMarkup,candidateMarkup,voteResultMarkup,outcomeMarkup});
if(!document.getElementById('app'))return;
const $=s=>document.querySelector(s);
let controller=null,owner=null,selected=null,selectionKey='',setupDifficulty='normal',setupScenario='random',setupStake=0,walletMount=null,walletSubscription=null,walletRevisionKey='',resignKey='',lastViewKey='',view={phase:'loading',game:null,revision:0,ready:false,busy:true};
const gate=()=>!!owner&&window.VEZDEHOT?.scopeKey()===owner&&window.VEZDEHOT?.account().user?.id===owner&&!window.VEZDEHOT.account().switching&&window.VEZDEHOT_TAB_SESSION?.canWrite()===true&&!document.hidden;
const writable=()=>gate()&&view.ready&&!view.busy&&!view.pending;
const key=()=>[owner,view.game?.id,view.revision].join('|');
const walletState=()=>window.VEZDEHOT_SERVER_WALLET?.status();
const canEnter=stake=>stake===0||paidStartAvailability(walletState());
function updateSetup(){
 const start=$('[data-start]'),hint=$('[data-stake-hint]'),paid=setupStake===100;
 if(start){start.disabled=!writable()||!canEnter(setupStake);start.textContent='Войти в бункер · '+(paid?'100 V':'бесплатно');}
 if(hint)hint.textContent=paid?(canEnter(100)?'Вход 100 V. Победа: возврат 250 V и 120 XP. Поражение: 25 XP.':'Для входа нужно 100 V на серверном балансе. Обнови его или выбери бесплатную практику.'):'Бесплатная практика: монеты и XP не меняются.';
 const rematch=$('[data-rematch]');if(rematch){const e=view.game?.economy;rematch.disabled=!writable()||!canEnter(e?.stake);const note=$('[data-rematch-note]');if(note)note.textContent=canEnter(e?.stake)?'Тот же сценарий и сложность, новые характеристики.':'Не хватает серверных монет. Ниже можно начать бесплатную практику.';}
}
function connectWallet(){const w=window.VEZDEHOT_SERVER_WALLET;if(!w)return;if(!walletMount)walletMount=w.mount(document.getElementById('sb-wallet'));if(!walletSubscription)walletSubscription=w.subscribe(updateSetup);}
function refreshWalletFor(s){if(!s.ready||s.busy||s.pending||!s.game||!gate())return;const k=owner+'|'+s.revision;if(walletRevisionKey===k)return;walletRevisionKey=k;Promise.resolve(window.VEZDEHOT_SERVER_WALLET?.refresh()).catch(()=>{});}
function setupMarkup(over=false){return `<section class="sb-setup" id="sb-new-game"><div class="sb-setup-copy"><span class="sb-eyebrow">СОЦИАЛЬНАЯ СТРАТЕГИЯ · С БОТАМИ</span><h1>${over?'Новая партия':'Шесть историй.<br>Три места внутри.'}</h1><p>У каждого есть то, что поможет группе выжить. Открой свою сильную сторону и реши, кому доверить место рядом.</p><div class="sb-counts"><span><b>6</b>кандидатов</span><span><b>3</b>места</span><span><b>3</b>раунда</span></div></div><div class="sb-setup-form"><label>История<select id="sb-scenario" ${!writable()?'disabled':''}><option value="random" ${setupScenario==='random'?'selected':''}>Случайный сценарий</option>${SCENARIOS.map(([code,name])=>`<option value="${code}" ${setupScenario===code?'selected':''}>${name}</option>`).join('')}</select></label><label>Характер ботов<select id="sb-difficulty" ${!writable()?'disabled':''}>${[['easy','Мягкие'],['normal','Рассудительные'],['hard','Расчётливые']].map(([v,n])=>`<option value="${v}" ${setupDifficulty===v?'selected':''}>${n}</option>`).join('')}</select></label><label>Режим партии<select id="sb-stake" aria-describedby="sb-stake-hint" ${!writable()?'disabled':''}><option value="0" ${setupStake===0?'selected':''}>Практика · бесплатно</option><option value="100" ${setupStake===100?'selected':''}>Игровые монеты · 100 V</option></select></label><p id="sb-stake-hint" data-stake-hint></p><button class="sb-button primary" data-start disabled>Войти в бункер · бесплатно</button><small>Игровые монеты не имеют денежной стоимости.</small></div></section>`;}
function scenarioMarkup(g){return `<section class="sb-scenario"><div><span class="sb-eyebrow">${esc(g.scenario.code)} · ${esc(g.scenario.duration)}</span><h2>${esc(g.scenario.name)}</h2></div><div class="sb-focus"><span>Сценарий <b>+2 · ${esc(TAGS[g.scenario.focus])}</b></span><span>Событие <b>+3 · ${esc(TAGS[g.currentEvent.focus])}</b></span></div><details><summary>${esc(g.currentEvent.title)} <span>Подробнее</span></summary><p>${esc(g.scenario.text)}</p><p><b>Сейчас:</b> ${esc(g.currentEvent.text)}</p><p>Бонусы прибавляются к каждой подходящей открытой карте. Скрытые характеристики соперников неизвестны.</p></details></section>`;}
function commandMarkup(g){const intent=selectedIntent(view,selected),phase=g.phase,terminal=!g.players[0].alive||g.players.filter(p=>p.alive).length===3;return `<aside class="sb-command" aria-label="Твоё решение"><div class="sb-command-copy"><span class="sb-eyebrow">${phase==='reveal'?'01 / РАСКРЫТИЕ':phase==='vote'?'02 / ТВОЙ ГОЛОС':'03 / РЕШЕНИЕ ГРУППЫ'}</span><h2>${phase==='reveal'?'Что о тебе узнают?':phase==='vote'?'Кто останется снаружи?':'Голосование завершено'}</h2><p data-selection aria-live="polite">${esc(selectionText(g,selected))}</p></div><div class="sb-action-row">${phase==='reveal'||phase==='vote'?`<button class="sb-button primary" data-confirm ${!writable()||!intent?'disabled':''}>${phase==='reveal'?'Раскрыть характеристику':'Подтвердить голос'}</button>`:g.legal.actions.includes('continue')?`<button class="sb-button primary" data-action="continue" ${!writable()?'disabled':''}>${terminal?'Завершить партию':'Следующий раунд →'}</button>`:''}${!view.ready?`<button class="sb-button" data-retry ${view.busy||!gate()?'disabled':''}>${view.busy?'Сохраняем…':view.pending?'Повторить запрос':'Загрузить партию'}</button>`:''}</div><small>${view.busy?'Сохраняем твой выбор…':'Таймера нет. Выбор применяется после подтверждения.'}</small></aside>`;}
function rulesMarkup(){return `<details class="sb-rules" data-rules><summary>Как играть</summary><ol><li><b>Раскрой одну характеристику.</b> Ты видишь все свои карты. Соперники узнают только ту, которую откроешь. Они также раскрывают по одной карте.</li><li><b>Выбери, кто покинет бункер.</b> Голосовать за себя нельзя. Боты оценивают только открытые характеристики: пользу, текущий приоритет и недостающие навыки команды.</li><li><b>Посмотри итог.</b> Выбывает кандидат с наибольшим числом голосов. При равенстве сервер проводит равную жеребьёвку. Если останешься среди трёх — ты победил.</li></ol><p>Польза — подсказка для сравнения, а не гарантированный результат голосования. Сценарий даёт +2 за нужный навык, событие раунда — ещё +3; бонусы складываются.</p><p>Практика бесплатная и не меняет монеты или XP. За вход 100 V: победа возвращает 250 V (+150 V чистыми) и 120 XP, поражение даёт 25 XP. Досрочный выход не возвращает вход и не даёт XP.</p></details>`;}
function render(){
 const app=$('#app');if(!app)return;const a=window.VEZDEHOT?.account(),g=view.game;
 const openDetails=new Set(Array.from(app.querySelectorAll('details[open][data-keep]'),n=>n.dataset.keep)),rulesOpen=!!$('[data-rules]')?.open;
 const header=`<header class="sb-header"><a class="sb-back" href="./index.html" aria-label="В лобби">‹</a><div><a class="sb-brand" href="./index.html">VEZDEHOT</a><span>Бункер · серверная партия</span></div><button class="sb-account" data-account>${esc(a?.user?window.VEZDEHOT.getProfile().nick:'Войти')}</button></header>`;
 if(!a?.user){app.innerHTML=header+`<section class="sb-setup sb-login"><div class="sb-setup-copy"><span class="sb-eyebrow">СОХРАНЯЙ КАЖДОЕ РЕШЕНИЕ</span><h1>Твоё место<br>в новой истории.</h1><p>Войди, чтобы раскрывать характеристики, голосовать и продолжать ту же партию на другом устройстве. Шесть кандидатов, три места — и только твой выбор.</p><button class="sb-button primary" data-account ${a?.loading||a?.switching?'disabled':''}>Войти и открыть бункер</button><a class="sb-link" href="./index.html?game=bunker">Играть гостем →</a><small>Против пяти ботов. Бесплатная практика по умолчанию.</small></div></section>`;bind();return;}
 const sync=`<div class="sb-sync" role="status"><span class="${view.ready&&gate()?'saved':''}">${!gate()?'Управление в активной вкладке':view.busy?'Подтверждаем выбор…':view.ready?'Выбор сохранён':'Нужна связь'}</span><button data-retry ${view.busy||!gate()?'disabled':''}>${view.pending?'Повторить запрос':'Обновить'}</button></div>`;
 const notice=view.notice?`<p class="sb-notice" role="status">${esc(view.notice)}</p>`:'';
 if(!g){app.innerHTML=header+sync+notice+setupMarkup()+rulesMarkup();bind();return;}
 if(selectionKey!==key()){selectionKey=key();selected=null;resignKey='';}
 const alive=g.players.filter(p=>p.alive).length,phase=g.phase;
 const roster=()=>`<section class="sb-roster" aria-label="Кандидаты в бункер"><div class="sb-section-title"><h2>${phase==='vote'?'Сравни открытые карты':'Участники'}</h2><span>${alive} кандидатов · 3 места</span></div><div class="sb-candidates">${g.players.map((p,i)=>p.alive?candidateMarkup(p,i,g,phase==='vote'&&writable()&&g.legal.targets.includes(i),selected):'').join('')}</div>${g.eliminated.length?`<details class="sb-archive" data-keep="eliminated"><summary>Выбывшие · ${g.eliminated.length}</summary><div class="sb-candidates">${g.players.map((p,i)=>!p.alive?candidateMarkup(p,i,g):'').join('')}</div></details>`:''}</section>`;
 const hand=`<section class="sb-dossier"><div class="sb-section-title"><h2>Твоё досье</h2><span>${g.players[0].cards.filter(c=>c.revealed).length} из 6 открыто</span></div><p class="sb-section-hint">${phase==='reveal'?'Выбери закрытую характеристику. Бонусы уже учтены в пользе.':'Только открытые характеристики участвуют в оценке группы.'}</p><div class="sb-traits">${g.players[0].cards.map(c=>cardMarkup(c,g,phase==='reveal'&&writable()&&g.legal.cards.includes(c.type),selected)).join('')}</div></section>`;
 app.innerHTML=header+sync+notice+`<div class="sb-heading"><div><span class="sb-eyebrow">${g.economy.stake?'ВХОД 100 V · ИГРОВЫЕ МОНЕТЫ':'БЕСПЛАТНАЯ ПРАКТИКА'}</span><h1>Бункер <span>Раунд ${g.round} / 3</span></h1></div><div class="sb-seats" aria-label="В бункере три места"><i></i><i></i><i></i><small>3 места</small></div></div>`+(g.over?outcomeMarkup(g):'')+scenarioMarkup(g)+`<div class="sb-play ${g.over?'finished':''}"><div class="sb-main">${phase==='voteResult'?voteResultMarkup(g):''}${phase==='reveal'?hand+roster():roster()+`<details class="sb-private" data-keep="dossier"><summary>Твоё досье · все характеристики</summary>${hand}</details>`}</div>${g.over?'':commandMarkup(g)}</div>`+(g.over?setupMarkup(true):'')+`<div class="sb-bottom">${rulesMarkup()}${g.voteLog.length?`<details class="sb-history" data-keep="history"><summary>История голосований · ${g.voteLog.length}</summary>${g.voteLog.map(v=>voteResultMarkup(g,v)).join('')}</details>`:''}${g.legal.actions.includes('resign')?'<button class="sb-link danger" data-resign>Завершить партию досрочно</button><div data-resign-host></div>':''}<footer class="sb-footer"><p>Дождись статуса «Выбор сохранён», затем войди в тот же аккаунт на другом устройстве.</p><a class="sb-link" href="./index.html">Все игры →</a></footer></div>`;
 app.querySelectorAll('details[data-keep]').forEach(n=>n.open=openDetails.has(n.dataset.keep));if($('[data-rules]'))$('[data-rules]').open=rulesOpen;
 bind();const transition=g.id+'|'+g.phase+'|'+g.round;if(lastViewKey&&lastViewKey!==transition){const target=g.over?$('[data-outcome-title]'):g.phase==='voteResult'?$('.sb-main > .sb-vote-result h2'):g.phase==='vote'?$('.sb-roster h2'):$('.sb-dossier h2');if(target){target.setAttribute('tabindex','-1');target.focus({preventScroll:true});target.scrollIntoView({block:'start',behavior:'auto'});}}lastViewKey=transition;
}
function paintSelection(){
 const g=view.game;if(!g)return;
 document.querySelectorAll('[data-trait]').forEach(b=>{const on=b.dataset.trait===selected;b.setAttribute('aria-pressed',String(on));b.classList.toggle('selected',on)});
 document.querySelectorAll('[data-target]').forEach(b=>{const on=Number(b.dataset.target)===selected;b.setAttribute('aria-pressed',String(on));b.classList.toggle('selected',on);b.textContent=on?'Выбран для голоса':'Голосовать против';b.closest('.sb-candidate')?.classList.toggle('selected',on)});
 if($('[data-selection]'))$('[data-selection]').textContent=selectionText(g,selected);
 if($('[data-confirm]'))$('[data-confirm]').disabled=!writable()||!selectedIntent(view,selected);
}
function bind(){
 document.querySelectorAll('[data-account]').forEach(b=>b.onclick=()=>window.VEZDEHOT.openAccount());
 document.querySelectorAll('[data-retry]').forEach(b=>b.onclick=()=>controller?.load());
 const difficulty=$('#sb-difficulty');if(difficulty)difficulty.onchange=()=>{setupDifficulty=difficulty.value};
 const scenario=$('#sb-scenario');if(scenario)scenario.onchange=()=>{setupScenario=scenario.value};
 const stake=$('#sb-stake');if(stake)stake.onchange=()=>{setupStake=Number(stake.value);updateSetup()};
 const start=$('[data-start]');if(start)start.onclick=()=>{if(writable()&&canEnter(setupStake))controller?.start(setupDifficulty,setupScenario,setupStake)};
 const rematch=$('[data-rematch]');if(rematch)rematch.onclick=()=>{const g=view.game;if(writable()&&g?.over&&canEnter(g.economy.stake))controller?.start(g.difficulty,g.scenario.code,g.economy.stake)};
 document.querySelectorAll('[data-trait]').forEach(b=>b.onclick=()=>{if(!writable()||!view.game.legal.cards.includes(b.dataset.trait))return;selected=selected===b.dataset.trait?null:b.dataset.trait;paintSelection()});
 document.querySelectorAll('[data-target]').forEach(b=>b.onclick=()=>{const n=Number(b.dataset.target);if(!writable()||!view.game.legal.targets.includes(n))return;selected=selected===n?null:n;paintSelection()});
 const confirm=$('[data-confirm]');if(confirm)confirm.onclick=()=>{const intent=selectedIntent(view,selected);if(writable()&&intent)controller?.act(intent)};
 document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>{if(writable()&&view.game?.legal.actions.includes(b.dataset.action))controller?.act({type:b.dataset.action})});
 const resign=$('[data-resign]');if(resign)resign.onclick=()=>{if(!writable())return;resignKey=key();$('[data-resign-host]').innerHTML=`<div class="sb-resign-confirm"><p>Закрыть эту партию?${view.game.economy.stake?' Вход 100 V не вернётся, XP не начислится.':''} Продолжить её позже не получится.</p><button class="sb-button" data-cancel-resign>Остаться</button><button class="sb-button danger" data-confirm-resign>Завершить досрочно</button></div>`;$('[data-cancel-resign]').onclick=()=>{$('[data-resign-host]').innerHTML='';resign.focus()};$('[data-confirm-resign]').onclick=()=>{if(writable()&&resignKey===key()&&view.game.legal.actions.includes('resign'))controller?.act({type:'resign'});else render()};$('[data-cancel-resign]').focus();};
 updateSetup();
}
function boot(){
 connectWallet();const a=window.VEZDEHOT?.account();if(!a)return;
 if(owner&&owner!==a.user?.id){controller?.destroy();controller=null;owner=null;selected=null;setupStake=0;setupDifficulty='normal';setupScenario='random';walletRevisionKey='';view={phase:'loading',game:null,revision:0,ready:false,busy:false};}
 if(controller&&!gate()){controller.destroy();controller=null;view={...view,ready:false,busy:false};}
 if(!controller&&a.user&&!a.loading&&!a.switching&&window.VEZDEHOT_TAB_SESSION?.canWrite()===true&&!document.hidden){owner=a.user.id;controller=createController({scope:owner,current:gate,request:b=>window.VEZDEHOT.serverBunkerRequest(b),storage:{getItem:k=>window.localStorage.getItem(k),setItem:(k,v)=>window.localStorage.setItem(k,v),removeItem:k=>window.localStorage.removeItem(k)},uuid:()=>{if(typeof crypto.randomUUID!=='function')throw new Error('Открой игру по защищённой ссылке HTTPS.');return crypto.randomUUID()},onChange:s=>{view=s;render();refreshWalletFor(s)}});controller.load();}
 render();
}
Promise.resolve(window.VEZDEHOT?.ready).then(boot);
for(const event of ['vezdehot:profile','vezdehot:sessionactive'])document.addEventListener(event,boot);
for(const event of ['vezdehot:sessionpause','vezdehot:sessionlost'])document.addEventListener(event,()=>{controller?.destroy();controller=null;view={...view,ready:false,busy:false};render()});
document.addEventListener('vezdehot:accountchange',()=>{controller?.destroy();controller=null;owner=null;selected=null;setupStake=0;setupDifficulty='normal';setupScenario='random';walletRevisionKey='';view={phase:'loading',game:null,revision:0,ready:false,busy:false};render()});
window.addEventListener('online',()=>{if(gate()&&!view.busy)controller?.load()});
document.addEventListener('visibilitychange',()=>{if(document.hidden){controller?.destroy();controller=null;view={...view,ready:false,busy:false}}else boot()});
})();
