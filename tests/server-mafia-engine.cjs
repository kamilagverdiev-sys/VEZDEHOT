const {test}=require('node:test'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const modulePromise=import('../supabase/functions/server-mafia/engine.mjs'),corePromise=import('../supabase/functions/server-mafia/core.mjs');
const seedRng=(seed=1)=>()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
const copy=v=>structuredClone(v);
const move=m=>g=>{const l=m.legalActions(g);return {type:l.actions[0],...(l.targets.length?{target:l.targets[0]}:{})};};
async function roleGame(role,stake=100){const m=await modulePromise;for(let i=1;i<500;i++){const rng=seedRng(i),g=m.createGame({stake},rng);if(g.players[0].role===role)return {m,g,rng};}throw Error('role missing');}
function privacy(g,p){
 for(const key of ['state','nightTarget','dayTarget','lastDoctorTarget','revealed','publicSuspicion','mafiaAlive','townAlive','diff'])assert(!Object.hasOwn(p,key),key);
 for(let i=0;i<7;i++){const person=g.players[i],visible=i===0||!person.alive||g.over||g.players[0].role==='mafia'&&person.role==='mafia';assert.equal(p.players[i].role,visible?person.role:null);assert.deepEqual(Object.keys(p.players[i]).sort(),['alive','id','kind','name','role']);}
 assert.deepEqual(p.knowledge,g.players[0].role==='detective'?g.knowledge[0]||{}:{});assert.equal(p.voteFacts!==null,g.over);
}
test('Mafia generated core exactly matches canonical source',()=>{execFileSync(process.execPath,['scripts/sync-server-mafia-core.cjs','--check'],{cwd:require('node:path').join(__dirname,'..')});});
test('Mafia deals seven unique seats with exact role distribution and rejects forged options',async()=>{
 const m=await modulePromise,g=m.createGame({nick:'  \u0000Игрок\n ',stake:100},seedRng(42));assert.equal(g.players[0].name,'Игрок');assert.equal(g.phase,'night');assert.equal(g.version,3);assert.equal(g.players.filter(p=>p.role==='mafia').length,2);assert.equal(g.economy.stake,100);
 for(const options of [{difficulty:'bad'},{stake:1},{stake:'100'},{id:'unsafe'},{nick:null}])assert.throws(()=>m.createGame(options),{code:'invalid_request'});
 for(const role of ['mafia','doctor','detective','civilian']){const {g}=await roleGame(role);privacy(g,m.projectGame(g));}
});
test('Mafia rejects wrong phases, invalid target, role selection and extra fields atomically',async()=>{
 const {m,g,rng}=await roleGame('mafia'),before=copy(g),ally=g.players.find(p=>p.id&&p.role==='mafia').id;
 for(const action of [{type:'vote',target:1},{type:'continue'},{type:'finish'},{type:'night'},{type:'night',target:ally},{type:'night',target:0},{type:'night',target:99},{type:'night',target:'1'},{type:'night',target:m.legalActions(g).targets[0],role:'civilian'},{type:'resign',payout:250},{type:'mark',target:0,mark:'trust'}])assert.throws(()=>m.applyAction(g,action,rng));
 assert.deepEqual(g,before);
 const c=await roleGame('civilian');assert.deepEqual(m.legalActions(c.g).targets,[]);assert.throws(()=>m.applyAction(c.g,{type:'night',target:1},c.rng));assert.notEqual(m.applyAction(c.g,{type:'night'},c.rng).phase,'night');
});
test('Mafia personal marks synchronize without advancing phases, consuming random or changing economy',async()=>{
 const {m,g}=await roleGame('detective');const never=()=>{throw Error('mark consumed random')};
 const marked=m.applyAction(g,{type:'mark',target:3,mark:'suspect'},never);assert.equal(marked.phase,g.phase);assert.equal(marked.round,g.round);assert.deepEqual(marked.economy,g.economy);assert.equal(m.projectGame(marked).personalMarks[3],'suspect');
 assert.deepEqual(m.applyAction(marked,{type:'mark',target:3,mark:''},never),g);assert.deepEqual(g.personalMarks,{});
});
test('Mafia detective sees only own binary investigation while precise living role stays secret',async()=>{
 const {m,g,rng}=await roleGame('detective'),target=g.players.find(p=>p.role==='doctor').id;
 const next=m.applyAction(g,{type:'night',target},rng),p=m.projectGame(next);assert.equal(p.knowledge[target],'town');if(next.players[target].alive&&!next.over)assert.equal(p.players[target].role,null);assert.equal(p.privateNotes.length,1);privacy(next,p);
 for(const ownRole of ['doctor','civilian','mafia']){const r=await roleGame(ownRole);let state=r.m.applyAction(r.g,move(r.m)(r.g),r.rng);assert.deepEqual(r.m.projectGame(state).knowledge,{});}
});
test('Mafia projections never use randomness, expose bot knowledge or retain nested private fields',async()=>{
 const {m,g,rng}=await roleGame('detective');let s=g;for(let i=0;i<5&&!s.over;i++)s=m.applyAction(s,move(m)(s),rng);
 s.statements.forEach(v=>v.privateRole='mafia');s.voteHistory.forEach(v=>v.botKnowledge={secret:true});const projected=m.projectGame(s);assert(!JSON.stringify(projected).includes('privateRole'));assert(!JSON.stringify(projected).includes('botKnowledge'));privacy(s,projected);
 projected.players[0].name='changed';projected.personalMarks[1]='trust';assert.notEqual(s.players[0].name,'changed');assert.deepEqual(s.personalMarks,{});
});
test('Mafia 600 seeded games finish with legal public states across roles, levels and stakes',async()=>{
 const m=await modulePromise,roles=new Set(),outcomes=new Set();let spectatorWins=0;
 for(let seed=1;seed<=600;seed++){
  const rng=seedRng(seed);let g=m.createGame({difficulty:['easy','normal','hard'][seed%3],stake:seed%2?100:0},rng);roles.add(g.players[0].role);
  for(let steps=0;!g.over&&steps<150;steps++){const l=m.legalActions(g),type=!g.players[0].alive&&seed%3===0?'finish':l.actions[0];g=m.applyAction(g,{type,...(l.targets.length?{target:l.targets[Math.floor(rng()*l.targets.length)]}:{})},rng);m.assertIntegrity(g);privacy(g,m.projectGame(g));}
  assert(g.over);outcomes.add(g.economy.outcome);if(!g.players[0].alive&&g.win)spectatorWins++;
  assert.equal(g.economy.payout,g.stake&&g.win?250:0);assert.equal(g.economy.xp,g.stake?(g.win?130:25):0);assert.deepEqual(m.legalActions(g),{actions:[],targets:[],marks:[]});assert.throws(()=>m.applyAction(g,{type:'resign'}));
 }
 assert.equal(roles.size,4);assert(outcomes.has('win'));assert(outcomes.has('loss'));assert(spectatorWins>0);
});
test('Mafia 80 full games match canonical action transitions and RNG exactly',async()=>{
 const m=await modulePromise,{mafiaCore}=await corePromise;
 for(let seed=1;seed<=80;seed++){
  let game=m.createGame({},seedRng(seed)),canonical=copy(game);const a=seedRng(seed*17),b=seedRng(seed*17);
  for(let steps=0;!game.over&&steps<150;steps++){
   const action=move(m)(game),core=mafiaCore(canonical,b);
   if(action.type==='night'){if(action.target!==undefined)core.chooseNight(action.target);core.confirmNight();}
   else if(action.type==='vote'){if(action.target!==undefined)core.chooseVote(action.target);core.castVote();}
   else core[({dawn:'beginDay',day:'beginVote',voteResult:'continueAfterVote'})[canonical.phase]]();
   game=m.applyAction(game,action,a);
   for(const key of ['players','round','phase','over','winningTeam','win','draw','resultReason','message','nightText','nightTarget','dayTarget','votes','ballots','voteHistory','eliminated','statements','statementsRound','knowledge','privateNotes','lastDoctorTarget','log','revealed'])assert.deepEqual(game[key],canonical[key],`seed ${seed} ${key}`);
  }
  assert(game.over);assert.equal(a(),b());
 }
});
test('Mafia spectator finish equals sequential canonical observation and preserves team rewards',async()=>{
 const m=await modulePromise;
 for(let seed=1,count=0;seed<=300&&count<25;seed++){
  const rng=seedRng(seed);let g=m.createGame({stake:100},rng);while(!g.over&&g.players[0].alive)g=m.applyAction(g,move(m)(g),rng);if(g.over)continue;count++;
  const quick=m.applyAction(g,{type:'finish'},seedRng(77)),manualRng=seedRng(77);let manual=copy(g);while(!manual.over)manual=m.applyAction(manual,move(m)(manual),manualRng);assert.deepEqual(quick,manual);
 }
});
test('Mafia round 25 tie settles as draw only after review continue, with exact refund',async()=>{
 const m=await modulePromise,g=m.createGame({stake:100},seedRng(1));const ballots=[{voter:0,target:1},{voter:1,target:0},{voter:2,target:0},{voter:3,target:0},{voter:4,target:1},{voter:5,target:1},{voter:6,target:2}];
 g.round=25;g.phase='voteResult';g.voteHistory=Array.from({length:25},(_,i)=>({round:i+1,ballots:copy(ballots),eliminated:null,message:'Голоса разделились.'}));g.ballots=copy(ballots);g.votes={0:3,1:3,2:1,3:0,4:0,5:0,6:0};m.assertIntegrity(g);
 const result=m.applyAction(g,{type:'continue'},seedRng(1));assert(result.draw);assert.equal(result.winningTeam,'draw');assert.deepEqual(result.economy,{version:1,stake:100,settled:true,payout:100,xp:40,outcome:'draw'});
 const early=copy(result);early.round=24;assert.throws(()=>m.assertIntegrity(early),{code:'invalid_server_state'});
});
test('Mafia resignation is an explicit loss without XP and free mode never awards value',async()=>{
 const m=await modulePromise;for(const stake of [0,100]){const g=m.applyAction(m.createGame({stake},seedRng(1)),{type:'resign'});assert(g.resigned&&g.over);assert.equal(g.winningTeam,null);assert(!g.win&&!g.draw);assert.deepEqual(g.economy,{version:1,stake,settled:true,payout:0,xp:0,outcome:'resigned'});}
});
test('Mafia persisted JSONB object key ordering does not invalidate states',async()=>{
 const {m,g,rng}=await roleGame('detective');let state=g;for(let i=0;i<5&&!state.over;i++)state=m.applyAction(state,move(m)(state),rng);
 const reorder=v=>Array.isArray(v)?v.map(reorder):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).reverse().map(k=>[k,reorder(v[k])])):v;
 m.assertIntegrity(reorder(state));assert.deepEqual(m.projectGame(reorder(state)),m.projectGame(state));
});
test('Mafia integrity rejects forged rewards, premature knowledge, impossible roles and deaths',async()=>{
 const {m,g}=await roleGame('detective');const bad=[];
 for(const edit of [s=>s.economy.xp=130,s=>s.win=true,s=>s.players[1].role=s.players[0].role,s=>s.phase='result',s=>s.knowledge[0]={[s.players.find(p=>p.id&&p.role==='mafia').id]:'mafia'},s=>{s.players[1].alive=false;s.players[2].alive=false;s.revealed=[1,2]},s=>s.economy={...s.economy,secret:1}]){const s=copy(g);edit(s);bad.push(s);}
 for(const s of bad)assert.throws(()=>m.assertIntegrity(s),{code:'invalid_server_state'});
});
