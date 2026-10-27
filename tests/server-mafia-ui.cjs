const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const ctx={window:{},document:{getElementById:()=>null},Object,JSON,Number,Set,Error,Promise};vm.createContext(ctx);vm.runInContext(fs.readFileSync('dist/server-mafia.js','utf8'),ctx);
const ui=ctx.window.VEZDEHOT_SERVER_MAFIA;let engine;
test.before(async()=>{engine=await import('../supabase/functions/server-mafia/engine.mjs');});
const ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',copy=v=>JSON.parse(JSON.stringify(v));
const seeded=n=>()=>((n=(Math.imul(n,1664525)+1013904223)>>>0)/2**32),ready=g=>({game:g,ready:true,busy:false,pending:false});
function findRole(role,stake=0){for(let n=1;n<1000;n++){const random=seeded(n),g=engine.createGame({id:ID,stake},random);if(g.players[0].role===role)return {g,random};}throw Error('No role fixture');}
function next(g){const l=engine.legalActions(g);return l.actions.includes('night')?{type:'night',...(l.targets.length?{target:l.targets[0]}:{})}:l.actions.includes('vote')?{type:'vote',...(l.targets.length?{target:l.targets[0]}:{})}:{type:'continue'};}
test('each active night role selects a permitted target without revealing or resolving early',()=>{
 for(const role of ['mafia','doctor','detective']){const {g:internal}=findRole(role),g=engine.projectGame(internal),before=JSON.stringify(g),target=g.legal.targets[0];assert.equal(ui.selectedIntent(ready(g),null),null);assert.deepEqual(copy(ui.selectedIntent(ready(g),target)),{type:'night',target});assert(ui.selectionText(g,target).includes(g.players[target].name));assert.equal(JSON.stringify(g),before);for(const state of [{...ready(g),ready:false},{...ready(g),busy:true},{...ready(g),pending:true}])assert.equal(ui.selectedIntent(state,target),null);}
});
test('civilian and dead observer advance night without inventing a target',()=>{
 const {g:internal}=findRole('civilian'),g=engine.projectGame(internal);assert.deepEqual(copy(ui.selectedIntent(ready(g),null)),{type:'night'});assert.match(ui.selectionText(g,null),/нет отдельного действия/);
 g.players[0].alive=false;assert.match(ui.selectionText(g,null),/наблюдаешь/);
});
test('vote selection is explicit, excludes self and does not create an early ballot',()=>{
 let {g,random}=findRole('doctor');while(!g.over&&g.phase!=='vote')g=engine.applyAction(g,next(g),random);assert.equal(g.phase,'vote');const pub=engine.projectGame(g),before=JSON.stringify(pub);if(pub.players[0].alive){assert.equal(ui.selectedIntent(ready(pub),0),null);const target=pub.legal.targets[0];assert.deepEqual(copy(ui.selectedIntent(ready(pub),target)),{type:'vote',target});assert.match(ui.selectionText(pub,target),/Подтверди голос/);}assert.equal(JSON.stringify(pub),before);
});
test('player rendering distinguishes known alignment from exact role and escapes user content',()=>{
 const {g:internal}=findRole('detective'),g=engine.projectGame(internal);g.players[1].name='<img src=x>';let html=ui.playerMarkup(g.players[1],g,true,1);assert.match(html,/Роль неизвестна/);assert(!html.includes('<img'));assert.match(html,/&lt;img/);assert.match(html,/aria-pressed="true"/);assert.match(html,/Моя пометка/);g.knowledge[1]='town';html=ui.playerMarkup(g.players[1],g,true,null);assert.match(html,/Проверка: не мафия/);assert(!html.includes('Комиссар'));assert(!html.includes('Доктор'));
});
test('private notebook contains only the supplied human findings, escaped, and only for commissioner',()=>{
 const {g:internal}=findRole('detective'),g=engine.projectGame(internal);assert.match(ui.notebookMarkup(g),/После первой проверки/);g.privateNotes=['Ночь 1: <b>Марс</b> — не мафия.'];let html=ui.notebookMarkup(g);assert.match(html,/Только тебе · 1/);assert(!html.includes('<b>Марс'));assert.match(html,/&lt;b&gt;Марс/);g.players[0].role='civilian';assert.equal(ui.notebookMarkup(g),'');
});
test('tied vote explains no elimination and renders all real ballots',()=>{
 const g=engine.projectGame(findRole('civilian').g),record={round:1,eliminated:null,message:'Голоса разделились.',ballots:[{voter:0,target:1},{voter:1,target:2},{voter:2,target:1},{voter:3,target:2},{voter:4,target:5},{voter:5,target:4},{voter:6,target:3}]};const html=ui.voteResultMarkup(g,record);assert.match(html,/Голоса разделились/);assert.match(html,/При равенстве никто не выбывает/);assert(!html.includes('жереб'));assert.equal((html.match(/<li>/g)||[]).length,7);assert.match(html,/Кто за кого голосовал/);
});
test('winning, losing, draw and resignation outcomes have exact separate returned coins and net result',()=>{
 const g=engine.projectGame(findRole('doctor').g);g.over=true;g.phase='result';g.resultReason='Город нашёл всю мафию.';
 for(const [outcome,payout,xp] of [['win',250,130],['loss',0,25],['draw',100,40],['resigned',0,0]]){g.win=outcome==='win';g.draw=outcome==='draw';g.resigned=outcome==='resigned';g.winningTeam=g.draw?'draw':g.resigned?null:g.win?'town':'mafia';g.economy={version:1,stake:100,settled:true,payout,xp,outcome};const html=ui.outcomeMarkup(g);assert(html.includes(`${payout} V`));assert(html.includes(`+${xp} XP`));assert(html.includes(`${payout-100>0?'+':''}${payout-100} V`));assert.match(html,/Ещё партия · 100 V/);if(outcome==='loss')assert.match(html,/Твоя сторона проиграла/);}
 g.economy={version:1,stake:0,settled:true,payout:0,xp:0,outcome:'resigned'};assert.match(ui.outcomeMarkup(g),/монеты и XP не меняются/);assert.match(ui.outcomeMarkup(g),/Ещё партия · бесплатно/);
});
test('public statement context is labelled as opinion and never includes an invented proof',()=>{
 const g=engine.projectGame(findRole('civilian').g);g.statements=[{actor:1,target:2,text:'Под подозрением: Вера.',context:'Это первая версия, без публичного подтверждения.'}];const html=ui.statementsMarkup(g);assert.match(html,/Не доказательства/);assert.match(html,/Основание версии/);assert.match(html,/без публичного подтверждения/);
});
test('all real projected lifecycles validate through every role, spectator finish and result',()=>{
 const roles=new Set(),finishes=new Set(),terminalEvents=new Set();
 for(let n=1;n<=100;n++){const random=seeded(n),stake=n%2?100:0;let g=engine.createGame({id:ID,stake,difficulty:['easy','normal','hard'][n%3]},random);roles.add(g.players[0].role);let steps=0;
  while(!g.over&&steps<150){const pub=engine.projectGame(g);assert.doesNotThrow(()=>ui.projection({status:'ok',revision:steps,game:pub}));let a=next(g);if(!g.players[0].alive&&n%3===0)a={type:'finish'};if(steps===0){const marked=engine.applyAction(g,{type:'mark',target:1,mark:'suspect'},random);assert.equal(marked.personalMarks[1],'suspect');g=marked;}g=engine.applyAction(g,a,random);steps++;}
  assert(g.over);const pub=engine.projectGame(g);assert.doesNotThrow(()=>ui.projection({status:'ok',revision:steps,game:pub}));finishes.add(pub.economy.outcome);const final=ui.finalEventMarkup(pub);assert(final.length>0);if(pub.votes!==null&&pub.voteHistory.at(-1)?.round===pub.round){terminalEvents.add('vote');assert.match(final,/Кто за кого голосовал/);assert(final.includes(pub.voteHistory.at(-1).message));}else{terminalEvents.add('night');assert(final.includes(pub.nightText));}
 }
 assert.equal(roles.size,4);assert(finishes.has('win'));assert(finishes.has('loss'));assert.deepEqual([...terminalEvents].sort(),['night','vote']);
});
test('personal vote analysis reports facts without attributing entire outcome to one ballot',()=>{
 const g=engine.projectGame(findRole('detective').g);g.voteFacts={total:1,againstMafia:0,againstTown:1,rows:[{round:1,target:1,name:'Марс',role:'doctor',eliminated:null,outName:null}]};const html=ui.factsMarkup(g);assert.match(html,/Против города: 1/);assert.match(html,/не определяет исход/);assert.match(html,/Доктор/);
});

test('page boot refreshes the server wallet after a confirmed empty-table load',async()=>{
 let refreshes=0;const calls=[],app={},account={user:{id:ID},loading:false,switching:false};
 const window={VEZDEHOT:{scopeKey:()=>ID,account:()=>account,serverMafiaRequest:async body=>{calls.push(body.op);return {ok:true,status:200,data:{status:'ok',revision:0,game:null}}}},VEZDEHOT_TAB_SESSION:{canWrite:()=>true},VEZDEHOT_SERVER_WALLET:{refresh:()=>{refreshes++;return Promise.resolve(true)}},localStorage:{getItem:()=>null}};
 const document={hidden:false,getElementById:id=>id==='app'?app:null,addEventListener:()=>{}};
 const source=fs.readFileSync('dist/server-mafia.js','utf8').replace('Promise.resolve(window.VEZDEHOT?.ready).then(boot);','window.__boot=boot;render=()=>{};connectWallet=()=>{};return;');
 const context={window,document,Object,JSON,Number,Set,Error,Promise};vm.createContext(context);vm.runInContext(source,context);window.__boot();await new Promise(r=>setImmediate(r));assert.deepEqual(calls,['load']);assert.equal(refreshes,1);
});
