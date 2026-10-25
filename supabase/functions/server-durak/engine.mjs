import {createCore} from './core.mjs';

export class GameError extends Error {
  constructor(code, status=422) { super(code); this.code=code; this.status=status; }
}
const fail = code => { throw new GameError(code); };
const ranks = ['6','7','8','9','10','J','Q','K','A'];
const suits = ['♠','♥','♦','♣'];
export const secureRandom = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
function rules(random=secureRandom, id='', nick='Ты') { return createCore({random,id,nick}); }
const publicCard = card => card ? {id:card.id,rank:card.rank,suit:card.suit,color:card.color} : null;
const economyKeys=['version','stake','settled','payout','xp','outcome'];
function economyFor(g,stake=0) {
  const outcome=!g.over?null:g.resigned===true?'resigned':g.draw?'draw':g.finished.includes(0)?'win':'loss';
  return {version:1,stake,settled:g.over,payout:stake?(outcome==='win'?stake*g.players.length:outcome==='draw'?stake:0):0,xp:stake?({win:80,draw:40,loss:25}[outcome]||0):0,outcome};
}
function checkEconomy(g) {
  if(g.economy===undefined)return; // Existing server practice stays free.
  const e=g.economy;
  if(!e||typeof e!=='object'||Array.isArray(e)||![0,100].includes(e.stake)||Object.keys(e).length!==economyKeys.length||economyKeys.some(k=>e[k]!==economyFor(g,e.stake)[k]))throw new GameError('invalid_server_state',503);
}

export function assertIntegrity(g) {
  if (!g || g.engineVersion!==3 || !Array.isArray(g.players) || g.players.length<2 || g.players.length>4 || !Array.isArray(g.deck) || !Array.isArray(g.table) || !Array.isArray(g.finished) || !Number.isInteger(g.discardCount) || g.discardCount<0 || g.discardCount>36) throw new GameError('invalid_server_state',503);
  const cards = [...g.deck,...g.players.flatMap(p=>p.hand),...g.table.flatMap(p=>p.d?[p.a,p.d]:[p.a])];
  if (cards.length+g.discardCount!==36 || new Set(cards.map(c=>c?.id)).size!==cards.length || cards.some(c=>!c||!ranks.includes(c.rank)||!suits.includes(c.suit)||c.id!==c.rank+c.suit)||!['attack','defend','resolve','roundEnd','over'].includes(g.phase)||!Number.isInteger(g.attacker)||!g.players[g.attacker]||!Number.isInteger(g.defender)||!g.players[g.defender]||g.attacker===g.defender) throw new GameError('invalid_server_state',503);
  if(typeof g.over!=='boolean'||typeof g.draw!=='boolean'||g.over!==(g.phase==='over')||new Set(g.finished).size!==g.finished.length||g.finished.some(i=>!Number.isInteger(i)||!g.players[i]||g.players[i].hand.length)||(g.finished.length&&g.deck.length))throw new GameError('invalid_server_state',503);
  if(g.over&&g.resigned!==true){
    const active=g.players.map((p,i)=>p.hand.length?i:null).filter(i=>i!==null);
    if(g.deck.length||g.table.length||active.length>1||g.draw!==(active.length===0)||g.loser!==(active[0]??null)||g.finished.length!==g.players.length-active.length)throw new GameError('invalid_server_state',503);
  }
  checkEconomy(g);
}
function runBots(g, core) {
  // One attack/defence at most before a human turn or explicit review pause.
  // Bot-vs-bot rounds still stop for review; no unbounded server loop.
  for (let count=0;count<2;count++) {
    if(g.over) break;
    if(g.phase==='attack' && g.attacker!==0) {
      const actor=g.attacker,card=core.botCard(actor,g);
      if(g.table.length&&!core.durakContinueAttack(actor,g,card)) core.durakPrepareRound(g,false);
      else if(!card||!core.durakApplyAttack(g,actor,g.players[actor].hand.findIndex(c=>c.id===card.id))) throw new GameError('invalid_server_state',503);
    } else if(g.phase==='defend'&&g.defender!==0) {
      const actor=g.defender,card=core.chooseDefense(actor,g);
      if(card) core.durakApplyDefense(g,actor,g.players[actor].hand.findIndex(c=>c.id===card.id));
      else core.durakApplyResolve(g,true);
    } else break;
  }
}
export function createGame({bots=1,difficulty='normal',nick='Ты',id=crypto.randomUUID(),stake=0}={},random=secureRandom) {
  if(!Number.isInteger(bots)||bots<1||bots>3||!['easy','normal','hard'].includes(difficulty)||![0,100].includes(stake)) throw new GameError('invalid_request',400);
  const core=rules(random,id,nick),g=core.newGame({bots,diff:difficulty,stake:0});
  runBots(g,core);g.economy=economyFor(g,stake);assertIntegrity(g);return g;
}
export function legalActions(g) {
  if(g.over)return {cards:[],actions:[]};
  const core=rules(),actions=[],cards=[];
  if(g.phase==='defend'&&g.defender===0) {
    actions.push('take');
    for(const c of g.players[0].hand)if(core.beats(c,g.table[g.table.length-1]?.a,g))cards.push(c.id);
    if(cards.length)actions.unshift('defend');
  } else if(['attack','resolve'].includes(g.phase)&&g.attacker===0) {
    for(const c of g.players[0].hand)if(core.canAddAttack(c,g))cards.push(c.id);
    if(cards.length)actions.push('attack');
    if(g.table.length&&g.table.every(p=>p.d))actions.push('finish');
  } else if(g.phase==='resolve') actions.push('continue');
  if(g.phase==='roundEnd')actions.push('continue');
  actions.push('resign');return {cards,actions};
}
export function applyAction(state, action, random=secureRandom) {
  assertIntegrity(state);
  if(!action||typeof action!=='object'||Array.isArray(action))throw new GameError('invalid_request',400);
  const keys=Object.keys(action);
  if(!['attack','defend','take','finish','continue','resign'].includes(action.type)||keys.some(k=>!['type','cardId'].includes(k))||(['attack','defend'].includes(action.type)?typeof action.cardId!=='string':keys.length!==1))throw new GameError('invalid_request',400);
  const legal=legalActions(state);
  if(!legal.actions.includes(action.type))fail('illegal_action');
  if(['attack','defend'].includes(action.type)&&!legal.cards.includes(action.cardId))fail('illegal_card');
  const g=structuredClone(state),core=rules(random);let changed=false;
  switch(action.type) {
    case 'attack': changed=core.durakApplyAttack(g,0,g.players[0].hand.findIndex(c=>c.id===action.cardId));break;
    case 'defend': changed=core.durakApplyDefense(g,0,g.players[0].hand.findIndex(c=>c.id===action.cardId));break;
    case 'take': changed=core.durakApplyResolve(g,true);break;
    case 'finish': changed=core.durakPrepareRound(g,false);break;
    case 'continue': changed=g.phase==='roundEnd'?core.durakCommitRound(g):core.durakContinueResolve(g);break;
    case 'resign': g.over=true;g.phase='over';g.resigned=true;g.draw=false;g.winner=null;g.loser=0;g.message='Ты завершил серверную партию. Можно открыть новый стол.';changed=true;break;
  }
  if(!changed)fail('illegal_action');
  runBots(g,core);g.economy=economyFor(g,state.economy?.stake||0);assertIntegrity(g);return g;
}
export function projectGame(g) {
  if(!g)return null;
  assertIntegrity(g);
  return {
    id:g.id,phase:g.phase,round:g.round,trump:g.trump,trumpCard:publicCard(g.trumpCard),
    deckCount:g.deck.length,discardCount:g.discardCount,attacker:g.attacker,defender:g.defender,
    players:g.players.map((p,i)=>({name:p.name,face:p.face,handCount:p.hand.length,kind:p.kind,...(i===0?{hand:p.hand.map(publicCard)}:{botStyle:p.botStyle})})),
    table:g.table.map(p=>({a:publicCard(p.a),d:publicCard(p.d)})),
    over:g.over,draw:g.draw,winner:g.winner,loser:g.loser,finished:[...g.finished],
    resigned:g.resigned===true,difficulty:g.diff,message:g.message,economy:{...(g.economy||economyFor(g))},
    journal:g.journal.map(entry=>({round:entry.round,kind:entry.kind,...(Number.isInteger(entry.actor)?{actor:entry.actor}:{}),...(Number.isInteger(entry.count)?{count:entry.count}:{}),...(entry.card?{card:{rank:entry.card.rank,suit:entry.card.suit}}:{}),...(entry.against?{against:{rank:entry.against.rank,suit:entry.against.suit}}:{})})),
    legal:legalActions(g),
  };
}
