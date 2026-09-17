/* ============================================================
 * 13-wiring-and-init.js
 * Event wiring for all UI controls, plus app initialization/boot sequence and global error handlers. MUST load last.
 *
 * Part of Nexus — loaded as a plain <script> (not a module) in
 * index.html, in numeric filename order. All files share one global
 * scope on purpose (same as the original single-file build), so
 * `state`, helper functions, etc. declared in an earlier file are
 * directly usable here without imports.
 * ============================================================ */
"use strict";

/* ============================================================
   WIRING
   ============================================================ */
document.getElementById('btn-today').onclick = goToday;
document.getElementById('btn-help').onclick = function(){ openPageByTitle(DOCS_TITLE, 'page'); };
document.getElementById('btn-new-page').onclick = openPalette;
document.getElementById('btn-graph').onclick = function(){
  document.getElementById('page-view').classList.remove('visible');
  document.getElementById('graph-view').classList.add('visible');
  renderGraph();
  if(typeof closeSidebarIfNarrow === 'function') closeSidebarIfNarrow();
};
document.getElementById('btn-close-graph').onclick = function(){
  document.getElementById('graph-view').classList.remove('visible');
  document.getElementById('page-view').classList.add('visible');
};
document.getElementById('btn-insert-query').onclick = function(){ openQueryBuilder('query', null, ''); };
/* .link/.tag clicks inside block content are handled per-row (see
   renderBlockRow); properties and backlinks live outside that tree,
   so they get their own small delegated listener here. */
['properties','backlinks'].forEach(function(containerId){
  document.getElementById(containerId).addEventListener('click', function(e){
    var t = e.target;
    if(t.classList && t.classList.contains('link')){ openPageByTitle(t.dataset.target, 'page'); return; }
    if(t.classList && t.classList.contains('tag')){ openPageByTitle(t.dataset.tag, 'tag'); return; }
  });
});
document.getElementById('btn-insert-table').onclick = function(){ openQueryBuilder('table', null, ''); };
document.getElementById('btn-insert-code').onclick = insertCodeBlockSpecial;
document.getElementById('btn-nav-back').onclick = goBack;
document.getElementById('btn-nav-forward').onclick = goForward;
document.getElementById('btn-undo').onclick = performUndo;
document.getElementById('btn-redo').onclick = performRedo;
document.getElementById('btn-delete-page').onclick = deleteCurrentPage;
document.getElementById('btn-doc-mode').onclick = function(){
  var page = state.pages[state.currentPageId];
  if(!page) return;
  page.viewMode = page.viewMode === 'doc' ? 'outline' : 'doc';
  save(); renderPage();
};
document.getElementById('empty-trash-btn').onclick = emptyTrash;
document.getElementById('trash-restore-btn').onclick = function(){ restorePage(state.currentPageId); };
document.getElementById('trash-delete-forever-btn').onclick = function(){ permanentlyDeletePage(state.currentPageId); };
document.getElementById('add-prop').onclick = function(){
  var page = state.pages[state.currentPageId];
  if(!page) return;
  if(!Array.isArray(page.properties)) page.properties = [];
  page.properties.push({key:'property', value:'', type:'text'});
  save(); renderProperties(page);
};
document.getElementById('add-root-block').onclick = function(){
  var page = state.pages[state.currentPageId];
  var id = uid();
  var nb;
  if(zoomedBlockId && state.blocks[zoomedBlockId] && state.blocks[zoomedBlockId].pageId === page.id){
    /* While zoomed, "add a line" should land inside the zoomed
       block — appending to page.rootBlocks would add it outside
       the current view, where it wouldn't be visible. */
    var parentBlk = state.blocks[zoomedBlockId];
    nb = mkBlock(id, page.id, parentBlk.id, "");
    state.blocks[id] = nb;
    parentBlk.children.push(id);
  } else {
    nb = mkBlock(id, page.id, null, "");
    state.blocks[id] = nb;
    page.rootBlocks.push(id);
  }
  save(); renderPage();
  focusBlock(id, 0);
};
document.getElementById('toggle-daily').onclick = function(){
  state.dailyShowAll = !state.dailyShowAll;
  renderSidebar(document.getElementById('search-box').value);
};
document.getElementById('search-box').addEventListener('input', function(e){
  renderSidebar(e.target.value);
});
document.getElementById('btn-find-replace').onclick = openFindReplace;
document.getElementById('fr-cancel').onclick = closeFindReplace;
document.getElementById('findreplace-overlay').addEventListener('click', function(e){
  if(e.target.id === 'findreplace-overlay') closeFindReplace();
});
document.getElementById('fr-find').addEventListener('input', updateFrPreview);
document.getElementById('fr-case').addEventListener('change', updateFrPreview);
document.getElementById('fr-apply').onclick = applyFindReplace;
document.getElementById('btn-backup').onclick = backup;
document.getElementById('btn-backup-gdrive').onclick = gdriveStartExport;
document.getElementById('btn-gdrive-sync-now').onclick = gdriveSyncNow;
document.getElementById('btn-restore-gdrive').onclick = gdriveStartImport;
document.getElementById('btn-restore').onclick = function(){
  document.getElementById('restore-input').click();
};
document.getElementById('restore-input').addEventListener('change', function(e){
  if(e.target.files && e.target.files[0]) restoreFromFile(e.target.files[0]);
  e.target.value = "";
});
document.getElementById('btn-export-md').onclick = exportPageAsMarkdown;
document.getElementById('btn-import-md').onclick = function(){
  document.getElementById('import-md-input').click();
};
document.getElementById('import-md-input').addEventListener('change', function(e){
  if(e.target.files && e.target.files.length) importMarkdownFiles(e.target.files);
  e.target.value = "";
});
document.getElementById('btn-export-pdf').onclick = exportPageAsPdf;
document.getElementById('new-template-btn').onclick = saveCurrentPageAsTemplate;
document.getElementById('refresh-attachments-btn').onclick = renderAttachmentsSection;
document.getElementById('btn-install-app').onclick = function(){
  if(!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  deferredInstallPrompt.userChoice.then(function(){ deferredInstallPrompt = null; });
  document.getElementById('btn-install-app').style.display = 'none';
};
document.getElementById('btn-download-sw').onclick = downloadServiceWorkerFile;

var titleEl = document.getElementById('page-title');
titleEl.addEventListener('blur', function(){
  if(!state || !state.pages || !state.pages[state.currentPageId]) return;
  var page = state.pages[state.currentPageId];
  var newTitle = titleEl.textContent.trim() || 'Untitled';
  if(newTitle !== page.title){
    delete state.titleIndex[page.title.toLowerCase()];
    renameCascade(page.title, newTitle);
    page.title = newTitle;
    state.titleIndex[newTitle.toLowerCase()] = page.id;
    save();
    renderAll();
  }
});
titleEl.addEventListener('keydown', function(e){
  if(e.key === 'Enter'){ e.preventDefault(); titleEl.blur();
    var page = state.pages[state.currentPageId];
    if(page.rootBlocks.length){ focusBlock(page.rootBlocks[0], 0); }
  }
});

document.addEventListener('keydown', function(e){
  if(appLocked) return; /* notebook shortcuts are inert while the lock screen is up */
  var isMod = e.metaKey || e.ctrlKey;
  if((e.key === 'k' || e.key === 'K') && isMod){
    e.preventDefault();
    openPalette();
  } else if(e.key === 'Escape'){
    closePalette();
    closeVersions();
    closeVersionDiff();
    closeSettings();
    closeFindReplace();
    closeSyncModal();
    closeQueryBuilder();
    closeBlockMenu();
    if(zoomedBlockId) zoomOut();
  } else if(isMod && (e.key === 'z' || e.key === 'Z')){
    /* While actively typing in a contentEditable field, defer to the
       browser's own native undo/redo for that field instead of jumping
       a whole app-level action — our undo is for committed actions. */
    if(document.activeElement && document.activeElement.isContentEditable) return;
    e.preventDefault();
    if(e.shiftKey) performRedo(); else performUndo();
  } else if(isMod && !e.shiftKey && (e.key === 'y' || e.key === 'Y')){
    if(document.activeElement && document.activeElement.isContentEditable) return;
    e.preventDefault();
    performRedo();
  }
});

window.addEventListener('beforeunload', flushSaveNow);
document.addEventListener('visibilitychange', function(){
  if(document.hidden) flushSaveNow();
});

/* ============================================================
   INIT
   Notebook load is async now (IndexedDB), so everything that reads
   `state` waits on initNotebook() resolving first.
   ============================================================ */
function bootNotebook(){
  document.getElementById('page-view').classList.add('visible');
  initNotebook().then(function(){
    renderAll();
    pushHistory(state.currentPageId);
    maybeAutoSnapshot();
    updateBackupBanner();
    updateUndoRedoButtons();
    updateConflictsBadge();
    registerPwa();
    renderAttachmentsSection();
    maybeRunAutoBackup();
    setInterval(maybeRunAutoBackup, 30*60*1000); /* catch up roughly twice an hour while the app stays open */
    handleIncomingShare();
    checkTodoDueReminders();
    setGdriveAutoSyncToggleUI();
    if(gdriveAutoSyncEnabled()){
      /* Reconnecting after a reload can only ever be silent (prompt:'') —
         there's no server here to hold a refresh token — so if Google's
         session has lapsed this just asks for one click rather than
         popping a sign-in window unprompted. */
      gdriveGetTokenSilently(function(){
        startGdriveAutoSyncTimer();
        runGdriveSyncCycle();
      }, function(){
        setGdriveAutoSyncStatus('Needs sign-in — open Settings and click "On" again to reconnect.');
      });
    }
  }).catch(function(){
    toast('Could not load your notebook — try reloading the page.');
  });
}

document.addEventListener('visibilitychange', function(){
  if(!document.hidden) runGdriveSyncCycle();
});

if(isLockEnabled()){
  showLockScreen(); /* bootNotebook() runs once attemptUnlockFromScreen() succeeds */
} else {
  bootNotebook();
}

/* Production-style safety net: surface unexpected runtime failures instead
   of leaving the editor apparently frozen with no explanation. */
window.addEventListener('error', function(e){
  try{ console.error('Nexus runtime error:', e.error || e.message); }catch(ignore){}
  if(typeof toast === 'function') toast('Nexus hit an unexpected error. Your last saved state is still protected.');
});
window.addEventListener('unhandledrejection', function(e){
  try{ console.error('Nexus promise rejection:', e.reason); }catch(ignore){}
});

