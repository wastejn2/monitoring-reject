// Bump this number whenever any cached file changes — that's the ONLY edit
// usually needed here. It forces every client to fetch fresh files instead
// of serving stale ones from cache.
const APP_VERSION = '1.4.2';
const CACHE_NAME = `monitoring-reject-${APP_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/api.js',
  './js/ui.js',
  './js/auth.js',
  './js/input-form.js',
  './js/dashboard.js',
  './js/tv.js',
  './js/history.js',
  './js/app.js',
  './libs/chart.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

// Lets the page ask the active service worker which version it's running,
// so the nav-drawer version label never has to be hand-updated separately
// from APP_VERSION above.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'GET_VERSION' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ version: APP_VERSION });
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache cross-origin calls (the Cloudflare Worker / API) — those
  // must always hit the network so data stays live.
  if (url.origin !== self.location.origin) return;

  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
