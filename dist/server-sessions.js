/* Read-only lobby summaries. Game pages alone recover pending actions. */
(()=>{
'use strict';
const MODES=['durak','poker','bunker','mafia','monopoly'];
const NAMES={durak:'Дурак',poker:'Покер',bunker:'Бункер',mafia:'Мафия',monopoly:'Монополия'};
const METHODS={durak:'serverDurakRequest',poker:'serverPokerRequest',bunker:'serverBunkerRequest',mafia:'serverMafiaRequest',monopoly:'serverMonopolyRequest'};
const PHASES={durak:{attack:'Атака',defend:'Защита',resolve:'Завершение захода',roundEnd:'Итог захода',over:'Финал'},poker:{betting:'Ставки',review:'Следующая улица',over:'Итог раздачи'},bunker:{reveal:'Раскрытие характеристик',vote:'Голосование',voteResult:'Итог голосов',over:'Финал'},mafia:{night:'Ночь',dawn:'Рассвет',day:'Обсуждение',vote:'Голосование',voteResult:'Итог голосов',result:'Финал'},monopoly:{ready:'Бросок кубиков',buy:'Покупка участка',review:'Итог хода',over:'Финал'}};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v),integer=(v,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const copy=v=>JSON.parse(JSON.stringify(v));
const pendingKey=(mode,scope)=>'vezdehot:server-'+mode+':pending:v1:'+scope;
function projection(mode,data){
  const invalid=()=>{throw new Error('Сохранённую партию не удалось проверить.')};
  if(!MODES.includes(mode)||!object(data)||!['ok','saved'].includes(data.status)||!integer(data.revision))invalid();
  if(data.game===null)return {revision:data.revision,game:null};
  const g=data.game;
  if(!object(g)||!UUID.test(g.id)||typeof g.over!=='boolean'||!Object.hasOwn(PHASES[mode],g.phase)||!object(g.economy)||![0,100].includes(g.economy.stake))invalid();
  const step=mode==='poker'?g.handNumber:mode==='monopoly'?g.turnNumber:g.round;
  if(!integer(step,1,mode==='bunker'?3:mode==='mafia'?25:mode==='monopoly'?80:Number.MAX_SAFE_INTEGER))invalid();
  if(mode==='poker'){
    if(typeof g.handOver!=='boolean'||typeof g.tableClosed!=='boolean'||g.tableClosed&&!g.over||g.over&&!g.handOver&&!g.tableClosed||g.handOver!==(g.phase==='over')&&!g.tableClosed)invalid();
  }else if(g.over!==(g.phase===(mode==='mafia'?'result':'over')))invalid();
  // Deliberately retain no cards, roles, names, actions or free-form server text.
  return {revision:data.revision,game:{id:g.id,phase:g.phase,step,over:g.over,stake:g.economy.stake,...(mode==='poker'?{handOver:g.handOver}:{})}};
}
const initial=phase=>Object.fromEntries(MODES.map(mode=>[mode,{phase,busy:false,pending:false,revision:0,game:null}]));
function createController(options){
  let destroyed=false,busy=false,ticket=0,rows=initial('loading');
  const current=()=>!destroyed&&options.current()===true;
  const status=()=>({busy,rows:copy(rows)});
  const publish=()=>{if(current())options.onChange?.(status())};
  async function load(){
    if(busy||!current())return false;
    busy=true;const sequence=++ticket;
    const valid=()=>current()&&sequence===ticket;
    for(const mode of MODES)rows[mode]={...rows[mode],phase:'loading',busy:true};
    publish();
    await Promise.all(MODES.map(async mode=>{
      let pending=false;
      try{
        // Presence only: even corrupt requests belong to the game recovery UI.
        const raw=options.storage.getItem(pendingKey(mode,options.scope));
        pending=raw!==null&&raw!=='';
        if(!valid())return;
        rows[mode]={...rows[mode],pending};publish();
        const response=await options.request(mode,{op:'load'});
        if(!valid())return;
        if(response?.ok!==true)throw new Error('unavailable');
        const next=projection(mode,response.data);
        if(next.revision<rows[mode].revision)throw new Error('stale');
        rows[mode]={...next,busy:false,pending,phase:pending?'pending':next.game?next.game.over?'finished':'active':'empty'};
      }catch{
        if(!valid())return;
        rows[mode]={...rows[mode],busy:false,pending,phase:pending?'pending':'unavailable'};
      }
      if(valid())publish();
    }));
    if(!valid())return false;
    busy=false;publish();return true;
  }
  return Object.freeze({load,status,destroy(){destroyed=true;ticket++;}});
}
function rowText(mode,row){
  const step=row.game?(mode==='poker'?'Раздача ':mode==='monopoly'?'Ход ':'Раунд ')+row.game.step:'';
  if(row.pending)return {status:'Есть неподтверждённый запрос на этом устройстве',action:'Проверить партию →'};
  if(row.phase==='guest')return {status:'Войди, чтобы сохранить партию онлайн',action:'Войти и играть →'};
  if(row.phase==='paused')return {status:'Доступно в активной вкладке',action:'Открыть →'};
  if(row.phase==='loading')return {status:'Проверяем сохранённую партию…',action:'Открыть →'};
  if(row.phase==='unavailable')return {status:'Не удалось проверить партию',action:'Проверить →'};
  if(row.phase==='empty')return {status:'Сохранённой партии пока нет',action:'Начать →'};
  if(row.phase==='finished')return {status:step+' · Партия завершена',action:'Итоги и новая игра →'};
  const phase=mode==='poker'&&row.game.handOver?'Следующая раздача':PHASES[mode][row.game.phase];
  return {status:step+' · '+phase+' · '+(row.game.stake?'вход 100 V':'бесплатно'),action:'Продолжить →'};
}
function summaryText(view){
  const rows=Object.values(view.rows),first=rows[0];
  if(first.phase==='guest')return 'Войди в аккаунт, чтобы увидеть свои онлайн-партии.';
  if(first.phase==='paused')return 'Проверка партий продолжится в активной вкладке.';
  if(view.busy)return 'Проверяем твои пять игр…';
  const active=rows.filter(r=>r.phase==='active').length,pending=rows.filter(r=>r.pending).length,unavailable=rows.filter(r=>r.phase==='unavailable').length;
  if(pending)return 'Есть неподтверждённые действия. Открой отмеченную игру, чтобы проверить запрос.';
  if(unavailable)return (active?'Можно продолжить: '+active+'. ':'')+'Часть партий пока не удалось проверить. Обнови список или открой нужную игру.';
  if(active)return 'Можно продолжить: '+active+'. Выбери игру — откроется сохранённая партия.';
  return rows.some(r=>r.phase==='finished')?'Завершённые партии сохранены. Открой итоги или начни новую.':'Твои партии появятся здесь после первой игры онлайн.';
}
let controller=null,owner=null,view={busy:false,rows:initial('loading')};
const mounts=new Map();
const account=()=>window.VEZDEHOT?.account?.();
const gate=()=>{const a=account();return !!owner&&a?.user?.id===owner&&window.VEZDEHOT?.scopeKey?.()===owner&&!a.loading&&!a.switching&&!a.authPending&&window.VEZDEHOT_TAB_SESSION?.canWrite?.()===true&&!document.hidden};
function prune(){for(const [root,entry] of mounts)if(!root.isConnected){entry.button?.removeEventListener?.('click',entry.refresh);mounts.delete(root);}}
function emit(){
  prune();
  for(const [root,entry] of mounts){
    root.setAttribute('aria-busy',String(view.busy));
    for(const mode of MODES){
      const link=root.querySelector('[data-server-game="'+mode+'"]');if(!link)continue;
      const row=view.rows[mode],text=rowText(mode,row);
      link.setAttribute('data-server-session-state',row.pending?'pending':row.phase);
      link.setAttribute('aria-label',NAMES[mode]+'. '+text.status+'. '+text.action.replace(' →',''));
      const detail=link.querySelector('[data-server-session-status]'),action=link.querySelector('[data-server-session-action]');
      if(detail)detail.textContent=text.status;if(action)action.textContent=text.action;
    }
    if(entry.summary)entry.summary.textContent=summaryText(view);
    if(entry.button){entry.button.disabled=view.busy||!gate();entry.button.textContent=view.busy?'Проверяем…':'Обновить партии';}
  }
}
function clear(phase){controller?.destroy();controller=null;owner=null;view={busy:phase==='loading',rows:initial(phase)};emit();}
function boot(refresh=false){
  prune();if(!mounts.size)return Promise.resolve(false);
  const a=account();
  if(!a?.user){clear(a?.loading||a?.switching||a?.authPending?'loading':'guest');return Promise.resolve(false);}
  const active=!a.loading&&!a.switching&&!a.authPending&&window.VEZDEHOT?.scopeKey?.()===a.user.id&&window.VEZDEHOT_TAB_SESSION?.canWrite?.()===true&&!document.hidden;
  if(!active){clear(a.loading||a.switching||a.authPending?'loading':'paused');return Promise.resolve(false);}
  if(controller&&owner===a.user.id){emit();return refresh?controller.load():Promise.resolve(true);}
  clear('loading');owner=a.user.id;
  controller=createController({scope:owner,current:gate,storage:{getItem:key=>window.localStorage.getItem(key)},request:(mode,body)=>window.VEZDEHOT[METHODS[mode]](body),onChange:next=>{view=next;emit()}});
  return controller.load();
}
const refresh=()=>boot(true);
function mount(root){
  if(!root||typeof root.querySelector!=='function')return()=>{};
  prune();
  if(!mounts.has(root)){
    const region=root.closest?.('[data-server-sessions-region]')||root.parentElement||root;
    const entry={summary:region.querySelector('[data-server-sessions-summary]'),button:region.querySelector('[data-server-sessions-refresh]'),refresh:()=>refresh()};
    mounts.set(root,entry);entry.button?.addEventListener?.('click',entry.refresh);
  }
  emit();boot();
  return()=>{const entry=mounts.get(root);entry?.button?.removeEventListener?.('click',entry.refresh);mounts.delete(root);};
}
window.VEZDEHOT_SERVER_SESSIONS=Object.freeze({projection,createController,rowText,summaryText,mount,refresh,status:()=>copy(view)});
if(typeof document==='undefined'||typeof document.addEventListener!=='function')return;
Promise.resolve(window.VEZDEHOT?.ready).then(()=>boot());
for(const name of ['vezdehot:profile','vezdehot:sessionactive'])document.addEventListener(name,()=>boot());
for(const name of ['vezdehot:accountchange','vezdehot:sessionpause','vezdehot:sessionlost'])document.addEventListener(name,()=>clear(name==='vezdehot:accountchange'?'loading':'paused'));
document.addEventListener('visibilitychange',()=>{if(document.hidden)clear('paused');else boot()});
window.addEventListener?.('online',()=>refresh());
window.addEventListener?.('pageshow',event=>{if(event.persisted)refresh();});
window.addEventListener?.('storage',event=>{if(owner&&MODES.some(mode=>event.key===pendingKey(mode,owner)))refresh();});
})();
