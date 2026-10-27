import {mafiaCore,mafiaNewState,roleInfo} from './core.mjs';
export class GameError extends Error {constructor(code,status=422){super(code);this.code=code;this.status=status;}}
export const secureRandom=()=>crypto.getRandomValues(new Uint32Array(1))[0]/4294967296;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES=['mafia','detective','doctor','civilian'],PHASES=['night','dawn','day','vote','voteResult','result'],MARKS=['','suspect','unsure','trust'];
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v),integer=(v,min,max)=>Number.isInteger(v)&&v>=min&&v<=max,seat=v=>integer(v,0,6),text=(v,max=1000)=>typeof v==='string'&&v.length<=max;
const invalid=()=>{throw new GameError('invalid_server_state',503);};
function same(a,b){if(a===b)return true;if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>same(v,b[i]));if(!object(a)||!object(b))return false;const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]));}
function economyFor(g){const outcome=!g.over?null:g.resigned?'resigned':g.draw?'draw':g.win?'win':'loss';return {version:1,stake:g.stake,settled:g.over,payout:g.stake?({win:250,draw:100}[outcome]||0):0,xp:g.stake?({win:130,draw:40,loss:25}[outcome]||0):0,outcome};}
function ballotsValid(ballots){return Array.isArray(ballots)&&ballots.length>=2&&ballots.length<=7&&new Set(ballots.map(b=>b?.voter)).size===ballots.length&&ballots.every(b=>object(b)&&Object.keys(b).length===2&&seat(b.voter)&&seat(b.target)&&b.voter!==b.target&&ballots.some(v=>v.voter===b.target));}
export function assertIntegrity(g){
 if(!object(g)||g.version!==3||!UUID.test(g.id)||!['easy','normal','hard'].includes(g.diff)||![0,100].includes(g.stake)||!integer(g.round,1,25)||!PHASES.includes(g.phase)||typeof g.over!=='boolean'||g.over!==(g.phase==='result')||typeof g.resigned!=='boolean'||g.resigned&&!g.over||g.settled!==g.over||typeof g.win!=='boolean'||typeof g.draw!=='boolean'||!Array.isArray(g.players)||g.players.length!==7)invalid();
 for(let i=0;i<7;i++){const p=g.players[i];if(!object(p)||p.id!==i||!text(p.name,24)||!p.name||p.kind!==(i?'bot':'human')||typeof p.alive!=='boolean'||!ROLES.includes(p.role))invalid();}
 if(ROLES.some((r,i)=>g.players.filter(p=>p.role===r).length!==[2,1,1,3][i]))invalid();
 const living=g.players.filter(p=>p.alive),mafia=living.filter(p=>p.role==='mafia').length,town=living.length-mafia,team=mafia===0?'town':mafia>=town?'mafia':null;
 if(!g.over&&(team!==null||g.winningTeam!==null||g.win||g.draw||g.resultReason!==null))invalid();
 if(g.over){if(!text(g.resultReason)||!g.resultReason)invalid();if(g.resigned){if(team!==null||g.winningTeam!==null||g.win||g.draw)invalid();}else{if(!['town','mafia','draw'].includes(g.winningTeam)||g.draw!==(g.winningTeam==='draw')||g.win!==(g.winningTeam===roleInfo[g.players[0].role].team)||g.draw&&(team!==null||g.round!==25)||!g.draw&&team!==g.winningTeam)invalid();}}
 if(!Array.isArray(g.revealed)||new Set(g.revealed).size!==g.revealed.length||g.revealed.some(i=>!seat(i)||g.players[i].alive)||g.players.some(p=>!p.alive&&!g.revealed.includes(p.id)))invalid();
 if(![null,...Array.from({length:7},(_,i)=>i)].includes(g.nightTarget)||! [null,...Array.from({length:7},(_,i)=>i)].includes(g.dayTarget)||g.nightTarget!==null)invalid();
 if(!object(g.knowledge)||!object(g.lastDoctorTarget)||!object(g.personalMarks)||!object(g.publicSuspicion))invalid();
 for(const [id,known] of Object.entries(g.knowledge)){if(!/^[0-6]$/.test(id)||g.players[+id].role!=='detective'||!object(known)||Object.keys(known).length>(g.phase==='night'?g.round-1:g.round))invalid();for(const [target,result] of Object.entries(known))if(!/^[0-6]$/.test(target)||target===id||result!==(g.players[+target].role==='mafia'?'mafia':'town'))invalid();}
 for(const [id,target] of Object.entries(g.lastDoctorTarget))if(!/^[0-6]$/.test(id)||g.players[+id].role!=='doctor'||!seat(target))invalid();
 for(const [id,mark] of Object.entries(g.personalMarks))if(!/^[1-6]$/.test(id)||!MARKS.slice(1).includes(mark))invalid();
 if(!Array.isArray(g.privateNotes)||g.privateNotes.length>6||g.privateNotes.some(v=>!text(v))||g.players[0].role!=='detective'&&g.privateNotes.length||g.privateNotes.length!==Object.keys(g.knowledge[0]||{}).length||!Array.isArray(g.log)||g.log.length>40||g.log.some(v=>!text(v))||!text(g.message)||!text(g.nightText))invalid();
 if(!Array.isArray(g.voteHistory)||g.voteHistory.length>25||!Array.isArray(g.ballots)||!Array.isArray(g.statements)||g.statements.length>6||!(g.statementsRound===null||integer(g.statementsRound,1,g.round))||!(g.eliminated===null||seat(g.eliminated)))invalid();
 let previousElectorate=new Set([0,1,2,3,4,5,6]);
 const eliminated=new Set();
 for(let i=0;i<g.voteHistory.length;i++){
  const h=g.voteHistory[i];if(!object(h)||h.round!==i+1||!ballotsValid(h.ballots)||!text(h.message)||!(h.eliminated===null||seat(h.eliminated)))invalid();
  const electorate=new Set(h.ballots.map(b=>b.voter));if([...electorate].some(id=>!previousElectorate.has(id)||eliminated.has(id))||previousElectorate.size-electorate.size>1)invalid();
  const tally=Object.fromEntries([...electorate].map(id=>[id,0]));h.ballots.forEach(b=>tally[b.target]++);const max=Math.max(...Object.values(tally)),leaders=[...electorate].filter(id=>tally[id]===max);
  if(h.eliminated!== (leaders.length===1?leaders[0]:null)||h.eliminated!==null&&g.players[h.eliminated].alive)invalid();
  if(h.eliminated!==null)eliminated.add(h.eliminated);previousElectorate=new Set([...electorate].filter(id=>id!==h.eliminated));
 }
 const last=g.voteHistory.at(-1),hasCurrentVote=last?.round===g.round;
 const currentLiving=new Set(living.map(p=>p.id)),nightResolved=!hasCurrentVote&&g.phase!=='night';
 if([...currentLiving].some(id=>!previousElectorate.has(id))||previousElectorate.size-currentLiving.size>(nightResolved?1:0))invalid();
 if(g.voteHistory.length>g.round||g.voteHistory.length<g.round-1||['night','dawn','day','vote'].includes(g.phase)&&hasCurrentVote||g.phase==='voteResult'&&!hasCurrentVote||g.draw&&!hasCurrentVote)invalid();
 if(last){if(!same(g.ballots,last.ballots)||g.eliminated!==last.eliminated)invalid();}else if(g.ballots.length||g.eliminated!==null)invalid();
 if(g.votes!==null){if(!last||!hasCurrentVote||!object(g.votes))invalid();const tally=Object.fromEntries(last.ballots.map(b=>[b.voter,0]));last.ballots.forEach(b=>tally[b.target]++);if(!same(g.votes,tally))invalid();}else if(hasCurrentVote&&!g.resigned)invalid();
 if(g.statementsRound!==null&&g.statements.some(s=>!object(s)||!seat(s.actor)||s.actor===0||!(s.target===null||seat(s.target)&&s.target!==s.actor)||!text(s.text)||!text(s.context))||new Set(g.statements.map(s=>s.actor)).size!==g.statements.length||g.statementsRound===null&&g.statements.length)invalid();
 if(!same(g.economy,economyFor(g)))invalid();
}
export function createGame({difficulty='normal',nick='Ты',id=crypto.randomUUID(),stake=0}={},random=secureRandom){
 if(!['easy','normal','hard'].includes(difficulty)||![0,100].includes(stake)||typeof id!=='string'||!UUID.test(id)||typeof nick!=='string'||typeof random!=='function')throw new GameError('invalid_request',400);
 const roles=['mafia','mafia','detective','doctor','civilian','civilian','civilian'];for(let i=roles.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[roles[i],roles[j]]=[roles[j],roles[i]];}
 const g=mafiaNewState(nick.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,24)||'Ты',id,difficulty,roles);
 Object.assign(g,{stake,resigned:false,winningTeam:null,win:false,draw:false,resultReason:null,eliminated:null});g.economy=economyFor(g);assertIntegrity(g);return g;
}
export function legalActions(g){
 if(g.over)return {actions:[],targets:[],marks:[]};
 const core=mafiaCore(g,()=>{throw Error('Legal actions must not use randomness');}),me=g.players[0];
 const primary=g.phase==='night'?'night':g.phase==='vote'?'vote':'continue';
 const targets=['night','vote'].includes(g.phase)?g.players.filter(p=>core.targetable(p,g.phase==='vote'?'vote':me.role,me)).map(p=>p.id):[];
 return {actions:[primary,...(!me.alive?['finish']:[]),'mark','resign'],targets,marks:[1,2,3,4,5,6]};
}
export function applyAction(state,action,random=secureRandom){
 assertIntegrity(state);
 if(!object(action)||!['night','vote','continue','finish','mark','resign'].includes(action.type))throw new GameError('invalid_request',400);
 const keys=action.type==='mark'?['type','target','mark']:['night','vote'].includes(action.type)&&Object.hasOwn(action,'target')?['type','target']:['type'];
 if(Object.keys(action).length!==keys.length||Object.keys(action).some(k=>!keys.includes(k))||Object.hasOwn(action,'target')&&!seat(action.target)||action.type==='mark'&&(!integer(action.target,1,6)||!MARKS.includes(action.mark)))throw new GameError('invalid_request',400);
 const legal=legalActions(state);if(!legal.actions.includes(action.type))throw new GameError('illegal_action');
 if(['night','vote'].includes(action.type)&&(legal.targets.length?!legal.targets.includes(action.target):Object.hasOwn(action,'target')))throw new GameError('illegal_target');
 const g=structuredClone(state),core=mafiaCore(g,random);
 if(action.type==='mark'){if(action.mark)g.personalMarks[action.target]=action.mark;else delete g.personalMarks[action.target];}
 else if(action.type==='resign')Object.assign(g,{over:true,phase:'result',resigned:true,winningTeam:null,win:false,draw:false,resultReason:'Ты завершил партию до итогов города.',message:'Ты завершил партию до итогов города.'});
 else if(action.type==='night'){if(action.target!==undefined)core.chooseNight(action.target);core.confirmNight();}
 else if(action.type==='vote'){if(action.target!==undefined)core.chooseVote(action.target);core.castVote();}
 else if(action.type==='continue'){core[({dawn:'beginDay',day:'beginVote',voteResult:'continueAfterVote'})[g.phase]]();}
 else{const steps={night:'confirmNight',dawn:'beginDay',day:'beginVote',vote:'castVote',voteResult:'continueAfterVote'};let n=0;while(!g.over&&n++<125)core[steps[g.phase]]();if(!g.over)throw new GameError('invalid_server_state',503);}
 g.settled=g.over;g.economy=economyFor(g);assertIntegrity(g);return g;
}
export function projectGame(g){
 if(!g)return null;assertIntegrity(g);const core=mafiaCore(g,()=>{throw Error('Projection must not use randomness');}),me=g.players[0];
 return {id:g.id,version:g.version,difficulty:g.diff,round:g.round,phase:g.phase,over:g.over,resigned:g.resigned,winningTeam:g.winningTeam,win:g.win,draw:g.draw,resultReason:g.resultReason,message:g.message,nightText:g.nightText,
 players:g.players.map(p=>({id:p.id,name:p.name,kind:p.kind,alive:p.alive,role:p.id===0||!p.alive||g.over||me.role==='mafia'&&p.role==='mafia'?p.role:null})),
 knowledge:me.role==='detective'?{...(g.knowledge[0]||{})}:{},privateNotes:[...g.privateNotes],personalMarks:{...g.personalMarks},votes:g.votes?{...g.votes}:null,ballots:g.ballots.map(b=>({...b})),voteHistory:g.voteHistory.map(h=>({round:h.round,eliminated:h.eliminated,message:h.message,ballots:h.ballots.map(b=>({voter:b.voter,target:b.target}))})),eliminated:g.eliminated,statements:g.statements.map(s=>({actor:s.actor,target:s.target,text:s.text,context:s.context})),log:[...g.log],voteFacts:g.over?core.playerVoteFacts():null,economy:{...g.economy},legal:legalActions(g)};
}
