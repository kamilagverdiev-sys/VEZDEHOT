const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const html=fs.readFileSync('dist/index.html','utf8'),storeSource=fs.readFileSync('dist/game-store.js','utf8');
const sessions=html.split('// MAIN_SESSIONS_START')[1].split('// MAIN_SESSIONS_END')[0].split('\n').slice(1).join('\n');
const engine=html.slice(html.indexOf('    function deck(){'),html.indexOf('    function canHumanAttack'));
const binding=html.slice(html.indexOf('    function bindRoom(){'),html.indexOf('    function confirmRestart'));
const clone=x=>JSON.parse(JSON.stringify(x));
function harness(local=new Map()){
  let seed=21991,writable=true;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32},nodes=new Map(),groups=new Map(),calls={render:0};
  const profile={nick:'Ты',balance:10000,xp:0,wins:0,games:0,bonusAt:0},storage={getItem:k=>local.get(k)||null,setItem:(k,v)=>local.set(k,v)};
  const ctx={console,Date,JSON,Math:Object.assign(Object.create(Math),{random}),Map,Set,localStorage:storage,document:{hidden:false,addEventListener(){}},defaultState:{...profile,view:'lobby',room:null,game:null},s:{...profile,view:'lobby',game:null,savedGames:{}},accountChanging:false,ranks:['6','7','8','9','10','J','Q','K','A'],suits:[['♠','black'],['♥','red'],['♦','red'],['♣','black']],botNames:['А','Б','В','Г','Д'],avatars:['A','B','C','D','E'],code:()=> 'ABCDEF',render(){calls.render++},toast(){},fmt:String,top:()=>'',esc:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),setTimeout:()=>1,clearTimeout(){},$:selector=>nodes.get(selector)||null,$$:selector=>groups.get(selector)||[],window:{localStorage:storage,VEZDEHOT_TAB_SESSION:{canWrite:()=>writable},VEZDEHOT:{loadMainState:()=>JSON.parse(local.get('vezdehot:lobby:v1:guest')||local.get('vezdehot:main:guest')||'{}'),updateProfile:p=>(Object.assign(profile,p),{...profile}),saveMainState:state=>local.set('vezdehot:lobby:v1:guest',JSON.stringify(state)),scopeKey:()=> 'guest'}}};
  vm.createContext(ctx);vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../dist/session-validation.js'),'utf8'),ctx);vm.runInContext(storeSource+sessions+engine+binding+'\nthis.api={load,save,chooseMainRoom,resumeMainGame,validateMainGame,startBunker,replayBunker,normalizeBunker,normalizeBunkerChoice,bunkerScenarioPreview,bunkerScenarioSetup,bunkerTeamSnapshot,bunkerComposition,bunkerDebrief,bunkerOutcome,bunkerRoom,bunkerView,bindRoom,bunkerHumanReveal,bunkerHumanVote,bunkerContinue,bunkerResolveVotes,bunkerCardValue,scenarios:bunkerScenarios,events:bunkerEvents};',ctx);
  return {ctx,a:ctx.api,local,nodes,groups,calls,setWritable:value=>writable=value,store:ctx.window.VEZDEHOT_GAME_STORE,start(choice='random'){ctx.s.game=null;ctx.s.balance=10000;ctx.api.startBunker({mode:'bunker',diff:'hard',scenarioChoice:choice});return ctx.s.game},load(){ctx.s=ctx.api.load();return ctx.s}};
}
let count=0;function test(name,fn){fn();count++;console.log('PASS '+name)}
test('ten scenarios and ten events cover all five priorities exactly twice',()=>{
  const h=harness();for(const catalog of [h.a.scenarios,h.a.events]){assert.equal(catalog.length,10);const counts={};for(const item of catalog)counts[item.focus]=(counts[item.focus]||0)+1;assert.deepEqual(counts,{survival:2,technical:2,food:2,medical:2,social:2})}
  assert.equal(new Set(h.a.scenarios.map(s=>s.code)).size,10);assert.equal(new Set(h.a.events.map(e=>e.title)).size,10);
  assert.deepEqual(Array.from(h.a.scenarios.slice(0,5),s=>s.code),['STORM / 07','BLACKOUT / 03','WINTER / 11','ASH / 05','STATION / 09']);
});
test('random selection has ten equal intervals and selected scenarios start with unchanged rules',()=>{
  const h=harness(),seen=[];for(let i=0;i<10;i++){h.ctx.Math.random=()=> (i+.5)/10;const g=h.start();seen.push(g.scenario.code);assert.equal(g.events.length,3);assert.equal(g.players.length,6);assert.equal(h.ctx.s.balance,9900)}
  assert.equal(new Set(seen).size,10);for(const scenario of h.a.scenarios){const g=h.start(scenario.code);assert.equal(g.scenario.code,scenario.code);assert.equal(h.ctx.s.room.scenarioChoice,scenario.code);assert.equal(g.version,2);assert.equal(g.stake,100);assert.equal(g.round,1);assert.equal(g.phase,'reveal');assert.equal(g.over,false)}
});
test('scenario and event bonuses remain exactly two and three and snapshots do not mutate catalogs',()=>{
  const h=harness(),g=h.start('ASH / 05');g.events[0].focus='medical';assert.equal(h.a.bunkerCardValue({score:7,tags:['medical']},g),12);assert.equal(h.a.bunkerCardValue({score:7,tags:['technical']},g),7);
  g.scenario.name='Changed saved snapshot';g.events[0].title='Changed saved event';assert(!h.a.scenarios.some(s=>s.name===g.scenario.name));assert(!h.a.events.some(e=>e.title===g.events[0].title));
});
test('scenario selector previews a new setting without changing or charging the current game',()=>{
  const h=harness(),g=h.start('STORM / 07'),before=JSON.stringify(g),balance=h.ctx.s.balance,select={value:'POLAR / 06'},preview={innerHTML:''};h.ctx.s.view='room';h.nodes.set('[data-bunker-scenario]',select);h.nodes.set('[data-bunker-scenario-preview]',preview);h.nodes.set('[data-start]',{});h.nodes.set('[data-resume-game]',{});h.a.bindRoom();const render=h.calls.render;select.onchange();assert.equal(h.ctx.s.room.scenarioChoice,'POLAR / 06');assert(preview.innerHTML.includes('110 дней'));assert(preview.innerHTML.includes('медицина'));assert.equal(JSON.stringify(g),before);assert.equal(h.ctx.s.balance,balance);assert.equal(h.calls.render,render);
  h.nodes.get('[data-resume-game]').onclick();assert.equal(h.ctx.s.game,g);assert.equal(g.scenario.code,'STORM / 07');assert.equal(h.ctx.s.view,'bunker');assert.equal(h.ctx.s.balance,balance);
});
test('blocked tabs cannot change scenario preferences or begin another game',()=>{
  const h=harness(),g=h.start('STORM / 07'),select={value:'POLAR / 06'};h.nodes.set('[data-bunker-scenario]',select);h.nodes.set('[data-start]',{});h.a.bindRoom();const disk=JSON.stringify([...h.local]);h.setWritable(false);select.onchange();h.a.startBunker({diff:'hard',scenarioChoice:'POLAR / 06'});assert.equal(h.ctx.s.game,g);assert.equal(h.ctx.s.room.scenarioChoice,'STORM / 07');assert.equal(select.value,'STORM / 07');assert.equal(JSON.stringify([...h.local]),disk);
});
test('room choice survives real-store reload and replay uses it while resume keeps its original scenario',()=>{
  const h=harness(),g=h.start('STORM / 07');h.ctx.s.room.scenarioChoice='HARVEST / 08';h.a.save();const restored=harness(h.local);restored.load();assert.equal(restored.ctx.s.room.scenarioChoice,'HARVEST / 08');assert.equal(restored.ctx.s.game.scenario.code,'STORM / 07');assert.equal(restored.ctx.s.game.id,g.id);
  Object.assign(restored.ctx.s.game,{over:true,settled:true,phase:'over',result:'lost'});const balance=restored.ctx.s.balance;restored.a.replayBunker();assert.equal(restored.ctx.s.game.scenario.code,'HARVEST / 08');assert.equal(restored.ctx.s.balance,balance-100);assert.equal(restored.ctx.s.game.phase,'reveal');
});
test('invalid or missing room choices normalize to random without changing saved scenarios',()=>{
  for(const value of [undefined,null,42,{},'UNKNOWN / 99','__proto__']){const h=harness(),g=h.start('STATION / 09');h.local.set('vezdehot:lobby:v1:guest',JSON.stringify({view:'bunker',activeGame:'bunker',room:{mode:'bunker',scenarioChoice:value}}));const next=harness(h.local);next.load();assert.equal(next.ctx.s.room.scenarioChoice,'random');assert.equal(next.ctx.s.game.scenario.code,g.scenario.code);assert.equal(next.a.normalizeBunkerChoice(value),'random')}
});
test('legacy main saves migrate their original scenario and current pending result unchanged',()=>{
  const h=harness(),g=h.start('ASH / 05');g.scenario.text='Original archived scenario wording';g.events[0].text='Original event wording';Object.assign(g,{over:true,settled:false,phase:'over',result:'lost'});g.players[0].alive=false;g.eliminated=[0];const local=new Map([['vezdehot:main:guest',JSON.stringify({game:g,view:'bunker',room:{mode:'bunker'}})]]),next=harness(local);next.load();assert.equal(next.ctx.s.game.version,2);assert.equal(next.ctx.s.game.settled,false);assert.equal(next.ctx.s.game.scenario.text,'Original archived scenario wording');assert.equal(next.ctx.s.game.events[0].text,'Original event wording');assert.equal(next.ctx.s.room.scenarioChoice,'random');assert.equal(next.store.peek('bunker','guest').state.settled,false);assert(local.has('vezdehot:main:guest'));
});
test('public composition counts people once per direction and excludes eliminated candidates',()=>{
  const h=harness(),g=h.start();g.players.forEach(p=>p.cards.forEach(c=>{c.revealed=false;c.tags=[]}));g.players[0].cards[0].revealed=true;g.players[0].cards[0].tags=['medical','medical'];g.players[0].cards[1].revealed=true;g.players[0].cards[1].tags=['medical'];g.players[1].cards[0].revealed=true;g.players[1].cards[0].tags=['technical'];g.players[2].cards[0].revealed=true;g.players[2].cards[0].tags=['medical','food'];g.players[2].alive=false;
  const team=h.a.bunkerTeamSnapshot(g);assert.equal(team.alive,5);assert.equal(team.covered,2);assert.deepEqual(Array.from(team.skills.find(s=>s.tag==='medical').names),['Ты']);assert.equal(team.skills.find(s=>s.tag==='food').names.length,0);assert(h.a.bunkerComposition(g).includes('Только Ты'));assert(h.a.bunkerComposition(g).includes('Пока не раскрыто'));
});
test('composition and final review never read unrevealed fields, even the human private dossier',()=>{
  const h=harness(),g=h.start();g.players.forEach(p=>p.cards.forEach(c=>{c.revealed=false;for(const key of ['title','score','tags'])Object.defineProperty(c,key,{get(){throw Error('Hidden '+key)},configurable:true})}));Object.assign(g,{over:true,phase:'over',result:'lost'});g.players[0].alive=false;
  assert.equal(h.a.bunkerTeamSnapshot(g).covered,0);assert.doesNotThrow(()=>h.a.bunkerComposition(g));assert.doesNotThrow(()=>h.a.bunkerDebrief(g));assert.doesNotThrow(()=>h.a.bunkerOutcome(g));
});
test('public composition and review are invariant under hidden permutations and escape names',()=>{
  const h=harness(),g=h.start();g.players[1].name='<img src=x>';g.players[1].cards[0].revealed=true;g.players[1].cards[0].tags=['medical'];Object.assign(g,{over:true,phase:'over',result:'lost'});g.players[0].alive=false;const before=h.a.bunkerDebrief(g);assert(before.includes('&lt;img src=x&gt;'));assert(!before.includes('<img'));
  for(let n=0;n<40;n++){g.players.forEach(p=>p.cards.filter(c=>!c.revealed).forEach(c=>{c.tags=n%2?['medical','technical','food','survival','social']:[];c.title='SECRET-'+n;c.score=n}));assert.equal(h.a.bunkerDebrief(g),before)}
});
test('early loss reports the actual stopping point and only recorded ballots, never a fictional final trio',()=>{
  const h=harness(),g=h.start();g.players[1].cards[0].revealed=true;g.players[1].cards[0].tags=['medical'];h.a.bunkerResolveVotes(g,[4,1,1,0,0,0],[{from:1,to:0},{from:2,to:0},{from:3,to:0},{from:4,to:0},{from:0,to:1},{from:5,to:2}]);h.a.bunkerContinue();const text=h.a.bunkerDebrief(g);assert.equal(g.round,1);assert.equal(g.players.filter(p=>p.alive).length,5);assert(text.includes('В игре оставалось 5 кандидатов'));assert(text.includes('следующие голосования не проводились'));assert(!text.includes('Три места заняты'));assert(text.includes('4 голоса'));assert(text.includes('Кто за кого голосовал'));assert(!text.includes('Раунд 2'));assert(!text.includes('%'));
});
test('a completed three-vote survival reviews only the remaining public skills and factual eliminations',()=>{
  const h=harness(),g=h.start();for(let round=1;round<=3;round++){g.round=round;g.players.forEach(p=>{if(p.alive){p.cards[round-1].revealed=true;p.cards[round-1].revealedRound=round}});const tally=Array(6).fill(0);tally[round]=g.players.filter(p=>p.alive).length;h.a.bunkerResolveVotes(g,tally,[]);h.a.bunkerContinue()}assert.equal(g.result,'survived');assert.equal(g.players.filter(p=>p.alive).length,3);assert.equal(g.voteLog.length,3);const text=h.a.bunkerDebrief(g);assert(text.includes('Три места заняты'));assert(text.includes('Раунд 3'));assert(text.includes('Имена голосовавших не сохранились'));assert(!text.includes('следующие голосования не проводились'));assert(!text.includes('%'));assert.equal(h.a.bunkerTeamSnapshot(g).alive,3);
});
test('setup has a labelled native selector, one random default and priority-duration previews',()=>{
  const h=harness();h.ctx.s.game=null;const markup=h.a.bunkerRoom({diff:'normal'});assert(markup.includes('for="bunker-scenario-choice"'));assert(markup.includes('value="random" selected'));assert.equal((markup.match(/<option /g)||[]).length,11);assert.equal((markup.match(/<optgroup /g)||[]).length,5);assert(markup.includes('aria-describedby="bunker-scenario-preview"'));assert(markup.includes('Длительность — часть истории, а не таймер'));assert(h.a.bunkerScenarioPreview('POLAR / 06').includes('110 дней'));
});
console.log(count+' Bunker scenario and public composition checks passed');
