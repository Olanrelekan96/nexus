/*
 * Nexus OS — Production Service Worker
 * Build: 2026-09-14-audit-final-v3
 */
var CACHE = 'nexus-shell-v2';

self.addEventListener('install', function (event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.add(self.registration.scope).catch(function () {});
    }).catch(function () {})
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== CACHE && key.indexOf('nexus-shell-') === 0) {
          return caches.delete(key).catch(function () {});
        }
        return Promise.resolve(false);
      }));
    }).then(function () {
      return self.clients.claim();
    }).catch(function () {})
  );
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request).then(function (response) {
      if (response && response.ok) {
        var copy = response.clone();
        caches.open(CACHE).then(function (cache) {
          return cache.put(event.request, copy);
        }).catch(function () {});
      }
      return response;
    }).catch(function () {
      return caches.match(event.request).then(function (cached) {
        return cached || caches.match(self.registration.scope);
      }).catch(function () {
        return caches.match(self.registration.scope);
      });
    })
  );
});
