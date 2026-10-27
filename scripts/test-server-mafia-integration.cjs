// Real browser controller, Edge handler, canonical Mafia engine and PostgreSQL.
// Disposable fixture identities and in-memory transport only; never calls production.
'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {PGlite}=require(process.argv[2]||'@electric-sql/pglite');
const root=path.resolve(__dirname,'..'),uid='b8251612-ec2e-445a-a768-c330645916a4';
const token='Bearer isolated-mafia-integration-token',origin='https://vezdehot.vercel.app';
const copy=x=>structuredClone(x),rng=n=>()=>((n=(Math.imul(n,1664525)+1013904223)>>>0)/2**32);
const nextAction=g=>g.legal.actions.includes('finish')?{type:'finish'}:['night','vote'].includes(g.phase)?{type:g.phase,...(g.legal.targets.length?{target:g.legal.targets[0]}:{})}:{type:'continue'};
(async()=>{
 const db=new PGlite();
 try {
  await db.exec('create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users(id uuid primary key);');
  for(const suffix of ['server_durak_actions','server_poker_actions','server_wallet','server_bunker_actions','server_mafia_actions']){
   const files=fs.readdirSync(path.join(root,'supabase/migrations')).filter(n=>n.endsWith('_'+suffix+'.sql'));assert.equal(files.length,1,'Migration '+suffix);
   await db.exec(fs.readFileSync(path.join(root,'supabase/migrations',files[0]),'utf8'));
  }
  await db.query('insert into auth.users(id) values ($1)',[uid]);
  const definitions={server_mafia_read:[['p_user_id','uuid'],['p_action_id','uuid'],['p_request','jsonb']],server_mafia_commit:[['p_user_id','uuid'],['p_expected_revision','bigint'],['p_action_id','uuid'],['p_request','jsonb'],['p_state','jsonb'],['p_response','jsonb']],server_wallet_read:[['p_user_id','uuid']]};
  let loseReply=false,random=rng(1);const calls=[];
  async function fetcher(url,options){
   const route=new URL(url).pathname;
   if(route==='/auth/v1/user'){assert.equal(options.headers.Authorization,token);return Response.json({id:uid,is_anonymous:false,user_metadata:{name:'Integration fixture'}});}
   const name=route.split('/').at(-1),definition=definitions[name],body=JSON.parse(options.body);assert(definition);assert.equal(body.p_user_id,uid);calls.push({name,body:copy(body)});
   let value;
   try {
    await db.exec('begin; set local role service_role;');
    const values=definition.map(([key,type])=>body[key]==null?null:type==='jsonb'?JSON.stringify(body[key]):body[key]);
    value=(await db.query('select public.'+name+'('+definition.map(([,type],i)=>'$'+(i+1)+'::'+type).join(',')+') as value',values)).rows[0].value;
    await db.exec('commit;');
   }catch(error){await db.exec('rollback;');return Response.json({code:error.code,message:error.message},{status:400});}
   if(name==='server_mafia_commit'&&loseReply){loseReply=false;throw Error('Lost response after successful commit');}
   return Response.json(value);
  }
  const env=key=>({SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'isolated-test-secret'}[key]);
  const {createHandler}=await import('../supabase/functions/server-mafia/index.ts');
  const {createGame,applyAction,projectGame}=await import('../supabase/functions/server-mafia/engine.mjs');
  const {createHandler:walletHandler}=await import('../supabase/functions/server-wallet/index.ts');
  const handler=createHandler({env,fetch:fetcher,random:()=>random()}),wallet=walletHandler({env,fetch:fetcher});
  async function request(body,handle=handler){const r=await handle(new Request('https://fixture.supabase.co/functions/v1/test',{method:'POST',headers:{origin,authorization:token,'content-type':'application/json'},body:JSON.stringify(body)}));return {ok:r.ok,status:r.status,data:await r.json()};}
  async function balance(){const r=await request({op:'load'},wallet);assert.equal(r.status,200,JSON.stringify(r.data));return r.data.wallet;}
  const context={window:{},document:{getElementById:()=>null},crypto,Date,Math,JSON,Number,Map,Set,structuredClone,setTimeout,clearTimeout};
  vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(root,'dist/server-mafia.js'),'utf8'),context);
  const makeController=context.window.VEZDEHOT_SERVER_MAFIA.createController;
  const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  const controller=()=>makeController({scope:uid,current:()=>true,storage,uuid:()=>crypto.randomUUID(),request});
  const mutation=(current,action)=>({op:'action',actionId:crypto.randomUUID(),expectedRevision:current.revision,gameId:current.game.id,action});

  // Select reproducible deals by running the same canonical engine in isolation.
  // Live requests below still traverse Auth, Edge, PostgreSQL and projection.
  let detectiveSeed=null;const outcomeSeeds={},spectatorSeeds={},roleSeeds={};
  for(let seed=1;seed<=2000&&(!detectiveSeed||!outcomeSeeds.win||!outcomeSeeds.loss||!spectatorSeeds.win||!spectatorSeeds.loss||!roleSeeds.mafia||!roleSeeds.doctor);seed++){
   const source=rng(seed);let g=createGame({id:crypto.randomUUID(),stake:100},source);roleSeeds[g.players[0].role]??=seed;
   if(g.players[0].role==='detective'&&!detectiveSeed){const dawn=applyAction(g,nextAction(projectGame(g)),source);if(dawn.players[0].alive)detectiveSeed=seed;}
   // A fresh random stream ensures searching for a detective does not alter the trace.
   const simulation=rng(seed);g=createGame({id:crypto.randomUUID(),stake:100},simulation);let observed=false;
   for(let step=0;!g.over&&step<130;step++){const p=projectGame(g);if(!p.players[0].alive)observed=true;g=applyAction(g,nextAction(p),simulation);}
   assert(g.over,'Bounded simulation reaches final result');
   outcomeSeeds[g.economy.outcome]??=seed;if(observed)spectatorSeeds[g.economy.outcome]??=seed;
  }
  assert(detectiveSeed&&outcomeSeeds.win&&outcomeSeeds.loss&&spectatorSeeds.win&&spectatorSeeds.loss,'Seed fixtures cover detective and observer team outcomes');

  async function privacy(state){
   if(!state.game)return;
   const stored=(await db.query('select state from vezdehot_private.server_mafia_games where user_id=$1',[uid])).rows[0].state,g=state.game;
   assert.deepEqual(g,projectGame(stored),'PostgreSQL JSONB order round-trips through the actual engine projection');
   for(const p of g.players){const privatePlayer=stored.players[p.id],allowed=p.id===0||!p.alive||g.over||stored.players[0].role==='mafia'&&privatePlayer.role==='mafia';assert.equal(p.role,allowed?privatePlayer.role:null);assert.deepEqual(Object.keys(p).sort(),['alive','id','kind','name','role']);}
   assert.deepEqual(g.knowledge,stored.players[0].role==='detective'?stored.knowledge[0]||{}:{});
   for(const field of ['nightTarget','dayTarget','lastDoctorTarget','revealed','publicSuspicion','diff'])assert.equal(Object.hasOwn(g,field),false);
   assert.deepEqual(g.privateNotes,stored.privateNotes);
  }
  let c=controller();assert(await c.load());assert.equal((await balance()).balance,1000);
  random=rng(detectiveSeed);loseReply=true;assert.equal(await c.start('normal',100),false);assert(c.status().pending);assert.equal((await balance()).balance,900);const pending=JSON.parse([...values.values()][0]);
  c.destroy();c=controller();assert(await c.load());assert.equal(c.status().pending,false);assert.equal(values.size,0);assert.equal((await balance()).balance,900);
  assert.equal(calls.filter(x=>x.name==='server_mafia_commit'&&x.body.p_action_id===pending.actionId).length,1);await privacy(c.status());
  console.log('PASS lost paid-entry reply + controller reload causes exactly one debit');

  const beforeNight=c.status(),nightAction=nextAction(beforeNight.game);assert.equal(beforeNight.game.players[0].role,'detective');
  loseReply=true;assert.equal(await c.act(nightAction),false);assert(c.status().pending);const lostNight=JSON.parse([...values.values()][0]);
  c.destroy();c=controller();assert(await c.load());let current=c.status();assert.equal(current.revision,beforeNight.revision+1);assert.equal(current.game.phase,'dawn');assert.equal(current.game.privateNotes.length,1);assert.equal(Object.keys(current.game.knowledge).length,1);await privacy(current);
  assert.equal(calls.filter(x=>x.name==='server_mafia_commit'&&x.body.p_action_id===lostNight.actionId).length,1);
  const reused=await request({...lostNight,action:{type:'mark',target:2,mark:'trust'}});assert.equal(reused.status,409);assert.equal((await request({op:'load'})).data.revision,current.revision);
  const stale=await request(mutation(beforeNight,nightAction));assert.equal(stale.data.status,'conflict');assert.equal(stale.data.revision,current.revision);
  assert(await c.act({type:'mark',target:1,mark:'suspect'}));c.destroy();c=controller();assert(await c.load());assert.equal(c.status().game.personalMarks[1],'suspect');
  assert(await c.act({type:'continue'}));assert(await c.act({type:'continue'}));const beforeVote=c.status();assert.equal(beforeVote.game.phase,'vote');
  loseReply=true;assert.equal(await c.act(nextAction(beforeVote.game)),false);assert(c.status().pending);const lostVote=JSON.parse([...values.values()][0]);
  c.destroy();c=controller();assert(await c.load());current=c.status();assert.equal(current.revision,beforeVote.revision+1);assert.equal(current.game.voteHistory.length,1);assert.equal(new Set(current.game.ballots.map(b=>b.voter)).size,current.game.ballots.length);await privacy(current);
  assert.equal(calls.filter(x=>x.name==='server_mafia_commit'&&x.body.p_action_id===lostVote.actionId).length,1);
  console.log('PASS atomic night and vote recover once; stale device conflicts; detective notes and personal marks survive JSONB reload');
  c.destroy();

  async function step(state,action){
   const body=mutation(state,action),r=await request(body);assert.equal(r.status,200,JSON.stringify({action,error:r.data}));assert.equal(r.data.status,'saved');
   const repeated=await request(body);assert.deepEqual(repeated.data,r.data,'Receipt replay is identical');await privacy(r.data);return r.data;
  }
  async function finish(state){
   let spectator=false;
   for(let count=0;!state.game.over&&count<130;count++){const action=nextAction(state.game);if(action.type==='finish')spectator=true;state=await step(state,action);}
   assert(state.game.over);return {state,spectator};
  }
  const settled=[];
  function expected(e){return e.stake?({win:[250,130],loss:[0,25],draw:[100,40],resigned:[0,0]}[e.outcome]):[0,0];}
  async function verifySettlement(before,state){
   const e=state.game.economy,[payout,xp]=expected(e),after=await balance();assert.equal(e.payout,payout);assert.equal(e.xp,xp);
   assert.equal(after.balance,before.balance+payout);assert.equal(after.xp,before.xp+xp);assert.equal(after.games,before.games+(e.stake?1:0));assert.equal(after.wins,before.wins+(e.stake&&e.outcome==='win'?1:0));
   if(e.stake){assert.equal(after.revision,before.revision+1);settled.push(state.game.id);}else assert.equal(after.revision,before.revision);
   return after;
  }
  const firstWallet=await balance();current=(await finish(current)).state;await verifySettlement(firstWallet,current);
  async function start(seed,stake=100,difficulty='normal'){
   if(stake&&(await balance()).balance<100)await db.query('update vezdehot_private.server_wallets set balance=1000 where user_id=$1',[uid]);
   const before=await balance();random=rng(seed);const r=await request({op:'start',actionId:crypto.randomUUID(),expectedRevision:current.revision,difficulty,stake});assert.equal(r.status,200,JSON.stringify(r.data));current=r.data;await privacy(current);
   const after=await balance();assert.equal(after.balance,before.balance-stake);assert.equal(after.games,before.games);assert.equal(after.xp,before.xp);return after;
  }
  for(const outcome of ['win','loss']){
   const before=await start(spectatorSeeds[outcome]);const completed=await finish(current);current=completed.state;assert(completed.spectator,'Fixture includes observer finish');assert.equal(current.game.economy.outcome,outcome);assert.equal(current.game.players[0].alive,false);await verifySettlement(before,current);
  }
  console.log('PASS eliminated player can finish observation and receive actual team win/loss; SQL pays 250/130 XP or 0/25 XP once');

  const beforeResign=await start(detectiveSeed);current=await step(current,{type:'resign'});assert.equal(current.game.economy.outcome,'resigned');await verifySettlement(beforeResign,current);
  const beforeFree=await start(spectatorSeeds.win,0,'hard');current=(await finish(current)).state;await verifySettlement(beforeFree,current);
  const counts=(await db.query("select table_id,kind,count(*)::int n from vezdehot_private.server_wallet_ledger where user_id=$1 and game='mafia' group by table_id,kind",[uid])).rows;assert(counts.every(x=>x.n===1));assert.equal(counts.length,settled.length*2);
  const freeLedger=(await db.query('select count(*)::int n from vezdehot_private.server_wallet_ledger where table_id=$1',[current.game.id])).rows[0].n;assert.equal(freeLedger,0);
  console.log('PASS voluntary exit pays no XP; free full game leaves balance, XP, statistics and wallet revision unchanged');
  for(const role of ['doctor','mafia']){
   const before=await start(roleSeeds[role],0,'normal');assert.equal(current.game.players[0].role,role);
   if(role==='doctor'){assert(current.game.legal.targets.includes(0));current=await step(current,{type:'night',target:0});}
   else assert.equal(current.game.players.filter(p=>p.role==='mafia').length,2,'Mafia sees only their own ally');
   current=(await finish(current)).state;await verifySettlement(before,current);
  }
  console.log('PASS doctor self-protection and Mafia ally visibility complete through real SQL with zero-cost settlement');
  console.log('PASS all persisted public DTOs hide live opponents, private bot knowledge and night targets; finished roles remain reviewable');
 }finally{await db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
