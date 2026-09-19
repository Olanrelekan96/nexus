/* ============================================================
 * 36-footer-actions-repair.js
 * Final defensive wiring for critical sidebar footer actions.
 * These controls must remain usable even if an optional status widget throws
 * during initialization. This module intentionally loads LAST.
 * ============================================================ */
"use strict";
(function(){
  function bind(id, fn){
    var el=document.getElementById(id);
    if(!el) return;
    el.onclick=function(e){
      if(e) e.__nexusFooterHandled=true;
      try{ fn(); }catch(err){
        try{ if(typeof toast==='function') toast('That action could not open right now. Try again.'); }catch(ignore){}
      }
    };
  }
  bind('btn-settings', function(){ openSettings(); });
  bind('btn-find-replace', function(){ openFindReplace(); });
  bind('btn-sync-center', function(){ openSyncCenter(); });
  bind('btn-sync', function(){ openSyncModal(); });
})();
