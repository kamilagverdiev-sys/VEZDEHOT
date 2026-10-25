'use strict';
// Real checkpoint/store/validation/platform modules; Supabase and lifecycle are
// controlled here. Real Web Lock handoff is covered separately in platform-locks.
const {test} = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..'), read = name => fs.readFileSync(path.join(ROOT, 'dist', name), 'utf8');
const files = ['session-validation.js', 'game-store.js', 'cloud-checkpoint.js', 'platform.js'];
const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const GAMES = ['durak','bunker','poker','mafia','monopoly'];
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const tick = async () => {for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));};
const profileKey = id => 'vezdehot:profile:' + id, metaKey = id => 'vezdehot:checkpoint:v1:' + id, gameKey = (id, game) => 'vezdehot:session:v1:' + id + ':' + game;
const baseProfile = () => ({nick:'Игрок',balance:10000,xp:0,wins:0,games:0,bonusAt:0,avatar:'✦',durakPace:'calm',reduceMotion:false,history:[],resultIds:[]});
const emptyGames = () => Object.fromEntries(GAMES.map(game => [game, null]));
const snapshot = (profile = baseProfile(), games = emptyGames()) => ({format:'vezdehot-account-checkpoint',version:1,profile:plain(profile),games:plain(games)});
const result = (id, delta = 250) => ({id,game:'mafia',win:true,delta,xp:130});
const session = id => id ? {user:{id,identities:[],app_metadata:{},user_metadata:{}}} : null;

class Target {
  constructor() {this.listeners = new Map();}
  addEventListener(type, fn) {const listeners = this.listeners.get(type) || []; listeners.push(fn); this.listeners.set(type, listeners);}
  removeEventListener(type, fn) {this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== fn));}
  dispatchEvent(event) {for (const fn of this.listeners.get(event.type) || []) fn(event); return true;}
}
function service() {
  const accounts = new Map(), requests = [], holds = [];
  const account = id => {if (!accounts.has(id)) accounts.set(id, {revision:1,snapshot:snapshot(),completed:new Set(),receipts:new Map(),bodies:new Map()}); return accounts.get(id);};
  function respond(id, name, args) {
    const row = account(id);
    if (name === 'load_player_checkpoint') return {data:{status:'ok',revision:row.revision,snapshot:plain(row.snapshot),updatedAt:'2026-10-23T12:00:00.000Z',completedIds:[...row.completed].filter(value => (args.p_known_ids || []).includes(value) || row.snapshot.profile.history.some(item => item.id === value))}};
    assert.equal(name, 'commit_player_checkpoint');
    if (row.receipts.has(args.p_mutation_id)) {assert.deepEqual(args, row.bodies.get(args.p_mutation_id), 'same UUID must resend the exact durable body'); return {data:plain(row.receipts.get(args.p_mutation_id))};}
    if (args.p_expected_revision !== row.revision) return {data:{status:'conflict',revision:row.revision}};
    if (args.p_results.some(entry => row.completed.has(entry.id))) return {data:{status:'duplicate_result',revision:row.revision}};
    row.snapshot = plain(args.p_snapshot); row.revision++;
    for (const entry of args.p_results) row.completed.add(entry.id);
    const receipt = {status:'saved',revision:row.revision,mutationId:args.p_mutation_id,updatedAt:'2026-10-23T12:01:00.000Z'};
    row.receipts.set(args.p_mutation_id, plain(receipt)); row.bodies.set(args.p_mutation_id, plain(args)); return {data:receipt};
  }
  return {account, requests,
    seed(id, value = snapshot(), revision = 1) {const row = account(id); row.snapshot = plain(value); row.revision = revision; return row;},
    hold(id, name, {apply = false} = {}) {const gate = {id,name,apply,...deferred()}; holds.push(gate); return gate;},
    rpc(id, name, args) {
      assert(id, 'guest must not call account RPC'); const request = {id,name,args:plain(args)}; requests.push(request);
      const index = holds.findIndex(gate => gate.id === id && gate.name === name);
      if (index < 0) return Promise.resolve(respond(id, name, plain(args)));
      const gate = holds.splice(index, 1)[0], answer = gate.apply ? respond(id, name, plain(args)) : null;
      gate.request = request; gate.finish = () => gate.resolve(answer || respond(id, name, plain(args))); gate.fail = () => gate.reject(Error('Lost response')); return gate.promise;
    }
  };
}
function device(server, {id = A, storage = new Map(), failWrite = () => false, noSdk = false, sessionError = false} = {}) {
  if (!storage.has('vezdehot:active')) storage.set('vezdehot:active', JSON.stringify(id || 'guest'));
  const window = new Target(), document = new Target(), timers = new Map(), writes = [], navigation = [], fromCalls = [], events = [];
  let timerId = 0, rawOwned = true, guard = null, authId = id, authCallback, currentScope = id || 'guest', ready = false;
  const controls = {failWrite};
  Object.assign(document, {body:null,hidden:false,documentElement:{dataset:{}},querySelector:()=>null,querySelectorAll:()=>[],getElementById:()=>null});
  const dispatch = document.dispatchEvent.bind(document); document.dispatchEvent = event => {events.push(event.type); return dispatch(event);};
  const localStorage = {
    getItem:key => storage.get(key) ?? null,
    setItem(key,value) {if (controls.failWrite(key, value)) throw Error('Quota exceeded'); storage.set(key, String(value)); writes.push({key,value:String(value)});},
    removeItem(key) {if (controls.failWrite(key, null)) throw Error('Quota exceeded'); storage.delete(key); writes.push({key,value:null});}
  };
  const lifecycle = {
    start: async next => {currentScope = next;},
    ownsLock: () => rawOwned,
    canWrite: () => rawOwned && (!guard || guard() !== false),
    setWriteGuard: value => {guard = value;},
    status: () => ({scope:currentScope,ownsLock:rawOwned,state:rawOwned?'active':'lost'}),
    release: async () => {rawOwned = false; document.dispatchEvent({type:'vezdehot:sessionlost'}); return true;}
  };
  const client = {
    auth:{getSession:async()=>{if(sessionError)throw Error('Unavailable session');return {data:{session:session(authId)}}},onAuthStateChange:fn=>{authCallback=fn; return {data:{subscription:{unsubscribe(){}}}};},signOut:async()=>({})},
    from(table) {fromCalls.push(table); throw Error('Legacy table API used with checkpoints enabled');},
    rpc(name,args) {
      if (name === 'commit_player_checkpoint') {
        const stored = JSON.parse(storage.get(metaKey(authId)) || 'null');
        assert.equal(stored?.flight?.id, args.p_mutation_id, 'request identity must be durable before network');
        assert.deepEqual(stored.flight.snapshot, plain(args.p_snapshot)); assert.deepEqual(stored.flight.results, plain(args.p_results));
      }
      return server.rpc(authId, name, args);
    }
  };
  Object.assign(window, {localStorage,VEZDEHOT_TAB_SESSION:lifecycle,VEZDEHOT_AUTH_CONFIG:{url:'https://project.supabase.co',publishableKey:'public',checkpointsEnabled:true},supabase:noSdk?undefined:{createClient:()=>client}});
  const context = {window,document,localStorage,console,crypto:require('node:crypto').webcrypto,AbortController,URLSearchParams,
    location:{search:'',origin:'https://app.test',assign:url=>navigation.push(url),reload:()=>navigation.push('reload')},
    CustomEvent:class {constructor(type, options = {}) {this.type=type;this.detail=options.detail;}},
    fetch:async()=>({ok:true,json:async()=>({external:{}})}),
    setTimeout:(fn, ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id)};
  vm.createContext(context); for (const file of files) vm.runInContext(read(file), context);
  const api = window.VEZDEHOT; api.ready.then(()=>{ready=true;});
  return {api,window,document,context,storage,controls,writes,navigation,events,fromCalls,timers,lifecycle,
    get ready() {return ready;}, setOwned(value) {rawOwned=value;},
    auth(next) {authId=next;authCallback(next?'SIGNED_IN':'SIGNED_OUT',session(next));},
    async runTimers(ms) {for (const [key, timer] of [...timers]) if (timer.ms === ms) {timers.delete(key);timer.fn();} await tick();},
    close() {rawOwned=false;document.dispatchEvent({type:'vezdehot:sessionlost'});timers.clear();}
  };
}
async function boot(t, server, options) {const h=device(server,options);t.after(()=>h.close());await h.api.ready;assert.equal(h.ready,true);return h;}
const commits = (server, id=A) => server.requests.filter(request=>request.id===id&&request.name==='commit_player_checkpoint');
function monopolyFixture() {
  const source=read('monopoly.html').split("(function(){'use strict';")[1].split('// Engine ends here.')[0];
  const ctx={window:{},Date,Math,console,document:{hidden:false},localStorage:{getItem:()=>null,setItem(){}},setTimeout:()=>1,clearTimeout(){},render(){}};
  vm.createContext(ctx);vm.runInContext(read('session-validation.js'),ctx);vm.runInContext(source,ctx);
  const game=ctx.newGame();ctx.game=game;ctx.initialized=true;ctx.roll();assert.equal(game.phase,'rolling');return plain(game);
}

test('enabled guest stays local and never calls an account RPC or legacy table API', async t=>{
  const server=service(),h=await boot(t,server,{id:null});assert.equal(h.api.checkpointStatus().phase,'guest');
  assert.equal(h.api.updateProfile({balance:9700}).ok,true);assert.equal(h.api.recordResult(result('guest-result')).ok,true);await h.api.sync();
  assert.equal(server.requests.length,0);assert.deepEqual(h.fromCalls,[]);assert.equal(h.api.getProfile().balance,9950);
});
test('ready waits for checkpoint bootstrap and loading guard rejects all gameplay writes', async t=>{
  const server=service();server.seed(A);const gate=server.hold(A,'load_player_checkpoint'),h=device(server);t.after(()=>h.close());await tick();
  assert(gate.request);assert.equal(h.ready,false);assert.equal(h.api.checkpointStatus().phase,'loading');const before=plain(h.api.getProfile());
  assert.equal(h.api.updateProfile({balance:1}).ok,false);assert.equal(h.api.recordResult(result('too-early')).ok,false);
  assert.equal(h.window.VEZDEHOT_GAME_STORE.save('monopoly',A,monopolyFixture()).ok,false);assert.deepEqual(plain(h.api.getProfile()),before);
  gate.finish();await h.api.ready;assert.equal(h.api.checkpointStatus().phase,'saved');assert.deepEqual(h.fromCalls,[]);
});
test('a real game-store save schedules checkpoint sync even when the profile did not change', async t=>{
  const server=service();server.seed(A);const h=await boot(t,server),profile=plain(h.api.getProfile()),game=monopolyFixture();
  assert(h.window.VEZDEHOT_GAME_STORE.save('monopoly',A,game).ok);assert.equal(h.api.getProfile().revision,profile.revision);
  assert([...h.timers.values()].some(timer=>timer.ms===700),'a game-only change queues synchronization');await h.runTimers(700);
  assert.equal(commits(server).length,1);assert.equal(server.account(A).snapshot.games.monopoly.id,game.id);assert.equal(server.account(A).snapshot.games.monopoly.phase,'rolling');
  assert.deepEqual(server.account(A).snapshot.games.monopoly.dice,game.dice);assert.equal(server.account(A).snapshot.profile.balance,profile.balance);assert.deepEqual(h.fromCalls,[]);
});
test('a result and its durable outbox entry are one profile snapshot; retry does not pay twice', async t=>{
  const server=service();server.seed(A);const h=await boot(t,server),before=h.storage.get(profileKey(A));h.controls.failWrite=key=>key===profileKey(A);
  assert.equal(h.api.recordResult(result('durable-result')).ok,false);assert.equal(h.storage.get(profileKey(A)),before);
  assert.equal(h.api.getProfile().balance,10250);assert.equal(h.api.getProfile().games,1);assert.equal(h.api.getProfile().pendingResults.length,1);
  assert.equal(h.api.recordResult(result('durable-result')).ok,false);assert.equal(h.api.getProfile().games,1);
  h.controls.failWrite=()=>false;assert.equal(h.api.recordResult(result('durable-result')).ok,true);
  const durable=JSON.parse(h.storage.get(profileKey(A)));assert.equal(durable.balance,10250);assert.equal(durable.games,1);assert.deepEqual(durable.pendingResults.map(entry=>entry.id),['durable-result']);
  assert(durable.resultIds.includes('durable-result'));assert.equal(durable.history[0].id,'durable-result');
});
test('an ACK removes only accepted outbox IDs while newer local rewards remain durable', async t=>{
  const server=service();server.seed(A);const h=await boot(t,server);assert(h.api.recordResult(result('first-reward')).ok);
  const gate=server.hold(A,'commit_player_checkpoint',{apply:true}),sending=h.api.sync();await tick();assert(gate.request);
  assert(h.api.recordResult(result('later-reward',140)).ok);gate.finish();await sending;
  assert.equal(h.api.getProfile().balance,10390);assert.equal(h.api.getProfile().games,2);assert.deepEqual(plain(h.api.getProfile().pendingResults.map(entry=>entry.id)),['later-reward']);
  assert.deepEqual(JSON.parse(h.storage.get(profileKey(A))).pendingResults.map(entry=>entry.id),['later-reward']);await h.api.sync();
  assert.equal(server.account(A).snapshot.profile.balance,10390);assert.equal(server.account(A).completed.size,2);assert.equal(h.api.getProfile().pendingResults.length,0);assert.deepEqual(h.fromCalls,[]);
});
test('the 500-entry outbox blocks a new result but retains old IDs outside visible history', async t=>{
  const server=service();server.seed(A);const h=await boot(t,server);
  for(let i=0;i<500;i++)assert(h.api.recordResult(result('outbox-'+i,1)).ok,'result '+i);
  const before=plain(h.api.getProfile());assert.equal(before.pendingResults.length,500);assert.equal(before.history.length,30);assert(before.resultIds.length<=500);
  for(const entry of before.pendingResults)assert(before.resultIds.includes(entry.id));for(const entry of before.history)assert(before.resultIds.includes(entry.id));
  assert.equal(h.api.recordResult(result('capacity-overflow',1)).ok,false);assert.deepEqual(plain(h.api.getProfile()),before);
  assert.equal(h.api.recordResult(result('outbox-0',1)).ok,true);assert.equal(h.api.getProfile().games,500);assert.equal(h.api.getProfile().balance,10500);
});
test('a lost ACK reload resends the exact persisted UUID and body without a second reward', async t=>{
  const server=service();server.seed(A);const h=await boot(t,server);h.api.recordResult(result('lost-ack'));
  const gate=server.hold(A,'commit_player_checkpoint',{apply:true}),sending=h.api.sync();await tick();assert(gate.request);const body=plain(gate.request.args),revision=server.account(A).revision;
  gate.fail();await sending;assert.equal(h.api.checkpointStatus().phase,'offline');assert.equal(h.api.getProfile().pendingResults.length,1);assert.equal(JSON.parse(h.storage.get(metaKey(A))).flight.id,body.p_mutation_id);
  h.close();const reopened=await boot(t,server,{storage:h.storage});const repeat=commits(server).filter(request=>request.args.p_mutation_id===body.p_mutation_id);assert(repeat.length>=2);assert.deepEqual(repeat.at(-1).args,body);
  assert.equal(server.account(A).revision,revision);assert.equal(server.account(A).completed.size,1);assert.equal(reopened.api.getProfile().balance,10250);assert.equal(reopened.api.getProfile().games,1);assert.equal(reopened.api.getProfile().pendingResults.length,0);
});
test('a conflict fences profile and game writes; explicit cloud acceptance archives and reloads the whole branch', async t=>{
  const server=service();server.seed(A);const first=await boot(t,server),second=await boot(t,server),game=monopolyFixture();
  first.api.updateProfile({balance:9300});assert(first.window.VEZDEHOT_GAME_STORE.save('monopoly',A,game).ok);second.api.updateProfile({balance:8700});second.api.recordResult(result('local-branch-only',50));
  await first.api.sync();await second.api.sync();assert.equal(second.api.checkpointStatus().phase,'conflict');const local=plain(second.api.getProfile());
  assert.equal(second.api.updateProfile({balance:1}).ok,false);assert.equal(second.api.recordResult(result('blocked-conflict')).ok,false);assert.equal(second.window.VEZDEHOT_GAME_STORE.save('monopoly',A,game).ok,false);
  assert.deepEqual(plain(second.api.getProfile()),local);const exported=second.api.exportLocalCheckpoint();assert.equal(exported.profile.balance,8750);assert.equal(exported.games.monopoly,null);
  assert.equal(await second.api.acceptCloud(),true);assert.equal(second.api.getProfile().balance,9300);assert.equal(second.api.getProfile().pendingResults.length,0);assert(second.navigation.includes('reload'));
  const archives=[...second.storage].filter(([key])=>key.startsWith(metaKey(A)+':archive:'));assert.equal(archives.length,1);const archived=JSON.parse(archives[0][1]);assert.equal(archived.snapshot.profile.balance,8750);assert.equal(archived.pendingResults[0].id,'local-branch-only');
  const restored=second.window.VEZDEHOT_GAME_STORE.peek('monopoly',A).state;assert.equal(restored.id,game.id);assert(restored.paused);assert.deepEqual(plain(restored.dice),game.dice);
});
test('partial import remains blocked until explicit retry installs the complete journal', async t=>{
  const server=service();server.seed(A);const first=await boot(t,server),second=await boot(t,server);first.api.updateProfile({balance:9100});second.api.updateProfile({balance:8300});await first.api.sync();await second.api.sync();
  second.controls.failWrite=key=>key===gameKey(A,'poker');assert.equal(await second.api.acceptCloud(),false);assert.equal(second.api.checkpointStatus().phase,'importing');assert(second.storage.get(metaKey(A)+':import'));
  assert.equal(second.api.updateProfile({balance:1}).ok,false);assert.equal(second.api.recordResult(result('partial-import')).ok,false);assert.equal(second.api.getProfile().balance,8300);
  second.controls.failWrite=()=>false;assert.equal(await second.api.retryImport(),true);assert.equal(second.api.getProfile().balance,9100);assert.equal(JSON.parse(second.storage.get(metaKey(A)+':import')),null);assert(second.navigation.includes('reload'));
});
test('account activation supersedes an older bootstrap response without writing its profile into the new account', async t=>{
  const server=service();server.seed(A,snapshot({...baseProfile(),nick:'Account A',balance:11000}));server.seed(B,snapshot({...baseProfile(),nick:'Account B',balance:22000}));
  const gate=server.hold(A,'load_player_checkpoint'),h=device(server);t.after(()=>h.close());await tick();assert(gate.request);h.auth(B);await h.runTimers(0);await tick();
  gate.finish();await h.api.ready;assert.equal(h.api.scopeKey(),B);assert.equal(h.api.getProfile().nick,'Account B');assert.equal(h.api.getProfile().balance,22000);assert.equal(JSON.parse(h.storage.get(profileKey(B))).nick,'Account B');assert.deepEqual(h.fromCalls,[]);
});
test('raw ownership loss suppresses delayed bootstrap and acknowledgement writes even before a lifecycle event', async t=>{
  const server=service();server.seed(A,snapshot({...baseProfile(),balance:13000}));const readGate=server.hold(A,'load_player_checkpoint'),reading=device(server);t.after(()=>reading.close());await tick();assert(readGate.request);
  reading.setOwned(false);const before=plain(reading.api.getProfile()),writes=reading.writes.length;readGate.finish();await reading.api.ready;assert.deepEqual(plain(reading.api.getProfile()),before);assert.equal(reading.writes.length,writes);
  const h=await boot(t,server);h.api.recordResult(result('late-ack'));const gate=server.hold(A,'commit_player_checkpoint',{apply:true}),sending=h.api.sync();await tick();assert(gate.request);
  h.setOwned(false);const pending=plain(h.api.getProfile()),count=h.writes.length;gate.finish();await sending;assert.deepEqual(plain(h.api.getProfile()),pending);assert.equal(h.writes.length,count);assert.equal(h.api.recordResult(result('stale-write')).ok,false);
});

test('guest play has no cloud outbox or 500-result limit, including after reload', async t=>{
  const server=service(),h=await boot(t,server,{id:null});
  for(let i=0;i<520;i++)assert.equal(h.api.recordResult(result('guest-many-'+i,1)).ok,true,'guest result '+i);
  const profile=h.api.getProfile();assert.equal(profile.games,520);assert.equal(profile.balance,10520);assert.equal(profile.pendingResults.length,0);
  assert.equal(JSON.parse(h.storage.get(profileKey('guest'))).pendingResults.length,0);assert.equal(server.requests.length,0);
  h.close();const reopened=await boot(t,server,{id:null,storage:h.storage});assert.equal(reopened.api.recordResult(result('guest-after-reload',1)).ok,true);
  assert.equal(reopened.api.getProfile().games,521);assert.equal(reopened.api.getProfile().pendingResults.length,0);assert.equal(server.requests.length,0);
});
test('a guest snapshot created by the interim client sheds its stale cloud queue without changing credits', async t=>{
  const old={...baseProfile(),balance:10501,games:501,wins:501,xp:501,pendingResults:Array.from({length:501},(_,i)=>({id:'old-guest-'+i,game:'mafia',win:true,delta:1,xp:1,at:'2026-10-23T12:00:00.000Z'}))};
  old.history=old.pendingResults.slice(-30).reverse();old.resultIds=old.pendingResults.map(entry=>entry.id);
  const storage=new Map([[profileKey('guest'),JSON.stringify(old)]]),server=service(),h=await boot(t,server,{id:null,storage});
  assert.equal(h.api.getProfile().balance,10501);assert.equal(h.api.getProfile().games,501);assert.equal(h.api.getProfile().pendingResults.length,0);
  assert.equal(h.api.recordResult(result('next-local',1)).ok,true);assert.equal(h.api.getProfile().balance,10502);assert.equal(server.requests.length,0);
});
test('explicit guest profile import queues its retained history only in the empty signed-in account', async t=>{
  const server=service(),guest=await boot(t,server,{id:null});guest.api.recordResult(result('guest-import-result',125));guest.close();
  guest.storage.set('vezdehot:active',JSON.stringify(A));const account=await boot(t,server,{storage:guest.storage});assert.equal(account.api.canImportGuest(),true);
  assert.equal(account.api.importGuest(),true);assert.equal(account.api.getProfile().balance,10125);assert.deepEqual(plain(account.api.getProfile().pendingResults.map(entry=>entry.id)),['guest-import-result']);
  await account.api.sync();assert.equal(server.account(A).completed.has('guest-import-result'),true);assert.equal(server.account(A).snapshot.profile.balance,10125);
  assert.equal(JSON.parse(guest.storage.get(profileKey('guest'))).pendingResults.length,0);assert.equal(account.api.canImportGuest(),false);
});


test('a missing SDK or failed session read offers refresh instead of an endless account loading state', async t=>{
  for(const options of [{noSdk:true},{sessionError:true}]){
    const original={...baseProfile(),nick:'Saved account',balance:8500,revision:4,pendingResults:[]},storage=new Map([[profileKey(A),JSON.stringify(original)]]),server=service(),h=await boot(t,server,{...options,storage});
    assert.equal(h.api.checkpointStatus().phase,'invalid');assert.match(h.api.checkpointStatus().message,/обнови страницу/);
    assert.equal(h.api.getProfile().balance,8500);assert.equal(h.api.updateProfile({balance:1}).ok,false);assert.equal(server.requests.length,0);
    assert.equal(JSON.parse(storage.get(profileKey(A))).balance,8500);
  }
});
