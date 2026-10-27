'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('dist/server-sessions.js','utf8'),MODES=['durak','poker','bunker','mafia','monopoly'];
const ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',SCOPE='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',OTHER='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const copy=v=>JSON.parse(JSON.stringify(v)),flush=()=>new Promise(resolve=>setImmediate(resolve)),key=(mode,scope=SCOPE)=>'vezdehot:server-'+mode+':pending:v1:'+scope;
const engines={},games={},ended={},states={};
const seeded=n=>()=>((n=(Math.imul(n,1664525)+1013904223)>>>0)/2**32);
const context={window:{}};vm.createContext(context);vm.runInContext(source,context);const api=context.window.VEZDEHOT_SERVER_SESSIONS;
function finishPokerHand(e,state){let steps=0;while(!state.game.over&&steps++<100){const actions=e.legalActions(state).actions,type=actions.includes('fold')?'fold':actions.includes('continue')?'continue':actions.includes('check')?'check':'call';state=e.applyAction(state,{type},seeded(steps),()=>OTHER);}assert(state.game.over);return state;}
test.before(async()=>{for(const mode of MODES){const e=engines[mode]=await import('../supabase/functions/server-'+mode+'/engine.mjs');const g=states[mode]=e.createGame({id:ID,stake:100},seeded(41),()=>OTHER);games[mode]=e.projectGame(g);ended[mode]=e.projectGame(e.applyAction(mode==='poker'?finishPokerHand(e,g):g,{type:mode==='poker'?'close':'resign'},seeded(42),()=>OTHER));}});
const response=(mode,revision=1,g=games[mode])=>({ok:true,status:200,data:{status:'ok',revision,game:copy(g)}});
function memory(){const values=new Map();return {values,getItem:k=>values.get(k)??null,setItem(){throw Error('Overview must never write storage')},removeItem(){throw Error('Overview must never remove storage')}};}
function harness(request=(mode)=>response(mode),storage=memory()){
 let active=true;const events=[],calls=[];
 const controller=api.createController({scope:SCOPE,current:()=>active,storage,request:(mode,body)=>{calls.push({mode,body:copy(body)});return request(mode,body)},onChange:s=>events.push(copy(s))});
 return {controller,storage,events,calls,deactivate(){active=false}};
}
test('all five production game projections become useful minimal lobby summaries',async()=>{
 const h=harness();await h.controller.load();const result=h.controller.status();
 assert.equal(result.busy,false);assert.equal(h.calls.length,5);
 for(const mode of MODES){const row=result.rows[mode];assert.equal(row.phase,'active');assert.equal(row.revision,1);assert.equal(row.game.id,ID);assert.equal(row.game.stake,100);assert.equal(api.rowText(mode,row).action,'Продолжить →');assert.match(api.rowText(mode,row).status,/100 V/);assert.deepEqual(h.calls.find(c=>c.mode===mode).body,{op:'load'});}
 assert.match(api.summaryText(result),/Можно продолжить: 5/);
});
test('all five finished games show their results instead of advertising a resumable game',async()=>{
 const h=harness(mode=>response(mode,9,ended[mode]));await h.controller.load();
 for(const mode of MODES){const row=h.controller.status().rows[mode];assert.equal(row.phase,'finished');assert.match(api.rowText(mode,row).action,/Итоги/);assert.match(api.rowText(mode,row).status,/завершена/);}
 assert.match(api.summaryText(h.controller.status()),/Завершённые партии/);
});
test('an ended poker hand still offers the same table and next deal',()=>{
 const e=engines.poker,state=finishPokerHand(e,copy(states.poker));
 assert(state.game.over);assert.equal(state.over,false);
 const row={...api.projection('poker',{status:'ok',revision:4,game:e.projectGame(state)}),phase:'active'};
 assert.equal(row.game.handOver,true);assert.equal(row.game.over,false);assert.match(api.rowText('poker',row).status,/Следующая раздача/);assert.match(api.rowText('poker',row).action,/Продолжить/);
});
test('verified no-game responses differ from failed loads and completed games',async()=>{
 const h=harness(mode=>response(mode,0,null));await h.controller.load();
 for(const mode of MODES){const row=h.controller.status().rows[mode];assert.equal(row.phase,'empty');assert.match(api.rowText(mode,row).status,/пока нет/);assert.equal(api.rowText(mode,row).action,'Начать →');}
});
test('partial endpoint failures leave other saved games usable and a refresh recovers',async()=>{
 let failed=true;const h=harness(mode=>{if(failed&&mode==='bunker')throw Error('secret network detail');if(failed&&mode==='mafia')return {ok:false,status:503,data:{error:'private'}};return response(mode)});
 await h.controller.load();assert.equal(h.controller.status().rows.bunker.phase,'unavailable');assert.equal(h.controller.status().rows.mafia.phase,'unavailable');assert.equal(h.controller.status().rows.monopoly.phase,'active');assert.match(api.summaryText(h.controller.status()),/Часть партий/);assert(!JSON.stringify(h.events).includes('private'));failed=false;await h.controller.load();assert(Object.values(h.controller.status().rows).every(r=>r.phase==='active'));
});
test('summary validation rejects malformed identity, revision, phase, progress and contradictory endings',()=>{
 for(const mode of MODES){for(const change of [{id:'not-a-uuid'},{phase:'<script>private</script>'},{over:'false'},{economy:{stake:100000}},mode==='poker'?{handNumber:0}:mode==='monopoly'?{turnNumber:81}:{round:0}])assert.throws(()=>api.projection(mode,{status:'ok',revision:1,game:{...games[mode],...change}}));for(const revision of [-1,1.1,'1',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>api.projection(mode,{status:'ok',revision,game:games[mode]}));assert.throws(()=>api.projection(mode,{status:'conflict',revision:2,game:games[mode]}));}
 assert.throws(()=>api.projection('durak',{status:'ok',revision:1,game:{...games.durak,over:true}}));
 assert.throws(()=>api.projection('poker',{status:'ok',revision:1,game:{...games.poker,tableClosed:true,over:false}}));
});
test('no raw game object, hidden cards, roles, player names or error text survive projection or controller events',async()=>{
 const h=harness(mode=>{const g=copy(games[mode]);Object.assign(g,{privateNotes:['DO_NOT_KEEP'],secret:'DO_NOT_KEEP',message:'DO_NOT_KEEP',players:[{name:'DO_NOT_KEEP',role:'DO_NOT_KEEP',hand:[{id:'DO_NOT_KEEP'}]}]});return response(mode,1,g)});
 await h.controller.load();const raw=JSON.stringify(h.events);assert(!raw.includes('DO_NOT_KEEP'));assert(!/players|privateNotes|message|handId|community|legal/.test(raw));
 for(const mode of MODES){const summary=h.controller.status().rows[mode].game;assert.deepEqual(Object.keys(summary).sort(),['id','over','phase','stake','step',...(mode==='poker'?['handOver']:[])].sort());}
 const snapshot=h.controller.status();snapshot.rows.durak.game.step=999;assert.notEqual(h.controller.status().rows.durak.game.step,999);
});
test('pending actions are only detected under exact game/account keys and never read as commands',async()=>{
 const store=memory();for(const mode of MODES)store.values.set(key(mode),'{ corrupt action with PRIVATE_PAYLOAD');store.values.set(key('durak',OTHER),'another-account');const before=[...store.values];
 const h=harness(mode=>mode==='mafia'?Promise.reject(Error('offline')):response(mode,0,null),store);await h.controller.load();
 for(const mode of MODES){const row=h.controller.status().rows[mode];assert.equal(row.phase,'pending');assert.equal(row.pending,true);assert.match(api.rowText(mode,row).action,/Проверить партию/);}
 assert.deepEqual([...store.values],before);assert(!JSON.stringify(h.events).includes('PRIVATE_PAYLOAD'));assert(h.calls.every(c=>JSON.stringify(c.body)==='{"op":"load"}'));
 store.values.delete(key('durak'));await h.controller.load();assert.equal(h.controller.status().rows.durak.phase,'empty');assert(store.values.has(key('durak',OTHER)));
});
test('unavailable local storage cannot silently claim there is no pending request',async()=>{
 const h=harness(undefined,{getItem(){throw Error('denied')}});await h.controller.load();assert.equal(h.calls.length,0);assert(Object.values(h.controller.status().rows).every(r=>r.phase==='unavailable'));
});
test('revisions never regress and stale snapshots are not presented as a current save',async()=>{
 let revision=8;const h=harness(mode=>response(mode,revision));await h.controller.load();revision=3;await h.controller.load();
 for(const mode of MODES){const row=h.controller.status().rows[mode];assert.equal(row.revision,8);assert.equal(row.phase,'unavailable');assert.match(api.rowText(mode,row).status,/Не удалось/);}revision=9;await h.controller.load();assert.equal(h.controller.status().rows.durak.revision,9);
});
test('late replies after account or tab changes are discarded',async()=>{
 const resolves=[];const h=harness(mode=>new Promise(resolve=>resolves.push(()=>resolve(response(mode)))));const pending=h.controller.load();const count=h.events.length;h.deactivate();resolves.forEach(resolve=>resolve());assert.equal(await pending,false);assert.equal(h.events.length,count);assert(Object.values(h.controller.status().rows).every(r=>r.game===null));
});
test('destroying a controller invalidates in-flight reads and prevents further requests',async()=>{
 const resolves=[],h=harness(mode=>new Promise(resolve=>resolves.push(()=>resolve(response(mode)))));const pending=h.controller.load();h.controller.destroy();const count=h.events.length;resolves.forEach(resolve=>resolve());assert.equal(await pending,false);assert.equal(await h.controller.load(),false);assert.equal(h.calls.length,5);assert.equal(h.events.length,count);
});
test('manual refresh cannot create parallel duplicate read batches',async()=>{
 const resolves=[],h=harness(mode=>new Promise(resolve=>resolves.push(()=>resolve(response(mode)))));const pending=h.controller.load();assert.equal(await h.controller.load(),false);assert.equal(h.calls.length,5);resolves.forEach(resolve=>resolve());await pending;
});

// DOM contract fixture runs the real mount/event handlers without claiming visual QA.
function node(children={}){return {isConnected:true,attrs:{},textContent:'',disabled:false,listeners:new Map(),querySelector(selector){return children[selector]||null},setAttribute(k,v){this.attrs[k]=String(v)},addEventListener(k,fn){if(!this.listeners.has(k))this.listeners.set(k,new Set());this.listeners.get(k).add(fn)},removeEventListener(k,fn){this.listeners.get(k)?.delete(fn)},click(){if(!this.disabled)for(const fn of this.listeners.get('click')||[])fn();}};}
function region(){const links={},summary=node(),button=node(),children={};for(const mode of MODES){const detail=node(),action=node(),link=node({'[data-server-session-status]':detail,'[data-server-session-action]':action});link.detail=detail;link.action=action;links[mode]=link;children['[data-server-game="'+mode+'"]']=link;}const root=node(children),parent=node({'[data-server-sessions-summary]':summary,'[data-server-sessions-refresh]':button});root.parentElement=parent;root.closest=()=>parent;return {root,summary,button,links};}
function browserHarness(request=(mode)=>response(mode)){
 const listeners=new Map(),storage=memory();let user={user:{id:SCOPE},loading:false,switching:false,authPending:false},scope=SCOPE,active=true;const calls=[];
 const add=(name,fn)=>{if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(fn)},dispatch=(name,event={})=>{for(const fn of listeners.get(name)||[])fn(event)};
 const document={hidden:false,addEventListener:add},platform={account:()=>user,scopeKey:()=>scope,ready:Promise.resolve()};
 for(const mode of MODES)platform['server'+mode[0].toUpperCase()+mode.slice(1)+'Request']=body=>{calls.push({mode,body:copy(body),scope});return request(mode,scope)};
 const window={VEZDEHOT:platform,VEZDEHOT_TAB_SESSION:{canWrite:()=>active},localStorage:storage,addEventListener:add};
 const ctx={window,document};vm.createContext(ctx);vm.runInContext(source,ctx);
 return {api:window.VEZDEHOT_SERVER_SESSIONS,calls,storage,document,dispatch,setAccount:(next,nextScope=next?.user?.id||'guest')=>{user=next;scope=nextScope},setActive:value=>active=value};
}
test('mount renders all five cards without replacing their navigation or focus targets',async()=>{
 const h=browserHarness(),r=region();h.api.mount(r.root);await flush();assert.equal(h.calls.length,5);assert.equal(r.root.attrs['aria-busy'],'false');assert.equal(r.button.disabled,false);assert.match(r.summary.textContent,/Можно продолжить: 5/);
 for(const mode of MODES){assert.equal(r.links[mode].attrs['data-server-session-state'],'active');assert.match(r.links[mode].attrs['aria-label'],/Продолжить/);assert.equal(r.links[mode].action.textContent,'Продолжить →');}r.button.click();await flush();assert.equal(h.calls.length,10);
});
test('profile notifications and DOM remounts reuse the current account summaries',async()=>{
 const h=browserHarness(),first=region();h.api.mount(first.root);await flush();for(let i=0;i<8;i++)h.dispatch('vezdehot:profile');h.api.mount(first.root);const next=region();first.root.isConnected=false;h.api.mount(next.root);await flush();assert.equal(h.calls.length,5);assert.equal(first.button.listeners.get('click').size,0);assert.equal(next.links.durak.action.textContent,'Продолжить →');assert.equal(next.button.listeners.get('click').size,1);
});
test('guest, incomplete authentication and tab ownership states never request account games',async()=>{
 for(const [account,active,scope,phase] of [[{user:null},true,'guest','guest'],[{user:{id:SCOPE},authPending:true},true,SCOPE,'loading'],[{user:{id:SCOPE},loading:true},true,SCOPE,'loading'],[{user:{id:SCOPE},switching:true},true,SCOPE,'loading'],[{user:{id:SCOPE}},false,SCOPE,'paused'],[{user:{id:SCOPE}},true,OTHER,'paused']]){
  const h=browserHarness(),r=region();h.setAccount(account,scope);h.setActive(active);h.api.mount(r.root);await flush();assert.equal(h.calls.length,0);assert.equal(r.links.durak.attrs['data-server-session-state'],phase);assert.equal(r.button.disabled,true);
 }
});
test('switching accounts immediately clears old summaries and rejects late results',async()=>{
 const late=[];const h=browserHarness((mode,scope)=>scope===SCOPE?new Promise(resolve=>late.push(()=>resolve(response(mode)))):response(mode,0,null)),r=region();h.api.mount(r.root);await flush();h.dispatch('vezdehot:accountchange');assert(!r.links.durak.detail.textContent.includes('Раунд'));h.setAccount({user:{id:OTHER},loading:false});h.dispatch('vezdehot:profile');await flush();late.forEach(fn=>fn());await flush();assert.equal(r.links.durak.attrs['data-server-session-state'],'empty');assert.equal(h.api.status().rows.durak.game,null);assert.equal(h.calls.length,10);
});
test('hidden tabs discard late summaries and read fresh state on return',async()=>{
 let delayed=true;const resolves=[];const h=browserHarness(mode=>delayed?new Promise(resolve=>resolves.push(()=>resolve(response(mode)))):response(mode,4,ended[mode])),r=region();h.api.mount(r.root);await flush();h.document.hidden=true;h.dispatch('visibilitychange');resolves.forEach(fn=>fn());await flush();assert.equal(r.links.durak.attrs['data-server-session-state'],'paused');assert.equal(h.api.status().rows.durak.game,null);delayed=false;h.document.hidden=false;h.dispatch('visibilitychange');await flush();assert.equal(r.links.durak.attrs['data-server-session-state'],'finished');assert.equal(h.calls.length,10);
});
test('ownership handoff clears summaries and a newly active tab reloads them',async()=>{
 const h=browserHarness(),r=region();h.api.mount(r.root);await flush();h.setActive(false);h.dispatch('vezdehot:sessionpause');h.dispatch('vezdehot:sessionlost');assert.equal(r.links.durak.attrs['data-server-session-state'],'paused');assert.equal(h.api.status().rows.durak.game,null);h.setActive(true);h.dispatch('vezdehot:sessionactive');await flush();assert.equal(h.calls.length,10);assert.equal(r.links.durak.attrs['data-server-session-state'],'active');
});
test('an offline overview has explicit recovery and reconnect refreshes all five games',async()=>{
 let offline=true;const h=browserHarness(mode=>{if(offline)throw Error('offline');return response(mode)}),r=region();h.api.mount(r.root);await flush();assert.equal(r.links.durak.attrs['data-server-session-state'],'unavailable');assert.equal(r.button.disabled,false);assert.match(r.links.durak.action.textContent,/Проверить/);offline=false;h.dispatch('online');await flush();assert.equal(r.links.durak.attrs['data-server-session-state'],'active');
});
test('pending storage updates and browser history restoration refresh read-only summaries',async()=>{
 const h=browserHarness(),r=region();h.api.mount(r.root);await flush();h.storage.values.set(key('durak'),'PRIVATE');h.dispatch('storage',{key:key('durak')});await flush();assert.equal(r.links.durak.attrs['data-server-session-state'],'pending');assert.match(r.links.durak.action.textContent,/Проверить партию/);const count=h.calls.length;h.dispatch('storage',{key:key('durak',OTHER)});await flush();assert.equal(h.calls.length,count);h.dispatch('pageshow',{persisted:true});await flush();assert.equal(h.calls.length,count+5);assert(!JSON.stringify(h.api.status()).includes('PRIVATE'));
});
test('unmount removes refresh handlers and no unmounted lobby triggers background loads',async()=>{
 const h=browserHarness(),r=region(),unmount=h.api.mount(r.root);await flush();unmount();const count=h.calls.length;r.button.click();h.dispatch('online');h.dispatch('vezdehot:profile');await flush();assert.equal(h.calls.length,count);assert.equal(r.button.listeners.get('click').size,0);
});
