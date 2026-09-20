var CACHE='nexus-shell-v5';
/* Precache the whole app shell at install time, not lazily on a later visit: a
   first visit followed immediately by going offline must still open the app. The
   asset list is read from index.html itself so it can never drift from the real
   script/style/icon files. */
function nexusPrecacheShell(){
  var scope = self.registration.scope;
  var origin = new URL(scope).origin;
  return caches.open(CACHE).then(function(cache){
    var urls = [scope, new URL('index.html', scope).href];
    return fetch(scope, {cache:'reload'}).then(function(res){
      if(!res || !res.ok) return;
      var copy = res.clone();
      return cache.put(scope, copy).then(function(){ return res.text(); }).then(function(html){
        var re = /(?:src|href)\s*=\s*["']([^"'#]+)["']/gi, m;
        while((m = re.exec(html))){
          var u; try{ u = new URL(m[1], scope); }catch(err){ continue; }
          if(u.origin === origin && urls.indexOf(u.href) === -1) urls.push(u.href);
        }
      });
    }).catch(function(){}).then(function(){
      return Promise.all(urls.map(function(u){ return cache.add(new Request(u, {cache:'reload'})).catch(function(){}); }));
    });
  });
}
self.addEventListener('install',function(e){self.skipWaiting();e.waitUntil(nexusPrecacheShell());});
self.addEventListener('activate',function(e){e.waitUntil(caches.keys().then(function(keys){return Promise.all(keys.filter(function(k){return k!==CACHE;}).map(function(k){return caches.delete(k);}));}).then(function(){return self.clients.claim();}));});
self.addEventListener('fetch',function(e){
  if(e.request.method!=='GET')return;
  if(e.request.url.indexOf('http')!==0)return;
  var req=e.request;
  e.respondWith(fetch(req,{cache:'no-store'}).then(function(r){
    if(r && r.ok){var copy=r.clone();caches.open(CACHE).then(function(c){c.put(req,copy);}).catch(function(){});}
    return r;
  }).catch(function(){
    return caches.match(req).then(function(c){
      if(c) return c;
      /* Only page navigations may fall back to the app shell; answering a failed script or
         stylesheet request with HTML just produces confusing syntax errors. */
      if(req.mode==='navigate') return caches.match(self.registration.scope);
      return Response.error();
    });
  }));
});
