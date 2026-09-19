/* ============================================================
 * 08-edit-dock-attachments.js
 * The docked WYSIWYG toolbar and image/file attachment handling.
 *
 * Part of Nexus — loaded as a plain <script> (not a module) in
 * index.html, in numeric filename order. All files share one global
 * scope on purpose (same as the original single-file build), so
 * `state`, helper functions, etc. declared in an earlier file are
 * directly usable here without imports.
 * ============================================================ */
"use strict";

/* ============================================================
   EDIT DOCK (docked WYSIWYG toolbar + indent tab, sits above the
   outline — replaces the old floating selection popup so touch/
   mobile users have a fixed target instead of hover-only controls)
   ============================================================ */
document.getElementById('dock-blocktype').onclick = function(){
  toast('Only "Text" lines are available right now.');
};

Array.prototype.slice.call(document.querySelectorAll('.dock-fmt-btn')).forEach(function(btn){
  /* preventDefault on mousedown keeps the block's contenteditable
     focused (and its selection intact) instead of blurring it when
     the dock button is tapped — mirrors the old floating toolbar. */
  btn.addEventListener('mousedown', function(e){ e.preventDefault(); });
  btn.addEventListener('click', function(){
    var editingEl = document.querySelector('.block-content.editing');
    if(!editingEl) return;
    if(btn.dataset.tag === 'link'){ applyLinkFormat(editingEl); }
    else { applyInlineFormat(editingEl, btn.dataset.tag); }
  });
});

document.getElementById('dock-indent-btn').addEventListener('mousedown', function(e){ e.preventDefault(); });
document.getElementById('dock-outdent-btn').addEventListener('mousedown', function(e){ e.preventDefault(); });
document.getElementById('dock-copysync-btn').addEventListener('mousedown', function(e){ e.preventDefault(); });
document.getElementById('dock-highlight-btn').addEventListener('mousedown', function(e){ e.preventDefault(); });
document.getElementById('dock-color-btn').addEventListener('mousedown', function(e){ e.preventDefault(); });

/* Highlighter and text-color both need a live text selection to act
   on — unlike Bold/Italic/etc. there's no sensible "toggle at the
   caret" behavior for a 12-way choice, so an empty selection just
   points the person at what to do instead of silently no-opping. */
function openDockSwatchPopover(kind){
  var editingEl = document.querySelector('.block-content.editing');
  if(!editingEl){ toast('Tap a line first, then select some text.'); return; }
  var sel = window.getSelection();
  if(!sel.rangeCount || sel.isCollapsed){ toast('Select some text first.'); return; }
  var rect = sel.getRangeAt(0).getBoundingClientRect();
  var btn = document.getElementById(kind === 'mark' ? 'dock-highlight-btn' : 'dock-color-btn');
  var anchorRect = (rect && (rect.width || rect.height)) ? rect : btn.getBoundingClientRect();
  openSwatchPopover(anchorRect.left, anchorRect.bottom + 6, editingEl, kind);
}
document.getElementById('dock-highlight-btn').onclick = function(){ openDockSwatchPopover('mark'); };
document.getElementById('dock-color-btn').onclick = function(){ openDockSwatchPopover('clr'); };

document.getElementById('dock-indent-btn').onclick = function(e){
  e.preventDefault();
  var b = dockBlockId ? state.blocks[dockBlockId] : null;
  if(b) doIndent(b);
};
document.getElementById('dock-outdent-btn').onclick = function(e){
  e.preventDefault();
  var b = dockBlockId ? state.blocks[dockBlockId] : null;
  if(b) doOutdent(b);
};
document.getElementById('dock-up-btn').addEventListener('mousedown', function(e){ e.preventDefault(); });
document.getElementById('dock-down-btn').addEventListener('mousedown', function(e){ e.preventDefault(); });
document.getElementById('dock-done-btn').addEventListener('mousedown', function(e){ e.preventDefault(); });
document.getElementById('dock-up-btn').onclick = function(e){
  e.preventDefault();
  var b = dockBlockId ? state.blocks[dockBlockId] : null;
  if(b) doMoveBlock(b, -1);
};
document.getElementById('dock-down-btn').onclick = function(e){
  e.preventDefault();
  var b = dockBlockId ? state.blocks[dockBlockId] : null;
  if(b) doMoveBlock(b, 1);
};
/* "Done" — the phone equivalent of clicking away: commits the line and
   lets the keyboard drop. Tapping empty page space doesn't do it on
   iOS/Android, since a non-focusable area doesn't take focus away. */
document.getElementById('dock-done-btn').onclick = function(e){
  e.preventDefault();
  var el = document.querySelector('.block-content.editing');
  if(el) el.blur();
  else if(document.activeElement && document.activeElement.blur) document.activeElement.blur();
};
document.getElementById('dock-copysync-btn').onclick = function(e){
  e.preventDefault();
  if(!dockBlockId){ toast('Tap a line first, then copy its reference.'); return; }
  copyToClipboard('((' + dockBlockId + '))');
  toast('Block reference copied — paste it anywhere to sync this line.');
};

/* ============================================================
   ATTACHMENTS (images & files)
   Binary data never touches localStorage (or the state object that
   Sync/backup/undo work with directly) — it's kept in IndexedDB,
   addressed by id. Block text only ever holds a lightweight
   {{img:ID|name}} / {{file:ID|name}} reference (see parseAttRef and
   friends above), so state stays small and JSON-serializable exactly
   as before. Three places need to know about the real bytes:
     - Backup/export: bundled in as base64 under __attachments (see
       buildBackupJson / restoreFromFile) so a .json export is self-
       contained and restoring it on any device brings images back.
     - Sync: deliberately NOT included. The relay message is the plain
       state object, so a synced device gets the {{img:ID|...}}
       reference but not the bytes — if that id isn't already in its
       own IndexedDB, the image/file renders as "not on this device"
       until it's added there too (e.g. via a shared backup file).
     - Undo/version history: also not touched — reverting text just
       changes which reference is present, it never deletes the
       underlying blob, so undoing a paste can't destroy the file.
   ============================================================ */
var ATT_DB_NAME = "nexus_attachments";
var ATT_STORE = "files";
var NB_STORE = "notebook"; /* the live notebook itself — see NOTEBOOK PERSISTENCE below */
var attDbPromise = null;
var attObjectUrlCache = {}; /* attId -> blob: URL string, or 'missing' */

function openAttachmentDb(){
  if(attDbPromise) return attDbPromise;
  attDbPromise = new Promise(function(resolve, reject){
    // v2 added the "versions" object store (see snapshotVersion) so that
    // full-notebook version snapshots share IndexedDB's much higher
    // ceiling instead of localStorage's ~5-10MB budget.
    // v3 adds the "notebook" object store, moving the live notebook
    // itself off localStorage for the same reason. Existing users
    // upgrading from an earlier version keep everything they already
    // have untouched; onupgradeneeded only adds whichever stores are
    // still missing.
    var req = indexedDB.open(ATT_DB_NAME, 4);
    req.onupgradeneeded = function(){
      var db = req.result;
      if(!db.objectStoreNames.contains(ATT_STORE)) db.createObjectStore(ATT_STORE, {keyPath:'id'});
      if(!db.objectStoreNames.contains(VERS_STORE)) db.createObjectStore(VERS_STORE, {keyPath:'ts'});
      if(!db.objectStoreNames.contains(NB_STORE)) db.createObjectStore(NB_STORE);
      /* v4 adds the device-local security store used when
         "Request passcode on launch" is turned off. The stored value is a
         non-exportable CryptoKey, never part of backups/sync, and is valid
         only until the normal re-entry deadline. */
      if(!db.objectStoreNames.contains('security')) db.createObjectStore('security');
    };
    // Fires if another tab still has an older DB version open — the
    // upgrade (and therefore this promise) waits for that tab to close
    // or release its connection. This used to only stall attachments;
    // now the notebook load waits on the same promise too, so surface
    // it instead of hanging silently (see the watchdog in initNotebook).
    req.onblocked = function(){
      toast('Waiting on another open Nexus tab to finish updating storage — close it to continue.');
    };
    req.onsuccess = function(){ resolve(req.result); };
    req.onerror = function(){ reject(req.error); };
  });
  return attDbPromise;
}
