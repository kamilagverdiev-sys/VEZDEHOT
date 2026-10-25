'use strict';
// Two logical devices have separate local storage and share only the CAS service.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../dist/cloud-checkpoint.js'),'utf8');
const A='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const GAMES=['durak','bunker','poker','mafia','monopoly'];
const plain=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const metaKey=scope=>'vezdehot:checkpoint:v1:'+scope;
const emptyGames=()=>Object.fromEntries(GAMES.map(game=>[game,null]));
const gameSet=token=>Object.fromEntries(GAMES.map(game=>[game,{fixture:game,token,turn:1}]));
const baseProfile=()=>({nick:'Игрок',balance:10000,xp:0,wins:0,games:0,bonusAt:0,avatar:'✦',durakPace:'calm',reduceMotion:false,history:[],resultIds:[],revision:0,dirty:false});
const publicProfile=profile=>Object.fromEntries(['nick','balance','xp','wins','games','bonusAt','avatar','durakPace','reduceMotion','history','resultIds'].map(key=>[key,plain(profile[key])]));
const snapshot=(profile=baseProfile(),games=emptyGames())=>({format:'vezdehot-account-checkpoint',version:1,profile:publicProfile(profile),games:plain(games)});
const result=(id='round-a')=>({id,game:'mafia',win:true,delta:250,xp:130,at:'2026-10-23T12:00:00.123Z',synced:false});
function validate(game,state){if(state===null)return null;if(!state||state.fixture!==game||typeof state.token!=='string'||!Number.isInteger(state.turn)||state.turn<0)throw Error('Invalid '+game);return plain(state)}
function service(){
 const accounts=new Map(),requests=[],holds=[];let clock=1700000000000;
 const account=scope=>{if(!accounts.has(scope))accounts.set(scope,{revision:0,snapshot:snapshot(),completed:new Set(),mutations:new Map(),commits:0,updatedAt:new Date(clock).toISOString()});return accounts.get(scope)};
 function respond(scope,name,args){const row=account(scope);
  if(name==='load_player_checkpoint')return {data:{status:'ok',revision:row.revision,snapshot:plain(row.snapshot),completedIds:[...new Set([...(args.p_known_ids||[]).filter(id=>row.completed.has(id)),...[...row.completed].slice(-30)])],updatedAt:row.updatedAt},error:null};
  assert.equal(name,'commit_player_checkpoint');
  if(row.mutations.has(args.p_mutation_id))return {data:plain(row.mutations.get(args.p_mutation_id)),error:null};
  if(args.p_expected_revision!==row.revision)return {data:{status:'conflict',revision:row.revision,updatedAt:row.updatedAt},error:null};
  if((args.p_results||[]).some(entry=>row.completed.has(entry.id)))return {data:{status:'duplicate_result',revision:row.revision,updatedAt:row.updatedAt},error:null};
  row.snapshot=plain(args.p_snapshot);row.revision++;row.commits++;row.updatedAt=new Date(++clock).toISOString();
  for(const entry of args.p_results||[])row.completed.add(entry.id);
  const reply={status:'saved',revision:row.revision,mutationId:args.p_mutation_id,updatedAt:row.updatedAt};row.mutations.set(args.p_mutation_id,reply);return {data:plain(reply),error:null};
 }
 return {accounts,requests,account,
  seed(scope,payload=snapshot(),revision=1){const row=account(scope);row.snapshot=plain(payload);row.revision=revision;return row},
  hold(scope,name,{apply=false}={}){const gate={scope,name,apply,job:null,...deferred()};holds.push(gate);return gate},
  async rpc(scope,name,args){const request={scope,name,args:plain(args)};requests.push(request);const i=holds.findIndex(gate=>gate.scope===scope&&gate.name===name);
   if(i<0)return respond(scope,name,args);const gate=holds.splice(i,1)[0];let reply=gate.apply?respond(scope,name,args):null;
   gate.job=request;gate.finish=()=>gate.resolve(reply||respond(scope,name,args));gate.fail=()=>gate.reject(new Error('Network timeout after request'));return gate.promise;
  }
 };
}
let deviceNumber=0;
function device(server,{scope=A,storage=new Map(),profile,games,failWrite=()=>false}={}){
 const id=++deviceNumber,profileKey='test:profile:'+scope,pendingKey='test:results:'+scope,revisionsKey='test:revisions:'+scope,gameKey=game=>'test:game:'+scope+':'+game;
 if(profile&&!storage.has(profileKey))storage.set(profileKey,plain(profile));
 if(games)for(const game of GAMES)if(!storage.has(gameKey(game)))storage.set(gameKey(game),plain(games[game]));
 let localProfile=plain(storage.get(profileKey)||baseProfile()),localGames=Object.fromEntries(GAMES.map(game=>[game,plain(storage.get(gameKey(game))??null)])),pending=plain(storage.get(pendingKey)||[]),current=true,uuid=0;
 const controls={failWrite},writes=[],effects=[],calls=[],revisions=plain(storage.get(revisionsKey)||Object.fromEntries(GAMES.map(game=>[game,0])));
 const write=(key,value)=>{writes.push({key,value:plain(value)});if(!current||controls.failWrite(key,value))return false;storage.set(key,plain(value));return true};
 const saveLocal=()=>{storage.set(profileKey,plain(localProfile));storage.set(pendingKey,plain(pending));for(const game of GAMES)storage.set(gameKey(game),plain(localGames[game]));storage.set(revisionsKey,plain(revisions))};
 const store={exportAll(requestScope,options={}){assert.equal(requestScope,scope);if(!current||options.contextCurrent?.()===false)return {ok:false,games:{},revisions:{},message:'Lost ownership'};return {ok:true,games:plain(localGames),revisions:plain(revisions),message:''}},
  installAll(requestScope,next,options={}){assert.equal(requestScope,scope);assert.deepEqual(Object.keys(next).sort(),[...GAMES].sort());for(const game of GAMES)validate(game,next[game]);
   for(const game of GAMES){if(!current||options.contextCurrent?.()===false)return {ok:false,message:'Lost ownership'};if(!write(gameKey(game),next[game]))return {ok:false,message:'Quota'};localGames[game]=plain(next[game]);revisions[game]++;storage.set(revisionsKey,plain(revisions));effects.push('install:'+game)}return {ok:true,message:''};}
 };
 const context={window:{},console,Date,Math,JSON,setTimeout,clearTimeout,crypto:require('node:crypto').webcrypto};vm.createContext(context);vm.runInContext(source,context);
 const instance=context.window.VEZDEHOT_CHECKPOINT.create({scope,getProfile:()=>plain(localProfile),getPendingResults:()=>plain(pending),getStore:()=>store,validate,
  read:(key,fallback)=>plain(storage.has(key)?storage.get(key):fallback),write,current:()=>current,
  rpc:(name,args)=>{calls.push({name,args:plain(args)});if(name==='commit_player_checkpoint'){const durable=JSON.stringify(storage.get(metaKey(scope)));assert.ok(durable?.includes(args.p_mutation_id),'flight identity must be durable before RPC');assert.ok(durable.includes(JSON.stringify(args.p_snapshot)),'flight body must be durable before RPC')}return server.rpc(scope,name,args)},
  installProfile(next,completedIds=[]){if(!current)return false;const installed={...plain(next),revision:localProfile.revision+1,dirty:false};if(!write(profileKey,installed))return false;localProfile=installed;pending=[];if(!write(pendingKey,pending))return false;effects.push('profile');return true},
  acknowledge({ids=[],profileRevision}){assert.ok(current,'stale response must not acknowledge');effects.push('ack');pending=pending.filter(entry=>!ids.includes(entry.id));localProfile.history.forEach(entry=>{if(ids.includes(entry.id))entry.synced=true});if(localProfile.revision===profileRevision)localProfile.dirty=false;const saved=write(profileKey,localProfile),savedPending=write(pendingKey,pending);return saved&&savedPending},
  pause(){effects.push('pause')},onChange(){effects.push('status')},reload(){effects.push('reload')},uuid:()=>`00000000-0000-4000-8000-${(id*1000000+ ++uuid).toString(16).padStart(12,'0')}`,now:()=>1700000000000+id
 });
 return {instance,storage,controls,writes,effects,calls,scope,profileKey,pendingKey,gameKey,
  profile:()=>plain(localProfile),games:()=>plain(localGames),pending:()=>plain(pending),view:()=>({profile:plain(localProfile),games:plain(localGames),pending:plain(pending)}),
  change(patch={},nextGames){localProfile={...localProfile,...plain(patch),revision:localProfile.revision+1,dirty:true};if(nextGames){localGames=plain(nextGames);for(const game of GAMES)revisions[game]++}saveLocal();instance.changed()},
  changeGames(nextGames){localGames=plain(nextGames);for(const game of GAMES)revisions[game]++;saveLocal();instance.changed()},
  addResult(entry=result()){if(!localProfile.resultIds.includes(entry.id)){localProfile={...localProfile,balance:localProfile.balance+entry.delta,xp:localProfile.xp+entry.xp,games:localProfile.games+1,wins:localProfile.wins+(entry.win?1:0),history:[plain(entry),...localProfile.history].slice(0,30),resultIds:[...localProfile.resultIds,entry.id].slice(-500),revision:localProfile.revision+1,dirty:true};pending.push(plain(entry));saveLocal();instance.changed()}},
  setCurrent(value){current=value},invalidate(){current=false;instance.invalidate()},replaceForAccount(nextProfile,nextGames){localProfile=plain(nextProfile);localGames=plain(nextGames)},clearEvents(){effects.length=0;writes.length=0}
 };
}
async function boot(server,options){const h=device(server,options);await h.instance.boot();assert.equal(h.instance.canWrite(),true,'baseline device can play');return h}
const commits=h=>h.calls.filter(call=>call.name==='commit_player_checkpoint');

// A device cannot accidentally share a browser lock or local storage with its peer.
test('two independent devices preserve a conflicting branch instead of overwriting a newer account checkpoint',async()=>{
 const server=service();server.seed(A);const first=await boot(server),second=await boot(server);assert.notEqual(first.storage,second.storage);
 first.change({nick:'First device',balance:9100},gameSet('first'));second.change({nick:'Second device',balance:9300},gameSet('second'));
 await first.instance.sync();const committed=plain(server.account(A).snapshot),revision=server.account(A).revision,local=second.view();
 await second.instance.sync();assert.equal(second.instance.canWrite(),false);assert.deepEqual(server.account(A).snapshot,committed);assert.equal(server.account(A).revision,revision);assert.deepEqual(second.view(),local);
 assert.equal(second.instance.status().phase,'conflict');assert.ok(second.effects.includes('pause'));
});

test('a committed request with a lost ACK retries its durable identity after reload without another reward or revision',async()=>{
 const server=service();server.seed(A);const h=await boot(server);h.addResult();h.change({},gameSet('finished'));
 const gate=server.hold(A,'commit_player_checkpoint',{apply:true}),sending=h.instance.sync();await tick();assert.ok(gate.job);const first=plain(gate.job.args),revision=server.account(A).revision;gate.fail();await sending;
 assert.equal(h.instance.canWrite(),true);assert.equal(server.account(A).completed.size,1);assert.equal(h.pending().length,1);
 h.invalidate();const reopened=device(server,{storage:h.storage});await reopened.instance.boot();await reopened.instance.sync();
 const retried=commits(reopened).find(call=>call.args.p_mutation_id===first.p_mutation_id);assert.ok(retried,'retry uses the persisted flight');assert.deepEqual(retried.args,first);
 assert.equal(server.account(A).revision,revision);assert.equal(server.account(A).completed.size,1);assert.equal(reopened.profile().balance,10250);assert.equal(reopened.profile().games,1);assert.equal(reopened.pending().length,0);assert.equal(reopened.instance.canWrite(),true);
});

test('a late successful ACK acknowledges only its snapshot while later local changes stay pending',async()=>{
 const server=service();server.seed(A);const h=await boot(server);h.change({nick:'First edit'},gameSet('first'));
 const gate=server.hold(A,'commit_player_checkpoint',{apply:true}),sending=h.instance.sync();await tick();assert.ok(gate.job);const revision=server.account(A).revision;
 h.change({nick:'Second edit',balance:8900},gameSet('second'));h.addResult(result('during-flight'));const secondView=h.view();gate.finish();await sending;
 assert.equal(h.profile().nick,'Second edit');assert.equal(h.profile().balance,secondView.profile.balance);assert.deepEqual(h.games(),secondView.games);
 await h.instance.sync();assert.equal(server.account(A).snapshot.profile.nick,'Second edit');assert.equal(server.account(A).snapshot.profile.balance,secondView.profile.balance);assert.deepEqual(server.account(A).snapshot.games,secondView.games);
 const last=commits(h).at(-1);assert.equal(last.args.p_expected_revision,revision);assert.notEqual(last.args.p_mutation_id,gate.job.args.p_mutation_id);assert.equal(h.pending().length,0);
});

test('invalidating account A ignores its delayed read and ACK and cannot change account B',async()=>{
 const server=service();server.seed(A);server.seed(B,snapshot({...baseProfile(),nick:'Account B',balance:44000}));
 const load=server.hold(A,'load_player_checkpoint'),reading=device(server),starting=reading.instance.boot();await tick();assert.ok(load.job);reading.invalidate();reading.clearEvents();const before=reading.view(),stored=plain([...reading.storage]);load.finish();await starting;
 assert.deepEqual(reading.view(),before);assert.deepEqual([...reading.storage],stored);assert.equal(reading.effects.length,0);
 const h=await boot(server);h.change({nick:'Account A edit'});const ack=server.hold(A,'commit_player_checkpoint',{apply:true}),sending=h.instance.sync();await tick();assert.ok(ack.job);h.invalidate();
 const other=device(server,{scope:B,storage:h.storage,profile:{...baseProfile(),nick:'Account B',balance:44000}});await other.instance.boot();const accountB=other.view(),savedB=plain([...other.storage]);h.clearEvents();ack.finish();await sending;
 assert.deepEqual(other.view(),accountB);assert.deepEqual([...other.storage],savedB);assert.equal(h.effects.length,0);assert.equal(other.profile().nick,'Account B');assert.equal(server.account(B).snapshot.profile.balance,44000);
});

test('accepting cloud refreshes the latest whole branch and archives local progress before import',async()=>{
 const server=service();server.seed(A);const first=await boot(server),second=await boot(server);first.change({balance:9000},gameSet('cloud-v1'));second.change({balance:8100},gameSet('local-branch'));second.addResult(result('local-only'));await first.instance.sync();await second.instance.sync();assert.equal(second.instance.canWrite(),false);
 first.change({balance:7200},gameSet('cloud-v2'));await first.instance.sync();const latest=plain(server.account(A).snapshot),local=second.view();second.clearEvents();await second.instance.acceptCloud();
 assert.deepEqual(publicProfile(second.profile()),latest.profile);assert.deepEqual(second.games(),latest.games);assert.equal(second.pending().length,0,'discarded branch cannot replay its local reward after acceptance');
 const archives=[...second.storage].filter(([key])=>key.startsWith(metaKey(A)+':archive:'));assert.ok(archives.length);const archived=JSON.stringify(archives);assert.ok(archived.includes('local-branch'));assert.ok(archived.includes('local-only'));assert.ok(archived.includes(String(local.profile.balance)));
 const archiveAt=second.writes.findIndex(write=>write.key.startsWith(metaKey(A)+':archive:')),journalAt=second.writes.findIndex(write=>write.key===metaKey(A)+':import'),gameAt=second.writes.findIndex(write=>write.key===second.gameKey('durak'));
 assert.ok(archiveAt>=0&&archiveAt<journalAt&&journalAt<gameAt,'archive then import journal must precede installation');assert.ok(second.effects.includes('reload'));assert.equal(commits(second).length,1,'acceptance never force-commits the rejected local branch');
});

test('archive or import-journal quota errors prevent branch replacement and remain retryable',async()=>{
 for(const stage of ['archive','journal']){const server=service();server.seed(A,snapshot({...baseProfile(),balance:25000},gameSet('cloud')));const h=device(server,{profile:{...baseProfile(),balance:17000},games:gameSet('local')});await h.instance.boot();assert.equal(h.instance.canWrite(),false);const before=h.view();
  h.controls.failWrite=key=>stage==='archive'?key.startsWith(metaKey(A)+':archive:'):key===metaKey(A)+':import';h.clearEvents();await h.instance.acceptCloud();assert.deepEqual(h.view(),before);assert.equal(h.instance.canWrite(),false);assert.equal(h.effects.some(effect=>effect.startsWith('install:')||effect==='profile'||effect==='reload'),false);
  h.controls.failWrite=()=>false;await h.instance.acceptCloud();assert.equal(h.profile().balance,25000);assert.deepEqual(h.games(),gameSet('cloud'));
 }
});

test('a partially written import is fenced and recovers the whole journal after reload',async()=>{
 const server=service(),cloud=snapshot({...baseProfile(),balance:25000},gameSet('cloud'));server.seed(A,cloud);
 const h=device(server,{profile:{...baseProfile(),balance:17000},games:gameSet('local')});await h.instance.boot();h.controls.failWrite=key=>key===h.gameKey('poker');await h.instance.acceptCloud();
 assert.equal(h.instance.canWrite(),false);assert.ok(h.storage.get(metaKey(A)+':import'));assert.equal(h.games().durak.token,'cloud');assert.equal(h.games().poker.token,'local');assert.equal(commits(h).length,0);
 h.invalidate();const reopened=device(server,{storage:h.storage,failWrite:key=>key===h.gameKey('poker')});await reopened.instance.boot();assert.equal(reopened.instance.canWrite(),false);assert.ok(reopened.storage.get(metaKey(A)+':import'));assert.equal(commits(reopened).length,0);
 reopened.controls.failWrite=()=>false;await reopened.instance.recoverImport();assert.deepEqual(publicProfile(reopened.profile()),cloud.profile);assert.deepEqual(reopened.games(),cloud.games);assert.ok(!reopened.storage.get(metaKey(A)+':import'));assert.equal(reopened.pending().length,0);
});

test('remote validation rejects the complete snapshot before installing any game or profile',async()=>{
 const server=service(),broken=snapshot({...baseProfile(),balance:22000},gameSet('remote'));broken.games.mafia={fixture:'mafia',token:'broken',turn:-1};server.seed(A,broken);
 const h=device(server),before=h.view();await h.instance.boot();assert.equal(h.instance.canWrite(),false);assert.deepEqual(h.view(),before);assert.equal(h.effects.some(effect=>effect.startsWith('install:')||effect==='profile'),false);assert.equal(commits(h).length,0);
});

test('a flight that cannot be stored durably never reaches the CAS service',async()=>{
 const server=service();server.seed(A);const h=await boot(server);h.change({balance:9300},gameSet('unsaved-flight'));h.controls.failWrite=key=>key===metaKey(A);const before=server.account(A).revision;await h.instance.sync();assert.equal(commits(h).length,0);assert.equal(server.account(A).revision,before);assert.equal(h.instance.canWrite(),true);
 h.controls.failWrite=()=>false;await h.instance.sync();assert.equal(server.account(A).snapshot.profile.balance,9300);assert.equal(commits(h).length,1);
});

test('failed ACK metadata persistence retries the original receipt without paying or committing twice',async()=>{
 const server=service();server.seed(A);const h=await boot(server);h.addResult(result('ack-quota'));const base=server.account(A).revision;
 h.controls.failWrite=(key,value)=>key===metaKey(A)&&value?.flight===null&&value?.baseRevision>base;
 await h.instance.sync();assert.equal(server.account(A).revision,base+1);assert.equal(h.instance.status().phase,'offline');assert.ok(h.storage.get(metaKey(A)).flight);const request=plain(commits(h)[0].args);
 h.invalidate();const reopened=device(server,{storage:h.storage});await reopened.instance.boot();assert.equal(server.account(A).revision,base+1);assert.deepEqual(commits(reopened)[0].args,request);assert.equal(reopened.profile().balance,10250);assert.equal(reopened.profile().games,1);assert.equal(reopened.pending().length,0);assert.equal(reopened.storage.get(metaKey(A)).flight,null);
});

test('failed profile acknowledgement keeps the flight durable for safe replay',async()=>{
 const server=service();server.seed(A);const h=await boot(server);h.addResult(result('profile-ack-quota'));h.controls.failWrite=key=>key===h.profileKey;await h.instance.sync();
 assert.equal(h.instance.status().phase,'offline');assert.ok(h.storage.get(metaKey(A)).flight);const revision=server.account(A).revision,request=plain(commits(h)[0].args);
 h.controls.failWrite=()=>false;await h.instance.sync();assert.deepEqual(commits(h).at(-1).args,request);assert.equal(server.account(A).revision,revision);assert.equal(h.profile().balance,10250);assert.equal(h.profile().games,1);assert.equal(h.pending().length,0);
});

test('game-only changes during flight remain dirty although the profile revision is unchanged',async()=>{
 const server=service();server.seed(A);const h=await boot(server);h.change({},gameSet('first-move'));const gate=server.hold(A,'commit_player_checkpoint',{apply:true}),sending=h.instance.sync();await tick();
 const next=gameSet('second-move');for(const game of GAMES)next[game].turn=2;
 const profileRevision=h.profile().revision;h.changeGames(next);assert.equal(h.profile().revision,profileRevision);gate.finish();await sending;
 assert.equal(h.instance.status().pending,true);await h.instance.sync();
 assert.equal(server.account(A).snapshot.games.mafia.token,'second-move');assert.equal(server.account(A).snapshot.games.mafia.turn,2);assert.equal(commits(h).length,2);assert.equal(h.profile().revision,profileRevision);
});

test('concurrent cloud acceptance shares or rejects a pending read instead of importing twice',async()=>{
 const server=service();server.seed(A,snapshot({...baseProfile(),balance:25000},gameSet('cloud')));const h=device(server,{profile:{...baseProfile(),balance:17000},games:gameSet('local')});await h.instance.boot();h.clearEvents();
 const gate=server.hold(A,'load_player_checkpoint',{apply:true}),before=h.calls.filter(call=>call.name==='load_player_checkpoint').length;
 const first=h.instance.acceptCloud();await tick();assert.ok(gate.job);const second=h.instance.acceptCloud();await tick();const reads=h.calls.filter(call=>call.name==='load_player_checkpoint').length-before;gate.finish();await Promise.all([first,second]);
 assert.equal(reads,1,'one user decision must have only one pending cloud read');assert.equal(h.effects.filter(effect=>effect==='profile').length,1);assert.equal([...h.storage.keys()].filter(key=>key.startsWith(metaKey(A)+':archive:')).length,1);
});

test('raw ownership loss makes canWrite false and suppresses all cloud or import effects',async()=>{
 const server=service();server.seed(A);const h=await boot(server);h.change({balance:9300});h.setCurrent(false);h.clearEvents();const before=h.view(),stored=plain([...h.storage]),count=h.calls.length;
 assert.equal(h.instance.canWrite(),false);await h.instance.sync({pull:true});await h.instance.acceptCloud();h.instance.changed();h.instance.recoverImport();assert.deepEqual(h.view(),before);assert.deepEqual([...h.storage],stored);assert.equal(h.calls.length,count);assert.equal(h.effects.length,0);
});

test('an invalid or foreign import journal fences the document before any server or install work',async()=>{
 for(const journal of ['broken',{version:2,scope:A},{version:1,scope:B},{version:1,scope:A,incoming:{status:'ok',revision:1,snapshot:{bad:true}}}]){
  const server=service();server.seed(A);const storage=new Map([[metaKey(A)+':import',plain(journal)]]),h=device(server,{storage}),before=h.view();await h.instance.boot();
  assert.equal(h.instance.canWrite(),false);assert.deepEqual(h.view(),before);assert.equal(h.calls.length,0);assert.equal(h.effects.some(effect=>effect.startsWith('install:')||effect==='profile'),false);assert.deepEqual(storage.get(metaKey(A)+':import'),journal);
 }
});

test('profile history and result-ID caps reject oversized remote snapshots before installation',async()=>{
 for(const kind of ['history','resultIds']){const server=service(),profile=baseProfile();if(kind==='history'){profile.history=Array.from({length:31},(_,i)=>result('history-'+i));profile.resultIds=profile.history.map(entry=>entry.id)}else profile.resultIds=Array.from({length:501},(_,i)=>'id-'+i);
  server.seed(A,snapshot(profile));const h=device(server),before=h.view();await h.instance.boot();assert.equal(h.instance.canWrite(),false);assert.deepEqual(h.view(),before);assert.equal(h.effects.some(effect=>effect.startsWith('install:')||effect==='profile'),false);
 }
});

test('outgoing checkpoint strips client-only fields and each settled result is in resultIds with matching history',async()=>{
 const server=service();server.seed(A);const h=await boot(server);h.addResult(result('shape-test'));h.change({pendingResults:[result('private-queue')],extra:'must not reach server'});await h.instance.sync();
 const args=commits(h).at(-1).args;assert.deepEqual(Object.keys(args).sort(),['p_expected_revision','p_mutation_id','p_results','p_snapshot']);assert.deepEqual(Object.keys(args.p_snapshot).sort(),['format','games','profile','version']);assert.deepEqual(Object.keys(args.p_snapshot.games).sort(),[...GAMES].sort());
 assert.deepEqual(Object.keys(args.p_snapshot.profile).sort(),Object.keys(publicProfile(baseProfile())).sort());assert.equal(args.p_snapshot.profile.revision,undefined);assert.equal(args.p_snapshot.profile.pendingResults,undefined);assert.equal(args.p_snapshot.profile.extra,undefined);
 for(const entry of args.p_results){assert.deepEqual(Object.keys(entry).sort(),['at','delta','game','id','win','xp']);assert.ok(args.p_snapshot.profile.resultIds.includes(entry.id));const history={...args.p_snapshot.profile.history.find(item=>item.id===entry.id)};delete history.synced;assert.deepEqual(history,entry)}
 assert.ok(args.p_results.length<=500);assert.ok(args.p_snapshot.profile.history.length<=30);assert.ok(args.p_snapshot.profile.resultIds.length<=500);
});

test('legacy revision-zero adoption cannot resurrect an active game whose result is already in the server ledger',async()=>{
 const server=service(),entry={...result('old-paid-table'),synced:true},remote={...baseProfile(),balance:10250,xp:130,wins:1,games:1,history:[entry],resultIds:[entry.id]};
 server.seed(A,snapshot(remote),0).completed.add(entry.id);
 // Local history retention has dropped this ID, but the saved live game still names it.
 const local={...remote,history:[],resultIds:[]},games=emptyGames();games.mafia={fixture:'mafia',token:'stale-live',turn:3,id:entry.id,over:false};
 const h=device(server,{profile:local,games});await h.instance.boot();assert.equal(h.instance.canWrite(),false);assert.equal(commits(h).length,0);assert.equal(h.games().mafia.token,'stale-live','preserve stale local bytes for explicit recovery, never resume or upload them');
});

test('duplicate_result freezes the stale payout branch and cloud acceptance restores the authoritative wallet',async()=>{
 const server=service(),entry={...result('already-settled'),synced:true},paid={...baseProfile(),balance:10250,xp:130,wins:1,games:1,history:[entry],resultIds:[entry.id]};server.seed(A,snapshot(paid)).completed.add(entry.id);
 const h=await boot(server);h.change({resultIds:[],history:[]});h.addResult({...entry,synced:false});assert.equal(h.profile().balance,10500);const revision=server.account(A).revision;
 await h.instance.sync();assert.equal(h.instance.status().phase,'conflict');assert.equal(h.instance.canWrite(),false);assert.equal(server.account(A).revision,revision);assert.equal(server.account(A).snapshot.profile.balance,10250);
 await h.instance.acceptCloud();assert.equal(h.profile().balance,10250);assert.equal(h.profile().games,1);assert.equal(h.pending().length,0);assert.ok(h.profile().resultIds.includes(entry.id));
});

test('retrying an old receipt pulls a newer cloud revision before declaring a branch saved',async()=>{
 for(const dirty of [false,true]){const server=service();server.seed(A);const first=await boot(server);first.change({nick:'Lost ACK'},gameSet('first'));
  const gate=server.hold(A,'commit_player_checkpoint',{apply:true}),sending=first.instance.sync();await tick();gate.fail();await sending;
  const second=await boot(server);second.change({nick:'Later device',balance:8800},gameSet('second'));await second.instance.sync();const latest=plain(server.account(A).snapshot),revision=server.account(A).revision;
  if(dirty)first.change({nick:'Offline continuation'},gameSet('offline-continuation'));
  await first.instance.sync();assert.equal(server.account(A).revision,revision);assert.equal(commits(first).length,2);assert.equal(commits(first)[0].args.p_mutation_id,commits(first)[1].args.p_mutation_id);
  if(dirty){assert.equal(first.instance.canWrite(),false);assert.equal(first.instance.status().phase,'conflict');assert.equal(first.profile().nick,'Offline continuation');assert.equal(first.games().mafia.token,'offline-continuation')}
  else{assert.deepEqual(publicProfile(first.profile()),latest.profile);assert.deepEqual(first.games(),latest.games);assert.equal(first.instance.status().revision,revision);assert.ok(first.effects.includes('reload'))}
 }
});

test('301 pending settlements remain SQL-compatible after legacy resultIds retention has dropped an ID',async()=>{
 const server=service();server.seed(A);const h=await boot(server);for(let i=0;i<301;i++)h.addResult(result('offline-'+i));h.change({resultIds:h.profile().resultIds.slice(-300)});await h.instance.sync();
 const args=commits(h).at(-1).args;assert.equal(args.p_results.length,301);assert.equal(args.p_snapshot.profile.history.length,30);assert.equal(args.p_snapshot.profile.resultIds.length,301);
 assert.ok(args.p_results.every(entry=>args.p_snapshot.profile.resultIds.includes(entry.id)));assert.equal(h.pending().length,0);assert.equal(server.account(A).completed.size,301);assert.equal(h.instance.canWrite(),true);
});

test('more than 500 pending results are blocked before a permanently invalid flight is created',async()=>{
 const server=service();server.seed(A);const h=await boot(server);for(let i=0;i<501;i++)h.addResult(result('over-cap-'+i));const before=h.view();await h.instance.sync();
 assert.equal(commits(h).length,0);assert.equal(h.instance.canWrite(),false);assert.equal(h.instance.status().phase,'invalid');assert.equal(h.storage.get(metaKey(A)).flight,null);assert.deepEqual(h.view(),before);assert.equal(h.pending().length,501);
});

test('530 completed IDs cannot evict history IDs from an imported checkpoint',async()=>{
 const server=service(),profile={...baseProfile(),games:30,wins:30,xp:3900,balance:17500};profile.history=Array.from({length:30},(_,i)=>({...result('recent-'+i),synced:true}));profile.resultIds=profile.history.map(entry=>entry.id);server.seed(A,snapshot(profile));
 const original=server.rpc;server.rpc=async(scope,name,args)=>{const reply=await original(scope,name,args);if(name==='load_player_checkpoint')reply.data.completedIds=[...profile.resultIds,...Array.from({length:500},(_,i)=>'requested-old-'+i)];return reply};
 const h=await boot(server);assert.equal(h.profile().resultIds.length,500);assert.ok(profile.history.every(entry=>h.profile().resultIds.includes(entry.id)));h.change({nick:'Preserved history'});await h.instance.sync();
 const outgoing=commits(h).at(-1).args.p_snapshot.profile;assert.ok(outgoing.history.every(entry=>outgoing.resultIds.includes(entry.id)));assert.equal(outgoing.history.length,30);
});

test('profile and result consistency failures are blocked before a cloud commit',async()=>{
 const cases=[{nick:' padded '},{nick:'bad\nname'},{wins:2,games:1},{resultIds:['duplicate','duplicate']},{history:[result('missing-id')],resultIds:[]}];
 for(const patch of cases){const server=service();server.seed(A,snapshot({...baseProfile(),...patch}));const h=device(server),before=h.view();await h.instance.boot();assert.equal(h.instance.canWrite(),false);assert.deepEqual(h.view(),before);assert.equal(commits(h).length,0)}
 const server=service();server.seed(A);const h=await boot(server);h.addResult(result('mismatch'));h.change({history:[{...result('mismatch'),delta:999}]});await h.instance.sync();assert.equal(h.instance.canWrite(),false);assert.equal(commits(h).length,0);assert.equal(h.pending().length,1);
});

test('the real store and shared validator import a paused Mafia state, then fence its stale live document on cloud replacement',async()=>{
 const read=file=>fs.readFileSync(path.join(__dirname,'../dist',file),'utf8');
 const engine={window:{},Date:{now:()=>1700000000000},Math:Object.assign(Object.create(Math),{random:()=>.4})};vm.createContext(engine);vm.runInContext(read('mafia.html').split('// MAFIA_ENGINE_START')[1].split('// MAFIA_ENGINE_END')[0]+'\nthis.fixture=newGame();',engine);
 const games=emptyGames();games.mafia=plain(engine.fixture);const server=service();server.seed(A,snapshot(baseProfile(),games));
 const storage=new Map(),events=[];let profile=baseProfile(),instance,uuids=0;
 const localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value))};
 const window={localStorage,document:{dispatchEvent:event=>events.push(event)},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail}},VEZDEHOT_TAB_SESSION:{ownsLock:()=>true,canWrite:()=>!instance||instance.canWrite(),status:()=>({scope:A})}};
 const context={window,localStorage,Date,Math,console};vm.createContext(context);for(const file of ['session-validation.js','game-store.js','cloud-checkpoint.js'])vm.runInContext(read(file),context);
 const store=window.VEZDEHOT_GAME_STORE;
 instance=window.VEZDEHOT_CHECKPOINT.create({scope:A,getProfile:()=>plain(profile),getPendingResults:()=>[],getStore:()=>store,validate:(game,state,options)=>window.VEZDEHOT_SESSION_VALIDATION.validate(game,state,options),
  read:(key,fallback)=>storage.has(key)?JSON.parse(storage.get(key)):fallback,write:(key,value)=>{storage.set(key,JSON.stringify(value));return true},current:()=>true,rpc:(name,args)=>server.rpc(A,name,args),
  installProfile(value){profile={...plain(value),revision:profile.revision+1,dirty:false};return true},acknowledge(){return true},pause(){events.push({type:'pause'})},onChange(){},reload(){events.push({type:'reload'})},uuid:()=>`00000000-0000-4000-8000-${String(++uuids).padStart(12,'0')}`,now:()=>1700000000000});
 await instance.boot();assert.equal(instance.canWrite(),true);const loaded=store.load('mafia',A).state;assert.equal(loaded.paused,true);assert.equal(loaded.id,games.mafia.id);assert.equal(store.exportAll(A).ok,true);
 const move={...plain(loaded),message:'Local move'};assert.equal(store.save('mafia',A,move).ok,true);instance.changed();await instance.sync();assert.equal(server.account(A).snapshot.games.mafia.message,'Local move');
 const newer=plain(server.account(A).snapshot);newer.profile.balance=9100;newer.games.mafia.message='Other device';server.seed(A,newer,server.account(A).revision+1);await instance.sync({pull:true});
 assert.equal(profile.balance,9100);assert.equal(store.exportAll(A).games.mafia.message,'Other device');assert.ok(events.some(event=>event.type==='reload'));
 assert.equal(store.save('mafia',A,move).ok,false,'old page state must not overwrite the imported checkpoint before reload');assert.equal(JSON.parse(storage.get('vezdehot:session:v1:'+A+':mafia')).payload.message,'Other device');
});

test('SQL payload validation errors block an invalid flight while auth and network failures remain offline',async()=>{
 for(const code of ['22023','42501','network']){const server=service();server.seed(A);const h=await boot(server);h.change({balance:9500},gameSet('pending'));const before=h.view(),rpc=server.rpc;
  server.rpc=async(scope,name,args)=>{if(name==='commit_player_checkpoint'){if(code==='network')throw Error('private network detail');return {data:null,error:{code,message:'private backend detail'}}}return rpc(scope,name,args)};
  await h.instance.sync();assert.equal(h.instance.status().phase,code==='22023'?'invalid':'offline');assert.equal(h.instance.canWrite(),code!=='22023');assert.ok(h.storage.get(metaKey(A)).flight);assert.deepEqual(h.view(),before);assert.equal(h.instance.status().message.includes('private'),false);assert.equal(server.account(A).revision,1);
 }
});

test('local play during a delayed pull turns a newer remote revision into a conflict instead of automatic replacement',async()=>{
 const server=service();server.seed(A);const h=await boot(server);server.seed(A,snapshot({...baseProfile(),balance:12000},gameSet('other-device')),2);
 const gate=server.hold(A,'load_player_checkpoint',{apply:true}),pulling=h.instance.sync({pull:true});await tick();assert.ok(gate.job);assert.equal(h.instance.canWrite(),true);
 h.change({nick:'Move during cloud read',balance:9600},gameSet('new-local-move'));h.addResult(result('local-during-read'));const local=h.view();h.clearEvents();gate.finish();await pulling;
 assert.equal(h.instance.canWrite(),false);assert.equal(h.instance.status().phase,'conflict');assert.deepEqual(h.view(),local);assert.equal(h.effects.some(effect=>effect.startsWith('install:')||effect==='profile'||effect==='reload'),false);assert.equal(commits(h).length,0);
});

test('a game-only move during an unchanged cloud read is sent from the current local snapshot',async()=>{
 const server=service();server.seed(A);const h=await boot(server),profileBefore=h.profile();
 const gate=server.hold(A,'load_player_checkpoint',{apply:true}),pulling=h.instance.sync({pull:true});await tick();assert.ok(gate.job);
 h.changeGames(gameSet('move-during-read'));const currentGames=h.games();gate.finish();await pulling;
 assert.equal(commits(h).length,1);assert.equal(h.instance.status().phase,'saved');assert.deepEqual(server.account(A).snapshot.games,currentGames);assert.deepEqual(h.games(),currentGames);assert.deepEqual(h.profile(),profileBefore);
 assert.equal(h.effects.some(effect=>effect==='reload'),false);
});
