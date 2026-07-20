const CACHE_NAME = 'enrichu-v12';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/login.html',
  '/register.html',
  '/admin.html',
  '/css/style.css',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (request.url.includes('/api/')) {
    event.respondWith(fetch(request));
    return;
  }
  if (request.destination === 'document') {
    event.respondWith(fetch(request));
    return;
  }
  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok && request.url.startsWith(self.location.origin)) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
      }
      return response;
    }))
  );
});
