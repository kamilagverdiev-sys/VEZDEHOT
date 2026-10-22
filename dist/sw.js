const CACHE='vezdehot-v5';
const ASSETS=['./','./index.html','./durak.css?v=5','./poker.html','./mafia.html','./monopoly.html','./manifest.webmanifest'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('vezdehot-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
// Network first on app assets. Updates never reload or interrupt an active game.
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin)return;
  event.respondWith(fetch(request).then(response=>{
    if(response.ok){const copy=response.clone();event.waitUntil(caches.open(CACHE).then(cache=>cache.put(request,copy)));}
    return response;
  }).catch(async()=>{const cached=await caches.match(request);if(cached)return cached;if(request.mode==='navigate')return caches.match('./index.html');return Response.error();}));
});
