/* ============================================================
 * 13a-locks-and-sidebar.js
 * Three small additions that the "⋯" menu and every right-click
 * menu hang off:
 *
 *   1. Page locks    — page.locked makes a page read-only: the title
 *                      stops being editable, no line on it can be
 *                      opened for editing, and the destructive items
 *                      in every menu grey out.
 *   2. Block locks   — block.locked does the same for one line and
 *                      everything nested under it.
 *   3. Sidebar visibility — page.hidden takes a page out of the
 *                      sidebar lists without trashing it. It stays
 *                      searchable, linkable and open-able; it just
 *                      isn't in the Pages/Daily/Tags lists any more,
 *                      and appears under "Hidden" so it can be put
 *                      back.
 *
 * These are all plain flags on existing objects, so they survive
 * save()/backup/sync with no format change: an older build simply
 * ignores fields it doesn't know about.
 *
 * Loaded as a plain <script> after 13-slash-and-context-menus.js and
 * before 14-wiring-and-init.js. Shares the one global scope, same as
 * every other file here.
 * ============================================================ */
"use strict";

/* ============================================================
   READ-ONLY CHECKS
   Everything that could mutate a line funnels through these two, so
   there is one answer to "may this be edited?" rather than one per
   call site.
   ============================================================ */

function pageIsLocked(pageId){
  var page = state && state.pages ? state.pages[pageId] : null;
  return !!(page && page.locked);
}

/* A line is locked if it says so, if any line it's nested under says
   so, or if its page does. The walk is bounded by the tree depth and
   guarded against a malformed parent cycle. */
function blockIsLocked(block){
  if(!block) return false;
  if(pageIsLocked(block.pageId)) return true;
  var cur = block, hops = 0;
  while(cur && hops < 500){
    if(cur.locked) return true;
    cur = cur.parent ? state.blocks[cur.parent] : null;
    hops++;
  }
  return false;
}

/* True when this line is locked only because something above it is —
   used to explain why "Unlock" isn't offered on the line itself. */
function blockLockedByAncestor(block){
  return !!(block && !block.locked && blockIsLocked(block));
}

function lockedNudge(block){
  if(block && pageIsLocked(block.pageId)){
    toast('This page is locked. Unlock it to edit — right-click the page title.');
  } else if(blockLockedByAncestor(block)){
    toast('A line above this one is locked, so this one is read-only too.');
  } else {
    toast('This line is locked. Unlock it from its ⋯ menu to edit.');
  }
}

/* ============================================================
   TOGGLES
   ============================================================ */

function togglePageLock(pageId){
  var page = state.pages[pageId];
  if(!page) return;
  if(page.locked){
    delete page.locked;
  } else {
    page.locked = true;
    /* Anything mid-edit on this page must be committed and closed,
       or its contenteditable would stay live behind the lock. */
    var editingEl = document.querySelector('.block-content.editing');
    if(editingEl) editingEl.blur();
    editingBlockId = null;
  }
  save();
  renderAll();
  toast(page.locked
    ? '"' + page.title + '" is locked — it\'s read-only until you unlock it.'
    : '"' + page.title + '" is unlocked.');
}

function toggleBlockLock(blockId){
  var b = state.blocks[blockId];
  if(!b) return;
  if(b.locked){
    delete b.locked;
  } else {
    b.locked = true;
    if(editingBlockId === blockId){
      var editingEl = document.querySelector('.block-content.editing');
      if(editingEl) editingEl.blur();
      editingBlockId = null;
    }
  }
  save();
  renderPage();
  toast(b.locked
    ? 'Line locked — it and anything nested under it are read-only.'
    : 'Line unlocked.');
}

/* ============================================================
   SIDEBAR VISIBILITY
   ============================================================ */

function togglePageHidden(pageId){
  var page = state.pages[pageId];
  if(!page) return;
  if((typeof isPermanentDatabasePage === 'function' && isPermanentDatabasePage(page)) || (typeof isPermanentQueryPage === 'function' && isPermanentQueryPage(page)) || (typeof isPermanentStickyNotesPage === 'function' && isPermanentStickyNotesPage(page))){ toast(isPermanentQueryPage && isPermanentQueryPage(page) ? 'The default Queries workspace always stays available in the sidebar.' : 'The default Database workspace always stays available in the sidebar.'); return; }
  if(page.hidden){
    delete page.hidden;
  } else {
    page.hidden = true;
    delete page.pinned; /* a hidden page in the Pinned list would defeat the point */
  }
  save();
  renderAll();
  toast(page.hidden
    ? '"' + page.title + '" removed from the sidebar — still searchable, and listed under Hidden.'
    : '"' + page.title + '" is back in the sidebar.');
}

function hiddenPages(){
  return livePages().filter(function(p){ return !!p.hidden; })
    .sort(function(a,b){ return a.title.localeCompare(b.title); });
}

/* Mirrors renderTrashSection: a section that only exists while there
   is something in it, with a one-click way back out. */
function renderHiddenSection(){
  var section = document.getElementById('hidden-section');
  var ul = document.getElementById('list-hidden');
  if(!section || !ul) return;
  var list = hiddenPages();
  ul.innerHTML = '';
  if(!list.length){ section.style.display = 'none'; return; }
  section.style.display = '';
  list.forEach(function(p){
    var li = document.createElement('li');
    var row = document.createElement('div');
    row.className = 'trash-row';
    row.dataset.pageId = p.id; /* so the right-click page menu works on it too */
    var a = document.createElement('a');
    a.href = 'javascript:void(0)';
    a.textContent = (p.type === 'tag' ? '#' : '') + p.title + (p.locked ? ' 🔒' : '');
    a.title = 'Hidden from the sidebar lists — click to open';
    if(p.id === state.currentPageId) a.className = 'active';
    a.onclick = function(){ openPage(p.id); };
    var showBtn = document.createElement('button');
    showBtn.type = 'button';
    showBtn.title = 'Show in the sidebar again';
    showBtn.textContent = '↺';
    showBtn.setAttribute('aria-label', 'Show "' + p.title + '" in the sidebar again');
    showBtn.onclick = function(e){ e.stopPropagation(); togglePageHidden(p.id); };
    row.appendChild(a);
    row.appendChild(showBtn);
    li.appendChild(row);
    ul.appendChild(li);
  });
}
