/**
 * Telegram Mini App -> Supabase session exchange.
 * Public-key verification: https://core.telegram.org/bots/webapps#validating-data-for-third-party-use
 * No Telegram bot token is used or accepted by this function.
 */
export const BOT_ID = '8412086640';
export const TELEGRAM_PUBLIC_KEY = 'e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d';
export const ALLOWED_ORIGINS = new Set([
  'https://vezdehot.vercel.app',
  'https://vezdehot.greysquid7.chatgpt.site',
]);
const MAX_BYTES = 16 * 1024;
const encoder = new TextEncoder();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class AuthError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
function deny() { throw new AuthError(401, 'invalid_telegram_data'); }
function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function parseInitData(raw: string) {
  if (!raw || encoder.encode(raw).byteLength > MAX_BYTES) deny();
  const fields = new Map<string, string>();
  for (const pair of raw.split('&')) {
    const separator = pair.indexOf('=');
    if (separator < 1) deny();
    let key, value;
    try {
      key = decodeURIComponent(pair.slice(0, separator).replace(/\+/g, ' '));
      value = decodeURIComponent(pair.slice(separator + 1).replace(/\+/g, ' '));
    } catch { deny(); }
    if (!key || value === undefined || !/^[a-z_]+$/.test(key) || fields.has(key)) deny();
    fields.set(key, value);
  }
  return fields;
}
function decodeSignature(signature: string) {
  // A 64-byte Ed25519 signature is 86 base64url characters, optionally padded.
  if (!/^[A-Za-z0-9_-]{86}(?:==)?$/.test(signature)) deny();
  const raw = atob(signature.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '') + '==');
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}
export async function verifyInitData(raw: string, options: {
  now?: number; publicKey?: string; botId?: string;
} = {}) {
  const fields = parseInitData(raw);
  const date = fields.get('auth_date') || '';
  if (!/^\d{1,12}$/.test(date)) deny();
  const seconds = Number(date);
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || now - seconds > 600 || seconds - now > 30) deny();
  const signature = decodeSignature(fields.get('signature') || '');
  const data = `${options.botId ?? BOT_ID}:WebAppData\n` + [...fields.entries()]
    .filter(([key]) => key !== 'hash' && key !== 'signature')
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join('\n');
  const hex = options.publicKey ?? TELEGRAM_PUBLIC_KEY;
  if (!/^[a-f0-9]{64}$/i.test(hex)) deny();
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(hex.match(/../g)!, byte => parseInt(byte, 16)), {name: 'Ed25519'}, false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', key, signature, encoder.encode(data))) deny();
  let user;
  try { user = JSON.parse(fields.get('user') || ''); } catch { deny(); }
  if (!isObject(user) || !Number.isSafeInteger(user.id) || user.id <= 0 || user.is_bot === true) deny();
  return {
    id: String(user.id),
    // Display metadata is never used to identify an account.
    name: [user.first_name, user.last_name].filter(value => typeof value === 'string').join(' ').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) || 'Игрок Telegram',
    authDate: seconds,
  };
}
async function readJson(request: Request) {
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw new AuthError(413, 'request_too_large');
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new AuthError(415, 'json_required');
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError(400, 'invalid_request');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) {
        await reader.cancel();
        throw new AuthError(413, 'request_too_large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(body));
    if (!isObject(parsed) || Object.keys(parsed).length !== 1 || typeof parsed.initData !== 'string') throw new Error();
    return parsed.initData;
  } catch { throw new AuthError(400, 'invalid_request'); }
}

type Dependencies = {
  env?: (name: string) => string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
  // Only dependency injection for offline crypto tests; never read from HTTP or environment.
  publicKey?: string;
};
export function createHandler(dependencies: Dependencies = {}) {
  const env = dependencies.env ?? ((name: string) => Deno.env.get(name));
  const fetcher = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const recent = new Map<string, number>();
  async function api(path: string, method = 'GET', body?: unknown) {
    const url = env('SUPABASE_URL');
    const secret = env('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !secret || !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url)) throw new AuthError(503, 'auth_unavailable');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetcher(url.replace(/\/$/, '') + path, {
        method, signal: controller.signal, redirect: 'error',
        headers: {apikey: secret, Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', Prefer: 'return=representation'},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      });
      const value = await response.json().catch(() => null);
      return {ok: response.ok, status: response.status, value};
    } catch { throw new AuthError(503, 'auth_unavailable'); }
    finally { clearTimeout(timeout); }
  }
  async function mapping(telegramId: string) {
    const result = await api(`/rest/v1/telegram_identities?telegram_id=eq.${telegramId}&select=telegram_id,user_id&limit=1`);
    if (!result.ok || !Array.isArray(result.value)) throw new AuthError(503, 'auth_unavailable');
    const row = result.value[0];
    if (row && (String(row.telegram_id) !== telegramId || !uuidPattern.test(row.user_id))) throw new AuthError(503, 'identity_mismatch');
    return row?.user_id as string | undefined;
  }
  async function exchange(identity: {id: string; name: string}) {
    let userId = await mapping(identity.id);
    if (!userId) {
      const created = await api('/auth/v1/admin/users', 'POST', {
        email: `telegram-${identity.id}@users.vezdehot.invalid`,
        email_confirm: true,
        user_metadata: {full_name: identity.name, name: identity.name},
        app_metadata: {telegram_id: identity.id, auth_provider: 'telegram'},
      });
      const user = created.value?.user ?? created.value;
      if (!created.ok || !user || !uuidPattern.test(user.id)) {
        // A parallel request may have created it. Email ownership is never a fallback.
        userId = await mapping(identity.id);
        if (!userId) throw new AuthError(409, 'please_retry');
      } else {
        let inserted;
        try { inserted = await api('/rest/v1/telegram_identities', 'POST', {telegram_id: identity.id, user_id: user.id}); }
        catch { inserted = null; }
        if (!inserted?.ok) {
          // If the insert outcome is uncertain, an unavailable lookup must NOT cause deletion.
          userId = await mapping(identity.id);
          if (!userId) {
            // Only this request's newly created, still-unmapped user may be rolled back.
            // Never search for or delete a user merely because its email already exists.
            try { await api(`/auth/v1/admin/users/${user.id}`, 'DELETE'); } catch { /* fail closed; operator repair may be needed */ }
            throw new AuthError(409, 'please_retry');
          }
        } else {
          // Re-read the authoritative mapping even after our successful insert.
          userId = await mapping(identity.id);
          if (userId !== user.id) throw new AuthError(503, 'identity_mismatch');
        }
      }
    }
    const result = await api(`/auth/v1/admin/users/${userId}`);
    const user = result.value?.user ?? result.value;
    if (!result.ok || !user || user.id !== userId || String(user.app_metadata?.telegram_id) !== identity.id || typeof user.email !== 'string' || !user.email) throw new AuthError(503, 'identity_mismatch');
    const generated = await api('/auth/v1/admin/generate_link', 'POST', {type: 'magiclink', email: user.email});
    const linkedUser = generated.value?.user ?? generated.value;
    // A simultaneous email change must never return another account's token.
    if (!generated.ok || linkedUser?.id !== userId || String(linkedUser.app_metadata?.telegram_id) !== identity.id || typeof generated.value?.hashed_token !== 'string' || !generated.value.hashed_token || generated.value.verification_type !== 'magiclink') throw new AuthError(503, 'auth_unavailable');
    return generated.value.hashed_token as string;
  }
  return async function handler(request: Request) {
    const origin = request.headers.get('origin') || '';
    const allowed = ALLOWED_ORIGINS.has(origin);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff',
      ...(allowed ? {'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-client-info', 'Access-Control-Max-Age': '600'} : {}),
    };
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), {status, headers});
    if (!allowed) return reply(403, {error: 'origin_not_allowed'});
    if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers});
    if (request.method !== 'POST') return reply(405, {error: 'method_not_allowed'});
    try {
      const raw = await readJson(request);
      const identity = await verifyInitData(raw, {now: now(), publicKey: dependencies.publicKey});
      const timestamp = now();
      for (const [key, until] of recent) if (until <= timestamp) recent.delete(key);
      if (recent.has(identity.id)) { headers['Retry-After'] = '1'; return reply(429, {error: 'please_retry'}); }
      // Short-lived per-isolate abuse guard; no permanent replay lockout.
      if (recent.size >= 4096) { headers['Retry-After'] = '1'; return reply(429, {error: 'please_retry'}); }
      recent.set(identity.id, timestamp + 1000);
      const tokenHash = await exchange(identity);
      return reply(200, {token_hash: tokenHash, type: 'magiclink'});
    } catch (error) {
      if (error instanceof AuthError) return reply(error.status, {error: error.code});
      return reply(503, {error: 'auth_unavailable'});
    }
  };
}

// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are built-in server secrets.
if (typeof Deno !== 'undefined') Deno.serve(createHandler());
