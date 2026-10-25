import {createCore} from './core.mjs';

export class GameError extends Error {
  constructor(code, status = 422) { super(code); this.code = code; this.status = status; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUITS = ['♠','♥','♦','♣'];
const DIFFICULTIES = ['easy','normal','hard'];
const integer = (value, minimum = 0, maximum = 4000) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = code => { throw new GameError(code); };
const invalidState = () => { throw new GameError('invalid_server_state', 503); };

export const secureRandom = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
const newId = () => crypto.randomUUID();
const rules = (random = secureRandom) => createCore({random});
const publicCard = card => ({id:card.id,rank:card.rank,suit:card.suit,v:card.v,red:card.red});
const publicCombination = value => ({name:value.name,category:value.category,cards:[...value.cards],parts:[...value.parts]});
const tableEnded = (g, core) => g.tableClosed === true || (g.over === true && core.tableFinished(g));
const economyKeys=['version','stake','settled','payout','xp','outcome'];
function economyFor(state,stake=0) {
  const cashout=Math.floor(state.game.players[0].chips/10);
  const outcome=!state.over?null:!state.game.over?'resigned':cashout>100?'win':cashout===100?'draw':'loss';
  return {version:1,stake,settled:state.over,payout:stake&&state.over?cashout:0,xp:stake&&state.over?({win:90,draw:40,loss:20}[outcome]||0):0,outcome};
}
function checkEconomy(state) {
  if(state.economy===undefined)return; // Older tables are free practice.
  const e=state.economy;
  if(!object(e)||![0,100].includes(e.stake)||Object.keys(e).length!==economyKeys.length||economyKeys.some(k=>e[k]!==economyFor(state,e.stake)[k])||(e.stake===100&&state.over&&!state.game.over))invalidState();
}

/** Checks persisted internal state before it can influence any reply or transition. */
export function assertIntegrity(state) {
  if (!object(state) || state.version !== 1 || !UUID.test(state.id) || !UUID.test(state.handId) || typeof state.over !== 'boolean' || !object(state.game)) invalidState();
  const g = state.game;
  if (g.version !== 3 || g.id !== state.handId || g.tableId !== state.id || !Array.isArray(g.players) || g.players.length !== 4 || !Array.isArray(g.deck) || !Array.isArray(g.burn) || !Array.isArray(g.community) || !DIFFICULTIES.includes(g.difficulty) || !integer(g.handNumber, 1, Number.MAX_SAFE_INTEGER) || !Array.isArray(g.handStartChips) || g.handStartChips.length !== 4 || g.handStartChips.some(n => !integer(n)) || g.handStartChips.reduce((sum,n) => sum+n, 0) !== 4000) invalidState();
  if (!['preflop','flop','turn','river'].includes(g.stage) || !['betting','review','over'].includes(g.phase) || typeof g.over !== 'boolean' || typeof g.tableClosed !== 'boolean' || g.paused !== false || !integer(g.button,0,3) || !integer(g.smallBlind,0,3) || !integer(g.bigBlind,0,3) || g.smallBlind === g.bigBlind || !integer(g.toAct,-1,3) || !integer(g.pot) || !integer(g.currentBet) || !integer(g.minRaise,1)) invalidState();
  const boardLength = {preflop:0,flop:3,turn:4,river:5}[g.stage];
  if (g.community.length !== boardLength || g.burn.length !== (boardLength ? boardLength-2 : 0)) invalidState();
  for (let i=0; i<4; i++) {
    const p = g.players[i];
    if (!object(p) || typeof p.name !== 'string' || !p.name.length || p.name.length > 24 || typeof p.initial !== 'string' || p.kind !== (i === 0 ? 'human' : 'bot') || !Array.isArray(p.hand) || p.hand.length !== (g.handStartChips[i] > 0 ? 2 : 0) || !integer(p.chips) || !integer(p.roundBet) || !integer(p.totalBet) || p.roundBet > p.totalBet || typeof p.folded !== 'boolean' || typeof p.sittingOut !== 'boolean' || p.sittingOut !== (g.handStartChips[i] === 0) || (p.sittingOut && !p.folded) || typeof p.acted !== 'boolean' || !(p.actedAtBet === null || integer(p.actedAtBet))) invalidState();
  }
  const cards = [...g.deck,...g.burn,...g.community,...g.players.flatMap(p => p.hand)];
  if (cards.length !== 52 || new Set(cards.map(c => c?.id)).size !== 52 || cards.some(c => !object(c) || !RANKS.includes(c.rank) || !SUITS.includes(c.suit) || c.id !== c.rank+c.suit || c.v !== RANKS.indexOf(c.rank)+2 || c.red !== ['♥','♦'].includes(c.suit))) invalidState();
  if (g.players.reduce((sum,p) => sum+p.chips, 0)+g.pot !== 4000 || g.players.reduce((sum,p) => sum+p.totalBet, 0) !== (g.over ? g.paidPot : g.pot)) invalidState();
  if (g.over !== (g.phase === 'over') || (g.phase === 'betting' ? g.toAct < 0 || g.players[g.toAct].folded || g.players[g.toAct].chips <= 0 : g.toAct !== -1)) invalidState();
  if (!Array.isArray(g.history) || g.history.length > 30 || g.history.some(x => typeof x !== 'string' || x.length > 250) || !Array.isArray(g.tableHistory) || g.tableHistory.length > 12 || typeof g.lastAction !== 'string' || g.lastAction.length > 250) invalidState();
  for (const item of g.tableHistory) {
    if (!object(item) || !integer(item.number,1,g.handNumber-1) || !integer(item.net,-4000,4000) || !integer(item.pot) || !Array.isArray(item.winners) || item.winners.length > 4 || item.winners.some(name => typeof name !== 'string' || name.length > 24)) invalidState();
  }
  if (g.over) {
    if (g.pot !== 0 || !integer(g.paidPot) || !integer(g.handProfit,-4000,4000) || g.handProfit !== g.players[0].chips-g.handStartChips[0] || !Array.isArray(g.prizes) || g.prizes.length !== 4 || g.prizes.some(n => !integer(n)) || g.prizes.reduce((sum,n) => sum+n,0) !== g.paidPot || typeof g.showdown !== 'boolean' || (g.showdown && g.community.length !== 5) || !Array.isArray(g.pots)) invalidState();
    for (const pot of g.pots) if (!object(pot) || !integer(pot.amount,1) || typeof pot.refund !== 'boolean' || !Array.isArray(pot.winners) || !pot.winners.length || pot.winners.some(i => !integer(i,0,3)) || new Set(pot.winners).size !== pot.winners.length) invalidState();
    if (g.pots.reduce((sum,pot) => sum+pot.amount,0) !== g.paidPot) invalidState();
  }
  if (state.over !== tableEnded(g,rules())) invalidState();
  checkEconomy(state);
  return true;
}

function runBots(g, core) {
  // Bounded work and an explicit pause: neither a request nor an unattended tab
  // can play an entire table. Each new street needs its own Continue action.
  for (let count=0;count<2;count++) {
    if (g.tableClosed || g.over || g.phase !== 'betting' || g.toAct === 0) break;
    if (!core.botMove(g)) invalidState();
  }
}

export function createGame({difficulty='normal',nick='Ты',id=newId(),stake=0}={},random=secureRandom,uuid=newId) {
  if (!DIFFICULTIES.includes(difficulty) || typeof nick !== 'string' || !UUID.test(id)||![0,100].includes(stake)) throw new GameError('invalid_request',400);
  const name = nick.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,24) || 'Ты';
  const core = rules(random), g = core.pokerNewGame(name,difficulty);
  g.id=uuid();g.tableId=id;
  runBots(g,core);
  const state={version:1,id,handId:g.id,over:tableEnded(g,core),game:g};
  state.economy=economyFor(state,stake);
  assertIntegrity(state);return state;
}

export function legalActions(state) {
  const g=state.game,core=rules(),actions=[];
  if (state.over) return {actions,callAmount:0,owed:0,minimum:0,maximum:0};
  let betting={};
  if (g.over) actions.push('nextHand');
  else if (g.phase==='review'||(g.phase==='betting'&&g.toAct!==0)) actions.push('continue');
  else {
    betting=core.legalActions(g,0);
    for (const type of ['fold','check','call','raise']) if(betting[type]) actions.push(type);
  }
  if(state.economy?.stake!==100||g.over)actions.push('close');
  return {actions,callAmount:betting.callAmount||0,owed:betting.owed||0,minimum:betting.minimum||0,maximum:betting.maximum||0};
}

export function applyAction(state,action,random=secureRandom,uuid=newId) {
  assertIntegrity(state);
  if (!object(action) || !['fold','check','call','raise','continue','nextHand','close','resign'].includes(action.type) || Object.keys(action).some(k => !['type','amount'].includes(k)) || (action.type==='raise' ? !integer(action.amount,1) : Object.keys(action).length!==1)) throw new GameError('invalid_request',400);
  const type=action.type==='resign'?'close':action.type;
  if (!legalActions(state).actions.includes(type)) fail('illegal_action');
  const next=structuredClone(state),core=rules(random);let g=next.game;
  if (['fold','check','call','raise'].includes(type)) {
    if (!core.pokerAction(g,0,type,action.amount)) fail('illegal_action');
  } else if (type==='continue') {
    if (g.phase==='review'&&!core.pokerContinue(g)) fail('illegal_action');
    // A betting-phase Continue lets the next bounded group of bots act.
  } else if (type==='nextHand') {
    g=core.pokerNextHand(g);if(!g)fail('illegal_action');
    g.id=uuid();g.tableId=state.id;next.game=g;next.handId=g.id;
  } else {
    g.tableClosed=true;
  }
  runBots(g,core);next.over=tableEnded(g,core);
  next.economy=economyFor(next,state.economy?.stake||0);
  assertIntegrity(next);return next;
}

export function projectGame(state) {
  if (!state) return null;
  assertIntegrity(state);
  const g=state.game,core=rules();
  const closed=g.tableClosed===true;
  return {
    id:state.id,handId:state.handId,over:state.over,handOver:g.over,
    tableClosed:closed,tableFinished:g.over&&core.tableFinished(g),
    phase:closed?'over':g.phase,stage:g.stage,difficulty:g.difficulty,
    handNumber:g.handNumber,button:g.button,smallBlind:g.smallBlind,bigBlind:g.bigBlind,toAct:closed?-1:g.toAct,
    pot:g.pot,paidPot:g.over?g.paidPot:0,handProfit:g.over?g.handProfit:0,
    community:g.community.map(publicCard),showdown:g.over&&g.showdown===true,
    players:g.players.map((p,i) => {
      const reveal=i===0||(g.over&&g.showdown&&!p.folded&&!p.sittingOut);
      return {
        name:p.name,initial:p.initial,kind:p.kind,chips:p.chips,
        roundBet:p.roundBet,totalBet:p.totalBet,folded:p.folded,sittingOut:p.sittingOut,handCount:p.hand.length,
        ...(reveal?{hand:p.hand.map(publicCard),...(p.hand.length?{combination:publicCombination(core.evaluate([...p.hand,...g.community]))}:{})}:{}),
      };
    }),
    prizes:g.over?[...g.prizes]:[],
    pots:g.over?g.pots.map(p => ({amount:p.amount,winners:[...p.winners],refund:p.refund})):[],
    result:closed?(state.economy?.stake===100?'Стол закрыт. Итог рассчитан по оставшимся фишкам.':'Стол закрыт. Фишки этого тренировочного стола не переносятся в кошелёк.'):g.over?g.result:'',
    lastAction:closed?(state.economy?.stake===100?'Стол закрыт. Начисление и закрытие сохранены вместе.':'Ты закрыл тренировочный стол. Можно создать новый.'):g.lastAction,
    economy:{...(state.economy||economyFor(state))},
    history:[...g.history],
    tableHistory:g.tableHistory.map(item => ({number:item.number,net:item.net,pot:item.pot,winners:[...item.winners]})),
    legal:legalActions(state),
  };
}
