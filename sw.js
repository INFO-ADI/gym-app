/* Gym Manager service worker: caches the app shell only. Member data (Supabase) is never cached. */
const CACHE = 'gym-shell-2.1.0';
const SHELL = ['./', 'index.html', 'config.js?v=2.0.0', 'assets/app.css?v=2.1.0', 'assets/app.js?v=2.1.0', 'assets/qrcode.js?v=1.4.4',
  'assets/supabase.js?v=2.119.2', 'assets/icons/icon-192.png', 'manifest.webmanifest'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;      // Supabase calls go straight to the network
  if (url.pathname.endsWith('setup.html') || url.pathname.endsWith('setup.js')) return;
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
});
