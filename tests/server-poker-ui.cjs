'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const raw=fs.readFileSync('dist/server-poker.js','utf8');
const source=raw.replace('Promise.resolve(window.VEZDEHOT?.ready).then(boot);',`window.__UI={setup,economyPanel,render,bind,updateSetup,connectWallet,refreshWalletFor,setState:s=>{view=s},setOwner:s=>{owner=s},setController:c=>{controller=c},setStake:n=>{setupStake=n}};return;`);
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
test('wallet is mounted once and refreshes only after each new saved table revision',()=>{
 const h=harness();h.ui.connectWallet();h.ui.connectWallet();assert.equal(h.wallet.mounts,1);
 h.ui.refreshWalletFor(ready());assert.equal(h.wallet.refreshes,0);const state=ready(fixture(),1);h.ui.refreshWalletFor(state);h.ui.refreshWalletFor(state);assert.equal(h.wallet.refreshes,1);
 h.ui.refreshWalletFor({...state,revision:2,busy:true,ready:false});h.ui.refreshWalletFor({...state,revision:2,pending:true});h.ui.refreshWalletFor({...state,revision:2,phase:'offline'});assert.equal(h.wallet.refreshes,1);
 h.ui.refreshWalletFor({...state,revision:2});assert.equal(h.wallet.refreshes,2);h.ui.setOwner('another-account');h.ui.refreshWalletFor({...state,revision:3});assert.equal(h.wallet.refreshes,2);
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
