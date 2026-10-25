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
console.log(count+' main navigation checks passed');
