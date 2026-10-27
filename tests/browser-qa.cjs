'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {randomUUID}=require('node:crypto');
const vm=require('node:vm');
const {prepare}=require('../scripts/prepare-browser-qa.cjs');
const root=path.resolve(__dirname,'..');
const modes=['durak','poker','bunker','mafia','monopoly'];
let temporary,prepared,createFixture;
const clientProjections={};

before(async()=>{
 temporary=fs.mkdtempSync(path.join(os.tmpdir(),'vezdehot-browser-qa-test-'));
 prepared=prepare(path.join(temporary,'fixture'));
 ({createFixture}=await import(pathToFileURL(path.join(prepared.staticDirectory,'qa-fixture.mjs')).href));
 for(const mode of modes){const ctx={window:{},document:{getElementById:()=>null},Object,Number,String,JSON,Set,Error,Promise};vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(prepared.staticDirectory,'server-'+mode+'.js'),'utf8'),ctx);clientProjections[mode]=ctx.window['VEZDEHOT_SERVER_'+mode.toUpperCase()].projection;}
});
after(()=>{if(temporary)fs.rmSync(temporary,{recursive:true,force:true});});
function memory(){const values=new Map(),writes=[];return {values,writes,get length(){return values.size},key:index=>[...values.keys()][index]??null,getItem:key=>values.get(String(key))??null,setItem(key,value){writes.push(['set',key]);values.set(String(key),String(value));},removeItem(key){writes.push(['remove',key]);values.delete(String(key));},clear(){writes.push(['clear']);values.clear();}};}
const clone=value=>JSON.parse(JSON.stringify(value));
function setup(namespace='case',storage=memory()){return {storage,fixture:createFixture({storage,namespace,seed:27102026})};}
const startBody=(revision=0,stake=0)=>({op:'start',actionId:randomUUID(),expectedRevision:revision,difficulty:'normal',stake});
const actBody=(view,action)=>({op:'action',actionId:randomUUID(),expectedRevision:view.revision,gameId:view.game.id,action});
async function load(fixture,mode){const response=await fixture.request(mode,{op:'load'});assert.equal(response.ok,true,mode+' load');return response.data;}
async function start(fixture,mode,stake=0){const body=startBody((await load(fixture,mode)).revision,stake);if(mode==='durak')body.bots=1;if(mode==='bunker')body.scenarioChoice='random';const response=await fixture.request(mode,body);assert.equal(response.ok,true,mode+' start: '+JSON.stringify(response));return {body,view:response.data};}
function actionFor(mode,g){
 const legal=g.legal,actions=legal.actions;
 if(mode==='durak'){const type=actions.includes('finish')?'finish':actions.find(value=>value!=='resign');return {type,...(['attack','defend'].includes(type)?{cardId:legal.cards[0]}:{})};}
 if(mode==='bunker'){const type=actions.find(value=>value!=='resign');return {type,...(type==='reveal'?{cardType:legal.cards[0]}:type==='vote'?{target:legal.targets[0]}:{})};}
 if(mode==='mafia'){const type=actions.includes('finish')?'finish':actions[0];return {type,...(['night','vote'].includes(type)&&legal.targets.length?{target:legal.targets[0]}:{})};}
 if(mode==='monopoly')return {type:g.phase==='buy'&&g.players[0].money-g.board[g.players[0].pos].price<150?'skip':actions.find(value=>value!=='resign')};
 if(g.handOver&&actions.includes('close'))return {type:'close'};
 return {type:actions.includes('continue')?'continue':actions.includes('check')?'check':actions.includes('call')?'call':actions.includes('fold')?'fold':actions[0]};
}
async function move(fixture,mode,view,action=actionFor(mode,view.game)){const body=actBody(view,action),response=await fixture.request(mode,body);assert.equal(response.ok,true,mode+' action '+JSON.stringify(action)+': '+JSON.stringify(response));assert.doesNotThrow(()=>clientProjections[mode](response.data),mode+' real UI accepts the fixture response');return {body,view:response.data};}
function files(directory){return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(path.join(directory,entry.name)):[path.join(directory,entry.name)]);}

test('QA preparation refuses existing and repository destinations, including a symlink into the repo',()=>{
 const before=fs.readFileSync(path.join(root,'dist/server-durak.html'),'utf8');
 for(const output of [root,path.join(root,'dist/qa-test-must-not-exist'),prepared.directory,path.dirname(root)])assert.throws(()=>prepare(output),undefined,output);
 assert.throws(()=>prepare('relative-qa-output'));
 const alias=path.join(temporary,'repo-alias');fs.symlinkSync(root,alias,'dir');
 assert.throws(()=>prepare(path.join(alias,'qa-test-must-not-exist')));
 assert.equal(fs.existsSync(path.join(root,'dist/qa-test-must-not-exist')),false);
 assert.equal(fs.existsSync(path.join(root,'qa-test-must-not-exist')),false);
 assert.equal(fs.readFileSync(path.join(root,'dist/server-durak.html'),'utf8'),before);
});

test('generated pages run real game clients and engines behind an isolated network-blocking QA runtime',()=>{
 assert.equal(prepared.staticDirectory,path.join(prepared.directory,'dist'));
 const forbiddenNames=['platform.js','auth-config.js','tab-session.js','server-wallet.js','telegram.js','cloud-checkpoint.js','game-store.js','sw.js'];
 for(const filename of files(prepared.staticDirectory)){
  assert(!forbiddenNames.includes(path.basename(filename)),filename);
  if(/\.(?:js|mjs|html|css)$/.test(filename))assert.doesNotMatch(fs.readFileSync(filename,'utf8'),/cyzbraifdkrqicdsbuwe|supabase\.co|https:\/\/t\.me\/|https:\/\/oauth\.telegram\.org|https:\/\/vezdehot\.vercel\.app|\/auth\/v1\/|\/functions\/v1\//,filename);
  if(/\.(?:html|css)$/.test(filename)){
   const source=fs.readFileSync(filename,'utf8'),refs=filename.endsWith('.html')?[...source.matchAll(/(?:src|href)="([^"]+)"/g)].map(match=>match[1]):[...source.matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/g)].map(match=>match[1]);
   for(const ref of refs){if(ref.startsWith('data:')||ref.startsWith('#'))continue;assert(!/^(?:[a-z]+:)?\/\//i.test(ref),'external resource '+ref);const local=path.resolve(path.dirname(filename),ref.split(/[?#]/)[0]);assert(local.startsWith(prepared.staticDirectory+path.sep),'resource escapes fixture '+ref);assert(fs.statSync(local).isFile(),'missing fixture resource '+ref);}
  }
 }
 for(const mode of modes){
  const html=fs.readFileSync(path.join(prepared.staticDirectory,'server-'+mode+'.html'),'utf8');
  assert.match(html,/connect-src\s+'none'/,mode+' blocks network');
  assert.match(html,/qa-runtime\.mjs/,mode+' uses QA runtime');
  assert.match(html,new RegExp('server-'+mode+'\\.js'),mode+' uses real UI');
  for(const name of forbiddenNames)assert(!html.includes(name),mode+' must not load '+name);
  assert.equal(fs.readFileSync(path.join(prepared.staticDirectory,'server-'+mode+'.js'),'utf8'),fs.readFileSync(path.join(root,'dist','server-'+mode+'.js'),'utf8'));
  for(const name of ['engine.mjs','core.mjs'])assert.equal(fs.readFileSync(path.join(prepared.staticDirectory,'qa-engines/server-'+mode,name),'utf8'),fs.readFileSync(path.join(root,'supabase/functions/server-'+mode,name),'utf8'));
 }
 const toolbar=fs.readFileSync(path.join(prepared.staticDirectory,'index.html'),'utf8');
 for(const text of ['320','390','844','1440'])assert(toolbar.includes(text),'viewport '+text);
 assert.match(toolbar,/qa-toolbar\.mjs/);assert.match(toolbar,/connect-src\s+'none'/);
 const toolbarScript=fs.readFileSync(path.join(prepared.staticDirectory,'qa-toolbar.mjs'),'utf8');assert.match(toolbarScript,/createElement\(['"]iframe['"]\)/);
});

test('HTTP QA preview uses secure random bytes for a UUID fallback and preserves native randomUUID',()=>{
 const guard=fs.readFileSync(path.join(prepared.staticDirectory,'qa-guard.js'),'utf8');let calls=0;
 const crypto={getRandomValues(bytes){assert.equal(this,crypto);assert.equal(bytes.constructor.name,'Uint8Array');assert.equal(bytes.length,16);calls++;for(let i=0;i<bytes.length;i++)bytes[i]=(calls*17+i*13)&255;return bytes;}};
 vm.runInNewContext(guard,{window:{},navigator:{},crypto});
 const ids=Array.from({length:12},()=>crypto.randomUUID());
 assert.equal(calls,12);assert.equal(new Set(ids).size,ids.length);
 for(const id of ids)assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
 const native=()=> 'native UUID sentinel',supported={randomUUID:native,getRandomValues(){throw Error('native UUID must not use fallback')}};
 vm.runInNewContext(guard,{window:{},navigator:{},crypto:supported});assert.equal(supported.randomUUID,native);assert.equal(supported.randomUUID(),'native UUID sentinel');
});

test('QA viewport measures changing native scrollbars to retain the selected document width',()=>{
 const toolbar=fs.readFileSync(path.join(prepared.staticDirectory,'qa-toolbar.mjs'),'utf8'),controls=new Map();
 const document={querySelector(selector){if(!controls.has(selector))controls.set(selector,{value:''});return controls.get(selector)}};
 const prefix=toolbar.slice(0,toolbar.indexOf('function open(){')).replace(/^import .*;\s*$/gm,'');
 const ctx={document,localStorage:{},namespace:'viewport-test',createFixture:()=>({current:()=>({account:'a'})})};vm.createContext(ctx);
 vm.runInContext(prefix+'\nglobalThis.resizeQA=(target,size)=>{frame=target;viewport.value=size;resize()};',ctx);
 for(const [width,height] of [[320,568],[390,844],[844,390],[1440,900]]){
  let actualWidth=300,gutter=15,writes=0;
  const frame={height:0,get width(){return actualWidth},set width(value){actualWidth=Number(value);writes++},contentWindow:{get innerWidth(){return actualWidth}},contentDocument:{documentElement:{get clientWidth(){return actualWidth-gutter}}}};
  for(gutter of [15,0,17,0]){ctx.resizeQA(frame,width+'x'+height);assert.equal(frame.contentDocument.documentElement.clientWidth,width);assert.equal(frame.height,height);const settled=writes;ctx.resizeQA(frame,width+'x'+height);assert.equal(writes,settled,'stable metrics must not resize repeatedly');}
 }
 const unloaded={width:300,height:150};ctx.resizeQA(unloaded,'320x568');assert.equal(unloaded.width,320);assert.equal(unloaded.height,568);
});

test('all five QA loads are read-only and a stale or foreign account scope cannot read or mutate data',async()=>{
 const {fixture,storage}=setup('read-only');fixture.current();fixture.wallet();const before=clone([...storage.values]),count=storage.writes.length;
 for(const mode of modes){assert.equal((await load(fixture,mode)).game,null);const denied=await fixture.request(mode,{op:'load'},'foreign-account');assert.equal(denied.status,403);}
 assert.deepEqual([...storage.values],before);assert.equal(storage.writes.length,count);
 const oldScope=fixture.current().scope;fixture.setAccount('b');
 for(const body of [{op:'load'},startBody()])assert.equal((await fixture.request('durak',body,oldScope)).status,403);
 assert.equal((await load(fixture,'durak')).game,null);assert.equal(fixture.wallet().balance,1000);
});

test('fixture accounts and namespaced pending requests survive switches without touching other storage',async()=>{
 const storage=memory();storage.setItem('vezdehot:profile:guest','real guest sentinel');storage.setItem('unrelated:key','foreign sentinel');
 const {fixture}=setup('accounts',storage),scopeA=fixture.current().scope;
 const a=await start(fixture,'durak',100),pending='vezdehot:server-durak:pending:v1:'+scopeA;
 fixture.storage.setItem(pending,'qa request');assert.equal(storage.getItem(pending),null);
 fixture.setAccount('b');assert.equal((await load(fixture,'durak')).game,null);assert.equal(fixture.wallet().balance,1000);
 const b=await start(fixture,'mafia',100);fixture.setAccount('a');assert.equal((await load(fixture,'durak')).game.id,a.view.game.id);assert.equal(fixture.wallet().balance,900);assert.equal(fixture.storage.getItem(pending),'qa request');
 fixture.reset();assert.notEqual(fixture.current().scope,scopeA);assert.equal((await load(fixture,'durak')).game,null);assert.equal(fixture.wallet().balance,1000);assert.equal(fixture.storage.getItem(pending),null);
 fixture.setAccount('b');assert.equal((await load(fixture,'mafia')).game.id,b.view.game.id);assert.equal(fixture.wallet().balance,900);
 assert.equal(storage.getItem('vezdehot:profile:guest'),'real guest sentinel');assert.equal(storage.getItem('unrelated:key'),'foreign sentinel');assert(!storage.writes.some(([op])=>op==='clear'));
});

test('all five committed lost replies replay their exact receipt after reload without a second entry charge',async()=>{
 for(const mode of modes){
  const namespace='lost-'+mode,{fixture,storage}=setup(namespace),body=startBody(0,100);if(mode==='durak')body.bots=1;if(mode==='bunker')body.scenarioChoice='random';
  fixture.armLostResponse();await assert.rejects(fixture.request(mode,body),/response lost after commit/);
  assert.equal(fixture.wallet().balance,900);const committed=await load(fixture,mode);assert.equal(committed.revision,1);assert.equal(committed.game.economy.stake,100);
  const reloaded=createFixture({storage,namespace,seed:27102026}),receipt=await reloaded.request(mode,body);assert.equal(receipt.ok,true);assert.equal(receipt.data.status,'saved');assert.equal(receipt.data.revision,1);assert.equal(receipt.data.game.id,committed.game.id);assert.equal(reloaded.wallet().balance,900);
  assert.deepEqual(await load(reloaded,mode),committed);
  const reused=await reloaded.request(mode,{...body,difficulty:'hard'});assert.equal(reused.status,409);assert.equal(reloaded.wallet().balance,900);
 }
});

test('real legal flows finish all five free and paid fixtures, with exactly one fake wallet settlement',async()=>{
 for(const mode of modes)for(const stake of [0,100]){
  const {fixture}=setup('flow-'+mode+'-'+stake);let {view}=await start(fixture,mode,stake),lastBody,steps=0;
  while(!view.game.over&&steps++<1500){const next=await move(fixture,mode,view);view=next.view;lastBody=next.body;}
  assert(view.game.over,mode+' stake '+stake+' must finish');assert.equal(view.game.economy.settled,true);
  assert.equal(fixture.wallet().balance,1000-stake+view.game.economy.payout,mode+' settlement balance');assert.equal(fixture.wallet().xp,view.game.economy.xp,mode+' settlement XP');
  const wallet=clone(fixture.wallet());assert.deepEqual((await fixture.request(mode,lastBody)).data,view);await load(fixture,mode);assert.deepEqual(fixture.wallet(),wallet,mode+' repeat settlement');
 }
});

test('paid poker can continue at the same table without charging for the next hand',async()=>{
 const {fixture}=setup('next-hand');let {view}=await start(fixture,'poker',100),steps=0;
 while(!view.game.handOver&&!view.game.over&&steps++<200)view=(await move(fixture,'poker',view)).view;
 assert(view.game.handOver);assert(view.game.legal.actions.includes('nextHand'),'seeded first hand leaves a continuation');
 const table=view.game.id,number=view.game.handNumber,balance=fixture.wallet().balance;
 view=(await move(fixture,'poker',view,{type:'nextHand'})).view;
 assert.equal(view.game.id,table);assert.equal(view.game.handNumber,number+1);assert.equal(fixture.wallet().balance,balance);assert.equal(view.game.economy.settled,false);
});
