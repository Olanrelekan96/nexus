'use strict';
const CACHE = 'nexus-final-v11-20260915';
const SCOPE = self.registration.scope;
const PRECACHE = [
  SCOPE,
  new URL('manifest.json', SCOPE).href,
  new URL('icon-192.png', SCOPE).href,
  new URL('icon-512.png', SCOPE).href,
  new URL('icon-512-maskable.png', SCOPE).href
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.all(PRECACHE.map(url => cache.add(url).catch(() => undefined))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key.startsWith('nexus-') && key !== CACHE).map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if(request.method !== 'GET') return;
  const url = new URL(request.url);
  if(url.origin !== self.location.origin) return;

  if(request.mode === 'navigate'){
    event.respondWith(
      fetch(request)
        .then(response => {
          if(response && response.ok){
            const copy = response.clone();
            caches.open(CACHE).then(cache => cache.put(SCOPE, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match(SCOPE).then(cached => cached || Response.error()))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      const network = fetch(request).then(response => {
        if(response && response.ok){
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
        }
        return response;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
