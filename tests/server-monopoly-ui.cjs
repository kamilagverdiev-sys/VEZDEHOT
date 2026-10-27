const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const ctx={window:{},document:{getElementById:()=>null},Object,JSON,Number,Set,Error,Promise};vm.createContext(ctx);vm.runInContext(fs.readFileSync('dist/server-monopoly.js','utf8'),ctx);
const ui=ctx.window.VEZDEHOT_SERVER_MONOPOLY;let engine;
test.before(async()=>{engine=await import('../supabase/functions/server-monopoly/engine.mjs');});
const ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',copy=v=>JSON.parse(JSON.stringify(v)),seeded=n=>()=>((n=(Math.imul(n,1664525)+1013904223)>>>0)/2**32);
const pub=()=>engine.projectGame(engine.createGame({id:ID})),valid=(g,revision=0)=>ui.projection({status:'ok',revision,game:g});
function next(g){return {type:g.phase==='ready'?'roll':g.phase==='buy'?(g.players[0].money-g.board[g.players[0].pos].price>=160?'buy':'skip'):'continue'};}
test('all twenty cells occupy one unique perimeter position and expose complete names and player tokens',()=>{
 const g=pub(),positions=g.board.map((_,i)=>copy(ui.cellPosition(i)));assert.equal(new Set(positions.map(p=>p.join(','))).size,20);assert(positions.every(([r,c])=>r>=1&&r<=6&&c>=1&&c<=6&&(r===1||r===6||c===1||c===6)));
 const html=ui.boardMarkup(g,0);assert.equal((html.match(/data-cell=/g)||[]).length,20);assert.match(html,/aria-pressed="true"/);for(const c of g.board)assert(html.includes(c.title));for(const p of g.players)assert(ui.tileDescription(g,0).includes(p.name));assert.match(html,/Первый ход — твой/);assert(!html.includes('class="mn-dice'));assert.match(html,/кубики не бросались/);
});
test('property inspection distinguishes base rent, complete-group rent and half-price sale',()=>{
 const g=pub();let html=ui.propertyMarkup(g,1);assert.match(html,/Базовая аренда/);assert.match(html,/22 ¤/);assert.match(html,/60 ¤/);assert.match(html,/Свободный объект/);
 for(const i of [1,2]){g.board[i].owner=0;g.board[i].currentRent=g.board[i].rent*2;g.players[0].properties.push(i);}html=ui.propertyMarkup(g,1);assert.match(html,/Аренда ×2/);assert.match(html,/44 ¤/);assert.match(html,/Вся цветовая группа/);assert(!html.includes(' V'));
});
test('buy preview conserves capital and clearly predicts completion of the public colour group',()=>{
 const g=pub();g.phase='buy';g.players[0].pos=2;g.board[1].owner=0;g.players[0].properties=[1];g.players[0].money=1380;g.players[0].capital=1500;
 assert.deepEqual(copy(ui.purchaseInfo(g)),{index:2,price:140,cashAfter:1240,rentAfter:52,completes:true,capitalAfter:1500});g.board[1].owner=1;assert.equal(ui.purchaseInfo(g).rentAfter,26);assert.equal(ui.purchaseInfo(g).completes,false);g.phase='review';assert.equal(ui.purchaseInfo(g),null);
});
test('rest actions and skipped rolls never describe a new throw or repeat the first-turn message',()=>{
 let g=engine.createGame({id:ID});g.players[0].pos=6;g.players[0].skip=1;g.turnNumber=5;let p=engine.projectGame(g);assert.match(ui.commandText(p),/Кубики не бросаются/);assert.match(ui.boardMarkup(p,6),/Один ход отдыха/);
 g=engine.applyAction(g,{type:'roll'},()=>{throw Error('A rest must not roll')});p=engine.projectGame(g);assert.equal(p.lastRoll,null);const html=ui.boardMarkup(p,6);assert.match(html,/Без броска кубиков/);assert(!html.includes('Первый ход — твой'));assert(!html.includes('class="mn-dice'));
});
test('dice show exactly the confirmed faces and animation is opt-in only',()=>{
 for(let n=1;n<=6;n++){const html=ui.diceMarkup([n,7-n]);assert.equal((html.match(/pip on/g)||[]).length,7);assert(html.includes(`Кубики: ${n} и ${7-n}. Всего 7`));assert(!html.includes('confirmed-roll'));}assert.match(ui.diceMarkup([2,4],true),/confirmed-roll/);
 const g=pub();for(const [dice,label] of [[[1,1],'2 шага'],[[1,2],'3 шага'],[[2,3],'5 шагов'],[[5,6],'11 шагов']]){g.dice=dice;g.lastRoll={turn:1,player:0,dice};assert(ui.boardMarkup(g,0).includes(label));}
});
test('forced-sale receipt shows amount due, paid cash, before-after capital and the sale discount',()=>{
 const g=pub();g.turnNumber=9;g.lastPayment={turn:9,player:0,creditor:1,reason:'Аренда',amount:200,paid:200,moneyBefore:40,moneyAfter:30,capitalBefore:420,capitalAfter:30,sales:[{index:19,value:190}]};
 const html=ui.paymentMarkup(g);assert.match(html,/Вынужденная продажа за ½ цены/);assert.match(html,/Главный хаб/);assert.match(html,/\+190 ¤/);assert.match(html,/40 → 30 ¤/);assert.match(html,/420 → 30 ¤/);assert.match(html,/-390 ¤/);assert.match(html,/платёж и потеря половины стоимости/);assert(!html.includes(' V'));
 g.lastPayment.turn=8;assert.equal(ui.paymentMarkup(g),'');g.over=true;assert(ui.paymentMarkup(g));
});
test('unpaid debt explains bankruptcy and never presents the full debt as received income',()=>{
 const g=pub();g.lastPayment={turn:1,player:0,creditor:1,reason:'Аренда',amount:200,paid:30,moneyBefore:30,moneyAfter:0,capitalBefore:30,capitalAfter:0,sales:[]};const html=ui.paymentMarkup(g);assert.match(html,/долг не погашен/);assert.match(html,/Начислено<\/dt><dd>200 ¤/);assert.match(html,/Выплачено<\/dt><dd>30 ¤/);assert.match(html,/Не хватило<\/dt><dd>170 ¤/);assert.match(html,/остаток не начисляется получателю/);
});
test('result explains shared first place and separates returned V, net V, XP and city capital',()=>{
 const g=pub();g.over=true;g.phase='over';g.winners=[0,1,2];g.winner=0;g.finishKind='capital';g.resultReason='Одинаковый капитал.';g.economy={version:1,stake:100,settled:true,outcome:'win',payout:250,xp:100};let html=ui.outcomeMarkup(g);assert.match(html,/ОБЩАЯ ПОБЕДА/);assert.match(html,/Победа на равных/);assert.match(html,/все лидеры побеждают/);assert.match(html,/250 V/);assert.match(html,/\+150 V/);assert.match(html,/\+100 XP/);assert.match(html,/Ещё партия · 100 V/);assert(!html.includes('на двоих'));
 g.economy={...g.economy,stake:0,payout:0,xp:0};html=ui.outcomeMarkup(g);assert.match(html,/монеты и XP не меняются/);assert.match(html,/Ещё партия · бесплатно/);
 g.resigned=true;g.economy={...g.economy,stake:100,outcome:'resigned'};html=ui.outcomeMarkup(g);assert.match(html,/ДОСРОЧНОЕ ЗАВЕРШЕНИЕ/);assert.match(html,/-100 V/);assert.match(html,/\+0 XP/);
});
test('names and ledger text remain escaped in every displayed personal entry',()=>{
 const g=pub();g.players[0].name='<img src=x onerror=1>';g.ledger=[{player:0,delta:1,label:'<script>x</script>',turn:1,balance:1501}];g.journal=[{turn:1,text:'<img src=x>'}];for(const html of [ui.playersMarkup(g),ui.tileMarkup(g,0,0),ui.historyMarkup(g)]){assert(!html.includes('<img'));assert(!html.includes('<script>'));assert.match(html,/&lt;/);}assert.match(ui.historyMarkup(g),/не меняют баланс V/);
 for(const [n,event,operation] of [[1,'событие','операция'],[2,'события','операции'],[5,'событий','операций'],[11,'событий','операций'],[21,'событие','операция']]){g.journal=Array.from({length:n},()=>({turn:1,text:'Событие'}));g.ledger=Array.from({length:n},()=>({player:0,delta:1,label:'Бонус',turn:1,balance:1501}));const html=ui.historyMarkup(g);assert(html.includes(`${n} ${event}`));assert(html.includes(`${n} ${operation}`));}
});
test('a bankrupt bot can remain the reviewed mover before the next living player continues',()=>{
 let g=engine.createGame({id:ID});g.turn=1;g.turnNumber=2;g.phase='review';g.players[1].alive=false;g.bank+=g.players[1].money;g.players[1].money=0;g.message='Мира обанкротилась.';const p=engine.projectGame(g);assert.doesNotThrow(()=>valid(p));assert.match(ui.playersMarkup(p),/Банкрот/);assert.match(ui.commandText(p),/Ход игрока Мира завершён/);g=engine.applyAction(g,{type:'continue'},seeded(1));assert.equal(g.turn,2);
});
test('real forced sale projection validates exact sale arithmetic and rejects forged receipts',()=>{
 let g=engine.createGame({id:ID});for(const i of [5,2,1]){g.players[0].money-=g.board[i].price;g.bank+=g.board[i].price;g.players[0].properties.push(i);g.board[i].owner=0;}g.bank+=g.players[0].money;g.players[0].money=0;
 g=engine.applyAction(g,{type:'roll'},()=>.2);const p=engine.projectGame(g);assert.doesNotThrow(()=>valid(p));assert.equal(p.lastPayment.sales.length,2);const html=ui.paymentMarkup(p);assert.match(html,/Маяк/);assert.match(html,/Оранжерея/);assert.match(html,/430 → 200 ¤/);assert.match(html,/0 → 30 ¤/);
 for(const mutate of [v=>v.lastPayment.paid++,v=>v.lastPayment.sales[0].value++,v=>v.lastPayment.capitalAfter++,v=>v.lastPayment.sales.push({...v.lastPayment.sales[0]})]){const bad=copy(p);mutate(bad);assert.throws(()=>valid(bad));}
});
test('all confirmed stages of 100 full games render and validate, including rest and final review',()=>{
 const finishes=new Set(),features=new Set();let count=0;
 for(let seed=1;seed<=100;seed++){
  const random=seeded(seed);let g=engine.createGame({id:ID,difficulty:['easy','normal','hard'][seed%3],stake:seed%2?100:0},random),steps=0;
  while(!g.over&&steps<160){const p=engine.projectGame(g);assert.doesNotThrow(()=>valid(p,steps));ui.boardMarkup(p,p.players[p.turn].pos);ui.propertyMarkup(p,p.players[p.turn].pos);ui.paymentMarkup(p);ui.playersMarkup(p);
   if(p.phase==='review'&&p.turnNumber===80){features.add('final-review');assert.deepEqual(copy(p.legal.actions),['continue']);}
   if(p.phase==='buy')features.add('buy');if(p.lastPayment?.sales.length)features.add('forced-sale');if(p.phase==='review'&&!p.lastRoll)features.add('rest');if(!p.players[p.turn].alive)features.add('bot-bankrupt');
   g=engine.applyAction(g,next(g),random);steps++;count++;
  }
  assert(g.over);const p=engine.projectGame(g);assert.doesNotThrow(()=>valid(p,steps));assert(ui.outcomeMarkup(p).includes('Ещё партия'));finishes.add(p.economy.outcome);
 }
 assert(count>8000);assert(finishes.has('win'));assert(finishes.has('loss'));for(const f of ['final-review','buy','rest'])assert(features.has(f),f);
});

test('page boot refreshes the server wallet after a confirmed empty-table load',async()=>{
 let refreshes=0;const calls=[],app={},account={user:{id:ID},loading:false,switching:false};
 const window={VEZDEHOT:{scopeKey:()=>ID,account:()=>account,serverMonopolyRequest:async body=>{calls.push(body.op);return {ok:true,status:200,data:{status:'ok',revision:0,game:null}}}},VEZDEHOT_TAB_SESSION:{canWrite:()=>true},VEZDEHOT_SERVER_WALLET:{refresh:()=>{refreshes++;return Promise.resolve(true)}},localStorage:{getItem:()=>null}};
 const document={hidden:false,getElementById:id=>id==='app'?app:null,addEventListener:()=>{}};
 const source=fs.readFileSync('dist/server-monopoly.js','utf8').replace('Promise.resolve(window.VEZDEHOT?.ready).then(boot);','window.__boot=boot;render=()=>{};connectWallet=()=>{};return;');
 const context={window,document,Object,JSON,Number,Set,Error,Promise};vm.createContext(context);vm.runInContext(source,context);window.__boot();await new Promise(r=>setImmediate(r));assert.deepEqual(calls,['load']);assert.equal(refreshes,1);
});
