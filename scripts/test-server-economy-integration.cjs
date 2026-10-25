// Real Edge handlers + real engines + real SQL, in a disposable local PGlite DB.
// No network, production credentials, or real account data are used.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {PGlite}=require(process.argv[2]||'@electric-sql/pglite');
const ROOT=path.resolve(__dirname,'..'),uid='bd896f9d-5614-48f8-909a-8083c2db1f24';
const token='Bearer isolated-economy-integration-token',origin='https://vezdehot.vercel.app';
const clone=x=>structuredClone(x);
function client(kind){const ctx={window:{},document:{getElementById:()=>null},crypto,Date,Math,JSON,Number,Map,Set,structuredClone,setTimeout,clearTimeout};vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(ROOT,'dist/server-'+kind+'.js'),'utf8'),ctx);return ctx.window['VEZDEHOT_SERVER_'+kind.toUpperCase()].createController;}
(async()=>{
 const db=new PGlite();
 try{
  await db.exec('create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);');
  for(const name of ['20261025091820_server_durak_actions.sql','20261025094046_server_poker_actions.sql','20261025110000_server_wallet.sql'])await db.exec(fs.readFileSync(path.join(ROOT,'supabase/migrations',name),'utf8'));
  await db.query('insert into auth.users(id) values($1)',[uid]);
  let loseCommit=null;const calls=[];
  const definitions={
   server_wallet_read:[['p_user_id','uuid']],server_wallet_claim:[['p_user_id','uuid'],['p_action_id','uuid'],['p_request','jsonb']],
   server_durak_read:[['p_user_id','uuid'],['p_action_id','uuid'],['p_request','jsonb']],server_poker_read:[['p_user_id','uuid'],['p_action_id','uuid'],['p_request','jsonb']],
   server_durak_commit:[['p_user_id','uuid'],['p_expected_revision','bigint'],['p_action_id','uuid'],['p_request','jsonb'],['p_state','jsonb'],['p_response','jsonb']],
   server_poker_commit:[['p_user_id','uuid'],['p_expected_revision','bigint'],['p_action_id','uuid'],['p_request','jsonb'],['p_state','jsonb'],['p_response','jsonb']],
  };
  async function fetcher(url,options){
   const route=new URL(url).pathname;
   if(route==='/auth/v1/user'){assert.equal(options.headers.Authorization,token);return Response.json({id:uid,is_anonymous:false,user_metadata:{name:'SQL Fixture'}});}
   const name=route.split('/').at(-1),definition=definitions[name],body=JSON.parse(options.body);assert(definition,'Unexpected route');assert.equal(body.p_user_id,uid);calls.push({name,body:clone(body)});
   let value;
   try{await db.exec('begin;set local role service_role;');const params=definition.map(([key,type])=>body[key]===null||body[key]===undefined?null:type==='jsonb'?JSON.stringify(body[key]):body[key]);const query='select public.'+name+'('+definition.map(([,type],i)=>'$'+(i+1)+'::'+type).join(',')+') as value';value=(await db.query(query,params)).rows[0].value;await db.exec('commit;');}
   catch(error){await db.exec('rollback;');return Response.json({code:error.code,message:error.message},{status:400});}
   if(loseCommit===name){loseCommit=null;throw Error('Local fixture lost reply after SQL COMMIT');}
   return Response.json(value);
  }
  let seed=73519;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32),handlers={};
  for(const kind of ['durak','poker','wallet']){const {createHandler}=await import('../supabase/functions/server-'+kind+'/index.ts');handlers[kind]=createHandler({fetch:fetcher,env:key=>({SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'isolated-fixture-secret'}[key]),random});}
  async function request(kind,body){const response=await handlers[kind](new Request('https://fixture.supabase.co/functions/v1/server-'+kind,{method:'POST',headers:{origin,authorization:token,'content-type':'application/json'},body:JSON.stringify(body)}));return{ok:response.ok,status:response.status,data:await response.json()};}
  async function wallet(){const result=await request('wallet',{op:'load'});assert.equal(result.status,200,JSON.stringify(result.data));return result.data.wallet;}
  const mutate=(state,type,extra={})=>({op:'action',actionId:crypto.randomUUID(),expectedRevision:state.revision,gameId:state.game.id,action:{type,...extra}});
  let w=await wallet();assert.equal(w.balance,1000);assert.equal((await wallet()).revision,w.revision);assert.equal(w.history.filter(e=>e.kind==='welcome').length,1);
  const claim={op:'claimDaily',actionId:crypto.randomUUID()},cooldown=await request('wallet',claim);assert.equal(cooldown.data.status,'cooldown');assert.deepEqual(await request('wallet',claim),cooldown);assert.equal((await wallet()).balance,1000);
  console.log('PASS real wallet Edge/SQL: one welcome grant, database cooldown and permanent receipt');

  const storage=new Map(),store={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
  const makeController=()=>client('durak')({scope:uid,current:()=>true,storage:store,uuid:()=>crypto.randomUUID(),request:body=>request('durak',body)});
  let controller=makeController();assert.equal(await controller.load(),true);loseCommit='server_durak_commit';assert.equal(await controller.start(1,'normal',100),false);assert.equal(controller.status().pending,true);assert.equal((await wallet()).balance,900);const pending=[...storage.values()][0];controller.destroy();controller=makeController();assert.equal(await controller.load(),true);assert.equal(controller.status().pending,false);assert.equal(storage.size,0);assert.equal((await wallet()).balance,900);const savedStart=JSON.parse(pending);assert.equal(calls.filter(c=>c.name==='server_durak_commit'&&c.body.p_action_id===savedStart.actionId).length,1);
  assert.equal(await controller.act({type:'resign'}),true);w=await wallet();assert.equal(w.balance,900);assert.equal(w.games,1);assert.equal(w.xp,0);assert.equal(w.history.filter(e=>e.kind==='settlement').length,1);controller.destroy();
  console.log('PASS real Durak client/Edge/SQL: lost paid-start reply, reload, same request, single debit and resignation settlement');

  let state=(await request('durak',{op:'load'})).data;
  const started=await request('durak',{op:'start',actionId:crypto.randomUUID(),expectedRevision:state.revision,bots:2,difficulty:'normal',stake:100});assert.equal(started.status,200,JSON.stringify(started.data));state=started.data;
  for(let i=0;!state.game.over&&i<600;i++){
   const legal=state.game.legal;let type,extra={};
   if(legal.actions.includes('defend')){type='defend';extra.cardId=legal.cards[0];}else if(legal.actions.includes('attack')){type='attack';extra.cardId=legal.cards[0];}else if(legal.actions.includes('finish'))type='finish';else if(legal.actions.includes('take'))type='take';else type='continue';
   const result=await request('durak',mutate(state,type,extra));assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.status,'saved');state=result.data;
  }
  assert(state.game.over,'Complete Durak game must terminate');assert.equal(state.game.economy.settled,true);w=await wallet();assert.equal(w.balance,800+state.game.economy.payout);assert.equal(w.xp,state.game.economy.xp);assert.equal(w.games,2);
  const entries=w.history.filter(e=>e.tableId===state.game.id);assert.equal(entries.filter(e=>e.kind==='entry').length,1);assert.equal(entries.filter(e=>e.kind==='settlement').length,1);
  console.log('PASS real Durak complete paid game: engine outcome matches SQL payout, XP and one settlement');

  const beforePoker=w.balance;let poker=await request('poker',{op:'start',actionId:crypto.randomUUID(),expectedRevision:0,difficulty:'normal',stake:100});assert.equal(poker.status,200,JSON.stringify(poker.data));state=poker.data;assert.equal((await wallet()).balance,beforePoker-100);
  const premature=await request('poker',mutate(state,'close'));assert.equal(premature.status,422);assert.equal((await wallet()).balance,beforePoker-100);
  async function finishHand(current){for(let i=0;!current.game.handOver&&i<100;i++){const actions=current.game.legal.actions,type=actions.includes('fold')?'fold':actions.includes('check')?'check':actions.includes('call')?'call':'continue';const result=await request('poker',mutate(current,type));assert.equal(result.status,200,JSON.stringify(result.data));current=result.data;}assert(current.game.handOver);return current;}
  state=await finishHand(state);const firstHand=state.game.handId;
  if(!state.game.over){const next=await request('poker',mutate(state,'nextHand'));assert.equal(next.status,200);state=next.data;assert.notEqual(state.game.handId,firstHand);assert.equal((await wallet()).balance,beforePoker-100);state=await finishHand(state);}
  if(!state.game.over){const cashout=Math.floor(state.game.players[0].chips/10),closeBody=mutate(state,'close'),closed=await request('poker',closeBody);assert.equal(closed.status,200,JSON.stringify(closed.data));state=closed.data;assert.equal(state.game.economy.payout,cashout);assert.deepEqual(await request('poker',closeBody),closed);}
  assert(state.game.over);w=await wallet();assert.equal(w.balance,beforePoker-100+state.game.economy.payout);assert.equal(w.games,3);assert.equal(w.history.filter(e=>e.tableId===state.game.id&&e.kind==='entry').length,1);assert.equal(w.history.filter(e=>e.tableId===state.game.id&&e.kind==='settlement').length,1);
  console.log('PASS real Poker Edge/engine/SQL: paid close restriction, continuous hands, one entry and current-stack cashout');
  console.log('PASS complete isolated server economy integration; disposable database closed');
 }finally{await db.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
