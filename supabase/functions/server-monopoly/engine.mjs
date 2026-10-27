import {createCore} from './core.mjs';
export class GameError extends Error {constructor(code,status=422){super(code);this.code=code;this.status=status;}}
export const secureRandom=()=>crypto.getRandomValues(new Uint32Array(1))[0]/4294967296;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v),integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max,seat=v=>integer(v,0,3),cell=v=>integer(v,0,19),text=(v,max=1000)=>typeof v==='string'&&v.length<=max;
const invalid=()=>{throw new GameError('invalid_server_state',503);};
const noRandom=()=>{throw Error('Read-only Monopoly operation used randomness');};
const catalog=createCore({random:noRandom});
const worth=(g,p)=>p.money+p.properties.reduce((sum,i)=>sum+g.board[i].price,0);
function same(a,b){if(a===b)return true;if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>same(v,b[i]));if(!object(a)||!object(b))return false;const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]));}
function economyFor(g){const outcome=!g.over?null:g.resigned?'resigned':g.winner===0?'win':'loss';return {version:1,stake:g.stake,settled:g.over,payout:g.stake&&outcome==='win'?250:0,xp:g.stake?(outcome==='win'?100:outcome==='loss'?25:0):0,outcome};}
function keys(value,names){return object(value)&&Object.keys(value).length===names.length&&names.every(k=>Object.hasOwn(value,k));}
export function assertIntegrity(g){
 if(!object(g)||g.version!==3||!UUID.test(g.id)||!['easy','normal','hard'].includes(g.diff)||![0,100].includes(g.stake)||!['ready','buy','review','over'].includes(g.phase)||!seat(g.turn)||!integer(g.turnNumber,1,80)||g.maxTurns!==80||typeof g.over!=='boolean'||g.over!==(g.phase==='over')||typeof g.resigned!=='boolean'||g.resigned&&!g.over||g.settled!==g.over||g.paused!==false||g.pace!=='calm'||g.pendingSteps!==0||!integer(g.bank,-100000,100000)||!Array.isArray(g.players)||g.players.length!==4||!Array.isArray(g.board)||g.board.length!==20)invalid();
 for(let i=0;i<4;i++){
  const p=g.players[i];if(!keys(p,['id','name','money','pos','alive','properties','skip'])||p.id!==i||!text(p.name,24)||!p.name||i>0&&p.name!==catalog.botNames[i-1]||!integer(p.money,0,100000)||!cell(p.pos)||typeof p.alive!=='boolean'||!integer(p.skip,0,1)||!Array.isArray(p.properties)||new Set(p.properties).size!==p.properties.length||p.properties.some(index=>!cell(index))||!p.alive&&(p.money!==0||p.properties.length))invalid();
 }
 if(g.bank+g.players.reduce((sum,p)=>sum+p.money,0)!==6000)invalid();
 for(let i=0;i<20;i++){
  const c=g.board[i],base=catalog.boardTemplate[i];if(!object(c)||!same(c,{...base,owner:c.owner})||!(c.owner===null||seat(c.owner))||c.owner!==null&&(c.kind!=='property'||!g.players[c.owner].alive))invalid();
  for(const p of g.players)if(p.properties.includes(i)!==(c.owner===p.id))invalid();
 }
 if(!Array.isArray(g.dice)||g.dice.length!==2||g.dice.some(n=>!integer(n,1,6))||!text(g.message)||!Array.isArray(g.log)||g.log.length>60||g.log.some(v=>!text(v))||!Array.isArray(g.journal)||g.journal.length>60||g.journal.some(v=>!keys(v,['turn','text'])||!integer(v.turn,1,g.turnNumber)||!text(v.text)))invalid();
 if(!Array.isArray(g.ledger)||g.ledger.length>240||g.ledger.some(v=>!keys(v,['player','delta','label','turn','balance'])||!seat(v.player)||!integer(v.delta,-100000,100000)||v.delta===0||!text(v.label)||!integer(v.turn,1,g.turnNumber)||!integer(v.balance,0,100000)))invalid();
 for(let i=1;i<g.ledger.length;i++)if(g.ledger[i].turn>g.ledger[i-1].turn)invalid();
 for(let i=1;i<g.journal.length;i++)if(g.journal[i].turn>g.journal[i-1].turn)invalid();
 if(!same(g.log,g.journal.map(entry=>entry.text)))invalid();
 if(!cell(g.lastIndex)||!cell(g.lastFrom)||!cell(g.lastTo)||!seat(g.lastMover)||!integer(g.lastSteps,0,20)||typeof g.lastRelocated!=='boolean'||!Array.isArray(g.lastPath)||g.lastPath.length>21||g.lastPath.some(index=>!cell(index)))invalid();
 if(g.lastRoll!==null&&(!keys(g.lastRoll,['turn','player','dice'])||!integer(g.lastRoll.turn,1,g.turnNumber)||!seat(g.lastRoll.player)||!same(g.lastRoll.dice,g.dice)))invalid();
 if(g.lastChance!==null){const e=g.lastChance;if(!keys(e,['text','delta','move','player','turn'])||!seat(e.player)||!integer(e.turn,1,g.turnNumber)||!catalog.chances.some(c=>c.text===e.text&&(c.delta||0)===e.delta&&(c.move||0)===e.move))invalid();}
 if(g.lastPayment!==null){
  const p=g.lastPayment;if(!keys(p,['turn','player','creditor','reason','amount','paid','moneyBefore','moneyAfter','capitalBefore','capitalAfter','sales'])||!integer(p.turn,1,g.turnNumber)||!seat(p.player)||!(p.creditor===null||seat(p.creditor)&&p.creditor!==p.player)||!text(p.reason)||!integer(p.amount,0,100000)||!integer(p.paid,0,p.amount)||!integer(p.moneyBefore,0,100000)||!integer(p.moneyAfter,0,100000)||!integer(p.capitalBefore,p.moneyBefore,100000)||!integer(p.capitalAfter,p.moneyAfter,100000)||!Array.isArray(p.sales)||p.sales.length>12||new Set(p.sales.map(s=>s?.index)).size!==p.sales.length)invalid();
  for(let i=0;i<p.sales.length;i++){const sale=p.sales[i];if(!keys(sale,['index','value'])||!cell(sale.index)||g.board[sale.index].kind!=='property'||sale.value!==Math.floor(g.board[sale.index].price/2)||i&&sale.value<p.sales[i-1].value)invalid();}
  const proceeds=p.sales.reduce((sum,s)=>sum+s.value,0),lostValue=p.sales.reduce((sum,s)=>sum+g.board[s.index].price,0);
  if(p.moneyAfter!==p.moneyBefore+proceeds-p.paid||p.capitalAfter!==p.capitalBefore+proceeds-lostValue-p.paid||p.paid!==Math.min(p.moneyBefore+proceeds,p.amount))invalid();
 }
 const living=g.players.filter(p=>p.alive);
 if(!living.length||!Array.isArray(g.winners)||new Set(g.winners).size!==g.winners.length||g.winners.some(id=>!seat(id)||!g.players[id].alive)||![null,0].includes(g.winner))invalid();
 if(!g.over){
  if(!g.players[0].alive||living.length<=1||!g.players[g.turn].alive&&g.phase!=='review'||g.winner!==null||g.winners.length||g.finishKind!==null||g.resultReason!==null||g.phase==='ready'&&g.turn!==0)invalid();
  if(g.phase==='buy'){const p=g.players[0],c=g.board[p.pos];if(g.turn!==0||c.kind!=='property'||c.owner!==null||p.money<c.price||g.lastIndex!==p.pos)invalid();}
 }else{
  if(!text(g.resultReason)||!g.resultReason||!['capital','bankrupt','last-player','resigned'].includes(g.finishKind))invalid();
  if(g.resigned){if(g.finishKind!=='resigned'||g.winner!==null||g.winners.length||!g.players[0].alive||living.length<=1)invalid();}
  else if(g.finishKind==='capital'){const max=Math.max(...living.map(p=>worth(g,p))),winners=living.filter(p=>worth(g,p)===max).map(p=>p.id);if(g.turnNumber!==80||!g.players[0].alive||!same(g.winners,winners)||g.winner!==(winners.includes(0)?0:null))invalid();}
  else if(g.finishKind==='bankrupt'){if(g.players[0].alive||g.winner!==null||g.winners.length||living.length<=1)invalid();}
  else if(g.finishKind==='last-player'){if(living.length!==1||!same(g.winners,[living[0].id])||g.winner!==(living[0].id===0?0:null))invalid();}
  else invalid();
 }
 if(!same(g.economy,economyFor(g)))invalid();
}
export function createGame({difficulty='normal',nick='Ты',id=crypto.randomUUID(),stake=0}={},random=secureRandom){
 if(!['easy','normal','hard'].includes(difficulty)||![0,100].includes(stake)||typeof id!=='string'||!UUID.test(id)||typeof nick!=='string'||typeof random!=='function')throw new GameError('invalid_request',400);
 const core=createCore({random,id,nick:nick.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,24)||'Ты',difficulty}),g=core.newGame();
 Object.assign(g,{stake,resigned:false,finishKind:null,resultReason:null});g.economy=economyFor(g);assertIntegrity(g);return g;
}
const finalReview=g=>!g.over&&g.turnNumber===80&&g.phase==='review';
export function legalActions(g){return {actions:g.over?[]:finalReview(g)?['continue']:[...(g.phase==='ready'?['roll']:g.phase==='buy'?['buy','skip']:['continue']),'resign']};}
export function applyAction(state,action,random=secureRandom){
 assertIntegrity(state);
 if(!keys(action,['type'])||!['roll','buy','skip','continue','resign'].includes(action.type)||typeof random!=='function')throw new GameError('invalid_request',400);
 if(!legalActions(state).actions.includes(action.type)&&!(action.type==='resign'&&finalReview(state)))throw new GameError('illegal_action');
 const g=structuredClone(state),core=createCore({random});
 if(action.type==='resign'&&finalReview(state))core.continue(g);
 else if(action.type==='resign')Object.assign(g,{over:true,phase:'over',resigned:true,winner:null,winners:[],finishKind:'resigned',resultReason:'Ты завершил партию до подведения итогов.',message:'Партия завершена досрочно.'});
 else core[action.type](g);
 g.settled=g.over;g.economy=economyFor(g);assertIntegrity(g);return g;
}
export function projectGame(g){
 if(!g)return null;assertIntegrity(g);const core=createCore({random:noRandom});
 return {id:g.id,version:g.version,difficulty:g.diff,diff:g.diff,phase:g.phase,turn:g.turn,turnNumber:g.turnNumber,maxTurns:g.maxTurns,over:g.over,resigned:g.resigned,settled:g.settled,winner:g.winner,winners:[...g.winners],finishKind:g.finishKind,resultReason:g.resultReason,bank:g.bank,dice:[...g.dice],message:g.message,
  players:g.players.map(p=>({id:p.id,name:p.name,money:p.money,pos:p.pos,alive:p.alive,properties:[...p.properties],skip:p.skip,capital:worth(g,p)})),
  board:g.board.map((c,index)=>({kind:c.kind,title:c.title,owner:c.owner,...(c.kind==='property'?{price:c.price,rent:c.rent,color:c.color,currentRent:core.rent(g,index)}:{}),...(['tax','bonus'].includes(c.kind)?{amount:c.amount}:{})})),
  log:[...g.log],journal:g.journal.map(e=>({turn:e.turn,text:e.text})),ledger:g.ledger.map(e=>({player:e.player,delta:e.delta,label:e.label,turn:e.turn,balance:e.balance})),lastIndex:g.lastIndex,lastFrom:g.lastFrom,lastTo:g.lastTo,lastMover:g.lastMover,lastSteps:g.lastSteps,lastRelocated:g.lastRelocated,lastPath:[...g.lastPath],
  lastRoll:g.lastRoll?{turn:g.lastRoll.turn,player:g.lastRoll.player,dice:[...g.lastRoll.dice]}:null,
  lastChance:g.lastChance?{text:g.lastChance.text,delta:g.lastChance.delta,move:g.lastChance.move,player:g.lastChance.player,turn:g.lastChance.turn}:null,
  lastPayment:g.lastPayment?{turn:g.lastPayment.turn,player:g.lastPayment.player,creditor:g.lastPayment.creditor,reason:g.lastPayment.reason,amount:g.lastPayment.amount,paid:g.lastPayment.paid,moneyBefore:g.lastPayment.moneyBefore,moneyAfter:g.lastPayment.moneyAfter,capitalBefore:g.lastPayment.capitalBefore,capitalAfter:g.lastPayment.capitalAfter,sales:g.lastPayment.sales.map(s=>({index:s.index,value:s.value}))}:null,
  economy:{...g.economy},legal:legalActions(g)};
}
