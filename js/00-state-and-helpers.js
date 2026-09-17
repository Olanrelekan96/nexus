/* ============================================================
 * 00-state-and-helpers.js
 * Core state model, undo/redo, sync merge logic, and small shared helpers used everywhere else.
 *
 * Part of Nexus — loaded as a plain <script> (not a module) in
 * index.html, in numeric filename order. All files share one global
 * scope on purpose (same as the original single-file build), so
 * `state`, helper functions, etc. declared in an earlier file are
 * directly usable here without imports.
 * ============================================================ */
"use strict";

/* ============================================================
   STORAGE / STATE
   ============================================================ */
var STORAGE_KEY = "nexus_pkm_v1";
var appLocked = false; /* true whenever the lock screen is covering the app — guards global keyboard shortcuts */

function uid(){ return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2,8); }

function seedState(){
  var welcomeId = uid(), b1=uid(), b2=uid(), b3=uid(), b4=uid(), b5=uid(), b6=uid(), b7=uid(), b8=uid(), b9=uid(), b10=uid(), b11=uid();
  var state = {
    pages: {},
    blocks: {},
    titleIndex: {},
    currentPageId: null,
    dailyShowAll: false,
    tombstones: {pages:{}, blocks:{}},
    deviceId: uid(),
    templates: {}
  };
  state.pages[welcomeId] = {
    id: welcomeId, title:"Welcome to Nexus", type:"page", createdAt:Date.now(),
    properties:[{key:"status", value:"start here"}], rootBlocks:[b1,b2,b3,b4,b5,b6,b7,b8,b9,b10,b11]
  };
  state.blocks[b1] = mkBlock(b1, welcomeId, null, "Nexus is your own offline knowledge base — pages, an outliner, and #backlinks in one file.");
  state.blocks[b2] = mkBlock(b2, welcomeId, null, "Type [[Page Name]] to link to (or create) another page — try clicking [[Project Ideas]].");
  state.blocks[b3] = mkBlock(b3, welcomeId, null, "Type #tags anywhere to build a tag index automatically, like #reference.");
  state.blocks[b4] = mkBlock(b4, welcomeId, null, "Press Tab to indent, Shift+Tab to outdent, Enter for a new line, ⌘K to jump anywhere.");
  state.blocks[b5] = mkBlock(b5, welcomeId, null, "Everything lives in your browser's local storage — nothing leaves your device.");
  state.blocks[b6] = mkBlock(b6, welcomeId, null, "Use Backup to save a .json file, and Restore to bring it back on any device.");
  state.blocks[b7] = mkBlock(b7, welcomeId, null, "Try **bold**, *italic*, ~~strikethrough~~ or `code` — they render live as you type, or select text and use the popup toolbar / ⌘B, ⌘I, ⌘⇧X, ⌘E.");
  state.blocks[b8] = mkBlock(b8, welcomeId, null, "A whole line can also become a live query or database — use the sidebar buttons, or type it yourself. Filters can mix #tags, [[Page links]], key:value properties and plain words; matches update automatically as you edit.");
  state.blocks[b9] = mkBlock(b9, welcomeId, null, "{{query: #reference}}");
  state.blocks[b10] = mkBlock(b10, welcomeId, null, "{{table: }}");
  state.blocks[b11] = mkBlock(b11, welcomeId, null, "Hover any line and click ⚭ to copy its block reference, then paste it anywhere as ((id)) — it stays perfectly in sync, like this: ((" + b1 + "))");
  state.titleIndex["welcome to nexus"] = welcomeId;
  state.currentPageId = welcomeId;
  return state;
}

function mkBlock(id, pageId, parent, text){
  return {id:id, pageId:pageId, parent:parent||null, text:text||"", children:[], collapsed:false};
}

var DOCS_TITLE = "Help & Tutorial";

/* Creates the built-in documentation page the first time it's needed —
   for brand-new notebooks and for anyone upgrading from an older version
   of Nexus that didn't have it yet. Never touches it again once it
   exists, so the user's own edits are always preserved. */
function ensureDocsPage(){
  if(state.titleIndex[DOCS_TITLE.toLowerCase()] && state.pages[state.titleIndex[DOCS_TITLE.toLowerCase()]]) return;

  var pid = uid();
  state.pages[pid] = {
    id: pid, title: DOCS_TITLE, type: 'page', createdAt: Date.now(),
    properties: [{key:"status", value:"reference"}], rootBlocks: []
  };
  state.titleIndex[DOCS_TITLE.toLowerCase()] = pid;

  function section(headerText, childTexts){
    var hid = uid();
    state.blocks[hid] = mkBlock(hid, pid, null, "**"+headerText+"**");
    state.pages[pid].rootBlocks.push(hid);
    childTexts.forEach(function(t){
      var cid = uid();
      state.blocks[cid] = mkBlock(cid, pid, hid, t);
      state.blocks[hid].children.push(cid);
    });
  }

  section("Getting started", [
    "This page is a living reference for everything Nexus can do — feel free to edit it, reorganize it, or delete it entirely; it's just a normal page.",
    "Skim the bold headers below for a quick overview, or read start to finish as a full tutorial."
  ]);

  section("Pages & daily notes", [
    "Click ＋ New page in the sidebar, or press ⌘K and type a name that doesn't exist yet, to create a page instantly.",
    "📅 Today's note opens (or creates) a daily journal page titled with today's date — a good default place to jot things down.",
    "Rename a page any time by editing its title at the top of the page; every [[link]] pointing to it updates automatically.",
    "Delete page removes the page and every line on it — this can't be undone, so it asks you to confirm first."
  ]);

  section("The outliner", [
    "Every line on a page is a block. Press Enter to create a new block right below the current one.",
    "Tab indents a block underneath the one above it; Shift+Tab outdents it back out. The ← → arrows that appear when you hover a line do the same thing.",
    "Click the small triangle or dot to the left of a line to collapse or expand its children. On a heading, collapsing also folds every line after it up to the next heading of the same or a higher level — like folding a section in a document.",
    "Backspace at the very start of a line merges it into the line above; the ↑ and ↓ arrow keys move the cursor between lines.",
    "Hover a line to reveal a ⠿ handle at its far left — drag it above or below another line to reorder, or drag it onto the middle of a line to nest it as that line's child."
  ]);

  section("Formatting text", [
    "Select any text while editing to reveal a small popup toolbar for Bold, Italic, Strikethrough and Code.",
    "Or use keyboard shortcuts: ⌘B bold, ⌘I italic, ⌘⇧X strikethrough, ⌘E code.",
    "You can also just type **bold**, *italic*, ~~strike~~ or `code` — the markers turn into real formatting live, the instant you finish typing the closing symbol."
  ]);

  section("Headings", [
    "Type # through ###### at the start of a line for an H1–H6 heading, sized and weighted like Markdown headings.",
    "Or hover a line and click the H button in its controls — it cycles H1 → H2 → H3 → plain text.",
    "Collapsing a heading folds its section (see \"The outliner\" above), so a whole part of a page can be tucked away with one click."
  ]);

  section("To-do checkboxes", [
    "Hover any line and click the ☐ button in its controls to turn it into a to-do — no typing required. Click it again to remove the checkbox.",
    "Click the checkbox itself to mark it done; the text gets a strikethrough. Click it again to mark it not done.",
    "Typing [ ] or [x] at the very start of a line does the same thing, if you prefer typing to clicking."
  ]);

  section("Links between pages", [
    "Type [[Page Name]] to link to another page. If that page doesn't exist yet, it's created the moment you finish typing it.",
    "Click any link to jump straight to that page."
  ]);

  section("Tags", [
    "Type #tagname anywhere in a line to tag it. Tags work like pages — each one gets its own page and shows up under Tags in the sidebar.",
    "Use tags to group related notes across your whole notebook, e.g. #project, #reading, #idea."
  ]);

  section("Linked references (backlinks)", [
    "Scroll to the bottom of any page to see \"Linked references\" — every line anywhere else in your notebook that mentions this page or tag, grouped by where it was written."
  ]);

  section("Properties", [
    "Click ＋ Add property, just under a page's title, to attach structured key: value metadata — for example status: in progress or author: Jane.",
    "Hover a property row to reveal a small type menu (Text, Number, Date, Checkbox, Select, Multi-select, Relation, Rollup) next to the key, and a ✕ for deleting the row.",
    "Number gives you a numeric field, Date a real date picker, Checkbox a tickbox, and Select/Multi-select suggest values already used elsewhere for that property so you stay consistent instead of retyping variants.",
    "Relation links this page to other pages by title — its chips are clickable, and any page it points at lists this one back under Related pages, below Linked references.",
    "Rollup is read-only: pick one of this page's own Relation properties, a property to pull from each page it points to, and how to combine them (list, count, sum, average, min, max) — it recalculates the instant any property changes in this notebook, not just when you reopen the page.",
    "Properties are what power {{table: ...}} database views, described below."
  ]);

  section("Command palette", [
    "Press ⌘K anywhere (or click ＋ New page) to open a fast jump-to-or-create palette.",
    "Type to filter, use ↑ ↓ to move, Enter to open or create, Esc to close."
  ]);

  section("Graph view", [
    "Click ◎ Graph view in the sidebar to see every page and tag laid out as a connected network, built automatically from your [[links]] and #tags."
  ]);

  section("Tasks view", [
    "Click ☑ Tasks in the sidebar to see every to-do across your whole notebook in one flat list, not just the current page.",
    "Tick a checkbox, change a due date, or click a page name to jump straight to that line \u2014 all update the same underlying line, exactly like checking it off on its own page.",
    "Filter by text or page name, hide finished ones, and sort by due date or by page.",
    "On any to-do, click 📅+ (or an existing 📅 date chip) to set or change a due date \u2014 stored right on the line as !due(YYYY-MM-DD). Anything due today or overdue gets a one-time reminder toast when you open Nexus."
  ]);

  section("Live queries", [
    "Click ⌕ Insert query in the sidebar to open a point-and-click filter builder — pick a tag, page, property, or word from dropdowns, no typing filter syntax required.",
    "Every filter row must be satisfied, and a live count updates as you build. Set a row to \"is not\" to exclude matches, or type several comma-separated values in one row to match any of them (e.g. tags urgent, important matches either).",
    "Click Insert and it becomes a live, auto-updating list of every matching line in your notebook.",
    "Click any existing query to reopen the same builder pre-filled with its filters. A small ✎ raw link in its corner still lets you type the underlying {{query: ...}} syntax by hand — e.g. -#done or #urgent|important — if you prefer."
  ]);

  section("Database views", [
    "Click ▤ Insert database in the sidebar to open the same builder for pages instead of lines — the result lists every matching page as a table, using each page's properties as columns, a lightweight always-current database with no code involved.",
    "The builder also has View, Sort, and Columns controls: switch to Board to group pages into columns by a property (like a kanban board), or Gallery for a card grid; sort by title or any property, ascending or descending; and optionally pick exactly which properties show up instead of showing every one used.",
    "Click an existing database view to reopen the builder pre-filled with its filters and view settings, or use its ✎ raw link to edit the {{table: view:board group:status sort:-due cols:status,due ...}} text directly."
  ]);

  section("Block sync (block references)", [
    "Hover any line and click the ⚭ button to copy a reference to it, then paste ((that id)) into any other line — it will embed that block's live content right there.",
    "Because the embed reads the very same block, editing it anywhere — the original or any embed — updates every copy of it instantly.",
    "A small number badge next to a line's bullet shows how many other places it's currently synced with."
  ]);

  section("Search & navigation", [
    "Use the search box at the top of the sidebar to filter your pages, daily notes, and tags by title as you type.",
    "It also searches the actual content of every line — matches show up in a \"Matching lines\" section beneath Tags, with a snippet and the page they're on. Click one to jump straight to it.",
    "Press ⌘K to open the command palette — it searches page titles and line content together, so you can jump to a specific line from anywhere, not just a page.",
    "Use ⇄ Find & replace in the sidebar footer to swap text across every line in your whole notebook at once. It takes an automatic snapshot first, so you can always undo it from Version history."
  ]);

  section("Images & files", [
    "Click a line to select it, then use the 📎 button in the toolbar above the outline to attach an image or any other file — it's inserted right where your cursor was.",
    "Images show inline; other files show as a small chip you can click to open or download. Click an image to open it full-size in a new tab.",
    "Attachments are stored separately from your notes (in the browser's IndexedDB, not the same small localStorage space text uses), so a handful of photos won't eat into the notes-storage budget shown in the sidebar footer — though large files still add up, and everything is still local to this browser.",
    "Deleting the {{img:…}} or {{file:…}} reference from a line removes it from view but doesn't delete the underlying file — that trade-off is what keeps Undo and Version history safe (reverting text can never destroy a file you attached earlier)."
  ]);

  section("Backup, restore & version history", [
    "Backup (export) saves your whole notebook — including every attached image and file — as a single .json file — keep a copy somewhere safe.",
    "In browsers that support it (Chrome, Edge, Opera), Backup opens a native Save As dialog so you can choose exactly which folder and filename to use. Other browsers save to your usual downloads location instead.",
    "Restore (import) loads a previously exported file back in, replacing what's currently here and restoring any attachments it contains; a safety snapshot is taken automatically right before it does.",
    "Version history keeps automatic snapshots (roughly daily, plus one before every restore) so you can recover from a mistake. These snapshots cover your notes; attached files aren't duplicated into each snapshot, since the reference-not-bytes design above means they don't need to be."
  ]);

  section("Privacy & storage", [
    "Everything lives locally in your browser's storage — notes, attached images, and files all in IndexedDB. If you set up Sync, your notes are sent directly to another device over your local network — nothing is relayed through an external server. The sidebar footer shows roughly how much space each is using.",
    "Back up regularly regardless — especially before clearing browser data, switching browsers, or moving to a new device. Backup is also currently the only way to move attachments to another device, since Sync intentionally carries only text (see Sync, below)."
  ]);

  section("Sync (local network, live pairing)", [
    "Sync devices in the sidebar connects two devices directly over your local network using WebRTC — no relay server, no STUN/TURN server, nothing external is ever contacted, not even to set up the connection.",
    "Because there's no server to hold a message for an offline device, both devices need the Sync dialog open at the same time to pair, and a pairing doesn't survive a page reload — you'll re-pair (copy/paste two short codes) each time you want to sync this way. Once connected it stays open and syncs live until either side closes the app.",
    "New or edited lines merge in automatically while connected; editing the same line on two devices before they've synced keeps whichever edit happened most recently. Deleting a page or line propagates the deletion too.",
    "Sync carries text only, not attached images or files — a synced device gets the reference to an attachment but not its bytes, and shows \"not available on this device\" until that file is added there directly (e.g. by restoring a Backup that contains it).",
    "Sync is separate from Backup — Backup makes a snapshot file you can restore anytime; Sync converges two devices' notebooks live, only while both are connected."
  ]);

  section("Undo & redo", [
    "↶ Undo and ↷ Redo in the top bar (or ⌘Z / ⌘⇧Z) step back and forward through completed actions — edits, indents, deletes, property changes, even restoring a backup.",
    "While you're actively typing inside a line, ⌘Z uses your browser's normal in-field undo instead; once you've moved on from that line, ⌘Z reaches back through Nexus's own history.",
    "Undo history lives only in memory for the current browser tab — it resets on reload. For anything you want to recover after closing Nexus, use Version history instead."
  ]);

  section("Shortcuts, quick reference", [
    "⌘K — command palette · ⌘Z / ⌘⇧Z — undo / redo · ⌘B / ⌘I / ⌘E / ⌘⇧X — bold / italic / code / strikethrough",
    "Tab / Shift+Tab — indent / outdent · Enter — new line · Backspace at start of line — merge up",
    "⌘B (with sidebar focused) or « / ☰ — collapse or expand the sidebar · Esc — close any open dialog"
  ]);

  save();
}

/* Seeds two starter templates ("Meeting notes" and "Daily journal") the
   first time a notebook is opened, so Templates is immediately useful
   rather than an empty list. Guarded by templatesSeeded (not by
   checking for an empty template list) so deleting the defaults later
   doesn't bring them back. */
function ensureDefaultTemplates(){
  if(state.templatesSeeded) return;
  state.templatesSeeded = true;

  var meetingId = uid();
  state.templates[meetingId] = {
    id: meetingId, name: "Meeting notes", createdAt: Date.now(),
    blocks: [
      {text:"**Attendees:** ", children:[]},
      {text:"**Agenda**", children:[{text:"", children:[]}]},
      {text:"**Notes**", children:[{text:"", children:[]}]},
      {text:"**Action items**", children:[{text:"Owner — ", children:[]}]}
    ]
  };

  var dailyId = uid();
  state.templates[dailyId] = {
    id: dailyId, name: "Daily journal", createdAt: Date.now(),
    blocks: [
      {text:"**Focus for today**", children:[{text:"", children:[]}]},
      {text:"**Log**", children:[{text:"", children:[]}]},
      {text:"**Gratitude / notes**", children:[{text:"", children:[]}]}
    ]
  };

  save();
}

/* Undo/redo bookkeeping vars are declared up front (before state is
   loaded/seeded) so they're already initialized if ensureDocsPage()
   below triggers an early save() while seeding a brand-new notebook. */
var undoStack = [];
var redoStack = [];
var UNDO_MAX = 100;
var lastSnapshotJson = null;

var state = null; /* populated asynchronously by initNotebook(), called at the bottom of this
                      file, before renderAll() and anything else that reads state runs */
function initNotebook(){
  // If openAttachmentDb() is stuck (see onblocked above), the user would
  // otherwise just see a permanently blank page-view with no feedback.
  // This doesn't abandon the real load — it only surfaces a hint while
  // still waiting on the same promise underneath.
  var warnTimer = setTimeout(function(){
    toast('Still loading your notebook — if this hangs, try closing other Nexus tabs.');
  }, 4000);
  return loadAsync().then(function(loaded){
    clearTimeout(warnTimer);
    state = loaded;
    ensureDocsPage();
    ensureDefaultTemplates();
    ensureSyncMeta();
    lastSnapshotJson = JSON.stringify(state); /* baseline so the very first edit is undoable */
  });
}

/* Guarantees every page/block has updatedAt/updatedBy timestamps and that
   tombstones/deviceId exist, even for notebooks created before Sync existed.
   Only fills in missing values — never overwrites real edit timestamps. */
function ensureSyncMeta(){
  if(!state.tombstones) state.tombstones = {pages:{}, blocks:{}};
  if(!state.tombstones.pages) state.tombstones.pages = {};
  if(!state.tombstones.blocks) state.tombstones.blocks = {};
  if(!state.deviceId) state.deviceId = uid();
  var now = Date.now();
  Object.keys(state.pages).forEach(function(id){
    var p = state.pages[id];
    if(!p.createdAt) p.createdAt = now;
    if(!p.updatedAt){ p.updatedAt = p.createdAt; p.updatedBy = state.deviceId; }
  });
  Object.keys(state.blocks).forEach(function(id){
    var b = state.blocks[id];
    if(!b.updatedAt){ b.updatedAt = now; b.updatedBy = state.deviceId; }
  });
}

function normalizeState(parsed){
  if(!parsed || typeof parsed !== 'object' || !parsed.pages || typeof parsed.pages !== 'object' ||
     !parsed.blocks || typeof parsed.blocks !== 'object') return seedState();

  /* Backups and older versions can legitimately omit newer fields. Normalize
     them here so every load/restore/history path receives the same shape. */
  if(parsed.dailyShowAll === undefined) parsed.dailyShowAll = false;
  if(!parsed.tombstones || typeof parsed.tombstones !== 'object') parsed.tombstones = {pages:{}, blocks:{}};
  if(!parsed.tombstones.pages || typeof parsed.tombstones.pages !== 'object') parsed.tombstones.pages = {};
  if(!parsed.tombstones.blocks || typeof parsed.tombstones.blocks !== 'object') parsed.tombstones.blocks = {};
  if(!parsed.templates || typeof parsed.templates !== 'object') parsed.templates = {};
  if(!parsed.syncPeers || typeof parsed.syncPeers !== 'object' || Array.isArray(parsed.syncPeers)) parsed.syncPeers = {};
  if(!parsed.deviceId) parsed.deviceId = uid();

  Object.keys(parsed.pages).forEach(function(id){
    var page = parsed.pages[id];
    if(!page || typeof page !== 'object'){
      delete parsed.pages[id];
      return;
    }
    page.id = page.id || id;
    page.title = String(page.title == null ? 'Untitled' : page.title);
    page.type = page.type || 'page';
    page.properties = Array.isArray(page.properties) ? page.properties : [];
    page.rootBlocks = Array.isArray(page.rootBlocks) ? page.rootBlocks : [];
  });

  Object.keys(parsed.blocks).forEach(function(id){
    var block = parsed.blocks[id];
    if(!block || typeof block !== 'object'){
      delete parsed.blocks[id];
      return;
    }
    block.id = block.id || id;
    block.pageId = block.pageId || '';
    block.text = String(block.text == null ? '' : block.text);
    block.children = Array.isArray(block.children) ? block.children.filter(function(cid){
      return !!parsed.blocks[cid];
    }) : [];
    if(block.parent === undefined) block.parent = null;
    if(block.collapsed === undefined) block.collapsed = false;
  });

  /* Never trust a persisted title index: renames/restores from older builds
     can leave it stale. Rebuilding is cheap compared with a broken link. */
  parsed.titleIndex = rebuildTitleIndex(parsed);

  var pageIds = Object.keys(parsed.pages);
  var fallbackPageId = pageIds.length ? pageIds[0] : '';

  /* Reject malformed cross-links from imported backups or remote peers.
     Every block must belong to a real page, and parent links must remain
     inside the same page. Cycles are broken at the repeated edge so a
     hostile/corrupt graph can never make recursive renderers loop forever. */
  Object.keys(parsed.blocks).forEach(function(id){
    var block = parsed.blocks[id];
    if(!block.pageId || !parsed.pages[block.pageId]) block.pageId = fallbackPageId;
    if(block.parent && (!parsed.blocks[block.parent] || parsed.blocks[block.parent].pageId !== block.pageId)){
      block.parent = null;
    }
  });
  Object.keys(parsed.blocks).forEach(function(id){
    var seen = {};
    var cur = id;
    while(cur && parsed.blocks[cur]){
      if(seen[cur]){ parsed.blocks[id].parent = null; break; }
      seen[cur] = true;
      var next = parsed.blocks[cur].parent;
      if(next && (!parsed.blocks[next] || parsed.blocks[next].pageId !== parsed.blocks[cur].pageId)){
        parsed.blocks[cur].parent = null;
        break;
      }
      cur = next;
    }
  });

  /* Children/root arrays are derived data. Rebuild them from the validated
     parent links while preserving the existing sibling ordering where it
     is available. */
  var oldRootOrder = {};
  Object.keys(parsed.pages).forEach(function(pid){
    oldRootOrder[pid] = Array.isArray(parsed.pages[pid].rootBlocks) ? parsed.pages[pid].rootBlocks.slice() : [];
    parsed.pages[pid].rootBlocks = [];
  });
  var oldChildOrder = {};
  Object.keys(parsed.blocks).forEach(function(id){
    oldChildOrder[id] = Array.isArray(parsed.blocks[id].children) ? parsed.blocks[id].children.slice() : [];
    parsed.blocks[id].children = [];
  });

  var placed = {};
  function placeBlock(id){
    if(placed[id] || !parsed.blocks[id]) return;
    placed[id] = true;
    var b = parsed.blocks[id];
    if(b.parent && parsed.blocks[b.parent]) parsed.blocks[b.parent].children.push(id);
    else if(parsed.pages[b.pageId]) parsed.pages[b.pageId].rootBlocks.push(id);
  }
  pageIds.forEach(function(pid){ oldRootOrder[pid].forEach(placeBlock); });
  Object.keys(oldChildOrder).forEach(function(pid){ oldChildOrder[pid].forEach(placeBlock); });
  Object.keys(parsed.blocks).forEach(placeBlock);

  if(!parsed.currentPageId || !parsed.pages[parsed.currentPageId]){
    parsed.currentPageId = pageIds.length ? pageIds[0] : null;
  }
  return parsed;
}

function parseLoadedState(raw){
  try{
    return normalizeState(JSON.parse(raw));
  }catch(e){ return seedState(); }
}

/* Loads the notebook from IndexedDB. The very first time a returning
   user hits this after upgrading, NB_STORE will be empty but their
   notebook may still be sitting in localStorage under STORAGE_KEY from
   before this migration — if so, that copy is imported into IndexedDB
   once and then cleared out of localStorage. New/empty notebooks fall
   through to seedState(). Returns a Promise<state object>. */
function loadAsync(){
  return getNotebookState().then(function(raw){
    if(raw) return parseLoadedState(raw);
    var legacy = null;
    try{ legacy = localStorage.getItem(STORAGE_KEY); }catch(e){}
    if(!legacy) return seedState();
    return putNotebookState(legacy).then(function(){
      try{ localStorage.removeItem(STORAGE_KEY); }catch(e){}
      return parseLoadedState(legacy);
    }).catch(function(){ return parseLoadedState(legacy); });
  }).catch(function(){ return seedState(); });
}

function rebuildTitleIndex(s){
  var idx = {};
  Object.keys(s.pages).forEach(function(id){
    var page = s.pages[id];
    if(page && !page.trashedAt && page.title){
      idx[page.title.toLowerCase()] = id;
    }
  });
  return idx;
}

var saveTimer = null;
var persistQueue = Promise.resolve();
var suppressBroadcast = false; /* true while applying a state we just received from a peer, so we don't echo it straight back out */
function enqueueNotebookPersist(json){
  /* Serialize all IndexedDB writes. Encryption is async, so without a queue
     an older save can finish after a newer one and overwrite it on disk. */
  persistQueue = persistQueue.catch(function(){}).then(function(){ return putNotebookState(json); });
  return persistQueue;
}
function save(options){
  options = options || {};
  if(options.touchEntities !== false) touchChangedEntities();
  if(options.recordUndo !== false) recordUndoCheckpoint();
  var doBroadcast = !suppressBroadcast && options.broadcast !== false;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function(){
    var json = JSON.stringify(state);
    enqueueNotebookPersist(json).then(function(){
      updateStorageHint();
      if(doBroadcast) broadcastStateToPeers();
    }).catch(function(){ toast("Could not save — storage may be full."); });
  }, 150);
}
/* Best-effort, non-debounced flush used when the page is about to go
   away (backgrounded, closed, reloaded). IndexedDB writes are async, so
   unlike the old synchronous localStorage.setItem this can't guarantee
   completion before unload — but browsers generally keep an
   already-started IndexedDB transaction alive briefly after unload, and
   pairing 'visibilitychange' (fires reliably on tab switch / mobile
   backgrounding) with 'beforeunload' minimizes the risk window given the
   debounce above is only 150ms anyway. */
function flushSaveNow(){
  clearTimeout(saveTimer);
  var json;
  try{ json = JSON.stringify(state); }catch(e){ return; }

  /* IndexedDB is still the primary store. For an unlocked, unencrypted
     notebook, keep a short-lived synchronous emergency snapshot so a tab
     killed during the async transaction can recover the last state. Never
     create a plaintext fallback when passcode protection is enabled. */
  if(!isLockEnabled()){
    try{
      if(json.length <= 4 * 1024 * 1024) localStorage.setItem(STORAGE_KEY, json);
    }catch(e){}
  }
  try{
    enqueueNotebookPersist(json).then(function(){
      if(!isLockEnabled()){
        try{ localStorage.removeItem(STORAGE_KEY); }catch(e){}
      }
    }).catch(function(){});
  }catch(e){}
}

/* Compares the state as it stood before this action (lastSnapshotJson) to
   the state as it stands now, and stamps updatedAt/updatedBy on anything
   that changed, plus records a tombstone for anything that was deleted.
   This is the only place these get stamped, so every mutation path in the
   app — text edits, indent/outdent, property edits, deletes, restores —
   is covered automatically without needing to touch each one individually.
   These timestamps are what Sync uses to merge two devices' notebooks. */
function shallowFieldsChanged(oldObj, newObj, fields){
  if(!oldObj) return true;
  for(var i=0;i<fields.length;i++){
    var f = fields[i];
    if(JSON.stringify(oldObj[f]) !== JSON.stringify(newObj[f])) return true;
  }
  return false;
}
function touchChangedEntities(){
  if(!state.tombstones) state.tombstones = {pages:{}, blocks:{}};
  if(!state.deviceId) state.deviceId = uid();
  var prev = null;
  if(lastSnapshotJson){ try{ prev = JSON.parse(lastSnapshotJson); }catch(e){} }
  var prevPages = (prev && prev.pages) || {};
  var prevBlocks = (prev && prev.blocks) || {};
  var now = Date.now();

  Object.keys(state.pages).forEach(function(id){
    var cur = state.pages[id];
    if(shallowFieldsChanged(prevPages[id], cur, ['title','type','properties','trashedAt','rootBlocks'])){
      cur.updatedAt = now; cur.updatedBy = state.deviceId;
    }
    if(!cur.createdAt) cur.createdAt = now;
  });
  Object.keys(prevPages).forEach(function(id){
    if(!state.pages[id]) state.tombstones.pages[id] = now;
  });

  Object.keys(state.blocks).forEach(function(id){
    var cur = state.blocks[id];
    if(shallowFieldsChanged(prevBlocks[id], cur, ['text','parent','collapsed','pageId','children'])){
      cur.updatedAt = now; cur.updatedBy = state.deviceId;
    }
  });
  Object.keys(prevBlocks).forEach(function(id){
    if(!state.blocks[id]) state.tombstones.blocks[id] = now;
  });
}

/* ============================================================
   UNDO / REDO
   Every call to save() marks the end of one discrete, completed
   action (a committed edit, an indent, a delete, a restore, etc —
   save() is never called mid-keystroke). So each save() is exactly
   the right granularity for a checkpoint: right before it runs,
   state already reflects the new, post-action value, and
   lastSnapshotJson still holds the value from before this action.
   In-memory only — undo history does not persist across reloads.
   ============================================================ */
function recordUndoCheckpoint(){
  var json = JSON.stringify(state);
  if(lastSnapshotJson !== null && lastSnapshotJson !== json){
    undoStack.push(lastSnapshotJson);
    if(undoStack.length > UNDO_MAX) undoStack.shift();
    redoStack.length = 0;
  }
  lastSnapshotJson = json;
  updateUndoRedoButtons();
}

function applyHistoryState(json){
  try{
    state = normalizeState(JSON.parse(json));
  }catch(e){ toast('That history entry could not be read.'); return; }
  /* Undo/redo is itself a real local mutation. Restamp changed entities so
     the resulting state participates in LWW sync instead of losing to a
     peer simply because the history snapshot carried old timestamps. */
  touchChangedEntities();
  var persistedJson = JSON.stringify(state);
  lastSnapshotJson = persistedJson;
  editingBlockId = null;
  dockBlockId = null;
  enqueueNotebookPersist(persistedJson).catch(function(){});
  updateStorageHint();
  renderAll();
  updateUndoRedoButtons();
}

function performUndo(){
  if(!undoStack.length) return;
  redoStack.push(JSON.stringify(state));
  applyHistoryState(undoStack.pop());
  toast('Undone.');
}

function performRedo(){
  if(!redoStack.length) return;
  undoStack.push(JSON.stringify(state));
  applyHistoryState(redoStack.pop());
  toast('Redone.');
}

function updateUndoRedoButtons(){
  var u = document.getElementById('btn-undo');
  var r = document.getElementById('btn-redo');
  if(u) u.disabled = !undoStack.length;
  if(r) r.disabled = !redoStack.length;
}

/* The notebook now lives in IndexedDB (disk-sized headroom) rather than
   localStorage's ~5-10MB ceiling, so this is a generous, rarely-hit
   sanity threshold rather than a real capacity warning. */
var ASSUMED_CAP_KB = 500000;
function updateStorageHint(){
  var kb = Math.round((JSON.stringify(state).length)/1024);
  var pct = Math.min(100, Math.round((kb/ASSUMED_CAP_KB)*100));
  var el = document.getElementById('storage-hint');
  var sizeText = kb >= 1024 ? (kb/1024).toFixed(1) + ' MB' : kb + ' KB';
  var baseText = sizeText + " of notes stored on-device";
  el.textContent = baseText;
  el.classList.toggle('warn', pct >= 70);
  Promise.all([
    listAllAttachments().catch(function(){ return []; }),
    loadVersions().catch(function(){ return []; })
  ]).then(function(results){
    var records = results[0], versions = results[1];
    var extra = [];
    if(records.length){
      var totalBytes = records.reduce(function(sum, r){ return sum + (r.size||0); }, 0);
      var mb = totalBytes/1024/1024;
      var sizeText = mb >= 1 ? mb.toFixed(1) + ' MB' : Math.round(totalBytes/1024) + ' KB';
      extra.push(records.length + ' attachment' + (records.length===1?'':'s') + ' (' + sizeText + ')');
    }
    if(versions.length){
      var vBytes = versions.reduce(function(sum, v){ return sum + (v.data ? v.data.length : (v.ct ? v.ct.length : 0)); }, 0);
      var vMb = vBytes/1024/1024;
      var vSizeText = vMb >= 1 ? vMb.toFixed(1) + ' MB' : Math.round(vBytes/1024) + ' KB';
      extra.push(versions.length + ' version snapshot' + (versions.length===1?'':'s') + ' (' + vSizeText + ')');
    }
    if(extra.length) el.textContent = baseText + ' · ' + extra.join(' · ') + ' in separate on-device storage';
  });
}

/* ============================================================
   SYNC — MERGE LOGIC
   Two notebooks are merged field-by-field using last-writer-wins on
   each page/block's updatedAt (ties broken by deviceId), plus
   tombstones so deletions propagate instead of resurrecting. Sibling
   order isn't timestamped per-move — it's simply re-derived from
   whichever copy of each block wins, read off that device's current
   arrays at the moment it was sent. That means a pure reorder (with no
   text/indent change) on two devices between syncs may not merge
   perfectly, but every edit, delete, and structural move is preserved.
   ============================================================ */
function deriveOrder(s){
  Object.keys(s.pages).forEach(function(pid){
    (s.pages[pid].rootBlocks||[]).forEach(function(id,i){ if(s.blocks[id]) s.blocks[id].order = i; });
  });
  Object.keys(s.blocks).forEach(function(bid){
    (s.blocks[bid].children||[]).forEach(function(id,i){ if(s.blocks[id]) s.blocks[id].order = i; });
  });
}

function mergeTombstoneMaps(a, b){
  var out = {};
  Object.keys(a||{}).forEach(function(k){ out[k] = a[k]; });
  Object.keys(b||{}).forEach(function(k){ out[k] = out[k] ? Math.max(out[k], b[k]) : b[k]; });
  return out;
}

/* Templates carry no updatedAt and aren't tombstoned (they're simple
   named snippets, not edited in place after creation), so — unlike
   pages/blocks — there's no last-writer-wins to compute. Merging is a
   straightforward union by id: whatever either device has, both end up
   with. Trade-off: a template deleted on one device while it still
   exists on the other will reappear after a sync. That mirrors the
   existing behavior for templates in general (no delete-tracking), it's
   just now visible across devices too instead of only within one. */
function mergeTemplateMaps(a, b){
  var out = {};
  Object.keys(a||{}).forEach(function(k){ out[k] = a[k]; });
  Object.keys(b||{}).forEach(function(k){ if(!out[k]) out[k] = b[k]; });
  return out;
}

/* Picks whichever of two copies of the same entity is newer. Ties (equal
   updatedAt, e.g. both untouched since a common ancestor) are broken by
   deviceId so both sides of a sync compute the identical winner. */
function pickWinner(a, b){
  if(a && !b) return a;
  if(b && !a) return b;
  if(!a && !b) return null;
  var ta = a.updatedAt||a.createdAt||0, tb = b.updatedAt||b.createdAt||0;
  if(ta !== tb) return ta > tb ? a : b;
  var da = a.updatedBy||"", db = b.updatedBy||"";
  return da <= db ? a : b;
}

/* sinceTs is the timestamp of the last successful sync with this
   specific peer (null on the very first ever sync with them). A
   genuine conflict — both sides edited the same page/line differently
   since they last talked to each other — is only flagged when both
   copies were touched after that point; otherwise "the peer has an
   edit I don't" is just normal catching-up, not a conflict. Returns
   {state, conflicts} — conflicts is a plain list for the caller to
   log and surface, kept separate from the synced state itself so the
   conflict record stays local to this device instead of propagating. */
function mergeStates(local, remote, sinceTs){
  deriveOrder(local);
  deriveOrder(remote);
  var merged = {
    pages:{}, blocks:{}, titleIndex:{},
    tombstones:{
      pages: mergeTombstoneMaps(local.tombstones && local.tombstones.pages, remote.tombstones && remote.tombstones.pages),
      blocks: mergeTombstoneMaps(local.tombstones && local.tombstones.blocks, remote.tombstones && remote.tombstones.blocks)
    },
    templates: JSON.parse(JSON.stringify(mergeTemplateMaps(local.templates, remote.templates))),
    templatesSeeded: !!(local.templatesSeeded || remote.templatesSeeded),
    currentPageId: local.currentPageId,
    dailyShowAll: local.dailyShowAll,
    deviceId: local.deviceId,
    /* Sync cursors are local relationship metadata. Never import the
       remote device's view of its peers into this device. */
    syncPeers: JSON.parse(JSON.stringify(local.syncPeers || {}))
  };
  var conflicts = [];

  var pageIds = Object.keys(local.pages).concat(Object.keys(remote.pages)).filter(function(id,i,arr){ return arr.indexOf(id)===i; });
  pageIds.forEach(function(id){
    var la = local.pages[id], ra = remote.pages[id];
    var winner = pickWinner(la, ra);
    var delAt = merged.tombstones.pages[id];
    if(delAt && (!winner || delAt >= (winner.updatedAt||0))) return;
    if(winner) merged.pages[id] = JSON.parse(JSON.stringify(winner));
    if(sinceTs && la && ra && la.title !== ra.title &&
       (la.updatedAt||0) > sinceTs && (ra.updatedAt||0) > sinceTs){
      var loserP = (winner === la) ? ra : la;
      conflicts.push({
        kind:'page', entityId:id, pageId:id, pageTitle: winner.title,
        keptText: winner.title, droppedText: loserP.title,
        keptBy: winner.updatedBy, droppedBy: loserP.updatedBy,
        keptAt: winner.updatedAt, droppedAt: loserP.updatedAt
      });
    }
  });

  var blockIds = Object.keys(local.blocks).concat(Object.keys(remote.blocks)).filter(function(id,i,arr){ return arr.indexOf(id)===i; });
  blockIds.forEach(function(id){
    var la = local.blocks[id], ra = remote.blocks[id];
    var winner = pickWinner(la, ra);
    var delAt = merged.tombstones.blocks[id];
    if(delAt && (!winner || delAt >= (winner.updatedAt||0))) return;
    if(winner && merged.pages[winner.pageId]) merged.blocks[id] = JSON.parse(JSON.stringify(winner));
    if(sinceTs && la && ra && la.text !== ra.text &&
       (la.updatedAt||0) > sinceTs && (ra.updatedAt||0) > sinceTs && merged.blocks[id]){
      var loserB = (winner === la) ? ra : la;
      var pg = merged.pages[winner.pageId];
      merged.blocks[id].conflict = {droppedText: loserB.text, droppedBy: loserB.updatedBy, droppedAt: loserB.updatedAt, at: Date.now()};
      conflicts.push({
        kind:'line', entityId:id, pageId: winner.pageId, pageTitle: pg ? pg.title : '(unknown page)',
        keptText: winner.text, droppedText: loserB.text,
        keptBy: winner.updatedBy, droppedBy: loserB.updatedBy,
        keptAt: winner.updatedAt, droppedAt: loserB.updatedAt
      });
    }
  });

  /* Rebuild rootBlocks/children purely from parent + order — the arrays
     on the winning copies are stale the moment they're mixed with blocks
     from the other side, so they're discarded and recomputed here. */
  Object.keys(merged.pages).forEach(function(pid){ merged.pages[pid].rootBlocks = []; });
  Object.keys(merged.blocks).forEach(function(bid){ merged.blocks[bid].children = []; });
  var allBlocks = Object.keys(merged.blocks).map(function(id){ return merged.blocks[id]; });
  allBlocks.sort(function(x,y){ return (x.order||0)-(y.order||0) || (x.id<y.id?-1:1); });
  allBlocks.forEach(function(b){
    if(b.parent && merged.blocks[b.parent]){
      merged.blocks[b.parent].children.push(b.id);
    } else if(merged.pages[b.pageId]){
      b.parent = null;
      merged.pages[b.pageId].rootBlocks.push(b.id);
    }
  });

  merged.titleIndex = rebuildTitleIndex(merged);
  if(!merged.currentPageId || !merged.pages[merged.currentPageId]){
    merged.currentPageId = Object.keys(merged.pages)[0];
  }
  return {state: merged, conflicts: conflicts};
}

/* Applies a merge result as the new live state: persists it, pushes an
   undo checkpoint, and re-renders — without re-broadcasting it right back
   out to whichever peer we just got it from (see suppressBroadcast). */
function applyIncomingMerge(merged){
  if(state.pages[state.currentPageId] && merged.pages[state.currentPageId]){
    merged.currentPageId = state.currentPageId; /* stay on whatever page the user is looking at */
  }
  editingBlockId = null;
  dockBlockId = null;
  state = merged;
  suppressBroadcast = true;
  /* Remote entities already carry their authoritative updatedAt/updatedBy.
     Persist the merge without pretending those changes were made locally. */
  save({touchEntities:false});
  suppressBroadcast = false;
  renderAll();
}

/* ============================================================
   HELPERS
   ============================================================ */
/* Escapes everything HTML needs escaped, including quotes — this string
   is used both as element text content and inside double-quoted HTML
   attributes (data-target="...", title="...", etc.) in decorateText()
   below, so a stray " or ' in user text must not be able to break out
   of an attribute and inject markup/attributes of its own. */
function escapeHtml(str){
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

var INLINE_PATTERN = /\[\[([^\]]+)\]\]|#([a-zA-Z0-9_][\w-]*)|\(\(([a-zA-Z0-9_-]+)\)\)|\*\*([^*]+)\*\*|~~([^~]+)~~|`([^`]+)`|\*([^*\s][^*]*)\*|\{\{img:([a-zA-Z0-9_-]+\|[^}]*)\}\}|\{\{file:([a-zA-Z0-9_-]+\|[^}]*)\}\}|\{\{mark:([a-z]+)\|([^}]*)\}\}|%%color:([a-z]+)\|([^%]*)%%/g;
var BLOCKREF_MAX_DEPTH = 4;

/* ============================================================
   HIGHLIGHTER (background) & TEXT COLOR
   Twelve named colors, shared by both — a background highlight
   ({{mark:key|text}}, rendered as <mark class="hl-swatch">) and a
   text color (%%color:key|text%%, rendered as <span class="clr-swatch">)
   are otherwise independent and can be nested on the same run of text.
   The two use different delimiters on purpose, not just for variety:
   this regex has no way to match balanced *nested* {{...}}, so if both
   used curly braces, highlighting an already-colored run would corrupt
   on the next render (the outer tag's content can't contain the
   inner's closing "}}"). Percent signs for color sidestep that the
   same way this file already lets, say, ~~strike~~ nest inside
   **bold** — cross-family nesting works as long as the delimiters
   don't collide; same-family nesting (bold-in-bold, highlight-in-
   highlight) doesn't, here as everywhere else in this file.
   Kept alongside INLINE_PATTERN because the color keys have to match
   the `[a-z]+` groups in that regex — anything added here only needs
   a lowercase-letters key to work everywhere else for free.
   ============================================================ */
var SWATCH_COLORS = [
  ['yellow','Yellow'], ['orange','Orange'], ['red','Red'], ['pink','Pink'],
  ['purple','Purple'], ['indigo','Indigo'], ['blue','Blue'], ['teal','Teal'],
  ['green','Green'], ['lime','Lime'], ['gray','Gray'], ['brown','Brown']
];



/* Attachments (images & files) are stored as blobs in IndexedDB, keyed by
   id, and referenced inline in block text as {{img:ID|filename}} or
   {{file:ID|filename}} — the same way ((blockId)) references a block.
   Only the reference travels with the notebook (JSON export, Sync); the
   actual bytes live in IndexedDB on whichever device added them. See the
   ATTACHMENTS section below for storage, hydration, and the backup path
   that carries the real bytes in and out of a .json export. */
function parseAttRef(raw){
  var idx = raw.indexOf('|');
  if(idx < 0) return {id: raw, name: ''};
  return {id: raw.slice(0, idx), name: raw.slice(idx+1)};
}
function renderImageHtml(raw){
  var parsed = parseAttRef(raw);
  return '<span class="att-img" data-att-id="'+escapeHtml(parsed.id)+'" data-att-name="'+escapeHtml(parsed.name)+'">'
    + '<img class="att-img-el" data-att-id="'+escapeHtml(parsed.id)+'" alt="'+escapeHtml(parsed.name||'image')+'">'
    + '</span>';
}
function renderFileHtml(raw){
  var parsed = parseAttRef(raw);
  return '<span class="att-file" data-att-id="'+escapeHtml(parsed.id)+'" data-att-name="'+escapeHtml(parsed.name)+'">'
    + '<span class="att-file-icon">📎</span>'
    + '<a class="att-file-link" data-att-id="'+escapeHtml(parsed.id)+'" href="#" target="_blank">'+escapeHtml(parsed.name||'file')+'</a>'
    + '</span>';
}
function buildImageNode(raw){
  var parsed = parseAttRef(raw);
  var wrap = document.createElement('span');
  wrap.className = 'att-img';
  wrap.dataset.attId = parsed.id; wrap.dataset.attName = parsed.name;
  var img = document.createElement('img');
  img.className = 'att-img-el'; img.dataset.attId = parsed.id;
  img.alt = parsed.name || 'image';
  wrap.appendChild(img);
  return wrap;
}
function buildFileNode(raw){
  var parsed = parseAttRef(raw);
  var wrap = document.createElement('span');
  wrap.className = 'att-file';
  wrap.dataset.attId = parsed.id; wrap.dataset.attName = parsed.name;
  var icon = document.createElement('span');
  icon.className = 'att-file-icon'; icon.textContent = '📎';
  var link = document.createElement('a');
  link.className = 'att-file-link'; link.dataset.attId = parsed.id;
  link.href = '#'; link.target = '_blank';
  link.textContent = parsed.name || 'file';
  wrap.appendChild(icon); wrap.appendChild(link);
  return wrap;
}

/* A ((blockId)) reference renders the *live* content of that block right
   here. Since it's read from the same state.blocks entry, editing the
   source anywhere instantly updates every place that embeds it. */
function renderBlockRefHtml(id, depth){
  depth = depth || 0;
  var blk = state.blocks[id];
  if(!blk){
    return '<span class="blockref blockref-missing" data-refid="'+escapeHtml(id)+'" title="This referenced block no longer exists">((missing block))</span>';
  }
  if(depth >= BLOCKREF_MAX_DEPTH){
    return '<span class="blockref" data-refid="'+escapeHtml(id)+'" title="Reference depth limit reached">'+escapeHtml((blk.text||'').slice(0,40))+'…</span>';
  }
  var page = state.pages[blk.pageId];
  var title = 'Synced block' + (page ? ' from "'+page.title+'"' : '');
  var inner = blk.text ? decorateText(blk.text, depth+1) : '<span style="opacity:.5">(empty block)</span>';
  return '<span class="blockref" data-refid="'+escapeHtml(id)+'" title="'+escapeHtml(title)+'">'+inner+'</span>';
}

function decorateText(text, depth){
  depth = depth || 0;
  if(!text) return "";
  var re = new RegExp(INLINE_PATTERN.source, 'g');
  var out = "", last = 0, m;
  while((m = re.exec(text))){
    out += escapeHtml(text.slice(last, m.index));
    if(m[1] !== undefined){
      out += '<span class="link" data-target="'+escapeHtml(m[1])+'">'+escapeHtml(m[1])+'</span>';
    } else if(m[2] !== undefined){
      out += '<span class="tag" data-tag="'+escapeHtml(m[2])+'">#'+escapeHtml(m[2])+'</span>';
    } else if(m[3] !== undefined){
      out += renderBlockRefHtml(m[3], depth);
    } else if(m[4] !== undefined){
      out += '<strong>'+decorateText(m[4], depth)+'</strong>';
    } else if(m[5] !== undefined){
      out += '<del>'+decorateText(m[5], depth)+'</del>';
    } else if(m[6] !== undefined){
      out += '<code>'+escapeHtml(m[6])+'</code>';
    } else if(m[7] !== undefined){
      out += '<em>'+decorateText(m[7], depth)+'</em>';
    } else if(m[8] !== undefined){
      out += renderImageHtml(m[8]);
    } else if(m[9] !== undefined){
      out += renderFileHtml(m[9]);
    } else if(m[10] !== undefined){
      out += '<mark class="hl-swatch" data-color="'+escapeHtml(m[10])+'">'+decorateText(m[11], depth)+'</mark>';
    } else if(m[12] !== undefined){
      out += '<span class="clr-swatch" data-color="'+escapeHtml(m[12])+'">'+decorateText(m[13], depth)+'</span>';
    }
    last = re.lastIndex;
  }
  out += escapeHtml(text.slice(last));
  return out;
}

/* Build real DOM nodes (for contenteditable) from markdown-flavored text,
   so editing shows live formatting instead of raw ** / ~~ / ` syntax. */
function buildInlineNodes(text){
  var frag = document.createDocumentFragment();
  if(!text) return frag;
  var re = new RegExp(INLINE_PATTERN.source, 'g');
  var last = 0, m;
  function pushText(s){ if(s) frag.appendChild(document.createTextNode(s)); }
  while((m = re.exec(text))){
    pushText(text.slice(last, m.index));
    if(m[1] !== undefined){
      var linkEl = document.createElement('span');
      linkEl.className = 'link'; linkEl.dataset.target = m[1]; linkEl.textContent = m[1];
      frag.appendChild(linkEl);
    } else if(m[2] !== undefined){
      var tagEl = document.createElement('span');
      tagEl.className = 'tag'; tagEl.dataset.tag = m[2]; tagEl.textContent = '#'+m[2];
      frag.appendChild(tagEl);
    } else if(m[3] !== undefined){
      var refEl = document.createElement('span');
      refEl.className = 'blockref'; refEl.dataset.refid = m[3];
      var refBlk = state.blocks[m[3]];
      if(!refBlk){ refEl.classList.add('blockref-missing'); refEl.textContent = '(missing block)'; }
      else {
        var preview = refBlk.text || '(empty block)';
        refEl.textContent = preview.length > 60 ? preview.slice(0,60)+'…' : preview;
      }
      frag.appendChild(refEl);
    } else if(m[4] !== undefined){
      var strongEl = document.createElement('strong');
      strongEl.appendChild(buildInlineNodes(m[4]));
      frag.appendChild(strongEl);
    } else if(m[5] !== undefined){
      var delEl = document.createElement('del');
      delEl.appendChild(buildInlineNodes(m[5]));
      frag.appendChild(delEl);
    } else if(m[6] !== undefined){
      var codeEl = document.createElement('code');
      codeEl.textContent = m[6];
      frag.appendChild(codeEl);
    } else if(m[7] !== undefined){
      var emEl = document.createElement('em');
      emEl.appendChild(buildInlineNodes(m[7]));
      frag.appendChild(emEl);
    } else if(m[8] !== undefined){
      frag.appendChild(buildImageNode(m[8]));
    } else if(m[9] !== undefined){
      frag.appendChild(buildFileNode(m[9]));
    } else if(m[10] !== undefined){
      var markEl = document.createElement('mark');
      markEl.className = 'hl-swatch'; markEl.dataset.color = m[10];
      markEl.appendChild(buildInlineNodes(m[11]));
      frag.appendChild(markEl);
    } else if(m[12] !== undefined){
      var clrEl = document.createElement('span');
      clrEl.className = 'clr-swatch'; clrEl.dataset.color = m[12];
      clrEl.appendChild(buildInlineNodes(m[13]));
      frag.appendChild(clrEl);
    }
    last = re.lastIndex;
  }
  pushText(text.slice(last));
  return frag;
}

/* Walk a contenteditable node's rendered DOM back into markdown-flavored
   plain text, so storage/search/backlinks keep working exactly as before. */
function serializeInline(node){
  var out = "";
  node.childNodes.forEach(function(n){
    if(n.nodeType === 3){
      out += n.nodeValue;
    } else if(n.nodeType === 1){
      var tag = n.tagName;
      if(n.classList && n.classList.contains('link')){
        out += '[[' + (n.dataset.target || n.textContent) + ']]';
      } else if(n.classList && n.classList.contains('tag')){
        out += '#' + (n.dataset.tag || n.textContent.replace(/^#/,''));
      } else if(n.classList && n.classList.contains('blockref')){
        out += '((' + (n.dataset.refid || '') + '))';
      } else if(n.classList && n.classList.contains('att-img')){
        out += '{{img:' + (n.dataset.attId || '') + '|' + (n.dataset.attName || '') + '}}';
      } else if(n.classList && n.classList.contains('att-file')){
        out += '{{file:' + (n.dataset.attId || '') + '|' + (n.dataset.attName || '') + '}}';
      } else if(n.classList && n.classList.contains('hl-swatch')){
        out += '{{mark:' + (n.dataset.color || '') + '|' + serializeInline(n) + '}}';
      } else if(n.classList && n.classList.contains('clr-swatch')){
        out += '%%color:' + (n.dataset.color || '') + '|' + serializeInline(n) + '%%';
      } else if(tag === 'STRONG' || tag === 'B'){
        out += '**' + serializeInline(n) + '**';
      } else if(tag === 'EM' || tag === 'I'){
        out += '*' + serializeInline(n) + '*';
      } else if(tag === 'DEL' || tag === 'S' || tag === 'STRIKE'){
        out += '~~' + serializeInline(n) + '~~';
      } else if(tag === 'CODE'){
        out += '`' + n.textContent + '`';
      } else if(tag === 'BR'){
        out += '\n';
      } else if(tag === 'DIV' || tag === 'P'){
        out += '\n' + serializeInline(n);
      } else {
        out += serializeInline(n);
      }
    }
  });
  return out;
}

/* Toggle an inline format (bold/italic/strike/code) on the current selection
   within a contenteditable block. Unwraps if the selection is already inside
   a matching tag, otherwise wraps the selection in a new element. */
function applyInlineFormat(el, tagName){
  var sel = window.getSelection();
  if(!sel.rangeCount) return;
  var range = sel.getRangeAt(0);
  if(range.collapsed || !el.contains(range.commonAncestorContainer)) return;
  var anchorNode = range.commonAncestorContainer;
  var anchorEl = anchorNode.nodeType === 3 ? anchorNode.parentNode : anchorNode;
  var existing = anchorEl.closest ? anchorEl.closest(tagName) : null;
  if(existing && el.contains(existing)){
    var parent = existing.parentNode;
    while(existing.firstChild) parent.insertBefore(existing.firstChild, existing);
    parent.removeChild(existing);
  } else {
    try{
      var contents = range.extractContents();
      var wrap = document.createElement(tagName);
      wrap.appendChild(contents);
      range.insertNode(wrap);
      var newRange = document.createRange();
      newRange.selectNodeContents(wrap);
      sel.removeAllRanges();
      sel.addRange(newRange);
    }catch(err){}
  }
  el.normalize();
}

/* Toggle a background highlight ({{mark:key|...}}) or text color
   (%%color:key|...%%) on the current selection — same shape as
   applyInlineFormat, generalized over which of the two wrapper kinds
   to use and which color key to stamp on it:
     - selection already sits inside a same-kind wrapper, same color
       → unwrap (turns it off)
     - selection already sits inside a same-kind wrapper, different
       color → re-stamp that wrapper with the new color
     - colorKey is null (the popover's "Remove" option) → unwrap
       whatever same-kind wrapper is there, regardless of its color
     - otherwise → wrap the selection in a new element
   Like applyInlineFormat, this only looks at the selection's anchor,
   so a selection spanning into/out of an existing wrapper is treated
   as "inside" or "outside" by its anchor end, not merged or split. */
function applyColorFormat(el, kind, colorKey){
  var sel = window.getSelection();
  if(!sel.rangeCount) return;
  var range = sel.getRangeAt(0);
  var tagName = kind === 'mark' ? 'mark' : 'span';
  var swatchClass = kind === 'mark' ? 'hl-swatch' : 'clr-swatch';
  var anchorNode = range.commonAncestorContainer;
  var anchorEl = anchorNode.nodeType === 3 ? anchorNode.parentNode : anchorNode;
  var existing = anchorEl.closest ? anchorEl.closest('.' + swatchClass) : null;
  if(existing && el.contains(existing)){
    if(colorKey && existing.dataset.color !== colorKey){
      existing.dataset.color = colorKey;
    } else {
      var parent = existing.parentNode;
      while(existing.firstChild) parent.insertBefore(existing.firstChild, existing);
      parent.removeChild(existing);
    }
  } else if(colorKey && !range.collapsed && el.contains(range.commonAncestorContainer)){
    try{
      var contents = range.extractContents();
      var wrap = document.createElement(tagName);
      wrap.className = swatchClass;
      wrap.dataset.color = colorKey;
      wrap.appendChild(contents);
      range.insertNode(wrap);
      var newRange = document.createRange();
      newRange.selectNodeContents(wrap);
      sel.removeAllRanges();
      sel.addRange(newRange);
    }catch(err){}
  }
  el.normalize();
}

/* Toggle a [[page link]] on the current selection, the same way the
   dock's link button and typing [[Name]] both work — unwraps if the
   selection already sits inside one. */
function applyLinkFormat(el){
  var sel = window.getSelection();
  if(!sel.rangeCount) return;
  var range = sel.getRangeAt(0);
  if(range.collapsed || !el.contains(range.commonAncestorContainer)) return;
  var anchorNode = range.commonAncestorContainer;
  var anchorEl = anchorNode.nodeType === 3 ? anchorNode.parentNode : anchorNode;
  var existing = anchorEl.closest ? anchorEl.closest('.link') : null;
  if(existing && el.contains(existing)){
    var parent = existing.parentNode;
    while(existing.firstChild) parent.insertBefore(existing.firstChild, existing);
    parent.removeChild(existing);
  } else {
    try{
      var text = range.toString();
      var contents = range.extractContents();
      var wrap = document.createElement('span');
      wrap.className = 'link';
      wrap.dataset.target = text;
      wrap.appendChild(contents);
      range.insertNode(wrap);
      var newRange = document.createRange();
      newRange.selectNodeContents(wrap);
      sel.removeAllRanges();
      sel.addRange(newRange);
    }catch(err){}
  }
  el.normalize();
}

/* As-you-type shorthand: typing **bold**, *italic*, ~~strike~~ or `code`
   converts live into real formatting the instant the closing marker lands,
   so the raw markdown characters never sit visible on screen. */
function autoFormatAtCaret(el){
  var sel = window.getSelection();
  if(!sel.rangeCount) return;
  var range = sel.getRangeAt(0);
  if(!range.collapsed) return;
  var node = range.startContainer;
  if(node.nodeType !== 3 || !el.contains(node)) return;
  var text = node.nodeValue;
  var before = text.slice(0, range.startOffset);

  var patterns = [
    {re:/\*\*([^*\s][^*]*)\*\*$/, tag:'strong', keep:false},
    {re:/~~([^~\s][^~]*)~~$/, tag:'del', keep:false},
    {re:/`([^`\s][^`]*)`$/, tag:'code', keep:false},
    {re:/(^|[^*])\*([^*\s][^*]*)\*$/, tag:'em', keep:true}
  ];
  for(var i=0;i<patterns.length;i++){
    var p = patterns[i];
    var m = before.match(p.re);
    if(!m) continue;
    var innerText = p.keep ? m[2] : m[1];
    var matchStart = p.keep ? m.index + m[1].length : m.index;
    var keepBefore = text.slice(0, matchStart);
    var restAfter = text.slice(range.startOffset);
    var wrapper = document.createElement(p.tag);
    wrapper.textContent = innerText;
    var beforeNode = document.createTextNode(keepBefore);
    var afterNode = document.createTextNode(restAfter);
    var parent = node.parentNode;
    parent.replaceChild(afterNode, node);
    parent.insertBefore(wrapper, afterNode);
    parent.insertBefore(beforeNode, wrapper);
    var newRange = document.createRange();
    newRange.setStart(afterNode, 0);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
    return;
  }
}

function extractRefs(text){
  var refs = [];
  var re = /\[\[([^\]]+)\]\]|#([a-zA-Z0-9_][\w-]*)/g, m;
  while((m = re.exec(text))){
    if(m[1] !== undefined) refs.push({type:'page', title:m[1]});
    else refs.push({type:'tag', title:m[2]});
  }
  return refs;
}

var BLOCKREF_RE = /\(\(([a-zA-Z0-9_-]+)\)\)/g;

/* Every other block whose text embeds ((id)) — i.e. every place that is
   kept in sync with this block. */
function findBlockRefsTo(id){
  var refs = [];
  Object.keys(state.blocks).forEach(function(bid){
    if(bid === id) return;
    var blk = state.blocks[bid];
    if(!blk.text) return;
    var re = new RegExp(BLOCKREF_RE.source, 'g'), m, found = false;
    while((m = re.exec(blk.text))){ if(m[1] === id){ found = true; break; } }
    if(found) refs.push(blk);
  });
  return refs;
}

function copyToClipboard(text){
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).catch(function(){ fallbackCopy(text); });
  } else {
    fallbackCopy(text);
  }
}
function fallbackCopy(text){
  var ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.focus(); ta.select();
  try{ document.execCommand('copy'); }catch(e){}
  document.body.removeChild(ta);
}

