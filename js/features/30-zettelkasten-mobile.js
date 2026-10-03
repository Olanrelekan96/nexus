/* ============================================================
 * 30-zettelkasten-mobile.js
 * Mobile-only Zettelkasten drawer/collapse state.
 *
 * The Zettelkasten hub is independent from the main navigation sidebar:
 * this module never changes `sidebar-collapsed`. On phone/tablet widths,
 * the hub becomes an off-canvas drawer over the editor/content area.
 * The user's collapsed/expanded preference is persisted locally and survives
 * navigation and reloads. Desktop keeps the normal full-workspace behavior.
 *
 * PROOF-OF-CONCEPT: this is the one file in Nexus loaded as a real ES module
 * (see its <script type="module"> tag in index.html) rather than a classic
 * script sharing the project's one global scope. Chosen specifically because
 * its only top-level side effect is a DOMContentLoaded listener -- module
 * scripts are always deferred (they run only after every classic script on
 * the page has finished, regardless of tag position), which would silently
 * break any file whose top-level code needs to run at a precise point
 * relative to other scripts. This file doesn't: DOMContentLoaded fires at the
 * same logical moment whether or not the listener that registered for it
 * came from a module, so there's no load-order hazard here. A file with
 * synchronous load-time side effects (several do -- see the top-level
 * `initNexusTabs()` call in 32-tabs.js, which wraps openPage/renderAll
 * immediately on load and would install that wrap too late if deferred)
 * would need its boot-timing restructured first, not just its script tag.
 *
 * What's genuinely different here, not just renamed: `export` is now a real,
 * enforced contract instead of a naming convention. Four functions are
 * exported -- the two 28-zettelkasten.js actually calls as a classic script
 * (bridged onto `window` below, since a module's own declarations don't
 * auto-attach there the way a classic script's do), plus two more
 * (collapse/expand) that are genuinely meaningful standalone behavior and
 * worth being independently testable even though nothing outside this file
 * currently calls them -- an ES module can have a real public API wider than
 * "whatever other files happen to reach into today", which a classic script
 * never could. Everything else (the two remaining helpers, the module's own
 * state) is now truly private: nothing else in the app can collide with
 * those names anymore, where before this conversion anything could.
 *
 * What this ISN'T a full test of: this module still reads two ambient
 * globals it doesn't import -- `zettelkastenVisible` and
 * `hideZettelkastenView`, both defined in 28-zettelkasten.js, a classic
 * script. A module can still read those (window is the same global object
 * either way), but it can't get a real `import` of them until that file is
 * converted too -- real static dependency tracking only starts once both
 * sides of a relationship are modules, which is exactly the "gradual"
 * part: converting one file at a time gets you real encapsulation for that
 * file immediately, but not the full benefit (tree-shaking, a real
 * dependency graph) until its neighbors follow. */
"use strict";

var ZETTELKASTEN_MOBILE_KEY = 'nexus_zettelkasten_mobile_collapsed';
var zettelkastenMobileCollapsed = false;

function zettelkastenMobileViewport(){
  try{
    if(typeof window !== 'undefined' && window.matchMedia) return window.matchMedia('(max-width:860px)').matches;
  }catch(e){}
  return false;
}
function loadZettelkastenMobilePreference(){
  try{ zettelkastenMobileCollapsed = localStorage.getItem(ZETTELKASTEN_MOBILE_KEY) === '1'; }
  catch(e){ zettelkastenMobileCollapsed = false; }
  return zettelkastenMobileCollapsed;
}
function setZettelkastenMobileCollapsed(collapsed, persist){
  zettelkastenMobileCollapsed = !!collapsed;
  if(persist !== false){
    try{ localStorage.setItem(ZETTELKASTEN_MOBILE_KEY, zettelkastenMobileCollapsed ? '1' : '0'); }catch(e){}
  }
  applyZettelkastenMobileMode();
}
export function clearZettelkastenMobileVisualState(){
  var app=document.getElementById('app');
  var view=document.getElementById('zettelkasten-view');
  var page=document.getElementById('page-view');
  var backdrop=document.getElementById('zettelkasten-mobile-backdrop');
  var reopen=document.getElementById('zettelkasten-mobile-reopen');
  if(app){app.classList.remove('zettelkasten-mobile-active','zettelkasten-mobile-collapsed','zettelkasten-mobile-drawer-open');}
  if(view){view.classList.remove('zk-mobile-drawer-expanded','zk-mobile-drawer-collapsed');}
  if(page) { page.classList.remove('zettelkasten-mobile-content-expanded'); if(zettelkastenMobileViewport()) page.classList.add('visible'); }
  if(backdrop){backdrop.style.display='none';backdrop.setAttribute('aria-hidden','true');}
  if(reopen){reopen.style.display='none';reopen.setAttribute('aria-expanded','false');}
}
export function applyZettelkastenMobileMode(){
  var app=document.getElementById('app');
  var view=document.getElementById('zettelkasten-view');
  var page=document.getElementById('page-view');
  var backdrop=document.getElementById('zettelkasten-mobile-backdrop');
  var reopen=document.getElementById('zettelkasten-mobile-reopen');
  var collapse=document.getElementById('zettelkasten-mobile-collapse');
  var close=document.getElementById('zettelkasten-mobile-close');
  if(!app||!view||typeof zettelkastenVisible==='undefined') return;
  if(!zettelkastenVisible){ clearZettelkastenMobileVisualState(); return; }

  var mobile=zettelkastenMobileViewport();
  app.classList.toggle('zettelkasten-mobile-active', mobile);
  if(!mobile){
    app.classList.remove('zettelkasten-mobile-collapsed','zettelkasten-mobile-drawer-open');
    view.classList.remove('zk-mobile-drawer-expanded','zk-mobile-drawer-collapsed');
    if(page) page.classList.remove('zettelkasten-mobile-content-expanded');
    if(backdrop){backdrop.style.display='none';backdrop.setAttribute('aria-hidden','true');}
    if(reopen) reopen.style.display='none';
    return;
  }

  /* Keep the editor/content visible behind the drawer. The drawer is an
     overlay, not a mutation of the main navigation sidebar. */
  if(page) page.classList.add('visible');
  if(page) page.classList.toggle('zettelkasten-mobile-content-expanded', zettelkastenMobileCollapsed);
  app.classList.toggle('zettelkasten-mobile-collapsed', zettelkastenMobileCollapsed);
  app.classList.toggle('zettelkasten-mobile-drawer-open', !zettelkastenMobileCollapsed);
  view.classList.toggle('zk-mobile-drawer-expanded', !zettelkastenMobileCollapsed);
  view.classList.toggle('zk-mobile-drawer-collapsed', zettelkastenMobileCollapsed);
  if(backdrop){
    backdrop.style.display=zettelkastenMobileCollapsed ? 'none' : 'block';
    backdrop.setAttribute('aria-hidden',zettelkastenMobileCollapsed ? 'true' : 'false');
  }
  if(reopen){
    reopen.style.display=zettelkastenMobileCollapsed ? 'inline-flex' : 'none';
    reopen.setAttribute('aria-expanded',String(!zettelkastenMobileCollapsed));
  }
  if(collapse){
    collapse.style.display='inline-flex';
    collapse.setAttribute('aria-expanded',String(!zettelkastenMobileCollapsed));
    collapse.textContent=zettelkastenMobileCollapsed ? '» Zettelkasten' : '« Zettelkasten';
    collapse.setAttribute('aria-label',zettelkastenMobileCollapsed ? 'Expand Zettelkasten on mobile' : 'Collapse Zettelkasten on mobile');
    collapse.title=collapse.getAttribute('aria-label');
  }
  if(close){close.style.display='inline-flex';}
}
export function collapseZettelkastenMobile(){
  if(!zettelkastenMobileViewport()) return;
  setZettelkastenMobileCollapsed(true,true);
}
export function expandZettelkastenMobile(){
  if(!zettelkastenMobileViewport()) return;
  setZettelkastenMobileCollapsed(false,true);
}
function closeZettelkastenMobile(){
  if(typeof hideZettelkastenView==='function') hideZettelkastenView();
  var page=document.getElementById('page-view');
  if(page) page.classList.add('visible');
}
function wireZettelkastenMobile(){
  loadZettelkastenMobilePreference();
  var collapse=document.getElementById('zettelkasten-mobile-collapse');
  var close=document.getElementById('zettelkasten-mobile-close');
  var reopen=document.getElementById('zettelkasten-mobile-reopen');
  var backdrop=document.getElementById('zettelkasten-mobile-backdrop');
  if(collapse) collapse.addEventListener('click',function(){
    if(zettelkastenMobileCollapsed) expandZettelkastenMobile(); else collapseZettelkastenMobile();
  });
  if(close) close.addEventListener('click',closeZettelkastenMobile);
  if(reopen) reopen.addEventListener('click',expandZettelkastenMobile);
  if(backdrop) backdrop.addEventListener('click',collapseZettelkastenMobile);
  window.addEventListener('resize',function(){ applyZettelkastenMobileMode(); });
  window.addEventListener('orientationchange',function(){ setTimeout(applyZettelkastenMobileMode,0); });
  window.addEventListener('pageshow',function(){ applyZettelkastenMobileMode(); });
  applyZettelkastenMobileMode();
}
if(typeof document!=='undefined'&&document.addEventListener) document.addEventListener('DOMContentLoaded',wireZettelkastenMobile);

/* Classic-script bridge: 28-zettelkasten.js calls these two directly as bare
   globals, same as it would call any other file's function in this project
   -- and it can't `import` them, since it isn't a module itself. A module's
   own top-level declarations don't auto-attach to `window` the way a
   classic script's do, so without this they'd simply be undefined from the
   caller's side despite being correctly exported. This explicit bridge is
   exactly the shape every other converted file would need until enough of
   its callers are also modules to talk in real imports instead. */
if(typeof window!=='undefined'){
  window.applyZettelkastenMobileMode=applyZettelkastenMobileMode;
  window.clearZettelkastenMobileVisualState=clearZettelkastenMobileVisualState;
}
