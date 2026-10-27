const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const html=fs.readFileSync('dist/index.html','utf8');
const source=html.slice(html.indexOf('    function bindTop(){'),html.indexOf('    function render(){'));

// Attribute selectors see the root before its descendants, as querySelector does.
// Keep this harness dependency-free; native details activation is covered by browser QA.
function harness(withThemeButton=false,code=source){
  const node=(tagName,dataset={},parentElement=null)=>({tagName,dataset,parentElement,onclick:null,isConnected:true});
  const root=node('HTML',{theme:'dark'}),body=node('BODY',{},root),app=node('MAIN',{},body),details=node('DETAILS',{},app),summary=node('SUMMARY',{},details);
  const theme=withThemeButton?node('BUTTON',{theme:''},app):null,nodes=[root,body,app,details,summary,...(theme?[theme]:[])];
  const calls={save:0,render:0},document={documentElement:root,querySelector(selector){const match=selector.match(/^([a-z]+)?\[data-([a-z]+)\]$/);assert(match,'supported selector '+selector);return nodes.find(n=>(!match[1]||n.tagName===match[1].toUpperCase())&&Object.hasOwn(n.dataset,match[2]))||null}};
  const ctx={document,$:selector=>document.querySelector(selector),s:{theme:'dark',view:'bunker'},save(){calls.save++},render(){calls.render++;details.isConnected=false;summary.isConnected=false}};
  vm.createContext(ctx);vm.runInContext(code+'\nthis.bind=bindTop;',ctx);
  const click=target=>{const event={target};for(let current=target;current;current=current.parentElement)current.onclick?.(event)};
  return {ctx,root,details,summary,theme,calls,click,bind:ctx.bind};
}
let count=0;function test(name,fn){fn();count++;console.log('PASS '+name)}
test('binding top controls leaves root and native details unbound when no theme button exists',()=>{
  const h=harness();h.bind();assert.equal(h.root.onclick,null);assert.equal(h.details.onclick,null);assert.equal(h.summary.onclick,null);
  h.click(h.summary);assert.deepEqual(h.calls,{save:0,render:0});assert.equal(h.summary.isConnected,true);assert.equal(h.details.isConnected,true);assert.equal(h.ctx.s.theme,'dark');
});
test('an actual theme button changes the theme once without binding the document root',()=>{
  const h=harness(true);h.bind();assert.equal(h.root.onclick,null);assert.equal(typeof h.theme.onclick,'function');
  h.click(h.theme);assert.equal(h.ctx.s.theme,'light');assert.equal(h.root.dataset.theme,'light');assert.deepEqual(h.calls,{save:1,render:1});
  h.click(h.theme);assert.equal(h.ctx.s.theme,'dark');assert.equal(h.root.dataset.theme,'dark');assert.deepEqual(h.calls,{save:2,render:2});
});
test('the fixture catches the original ancestor handler detaching a clicked summary',()=>{
  const h=harness(false,source.replace("$('button[data-theme]')","$('[data-theme]')"));h.bind();h.click(h.summary);assert.equal(h.calls.render,1);assert.equal(h.summary.isConnected,false);
});
const navigation=html.split('// MAIN_NAVIGATION_START')[1].split('// MAIN_NAVIGATION_END')[0].split('\n').slice(1).join('\n');
function navigationHarness(){
  const calls=[],nodes=new Map(),document={activeElement:null},window={scrollY:0,scrollTo(options){calls.push({scroll:options.top});this.scrollY=options.top}},state={view:'lobby'};
  const element=(kind,extra={})=>({kind,tabIndex:-1,setAttribute(){},closest:()=>null,focus(options){document.activeElement=this;calls.push({focus:kind,preventScroll:options?.preventScroll})},...extra});
  const heading=element('heading'),app=element('app',{contains:node=>node?.inApp===true,querySelector:selector=>selector==='h1'?heading:nodes.get(selector)||null});
  const ctx={s:state,document,window,Number,Math};vm.createContext(ctx);vm.runInContext(navigation+'\nthis.begin=beginMainNavigation;this.finish=finishMainNavigation;',ctx);
  return {calls,nodes,document,window,state,element,heading,render(){ctx.finish(app,ctx.begin(app))}};
}
test('new local screens reset scroll once, while ordinary rerenders preserve an active control',()=>{
  const h=navigationHarness();h.window.scrollY=820;h.render();assert.equal(h.calls.length,0,'initial load must not reset browser position');
  h.state.view='room';h.render();assert.deepEqual(h.calls,[{focus:'heading',preventScroll:true},{scroll:0}]);
  const select=h.element('select',{inApp:true});h.document.activeElement=select;h.window.scrollY=330;h.calls.length=0;h.render();assert.equal(h.document.activeElement,select);assert.equal(h.window.scrollY,330);assert.equal(h.calls.length,0);
  h.state.view='bunker';h.render();assert.equal(h.window.scrollY,0);assert.equal(h.document.activeElement,h.heading);
});
test('returning to lobby restores its scroll and the new card control, not a detached element',()=>{
  const h=navigationHarness(),article={dataset:{clubGame:'bunker'}},old=h.element('old-card',{inApp:true,closest:selector=>selector==='[data-club-game]'?article:null});h.render();h.window.scrollY=1450;h.document.activeElement=old;
  h.state.view='room';h.render();h.state.view='bunker';h.render();
  const replacement=h.element('new-card',{inApp:true,tabIndex:0});h.nodes.set('[data-club-game="bunker"] .club-game-open',replacement);h.state.view='lobby';h.render();assert.equal(h.document.activeElement,replacement);assert.equal(h.window.scrollY,1450);assert.notEqual(h.document.activeElement,old);
});
test('saved-session launch restores its shelf button and missing lobby controls fall back to a heading',()=>{
  const h=navigationHarness();h.render();h.document.activeElement=h.element('resume',{inApp:true,dataset:{clubResume:'durak'}});h.window.scrollY=400;h.state.view='game';h.render();const replacement=h.element('new-resume',{inApp:true,tabIndex:0});h.nodes.set('[data-club-resume="durak"]',replacement);h.state.view='lobby';h.render();assert.equal(h.document.activeElement,replacement);assert.equal(h.window.scrollY,400);
  h.state.view='room';h.render();h.nodes.clear();h.state.view='lobby';h.render();assert.equal(h.document.activeElement,h.heading);
});
// Exercise the production startup block and room selection, with a stale saved
// game that would visibly advance if startup restored it before reading the URL.
const boot=html.slice(html.lastIndexOf('    s=load();'),html.lastIndexOf('  })();'));
const gameKind=html.slice(html.indexOf('    function mainGameKind('),html.indexOf('    function mainScope('));
const rememberGame=html.slice(html.indexOf('    function rememberMainGame('),html.indexOf('    function saveMainMetadata('));
const chooseRoom=html.slice(html.indexOf('    function chooseMainRoom('),html.indexOf('    function resumeMainGame('));
const resumeGame=html.slice(html.indexOf('    function resumeMainGame('),html.indexOf('    function mainSaveNotice('));
const startGame=html.slice(html.indexOf('    function startGame('),html.indexOf('    function newGame('));
function startupHarness(search='',active='durak',options={}){
  const durak=options.state?.savedGames.durak||{id:'saved-durak',players:[{hand:['6♠']},{hand:['7♠']}],deck:[],phase:'defend',over:false,paused:false,diff:'hard',stake:100};
  const bunker=options.state?.savedGames.bunker||{id:'saved-bunker',players:[{cards:['profession']}],phase:'voteResult',over:false,paused:false,diff:'normal'};
  const state=options.state||{view:active==='durak'?'game':'bunker',activeGame:active,game:active==='durak'?durak:bunker,savedGames:{durak,bunker},room:{mode:active,scenarioChoice:'random'}};
  if(options.terminal){state.game.over=true;state.game.settled=false;}
  const calls={renders:[],saves:[],advanced:0,normalized:0,settled:0,cleared:0,history:[],profiles:0,order:[]},listeners={},location=new URL('/index.html'+search,'https://example.test');
  const history={state:options.historyState||null,replaceState(value,title,path){calls.history.push([value,title,path]);calls.order.push('consume');this.state=value;location.href=new URL(path,location).href}};
  const ctx={s:null,URLSearchParams,location,history,navigator:{},document:{hidden:false,addEventListener:(name,fn)=>listeners[name]=fn},window:{addEventListener(){},VEZDEHOT:{openAccount(){calls.profiles++}}},load:()=>state,mainWritable:()=>options.writable!==false,code:()=> 'ABC234',normalizeBunkerChoice:value=>value||'random',clearDurakTimer(){calls.cleared++},save(){ctx.rememberMainGame();calls.saves.push({view:state.view,activeGame:state.activeGame,phase:state.game?.phase})},render(){calls.order.push('render');calls.renders.push({view:state.view,mode:state.room.mode,game:state.game?.id,phase:state.game?.phase})},advance(){calls.advanced++;state.game.phase='advanced'},normalizeDurakGame(){calls.normalized++},settle(game){calls.settled++;game.settled=true},settleBunker(game){calls.settled++;game.settled=true},newGame:()=>({...durak,id:'new-durak',stake:0}),toast(){}};
  vm.createContext(ctx);vm.runInContext(gameKind+rememberGame+chooseRoom+resumeGame+startGame+boot,ctx);return {state,durak,bunker,calls,listeners,location,resume:mode=>ctx.resumeMainGame(mode),start:()=>ctx.startGame({bots:1,diff:'normal',stake:0})};
}
test('server-to-lobby launch renders only the lobby and preserves the selected local game without advancing it',()=>{
  for(const active of ['durak','bunker']){
    const h=startupHarness('?view=lobby',active),saved=active==='durak'?h.durak:h.bunker;
    assert(h.calls.renders.length>0);assert(h.calls.renders.every(frame=>frame.view==='lobby'));assert.equal(h.calls.advanced,0);assert.equal(h.calls.normalized,0);assert.equal(h.calls.settled,0);assert.equal(h.state.game,saved);assert.equal(h.state.savedGames[active],saved);assert.equal(h.state.activeGame,active);assert.equal(saved.phase,active==='durak'?'defend':'voteResult');assert(h.calls.saves.every(frame=>frame.view==='lobby'));assert.deepEqual(h.calls.history,[[null,'','/index.html']]);assert.equal(h.calls.order[0],'consume');
  }
});
test('explicit lobby navigation does not settle an old local result as a side effect',()=>{
  for(const active of ['durak','bunker']){const h=startupHarness('?view=lobby',active,{terminal:true});assert.equal(h.calls.settled,0);assert.equal(h.state.game.settled,false);assert.equal(h.calls.advanced,0);assert(h.calls.renders.every(frame=>frame.view==='lobby'));}
});
test('explicit game launch chooses its saved room before first paint, keeps both games and cleans the URL',()=>{
  for(const mode of ['durak','bunker']){
    const h=startupHarness('?view=lobby&game='+mode+'&profile=1',mode==='durak'?'bunker':'durak'),chosen=mode==='durak'?h.durak:h.bunker;
    assert(h.calls.renders.length>0);assert(h.calls.renders.every(frame=>frame.view==='room'&&frame.mode===mode&&frame.game===chosen.id));assert.equal(h.state.game,chosen);assert.equal(h.state.savedGames.durak,h.durak);assert.equal(h.state.savedGames.bunker,h.bunker);assert.equal(h.calls.advanced,0);assert.equal(h.calls.normalized,0);assert.equal(h.calls.settled,0);assert.equal(h.durak.phase,'defend');assert.equal(h.bunker.phase,'voteResult');assert.deepEqual(h.calls.history,[[null,'','/index.html?profile=1']]);assert.equal(h.calls.order[0],'consume');assert.equal(h.calls.profiles,1);
  }
});
test('unknown game does not override an explicit lobby, and a read-only game launch still paints safely',()=>{
  const invalid=startupHarness('?view=lobby&game=unknown');assert(invalid.calls.renders.every(frame=>frame.view==='lobby'));assert.equal(invalid.calls.advanced,0);assert.deepEqual(invalid.calls.history,[[null,'','/index.html?game=unknown']]);
  const readonly=startupHarness('?game=bunker','durak',{writable:false});assert(readonly.calls.renders.length>0);assert(readonly.calls.renders.every(frame=>frame.view==='lobby'));assert.equal(readonly.calls.advanced,0);assert.equal(readonly.state.game,readonly.durak);
});
test('ordinary reload keeps existing resume and result-settlement behaviour',()=>{
  const h=startupHarness();assert.equal(h.calls.renders[0].view,'game');assert.equal(h.calls.normalized,1);assert.equal(h.calls.advanced,1);assert.equal(h.state.game.phase,'advanced');assert.equal(h.calls.history.length,0);
  for(const active of ['durak','bunker']){const terminal=startupHarness('',active,{terminal:true});assert.equal(terminal.calls.settled,1);assert.equal(terminal.state.game.settled,true);}
});
test('entry intents are consumed before paint without discarding other query parameters, hashes or history state',()=>{
  const historyState={returnTo:'catalog',scroll:450};
  for(const intent of ['view=lobby','game=durak','view=lobby&game=bunker']){
    const h=startupHarness('?'+intent+'&campaign=hello%20world&campaign=second&profile=1#club-games','durak',{historyState});
    assert.equal(h.calls.order[0],'consume');assert.equal(h.calls.history.length,1);assert.equal(h.calls.history[0][0],historyState);assert.equal(h.location.searchParams.has('view'),false);assert.equal(h.location.searchParams.has('game'),false);assert.deepEqual(h.location.searchParams.getAll('campaign'),['hello world','second']);assert.equal(h.location.searchParams.get('profile'),'1');assert.equal(h.location.hash,'#club-games');assert.equal(h.calls.profiles,1);
  }
  const unrelated=startupHarness('?view=unknown&game=unknown&campaign=x#section');assert.equal(unrelated.calls.history.length,0);assert.equal(unrelated.location.search,'?view=unknown&game=unknown&campaign=x');assert.equal(unrelated.location.hash,'#section');
});
test('return to lobby then resume either local game survives reload in that same game',()=>{
  for(const mode of ['durak','bunker']){
    const entry=startupHarness('?view=lobby&campaign=return#club-games',mode);entry.resume(mode);const saved=JSON.parse(JSON.stringify(entry.state));
    const reloaded=startupHarness(entry.location.search+entry.location.hash,mode,{state:saved});
    assert.equal(reloaded.calls.renders[0].view,mode==='durak'?'game':'bunker');assert.equal(reloaded.state.game.id,entry.state.game.id);assert.equal(reloaded.state.game.id,'saved-'+mode);assert.equal(reloaded.calls.history.length,0);assert.equal(reloaded.location.searchParams.get('campaign'),'return');
  }
});
test('lobby or room entry then starting a new local table reloads that new table',()=>{
  for(const intent of ['?view=lobby','?game=durak','?view=lobby&game=durak']){
    const entry=startupHarness(intent);entry.start();assert.equal(entry.state.view,'game');assert.equal(entry.state.game.id,'new-durak');
    const reloaded=startupHarness(entry.location.search,'durak',{state:JSON.parse(JSON.stringify(entry.state))});assert.equal(reloaded.calls.renders[0].view,'game');assert.equal(reloaded.state.game.id,'new-durak');assert.equal(reloaded.calls.history.length,0);
  }
});
test('read-only entry keeps its route until ownership-transfer reload can apply and consume it',()=>{
  for(const [intent,target] of [['?view=lobby','lobby'],['?game=bunker','room'],['?view=lobby&game=durak','room']]){
    const waiting=startupHarness(intent,'durak',{writable:false});assert.equal(waiting.calls.history.length,0);assert.equal(waiting.location.search,intent);
    const active=startupHarness(waiting.location.search,'durak',{writable:true});assert.equal(active.calls.renders[0].view,target);assert.equal(active.calls.history.length,1);assert.equal(active.location.search,'');assert.equal(active.calls.advanced,0);
  }
});
test('ordinary home and lobby links route to lobby even with a different unfinished local game',()=>{
  let links=0;
  for(const file of ['index.html','poker.html','mafia.html','monopoly.html']){
    const text=fs.readFileSync('dist/'+file,'utf8');
    for(const match of text.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)){
      const attrs=match[1],body=match[2],className=attrs.match(/class="([^"]*)"/)?.[1]||'';
      if(!/(?:^|\s)(?:brand|pk-brand|pk-back|dt-brand|club-logo|back|icon-button)(?:\s|$)/.test(className)&&!/(?:В лобби|Все игры)/.test(body))continue;
      const href=attrs.match(/href="([^"]*)"/)?.[1];assert(href,file+' has a navigation destination');const url=new URL(href,'https://example.test/'+file);links++;
      assert.equal(url.searchParams.get('view'),'lobby',file+' '+className+' opens the lobby explicitly');
      for(const mode of ['durak','bunker']){const h=startupHarness(url.search,mode);assert(h.calls.renders.every(frame=>frame.view==='lobby'));assert.equal(h.calls.advanced,0);assert.equal(h.state.game.id,'saved-'+mode);}
    }
  }
  assert.equal(links,10,'covers two index logos, two poker links, two Mafia links and four Monopoly links');
});
test('Durak logo preserves native modified-click navigation and ordinary activation returns in place',()=>{
  const binding=html.slice(html.indexOf('    function bindGame(){'),html.indexOf('    // MAIN_GUIDES_START'));
  function bound(){
    const brand={},calls={save:0,render:0,clear:0},state={view:'game',game:{id:'kept-game',paused:false}};
    const ctx={s:state,$:selector=>selector==='[data-game-brand]'?brand:null,$$:()=>[],mainWritable:()=>true,document:{hidden:false},clearDurakTimer(){calls.clear++},save(){calls.save++},render(){calls.render++}};
    for(const name of ['playAttack','humanDefend','humanTake','finishAttack','continueRound','replayDurak','settle','advance','bindDurakCards','durakHelp'])ctx[name]=()=>{};
    vm.createContext(ctx);vm.runInContext(binding+';bindGame()',ctx);return {brand,calls,state};
  }
  for(const modifier of [{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true},{button:1},{defaultPrevented:true}]){
    const h=bound();let prevented=false;h.brand.onclick({button:0,...modifier,preventDefault(){prevented=true}});assert.equal(prevented,false);assert.equal(h.state.view,'game');assert.deepEqual(h.calls,{save:0,render:0,clear:0});
  }
  // Native keyboard-generated clicks and ordinary pointer clicks both use button 0.
  for(const detail of [0,1]){const h=bound();let prevented=false;h.brand.onclick({button:0,detail,preventDefault(){prevented=true}});assert.equal(prevented,true);assert.equal(h.state.view,'lobby');assert.equal(h.state.game.id,'kept-game');assert.deepEqual(h.calls,{save:1,render:1,clear:1});}
});
console.log(count+' main navigation checks passed');
