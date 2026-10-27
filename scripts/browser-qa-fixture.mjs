/* Browser QA only. Copied outside the production repository by prepare-browser-qa.cjs. */
import * as durak from './qa-engines/server-durak/engine.mjs';
import * as poker from './qa-engines/server-poker/engine.mjs';
import * as bunker from './qa-engines/server-bunker/engine.mjs';
import * as mafia from './qa-engines/server-mafia/engine.mjs';
import * as monopoly from './qa-engines/server-monopoly/engine.mjs';

const engines={durak,poker,bunker,mafia,monopoly};
export const MODES=Object.freeze(Object.keys(engines));
const copy=value=>JSON.parse(JSON.stringify(value));
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const error=(status,code)=>({ok:false,status,data:{error:code}});

export function createFixture({storage,namespace='test-qa',seed=27102026}={}){
  if(!storage||typeof storage.getItem!=='function'||typeof namespace!=='string'||!/^[a-zA-Z0-9:_-]{1,160}$/.test(namespace))throw new TypeError('QA storage and namespace required');
  const prefix='vezdehot:browser-qa:'+namespace+':',contextKey=prefix+'context';
  const read=(key,fallback)=>{const value=storage.getItem(key);return value===null?copy(fallback):JSON.parse(value)};
  const write=(key,value)=>storage.setItem(key,JSON.stringify(value));
  const context=()=>read(contextKey,{account:'a',loseNext:false});
  const dbKey=account=>prefix+'account:'+account;
  const empty=()=>({generation:0,wallet:{balance:1000,xp:0},rows:{},receipts:{}});
  const database=account=>read(dbKey(account),empty());
  const current=()=>{const ctx=context(),db=database(ctx.account);return {account:ctx.account,scope:prefix+ctx.account+':'+db.generation,loseNext:ctx.loseNext}};
  const clientPrefix=prefix+'client:';
  const clientKeys=()=>{const keys=[];for(let i=0;i<storage.length;i++){const key=storage.key(i);if(key?.startsWith(clientPrefix))keys.push(key)}return keys};
  const clientStorage=Object.freeze({
    get length(){return clientKeys().length},key:index=>clientKeys()[index]?.slice(clientPrefix.length)??null,
    getItem:key=>storage.getItem(clientPrefix+String(key)),setItem:(key,value)=>storage.setItem(clientPrefix+String(key),String(value)),removeItem:key=>storage.removeItem(clientPrefix+String(key)),
    clear(){for(const key of clientKeys())storage.removeItem(key)}
  });
  function setAccount(account){if(!['a','b'].includes(account))throw new TypeError('Only QA accounts a and b exist');write(contextKey,{account,loseNext:false});return current()}
  function reset(){
    const before=current(),db=empty();db.generation=database(before.account).generation+1;write(dbKey(before.account),db);write(contextKey,{account:before.account,loseNext:false});
    for(const key of clientKeys())if(key.endsWith(before.scope))storage.removeItem(key);
    return current();
  }
  function armLostResponse(){const ctx=context();write(contextKey,{...ctx,loseNext:true});return current()}
  async function request(mode,body,scope=current().scope){
    const owner=current();if(scope!==owner.scope)return error(403,'qa_stale_account');
    if(!Object.hasOwn(engines,mode)||!body||typeof body!=='object'||Array.isArray(body))return error(400,'invalid_request');
    const db=database(owner.account),engine=engines[mode];
    const row=db.rows[mode]||{revision:0,game:null,rng:(seed+MODES.indexOf(mode)*7919+(owner.account==='b'?101:0))>>>0};
    const response=status=>({ok:true,status:200,data:{status,revision:row.revision,game:engine.projectGame(row.game)}});
    // Reading a fixture never seeds a game, advances randomness or writes storage.
    if(body.op==='load')return response('ok');
    if(!['start','action'].includes(body.op)||!uuidPattern.test(body.actionId)||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0)return error(400,'invalid_request');
    const receiptKey=mode+':'+body.actionId,saved=db.receipts[receiptKey];
    if(saved)return JSON.stringify(saved.body)===JSON.stringify(body)?copy(saved.response):error(409,'request_id_reused');
    if(body.expectedRevision!==row.revision)return response('conflict');
    const random=()=>((row.rng=(Math.imul(row.rng,1664525)+1013904223)>>>0)/2**32);
    const uuid=()=>{const bytes=Array.from({length:16},()=>Math.floor(random()*256));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const h=bytes.map(b=>b.toString(16).padStart(2,'0')).join('');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20)};
    try{
      const previous=row.game;
      if(body.op==='start'){
        const stake=body.stake??0;if(![0,100].includes(stake))return error(400,'invalid_request');
        if(previous&&!previous.over)return error(422,'active_game');
        if(db.wallet.balance<stake)return error(422,'insufficient_funds');
        row.game=engine.createGame({bots:body.bots??1,difficulty:body.difficulty??'normal',scenarioChoice:body.scenarioChoice??'random',nick:'QA игрок '+owner.account.toUpperCase(),id:uuid(),stake},random,uuid);
        db.wallet.balance-=stake;
      }else{
        if(!previous||body.gameId!==previous.id)return error(409,'game_changed');
        row.game=engine.applyAction(previous,body.action,random,uuid);
      }
      // Fake accounting follows the real engine result, once per committed table.
      if(row.game.economy?.settled&&(body.op==='start'||!previous?.economy?.settled)){
        db.wallet.balance+=row.game.economy.payout;db.wallet.xp+=row.game.economy.xp;
      }
      row.revision++;db.rows[mode]=row;
      const result=response('saved');db.receipts[receiptKey]={body:copy(body),response:copy(result)};
      // State, fake wallet and receipt share one durable storage commit.
      write(dbKey(owner.account),db);
      if(context().loseNext){write(contextKey,{account:owner.account,loseNext:false});throw Object.assign(new Error('QA: response lost after commit'),{qaLostResponse:true})}
      return result;
    }catch(e){if(e.qaLostResponse)throw e;return error(e.status||422,e.code||'illegal_action')}
  }
  return Object.freeze({current,setAccount,reset,armLostResponse,request,wallet:()=>copy(database(current().account).wallet),storage:clientStorage});
}
