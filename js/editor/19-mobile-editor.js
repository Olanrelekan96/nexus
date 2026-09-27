/* ============================================================
 * 19-mobile-editor.js
 * Phone/tablet behavior for the editor: the on-screen keyboard,
 * the docked edit bar, keeping the caret in view, and the sidebar
 * button in each view's top bar.
 *
 * Part of Nexus — loaded as a plain <script> (not a module) in
 * index.html. Purely additive: everything here is event-driven off
 * the DOM and does nothing on a desktop with a mouse, apart from
 * setting a couple of harmless CSS variables.
 *
 * The problem this solves: on a phone, opening the keyboard shrinks
 * only the *visual* viewport. Fixed/sticky UI keeps positioning
 * itself against the full-height layout viewport, so anything pinned
 * to the bottom — the formatting bar — ends up behind the keyboard,
 * and the line being typed into can too. The visual viewport API
 * reports where the keyboard actually is, so this keeps three things
 * in step with it:
 *   --kb-inset   how far up from the bottom the edit bar must sit
 *   --vv-h       the height the app should be while the keyboard is up
 *   html.kb-open / html.is-editing   state hooks for the CSS
 * ============================================================ */
"use strict";

(function(){
  var root = document.documentElement;
  var vv = window.visualViewport || null;
  var KB_MIN_PX = 100; /* smaller shrinks are browser chrome, not a keyboard */
  var lastKb = 0;

  function pinchZoomed(){ return !!vv && vv.scale > 1.01; }

  /* ---- Keyboard / visual viewport ---- */
  function updateViewportVars(){
    if(!vv) return;
    if(pinchZoomed()) return; /* zooming in also shrinks the visual viewport — that isn't a keyboard */
    var kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    var open = kb > KB_MIN_PX;
    root.style.setProperty('--kb-inset', (open ? kb : 0) + 'px');
    root.style.setProperty('--vv-h', Math.round(vv.height) + 'px');
    root.classList.toggle('kb-open', open);
    /* iOS pans the whole page up to reveal a focused field, which drags
       the top bar out of sight. The app already resizes to fit above the
       keyboard (see --vv-h), so put the page back at the top. */
    if(open && (window.scrollY || vv.offsetTop)) window.scrollTo(0, 0);
    if(open !== (lastKb > KB_MIN_PX)) scheduleCaretCheck();
    lastKb = open ? kb : 0;
  }
  if(vv){
    vv.addEventListener('resize', updateViewportVars);
    vv.addEventListener('scroll', updateViewportVars);
  }
  window.addEventListener('orientationchange', function(){ setTimeout(updateViewportVars, 250); });
  updateViewportVars();

  /* ---- "Is a line being edited?" -> shows the docked edit bar ----
     Debounced because re-rendering the page (Enter, indent, move…)
     blurs one line and focuses the next a beat later; without this the
     bar would flicker away and back on every keystroke that splits a
     line. */
  var editTimer = null;
  function syncEditingClass(){
    var ae = document.activeElement;
    var on = !!(ae && ae.classList && ae.classList.contains('block-content') && ae.classList.contains('editing'));
    root.classList.toggle('is-editing', on);
    if(on) scheduleCaretCheck();
  }
  function scheduleEditingSync(){
    clearTimeout(editTimer);
    editTimer = setTimeout(syncEditingClass, 60);
  }
  document.addEventListener('focusin', scheduleEditingSync);
  document.addEventListener('focusout', scheduleEditingSync);

  /* Tapping the bar's own padding or a disabled button must not steal
     focus from the line (which would close the keyboard and the bar). */
  var dock = document.getElementById('edit-dock');
  if(dock){
    dock.addEventListener('mousedown', function(e){
      if(e.target && e.target.tagName === 'INPUT') return;
      e.preventDefault();
    });
  }

  /* ---- Keep the caret above the keyboard and the edit bar ---- */
  function caretRect(el){
    var sel = window.getSelection();
    if(sel && sel.rangeCount && el.contains(sel.anchorNode)){
      var r = sel.getRangeAt(0).cloneRange();
      r.collapse(false);
      var rects = r.getClientRects();
      if(rects.length) return rects[rects.length - 1];
      var b = r.getBoundingClientRect();
      if(b && (b.width || b.height)) return b;
    }
    return el.getBoundingClientRect(); /* empty line: no caret rect to measure */
  }

  var caretRaf = 0;
  function scheduleCaretCheck(){
    if(caretRaf) return;
    caretRaf = requestAnimationFrame(function(){ caretRaf = 0; ensureCaretVisible(); });
  }
  function ensureCaretVisible(){
    if(!root.classList.contains('is-editing')) return;
    var el = document.querySelector('.block-content.editing');
    var main = document.getElementById('main');
    if(!el || !main) return;
    var sel = window.getSelection();
    /* Leave range selections alone — the native selection handles do
       their own edge-scrolling and fighting them makes dragging jumpy. */
    if(sel && sel.rangeCount && !sel.isCollapsed) return;

    var mainRect = main.getBoundingClientRect();
    var vp = usableViewport();
    var topbar = document.querySelector('#page-view .topbar');
    var topbarH = topbar ? topbar.getBoundingClientRect().height : 0;
    var topLimit = Math.max(mainRect.top, vp.top) + Math.min(topbarH, 64) + 8;
    var bottomLimit = Math.min(mainRect.bottom, vp.bottom) - 12;
    var rect = caretRect(el);
    if(rect.bottom > bottomLimit){
      main.scrollTop += rect.bottom - bottomLimit;
    } else if(rect.top < topLimit){
      main.scrollTop -= topLimit - rect.top;
    }
  }
  /* selectionchange fires for every caret move (typing, arrow keys,
     tapping elsewhere in the line), which is exactly when the caret can
     drift under the keyboard. */
  document.addEventListener('selectionchange', function(){
    if(root.classList.contains('is-editing')) scheduleCaretCheck();
  });

  /* ---- Sidebar button in each view's top bar ---- */
  document.addEventListener('click', function(e){
    var btn = e.target && e.target.closest ? e.target.closest('.topbar-menu-btn') : null;
    if(!btn) return;
    if(typeof setSidebarCollapsed === 'function') setSidebarCollapsed(false);
  });
})();
