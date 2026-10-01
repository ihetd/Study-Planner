// Network-first service worker: always loads the newest version when online,
// falls back to the cached copy so the installed app still opens offline.
// Cross-origin requests (Firebase, fonts, Google) are left to the network.
const CACHE = 'study-planner-v2';
const SHELL = ['./', './index.html', './manifest.webmanifest', './assets/peony.png', './assets/icon-192.png', './assets/apple-touch-icon.png', './assets/silence.m4a'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(hit => hit || (req.mode === 'navigate' ? caches.match('./') : undefined)))
  );
});
