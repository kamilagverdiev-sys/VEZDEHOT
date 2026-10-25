/* Pure session codecs shared by game pages and account checkpoint import.
 * Local legacy states without IDs receive a deterministic migration ID. Existing
 * IDs are never rewritten. Remote snapshots require current versions and IDs;
 * they never run legacy migrations or create identifiers.
 */
(function(root){
'use strict';
const MAX_LENGTH=512*1024;
const games=new Set(['durak','bunker','poker','mafia','monopoly']);
const ranks=['6','7','8','9','10','J','Q','K','A'];
const DURAK_ENGINE_VERSION=3,BUNKER_VERSION=2,GAME_VERSION=3;
const DURAK_STYLES={pressure:true,careful:true,flexible:true},DURAK_STYLE_ORDER=['pressure','careful','flexible'];
const BUNKER_STYLES={pragmatic:true,team:true,focused:true},BUNKER_STYLE_ORDER=['pragmatic','team','focused'];
const roleInfo={mafia:{team:'mafia'},detective:{team:'town'},doctor:{team:'town'},civilian:{team:'town'}};
// These are the original legacy migration defaults, not new scenario selection.
const bunkerScenarios=[{name:'После большого шторма',code:'STORM / 07',text:'Побережье затоплено. Связь оборвалась, снаружи холодно. Убежище должно продержаться до прибытия спасателей.',focus:'survival',duration:'90 дней'}];
const bunkerEvents=[
  {title:'Сбой вентиляции',text:'Воздух становится душным. Навыки ремонта особенно полезны сегодня.',focus:'technical'},
  {title:'Запасы на исходе',text:'Нужно составить рацион и запустить выращивание еды.',focus:'food'},
  {title:'Трудная смена',text:'Команде нужны первая помощь и забота о здоровье.',focus:'medical'}
];
function clone(value){const raw=JSON.stringify(value);if(typeof raw!=='string'||raw.length>MAX_LENGTH)throw new Error('Invalid session size');return JSON.parse(raw)}
function canonical(value){if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';return JSON.stringify(value)}
function legacyId(game,value){
  const raw=canonical(value);let a=2166136261,b=0x9e3779b9;
  for(let i=0;i<raw.length;i++){a=Math.imul(a^raw.charCodeAt(i),16777619);b=Math.imul(b^raw.charCodeAt(i),2246822519)}
  return game+'-migrated-'+(a>>>0).toString(36)+'-'+(b>>>0).toString(36);
}
function mainGameKind(g){return g&&Array.isArray(g.players)&&g.players[0]?(Array.isArray(g.deck)&&Array.isArray(g.players[0].hand)?'durak':Array.isArray(g.players[0].cards)?'bunker':null):null}
function normalizeDurakStyles(g){g.players.forEach((p,i)=>{if(p.kind==='bot'&&!Object.hasOwn(DURAK_STYLES,p.botStyle))p.botStyle=DURAK_STYLE_ORDER[Math.max(0,i-1)%3]})}
function beats(def,atk,g){if(!def||!atk)return false;if(def.suit===atk.suit)return ranks.indexOf(def.rank)>ranks.indexOf(atk.rank);return def.suit===g.trump&&atk.suit!==g.trump}
function makeDeck(){return ['♠','♥','♦','♣'].flatMap(suit=>['2','3','4','5','6','7','8','9','10','J','Q','K','A'].map((rank,i)=>({id:rank+suit,rank,suit,v:i+2})))}

var boardTemplate=[{kind:'start',title:'Старт'},{kind:'property',title:'Маяк',price:120,rent:22,color:'pink'},{kind:'property',title:'Оранжерея',price:140,rent:26,color:'pink'},{kind:'chance',title:'Шанс'},{kind:'tax',title:'Налог',amount:100},{kind:'property',title:'Космопорт',price:170,rent:32,color:'blue'},{kind:'jail',title:'Тихий двор'},{kind:'property',title:'Станция',price:190,rent:38,color:'blue'},{kind:'property',title:'Сад на крыше',price:210,rent:44,color:'green'},{kind:'chance',title:'Шанс'},{kind:'property',title:'Кинотеатр',price:230,rent:50,color:'green'},{kind:'goto',title:'На отдых'},{kind:'property',title:'Арт-кластер',price:260,rent:58,color:'orange'},{kind:'property',title:'Лофт 404',price:280,rent:64,color:'orange'},{kind:'tax',title:'Суперналог',amount:150},{kind:'property',title:'Панорама',price:310,rent:72,color:'purple'},{kind:'chance',title:'Шанс'},{kind:'property',title:'Неон-сквер',price:340,rent:82,color:'purple'},{kind:'bonus',title:'Оазис',amount:120},{kind:'property',title:'Главный хаб',price:380,rent:96,color:'purple'}];

    function normalizeDurakGame(g){
      if(!g||!Array.isArray(g.players)||!Array.isArray(g.deck))return g;
      const legacy=g.engineVersion!==DURAK_ENGINE_VERSION;
      g.id=g.id||legacyId('durak',g);g.table=g.table||[];g.finished=Array.isArray(g.finished)?g.finished:[];
      g.draw=!!g.draw;g.paused=!!g.paused;g.journal=Array.isArray(g.journal)?g.journal:[];
      if(legacy&&g.resolve?.took&&g.resolve.prepared){
        // Earlier builds put taken cards in the hand before clearing the table.
        // Undo that staging once; the next-round transition will transfer them.
        const h=g.players[g.defender].hand;
        for(const c of g.table.flatMap(p=>p.d?[p.a,p.d]:[p.a])){
          const index=h.findIndex(x=>x.id===c.id||(x.rank===c.rank&&x.suit===c.suit));
          if(index>=0)h.splice(index,1);
        }
        g.resolve.prepared=false;
      }
      if(legacy&&g.phase==='resolve'&&g.resolve?.took){
        g.pendingRound={took:true,attacker:g.attacker,defender:g.defender};g.phase='roundEnd';
      }
      if(legacy&&g.over&&typeof g.settled!=='boolean')g.settled=true; // Only pre-settlement saves imply an already paid historical result.
      const visible=g.table.reduce((n,p)=>n+1+(p.d?1:0),0);
      if(!Number.isFinite(g.discardCount))g.discardCount=Math.max(0,36-g.deck.length-g.players.reduce((n,p)=>n+p.hand.length,0)-visible);
      if(g.trumpCard===undefined)g.trumpCard=null; // Old saves did not record the exposed card.
      if(!g.deck.length&&!g.over)g.players.forEach((p,i)=>{if(!p.hand.length&&!g.table.length&&!g.finished.includes(i))g.finished.push(i)});
      g.engineVersion=DURAK_ENGINE_VERSION;normalizeDurakStyles(g);
      return g;
    }

    function normalizeBunker(g){
      if(!g||!g.players?.[0]?.cards)return g;
      if(g.version!==BUNKER_VERSION){g.scenario=g.scenario||clone(bunkerScenarios[0]);g.events=g.events||clone(bunkerEvents.slice(0,3));g.selectedVote=null;g.voteLog=g.voteLog||[];g.settled=!!g.over;g.players.forEach(p=>p.cards.forEach(c=>{c.tags=c.tags||[]}));g.version=BUNKER_VERSION}
      g.id=g.id||legacyId('bunker',g);g.selectedCard=Number.isInteger(g.selectedCard)?g.selectedCard:null;g.selectedVote=Number.isInteger(g.selectedVote)?g.selectedVote:null;g.eliminated=g.eliminated||[];g.players.forEach((p,i)=>{if(p.kind==='bot'&&!Object.hasOwn(BUNKER_STYLES,p.botStyle))p.botStyle=BUNKER_STYLE_ORDER[Math.max(0,i-1)%3]});return g;
    }

    function validateMainGame(mode,value){
      try{
        if(mainGameKind(value)!==mode)return false;
        const g=JSON.parse(JSON.stringify(value)),integer=(n,min,max)=>Number.isInteger(n)&&n>=min&&n<=max,unique=list=>new Set(list).size===list.length;
        if(typeof g.over!=='boolean'||!integer(g.round,1,mode==='durak'?10000:3)||!['easy','normal','hard'].includes(g.diff)||!integer(g.stake,0,1000))return false;
        if(g.id!==undefined&&(typeof g.id!=='string'||!g.id.length||g.id.length>200))return false;
        if(g.players.some((p,i)=>!p||typeof p.name!=='string'||typeof p.face!=='string'||p.kind!==(i?'bot':'human')))return false;
        if(mode==='durak'){
          if(g.engineVersion!==undefined&&![1,2,3].includes(g.engineVersion)||g.players.some(p=>p.kind==='bot'&&p.botStyle!==undefined&&!['careful','pressure','flexible'].includes(p.botStyle)))return false;
          if(!integer(g.players.length,2,4)||!Array.isArray(g.table)||g.table.length>6||!['attack','defend','resolve','roundEnd','over'].includes(g.phase)||!['♠','♥','♦','♣'].includes(g.trump))return false;
          if(!integer(g.attacker,0,g.players.length-1)||!integer(g.defender,0,g.players.length-1)||g.attacker===g.defender||g.players.some(p=>!Array.isArray(p.hand)||p.hand.length>36))return false;
          const validCard=c=>c&&['6','7','8','9','10','J','Q','K','A'].includes(c.rank)&&['♠','♥','♦','♣'].includes(c.suit)&&c.id===c.rank+c.suit&&c.color===(['♥','♦'].includes(c.suit)?'red':'black');
          if(g.deck.length>36||g.table.some(p=>!p||!validCard(p.a)||(p.d&&!validCard(p.d))))return false;
          if(g.finished!==undefined&&(!Array.isArray(g.finished)||!unique(g.finished)||g.finished.some(i=>!integer(i,0,g.players.length-1))))return false;
          if(g.trumpCard!=null&&!validCard(g.trumpCard))return false;
          if(g.journal!==undefined){const publicCard=c=>c&&['6','7','8','9','10','J','Q','K','A'].includes(c.rank)&&['♠','♥','♦','♣'].includes(c.suit)&&Object.keys(c).every(k=>['rank','suit'].includes(k));
            if(!Array.isArray(g.journal)||g.journal.length>80||g.journal.some(e=>!e||!integer(e.round,1,g.round)||!['start','attack','defense','take','discard','draw','next','out','end'].includes(e.kind)||Object.keys(e).some(k=>!['round','kind','actor','card','against','count'].includes(k))||!(e.kind==='end'&&e.actor===null)&&!integer(e.actor,0,g.players.length-1)||['attack','defense'].includes(e.kind)&&!publicCard(e.card)||e.kind==='defense'&&!publicCard(e.against)||['take','discard','draw'].includes(e.kind)&&!integer(e.count,1,36)))return false;
          }
          normalizeDurakGame(g);
          const cards=[...g.deck,...g.players.flatMap(p=>p.hand),...g.table.flatMap(p=>p.d?[p.a,p.d]:[p.a])];
          if(cards.some(c=>!validCard(c))||!unique(cards.map(c=>c.id))||!integer(g.discardCount,0,36)||cards.length+g.discardCount!==36)return false;
          if(g.phase==='roundEnd'&&(!g.pendingRound||g.pendingRound.attacker!==g.attacker||g.pendingRound.defender!==g.defender||typeof g.pendingRound.took!=='boolean'))return false;
          if(g.phase==='defend'&&(!g.table.length||g.table[g.table.length-1].d))return false;
          if(!g.over&&g.phase==='over'||g.over&&g.phase!=='over')return false;
          if(g.table.some((p,i)=>p.d&&!beats(p.d,p.a,g)||!p.d&&i<g.table.length-1))return false;
          if(g.roundLimit!==null&&g.roundLimit!==undefined&&!integer(g.roundLimit,1,6))return false;
          if(!g.over&&g.finished.some(i=>g.players[i].hand.length))return false;
          g.selected=integer(g.selected,0,g.players[0].hand.length-1)?g.selected:null;
          g.paused=!!g.paused;
        }else{
          if(g.version!==undefined&&![1,2].includes(g.version)||g.players.some(p=>p.kind==='bot'&&p.botStyle!==undefined&&!['pragmatic','team','focused'].includes(p.botStyle)))return false;
          if(g.players.length!==6||!['reveal','vote','voteResult','over'].includes(g.phase)||g.stake!==100)return false;
          const types=['profession','health','hobby','baggage','phobia','fact'],tags=['medical','technical','food','survival','social'];
          if(g.players.some(p=>typeof p.alive!=='boolean'||!Array.isArray(p.cards)||p.cards.length!==6||!unique(p.cards.map(c=>c?.type))||p.cards.some(c=>!c||!types.includes(c.type)||typeof c.title!=='string'||typeof c.label!=='string'||typeof c.revealed!=='boolean'||!integer(c.score,0,20)||c.tags!==undefined&&(!Array.isArray(c.tags)||c.tags.some(t=>!tags.includes(t))))))return false;
          normalizeBunker(g);
          if(!g.scenario||!tags.includes(g.scenario.focus)||['name','code','duration','text'].some(k=>typeof g.scenario[k]!=='string')||!Array.isArray(g.events)||g.events.length!==3||g.events.some(e=>!e||!tags.includes(e.focus)||typeof e.title!=='string'||typeof e.text!=='string'))return false;
          if(!Array.isArray(g.eliminated)||g.eliminated.length>3||!unique(g.eliminated)||g.eliminated.some(i=>!integer(i,0,5)||g.players[i].alive))return false;
          const validVotes=v=>Array.isArray(v)&&v.length===6&&v.every(n=>integer(n,0,6));
          const validVote=v=>v&&integer(v.out,0,5)&&integer(v.round,1,3)&&integer(v.count,1,6)&&Array.isArray(v.tied)&&v.tied.length>0&&v.tied.every(i=>integer(i,0,5))&&(!v.votes||validVotes(v.votes))&&(!v.ballots||Array.isArray(v.ballots)&&v.ballots.every(b=>b&&integer(b.from,0,5)&&integer(b.to,0,5)&&b.from!==b.to));
          if(g.votes!==null&&g.votes!==undefined&&!validVotes(g.votes)||!Array.isArray(g.voteLog)||g.voteLog.length>3||g.voteLog.some(v=>!validVote(v))||g.lastVote&&!validVote(g.lastVote))return false;
          if(g.phase==='voteResult'&&(!validVotes(g.votes)||!validVote(g.lastVote)))return false;
          if(g.over&&(g.phase!=='over'||!['survived','lost'].includes(g.result))||!g.over&&g.phase==='over')return false;
          g.selectedCard=integer(g.selectedCard,0,5)&&!g.players[0].cards[g.selectedCard].revealed?g.selectedCard:null;
          g.selectedVote=integer(g.selectedVote,1,5)&&g.players[g.selectedVote].alive?g.selectedVote:null;
        }
        g.settled=!!g.settled;return g;
      }catch{return false}
    }

function validPokerSave(value){
  try{
    const n=v=>Number.isInteger(v)&&v>=0&&v<=4000,id=v=>typeof v==='string'&&/^poker-[a-z0-9-]{3,95}$/.test(v);
    if(!value||![2,3].includes(value.version)||!id(value.id)||!Array.isArray(value.players)||value.players.length!==4)return false;
    const g=value,stageCards={preflop:0,flop:3,turn:4,river:5};
    if(!Object.hasOwn(stageCards,g.stage)||!['betting','review','over'].includes(g.phase)||typeof g.over!=='boolean'||g.over!==(g.phase==='over'))return false;
    if(![g.deck,g.burn,g.community,g.history].every(Array.isArray)||g.community.length!==stageCards[g.stage]||g.history.some(x=>typeof x!=='string'))return false;
    if(!n(g.pot)||!n(g.currentBet)||!n(g.minRaise)||g.minRaise===0||!Number.isInteger(g.button)||g.button<0||g.button>3)return false;
    if(!g.players.every((p,i)=>p&&typeof p.name==='string'&&p.name.length<=100&&p.kind===(i===0?'human':'bot')&&typeof p.folded==='boolean'&&Array.isArray(p.hand)&&[0,2].includes(p.hand.length)&&[p.chips,p.roundBet,p.totalBet].every(n)&&p.roundBet<=p.totalBet&&(!p.hand.length?p.folded:true)))return false;
    const all=[...g.deck,...g.burn,...g.community,...g.players.flatMap(p=>p.hand)],deck=new Map(makeDeck().map(c=>[c.id,c]));
    if(all.length!==52||new Set(all.map(c=>c?.id)).size!==52||all.some(c=>!deck.has(c?.id)||c.rank!==deck.get(c.id).rank||c.suit!==deck.get(c.id).suit||c.v!==deck.get(c.id).v))return false;
    if(g.players.reduce((sum,p)=>sum+p.chips,0)+g.pot!==4000)return false;
    const contributed=g.players.reduce((sum,p)=>sum+p.totalBet,0);
    if(!g.over&&g.pot!==contributed)return false;
    if(g.phase==='betting'&&(!Number.isInteger(g.toAct)||g.toAct<0||g.toAct>3||g.players[g.toAct].folded||!g.players[g.toAct].chips))return false;
    if(g.phase!=='betting'&&g.toAct!==-1)return false;
    if(g.version===3&&(!id(g.tableId)||!Number.isInteger(g.handNumber)||g.handNumber<1||!Array.isArray(g.handStartChips)||g.handStartChips.length!==4||!g.handStartChips.every(n)||g.handStartChips.reduce((a,b)=>a+b,0)!==4000||!Array.isArray(g.tableHistory)||g.tableHistory.some(h=>!h||!Number.isInteger(h.number)||!Number.isFinite(h.net)||!Array.isArray(h.winners)||h.winners.some(x=>typeof x!=='string'))))return false;
    if(g.over&&(!n(g.paidPot)||g.paidPot!==contributed||!Array.isArray(g.prizes)||g.prizes.length!==4||!g.prizes.every(n)||g.prizes.reduce((a,b)=>a+b,0)!==g.paidPot||!Array.isArray(g.pots)||g.pots.some(p=>!p||!n(p.amount)||!Array.isArray(p.winners)||!p.winners.length||p.winners.some(i=>!Number.isInteger(i)||i<0||i>3))||g.payout!==Math.floor(g.players[0].chips/10)||g.profit!==g.payout-100))return false;
    return true;
  }catch{return false}
}

function validGame(x){
 var object=function(v){return !!v&&typeof v==='object'&&!Array.isArray(v)},id=function(v){return Number.isInteger(v)&&v>=0&&v<7},maybeId=function(v){return v===null||id(v)},strings=function(v){return Array.isArray(v)&&v.every(function(s){return typeof s==='string'})},ballots=function(v){return Array.isArray(v)&&v.length<=7&&v.every(function(b){return object(b)&&id(b.voter)&&id(b.target)&&b.voter!==b.target})&&new Set(v.map(function(b){return b.voter})).size===v.length};
 if(!object(x)||x.version!==GAME_VERSION||typeof x.id!=='string'||!x.id||!Number.isInteger(x.round)||x.round<1||x.round>25||!['night','dawn','day','vote','voteResult','result'].includes(x.phase))return false;
 if(typeof x.over!=='boolean'||typeof x.settled!=='boolean'||x.over!==(x.phase==='result')||x.settled&&!x.over||x.paused!==undefined&&typeof x.paused!=='boolean')return false;
 if(!Array.isArray(x.players)||x.players.length!==7||!x.players.every(function(p,i){return object(p)&&p.id===i&&typeof p.name==='string'&&Object.prototype.hasOwnProperty.call(roleInfo,p.role)&&typeof p.alive==='boolean'&&p.kind===(i===0?'human':'bot')}))return false;
 if(!strings(x.log)||!strings(x.privateNotes)||typeof x.message!=='string'||typeof x.nightText!=='string'||!['easy','normal','hard'].includes(x.diff)||!maybeId(x.nightTarget)||!maybeId(x.dayTarget))return false;
 if(!Array.isArray(x.revealed)||!x.revealed.every(id)||new Set(x.revealed).size!==x.revealed.length||!ballots(x.ballots))return false;
 if(x.votes!==null&&(!object(x.votes)||!Object.entries(x.votes).every(function(v){return id(+v[0])&&Number.isInteger(v[1])&&v[1]>=0&&v[1]<=7})))return false;
 if(!object(x.knowledge)||!Object.entries(x.knowledge).every(function(v){return id(+v[0])&&object(v[1])&&Object.entries(v[1]).every(function(k){return id(+k[0])&&['mafia','town'].includes(k[1])})}))return false;
 if(!object(x.publicSuspicion)||!Object.entries(x.publicSuspicion).every(function(v){return id(+v[0])&&Number.isFinite(v[1])})||!object(x.lastDoctorTarget)||!Object.entries(x.lastDoctorTarget).every(function(v){return id(+v[0])&&id(v[1])}))return false;
 if(!Array.isArray(x.statements)||!x.statements.every(function(s){return object(s)&&id(s.actor)&&maybeId(s.target)&&typeof s.text==='string'&&(s.context===undefined||typeof s.context==='string')}))return false;
 if(x.statementsRound!==undefined&&x.statementsRound!==null&&(!Number.isInteger(x.statementsRound)||x.statementsRound<1||x.statementsRound>x.round))return false;
 if(x.voteHistory!==undefined&&(!Array.isArray(x.voteHistory)||x.voteHistory.length>25||new Set(x.voteHistory.map(function(v){return v&&v.round})).size!==x.voteHistory.length||!x.voteHistory.every(function(v){return object(v)&&Number.isInteger(v.round)&&v.round>0&&v.round<=x.round&&ballots(v.ballots)&&(v.eliminated===undefined||maybeId(v.eliminated))&&typeof v.message==='string'})))return false;
 if(x.eliminated!==undefined&&!maybeId(x.eliminated))return false;
 if(x.personalMarks!==undefined&&(!object(x.personalMarks)||!Object.entries(x.personalMarks).every(function(v){return /^[1-6]$/.test(v[0])&&['suspect','unsure','trust'].includes(v[1])})))return false;
 if(x.over&&(!['town','mafia','draw'].includes(x.winningTeam)||typeof x.win!=='boolean'||typeof x.draw!=='boolean'||typeof x.resultReason!=='string'||x.draw!==(x.winningTeam==='draw')||x.win!==(x.winningTeam===roleInfo[x.players[0].role].team)))return false;
 return true;
}

function restore(value){
  if(!value||value.version!==3||typeof value.id!=='string'||!value.id||!Array.isArray(value.players)||value.players.length!==4||!Array.isArray(value.board)||value.board.length!==20)return null;
  var integer=function(n,min,max){return Number.isInteger(n)&&n>=min&&n<=max};
  if(!integer(value.turn,0,3)||!integer(value.turnNumber,1,80)||!['ready','rolling','buy','review','over'].includes(value.phase)||typeof value.over!=='boolean'||(value.phase==='over')!==value.over||!Number.isFinite(value.bank))return null;
  if(value.players.some(function(p,i){return !p||p.id!==i||typeof p.name!=='string'||!integer(p.money,0,2000000000)||!integer(p.pos,0,19)||typeof p.alive!=='boolean'||!integer(p.skip,0,1)}))return null;
  if(!value.players.some(function(p){return p.alive})||(!value.over&&(!value.players[0].alive||!value.players[value.turn].alive))||typeof value.settled!=='boolean'||(value.winner!==null&&value.winner!==0)||(!value.over&&(value.settled||value.winner!==null))||(value.winner===0&&!value.players[0].alive))return null;
  if(!Array.isArray(value.dice)||value.dice.length!==2||value.dice.some(function(n){return !integer(n,1,6)}))return null;
  if(value.phase==='rolling'&&(!integer(value.pendingSteps,2,12)||value.pendingSteps!==value.dice[0]+value.dice[1]))return null;
  if(value.board.some(function(c,i){return !c||(c.owner!==null&&(!integer(c.owner,0,3)||!value.players[c.owner].alive||boardTemplate[i].kind!=='property'))}))return null;
  if(Math.abs(value.players.reduce(function(n,p){return n+p.money},value.bank)-6000)>0.001)return null;
  var restored=Object.assign({},value);restored.players=value.players.map(function(p){return Object.assign({},p,{name:p.name.slice(0,24),properties:[]})});
  restored.board=boardTemplate.map(function(c,i){var next=Object.assign({},c,{owner:value.board[i].owner});if(next.owner!==null)restored.players[next.owner].properties.push(i);return next});
  var at=restored.board[restored.players[0].pos];if(value.phase==='buy'&&(value.turn!==0||at.kind!=='property'||at.owner!==null||restored.players[0].money<at.price))return null;
  restored.maxTurns=80;restored.paused=!restored.over;restored.pendingSteps=value.phase==='rolling'?value.pendingSteps:0;
  restored.diff=['easy','normal','hard'].includes(value.diff)?value.diff:'normal';restored.pace=['calm','normal'].includes(value.pace)?value.pace:'calm';
  restored.log=Array.isArray(value.log)?value.log.filter(function(t){return typeof t==='string'}).slice(0,60):[];
  restored.journal=Array.isArray(value.journal)?value.journal.filter(function(e){return e&&typeof e.text==='string'&&(e.turn===null||integer(e.turn,1,80))}).slice(0,60).map(function(e){return{turn:e.turn,text:e.text}}):restored.log.map(function(text){return{turn:null,text:text}});restored.message=typeof value.message==='string'?value.message:'Партия восстановлена.';
  restored.ledger=Array.isArray(value.ledger)?value.ledger.filter(function(e){return e&&integer(e.player,0,3)&&Number.isInteger(e.delta)&&integer(e.balance,0,2000000000)&&integer(e.turn,1,80)&&typeof e.label==='string'}).slice(0,240):[];
  restored.winners=Array.isArray(value.winners)?Array.from(new Set(value.winners.filter(function(id){return integer(id,0,3)&&restored.players[id].alive}))):[];
  restored.lastPath=Array.isArray(value.lastPath)?value.lastPath.filter(function(i){return integer(i,0,19)}).slice(-32):[];
  if(!integer(restored.lastFrom,0,19))restored.lastFrom=restored.players[restored.turn].pos;
  var roll=value.lastRoll;restored.lastRoll=roll&&roll.turn===value.turnNumber&&roll.player===value.turn&&Array.isArray(roll.dice)&&roll.dice.length===2&&roll.dice.every(function(n,i){return n===value.dice[i]})?roll:(value.phase==='rolling'||value.lastRoll===undefined&&['buy','review'].includes(value.phase)&&value.lastSteps>0)?{turn:value.turnNumber,player:value.turn,dice:value.dice.slice()}:null;
  var event=value.lastChance;restored.lastChance=event&&event.turn===value.turnNumber&&integer(event.player,0,3)&&typeof event.text==='string'&&Number.isFinite(event.delta)&&Number.isFinite(event.move)?event:null;
  return restored;
}

function normalizeMafia(value){
  if(!validGame(value))return false;
  value.voteHistory=Array.isArray(value.voteHistory)?value.voteHistory:[];
  if(!value.voteHistory.length&&value.ballots.length){const round=value.votes?value.round:value.round-1;if(round>0)value.voteHistory.push({round,ballots:value.ballots.map(b=>({voter:b.voter,target:b.target})),eliminated:value.eliminated,message:'Сохранённое голосование'})}
  return value;
}
function validate(game,payload,options){
  if(!games.has(game))throw new Error('Unknown session game');
  if(payload===null)return null;
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('Invalid session payload');
  const value=clone(payload),remote=options?.remote===true;
  if(remote){
    const current=game==='durak'?value.engineVersion===3:game==='bunker'?value.version===2:value.version===3;
    const id=key=>typeof value[key]==='string'&&value[key].length>0&&value[key].length<=100;
    if(!current||!id('id')||game==='poker'&&!id('tableId'))throw new Error('Remote session version or identifier missing');
    if(typeof value.settled!=='boolean'||value.settled&&!value.over)throw new Error('Invalid remote settlement state');
  }
  let result;
  if(game==='durak'||game==='bunker')result=validateMainGame(game,value);
  else if(game==='poker')result=validPokerSave(value)?value:false;
  else if(game==='mafia')result=normalizeMafia(value);
  else result=restore(value);
  if(!result)throw new Error('Invalid '+game+' session');
  if(remote&&!result.over&&game!=='bunker')result.paused=true;
  return clone(result);
}
root.VEZDEHOT_SESSION_VALIDATION=Object.freeze({validate});
if(typeof window!=='undefined'&&window!==root)window.VEZDEHOT_SESSION_VALIDATION=root.VEZDEHOT_SESSION_VALIDATION;
})(globalThis);
