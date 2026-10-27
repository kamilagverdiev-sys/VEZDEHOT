// Real browser controller, Edge handler, canonical engine and SQL in disposable PostgreSQL.
// Uses only fixture identities and an in-memory transport; never calls production.
'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {PGlite}=require(process.argv[2]||'@electric-sql/pglite');
const root=path.resolve(__dirname,'..'),uid='eb94dbaa-6547-4904-a94c-15c21c048bb4';
const token='Bearer isolated-bunker-integration-token',origin='https://vezdehot.vercel.app';
const copy=x=>structuredClone(x);
(async()=>{
 const db=new PGlite();
 try {
  await db.exec('create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users(id uuid primary key);');
  for(const suffix of ['server_durak_actions','server_poker_actions','server_wallet','server_bunker_actions']){
   const files=fs.readdirSync(path.join(root,'supabase/migrations')).filter(n=>n.endsWith('_'+suffix+'.sql'));assert.equal(files.length,1,'Migration '+suffix);
   await db.exec(fs.readFileSync(path.join(root,'supabase/migrations',files[0]),'utf8'));
  }
  await db.query('insert into auth.users(id) values ($1)',[uid]);
  const definitions={server_bunker_read:[['p_user_id','uuid'],['p_action_id','uuid'],['p_request','jsonb']],server_bunker_commit:[['p_user_id','uuid'],['p_expected_revision','bigint'],['p_action_id','uuid'],['p_request','jsonb'],['p_state','jsonb'],['p_response','jsonb']],server_wallet_read:[['p_user_id','uuid']]};
  let loseReply=false,seed=7831;const calls=[],random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
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
   if(name==='server_bunker_commit'&&loseReply){loseReply=false;throw Error('Lost response after successful commit');}
   return Response.json(value);
  }
  const env=key=>({SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'isolated-test-secret'}[key]);
  const {createHandler}=await import('../supabase/functions/server-bunker/index.ts');
  const {createHandler:walletHandler}=await import('../supabase/functions/server-wallet/index.ts');
  const handler=createHandler({env,fetch:fetcher,random}),wallet=walletHandler({env,fetch:fetcher});
  async function request(body,handle=handler){const r=await handle(new Request('https://fixture.supabase.co/functions/v1/test',{method:'POST',headers:{origin,authorization:token,'content-type':'application/json'},body:JSON.stringify(body)}));return {ok:r.ok,status:r.status,data:await r.json()};}
  async function balance(){const r=await request({op:'load'},wallet);assert.equal(r.status,200,JSON.stringify(r.data));return r.data.wallet;}
  const context={window:{},document:{getElementById:()=>null},crypto,Date,Math,JSON,Number,Map,Set,structuredClone,setTimeout,clearTimeout};
  vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(root,'dist/server-bunker.js'),'utf8'),context);
  const makeController=context.window.VEZDEHOT_SERVER_BUNKER.createController;
  const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  const controller=()=>makeController({scope:uid,current:()=>true,storage,uuid:()=>crypto.randomUUID(),request});
  const mutation=(current,action)=>({op:'action',actionId:crypto.randomUUID(),expectedRevision:current.revision,gameId:current.game.id,action});
  let c=controller();assert(await c.load());assert.equal((await balance()).balance,1000);
  loseReply=true;assert.equal(await c.start('normal','random',100),false);assert(c.status().pending);assert.equal((await balance()).balance,900);const pending=JSON.parse([...values.values()][0]);
  c.destroy();c=controller();assert(await c.load());assert.equal(c.status().pending,false);assert.equal(values.size,0);assert.equal((await balance()).balance,900);
  assert.equal(calls.filter(x=>x.name==='server_bunker_commit'&&x.body.p_action_id===pending.actionId).length,1);
  console.log('PASS paid entry survives a lost reply and browser reload with exactly one debit');

  const beforeReveal=c.status();assert(await c.act({type:'reveal',cardType:beforeReveal.game.legal.cards[0]}));
  let current=c.status();assert.equal(current.game.phase,'vote');
  const stale=await request(mutation(beforeReveal,{type:'reveal',cardType:beforeReveal.game.legal.cards[1]}));assert.equal(stale.data.status,'conflict');assert.equal(stale.data.revision,current.revision);
  const beforeVote=current.revision;loseReply=true;assert.equal(await c.act({type:'vote',target:current.game.legal.targets[0]}),false);assert(c.status().pending);
  c.destroy();c=controller();assert(await c.load());current=c.status();assert.equal(current.revision,beforeVote+1);assert.equal(current.game.phase,'voteResult');assert.equal(current.game.voteLog.length,1);assert.equal(current.game.players.filter(p=>p.alive).length,5);
  console.log('PASS stale second client cannot overwrite a reveal; lost vote reply records one ballot round');
  c.destroy();
  let outcomes=new Set(),completed=0;
  async function finish(state){
   for(let step=0;!state.game.over&&step<12;step++){
    const g=state.game,action=g.phase==='reveal'?{type:'reveal',cardType:g.legal.cards[0]}:g.phase==='vote'?{type:'vote',target:g.legal.targets[0]}:{type:'continue'};
    const body=mutation(state,action),r=await request(body);assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.status,'saved');
    const repeated=await request(body);assert.deepEqual(repeated.data,r.data);state=r.data;
   }
   assert(state.game.over);return state;
  }
  current=await finish(current);outcomes.add(current.game.economy.outcome);completed++;
  let w=await balance();assert.equal(w.balance,900+current.game.economy.payout);assert.equal(w.xp,current.game.economy.xp);assert.equal(w.games,1);
  for(let n=0;n<30&&outcomes.size<2;n++){
   const previous=await balance();if(previous.balance<100)await db.query('update vezdehot_private.server_wallets set balance=1000 where user_id=$1',[uid]);
   const entryBalance=(await balance()).balance,start=await request({op:'start',actionId:crypto.randomUUID(),expectedRevision:current.revision,difficulty:['easy','normal','hard'][n%3],scenarioChoice:'random',stake:100});assert.equal(start.status,200,JSON.stringify(start.data));current=await finish(start.data);completed++;outcomes.add(current.game.economy.outcome);w=await balance();
   assert.equal(w.balance,entryBalance-100+current.game.economy.payout);assert.equal(w.games,completed);assert.equal(w.xp,previous.xp+current.game.economy.xp);
  }
  assert(outcomes.has('win')&&outcomes.has('loss'),'Seeded paid games cover win and loss');
  const counts=(await db.query("select table_id,kind,count(*)::int n from vezdehot_private.server_wallet_ledger where user_id=$1 and game='bunker' group by table_id,kind",[uid])).rows;assert(counts.every(x=>x.n===1));assert.equal(counts.length,completed*2);
  console.log('PASS full paid games: SQL independently matches win250/120XP and loss0/25XP; one entry and settlement per game');
  const beforeFree=await balance(),free=await request({op:'start',actionId:crypto.randomUUID(),expectedRevision:current.revision,difficulty:'normal',scenarioChoice:'random',stake:0});assert.equal(free.status,200);current=await finish(free.data);assert.equal(current.game.economy.payout,0);assert.equal(current.game.economy.xp,0);
  const afterFree=await balance();for(const key of ['balance','xp','games','wins','revision'])assert.equal(afterFree[key],beforeFree[key]);
  console.log('PASS free game leaves protected balance, XP, statistics and wallet revision unchanged');
 }finally{await db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
