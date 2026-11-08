/* Tontine Claire — l'appli s'ouvre même sans réseau (les données, elles, ont besoin d'Internet).
   Pour publier une mise à jour, changez le numéro de CACHE. */
const CACHE = 'tontine-claire-1';
const ASSETS = ['./', './index.html', './style.css', './app.js', './config.js', './vendor/supabase.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;  // les échanges avec Supabase ne passent jamais par le cache
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(req, {ignoreSearch: true});
    const network = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    if (cached) return cached;
    const res = await network;
    return res || (req.mode === 'navigate' ? cache.match('./index.html') : Response.error());
  }));
});
