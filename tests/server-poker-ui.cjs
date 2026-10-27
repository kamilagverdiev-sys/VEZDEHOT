'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const raw=fs.readFileSync('dist/server-poker.js','utf8');
const source=raw.replace('Promise.resolve(window.VEZDEHOT?.ready).then(boot);',`window.__UI={setup,economyPanel,render,bind,updateSetup,connectWallet,refreshConfirmedWallet,resultTitle,resultReason,raisePresets,announceTransition,setState:s=>{view=s},setOwner:s=>{owner=s},setController:c=>{controller=c},setStake:n=>{setupStake=n}};return;`);
const ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture(){return {id:ID,handId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',phase:'betting',stage:'preflop',handNumber:1,over:false,handOver:false,tableClosed:false,showdown:false,button:0,smallBlind:1,bigBlind:2,toAct:0,pot:60,paidPot:0,handProfit:0,community:[],history:[],tableHistory:[],pots:[],prizes:[],players:[{name:'Ты',chips:1000,roundBet:0,handCount:2,hand:[{id:'A♠',rank:'A',suit:'♠'},{id:'K♥',rank:'K',suit:'♥'}]},...['Лаки','Даша','Вегас'].map(name=>({name,chips:1000,roundBet:0,handCount:2}))],legal:{actions:['fold','call'],callAmount:40,owed:40,minimum:80,maximum:1000},economy:{version:1,stake:100,settled:false,payout:0,xp:0,outcome:null}};}
const ready=(game=null,revision=0)=>({phase:'saved',game,revision,ready:true,busy:false,pending:false});
function harness(){
 const app={},walletHost={},nodes=new Map([['#app',app]]),lists=new Map(),calls=[],wallet={state:{phase:'saved',ready:true,busy:false,pending:false,wallet:{balance:1000}},mounts:0,refreshes:0,subscriber:null};
 let markup='';Object.defineProperty(app,'innerHTML',{get:()=>markup,set:value=>{markup=value;(lists.get('[data-journal] ol')||[]).forEach(n=>n.scrollTop=0)}});
 const document={hidden:false,getElementById:id=>id==='app'?app:id==='sp-wallet'?walletHost:null,querySelector:s=>nodes.get(s)||null,querySelectorAll:s=>lists.get(s)||[],addEventListener:()=>{}};
 const window={VEZDEHOT:{scopeKey:()=>ID,account:()=>({user:{id:ID},loading:false,switching:false}),getProfile:()=>({nick:'Игрок'}),openAccount:()=>{}},VEZDEHOT_TAB_SESSION:{canWrite:()=>true},VEZDEHOT_SERVER_WALLET:{status:()=>wallet.state,mount:host=>{assert.equal(host,walletHost);wallet.mounts++;return()=>{}},subscribe:fn=>{wallet.subscriber=fn;fn(wallet.state);return()=>{}},refresh:()=>{wallet.refreshes++;return Promise.resolve(true)}}};
 const ctx={window,document,AbortController,Object,JSON,Number,Set,Error,Promise};vm.createContext(ctx);vm.runInContext(source,ctx);const ui=window.__UI;assert(ui);ui.setOwner(ID);ui.setState(ready());ui.setController({start:(difficulty,stake)=>calls.push({op:'start',difficulty,stake}),act:action=>calls.push({op:'action',action}),load:()=>calls.push({op:'load'})});
 return {ui,app,nodes,lists,wallet,calls,document,window};
}
test('setup defaults to free and keeps practice available while paid wallet is unavailable',()=>{
 const h=harness(),start={focus(){}},hint={},stake={value:'0'},difficulty={value:'normal'},free={};h.nodes.set('[data-start]',start);h.nodes.set('[data-stake-hint]',hint);h.nodes.set('#sp-stake',stake);h.nodes.set('#sp-difficulty',difficulty);h.nodes.set('[data-choose-free]',free);
 assert.match(h.ui.setup(),/option value="0" selected/);h.wallet.state={phase:'offline',ready:false,wallet:null};h.ui.bind();assert.equal(start.disabled,false);assert.match(start.textContent,/бесплатно/);start.onclick();assert.deepEqual(h.calls,[{op:'start',difficulty:'normal',stake:0}]);
 stake.value='100';stake.onchange();assert.equal(start.disabled,true);assert.equal(free.hidden,false);assert.match(hint.textContent,/бесплатную практику/);start.onclick();assert.equal(h.calls.length,1);
 free.onclick();assert.equal(stake.value,'0');assert.equal(start.disabled,false);assert.equal(free.hidden,true);
});
test('wallet updates only toggle paid controls; a stale, low or pending wallet cannot start a paid table',()=>{
 const h=harness(),start={},hint={},stake={value:'100'};h.nodes.set('[data-start]',start);h.nodes.set('[data-stake-hint]',hint);h.nodes.set('#sp-stake',stake);h.ui.setStake(100);h.ui.bind();h.ui.connectWallet();const original='A table with focused actions';h.app.innerHTML=original;
 assert.equal(start.disabled,false);start.onclick();assert.deepEqual(h.calls,[{op:'start',difficulty:'normal',stake:100}]);
 for(const state of [{phase:'saved',ready:true,pending:false,wallet:{balance:99}},{phase:'saved',ready:true,pending:true,wallet:{balance:1000}},{phase:'loading',ready:false,pending:false,wallet:{balance:1000}}]){h.wallet.state=state;h.wallet.subscriber(state);assert.equal(start.disabled,true);start.onclick();assert.equal(h.calls.length,1);assert.equal(h.app.innerHTML,original);}
 assert.equal(h.wallet.refreshes,0);
});
test('confirmed wallet refresh stays within the current account and active tab',()=>{
 const h=harness();h.ui.connectWallet();h.ui.connectWallet();assert.equal(h.wallet.mounts,1);h.ui.refreshConfirmedWallet();assert.equal(h.wallet.refreshes,1);
 h.ui.setOwner('another-account');h.ui.refreshConfirmedWallet();assert.equal(h.wallet.refreshes,1);h.ui.setOwner(ID);h.document.hidden=true;h.ui.refreshConfirmedWallet();assert.equal(h.wallet.refreshes,1);h.document.hidden=false;h.window.VEZDEHOT_TAB_SESSION.canWrite=()=>false;h.ui.refreshConfirmedWallet();assert.equal(h.wallet.refreshes,1);
});
test('paid close is absent during a hand and appears only when server legal actions permit it',()=>{
 const h=harness(),g=fixture();h.ui.setState(ready(g,1));h.ui.render();assert.doesNotMatch(h.app.innerHTML,/data-close\b/);assert.doesNotMatch(h.app.innerHTML,/РАСЧЁТ СТОЛА ПОДТВЕРЖДЁН/);assert.match(h.app.innerHTML,/после раздачи/);
 g.handOver=true;g.phase='over';g.legal.actions=['nextHand','close'];h.ui.setState(ready(g,2));h.ui.render();assert.match(h.app.innerHTML,/data-close\b/);assert.match(h.app.innerHTML,/data-action="nextHand"/);assert.match(h.app.innerHTML,/без нового списания/);
 g.legal.actions=['nextHand'];h.ui.render();assert.doesNotMatch(h.app.innerHTML,/data-close\b/);
});
test('settlement reports only this table confirmed payout, net entry result and XP before the board',()=>{
 const h=harness(),g=fixture();g.over=true;g.handOver=true;g.phase='over';g.tableClosed=true;g.players[0].chips=1350;g.payout=999;g.legal.actions=[];g.economy={version:1,stake:100,settled:true,payout:135,xp:90,outcome:'win'};h.ui.setState(ready(g,8));h.ui.render();
 assert.match(h.app.innerHTML,/135 <small>V/);assert.match(h.app.innerHTML,/\+35 <small>V/);assert.match(h.app.innerHTML,/\+90 <small>XP/);assert.doesNotMatch(h.app.innerHTML,/999/);assert(h.app.innerHTML.indexOf('sp-settlement')<h.app.innerHTML.indexOf('sp-table'));
 const next=fixture();next.id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';h.ui.setState(ready(next,9));h.ui.render();assert.doesNotMatch(h.app.innerHTML,/РАСЧЁТ СТОЛА ПОДТВЕРЖДЁН|\+35 <small>V/);
 delete next.economy;assert.equal(h.ui.economyPanel(next),'');
});
test('a close confirmation cannot act on a newer revision or a different account',()=>{
 const h=harness(),g=fixture();g.handOver=true;g.phase='over';g.legal.actions=['nextHand','close'];const close={},cancel={focus(){}},confirm={};h.nodes.set('[data-close]',close);h.nodes.set('.sp-close-confirm [data-close-cancel]',cancel);h.nodes.set('.sp-close-confirm [data-close-confirm]',confirm);h.ui.setState(ready(g,2));h.ui.bind();close.onclick();assert.match(close.outerHTML,/Завершить и рассчитать/);
 h.ui.setState(ready(g,3));confirm.onclick();assert.equal(h.calls.length,0);
 close.onclick();h.ui.setOwner('another-account');confirm.onclick();assert.equal(h.calls.length,0);
 h.ui.setOwner(ID);close.onclick();confirm.onclick();assert.equal(h.calls.length,1);assert.equal(h.calls[0].action.type,'close');
});
test('journal scroll stays in place during a same-table update',()=>{
 const h=harness(),g=fixture(),journal={open:true},first={scrollTop:137},second={scrollTop:48};h.ui.setState(ready(g,1));h.ui.render();h.nodes.set('[data-journal]',journal);h.lists.set('[data-journal] ol',[first,second]);h.ui.setState(ready(g,2));h.ui.render();assert.equal(first.scrollTop,137);assert.equal(second.scrollTop,48);assert.match(h.app.innerHTML,/data-journal open/);
 g.id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';h.ui.setState(ready(g,3));h.ui.render();assert.equal(first.scrollTop,0);assert.equal(second.scrollTop,0);assert.doesNotMatch(h.app.innerHTML,/data-journal open/);
});
test('separate main and side-pot winners are distinguished from a shared bank and refunds',()=>{
 const h=harness(),g=fixture();g.handOver=true;g.phase='over';g.showdown=true;g.legal.actions=['nextHand','close'];g.pots=[{amount:400,winners:[0],refund:false},{amount:600,winners:[1],refund:false},{amount:800,winners:[2],refund:false}];g.prizes=[400,600,800,0];
 assert.equal(h.ui.resultTitle(g),'У банков разные победители');assert.match(h.ui.resultReason(g),/Основной банк — Ты/);assert.match(h.ui.resultReason(g),/побочных банков/);h.ui.setState(ready(g,2));h.ui.render();assert(h.app.innerHTML.indexOf('class="sp-outcome"')<h.app.innerHTML.indexOf('class="sp-table"'));assert.equal((h.app.innerHTML.match(/data-action="nextHand"/g)||[]).length,1);
 g.pots=[{amount:400,winners:[0,1],refund:false},{amount:20,winners:[2],refund:true}];assert.equal(h.ui.resultTitle(g),'Банк разделён');assert.match(h.ui.resultReason(g),/равны по старшинству/);
 g.pots=[{amount:80,winners:[1],refund:false},{amount:20,winners:[0],refund:true}];assert.equal(h.ui.resultTitle(g),'Победитель — Лаки');g.showdown=false;assert.match(h.ui.resultReason(g),/сделали пас/);
});
test('showdown explanation uses confirmed combinations and escapes player names in the banner',()=>{
 const h=harness(),g=fixture();g.handOver=true;g.phase='over';g.showdown=true;g.legal.actions=['nextHand','close'];g.pots=[{amount:100,winners:[1],refund:false}];g.players[1].name='<img src=x>';g.players[1].combination={name:'Пара',category:1,parts:[1,14,13,12,10,0],cards:[]};g.players[0].combination={name:'Пара',category:1,parts:[1,14,13,12,9,0],cards:[]};
 assert.match(h.ui.resultReason(g),/Тип комбинации совпал/);assert.match(h.ui.resultReason(g),/10.*сильнее.*9/);h.ui.setState(ready(g,2));h.ui.render();assert.doesNotMatch(h.app.innerHTML,/<img src=x>/);assert.match(h.app.innerHTML,/&lt;img src=x&gt;/);
 g.players[1].combination={name:'Флеш',category:5,parts:[5,14,12,10,8,6],cards:[]};assert.match(h.ui.resultReason(g),/Флеш старше, чем пара/);
});
test('half-pot and pot presets include the outstanding call, clamp all-in and remain choices until confirmed',()=>{
 const h=harness(),g=fixture();g.players[0].roundBet=20;g.players[0].chips=980;g.pot=400;g.legal={actions:['fold','call','raise'],callAmount:80,owed:80,minimum:140,maximum:1000};
 const presets=JSON.parse(JSON.stringify(h.ui.raisePresets(g)));assert.equal(presets.find(p=>p.label==='½ банка').n,340);assert.equal(presets.find(p=>p.label==='Банк').n,580);
 h.ui.setState(ready(g,1));const slider={value:'140'},output={},action={},help={},button={dataset:{raise:'580'}};h.nodes.set('#sp-raise',slider);h.nodes.set('#sp-raise-value',output);h.nodes.set('[data-action="raise"]',action);h.nodes.set('.sp-raise p',help);h.lists.set('[data-raise]',[button]);h.ui.bind();button.onclick();assert.equal(slider.value,'580');assert.match(help.textContent,/добавить 560/);assert.equal(h.calls.length,0);
 g.legal.maximum=250;g.players[0].chips=230;for(const p of h.ui.raisePresets(g))assert(p.n>=140&&p.n<=250);g.legal.minimum=300;assert.equal(h.ui.raisePresets(g).length,1);assert.equal(h.ui.raisePresets(g)[0].label,'Ва-банк');
});
test('result focus happens once on a confirmed hand transition, never on ordinary refresh or pending ACK',()=>{
 const h=harness(),g=fixture(),focused=[],scrolled=[];for(const [selector,name] of [['.sp-outcome h2','result'],['.sp-heading h1','table'],['.sp-settlement h2','settlement']])h.nodes.set(selector,{focus:options=>focused.push({name,...options}),scrollIntoView:options=>scrolled.push({name,...options})});h.window.VEZDEHOT.getProfile=()=>({nick:'Игрок',reduceMotion:true});
 h.ui.setState(ready(g,1));h.ui.render();assert.equal(focused.length,0);
 g.handOver=true;g.phase='over';g.legal.actions=['nextHand','close'];h.ui.setState({...ready(g,2),busy:true,pending:true,ready:false});h.ui.render();assert.equal(focused.length,0);
 h.ui.setState(ready(g,2));h.ui.render();assert.deepEqual(focused.map(x=>x.name),['result']);assert.equal(scrolled[0].behavior,'auto');h.ui.render();h.ui.setState(ready(g,3));h.ui.render();assert.equal(focused.length,1);
 g.handOver=false;g.phase='betting';g.handId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';g.legal.actions=['fold','call'];h.ui.setState(ready(g,4));h.ui.render();assert.deepEqual(focused.map(x=>x.name),['result','table']);h.ui.render();assert.equal(focused.length,2);
 g.handOver=true;g.over=true;g.phase='over';g.legal.actions=[];g.economy={version:1,stake:100,settled:true,payout:100,xp:40,outcome:'draw'};h.ui.setState(ready(g,5));h.ui.render();assert.deepEqual(focused.map(x=>x.name),['result','table','settlement']);h.ui.render();assert.equal(focused.length,3);
});
test('a free table closed before showdown no longer calculates or shows a live winning chance',()=>{
 const h=harness(),g=fixture();g.over=true;g.tableClosed=true;g.phase='over';g.legal.actions=[];g.economy={version:1,stake:0,settled:true,payout:0,xp:0,outcome:'resigned'};assert.equal(h.window.VEZDEHOT_SERVER_POKER.equityInput(g),null);h.ui.setState(ready(g,4));h.ui.render();assert.doesNotMatch(h.app.innerHTML,/data-equity|Победа без дележа/);assert.match(h.app.innerHTML,/Этот стол закрыт/);
});

test('page boot refreshes the server wallet after a confirmed empty-table load',async()=>{
 let refreshes=0;const calls=[],app={},account={user:{id:ID},loading:false,switching:false};
 const window={VEZDEHOT:{scopeKey:()=>ID,account:()=>account,serverPokerRequest:async body=>{calls.push(body.op);return {ok:true,status:200,data:{status:'ok',revision:0,game:null}}}},VEZDEHOT_TAB_SESSION:{canWrite:()=>true},VEZDEHOT_SERVER_WALLET:{refresh:()=>{refreshes++;return Promise.resolve(true)}},localStorage:{getItem:()=>null}};
 const document={hidden:false,getElementById:id=>id==='app'?app:null,addEventListener:()=>{}};
 const source=fs.readFileSync('dist/server-poker.js','utf8').replace('Promise.resolve(window.VEZDEHOT?.ready).then(boot);','window.__boot=boot;render=()=>{};connectWallet=()=>{};return;');
 const context={window,document,Object,JSON,Number,Set,Error,Promise};vm.createContext(context);vm.runInContext(source,context);window.__boot();await new Promise(r=>setImmediate(r));assert.deepEqual(calls,['load']);assert.equal(refreshes,1);
});
