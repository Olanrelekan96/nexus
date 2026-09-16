/* ============================================================
 * 12-pwa.js
 * PWA install prompt and offline-capable app shell registration.
 *
 * Part of Nexus — loaded as a plain <script> (not a module) in
 * index.html, in numeric filename order. All files share one global
 * scope on purpose (same as the original single-file build), so
 * `state`, helper functions, etc. declared in an earlier file are
 * directly usable here without imports.
 * ============================================================ */
"use strict";

/* ============================================================
   PWA: installable, offline-capable app shell
   The manifest and icon can be generated in-memory as Blob/data URLs
   — that's just a normal fetched resource, no restriction there.
   The service worker script cannot: per spec, browsers reject
   navigator.serviceWorker.register() with a TypeError whenever the
   scriptURL isn't http(s) — blob:/data: script URLs are explicitly
   disallowed (this is deliberate, not a bug to route around), so a
   real same-origin sw.js file is required. Nexus ships one as a
   companion file — save it next to this .html on a web server (or
   localhost) and it registers automatically; without it, everything
   above still works fine, just without install/offline.
   ============================================================ */
var NEXUS_SW_SOURCE = "var CACHE='nexus-shell-v2';" +
  "self.addEventListener('install',function(e){self.skipWaiting();e.waitUntil(caches.open(CACHE).then(function(c){return c.add(self.registration.scope).catch(function(){});}));});" +
  "self.addEventListener('activate',function(e){e.waitUntil(caches.keys().then(function(keys){return Promise.all(keys.filter(function(k){return k!==CACHE;}).map(function(k){return caches.delete(k);}));}).then(function(){return self.clients.claim();}));});" +
  "self.addEventListener('fetch',function(e){" +
  "if(e.request.method!=='GET')return;" +
  "e.respondWith(fetch(e.request).then(function(r){if(r && r.ok){var copy=r.clone();caches.open(CACHE).then(function(c){c.put(e.request,copy);}).catch(function(){});}return r;})" +
  ".catch(function(){return caches.match(e.request).then(function(c){return c||caches.match(self.registration.scope);});}));" +
  "});";
function downloadServiceWorkerFile(){
  var blob = new Blob([NEXUS_SW_SOURCE], {type:'text/javascript'});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = 'sw.js';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('Downloaded sw.js — put it in the same folder as this .html file, then reload.');
}
function setPwaStatus(text){
  var el = document.getElementById('pwa-status');
  if(el) el.textContent = text;
}
var deferredInstallPrompt = null;
function registerPwa(){
  /* manifest.json and the icons/ files are now real static files shipped
     next to index.html (see /manifest.json and /icons) instead of being
     generated at runtime as blob: URLs. A real manifest.json is what
     browsers actually rely on for installability checks and "Add to Home
     Screen" — blob-URL manifests behave inconsistently across browsers —
     so the <link rel="manifest"> and <link rel="icon"/apple-touch-icon>
     tags in index.html now just point straight at those real files and
     nothing here needs to rewrite them. */

  if(!('serviceWorker' in navigator)){
    setPwaStatus('This browser does not support installable/offline apps.');
    return;
  }
  if(!(location.protocol === 'https:' || location.hostname === 'localhost')){
    setPwaStatus('Open Nexus over https:// (or localhost) to enable install + offline.');
    return;
  }
  if(location.protocol === 'blob:' || location.href.indexOf('blob:') === 0){
    setPwaStatus('Open the real file URL (not a blob preview) to enable install + offline.');
    return;
  }
  var swPath = location.pathname.replace(/[^/]*$/, '') + 'sw.js';
  navigator.serviceWorker.register(swPath, {scope: './'}).then(function(){
    setPwaStatus('Offline-ready — this page will reload even without a connection.');
    document.getElementById('btn-download-sw').style.display = 'none';
  }).catch(function(){
    setPwaStatus('Save the companion sw.js file next to this .html on your server to enable install + offline.');
    document.getElementById('btn-download-sw').style.display = '';
  });
}
window.addEventListener('beforeinstallprompt', function(e){
  e.preventDefault();
  deferredInstallPrompt = e;
  var btn = document.getElementById('btn-install-app');
  if(btn) btn.style.display = '';
});
window.addEventListener('appinstalled', function(){
  deferredInstallPrompt = null;
  var btn = document.getElementById('btn-install-app');
  if(btn) btn.style.display = 'none';
  toast('Nexus installed.');
});

