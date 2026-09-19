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
var NEXUS_SW_SOURCE = "/* Nexus offline app-shell service worker. Keep this file and the generated\n   download copy in js/12-pwa.js in sync. */\nvar CACHE='nexus-shell-v11';\nvar SHELL=[\n  './', './index.html', './manifest.json',\n  './css/styles.css',\n  './icons/favicon.ico', './icons/apple-touch-icon.png', './icons/icon-192.png',\n  './icons/icon-512.png', './icons/icon-512-maskable.png',\n  './js/00-state-and-helpers.js', './js/01-query-engine.js', './js/02-editor-core.js',\n  './js/03-sidebar-search-templates.js', './js/04-render-page.js', './js/05-backlinks-nav-graph.js',\n  './js/06-backup-sync.js', './js/07-find-replace-settings.js', './js/08-edit-dock-attachments.js',\n  './js/09-security-lock.js?v=20260919-passcode-v7-true-launch-off', './js/10-lan-sync.js', './js/11-import-export.js', './js/12-pwa.js',\n  './js/13-slash-and-context-menus.js', './js/13a-locks-and-sidebar.js', './js/13b-dashboard.js',\n  './js/14-wiring-and-init.js', './js/15-task-manager.js', './js/16-advanced-database.js',\n  './js/17-advanced-search.js', './js/18-global-search.js', './js/19-mobile-editor.js',\n  './js/20-quality-hardening.js', './js/21-database-sidebar.js', './js/22-query-sidebar.js',\n  './js/23-daily-notes.js', './js/24-page-appearance.js', './js/25-transclusion.js',\n  './js/26-flashcards.js', './js/27-sticky-notes.js', './js/28-zettelkasten.js',\n  './js/29-folders.js', './js/30-zettelkasten-mobile.js', './js/31-command-center.js',\n  './js/32-tabs.js', './js/33-footnotes.js', './js/34-sidebar-ui-ordering.js'\n];\nself.addEventListener('install',function(e){\n  self.skipWaiting();\n  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(SHELL); }));\n});\nself.addEventListener('activate',function(e){\n  e.waitUntil(caches.keys().then(function(keys){\n    return Promise.all(keys.filter(function(k){ return k!==CACHE; }).map(function(k){ return caches.delete(k); }));\n  }).then(function(){ return self.clients.claim(); }));\n});\nself.addEventListener('fetch',function(e){\n  if(e.request.method!=='GET') return;\n  var req=e.request;\n  var url;\n  try{ url=new URL(req.url); }catch(ignore){ return; }\n  if(url.origin!==self.location.origin) return;\n  e.respondWith(\n    fetch(req,{cache:'no-store'}).then(function(r){\n      if(r && r.ok){\n        var copy=r.clone();\n        caches.open(CACHE).then(function(c){ c.put(req,copy); }).catch(function(){});\n      }\n      return r;\n    }).catch(function(){\n      if(req.mode==='navigate') return caches.match('./index.html');\n      return caches.match(req);\n    })\n  );\n});\n";

function downloadServiceWorkerFile(){
  var swPath = location.pathname.replace(/[^/]*$/, '') + 'sw.js';
  fetch(swPath,{cache:'no-store'}).then(function(r){
    if(!r.ok) throw new Error('companion service worker not found');
    return r.text();
  }).catch(function(){ return NEXUS_SW_SOURCE; }).then(function(source){
    var blob = new Blob([source], {type:'text/javascript'});
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'sw.js';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('Downloaded the current Nexus sw.js. Put it beside index.html, then reload.');
  }).catch(function(){ toast('Could not prepare sw.js for download.'); });
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
    setPwaStatus('Offline-ready — the Nexus app shell is cached for offline startup.');
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

