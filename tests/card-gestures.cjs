'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('dist/card-gestures.js','utf8');

// This event model exercises capture/bubbling and identity fences without a DOM
// implementation, browser automation, network service or production identity.
class Target{
 constructor(){this.listeners=new Map()}
 addEventListener(type,fn,opts){const list=this.listeners.get(type)||[];list.push({fn,capture:typeof opts==='boolean'?opts:!!opts?.capture});this.listeners.set(type,list)}
 removeEventListener(type,fn,capture){this.listeners.set(type,(this.listeners.get(type)||[]).filter(x=>x.fn!==fn||x.capture!==!!capture))}
}
class Element extends Target{
 constructor(doc,tag='div',attrs={},bounds={left:0,top:0,width:100,height:100}){super();this.ownerDocument=doc;this.tagName=tag.toUpperCase();this.attrs={...attrs};this.children=[];this.parentElement=null;this.bounds={...bounds};this.style={};this.captured=new Set();this.classes=new Set((attrs.class||'').split(' ').filter(Boolean));this.classList={add:(...v)=>v.forEach(x=>this.classes.add(x)),remove:(...v)=>v.forEach(x=>this.classes.delete(x)),contains:v=>this.classes.has(v),toggle:(v,on)=>{if(on===undefined)on=!this.classes.has(v);on?this.classes.add(v):this.classes.delete(v);return on}}}
 get isConnected(){let node=this;while(node){if(node===this.ownerDocument.body)return true;node=node.parentElement}return false}
 get disabled(){return Object.hasOwn(this.attrs,'disabled')}
 set disabled(v){if(v)this.attrs.disabled='';else delete this.attrs.disabled}
 getAttribute(k){return k==='class'?[...this.classes].join(' '):this.attrs[k]??null}
 setAttribute(k,v){if(k==='class')this.classes=new Set(String(v).split(' '));else this.attrs[k]=String(v)}
 removeAttribute(k){delete this.attrs[k]}
 appendChild(child){child.remove();this.children.push(child);child.parentElement=this;return child}
 remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(x=>x!==this);this.parentElement=null}
 contains(other){for(let n=other;n;n=n.parentElement)if(n===this)return true;return false}
 matches(selector){return selector.split(',').some(s=>{s=s.trim();return s.startsWith('.')?this.classes.has(s.slice(1)):s.startsWith('[')?Object.hasOwn(this.attrs,s.slice(1,-1)):this.tagName===s.toUpperCase()})}
 closest(selector){for(let n=this;n;n=n.parentElement)if(n.matches(selector))return n;return null}
 querySelectorAll(selector){return this.children.flatMap(c=>[...(c.matches(selector)?[c]:[]),...c.querySelectorAll(selector)])}
 getBoundingClientRect(){const r=this.bounds;return {...r,right:r.left+r.width,bottom:r.top+r.height}}
 cloneNode(deep){const n=new Element(this.ownerDocument,this.tagName,{...this.attrs,class:[...this.classes].join(' ')},this.bounds);if(deep)this.children.forEach(c=>n.appendChild(c.cloneNode(true)));return n}
 setPointerCapture(id){this.captured.add(id)}
 hasPointerCapture(id){return this.captured.has(id)}
 releasePointerCapture(id){this.captured.delete(id);this.onRelease?.()}
}
function environment(){
 const doc=new Target(),win=new Target();doc.hidden=false;doc.defaultView=win;doc.body=new Element(doc,'body');
 const root=doc.body.appendChild(new Element(doc,'main'));
 const card=root.appendChild(new Element(doc,'button',{class:'card',id:'original-card','data-card-id':'A♠'},{left:100,top:400,width:60,height:90}));
 const symbol=card.appendChild(new Element(doc,'span',{id:'card-symbol'}));
 const zone=root.appendChild(new Element(doc,'div',{'data-drop-zone':''},{left:50,top:50,width:250,height:220}));
 const clicks=[],drops=[],cancels=[];let key='account-A|revision-1',legal=true,dropLegal=true,callback=null;
 const context={window:{},WeakMap,Object,Array,Math,Number,Date,TypeError};vm.createContext(context);vm.runInContext(source,context);
 const options={root,cardSelector:'.card',dropSelector:'[data-drop-zone]',getCardId:el=>el.getAttribute('data-card-id'),canStart:()=>legal,canDrop:()=>dropLegal,getStateKey:()=>key,onDrop:id=>{drops.push(id);callback?.(id)},onCancel:reason=>cancels.push(reason)};
 let binding=context.window.VEZDEHOT_CARDS.bind(options);
 card.addEventListener('click',()=>clicks.push('tap'));
 const fire=(type,target=card,fields={})=>{
  const e={type,target,pointerId:1,pointerType:'mouse',isPrimary:true,button:0,clientX:130,clientY:430,detail:1,defaultPrevented:false,stopped:false,preventDefault(){this.defaultPrevented=true},stopImmediatePropagation(){this.stopped=true},...fields};
  const path=target===win?[win]:target===doc?[win,doc]:[win,doc,...(()=>{const p=[];for(let n=target;n;n=n.parentElement)p.unshift(n);return p})()];
  for(const capture of [true,false])for(const node of capture?path:[...path].reverse())for(const listener of [...(node.listeners.get(type)||[])]){if(e.stopped)return e;if(listener.capture===capture)listener.fn(e)}return e;
 };
 return {doc,win,root,card,symbol,zone,clicks,drops,cancels,fire,get binding(){return binding},rebind(next={}){binding=context.window.VEZDEHOT_CARDS.bind({...options,...next});return binding},setKey:value=>key=value,setLegal:value=>legal=value,setDropLegal:value=>dropLegal=value,onDrop:fn=>callback=fn,ghosts:()=>doc.body.querySelectorAll('.vh-card-ghost')};
}
function drag(e,fields={}){e.fire('pointerdown',e.card,fields);e.fire('pointermove',e.card,{clientX:140,clientY:240,...fields})}

test('a simple pointer tap and keyboard activation remain with existing card click handlers',()=>{
 const e=environment();e.fire('pointerdown');e.fire('pointerup');const click=e.fire('click');assert.equal(click.defaultPrevented,false);e.fire('click',e.card,{detail:0});assert.deepEqual(e.clicks,['tap','tap']);assert.equal(e.drops.length,0);assert.equal(e.ghosts().length,0);
});
test('legal drag submits once only inside the table and suppresses its trailing click',()=>{
 const e=environment();drag(e);assert.equal(e.ghosts().length,1);assert(e.zone.classList.contains('vh-drop-ready'));assert(e.zone.classList.contains('vh-drop-over'));
 e.fire('pointerup',e.card,{clientX:140,clientY:240});e.fire('pointerup',e.card,{clientX:140,clientY:240});assert.deepEqual(e.drops,['A♠']);assert.equal(e.ghosts().length,0);assert(!e.zone.classList.contains('vh-drop-ready'));assert(!e.card.classList.contains('vh-card-dragging'));assert.equal(e.fire('click').defaultPrevented,true);assert.equal(e.clicks.length,0);
 e.fire('pointerdown');e.fire('pointerup');e.fire('click');assert.deepEqual(e.clicks,['tap'],'a fresh intentional tap is never blocked');
});
test('touch horizontal motion remains scrollable and cannot turn into a card selection or drop',()=>{
 const e=environment();e.fire('pointerdown',e.card,{pointerType:'touch'});const moved=e.fire('pointermove',e.card,{pointerType:'touch',clientX:170,clientY:435});assert.equal(moved.defaultPrevented,false);e.fire('pointerup');e.fire('click');assert.deepEqual(e.cancels,['horizontal_scroll']);assert.equal(e.drops.length,0);assert.equal(e.clicks.length,0);assert.equal(e.ghosts().length,0);
});
test('touch vertical lift crosses the threshold before drag begins',()=>{
 const e=environment();e.fire('pointerdown',e.card,{pointerType:'touch'});e.fire('pointermove',e.card,{pointerType:'touch',clientX:132,clientY:425});assert.equal(e.ghosts().length,0);const moved=e.fire('pointermove',e.card,{pointerType:'touch',clientX:133,clientY:410});assert.equal(moved.defaultPrevented,true);assert.equal(e.ghosts().length,1);e.fire('pointerup',e.card,{clientX:140,clientY:200});assert.deepEqual(e.drops,['A♠']);
});
test('drag outside every drop zone restores the card without playing or selecting it',()=>{
 const e=environment();drag(e);e.fire('pointerup',e.card,{clientX:400,clientY:200});assert.equal(e.drops.length,0);assert.equal(e.ghosts().length,0);assert(!e.zone.classList.contains('vh-drop-over'));assert.equal(e.fire('click').defaultPrevented,true);assert.deepEqual(e.cancels,['invalid_drop']);
});
test('revision, account, card identity and ownership changes reject the in-flight drag',()=>{
 for(const change of [e=>e.setKey('account-B|revision-1'),e=>e.setKey('account-A|revision-2'),e=>e.setLegal(false),e=>e.setDropLegal(false),e=>e.card.setAttribute('data-card-id','6♥'),e=>e.card.disabled=true,e=>e.root.remove()]){
  const e=environment();drag(e);change(e);e.fire('pointerup',e.card,{clientX:140,clientY:200});assert.equal(e.drops.length,0);assert.equal(e.ghosts().length,0);
 }
});
test('release-capture observers cannot change ownership between validation and submission',()=>{
 const e=environment();drag(e);e.card.onRelease=()=>e.setKey('other-account');e.fire('pointerup',e.card,{clientX:140,clientY:200});assert.equal(e.drops.length,0);assert.equal(e.ghosts().length,0);
});
test('disabled, aria-disabled, non-primary and non-left pointers never start a drag',()=>{
 for(const setup of [e=>e.card.disabled=true,e=>e.card.setAttribute('aria-disabled','true'),e=>e.setLegal(false)]){const e=environment();setup(e);drag(e);e.fire('pointerup',e.card,{clientX:140,clientY:200});assert.equal(e.drops.length,0);assert.equal(e.ghosts().length,0)}
 for(const fields of [{button:2},{isPrimary:false}]){const e=environment();drag(e,fields);e.fire('pointerup',e.card,{clientX:140,clientY:200});assert.equal(e.drops.length,0);assert.equal(e.ghosts().length,0)}
});
test('pointer cancellation, lost capture, Escape, blur, resize and scrolling always cancel',()=>{
 for(const [type,target,fields] of [['pointercancel','card',{}],['lostpointercapture','card',{}],['keydown','doc',{key:'Escape'}],['blur','win',{}],['resize','win',{}],['scroll','win',{}]]){
  const e=environment();drag(e);e.fire(type,e[target],fields);e.fire('pointerup',e.card,{clientX:140,clientY:200});assert.equal(e.drops.length,0,type);assert.equal(e.ghosts().length,0,type);assert.equal(e.fire('click').defaultPrevented,true,type);
 }
});
test('hidden pages and account/session events cancel before a late pointer release',()=>{
 for(const type of ['visibilitychange','vezdehot:accountchange','vezdehot:sessionpause','vezdehot:sessionlost']){const e=environment();drag(e);if(type==='visibilitychange')e.doc.hidden=true;e.fire(type,e.doc);e.doc.hidden=false;e.fire('pointerup',e.card,{clientX:140,clientY:200});assert.equal(e.drops.length,0,type);assert.equal(e.ghosts().length,0,type)}
});
test('a second pointer cancels the active card and never takes over the gesture',()=>{
 for(const second of [{pointerType:'touch',isPrimary:false},{pointerType:'mouse',isPrimary:true}]){const e=environment();drag(e,{pointerType:'touch'});e.fire('pointerdown',e.card,{pointerId:2,...second});e.fire('pointermove',e.card,{pointerId:2,clientX:140,clientY:200,...second});e.fire('pointerup',e.card,{clientX:140,clientY:200});e.fire('pointerup',e.card,{pointerId:2,clientX:140,clientY:200,...second});assert.equal(e.drops.length,0);assert.deepEqual(e.cancels,['multiple_pointers']);assert.equal(e.ghosts().length,0)}
});
test('the ghost has no duplicate IDs and cannot become a focusable or pointer target',()=>{
 const e=environment();drag(e);const ghost=e.ghosts()[0];assert.equal(ghost.getAttribute('id'),null);assert.equal(ghost.querySelectorAll('[id]').length,0);assert.equal(ghost.getAttribute('aria-hidden'),'true');assert.equal(ghost.getAttribute('tabindex'),'-1');assert.equal(ghost.getAttribute('inert'),'');assert.equal(ghost.style.pointerEvents,'none');assert.equal(e.card.getAttribute('id'),'original-card');e.binding.destroy();
});
test('destroying or rebinding cancels the old drag and does not duplicate event handling',()=>{
 const e=environment();drag(e);e.rebind();assert.equal(e.ghosts().length,0);e.fire('pointerup',e.card,{clientX:140,clientY:200});assert.equal(e.drops.length,0);drag(e);e.fire('pointerup',e.card,{clientX:140,clientY:200});assert.deepEqual(e.drops,['A♠']);e.binding.destroy();e.binding.destroy();assert.equal(e.root.getAttribute('data-card-drag'),null);
});
test('click suppression survives the submitting table being removed and replaced',()=>{
 const e=environment();let newCard,newRoot,newClicks=0;e.onDrop(()=>{e.binding.destroy();e.root.remove();newRoot=e.doc.body.appendChild(new Element(e.doc,'main'));newCard=newRoot.appendChild(new Element(e.doc,'button',{class:'card','data-card-id':'K♥'}));newCard.addEventListener('click',()=>newClicks++);e.rebind({root:newRoot})});
 drag(e);e.fire('pointerup',e.card,{clientX:140,clientY:200});assert.deepEqual(e.drops,['A♠']);assert.equal(e.fire('click',newCard).defaultPrevented,true);assert.equal(newClicks,0);assert.equal(e.fire('click',newCard,{detail:0}).defaultPrevented,false);assert.equal(newClicks,1);e.binding.destroy();
});
test('a candidate whose state changed before pointerup cannot become a stale click',()=>{
 const e=environment();e.fire('pointerdown');e.setKey('other-revision');e.fire('pointerup');assert.equal(e.fire('click').defaultPrevented,true);assert.equal(e.clicks.length,0);assert.equal(e.drops.length,0);
});
test('missing or hidden drop zones never submit a card',()=>{
 for(const change of [e=>e.zone.remove(),e=>e.zone.bounds.width=0]){const e=environment();change(e);drag(e);e.fire('pointerup',e.card,{clientX:140,clientY:200});assert.equal(e.drops.length,0);assert.equal(e.ghosts().length,0)}
});
test('an overlay or viewport edge covering a drop zone prevents a hidden action',()=>{
 for(const lookup of [e=>e.doc.body,e=>null]){const e=environment();e.doc.elementFromPoint=()=>lookup(e);drag(e);e.fire('pointerup',e.card,{clientX:140,clientY:200});assert.equal(e.drops.length,0);assert(!e.zone.classList.contains('vh-drop-over'))}
 const e=environment();e.doc.elementFromPoint=()=>e.zone;drag(e);e.fire('pointerup',e.card,{clientX:140,clientY:200});assert.deepEqual(e.drops,['A♠']);
});
