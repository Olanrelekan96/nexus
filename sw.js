/* Nexus offline app-shell service worker. Keep this file and the generated
   download copy in js/12-pwa.js in sync. */
var CACHE='nexus-shell-v11';
var SHELL=[
  './', './index.html', './manifest.json',
  './css/styles.css',
  './icons/favicon.ico', './icons/apple-touch-icon.png', './icons/icon-192.png',
  './icons/icon-512.png', './icons/icon-512-maskable.png',
  './js/00-state-and-helpers.js', './js/01-query-engine.js', './js/02-editor-core.js',
  './js/03-sidebar-search-templates.js', './js/04-render-page.js', './js/05-backlinks-nav-graph.js',
  './js/06-backup-sync.js', './js/07-find-replace-settings.js', './js/08-edit-dock-attachments.js',
  './js/09-security-lock.js?v=20260919-passcode-v7-true-launch-off', './js/10-lan-sync.js', './js/11-import-export.js', './js/12-pwa.js',
  './js/13-slash-and-context-menus.js', './js/13a-locks-and-sidebar.js', './js/13b-dashboard.js',
  './js/14-wiring-and-init.js', './js/15-task-manager.js', './js/16-advanced-database.js',
  './js/17-advanced-search.js', './js/18-global-search.js', './js/19-mobile-editor.js',
  './js/20-quality-hardening.js', './js/21-database-sidebar.js', './js/22-query-sidebar.js',
  './js/23-daily-notes.js', './js/24-page-appearance.js', './js/25-transclusion.js',
  './js/26-flashcards.js', './js/27-sticky-notes.js', './js/28-zettelkasten.js',
  './js/29-folders.js', './js/30-zettelkasten-mobile.js', './js/31-command-center.js',
  './js/32-tabs.js', './js/33-footnotes.js', './js/34-sidebar-ui-ordering.js'
];
self.addEventListener('install',function(e){
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(SHELL); }));
});
self.addEventListener('activate',function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k!==CACHE; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});
self.addEventListener('fetch',function(e){
  if(e.request.method!=='GET') return;
  var req=e.request;
  var url;
  try{ url=new URL(req.url); }catch(ignore){ return; }
  if(url.origin!==self.location.origin) return;
  e.respondWith(
    fetch(req,{cache:'no-store'}).then(function(r){
      if(r && r.ok){
        var copy=r.clone();
        caches.open(CACHE).then(function(c){ c.put(req,copy); }).catch(function(){});
      }
      return r;
    }).catch(function(){
      if(req.mode==='navigate') return caches.match('./index.html');
      return caches.match(req);
    })
  );
});
