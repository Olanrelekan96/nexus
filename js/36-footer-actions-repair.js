/* ============================================================
 * 36-footer-actions-repair.js
 * Critical sidebar/footer action router.
 *
 * The four controls covered here are app-critical entry points. They are
 * wired directly, then protected by a document-level capture router so a
 * later legacy `.onclick` assignment, delegation, or stopPropagation call
 * cannot leave them inert. The module also exposes a small diagnostics API.
 * ============================================================ */
"use strict";
(function(){
  var ACTION_IDS = ['btn-settings','btn-find-replace','btn-sync-center','btn-sync'];
  var ACTIONS = {
    'btn-settings': function(){ if(typeof openSettings !== 'function') throw new Error('openSettings unavailable'); openSettings(); },
    'btn-find-replace': function(){ if(typeof openFindReplace !== 'function') throw new Error('openFindReplace unavailable'); openFindReplace(); },
    'btn-sync-center': function(){ if(typeof openSyncCenter !== 'function') throw new Error('openSyncCenter unavailable'); openSyncCenter(); },
    'btn-sync': function(){ if(typeof openSyncModal !== 'function') throw new Error('openSyncModal unavailable'); openSyncModal(); }
  };

  function reportFailure(id, err){
    try{ console.error('Nexus critical action failed:', id, err); }catch(ignore){}
    try{ if(typeof toast==='function') toast('That action could not open right now. Try again.'); }catch(ignoreToast){}
  }
  function run(id){
    var fn=ACTIONS[id];
    if(!fn) return false;
    try{ fn(); return true; }
    catch(err){ reportFailure(id,err); return false; }
  }
  function resolveActionTarget(node){
    var t=node;
    while(t && t!==document){
      if(t.id && Object.prototype.hasOwnProperty.call(ACTIONS,t.id)) return t;
      t=t.parentNode;
    }
    return null;
  }
  function markAndRun(e, el){
    if(!el || !ACTIONS[el.id]) return false;
    if(e && e.__nexusCriticalHandled) return true;
    if(e) e.__nexusCriticalHandled=true;
    return run(el.id);
  }

  /* Direct property handler is the normal path for existing code. */
  ACTION_IDS.forEach(function(id){
    var el=document.getElementById(id);
    if(!el) return;
    el.onclick=function(e){ markAndRun(e,el); };
    if(el.setAttribute){
      el.setAttribute('data-nexus-critical-action','1');
      el.setAttribute('aria-controls', id==='btn-settings' ? 'settings-overlay' : id==='btn-find-replace' ? 'findreplace-overlay' : id==='btn-sync-center' ? 'sync-center-overlay' : 'sync-overlay');
    }
    el.addEventListener('click',function(e){ markAndRun(e,el); });
    el.addEventListener('keydown',function(e){
      if(e.key==='Enter' || e.key===' '){ e.preventDefault(); markAndRun(e,el); }
    });
  });

  /* Capture phase runs before ordinary bubbling listeners. This is the
     important fallback when another module has overwritten `.onclick` or
     stops bubbling. */
  document.addEventListener('click',function(e){
    var el=resolveActionTarget(e.target);
    if(el) markAndRun(e,el);
  },true);

  window.NexusCriticalActions={
    ids:function(){ return ACTION_IDS.slice(); },
    run:function(id){ return run(id); },
    isBound:function(id){ var el=document.getElementById(id); return !!(el && typeof el.onclick==='function'); }
  };
})();
