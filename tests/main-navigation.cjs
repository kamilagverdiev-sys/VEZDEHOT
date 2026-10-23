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
console.log(count+' main navigation checks passed');
