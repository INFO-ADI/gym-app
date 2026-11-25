/* Gym app service worker: caches the app shell only. Member data (Supabase) is never cached.
   Gyms may share one web address (kanpurgym.com/g/<slug>/), so this worker only ever touches
   caches named "gym-<this gym's slug>-<hex version>" and never another gym's caches. */
const SLUG = '{{SLUG}}';
const PREFIX = 'gym-' + SLUG + '-';
const CACHE = PREFIX + '{{HASH}}';
const SHELL = {{SHELL}};
const isMine = k => k.startsWith(PREFIX) && /^[0-9a-f]+$/.test(k.slice(PREFIX.length));   // "gym-first-" must not match "gym-first-gym-…"
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => isMine(k) && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;      // Supabase calls go straight to the network
  if (url.pathname.endsWith('/setup') || url.pathname.endsWith('setup.js') || url.pathname.endsWith('/sw.js')) return;
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.open(CACHE).then(c => c.match(e.request).then(r => r || c.match('index.html')))));
});
