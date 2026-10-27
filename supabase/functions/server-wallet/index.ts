// The browser submits intent only. Ownership, amounts and time belong to Auth/DB.
export const ALLOWED_ORIGINS = new Set(['https://vezdehot.vercel.app','https://vezdehot.greysquid7.chatgpt.site']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/;
const object = (v: unknown): v is Record<string, any> => !!v&&typeof v==='object'&&!Array.isArray(v);
const integer = (v: unknown,minimum=0) => Number.isSafeInteger(v)&&Number(v)>=minimum;
const date = (v: unknown) => typeof v==='string'&&UTC_DATE.test(v)&&Number.isFinite(Date.parse(v));
class WalletError extends Error {
  code: string;
  status: number;
  constructor(code: string,status=503) {super(code);this.code=code;this.status=status;}
}
const unavailable = (): never => {throw new WalletError('server_unavailable');};
const invalid = (): never => {throw new WalletError('invalid_request',400);};

async function requestBody(request: Request) {
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw new WalletError('json_required',415);
  const reader=request.body?.getReader();if(!reader)invalid();
  const chunks: Uint8Array[]=[];let bytes=0;
  try {while(true){const {done,value}=await reader!.read();if(done)break;bytes+=value.byteLength;if(bytes>4096){await reader!.cancel();throw new WalletError('request_too_large',413);}chunks.push(value);}}finally{reader!.releaseLock();}
  const raw=new Uint8Array(bytes);let at=0;for(const chunk of chunks){raw.set(chunk,at);at+=chunk.byteLength;}
  let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{invalid();}
  if(!object(body))invalid();
  const allowed=body.op==='load'?['op']:body.op==='claimDaily'?['op','actionId']:[];
  if(!allowed.length||Object.keys(body).some(k=>!allowed.includes(k)))invalid();
  if(body.op==='claimDaily'&&(typeof body.actionId!=='string'||!UUID.test(body.actionId)))invalid();
  return body;
}

/** Explicit public projection prevents storage-only fields from reaching players. */
export function projectWallet(value: unknown) {
  if(!object(value)||value.version!==1||!integer(value.revision)||!integer(value.balance)||!integer(value.xp)||!integer(value.games)||!integer(value.wins)||value.wins>value.games||!date(value.bonusAvailableAt)||!date(value.serverTime)||!Array.isArray(value.history)||value.history.length>20)unavailable();
  const v=value as Record<string, any>;
  const history=v.history.map((entry: unknown)=>{
    if(!object(entry)||typeof entry.id!=='string'||entry.id.length<1||entry.id.length>100||!['welcome','daily','entry','settlement'].includes(entry.kind)||!integer(entry.delta,-Number.MAX_SAFE_INTEGER)||!integer(entry.xp)||!integer(entry.balance)||!date(entry.createdAt))unavailable();
    const e=entry as Record<string, any>,gameEvent=e.kind==='entry'||e.kind==='settlement';
    if(gameEvent?(!['durak','poker','bunker'].includes(e.game)||typeof e.tableId!=='string'||!UUID.test(e.tableId)):(e.game!==null||e.tableId!==null))unavailable();
    return {id:e.id,kind:e.kind,game:e.game,tableId:e.tableId,delta:e.delta,xp:e.xp,balance:e.balance,createdAt:e.createdAt};
  });
  if(new Set(history.map((entry: {id: string})=>entry.id)).size!==history.length)unavailable();
  return {version:1,revision:v.revision,balance:v.balance,xp:v.xp,games:v.games,wins:v.wins,bonusAvailableAt:v.bonusAvailableAt,serverTime:v.serverTime,history};
}

function projectReceipt(value: unknown,actionId: string) {
  if(!object(value)||!['saved','cooldown'].includes(value.status)||typeof value.actionId!=='string'||value.actionId.toLowerCase()!==actionId.toLowerCase()||(value.availableAt!==undefined&&!date(value.availableAt))||(value.status==='cooldown'&&!date(value.availableAt)))unavailable();
  const v=value as Record<string, any>;
  return {status:v.status,actionId,...(v.availableAt===undefined?{}:{availableAt:v.availableAt})};
}

type Dependencies = {env?: (name:string)=>string|undefined;fetch?:typeof fetch};
export function createHandler(deps: Dependencies={}) {
  const env=deps.env??((name:string)=>Deno.env.get(name)),fetcher=deps.fetch??fetch;
  async function api(path:string,body?:unknown,authorization?:string) {
    const url=env('SUPABASE_URL'),secret=env('SUPABASE_SERVICE_ROLE_KEY');
    if(!url||!secret||!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url))unavailable();
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);
    try {
      const response=await fetcher(url!.replace(/\/$/,'')+path,{method:body===undefined?'GET':'POST',redirect:'error',signal:controller.signal,headers:{apikey:secret!,Authorization:authorization??`Bearer ${secret}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {status:response.status,ok:response.ok,value:await response.json().catch(()=>null)};
    } catch {unavailable();} finally {clearTimeout(timeout);}
  }
  async function rpc(name:string,body:unknown) {
    const result=await api('/rest/v1/rpc/'+name,body);
    if(!result!.ok)throw new WalletError(result!.value?.code==='22023'?'request_id_reused':'server_unavailable',result!.value?.code==='22023'?409:503);
    if(!object(result!.value))unavailable();
    return result!.value;
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
      if(!/^Bearer [A-Za-z0-9._~-]{20,8192}$/i.test(authorization))throw new WalletError('login_required',401);
      const body=await requestBody(request);
      const verified=await api('/auth/v1/user',undefined,authorization),user=verified!.value;
      if(!verified!.ok)throw new WalletError(verified!.status>=500?'server_unavailable':'login_required',verified!.status>=500?503:401);
      if(!object(user)||typeof user.id!=='string'||!UUID.test(user.id)||user.is_anonymous!==false)throw new WalletError('login_required',401);
      if(body.op==='load')return reply(200,{status:'ok',wallet:projectWallet(await rpc('server_wallet_read',{p_user_id:user.id}))});
      return reply(200,projectReceipt(await rpc('server_wallet_claim',{p_user_id:user.id,p_action_id:body.actionId,p_request:body}),body.actionId));
    } catch(error) {
      if(error instanceof WalletError)return reply(error.status,{error:error.code});
      return reply(503,{error:'server_unavailable'});
    }
  };
}
if(typeof Deno!=='undefined')Deno.serve(createHandler());
