const {test}=require('node:test'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const ready=Promise.all([import('../supabase/functions/server-monopoly/engine.mjs'),import('../supabase/functions/server-monopoly/core.mjs')]);
const rng=(s=1)=>()=>((s=(Math.imul(s,1664525)+1013904223)>>>0)/2**32),copy=v=>structuredClone(v);
const dice=(a,b,chance=0)=>{let values=[(a-1)/6,(b-1)/6,chance];return()=>values.shift()??0;};
const next=g=>({type:g.phase==='buy'&&g.players[0].money-g.board[g.players[0].pos].price<150?'skip':g.phase==='ready'?'roll':g.phase==='buy'?'buy':'continue'});
function own(g,player,index){const p=g.players[player],c=g.board[index];p.money-=c.price;g.bank+=c.price;p.properties.push(index);c.owner=player;}
function cash(g,id,amount){g.bank+=g.players[id].money-amount;g.players[id].money=amount;}
function projections(e,g){const p=e.projectGame(g);for(const key of ['state','random','seed','rng','pendingSteps','paused','pace'])assert(!Object.hasOwn(p,key));assert.deepEqual(p.economy,g.economy);assert.equal(p.players.length,4);assert.equal(p.board.length,20);assert.deepEqual(p.legal,e.legalActions(g));return p;}
test('Monopoly generated primitives and fixed catalogs match canonical source byte-for-byte',()=>execFileSync(process.execPath,['scripts/sync-server-monopoly-core.cjs','--check'],{cwd:require('node:path').join(__dirname,'..')}));
test('Monopoly begins with four distinct owners, 20 cells and conserved capital',async()=>{
 const [e]=await ready,g=e.createGame({nick:'  \u0000Игрок\n  ',stake:100},rng(1));assert.equal(g.players[0].name,'Игрок');assert.equal(g.phase,'ready');assert.equal(g.turnNumber,1);assert.equal(g.maxTurns,80);assert.deepEqual(g.players.map(p=>p.money),[1500,1500,1500,1500]);assert.equal(g.bank,0);assert.deepEqual(e.legalActions(g),{actions:['roll','resign']});projections(e,g);
 for(const input of [{stake:1},{stake:'100'},{stake:null},{difficulty:'impossible'},{id:'bad'},{nick:null}])assert.throws(()=>e.createGame(input),{code:'invalid_request'});
});
test('Monopoly atomic roll resolves movement and exposes a purchase without storing rolling',async()=>{
 const [e]=await ready,g=e.createGame({},rng(1)),snapshot=copy(g),p=e.applyAction(g,{type:'roll'},dice(1,1));assert.deepEqual(g,snapshot);assert.equal(p.phase,'buy');assert.equal(p.players[0].pos,2);assert.deepEqual(p.lastPath,[1,2]);assert.deepEqual(p.lastRoll,{turn:1,player:0,dice:[1,1]});assert.equal(p.pendingSteps,0);assert.deepEqual(e.legalActions(p),{actions:['buy','skip','resign']});
 const bought=e.applyAction(p,{type:'buy'}),skipped=e.applyAction(p,{type:'skip'});assert.equal(bought.phase,'review');assert.equal(bought.board[2].owner,0);assert.equal(bought.players[0].money,1360);assert.equal(bought.bank,140);assert.equal(skipped.board[2].owner,null);assert.equal(skipped.players[0].money,1500);
});
test('Monopoly every continue reveals exactly one bot and stops before the human roll',async()=>{
 const [e]=await ready;let g=e.createGame({},rng(1));g=e.applyAction(e.applyAction(g,{type:'roll'},dice(1,1)),{type:'skip'});
 for(let seat=1;seat<=3;seat++){g=e.applyAction(g,{type:'continue'},dice(1,1));assert.equal(g.turn,seat);assert.equal(g.turnNumber,seat+1);assert.equal(g.phase,'review');assert.equal(g.lastMover,seat);assert.equal(g.lastRoll.player,seat);assert.equal(g.players[seat].pos,2);}
 let used=false;g=e.applyAction(g,{type:'continue'},()=>{used=true;throw Error('human turn rolled automatically');});assert(!used);assert.equal(g.turn,0);assert.equal(g.phase,'ready');assert.equal(g.turnNumber,5);assert.deepEqual(g.lastPath,[]);
});
test('Monopoly denies dice, positions, actor IDs, client seeds and phase bypass atomically',async()=>{
 const [e]=await ready,g=e.createGame(),snapshot=copy(g);for(const action of [null,[],{type:'buy'},{type:'skip'},{type:'continue'},{type:'roll',dice:[6,6]},{type:'roll',seed:123},{type:'roll',actor:1},{type:'roll',position:19},{type:'resign',payout:250},{type:'unknown'}])assert.throws(()=>e.applyAction(g,action));assert.deepEqual(g,snapshot);
 const rolled=e.applyAction(g,{type:'roll'},dice(1,1));assert.throws(()=>e.applyAction(rolled,{type:'roll'}),{code:'illegal_action'});
});
test('Monopoly start bonus is credited once and chance movement resolves the destination',async()=>{
 const [e]=await ready,g=e.createGame();g.players[0].pos=19;let after=e.applyAction(g,{type:'roll'},dice(1,1));assert.equal(after.players[0].money,1700);assert.equal(after.bank,-200);assert.deepEqual(after.lastPath,[0,1]);assert.equal(after.ledger.filter(v=>v.delta===200).length,1);
 const chance=e.applyAction(e.createGame(),{type:'roll'},dice(1,2,.999));assert.equal(chance.players[0].pos,5);assert.equal(chance.phase,'buy');assert.equal(chance.lastSteps,5);assert.deepEqual(chance.lastPath,[1,2,3,4,5]);assert.deepEqual(chance.lastChance,{text:'Вперёд на две клетки',delta:0,move:2,player:0,turn:1});
});
test('Monopoly rest relocates to six and consumes exactly one future turn without RNG',async()=>{
 const [e]=await ready;let g=e.applyAction(e.createGame(),{type:'roll'},dice(5,6));assert.equal(g.players[0].pos,6);assert.equal(g.players[0].skip,1);assert(g.lastRelocated);assert.equal(g.lastPath.at(-1),6);
 for(let n=0;n<4;n++)g=e.applyAction(g,{type:'continue'},dice(1,1));assert.equal(g.phase,'ready');const skipped=e.applyAction(g,{type:'roll'},()=>{throw Error('rest must not roll');});assert.equal(skipped.players[0].skip,0);assert.equal(skipped.players[0].pos,6);assert.equal(skipped.phase,'review');assert.equal(skipped.lastRoll,null);assert.deepEqual(skipped.lastPath,[]);
});
test('Monopoly complete color groups double rent and record both actual cash ledger sides',async()=>{
 const [e]=await ready,g=e.createGame();own(g,1,1);own(g,1,2);assert.equal(e.projectGame(g).board[2].currentRent,52);const next=e.applyAction(g,{type:'roll'},dice(1,1));assert.equal(next.players[0].money,1448);assert.equal(next.players[1].money,1292);assert.equal(next.lastPayment.amount,52);assert.equal(next.lastPayment.creditor,1);assert.deepEqual(next.ledger.map(v=>[v.player,v.delta]),[[1,52],[0,-52]]);
});
test('Monopoly forced sale is cheapest first at half price and preserves receipt capital math',async()=>{
 const [e]=await ready,g=e.createGame();for(const index of [5,2,1])own(g,0,index);cash(g,0,0);const after=e.applyAction(g,{type:'roll'},dice(2,2));assert.equal(after.phase,'review');assert.equal(after.players[0].money,30);assert.deepEqual(after.players[0].properties,[5]);assert.deepEqual(after.lastPayment.sales,[{index:1,value:60},{index:2,value:70}]);assert.equal(after.lastPayment.capitalBefore,430);assert.equal(after.lastPayment.capitalAfter,200);assert.equal(after.lastPayment.paid,100);assert.equal(after.board[1].owner,null);assert.equal(after.board[2].owner,null);assert.equal(after.bank+after.players.reduce((n,p)=>n+p.money,0),6000);projections(e,after);
});
test('Monopoly short human payment terminates immediately without an invented bot winner or unpaid rent',async()=>{
 const [e]=await ready,g=e.createGame({stake:100});own(g,1,2);cash(g,0,10);const before=g.players[1].money,after=e.applyAction(g,{type:'roll'},dice(1,1));assert(after.over);assert.equal(after.phase,'over');assert.equal(after.players[0].alive,false);assert.equal(after.players[1].money,before+10);assert.equal(after.lastPayment.amount,26);assert.equal(after.lastPayment.paid,10);assert.equal(after.finishKind,'bankrupt');assert.deepEqual(after.winners,[]);assert.deepEqual(after.economy,{version:1,stake:100,settled:true,payout:0,xp:25,outcome:'loss'});assert.throws(()=>e.applyAction(after,{type:'continue'}));
});
test('Monopoly an exactly affordable bill leaves the player alive at zero money',async()=>{
 const [e]=await ready,g=e.createGame();cash(g,0,100);const after=e.applyAction(g,{type:'roll'},dice(2,2));assert.equal(after.players[0].money,0);assert(after.players[0].alive);assert(!after.over);assert.equal(after.phase,'review');assert.equal(after.lastPayment.paid,100);
});
test('Monopoly final capital ties including the human award the full canonical prize',async()=>{
 const [e]=await ready;for(const stake of [0,100]){const g=e.createGame({stake});g.turnNumber=80;g.phase='review';const result=e.applyAction(g,{type:'continue'},()=>{throw Error('final scoring must not use RNG');});assert(result.over);assert.equal(result.finishKind,'capital');assert.equal(result.winner,0);assert.deepEqual(result.winners,[0,1,2,3]);assert.deepEqual(result.economy,{version:1,stake,settled:true,payout:stake?250:0,xp:stake?100:0,outcome:'win'});}
 const g=e.createGame({stake:100});g.turnNumber=80;g.phase='review';cash(g,0,1400);const loss=e.applyAction(g,{type:'continue'});assert.equal(loss.winner,null);assert.deepEqual(loss.winners,[1,2,3]);assert.equal(loss.economy.xp,25);
});
test('Monopoly last surviving bot is named when human bankruptcy ends heads-up play',async()=>{
 const [e]=await ready,g=e.createGame({stake:100});for(const seat of [1,2]){cash(g,seat,0);g.players[seat].alive=false;}own(g,3,2);cash(g,0,10);const result=e.applyAction(g,{type:'roll'},dice(1,1));assert.equal(result.finishKind,'last-player');assert.deepEqual(result.winners,[3]);assert.equal(result.winner,null);assert.equal(result.economy.outcome,'loss');
});
test('Monopoly bankrupt bot retains its review and next continuation skips its eliminated seat',async()=>{
 const [e]=await ready,g=e.createGame({stake:100});g.phase='review';cash(g,1,0);const after=e.applyAction(g,{type:'continue'},dice(2,2));assert.equal(after.turn,1);assert.equal(after.phase,'review');assert(!after.players[1].alive);assert(!after.over);assert.equal(after.lastPayment.player,1);assert.equal(after.lastPayment.paid,0);const next=e.applyAction(after,{type:'continue'},dice(1,1));assert.equal(next.turn,2);assert.equal(next.turnNumber,3);
 const last=copy(g);for(const id of [2,3]){cash(last,id,0);last.players[id].alive=false;}const win=e.applyAction(last,{type:'continue'},dice(2,2));assert(win.over);assert.equal(win.finishKind,'last-player');assert.equal(win.winner,0);assert.deepEqual(win.winners,[0]);assert.equal(win.economy.payout,250);
});
test('Monopoly final review hides resignation and stale resignation preserves the earned capital outcome',async()=>{
 const [e]=await ready;for(const money of [1400,1500,1600]){const g=e.createGame({stake:100});g.turnNumber=80;g.phase='review';cash(g,0,money);assert.deepEqual(e.legalActions(g),{actions:['continue']});const result=e.applyAction(g,{type:'continue'}),stale=e.applyAction(g,{type:'resign'});assert.deepEqual(stale,result);assert.equal(stale.resigned,false);assert.equal(stale.economy.outcome,money<1500?'loss':'win');assert.equal(stale.economy.xp,money<1500?25:100);}
});
test('Monopoly resignation has no payout or XP and cannot modify a settled outcome',async()=>{
 const [e]=await ready;for(const stake of [0,100]){const g=e.createGame({stake}),ended=e.applyAction(g,{type:'resign'});assert.deepEqual(ended.players,g.players);assert.deepEqual(ended.board,g.board);assert(ended.over&&ended.resigned);assert.equal(ended.finishKind,'resigned');assert.deepEqual(ended.economy,{version:1,stake,settled:true,payout:0,xp:0,outcome:'resigned'});assert.deepEqual(e.legalActions(ended),{actions:[]});assert.throws(()=>e.applyAction(ended,{type:'roll'}));}
});
test('Monopoly 240 seeded games cover all difficulties, free and paid outcomes with conserved money',async()=>{
 const [e]=await ready,outcomes=new Set(),features=new Set();for(let seed=1;seed<=240;seed++){
  const random=rng(seed);let g=e.createGame({difficulty:['easy','normal','hard'][seed%3],stake:seed%2?100:0},random),steps=0;
  while(!g.over&&steps++<200){g=e.applyAction(g,next(g),random);projections(e,g);if(g.lastChance)features.add('chance');if(g.lastRelocated)features.add('rest');if(g.lastPayment?.sales.length)features.add('sale');if(g.lastPayment?.creditor!==null&&g.lastPayment)features.add('rent');}
  assert(g.over);assert(g.turnNumber<=80);outcomes.add(g.economy.outcome);assert.equal(g.economy.payout,g.stake&&g.winner===0?250:0);assert.equal(g.economy.xp,g.stake?(g.winner===0?100:25):0);assert.equal(g.bank+g.players.reduce((n,p)=>n+p.money,0),6000);
 }assert.deepEqual([...outcomes].sort(),['loss','win']);assert(features.has('chance')&&features.has('rest')&&features.has('rent'));
});
test('Monopoly 45 full games match canonical transitions and RNG consumption exactly',async()=>{
 const [e,c]=await ready,fields=['players','board','bank','turn','turnNumber','phase','over','winner','winners','finishKind','resultReason','message','dice','log','journal','ledger','lastIndex','lastPath','lastFrom','lastTo','lastMover','lastSteps','lastRelocated','lastRoll','lastChance','lastPayment'];
 for(let seed=1;seed<=45;seed++){
  let g=e.createGame({difficulty:['easy','normal','hard'][seed%3]},rng(seed)),canonical=copy(g);const a=rng(seed+500),b=rng(seed+500),core=c.createCore({random:b});
  for(let steps=0;!g.over&&steps<200;steps++){const action=next(g);core[action.type](canonical);g=e.applyAction(g,action,a);for(const key of fields)assert.deepEqual(g[key],canonical[key],`seed ${seed} field ${key}`);}assert(g.over);assert.equal(a(),b());
 }
});
test('Monopoly projection is read-only, detached and excludes private extension fields',async()=>{
 const [e]=await ready,g=e.createGame();g.privateSeed='DO-NOT-EXPOSE';g.credentials={secret:'DO-NOT-EXPOSE'};const before=copy(g),projected=projections(e,g);assert(!JSON.stringify(projected).includes('DO-NOT-EXPOSE'));assert.deepEqual(g,before);projected.players[0].money=999;projected.board[0].title='changed';projected.legal.actions.push('cheat');assert.equal(g.players[0].money,1500);assert.notEqual(g.board[0].title,'changed');
});
test('Monopoly persisted JSONB key ordering preserves the game and every transition',async()=>{
 const [e]=await ready,reorder=v=>Array.isArray(v)?v.map(reorder):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).reverse().map(([k,x])=>[k,reorder(x)])):v;let g=e.createGame({stake:100},rng(4)),a=rng(99),b=rng(99);while(!g.over){const stored=reorder(g);assert.deepEqual(e.projectGame(stored),e.projectGame(g));const action=next(g),nextA=e.applyAction(g,action,a),nextB=e.applyAction(stored,action,b);assert.deepEqual(nextA,nextB);g=nextA;}
});
test('Monopoly corrupt catalogs, ownership, cash, results, receipts and economy fail closed',async()=>{
 const [e]=await ready,g=e.createGame();for(const change of [v=>v.board[1].price++,v=>v.board[1].rent++,v=>v.board[1].title='fake',v=>v.board[1].owner=0,v=>v.players[0].properties=[1],v=>v.players[0].money++,v=>v.players[1].name='fake',v=>v.turn=1,v=>v.phase='rolling',v=>v.maxTurns=400,v=>v.economy.payout=250,v=>v.economy.extra=true,v=>v.winners=[0],v=>v.players[0].alive=false,v=>v.pendingSteps=12,v=>v.lastChance={text:'fake',delta:1,move:0,player:0,turn:1}]){const bad=copy(g);change(bad);assert.throws(()=>e.projectGame(bad),{code:'invalid_server_state',status:503});}
 const sold=copy(g);own(sold,0,1);cash(sold,0,50);const paid=e.applyAction(sold,{type:'roll'},dice(2,2));for(const change of [v=>v.lastPayment.paid++,v=>v.lastPayment.sales[0].value++,v=>v.lastPayment.capitalAfter++,v=>v.lastPayment.sales.push({...v.lastPayment.sales[0]})]){const bad=copy(paid);change(bad);assert.throws(()=>e.applyAction(bad,{type:'continue'}),{code:'invalid_server_state'});}
 const terminal=copy(g);terminal.turnNumber=80;terminal.phase='review';const result=e.applyAction(terminal,{type:'continue'});for(const change of [v=>v.winners=[0],v=>v.winner=null,v=>v.turnNumber=79,v=>v.finishKind='bankrupt',v=>v.resigned=true]){const bad=copy(result);change(bad);assert.throws(()=>e.assertIntegrity(bad),{code:'invalid_server_state'});}
});
