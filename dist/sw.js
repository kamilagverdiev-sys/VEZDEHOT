const CACHE = 'vezdehot-v12';
const ASSETS = [
  './', './index.html', './durak.css', './bunker.css', './lobby.css', './platform.css',
  './poker.html', './poker-equity.js', './mafia.html', './monopoly.html', './manifest.webmanifest',
  './auth-config.js', './game-store.js', './tab-session.js', './session.css', './game-guide.js', './game-guide.css', './platform.js', './telegram.js', './vendor/supabase-2.118.0.js'
];
const SCOPE = new URL(self.registration.scope);
const PATHS = new Set(ASSETS.map(path => new URL(path, SCOPE).pathname));
const AUTH_KEYS = /^(?:code|error(?:_.*)?|state|access_token|refresh_token|id_token|provider_token|provider_refresh_token|token|oauth_token|code_verifier|assertion)$/i;
const TOKEN_DATA = /["'](?:access_token|refresh_token|id_token|provider_token|provider_refresh_token)["']\s*:\s*["'][^"']+["']/i;

function safeURL(value) {
  const url = new URL(value, SCOPE);
  if (url.origin !== SCOPE.origin || /\/auth-callback(?:[./]|$)/i.test(url.pathname)) return false;
  for (const key of url.searchParams.keys()) if (AUTH_KEYS.test(key)) return false;
  for (const key of new URLSearchParams(url.hash.slice(1)).keys()) if (AUTH_KEYS.test(key)) return false;
  return true;
}

// Keep cache keys free of query strings. Only known app files and their clean URLs qualify.
function assetKey(value) {
  if (!safeURL(value)) return null;
  const url = new URL(value, SCOPE);
  if ([...url.searchParams.keys()].some(key => key !== 'v')) return null;
  let path = url.pathname;
  if (!PATHS.has(path) && PATHS.has(path + '.html')) path += '.html';
  if (!PATHS.has(path)) return null;
  return new URL(path, SCOPE).href;
}

async function cacheableResponse(response, key) {
  if (!response || !response.ok || response.type === 'opaque') return false;
  if (response.url && assetKey(response.url) !== key) return false;
  if (/\b(?:no-store|private)\b/i.test(response.headers.get('Cache-Control') || '')) return false;
  if (['Authorization', 'Set-Cookie', 'X-Access-Token', 'X-Refresh-Token'].some(header => response.headers.has(header))) return false;
  // Every allowlisted app asset is text. Inspect it even when a server omits its MIME type.
  if (TOKEN_DATA.test(await response.clone().text())) return false;
  return true;
}

async function remember(cache, key, response) {
  if (await cacheableResponse(response, key)) await cache.put(key, response.clone());
}

self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  // A temporarily unavailable optional asset must not prevent a service-worker update.
  await Promise.allSettled(ASSETS.map(async path => {
    const url = new URL(path, SCOPE).href;
    const response = await fetch(new Request(url, {cache: 'reload', credentials: 'omit'}));
    await remember(cache, assetKey(url), response);
  }));
  await self.skipWaiting();
})()));

self.addEventListener('activate', event => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key.startsWith('vezdehot-') && key !== CACHE).map(key => caches.delete(key)));
  await self.clients.claim();
})()));

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('Authorization')) return;
  const key = assetKey(request.url);
  // OAuth callbacks, token/error URLs, external services and APIs always bypass this worker.
  if (!key) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const immutable = /\/vendor\/supabase-\d+\.\d+\.\d+\.js$/.test(new URL(key).pathname);
    if (immutable && request.mode !== 'navigate') {
      const cached = await cache.match(key);
      if (cached) return cached;
    }
    try {
      // Navigations and mutable assets use the network first, so updates remain visible.
      const response = await fetch(request);
      event.waitUntil(remember(cache, key, response).catch(() => {}));
      return response;
    } catch (_) {
      const cached = await cache.match(key);
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const lobby = await cache.match(new URL('./index.html', SCOPE).href) || await cache.match(SCOPE.href);
        if (lobby) return lobby;
      }
      return Response.error();
    }
  })());
});
