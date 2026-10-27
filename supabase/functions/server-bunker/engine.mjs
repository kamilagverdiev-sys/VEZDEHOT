import {createCore} from './core.mjs';

export class GameError extends Error {
  constructor(code,status=422){super(code);this.code=code;this.status=status;}
}
export const secureRandom=()=>crypto.getRandomValues(new Uint32Array(1))[0]/4294967296;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const catalog=createCore({random:()=>.5});
export const SCENARIO_CHOICES=Object.freeze(['random',...catalog.bunkerScenarios.map(s=>s.code)]);
const TYPES=Object.freeze(catalog.bunkerTypes.map(([type])=>type));
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const integer=(v,min,max)=>Number.isInteger(v)&&v>=min&&v<=max;
function same(a,b){
  if(a===b)return true;
  if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((value,i)=>same(value,b[i]));
  if(!object(a)||!object(b))return false;
  const keys=Object.keys(a);
  return keys.length===Object.keys(b).length&&keys.every(key=>Object.hasOwn(b,key)&&same(a[key],b[key]));
}
const invalid=()=>{throw new GameError('invalid_server_state',503);};
const fail=code=>{throw new GameError(code);};
const economyKeys=['version','stake','settled','payout','xp','outcome'];
function economyFor(g,stake){
  const outcome=!g.over?null:g.resigned?'resigned':g.result==='survived'?'win':'loss';
  return {version:1,stake,settled:g.over,payout:stake&&outcome==='win'?250:0,xp:stake?({win:120,loss:25}[outcome]||0):0,outcome};
}

export function assertIntegrity(g){
  if(!object(g)||g.version!==2||typeof g.id!=='string'||!UUID.test(g.id)||!['easy','normal','hard'].includes(g.diff)||!SCENARIO_CHOICES.includes(g.scenarioChoice)||![0,100].includes(g.stake)||!integer(g.round,1,3)||!['reveal','vote','voteResult','over'].includes(g.phase)||typeof g.over!=='boolean'||g.over!==(g.phase==='over')||typeof g.resigned!=='boolean'||g.resigned&&!g.over||g.settled!==g.over||!Array.isArray(g.players)||g.players.length!==6)invalid();
  const scenario=catalog.bunkerScenarios.find(s=>s.code===g.scenario?.code);
  if(!scenario||!same(scenario,g.scenario)||g.scenarioChoice!=='random'&&g.scenarioChoice!==g.scenario.code||!Array.isArray(g.events)||g.events.length!==3||new Set(g.events.map(e=>e?.title)).size!==3||g.events.some(e=>!catalog.bunkerEvents.some(known=>same(known,e))))invalid();
  for(let seat=0;seat<6;seat++){
    const p=g.players[seat];
    if(!object(p)||typeof p.name!=='string'||p.name.length>24||typeof p.face!=='string'||p.kind!==(seat?'bot':'human')||typeof p.alive!=='boolean'||seat&&!['pragmatic','team','focused'].includes(p.botStyle)||!Array.isArray(p.cards)||p.cards.length!==6||new Set(p.cards.map(c=>c?.type)).size!==6)invalid();
    const rounds=[];
    for(const c of p.cards){
      const definition=catalog.bunkerTypes.find(([type])=>type===c?.type);
      if(!definition||c.icon!==definition[1]||c.label!==definition[2]||typeof c.revealed!=='boolean'||!Array.isArray(c.tags)||!catalog.bunkerPools[c.type].some(([title,score,tags])=>c.title===title&&c.score===score&&same(c.tags,tags))||c.revealed&&!integer(c.revealedRound,1,g.round)||!c.revealed&&c.revealedRound!==undefined)invalid();
      if(c.revealed)rounds.push(c.revealedRound);
    }
    rounds.sort((a,b)=>a-b);if(rounds.some((round,i)=>round!==i+1))invalid();
  }
  for(const type of TYPES)if(new Set(g.players.map(p=>p.cards.find(c=>c.type===type).title)).size!==6)invalid();
  if(!Array.isArray(g.eliminated)||!Array.isArray(g.voteLog)||g.voteLog.length>3||g.eliminated.length!==g.voteLog.length)invalid();
  const alive=new Set([0,1,2,3,4,5]);
  for(let n=0;n<g.voteLog.length;n++){
    const v=g.voteLog[n];
    if(!object(v)||v.round!==n+1||!alive.has(v.out)||v.out!==g.eliminated[n]||!Array.isArray(v.ballots)||v.ballots.length!==alive.size||new Set(v.ballots.map(b=>b?.from)).size!==alive.size||!Array.isArray(v.votes)||v.votes.length!==6||!Array.isArray(v.tied))invalid();
    const tally=Array(6).fill(0);
    for(const ballot of v.ballots){if(!object(ballot)||!alive.has(ballot.from)||!alive.has(ballot.to)||ballot.from===ballot.to)invalid();tally[ballot.to]++;}
    const max=Math.max(...[...alive].map(i=>tally[i])),tied=[...alive].filter(i=>tally[i]===max);
    if(!same(tally,v.votes)||v.count!==max||!same(tied,v.tied)||!tied.includes(v.out))invalid();
    alive.delete(v.out);
    if(!alive.has(0)&&n<g.voteLog.length-1)invalid();
  }
  if(g.players.some((p,i)=>p.alive!==alive.has(i)))invalid();
  const last=g.voteLog.at(-1);
  if(last){const {votes,...expected}=last;if(!same(g.lastVote,expected))invalid();}
  else if(g.lastVote!==undefined&&g.lastVote!==null)invalid();
  if(g.votes!==null&&(!last||!same(g.votes,last.votes)))invalid();
  if(['reveal','vote'].includes(g.phase)&&(g.voteLog.length!==g.round-1||g.votes!==null||!alive.has(0)||alive.size<=3))invalid();
  if(g.phase==='voteResult'&&(g.voteLog.length!==g.round||!same(g.votes,last?.votes)))invalid();
  if(!g.over&&g.result!==null)invalid();
  if(g.over){
    if(g.resigned){if(g.result!=='lost'||!alive.has(0)||alive.size<=3||![g.round-1,g.round].includes(g.voteLog.length))invalid();}
    else if(!['survived','lost'].includes(g.result)||alive.has(0)&&alive.size!==3||g.voteLog.length!==g.round||!same(g.votes,last?.votes)||g.result!==(alive.has(0)?'survived':'lost'))invalid();
  }
  for(let seat=0;seat<6;seat++){
    const p=g.players[seat],elimination=g.voteLog.find(v=>v.out===seat),revealed=p.cards.filter(c=>c.revealed).length;
    if(elimination){if(revealed!==elimination.round)invalid();}
    else if(g.resigned){if(![g.round-1,g.round].includes(revealed))invalid();}
    else if(revealed!==(g.phase==='reveal'?g.round-1:g.round))invalid();
  }
  if(g.resigned&&new Set(g.players.filter(p=>p.alive).map(p=>p.cards.filter(c=>c.revealed).length)).size!==1)invalid();
  if(!object(g.economy)||Object.keys(g.economy).length!==economyKeys.length||economyKeys.some(k=>g.economy[k]!==economyFor(g,g.stake)[k]))invalid();
}

export function createGame({difficulty='normal',scenarioChoice='random',nick='Ты',id=crypto.randomUUID(),stake=0}={},random=secureRandom){
  if(!['easy','normal','hard'].includes(difficulty)||!SCENARIO_CHOICES.includes(scenarioChoice)||![0,100].includes(stake)||typeof id!=='string'||!UUID.test(id)||typeof nick!=='string')throw new GameError('invalid_request',400);
  const name=nick.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,24)||'Ты';
  const core=createCore({random,id,nick:name}),g=core.newGame({diff:difficulty,scenarioChoice});
  g.scenarioChoice=scenarioChoice;g.stake=stake;g.resigned=false;g.economy=economyFor(g,stake);
  assertIntegrity(g);return g;
}
const terminalReview=g=>g.phase==='voteResult'&&(!g.players[0].alive||g.players.filter(p=>p.alive).length===3);
export function legalActions(g){
  if(g.over)return {actions:[],cards:[],targets:[]};
  if(terminalReview(g))return {actions:['continue'],cards:[],targets:[]};
  if(g.phase==='reveal')return {actions:['reveal','resign'],cards:g.players[0].cards.filter(c=>!c.revealed).map(c=>c.type),targets:[]};
  if(g.phase==='vote')return {actions:['vote','resign'],cards:[],targets:g.players.map((p,i)=>p.alive&&i?i:null).filter(i=>i!==null)};
  return {actions:['continue','resign'],cards:[],targets:[]};
}
export function applyAction(state,action,random=secureRandom){
  assertIntegrity(state);
  if(!object(action)||!['reveal','vote','continue','resign'].includes(action.type))throw new GameError('invalid_request',400);
  const keys=action.type==='reveal'?['type','cardType']:action.type==='vote'?['type','target']:['type'];
  if(Object.keys(action).length!==keys.length||Object.keys(action).some(k=>!keys.includes(k))||action.type==='reveal'&&!TYPES.includes(action.cardType)||action.type==='vote'&&!integer(action.target,1,5))throw new GameError('invalid_request',400);
  if(action.type==='resign'&&terminalReview(state))action={type:'continue'};
  const legal=legalActions(state);
  if(!legal.actions.includes(action.type))fail('illegal_action');
  if(action.type==='reveal'&&!legal.cards.includes(action.cardType))fail('illegal_card');
  if(action.type==='vote'&&!legal.targets.includes(action.target))fail('illegal_target');
  const g=structuredClone(state),core=createCore({random});
  if(action.type==='reveal')core.reveal(g,action.cardType);
  else if(action.type==='vote')core.vote(g,action.target);
  else if(action.type==='continue')core.continue(g);
  else Object.assign(g,{over:true,phase:'over',result:'lost',resigned:true,settled:true});
  g.economy=economyFor(g,g.stake);
  if(g.over)g.message=g.resigned?'Ты завершил партию. Можно начать новую.':g.result==='survived'?'Ты занял одно из трёх мест в бункере.':'Тебя исключили голосованием. Итог партии сохранён.';
  assertIntegrity(g);return g;
}
function publicCard(c,g,visible){
  const basic={type:c.type,icon:c.icon,label:c.label,revealed:c.revealed};
  return visible?{...basic,title:c.title,score:c.score,tags:[...c.tags],value:catalog.bunkerCardValue(c,g),...(c.revealed?{revealedRound:c.revealedRound}:{})}:basic;
}
const publicVote=v=>v?{out:v.out,round:v.round,tied:[...v.tied],count:v.count,ballots:v.ballots.map(b=>({from:b.from,to:b.to}))}:null;
export function projectGame(g){
  if(!g)return null;
  assertIntegrity(g);
  return {
    id:g.id,version:g.version,phase:g.phase,round:g.round,difficulty:g.diff,scenarioChoice:g.scenarioChoice,
    scenario:{...g.scenario},currentEvent:{...catalog.bunkerEvent(g)},
    players:g.players.map((p,i)=>({name:p.name,face:p.face,kind:p.kind,alive:p.alive,...(i?{botStyle:p.botStyle}:{}),score:catalog.bunkerScore(p,g),cards:p.cards.map(c=>publicCard(c,g,i===0||c.revealed))})),
    votes:g.votes?[...g.votes]:null,lastVote:publicVote(g.lastVote),voteLog:g.voteLog.map(v=>({...publicVote(v),votes:[...v.votes]})),eliminated:[...g.eliminated],
    message:g.message,over:g.over,result:g.result,resigned:g.resigned,economy:{...g.economy},legal:legalActions(g)
  };
}
