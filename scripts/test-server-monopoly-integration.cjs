// Real browser controller, Edge handler, canonical Monopoly engine and PostgreSQL.
// Disposable fixture identities and in-memory transport only; never calls production.
'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {PGlite}=require(process.argv[2]||'@electric-sql/pglite');
const root=path.resolve(__dirname,'..'),uid='6cc7dbe4-5cc4-4ed4-ab5f-6f2d5a91fd24';
const token='Bearer isolated-monopoly-integration-token',origin='https://vezdehot.vercel.app';
const copy=x=>structuredClone(x),rng=n=>()=>((n=(Math.imul(n,1664525)+1013904223)>>>0)/2**32);
const nextAction=g=>({type:g.phase==='ready'?'roll':g.phase==='buy'?'buy':'continue'});
(async()=>{
 const db=new PGlite();
 try {
  await db.exec('create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users(id uuid primary key);');
  for(const suffix of ['server_durak_actions','server_poker_actions','server_wallet','server_bunker_actions','server_mafia_actions','server_monopoly_actions']){
   const files=fs.readdirSync(path.join(root,'supabase/migrations')).filter(n=>n.endsWith('_'+suffix+'.sql'));assert.equal(files.length,1,'Migration '+suffix);
   await db.exec(fs.readFileSync(path.join(root,'supabase/migrations',files[0]),'utf8'));
  }
  await db.query('insert into auth.users(id) values ($1)',[uid]);
  const definitions={server_monopoly_read:[['p_user_id','uuid'],['p_action_id','uuid'],['p_request','jsonb']],server_monopoly_commit:[['p_user_id','uuid'],['p_expected_revision','bigint'],['p_action_id','uuid'],['p_request','jsonb'],['p_state','jsonb'],['p_response','jsonb']],server_wallet_read:[['p_user_id','uuid']]};
  let loseReply=false,random=rng(1),randomCalls=0;const calls=[];
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
   if(name==='server_monopoly_commit'&&loseReply){loseReply=false;throw Error('Lost response after successful commit');}
   return Response.json(value);
  }
  const env=key=>({SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'isolated-test-secret'}[key]);
  const {createHandler}=await import('../supabase/functions/server-monopoly/index.ts');
  const {createGame,applyAction,projectGame,assertIntegrity}=await import('../supabase/functions/server-monopoly/engine.mjs');
  const {createHandler:walletHandler}=await import('../supabase/functions/server-wallet/index.ts');
  const handler=createHandler({env,fetch:fetcher,random:()=>{randomCalls++;return random();}}),wallet=walletHandler({env,fetch:fetcher});
  async function request(body,handle=handler){const r=await handle(new Request('https://fixture.supabase.co/functions/v1/test',{method:'POST',headers:{origin,authorization:token,'content-type':'application/json'},body:JSON.stringify(body)}));return {ok:r.ok,status:r.status,data:await r.json()};}
  async function balance(){const r=await request({op:'load'},wallet);assert.equal(r.status,200,JSON.stringify(r.data));return r.data.wallet;}
  const context={window:{},document:{getElementById:()=>null},crypto,Date,Math,JSON,Number,Map,Set,structuredClone,setTimeout,clearTimeout};
  vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(root,'dist/server-monopoly.js'),'utf8'),context);
  const makeController=context.window.VEZDEHOT_SERVER_MONOPOLY.createController;
  const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  const controller=(deviceStorage=storage,onConfirmed)=>makeController({scope:uid,current:()=>true,storage:deviceStorage,uuid:()=>crypto.randomUUID(),request,onConfirmed});
  const mutation=(current,action)=>({op:'action',actionId:crypto.randomUUID(),expectedRevision:current.revision,gameId:current.game.id,action});
  const stored=async()=>(await db.query('select state from vezdehot_private.server_monopoly_games where user_id=$1',[uid])).rows[0].state,seen=new Set();
  async function projection(state){
   if(!state.game)return;
   const internal=await stored(),g=state.game;assertIntegrity(internal);
   assert.deepEqual(g,projectGame(internal),'PostgreSQL JSONB round-trips through the actual engine projection');
   assert.equal(g.players.reduce((sum,p)=>sum+p.money,0)+g.bank,6000,'Cash is conserved after every action');
   for(const p of g.players){assert.equal(p.capital,p.money+p.properties.reduce((sum,i)=>sum+g.board[i].price,0));for(const i of p.properties)assert.equal(g.board[i].owner,p.id);}
   for(const field of ['paused','pace','pendingSteps','stake'])assert.equal(Object.hasOwn(g,field),false,'Internal field is not projected: '+field);
   if(g.lastChance)seen.add('chance');if(g.lastRelocated)seen.add('relocation');if(g.lastPayment&&g.lastPayment.creditor!==null)seen.add('rent');
   if(g.ledger.some(e=>e.label==='прохождение Старта'))seen.add('start');if(g.journal.some(e=>e.text.includes('отдыхает и пропускает')))seen.add('rest');
  }
  const commitCount=id=>calls.filter(x=>x.name==='server_monopoly_commit'&&x.body.p_action_id===id).length;
  let c=controller();assert(await c.load());assert.equal((await balance()).balance,1000);
  loseReply=true;assert.equal(await c.start('normal',100),false);assert(c.status().pending);assert.equal((await balance()).balance,900);const pending=JSON.parse([...values.values()][0]);
  c.destroy();c=controller();assert(await c.load());assert.equal(c.status().pending,false);assert.equal(values.size,0);assert.equal((await balance()).balance,900);assert.equal(commitCount(pending.actionId),1);await projection(c.status());
  console.log('PASS lost paid entry + controller reload causes exactly one 100 V debit');

  const beforeRoll=c.status();loseReply=true;assert.equal(await c.act({type:'roll'}),false);assert(c.status().pending);
  const lostRoll=JSON.parse([...values.values()][0]),rolled=projectGame(await stored()),drawsAfterRoll=randomCalls;assert.equal(rolled.phase,'buy');
  c.destroy();c=controller();assert(await c.load());let current=c.status();assert.equal(current.revision,beforeRoll.revision+1);assert.deepEqual(copy(current.game),rolled);assert.equal(randomCalls,drawsAfterRoll,'A recovered roll must never reroll the dice');assert.equal(commitCount(lostRoll.actionId),1);await projection(current);
  const reused=await request({...lostRoll,action:{type:'resign'}});assert.equal(reused.status,409);assert.equal((await request({op:'load'})).data.revision,current.revision);
  const stale=await request(mutation(beforeRoll,{type:'roll'}));assert.equal(stale.data.status,'conflict');assert.equal(stale.data.revision,current.revision);assert.equal(randomCalls,drawsAfterRoll);
  console.log('PASS lost dice reply restores the identical result; request reuse and stale device cannot reroll');

  const beforeBuy=current,property=current.game.players[0].pos,price=current.game.board[property].price;loseReply=true;assert.equal(await c.act({type:'buy'}),false);
  const lostBuy=JSON.parse([...values.values()][0]);c.destroy();c=controller();assert(await c.load());current=c.status();await projection(current);
  assert.equal(current.revision,beforeBuy.revision+1);assert.equal(current.game.board[property].owner,0);assert.equal(current.game.players[0].money,beforeBuy.game.players[0].money-price);assert.equal(current.game.players[0].capital,beforeBuy.game.players[0].capital);assert.equal(current.game.bank,beforeBuy.game.bank+price);assert.equal(commitCount(lostBuy.actionId),1);
  const beforeBot=current;loseReply=true;assert.equal(await c.act({type:'continue'}),false);const lostBot=JSON.parse([...values.values()][0]),botResult=projectGame(await stored()),botDraws=randomCalls;
  c.destroy();c=controller();assert(await c.load());current=c.status();assert.equal(current.revision,beforeBot.revision+1);assert.equal(current.game.turnNumber,beforeBot.game.turnNumber+1);assert.equal(current.game.turn,1);assert.equal(current.game.phase,'review');assert.deepEqual(copy(current.game),botResult);assert.equal(randomCalls,botDraws);assert.equal(commitCount(lostBot.actionId),1);await projection(current);c.destroy();
  console.log('PASS lost purchase and bot-turn replies preserve one purchase, unchanged purchase capital, and one bot move');

  async function step(state,action){
   const body=mutation(state,action),r=await request(body);assert.equal(r.status,200,JSON.stringify({action,error:r.data}));assert.equal(r.data.status,'saved');
   const afterDraws=randomCalls,repeated=await request(body);assert.deepEqual(repeated.data,r.data,'Receipt replay is identical');assert.equal(randomCalls,afterDraws);await projection(r.data);return r.data;
  }
  async function finish(state,finalResign=false){for(let count=0;!state.game.over&&count<180;count++)state=await step(state,finalResign&&state.game.turnNumber===80&&state.game.phase==='review'?{type:'resign'}:nextAction(state.game));assert(state.game.over,'A complete game is bounded');return state;}
  const settled=[];
  async function verifySettlement(before,state){
   const e=state.game.economy,payout=e.stake&&e.outcome==='win'?250:0,xp=e.stake?(e.outcome==='win'?100:e.outcome==='loss'?25:0):0,after=await balance();
   assert.equal(e.payout,payout);assert.equal(e.xp,xp);assert.equal(after.balance,before.balance+payout);assert.equal(after.xp,before.xp+xp);assert.equal(after.games,before.games+(e.stake?1:0));assert.equal(after.wins,before.wins+(e.stake&&e.outcome==='win'?1:0));assert.equal(after.revision,before.revision+(e.stake?1:0));
   if(e.stake){settled.push(state.game.id);assert(after.history.some(x=>x.game==='monopoly'&&x.tableId===state.game.id&&x.kind==='settlement'&&x.delta===payout&&x.xp===xp),'Wallet restores the explicit Monopoly receipt');}
   else assert.equal((await db.query('select count(*)::int n from vezdehot_private.server_wallet_ledger where table_id=$1',[state.game.id])).rows[0].n,0);
   return after;
  }
  async function start(seed,stake=100,difficulty='normal'){
   if(stake&&(await balance()).balance<100)await db.query('update vezdehot_private.server_wallets set balance=1000 where user_id=$1',[uid]);
   const before=await balance();random=rng(seed);const r=await request({op:'start',actionId:crypto.randomUUID(),expectedRevision:current.revision,difficulty,stake});assert.equal(r.status,200,JSON.stringify(r.data));current=r.data;await projection(current);
   const after=await balance();assert.equal(after.balance,before.balance-stake);assert.equal(after.games,before.games);assert.equal(after.xp,before.xp);return after;
  }
  const firstWallet=await balance();current=await finish(current);assert.equal(current.game.finishKind,'capital');assert.equal(current.game.turnNumber,80);assert.equal(current.game.economy.outcome,'loss');await verifySettlement(firstWallet,current);
  // Find a win using the exact canonical engine rather than a hand-written result.
  let winSeed=null;
  for(let seed=1;seed<=30&&!winSeed;seed++){const source=rng(seed);let g=createGame({stake:100},source);for(let n=0;!g.over&&n<180;n++)g=applyAction(g,nextAction(g),source);assert(g.over);if(g.finishKind==='capital'&&g.economy.outcome==='win')winSeed=seed;}
  assert(winSeed,'Seeded fixture includes an 80-turn capital win');
  const beforeWin=await start(winSeed);
  for(let n=0;n<180&&!(current.game.turnNumber===80&&current.game.phase==='review');n++)current=await step(current,nextAction(current.game));
  assert.equal(current.game.turnNumber,80);assert.equal(current.game.phase,'review');assert.equal(current.game.over,false);
  const device=()=>{const records=new Map();return {records,getItem:k=>records.get(k)??null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)}};
  const deviceA=device(),deviceB=device();let confirmedA=0;
  const a=controller(deviceA,()=>confirmedA++),b=controller(deviceB);assert(await a.load());
  const beforeFinal=current,confirmationsBefore=confirmedA;
  // Even a stale exit request on the final review must settle the earned result.
  loseReply=true;assert.equal(await a.act({type:'resign'}),false);assert(a.status().pending);assert.equal(confirmedA,confirmationsBefore);
  const lostFinal=JSON.parse([...deviceA.records.values()][0]),drawsAtFinal=randomCalls;
  assert(await b.load());current=copy(b.status());assert.equal(current.revision,beforeFinal.revision+1);assert.equal(current.game.finishKind,'capital');assert.equal(current.game.economy.outcome,'win');assert.equal(current.game.resigned,false);await verifySettlement(beforeWin,current);
  const completedId=current.game.id,settledWallet=await balance();
  // Another independent browser starts a new paid table before A receives its old ACK.
  random=rng(1);assert(await b.start('normal',100));current=copy(b.status());const rematchId=current.game.id,rematchWallet=await balance();
  assert.notEqual(rematchId,completedId);assert.equal(current.game.over,false);assert.equal(rematchWallet.balance,settledWallet.balance-100);assert.equal(rematchWallet.games,settledWallet.games);assert.equal(rematchWallet.xp,settledWallet.xp);
  const drawsBeforeRetry=randomCalls;assert(drawsBeforeRetry>=drawsAtFinal);assert(await a.load());
  assert.equal(a.status().pending,false);assert.equal(deviceA.records.size,0);assert.equal(deviceB.records.size,0);assert.equal(a.status().revision,current.revision);assert.deepEqual(copy(a.status().game),current.game,'Old receipt must lead to the current rematch, never replace it with the finished table');assert(confirmedA>confirmationsBefore);
  assert.equal(randomCalls,drawsBeforeRetry,'Recovery never rolls or creates another table');assert.equal(commitCount(lostFinal.actionId),1);
  const walletAfterRetry=await balance();for(const field of ['balance','xp','games','wins','revision'])assert.equal(walletAfterRetry[field],rematchWallet[field]);
  const finalLedger=(await db.query("select kind,count(*)::int n from vezdehot_private.server_wallet_ledger where user_id=$1 and table_id=$2 group by kind",[uid,completedId])).rows;
  assert.equal(finalLedger.length,2);assert(finalLedger.every(row=>row.n===1));await projection(a.status());a.destroy();
  assert(await b.act({type:'resign'}));current=copy(b.status());await verifySettlement(rematchWallet,current);b.destroy();
  console.log('PASS two independent devices: lost final ACK, exact paid settlement, paid rematch and old receipt recovery preserve one current table and one ledger result');
  console.log('PASS complete 80-turn paid win/loss through Edge and SQL: 250 V / 100 XP or 0 V / 25 XP, exactly once');

  const beforeFree=await start(winSeed,0,'hard');current=await finish(current);await verifySettlement(beforeFree,current);
  for(const feature of ['chance','relocation','rent','start','rest'])assert(seen.has(feature),'Full-game fixtures exercise '+feature);
  const beforeResign=await start(1);current=await step(current,{type:'resign'});assert.equal(current.game.economy.outcome,'resigned');await verifySettlement(beforeResign,current);
  console.log('PASS complete free game leaves wallet and statistics unchanged; paid voluntary exit pays no XP');

  // Deliberate late-game arrangements cover rare insolvency branches without
  // changing the engine, mocking its result, or touching real user accounts.
  // Each arrangement is validated, persisted, then resolved by real Edge/SQL.
  async function arrange(configure){const state=await stored();configure(state);assertIntegrity(state);await db.query('update vezdehot_private.server_monopoly_games set state=$2::jsonb where user_id=$1',[uid,JSON.stringify(state)]);const loaded=await request({op:'load'});assert.equal(loaded.status,200);current=loaded.data;await projection(current);}
  const beforeRent=await start(1,0);
  await arrange(g=>{g.players[0].money=3;g.players[0].pos=3;g.players[0].properties=[1,2];g.board[1].owner=0;g.board[2].owner=0;g.players[1].properties=[5,7];g.board[5].owner=1;g.board[7].owner=1;g.bank=1497;});
  const creditorBefore=current.game.players[1].money;assert.equal(current.game.board[5].currentRent,64);random=()=>0;current=await step(current,{type:'roll'});const rent=current.game.lastPayment;
  assert.equal(rent.amount,64);assert.equal(rent.paid,64);assert.equal(rent.creditor,1);assert.deepEqual(rent.sales,[{index:1,value:60},{index:2,value:70}]);assert.equal(rent.moneyAfter,69);assert.equal(rent.capitalBefore-rent.capitalAfter,194);assert.equal(current.game.players[1].money,creditorBefore+64);assert.equal(current.game.players[0].alive,true);assert.equal(current.game.board[1].owner,null);assert.equal(current.game.board[2].owner,null);current=await step(current,{type:'resign'});await verifySettlement(beforeRent,current);
  console.log('PASS full color-group rent doubles; cheapest properties sell at half price; creditor receives the actual rent once');

  const beforeBankrupt=await start(1);
  await arrange(g=>{g.players[0].money=5;g.players[0].pos=12;g.players[0].properties=[1,2];g.board[1].owner=0;g.board[2].owner=0;g.bank=1495;});
  random=()=>0;current=await step(current,{type:'roll'});const debt=current.game.lastPayment;assert.equal(debt.amount,150);assert.equal(debt.paid,135);assert.equal(debt.moneyAfter,0);assert.equal(debt.sales.length,2);assert.equal(current.game.players[0].alive,false);assert.equal(current.game.finishKind,'bankrupt');assert.equal(current.game.economy.outcome,'loss');await verifySettlement(beforeBankrupt,current);
  const counts=(await db.query("select table_id,kind,count(*)::int n from vezdehot_private.server_wallet_ledger where user_id=$1 and game='monopoly' group by table_id,kind",[uid])).rows;assert(counts.every(x=>x.n===1));assert.equal(counts.length,settled.length*2);
  c=controller();assert(await c.load());assert.deepEqual(copy(c.status().game),current.game);assert.equal(c.status().game.over,true);c.destroy();
  console.log('PASS insufficient liquidation produces an explained bankruptcy and one loss settlement; finished game reloads intact');
 }finally{await db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
