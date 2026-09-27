/* ============================================================
 * 30-zettelkasten-mobile.js
 * Mobile-only Zettelkasten drawer/collapse state.
 *
 * The Zettelkasten hub is independent from the main navigation sidebar:
 * this module never changes `sidebar-collapsed`. On phone/tablet widths,
 * the hub becomes an off-canvas drawer over the editor/content area.
 * The user's collapsed/expanded preference is persisted locally and survives
 * navigation and reloads. Desktop keeps the normal full-workspace behavior.
 * ============================================================ */
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
function clearZettelkastenMobileVisualState(){
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
function applyZettelkastenMobileMode(){
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
function collapseZettelkastenMobile(){
  if(!zettelkastenMobileViewport()) return;
  setZettelkastenMobileCollapsed(true,true);
}
function expandZettelkastenMobile(){
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
