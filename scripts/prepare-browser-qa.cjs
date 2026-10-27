#!/usr/bin/env node
'use strict';
// Local QA only. Never writes generated pages or fake accounts into production dist.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..'),MODES=['durak','poker','bunker','mafia','monopoly'];
const CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; frame-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const guard=`'use strict';
// Defence in depth: no production transport, OAuth, sockets, workers or analytics.
const denied=()=>{throw new Error('QA fixture: network access is disabled')};
// Managed HTTP previews may lack randomUUID while retaining getRandomValues.
// This fallback is confined to the generated fixture; production keeps HTTPS checks.
if(typeof crypto.randomUUID!=='function')Object.defineProperty(crypto,'randomUUID',{value:()=>{
  const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
  return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
}});
window.fetch=async()=>denied();
for(const name of ['XMLHttpRequest','WebSocket','EventSource','Worker','SharedWorker'])window[name]=class{constructor(){denied()}};
try{Object.defineProperty(navigator,'sendBeacon',{value:denied})}catch{}
if(navigator.serviceWorker?.controller)throw new Error('Use an isolated QA preview origin without a controlling service worker');
window.VEZDEHOT={ready:new Promise(resolve=>window.qaReadyResolve=resolve)};
`;
const css=`:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#10131b;color:#ecf1fb;font:14px system-ui,sans-serif}header{position:sticky;top:0;z-index:5;padding:12px 16px;background:#171d29;border-bottom:1px solid #344057}h1{font-size:17px;margin:0 0 6px}p{margin:6px 0;color:#bac5d8;line-height:1.5}.controls{display:flex;gap:8px 12px;align-items:end;flex-wrap:wrap;margin-top:10px}label{display:grid;gap:4px;font-size:12px}select,button{font:inherit;min-height:38px;padding:7px 10px;border:1px solid #53637d;border-radius:7px;background:#222c3e;color:white}button{cursor:pointer}button:focus-visible,select:focus-visible{outline:3px solid #68d5fa;outline-offset:2px}output{display:block;margin-top:9px;min-height:20px;color:#bde8fb}#qa-stage{overflow:auto;padding:16px;min-height:70vh}iframe{display:block;margin:0 auto;border:0;background:#151922;max-width:none}small{color:#bac5d8}`;
const html=`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${CSP}"><title>VEZDEHOT · изолированный Browser QA</title><link rel="stylesheet" href="./qa-toolbar.css"><script src="./qa-guard.js"></script><script type="module" src="./qa-toolbar.mjs"></script></head><body><header><h1>VEZDEHOT · изолированный QA</h1><p>Настоящие интерфейсы и движки пяти игр. Аккаунты и монеты тестовые; сеть и реальный вход отключены.</p><div class="controls"><label>Игра<select id="qa-game"><option value="durak">Дурак</option><option value="poker">Покер</option><option value="bunker">Бункер</option><option value="mafia">Мафия</option><option value="monopoly">Монополия</option></select></label><label>Экран<select id="qa-viewport"><option value="390x844">390 × 844</option><option value="320x568">320 × 568</option><option value="844x390">844 × 390</option><option value="1440x900">1440 × 900</option></select></label><label>Тестовый аккаунт<select id="qa-account"><option value="a">A</option><option value="b">B</option></select></label><label>Сценарий после сброса<select id="qa-scenario"><option value="free">Бесплатный</option><option value="paid">100 тестовых V</option></select></label><button id="qa-reload">Перезагрузить игру</button><button id="qa-reset">Сбросить аккаунт и начать сценарий</button><button id="qa-lose">Потерять следующий ответ после сохранения</button></div><output id="qa-status" aria-live="polite"></output><small>Сброс удаляет только тестовые партии текущего QA-аккаунта. После потери ответа нажми «Повторить запрос» в игре или перезагрузи её.</small></header><main id="qa-stage"></main></body></html>`;

function inside(candidate,base){return candidate===base||candidate.startsWith(base+path.sep)}
function safeOutput(output){
  if(typeof output!=='string'||!path.isAbsolute(output))throw new Error('Pass a new absolute output directory outside the repository');
  const target=path.resolve(output);if(fs.existsSync(target))throw new Error('Output already exists; choose a new directory');
  let ancestor=target;while(!fs.existsSync(ancestor))ancestor=path.dirname(ancestor);
  const canonical=path.join(fs.realpathSync(ancestor),path.relative(ancestor,target)),repo=fs.realpathSync(ROOT);
  if(inside(canonical,repo)||inside(repo,canonical))throw new Error('QA output must be outside the repository');
  return target;
}
function prepare(output){
  const target=safeOutput(output),files=new Map();
  const add=(name,source)=>files.set(name,fs.readFileSync(source));
  const assets=['platform.css','session.css','server-wallet.css','card-gestures.css','card-gestures.js','poker-equity.js',...MODES.flatMap(mode=>['server-'+mode+'.css','server-'+mode+'.js'])];
  for(const asset of assets)add(asset,path.join(ROOT,'dist',asset));
  for(const mode of MODES){
    for(const name of ['core.mjs','engine.mjs'])add('qa-engines/server-'+mode+'/'+name,path.join(ROOT,'supabase/functions/server-'+mode,name));
    let page=fs.readFileSync(path.join(ROOT,'dist','server-'+mode+'.html'),'utf8');
    page=page.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace('<html lang="ru">','<html lang="ru" data-qa-game="'+mode+'">').replace('<title>','<title>QA · ');
    page=page.replace('<head>','<head>\n<meta http-equiv="Content-Security-Policy" content="'+CSP+'">');
    const extras=mode==='durak'?'<script src="./card-gestures.js" defer></script>':mode==='poker'?'<script src="./poker-equity.js" defer></script>':'';
    page=page.replace('</head>','<script src="./qa-guard.js"></script><script type="module" src="./qa-runtime.mjs"></script>'+extras+'<script src="./server-'+mode+'.js" defer></script>\n</head>');
    // Fail closed if a future page adds a network-bearing resource outside this copy.
    for(const [,url] of page.matchAll(/(?:src|href)="([^"]+)"/g))if(!url.startsWith('./')||!files.has(url.slice(2))&&!['qa-guard.js','qa-runtime.mjs'].includes(url.slice(2)))throw new Error('Unsupported QA page resource: '+url);
    files.set('server-'+mode+'.html',page);
  }
  add('qa-fixture.mjs',path.join(__dirname,'browser-qa-fixture.mjs'));
  add('qa-runtime.mjs',path.join(__dirname,'browser-qa-runtime.mjs'));
  add('qa-toolbar.mjs',path.join(__dirname,'browser-qa-toolbar.mjs'));
  const namespace='fixture-'+crypto.randomUUID();
  files.set('qa-config.mjs','export const namespace='+JSON.stringify(namespace)+';\n');
  files.set('qa-guard.js',guard);files.set('qa-toolbar.css',css);files.set('index.html',html);
  const staticDirectory=path.join(target,'dist');fs.mkdirSync(staticDirectory,{recursive:true});
  for(const [name,contents] of files){const full=path.join(staticDirectory,name);fs.mkdirSync(path.dirname(full),{recursive:true});fs.writeFileSync(full,contents)}
  fs.mkdirSync(path.join(target,'.openai'));fs.writeFileSync(path.join(target,'.openai','hosting.json'),JSON.stringify({static:{directory:'dist'}},null,2)+'\n');
  fs.writeFileSync(path.join(target,'README.md'),'# Isolated VEZDEHOT Browser QA\n\nGenerated from production assets and real server engines. No production auth, transport or endpoints are included. Accounts A/B and all V/XP are fake.\n\nManaged preview: `sites-preview start '+target+'`. Open the exact returned URL. The fixture is local QA only: do not publish it as the production site.\n\nThe toolbar supports five games, exact 320/390/844/1440 widths, reload, account switching, deterministic reset to a free/paid scenario and lost acknowledgement after local commit. Reset affects only the selected fake account. Replaying the same action receipt does not repeat the move or fake charge.\n\nBrowser API: `window.VEZDEHOT_QA.fixture` exposes current(), wallet(), request(), setAccount(), reset(), armLostResponse() and a namespaced storage facade. The engine is real; this is not a SQL, authentication, real-device or production-account test.\n');
  return {directory:target,staticDirectory,entry:path.join(staticDirectory,'index.html')};
}
module.exports={prepare};
if(require.main===module){try{if(process.argv.length!==3)throw new Error('Usage: node scripts/prepare-browser-qa.cjs /absolute/new/output-directory');console.log(JSON.stringify(prepare(process.argv[2]),null,2))}catch(error){console.error(error.message);process.exitCode=1}}
