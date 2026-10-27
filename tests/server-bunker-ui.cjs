const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const ctx={window:{},document:{getElementById:()=>null},Object,JSON,Number,Set,Error,Promise};vm.createContext(ctx);vm.runInContext(fs.readFileSync('dist/server-bunker.js','utf8'),ctx);
const ui=ctx.window.VEZDEHOT_SERVER_BUNKER;let engine;
test.before(async()=>{engine=await import('../supabase/functions/server-bunker/engine.mjs');});
const ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function initial(stake=0){return engine.createGame({id:ID,stake},()=>.5);}
const publicGame=g=>engine.projectGame(g),ready=g=>({game:g,ready:true,busy:false,pending:false});
test('selecting a trait creates only an explicit reveal intent with an understandable disclosure',()=>{
 const g=publicGame(initial()),before=JSON.stringify(g);assert.equal(ui.selectedIntent(ready(g),null),null);assert.deepEqual(JSON.parse(JSON.stringify(ui.selectedIntent(ready(g),'profession'))),{type:'reveal',cardType:'profession'});assert(ui.selectionText(g,'profession').includes(g.players[0].cards[0].title));assert.match(ui.selectionText(g,'profession'),/Соперники увидят/);assert.equal(JSON.stringify(g),before);
 for(const state of [{...ready(g),busy:true},{...ready(g),pending:true},{...ready(g),ready:false}])assert.equal(ui.selectedIntent(state,'profession'),null);
});
test('vote selection only targets living opponents and does not apply a ballot before confirmation',()=>{
 const internal=engine.applyAction(initial(),{type:'reveal',cardType:'profession'},()=>.5),g=publicGame(internal),before=JSON.stringify(g);assert.equal(ui.selectedIntent(ready(g),0),null);assert.equal(ui.selectedIntent(ready(g),6),null);assert.deepEqual(JSON.parse(JSON.stringify(ui.selectedIntent(ready(g),1))),{type:'vote',target:1});assert(ui.selectionText(g,1).includes(g.players[1].name));assert.match(ui.selectionText(g,1),/Подтверди/);assert.equal(JSON.stringify(g),before);
});
test('candidate rendering never reads hidden card traits or exposes them in markup',()=>{
 let internal=engine.applyAction(initial(),{type:'reveal',cardType:'profession'},()=>.5),g=publicGame(internal),p=g.players[1];for(const c of p.cards.filter(c=>!c.revealed)){for(const key of ['title','tags','score','value'])Object.defineProperty(c,key,{get(){throw Error('Hidden value read: '+key)}})}
 const html=ui.candidateMarkup(p,1,g,true,1);assert.match(html,/aria-pressed="true"/);assert.match(html,/Выбран для голоса/);assert.match(html,/Скрыто: 5 из 6/);assert(html.includes(p.cards.find(c=>c.revealed).title));
});
test('card details show exact base and two bonuses, and escape titles',()=>{
 const g=publicGame(initial()),c=g.players[0].cards[0];c.title='<script>bad</script>';c.tags=['medical'];g.scenario.focus='medical';g.currentEvent.focus='medical';c.score=7;c.value=12;const html=ui.cardMarkup(c,g,true,'profession');assert(!html.includes('<script>'));assert(html.includes('&lt;script&gt;'));assert.match(html,/База 7 · сценарий \+2 · событие \+3/);assert.match(html,/\+5 бонус/);assert.match(html,/aria-pressed="true"/);assert.match(html,/Только тебе/);
});
test('vote result explains the real tie and lists each recorded ballot',()=>{
 const g=publicGame(initial());g.players[1].name='<img src=x>';g.lastVote={round:1,out:1,count:2,tied:[1,2],ballots:[{from:0,to:1},{from:1,to:2},{from:2,to:1},{from:3,to:2},{from:4,to:5},{from:5,to:4}]};const html=ui.voteResultMarkup(g);assert.match(html,/2 голоса против/);assert.match(html,/Равная жеребьёвка/);assert.match(html,/Кто за кого голосовал/);assert.match(html,/· ты/);assert(!html.includes('<img'));assert(html.includes('&lt;img'));assert.equal((html.match(/<li>/g)||[]).length,6);
});
test('paid victory separates returned coins from profit while free result has no rewards',()=>{
 const g=publicGame(initial());g.over=true;g.phase='over';g.result='survived';g.players.forEach((p,i)=>p.alive=i<3);g.economy={version:1,stake:100,settled:true,payout:250,xp:120,outcome:'win'};let html=ui.outcomeMarkup(g);assert.match(html,/250 V/);assert.match(html,/\+150 V/);assert.match(html,/\+120 XP/);assert.match(html,/Ещё партия · 100 V/);assert(html.includes(g.players[1].name));assert(!html.includes(g.players[4].name));g.economy={version:1,stake:0,settled:true,payout:0,xp:0,outcome:'win'};html=ui.outcomeMarkup(g);assert.match(html,/Бесплатная практика/);assert.match(html,/монеты и XP не меняются/);assert(!html.includes('+120'));assert.match(html,/Ещё партия · бесплатно/);
});
test('terminal voting review asks for settlement before allowing a new party',()=>{
 const g=publicGame(initial());g.phase='voteResult';g.players[0].alive=false;g.legal={actions:['continue'],cards:[],targets:[]};assert.match(ui.selectionText(g,null),/Завершить партию/);assert.equal(ui.selectedIntent(ready(g),1),null);
});
test('early resignation text distinguishes it from a lost vote and awards no XP',()=>{
 const g=publicGame(engine.applyAction(initial(100),{type:'resign'},()=>.5));const html=ui.outcomeMarkup(g);assert.match(html,/по твоему решению/);assert.match(html,/-100 V/);assert.match(html,/\+0 XP/);assert(!html.includes('Группа проголосовала'));
});
test('projection accepts full real party lifecycle with public DTO at every phase',()=>{
 for(let n=0;n<40;n++){let seed=n+3;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);let g=engine.createGame({id:ID,stake:n%2?100:0,difficulty:['easy','normal','hard'][n%3]},random);for(let round=0;round<12&&!g.over;round++){const pub=publicGame(g);assert.doesNotThrow(()=>ui.projection({status:'ok',revision:round,game:pub}));const a=pub.legal.actions.includes('reveal')?{type:'reveal',cardType:pub.legal.cards[0]}:pub.legal.actions.includes('vote')?{type:'vote',target:pub.legal.targets[0]}:{type:'continue'};g=engine.applyAction(g,a,random);}assert(g.over);assert.doesNotThrow(()=>ui.projection({status:'ok',revision:12,game:publicGame(g)}));}
});
