/* MMRC Fleet Log service worker.
   Lets phones install the site as an app. Pages always load fresh from the
   internet when there is a connection; the saved copy is only a fallback.
   Records never pass through here: they go straight to Google. */
const CACHE = 'fleet-log-v3';
const SHELL = ['./', './index.html', './trolley.html', './movexx.html', './store.js',
               './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  // Cache each file on its own, so one missing file can't stop the app installing
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;   // Google, fonts, PDF library: untouched
  e.respondWith(
    fetch(req).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })
      .then(r => r || (req.mode === 'navigate' ? caches.match('./index.html').then(i => i || caches.match('./')) : undefined))
      .then(r => r || new Response('Offline. Connect to the internet and try again.', { status: 503, headers: { 'Content-Type': 'text/plain' } })))
  );
});
