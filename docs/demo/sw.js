// Gander service worker — just enough offline to make the PWA shell open
// instantly on a phone. The live data is WebSocket + /api/, which we never
// touch: stale agent state is worse than no agent state.
const CACHE = 'gander-v1';
const SHELL = ['/', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

// Drop caches from older versions so a bumped CACHE name fully replaces them.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('gander-') && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never intercept POSTs etc.

  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return; // live data — always straight to the bridge

  // Vite's /assets/ files are content-hashed, so cache-first is always correct:
  // a changed file gets a new name, an old name never goes stale.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      }))
    );
    return;
  }

  // Navigations (and '/') are network-first: always fresh when the bridge is
  // reachable, cached shell when it isn't (subway mode).
  if (req.mode === 'navigate' || url.pathname === '/') {
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match('/')))
    );
  }
});
