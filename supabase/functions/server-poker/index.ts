import {createGame, applyAction, projectGame, GameError} from './engine.mjs';

export const ALLOWED_ORIGINS = new Set(['https://vezdehot.vercel.app','https://vezdehot.greysquid7.chatgpt.site']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (v: unknown): v is Record<string, any> => !!v&&typeof v==='object'&&!Array.isArray(v);
function invalid() {throw new GameError('invalid_request',400);}
async function requestBody(request: Request) {
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw new GameError('json_required',415);
  const reader=request.body?.getReader();if(!reader)invalid();
  const chunks: Uint8Array[]=[];let bytes=0;
  try {while(true){const {done,value}=await reader!.read();if(done)break;bytes+=value.byteLength;if(bytes>4096){await reader!.cancel();throw new GameError('request_too_large',413);}chunks.push(value);}}finally{reader!.releaseLock();}
  const raw=new Uint8Array(bytes);let at=0;for(const chunk of chunks){raw.set(chunk,at);at+=chunk.byteLength;}
  let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{invalid();}
  if(!object(body))invalid();
  const allowed=body.op==='load'?['op']:body.op==='start'?['op','actionId','expectedRevision','difficulty']:body.op==='action'?['op','actionId','expectedRevision','gameId','action']:[];
  if(!allowed.length||Object.keys(body).some(k=>!allowed.includes(k)))invalid();
  if(body.op==='load')return body;
  if(typeof body.actionId!=='string'||!UUID.test(body.actionId)||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0)invalid();
  if(body.op==='start') {
    if(!['easy','normal','hard'].includes(body.difficulty))invalid();
  } else if(typeof body.gameId!=='string'||!UUID.test(body.gameId)||!object(body.action))invalid();
  return body;
}

type Dependencies = {env?: (name:string)=>string|undefined;fetch?:typeof fetch;random?:()=>number;uuid?:()=>string};
export function createHandler(deps: Dependencies={}) {
  const env=deps.env??((name:string)=>Deno.env.get(name)),fetcher=deps.fetch??fetch;
  async function api(path:string,body?:unknown,authorization?:string) {
    const url=env('SUPABASE_URL'),secret=env('SUPABASE_SERVICE_ROLE_KEY');
    if(!url||!secret||!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url))throw new GameError('server_unavailable',503);
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);
    try {
      const response=await fetcher(url.replace(/\/$/,'')+path,{method:body===undefined?'GET':'POST',redirect:'error',signal:controller.signal,headers:{apikey:secret,Authorization:authorization??`Bearer ${secret}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {status:response.status,ok:response.ok,value:await response.json().catch(()=>null)};
    } catch {throw new GameError('server_unavailable',503);} finally {clearTimeout(timeout);}
  }
  async function rpc(name:string,body:unknown) {
    const result=await api('/rest/v1/rpc/'+name,body);
    if(!result.ok)throw new GameError(result.value?.code==='22023'?'request_id_reused':'server_unavailable',result.value?.code==='22023'?409:503);
    if(!object(result.value))throw new GameError('server_unavailable',503);
    return result.value;
  }
  return async function handler(request: Request) {
    const origin=request.headers.get('origin')||'',allowed=ALLOWED_ORIGINS.has(origin);
    const headers:Record<string,string>={'Content-Type':'application/json','Cache-Control':'no-store','Vary':'Origin','X-Content-Type-Options':'nosniff',...(allowed?{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'content-type, apikey, authorization, x-client-info','Access-Control-Max-Age':'600'}:{})};
    const reply=(status:number,value:unknown)=>new Response(JSON.stringify(value),{status,headers});
    if(!allowed)return reply(403,{error:'origin_not_allowed'});
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
    if(request.method!=='POST')return reply(405,{error:'method_not_allowed'});
    try {
      const authorization=request.headers.get('authorization')||'';
      if(!/^Bearer [A-Za-z0-9._~-]{20,8192}$/i.test(authorization))throw new GameError('login_required',401);
      const body=await requestBody(request);
      // Verify with Auth on every request. Never decode an unverified JWT for ownership.
      const verified=await api('/auth/v1/user',undefined,authorization),user=verified.value;
      if(!verified.ok)throw new GameError(verified.status>=500?'server_unavailable':'login_required',verified.status>=500?503:401);
      if(!object(user)||typeof user.id!=='string'||!UUID.test(user.id)||user.is_anonymous!==false)throw new GameError('login_required',401);
      const current=await rpc('server_poker_read',{p_user_id:user.id,p_action_id:body.actionId??null,p_request:body.op==='load'?null:body});
      if(current.receipt)return reply(200,current.receipt);
      if(!Number.isSafeInteger(current.revision)||current.revision<0)throw new GameError('server_unavailable',503);
      if(body.op==='load')return reply(200,{status:'ok',revision:current.revision,game:projectGame(current.state)});
      if(body.expectedRevision!==current.revision)return reply(200,{status:'conflict',revision:current.revision,game:projectGame(current.state)});
      let state;
      if(body.op==='start') {
        if(current.state&&!current.state.over)throw new GameError('table_already_active',422);
        const nickname=String(user.user_metadata?.full_name||user.user_metadata?.name||'Ты').replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,24)||'Ты';
        state=createGame({difficulty:body.difficulty,nick:nickname,id:deps.uuid?.()??crypto.randomUUID()},deps.random,deps.uuid);
      } else {
        if(!current.state||current.state.id!==body.gameId)throw new GameError('table_changed',422);
        state=applyAction(current.state,body.action,deps.random,deps.uuid);
      }
      const response={status:'saved',revision:current.revision+1,game:projectGame(state)};
      const committed=await rpc('server_poker_commit',{p_user_id:user.id,p_expected_revision:current.revision,p_action_id:body.actionId,p_request:body,p_state:state,p_response:response});
      if(committed.receipt)return reply(200,committed.receipt);
      if(committed.conflict===true&&Number.isSafeInteger(committed.revision))return reply(200,{status:'conflict',revision:committed.revision,game:projectGame(committed.state)});
      throw new GameError('server_unavailable',503);
    }catch(error){
      if(error instanceof GameError)return reply(error.status,{error:error.code});
      return reply(503,{error:'server_unavailable'});
    }
  };
}
if(typeof Deno!=='undefined')Deno.serve(createHandler());
