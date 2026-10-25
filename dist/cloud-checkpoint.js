/* One account revision covers its wallet and all five solo games. */
(function(root){
  'use strict';
  const GAMES=['durak','bunker','poker','mafia','monopoly'];
  const FORMAT='vezdehot-account-checkpoint';
  const FIELDS=['nick','balance','xp','wins','games','bonusAt','avatar','durakPace','reduceMotion','history','resultIds'];
  const copy=value=>JSON.parse(JSON.stringify(value));
  const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const integer=(v,max=2000000000)=>Number.isSafeInteger(v)&&v>=0&&v<=max;
  const resultFields=['id','game','win','delta','xp','at'];
  const validId=id=>typeof id==='string'&&id.length>0&&id.length<=100&&id.trim().length>0&&!/[\u0000-\u001f\u007f-\u009f]/.test(id);
  function resultSnapshot(item){
    if(!object(item))throw new Error('invalid-result');
    const result={};for(const field of resultFields)result[field]=item[field];
    if(!validId(result.id)||!GAMES.includes(result.game)||typeof result.win!=='boolean'||!Number.isSafeInteger(result.delta)||Math.abs(result.delta)>2000000||!integer(result.xp)||typeof result.at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(result.at)||!Number.isFinite(Date.parse(result.at)))throw new Error('invalid-result');
    return result;
  }
  function retainIds(required,other=[]){
    if([...required,...other].some(id=>!validId(id)))throw new Error('invalid-result-id');
    const first=[...new Set(required)];if(first.length>500)throw new Error('invalid-result-capacity');
    return [...new Set([...first,...other])].slice(0,500);
  }
  function profileSnapshot(profile){
    if(!object(profile)||!FIELDS.every(field=>Object.hasOwn(profile,field)))throw new Error('invalid-profile');
    const result={};for(const field of FIELDS)result[field]=copy(profile[field]);return result;
  }
  function validateProfile(p){
    if(!object(p)||Object.keys(p).some(key=>!FIELDS.includes(key))||typeof p.nick!=='string'||p.nick.length<1||p.nick.length>24||p.nick!==p.nick.trim()||/[\u0000-\u001f\u007f-\u009f]/.test(p.nick)||
      !['balance','xp','wins','games'].every(k=>integer(p[k]))||p.wins>p.games||!integer(p.bonusAt,Number.MAX_SAFE_INTEGER)||
      !['✦','◈','♠','✿','△','☾','✹','◇'].includes(p.avatar)||!['calm','normal','quick'].includes(p.durakPace)||
      typeof p.reduceMotion!=='boolean'||!Array.isArray(p.history)||p.history.length>30||!Array.isArray(p.resultIds)||p.resultIds.length>500)throw new Error('invalid-profile');
    if(p.resultIds.some(id=>!validId(id))||new Set(p.resultIds).size!==p.resultIds.length)throw new Error('invalid-result-id');
    const result=profileSnapshot(p),seen=new Set();
    result.history=p.history.map(item=>{
      if(!object(item)||Object.keys(item).some(key=>![...resultFields,'synced'].includes(key))||item.synced!==undefined&&typeof item.synced!=='boolean')throw new Error('invalid-history');
      const entry=resultSnapshot(item);if(seen.has(entry.id)||!p.resultIds.includes(entry.id))throw new Error('invalid-history-id');seen.add(entry.id);return {...entry,synced:true};
    });return result;
  }
  function payoutId(game,state){return state?(game==='poker'&&state.version===3?state.tableId:state.id):null;}
  function finished(game,state){
    if(!state)return false;
    if(game!=='poker')return state.over===true;
    return state.over===true&&(state.version===2||state.tableClosed===true||state.players?.[0]?.chips<=0||state.players?.filter(p=>p.chips>0).length<=1);
  }
  function create(o){
    const scope=o.scope,key='vezdehot:checkpoint:v1:'+scope,journalKey=key+':import';
    let valid=true,started=false,busy=null,phase='loading',message='',remote=null,importing=false,capturing=false;
    const initial=o.read(key,null);
    let meta=object(initial)&&initial.version===1?initial:{version:1,baseRevision:null,ackHeads:null,flight:null,updatedAt:null};
    let metadataDamaged=initial!==null&&(!object(initial)||initial.version!==1||!(initial.baseRevision===null||integer(initial.baseRevision,Number.MAX_SAFE_INTEGER)));
    const current=()=>valid&&o.current()===true;
    const notify=()=>{if(current())o.onChange?.();};
    const set=(next,text='')=>{phase=next;message=text;notify();};
    function durable(k,value){return current()&&o.write(k,copy(value))===true;}
    function status(){return{phase,revision:meta.baseRevision,updatedAt:meta.updatedAt,message,pending:!!meta.flight||phase==='local'||phase==='offline',conflict:phase==='conflict',importing};}
    function canWrite(){return current()&&!['loading','conflict','invalid','importing'].includes(phase)&&!importing;}
    function changed(){if(!current()||capturing||importing)return;if(!['loading','conflict','invalid'].includes(phase))set(phase==='syncing'?'syncing':'local');}
    function capture(){
      if(!current())throw new Error('stale');
      capturing=true;let exported;
      try{exported=o.getStore().exportAll(scope,{contextCurrent:current});}finally{capturing=false;}
      if(!exported?.ok)throw new Error(exported?.message||'local-save-unavailable');
      const p=o.getProfile(),pending=copy(o.getPendingResults?.()||[]);
      if(!Array.isArray(pending)||pending.length>500)throw new Error('invalid-result-capacity');
      const results=pending.map(resultSnapshot);if(new Set(results.map(item=>item.id)).size!==results.length)throw new Error('invalid-duplicate-result');
      const profile=profileSnapshot(p);
      if(!Array.isArray(profile.history)||!Array.isArray(profile.resultIds))throw new Error('invalid-profile');
      profile.resultIds=retainIds([...results.map(item=>item.id),...profile.history.map(item=>item?.id)],profile.resultIds);
      const snapshot={format:FORMAT,version:1,profile:validateProfile(profile),games:copy(exported.games)};
      for(const item of results){const historical=snapshot.profile.history.find(entry=>entry.id===item.id);if(historical&&!equal(resultSnapshot(historical),item))throw new Error('invalid-result-history');}
      for(const game of GAMES)if(!Object.hasOwn(snapshot.games,game))throw new Error('missing-game');
      return{snapshot,heads:{profile:p.revision||0,games:copy(exported.revisions)},results};
    }
    function knownIds(local){
      return[...new Set([...GAMES.map(g=>payoutId(g,local?.snapshot.games[g])),...(local?.results||[]).map(x=>x.id),...(local?.snapshot.profile.history||[]).map(x=>x.id)])].filter(x=>typeof x==='string'&&x.length&&x.length<=100).slice(0,500);
    }
    async function call(name,args){const r=await o.rpc(name,args);if(!current())throw new Error('stale');if(r?.error)throw new Error(r.error.code==='22023'?'invalid-cloud-request':'cloud-request');if(!object(r?.data))throw new Error('cloud-response');return r.data;}
    function checked(incoming){
      if(!object(incoming)||incoming.status!=='ok'||!integer(incoming.revision,Number.MAX_SAFE_INTEGER)||!object(incoming.snapshot)||incoming.snapshot.format!==FORMAT||incoming.snapshot.version!==1||!object(incoming.snapshot.games))throw new Error('invalid-cloud');
      const snapshot={format:FORMAT,version:1,profile:validateProfile(incoming.snapshot.profile),games:{}};
      if(Object.keys(incoming.snapshot.games).length!==GAMES.length)throw new Error('invalid-games');
      const completedIds=Array.isArray(incoming.completedIds)?[...new Set(incoming.completedIds.filter(validId))]:[];
      for(const game of GAMES){
        if(!Object.hasOwn(incoming.snapshot.games,game))throw new Error('missing-game');
        try{snapshot.games[game]=o.validate(game,copy(incoming.snapshot.games[game]),{remote:true});}catch(_){throw new Error('invalid-game-'+game);}
        const state=snapshot.games[game],id=payoutId(game,state);
        // A paid table may be waiting for its local settled marker, but a live
        // table with a durable result is an obsolete branch and cannot resume.
        if(id&&completedIds.includes(id)&&!finished(game,state))throw new Error('finished-checkpoint-is-active');
      }
      const required=[...snapshot.profile.history.map(item=>item.id),...GAMES.map(game=>payoutId(game,snapshot.games[game])).filter(id=>id&&completedIds.includes(id))];
      snapshot.profile.resultIds=retainIds(required,[...snapshot.profile.resultIds,...completedIds]);
      return{...incoming,snapshot,completedIds};
    }
    async function pull(local){return checked(await call('load_player_checkpoint',{p_known_ids:knownIds(local)}));}
    function sameProfile(a,b){
      // Result retention and cloud flags are presentation metadata. Money,
      // counters and preferences must agree before adopting a legacy branch.
      return FIELDS.filter(k=>!['history','resultIds'].includes(k)).every(k=>equal(a[k],b[k]));
    }
    function conflict(incoming,text){remote=incoming;o.pause?.();set('conflict',text||'На другом устройстве появилась другая версия. Выбери облачную версию, чтобы продолжить; локальная копия будет сохранена отдельно.');}
    function install(incoming,{archive=false,reload=false,recovering=false}={}){
      if(!current())return false;
      let journal;
      try{
        incoming=checked(incoming); // All five games pass before the first write.
        if(recovering){journal=o.read(journalKey,null);if(!journal)throw new Error('missing-import');}
        else{
          o.pause?.();
          const local=capture();
          let archiveKey=null;
          if(archive){archiveKey=key+':archive:'+o.uuid();if(!durable(archiveKey,{version:1,createdAt:o.now(),scope,snapshot:local.snapshot,pendingResults:local.results,meta:copy(meta)}))throw new Error('archive-storage');}
          journal={version:1,scope,incoming,archiveKey,reload};
          if(!durable(journalKey,journal))throw new Error('journal-storage');
        }
        importing=true;set('importing','Восстанавливаем согласованную версию профиля и партий.');
        const installed=o.getStore().installAll(scope,incoming.snapshot.games,{contextCurrent:current});
        if(!installed?.ok||!current())throw new Error('install-storage');
        if(o.installProfile(copy(incoming.snapshot.profile),incoming.completedIds)!==true)throw new Error('profile-storage');
        const local=capture();
        const next={version:1,baseRevision:incoming.revision,ackHeads:local.heads,flight:null,updatedAt:incoming.updatedAt||null};
        if(!durable(key,next))throw new Error('metadata-storage');
        meta=next;metadataDamaged=false;
        if(!durable(journalKey,null))throw new Error('journal-storage');
        importing=false;remote=null;set('saved');
        if(reload&&current())o.reload?.();
        return true;
      }catch(error){
        if(current()){
          importing=!!o.read(journalKey,null);
          set(importing?'importing':'conflict',importing?'Восстановление не завершено. Освободи место в браузере и повтори; игра пока на паузе.':'Не удалось сохранить локальную копию. Ничего не заменено; освободи место и повтори.');
        }
        return false;
      }
    }
    function recoverImport(){
      if(!current())return false;
      const journal=o.read(journalKey,null);
      if(journal===null)return true;
      if(!object(journal)||journal.version!==1||journal.scope!==scope){importing=true;set('invalid','Сохранённое восстановление повреждено. Партии оставлены без изменений.');return false;}
      return install(journal.incoming,{reload:started,recovering:true});
    }
    async function transmit(local){
      if(!current())return false;
      let flight=meta.flight;
      if(!flight){
        flight={id:o.uuid(),expectedRevision:meta.baseRevision,heads:local.heads,snapshot:local.snapshot,results:local.results.map(x=>({id:x.id,game:x.game,win:x.win,delta:x.delta,xp:x.xp,at:x.at}))};
        const next={...meta,flight};if(!durable(key,next))throw new Error('request-storage');meta=next;
      }
      if(!object(flight)||!integer(flight.expectedRevision,Number.MAX_SAFE_INTEGER)||typeof flight.id!=='string'||!object(flight.snapshot))throw new Error('invalid-flight');
      set('syncing');
      const answer=await call('commit_player_checkpoint',{p_expected_revision:flight.expectedRevision,p_mutation_id:flight.id,p_snapshot:flight.snapshot,p_results:flight.results});
      if(answer.status==='conflict'||answer.status==='duplicate_result'){
        const latest=await pull(capture());conflict(latest,answer.status==='duplicate_result'?'Этот результат уже сохранён в аккаунте. Загрузи облачную версию, чтобы не начислять его повторно.':undefined);return false;
      }
      if(answer.status!=='saved'||answer.mutationId!==flight.id||!integer(answer.revision,Number.MAX_SAFE_INTEGER)||answer.revision!==flight.expectedRevision+1)throw new Error('invalid-receipt');
      const acknowledged=o.acknowledge({ids:flight.results.map(x=>x.id),profileRevision:flight.heads.profile});
      if(acknowledged===false)throw new Error('ack-storage');
      const next={version:1,baseRevision:answer.revision,ackHeads:flight.heads,flight:null,updatedAt:answer.updatedAt||null};
      if(!durable(key,next))throw new Error('ack-storage');meta=next;
      const now=capture();set(equal(now.heads,flight.heads)&&!now.results.length?'saved':'local');return true;
    }
    async function work({pull:shouldPull=false,boot=false}={}){
      if(!current())return false;
      if(!recoverImport())return false;
      if(['conflict','invalid'].includes(phase))return false;
      try{
        let local=capture();
        // A persisted request is resolved before a new read. Otherwise a lost
        // ACK would look like an unrelated remote edit after reload.
        const replayedFlight=!!meta.flight;
        if(meta.flight){if(!await transmit(local))return false;local=capture();}
        if(boot||shouldPull||replayedFlight||meta.baseRevision===null){
          const latest=await pull(local);remote=latest;
          // A network read does not suspend local play. Decide whether the
          // account is clean using its current heads, not the pre-request copy.
          local=capture();
          const stalePaidGame=GAMES.some(game=>{const state=local.snapshot.games[game],id=payoutId(game,state);return id&&latest.completedIds.includes(id)&&(!finished(game,state)||!local.snapshot.profile.resultIds.includes(id));});
          if(stalePaidGame){conflict(latest,'Результат одной из сохранённых партий уже начислен в аккаунте. Загрузи облачную версию, чтобы не продолжить старую партию и не начислить результат повторно.');return false;}
          if(metadataDamaged){conflict(latest,'Не удалось проверить прежнюю версию синхронизации. Локальные данные сохранены; выбери облачную версию для продолжения.');return false;}
          if(meta.baseRevision===null){
            const hasLocalGames=GAMES.some(g=>local.snapshot.games[g]!==null),hasPending=local.results.length>0;
            if(latest.revision===0&&sameProfile(local.snapshot.profile,latest.snapshot.profile)&&!hasPending){
              meta={...meta,baseRevision:0,ackHeads:local.heads};if(!durable(key,meta))throw new Error('metadata-storage');
            }else if(!hasLocalGames&&!hasPending&&!o.getProfile().dirty){
              if(!install(latest,{reload:!boot}))return false;local=capture();
            }else{conflict(latest,'На устройстве и в аккаунте есть разные сохранения. Автоматическое объединение изменило бы баланс. Загрузи облачную версию; местная копия останется в архиве.');return false;}
          }else if(latest.revision!==meta.baseRevision){
            if(equal(local.heads,meta.ackHeads)&&!local.results.length){if(!install(latest,{archive:true,reload:!boot}))return false;local=capture();}
            else{conflict(latest);return false;}
          }
        }
        if(meta.baseRevision===0||!equal(local.heads,meta.ackHeads)||local.results.length){return await transmit(local);}
        set('saved');return true;
      }catch(error){
        if(current())set(/invalid|missing-game|finished-checkpoint/.test(error.message)?'invalid':'offline',/invalid|missing-game|finished-checkpoint/.test(error.message)?'Облачная версия не прошла проверку. Локальные данные сохранены; повтори загрузку позже.':'Нет подтверждения облака. Прогресс остаётся на этом устройстве; повтори синхронизацию перед переходом на другое.');
        return false;
      }
    }
    function run(options){
      if(busy)return busy;
      const job=Promise.resolve().then(()=>options?.accept?acceptCloudWork():work(options));busy=job;
      return job.finally(()=>{if(busy===job)busy=null;});
    }
    async function boot(){const result=await run({boot:true,pull:true});started=true;return result;}
    function sync(options={}){if(phase==='invalid'&&!o.read(journalKey,null))set('local');return run(options);}
    async function acceptCloudWork(){
      if(!current())return false;
      if(o.read(journalKey,null))return recoverImport();
      try{const latest=await pull(capture());remote=latest;return install(latest,{archive:true,reload:true});}
      catch(_){if(current())set('conflict','Не удалось загрузить облачную версию. Локальные данные не изменены.');return false;}
    }
    function acceptCloud(){return run({accept:true});}
    return Object.freeze({boot,sync,changed,status,canWrite,acceptCloud,recoverImport,invalidate(){valid=false;},snapshot:()=>capture().snapshot});
  }
  root.VEZDEHOT_CHECKPOINT=Object.freeze({create});
})(window);
