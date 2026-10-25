'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('dist/server-durak.js','utf8');
const ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',SCOPE='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const copy=v=>JSON.parse(JSON.stringify(v));
const decode=s=>s.replace(/&(?:amp|lt|gt|quot|#39);/g,c=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"}[c]));
// Small DOM contract model: the real renderer and bound event handlers run here.
// This deliberately does not stand in for browser layout, touch or visual QA.
class Element {
 constructor(doc,tag,attrs={}){this.ownerDocument=doc;this.tagName=tag.toUpperCase();this.attrs={...attrs};this.childNodes=[];this.parentElement=null;this._scrollLeft=0;this.scrollTop=0;this._value=undefined;this.dataset=new Proxy({}, {get:(_,k)=>this.attrs['data-'+String(k).replace(/[A-Z]/g,c=>'-'+c.toLowerCase())],set:(_,k,v)=>{this.attrs['data-'+String(k).replace(/[A-Z]/g,c=>'-'+c.toLowerCase())]=String(v);return true}});}
 append(node){this.childNodes.push(node);if(node instanceof Element)node.parentElement=this;}
 get children(){return this.childNodes.filter(n=>n instanceof Element)}
 get id(){return this.attrs.id||''}get className(){return this.attrs.class||''}
 get textContent(){return this.childNodes.map(n=>typeof n==='string'?n:n.textContent).join('')}
 hasAttribute(k){return Object.hasOwn(this.attrs,k)}getAttribute(k){return this.attrs[k]??null}setAttribute(k,v){this.attrs[k]=String(v)}
 get disabled(){return this.hasAttribute('disabled')}get open(){return this.hasAttribute('open')}set open(v){if(v)this.attrs.open='';else delete this.attrs.open;}
 get value(){if(this._value!==undefined)return this._value;if(this.tagName==='SELECT'){const options=this.querySelectorAll('option');return (options.find(o=>o.hasAttribute('selected'))||options[0])?.value||''}return this.attrs.value||''}set value(v){this._value=String(v)}
 get scrollWidth(){return this.className.split(' ').includes('sd-hand')?Math.max(300,this.children.length*65):300}get clientWidth(){return 300}
 get scrollLeft(){return this._scrollLeft}set scrollLeft(v){this._scrollLeft=Math.max(0,Math.min(Number(v)||0,this.scrollWidth-this.clientWidth))}
 contains(node){return node===this||this.children.some(child=>child.contains(node))}
 matches(selector){if(selector.startsWith('#'))return this.id===selector.slice(1);if(selector.startsWith('.'))return this.className.split(' ').includes(selector.slice(1));if(selector.startsWith('[')){const [,name,value]=selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/)||[];return name&&this.hasAttribute(name)&&(value===undefined||this.getAttribute(name)===value)}return this.tagName===selector.toUpperCase();}
 querySelectorAll(selector){const parts=selector.split(/\s+/),all=[];const visit=node=>{for(const child of node.children){all.push(child);visit(child)}};visit(this);return all.filter(node=>{if(!node.matches(parts.at(-1)))return false;let ancestor=node.parentElement;for(let i=parts.length-2;i>=0;i--){while(ancestor&&!ancestor.matches(parts[i]))ancestor=ancestor.parentElement;if(!ancestor)return false;ancestor=ancestor.parentElement}return true})}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null}
 focus(){if(!this.disabled&&this.ownerDocument.body.contains(this))this.ownerDocument.activeElement=this;}
 set innerHTML(markup){if(this.contains(this.ownerDocument.activeElement))this.ownerDocument.activeElement=this.ownerDocument.body;for(const child of this.children)child.parentElement=null;this.childNodes=[];parseInto(this,markup);this.ownerDocument.replacements++;}
 set outerHTML(markup){const parent=this.parentElement,at=parent.childNodes.indexOf(this),holder=new Element(this.ownerDocument,'fragment');parseInto(holder,markup);parent.childNodes.splice(at,1,...holder.childNodes);for(const child of holder.children)child.parentElement=parent;this.parentElement=null;}
 click(){if(!this.disabled)this.onclick?.({target:this})}
}
function parseInto(root,markup){
 const stack=[root];for(const token of markup.match(/<[^>]+>|[^<]+/g)||[]){if(token.startsWith('</')){stack.pop();continue}if(token.startsWith('<')){const match=token.match(/^<([\w-]+)\b([^>]*)>/);if(!match)continue;const attrs={};for(const m of match[2].matchAll(/([\w-]+)(?:="([^"]*)"|'([^']*)')?/g))attrs[m[1]]=decode(m[2]??m[3]??'');const node=new Element(root.ownerDocument,match[1],attrs);stack.at(-1).append(node);if(!['input','br','img','meta','link','hr'].includes(match[1]))stack.push(node);}else stack.at(-1).append(decode(token));}
}
function documentModel(){const document={hidden:false,replacements:0};document.body=new Element(document,'body');document.activeElement=document.body;document.body.append(new Element(document,'main',{id:'app'}));document.body.append(new Element(document,'aside',{id:'server-wallet'}));document.querySelector=s=>document.body.querySelector(s);document.querySelectorAll=s=>document.body.querySelectorAll(s);document.getElementById=id=>document.querySelector('#'+id);return document;}
const ranks=['6','7','8','9','10','J','Q','K','A'];
function game(count=18){const hand=['♠','♥','♦','♣'].flatMap(suit=>ranks.map(rank=>({rank,suit,id:rank+suit}))).slice(0,count);return {id:ID,phase:'attack',round:5,players:[{name:'Ты',hand,handCount:count},{name:'Искра',face:'♟',handCount:6},{name:'Север',face:'♟',handCount:6}],table:[],legal:{cards:hand.map(c=>c.id),actions:['attack','resign']},over:false,draw:false,resigned:false,finished:[],winner:null,loser:null,deckCount:0,discardCount:6,trump:'♠',trumpCard:{rank:'A',suit:'♠',id:'A♠'},attacker:0,defender:1,difficulty:'hard',message:'Выбери карту',journal:[{kind:'start',actor:0,round:1}]};}
function ended(kind='won',stake=0){const g=game(0);Object.assign(g,{over:true,phase:'over',legal:{cards:[],actions:[]},finished:[0,1],loser:2,winner:0});g.players[1].handCount=0;g.players[2].handCount=3;if(kind==='lost'){g.players[0].hand=[{rank:'6',suit:'♠',id:'6♠'}];g.players[0].handCount=1;g.players[2].handCount=0;g.finished=[1,2];g.loser=0;g.winner=1;}if(kind==='draw'){g.draw=true;g.players.forEach(p=>p.handCount=0);g.finished=[0,1,2];g.loser=null;}if(kind==='resigned'){g.resigned=true;g.players[0].handCount=6;g.players[1].handCount=6;g.players[2].handCount=6;g.finished=[];g.loser=0;g.winner=null;}if(stake)g.economy={version:1,stake,settled:true,payout:kind==='won'?300:kind==='draw'?100:0,xp:{won:80,draw:40,lost:25,resigned:0}[kind],outcome:{won:'win',lost:'loss',draw:'draw',resigned:'resigned'}[kind]};return g;}
function harness(initial=game()){
 const document=documentModel();let account={user:{id:SCOPE},loading:false,switching:false},tabWritable=true,current=initial,state={phase:'saved',ready:true,busy:false,pending:false,revision:3,game:initial},wallet={phase:'saved',ready:true,busy:false,pending:false,wallet:{balance:1000}},walletSubscriber,legacyWrites=0,mounts=0,refreshes=0;
 const starts=[],actions=[],window={VEZDEHOT:{account:()=>account,scopeKey:()=>account.user?.id,getProfile:()=>({nick:'Игрок'}),openAccount(){},recordResult(){legacyWrites++},updateProfile(){legacyWrites++}},VEZDEHOT_TAB_SESSION:{canWrite:()=>tabWritable},VEZDEHOT_SERVER_WALLET:{status:()=>wallet,mount:host=>{mounts++;host.innerHTML='<details><summary>Баланс</summary></details>';return()=>{}},subscribe:fn=>{walletSubscriber=fn;fn(wallet);return()=>{}},refresh:()=>{refreshes++}}};
 const ctx={window,document,Object,Number,String,JSON,Set,Error,Promise};vm.createContext(ctx);vm.runInContext(source.slice(0,source.indexOf('function boot(){'))+`window.testUI={render,attachWallet,setState:s=>view=s,setOwner:s=>owner=s,setController:c=>controller=c};})();`,ctx);const ui=window.testUI;
 const controller={status:()=>({...state,game:current}),start:(...args)=>{starts.push(args);state={...state,busy:true,ready:false};ui.setState(state);ui.render()},act:a=>actions.push(copy(a)),load(){}};ui.setOwner(SCOPE);ui.setController(controller);ui.setState(state);ui.render();
 return {document,window,ui,starts,actions,query:s=>document.querySelector(s),all:s=>document.querySelectorAll(s),setState:change=>{state={...state,...change};if(Object.hasOwn(change,'game'))current=change.game;ui.setState(state);ui.render()},setRemoteGame:g=>current=g,setAccount:id=>{account={...account,user:id?{id}:null};ui.setOwner(id);ui.render()},setTab:allowed=>{tabWritable=allowed;ui.render()},setWallet:change=>{wallet={...wallet,...change};walletSubscriber?.(wallet)},counts:()=>({legacyWrites,mounts,refreshes})};
}

test('selecting a far card keeps the hand position, keyboard focus and open history on the same table',()=>{
 const h=harness(),hand=h.query('.sd-hand'),card=h.all('[data-card]')[12];hand.scrollLeft=470;h.query('[data-rules]').open=true;h.query('[data-journal]').open=true;h.query('.sd-journal ol').scrollTop=81;card.focus();card.click();
 const selected=h.all('[data-card]')[12];assert.notEqual(h.query('.sd-hand'),hand);assert.notEqual(selected,card);assert.equal(h.query('.sd-hand').scrollLeft,470);assert.equal(h.document.activeElement,selected);assert.equal(selected.getAttribute('aria-pressed'),'true');assert(h.query('[data-rules]').open);assert(h.query('[data-journal]').open);assert.equal(h.query('.sd-journal ol').scrollTop,81);assert.equal(h.actions.length,0);
 selected.click();assert.equal(h.query('.sd-hand').scrollLeft,470);assert.equal(h.all('[data-card]')[12].getAttribute('aria-pressed'),'false');assert.equal(h.document.activeElement,h.all('[data-card]')[12]);
});
test('server updates retain hand scroll but never refocus an unavailable card; a smaller hand clamps safely',()=>{
 const g=game(),h=harness(g);h.query('.sd-hand').scrollLeft=500;h.all('[data-card]')[12].focus();h.setState({busy:true,ready:false});assert.equal(h.query('.sd-hand').scrollLeft,500);assert.equal(h.document.activeElement,h.document.body);assert(h.all('[data-card]').every(n=>n.disabled));
 const next=copy(g);next.players[0].hand=next.players[0].hand.slice(0,3);next.players[0].handCount=3;next.legal.cards=next.players[0].hand.map(c=>c.id);h.setState({game:next,busy:false,ready:true,revision:4});assert.equal(h.query('.sd-hand').scrollLeft,0);assert.equal(h.document.activeElement,h.document.body);
});
test('a different table or account starts without the previous hand scroll, card focus or disclosure state',()=>{
 for(const replace of [h=>h.setState({game:{...game(),id:'different-table'}}),h=>h.setAccount('different-account')]){const h=harness();h.query('.sd-hand').scrollLeft=410;h.query('[data-journal]').open=true;h.all('[data-card]')[10].focus();replace(h);assert.equal(h.query('.sd-hand').scrollLeft,0);assert.equal(h.query('[data-journal]').open,false);assert.equal(h.document.activeElement,h.document.body);}
});
for(const [outcome,title,detail] of [['won','Ты выиграл!','Север — последний игрок с картами: 3.'],['lost','Ты остался с картами','В твоей руке осталось карт: 1.'],['draw','Ничья','ни у кого не осталось карт'],['resigned','Ты завершил стол','Победитель по картам не определён']])test('terminal '+outcome+' leads with the actual result and has no empty felt or misleading next turn',()=>{
 const h=harness(ended(outcome));assert.equal(h.query('.sd-result h1').textContent,title);assert(h.query('.sd-result').textContent.includes(detail));assert.equal(h.query('.sd-shell'),null);assert.equal(h.query('.sd-empty-table'),null);assert.equal(h.query('.sd-turn'),null);assert.equal(h.query('[data-resign]'),null);assert.equal(h.all('.sd-final-players li').length,3);assert.equal(h.query('[data-replay-settings]').open,false);assert.equal(h.query('#sd-bots').value,'2');assert.equal(h.query('#sd-difficulty').value,'hard');
});
test('direct replay retains players and difficulty, treats a legacy table as free, and prevents a second click',()=>{
 const h=harness(ended()),button=h.query('[data-rematch]');assert.equal(button.textContent,'Ещё партия · бесплатно');button.click();button.onclick();assert.deepEqual(h.starts,[[2,'hard',0]]);assert(h.query('[data-rematch]').disabled);
});
test('replay checks current ownership and server table again instead of trusting the old result button',()=>{
 for(const block of [h=>h.setState({pending:true}),h=>h.setTab(false),h=>h.setRemoteGame(game()),h=>h.setRemoteGame({...ended(),id:'another-table'})]){const h=harness(ended()),button=h.query('[data-rematch]');block(h);button.onclick();assert.deepEqual(h.starts,[]);}
});
test('paid replay displays the server return and XP, retains stake, and never writes a practice profile',()=>{
 const h=harness(ended('won',100));assert.deepEqual(h.all('.sd-settlement dd').map(n=>n.textContent),['100 V','300 V','+200 V','+80 XP']);assert.equal(h.query('[data-rematch]').textContent,'Ещё партия · 100 V');h.query('[data-rematch]').click();assert.deepEqual(h.starts,[[2,'hard',100]]);assert.equal(h.counts().legacyWrites,0);
 for(const [kind,expected] of [['resigned',['100 V','0 V','-100 V','+0 XP']],['draw',['100 V','100 V','0 V','+40 XP']],['lost',['100 V','0 V','-100 V','+25 XP']]]){const result=harness(ended(kind,100));assert.deepEqual(result.all('.sd-settlement dd').map(n=>n.textContent),expected);assert.equal(result.counts().legacyWrites,0);}
});
test('paid starts require a fresh sufficient server balance; free practice stays available',()=>{
 const h=harness(null);h.ui.attachWallet();assert.equal(h.query('#sd-stake').value,'0');assert.equal(h.query('[data-start]').disabled,false);
 const mode=h.query('#sd-stake');mode.value='100';mode.onchange();assert.equal(h.query('[data-start]').disabled,false);h.setWallet({wallet:{balance:99}});assert.equal(h.query('[data-start]').disabled,true);assert(h.query('.sd-entry-note').textContent.includes('нужно 100 V'));h.query('[data-start]').onclick();assert.deepEqual(h.starts,[]);
 h.setWallet({ready:false,phase:'offline'});assert(h.query('.sd-entry-note').textContent.includes('недоступен'));h.setWallet({ready:true,phase:'saved',wallet:{balance:100}});h.query('[data-start]').click();assert.deepEqual(h.starts,[[1,'normal',100]]);
 const free=harness(null);free.setWallet({ready:false,wallet:null});free.query('[data-start]').click();assert.deepEqual(free.starts,[[1,'normal',0]]);
});
test('wallet updates preserve edited replay settings and focus, mount only once, and leave a live table untouched',()=>{
 const h=harness(ended('won',100));h.ui.attachWallet();h.ui.attachWallet();h.query('[data-replay-settings]').open=true;const bots=h.query('#sd-bots');bots.value='3';bots.focus();bots.onchange();const difficulty=h.query('#sd-difficulty');difficulty.value='easy';difficulty.onchange();h.setWallet({wallet:{balance:900}});assert.equal(h.query('#sd-bots').value,'3');assert.equal(h.query('#sd-difficulty').value,'easy');assert.equal(h.query('#sd-stake').value,'100');assert(h.query('[data-replay-settings]').open);assert.equal(h.document.activeElement.id,'sd-bots');assert.equal(h.counts().mounts,1);assert.equal(h.counts().refreshes,0);
 h.query('[data-start]').click();assert.deepEqual(h.starts,[[3,'easy',100]]);h.setState({game:game(),busy:false,ready:true});const hand=h.query('.sd-hand'),replacements=h.document.replacements;h.setWallet({wallet:{balance:800}});assert.equal(h.query('.sd-hand'),hand);assert.equal(h.document.replacements,replacements);assert.equal(h.counts().refreshes,0);
});
test('paid exit explains the forfeited entry before sending the server-only resignation',()=>{
 const g=game();g.economy={version:1,stake:100,settled:false,payout:0,xp:0,outcome:null};const h=harness(g);assert(h.query('.sd-table-meta').textContent.includes('ВХОД 100 V'));h.query('[data-resign]').click();assert(h.query('.sd-resign p').textContent.includes('100 V не возвращается'));assert(h.query('.sd-resign p').textContent.includes('XP за выход не начисляются'));assert.deepEqual(h.actions,[]);h.query('[data-resign-confirm]').click();assert.deepEqual(h.actions,[{type:'resign'}]);assert.equal(h.counts().legacyWrites,0);
});
test('a restored completed human hand offers one bot completion action and never offers forfeiture',()=>{
 const g=game(0);g.finished=[0];g.attacker=1;g.defender=2;g.phase='resolve';g.legal={cards:[],actions:['continue']};g.economy={version:1,stake:100,settled:false,payout:0,xp:0,outcome:null};const h=harness(g);
 assert.equal(h.query('.sd-turn h1').textContent,'Ты вышел без карт');assert.equal(h.query('[data-resign]'),null);assert.equal(h.query('[data-action]').textContent,'Завершить партию ботов');assert(!h.query('.sd-empty-table').textContent.includes('Твой следующий ход'));h.query('[data-action]').click();assert.deepEqual(h.actions,[{type:'continue'}]);assert.equal(h.counts().legacyWrites,0);
});
