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

function uid(){
  /* IDs are persisted forever and also travel across sync/backup. Use the
     platform CSPRNG when available instead of time+Math.random(), then
     keep a compact fallback for very old/embedded browsers. */
  try{
    if(window.crypto && typeof window.crypto.randomUUID === 'function') return 'b' + window.crypto.randomUUID().replace(/-/g,'');
    if(window.crypto && typeof window.crypto.getRandomValues === 'function'){
      var bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      return 'b' + Array.prototype.map.call(bytes, function(x){ return x.toString(16).padStart(2,'0'); }).join('');
    }
  }catch(ignore){}
  return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
}

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
    templates: {},
    flashcards: {decks:{}, cards:{}},
    stickyNotes: {cards:{}},
    folders: {}
  };
  state.pages[welcomeId] = {
    id: welcomeId, title:"Welcome to Nexus", type:"page", createdAt:Date.now(), icon:'👋', banner:'paper',
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

var NEXUS_DEFAULT_PAGE_ICONS = {page:'📄', daily:'📅', tag:'🏷️'};
var NEXUS_PAGE_BANNER_PRESETS = ['none','paper','ocean','forest','violet','sunset','rose','slate','aurora'];
function defaultPageIcon(type){ return NEXUS_DEFAULT_PAGE_ICONS[type] || NEXUS_DEFAULT_PAGE_ICONS.page; }
function normalizePageAppearance(page){
  if(!page || typeof page !== 'object') return page;
  var fallbackIcon = defaultPageIcon(page.type);
  if(typeof page.icon !== 'string' || !page.icon.trim() || page.icon.length > 8) page.icon = fallbackIcon;
  if(NEXUS_PAGE_BANNER_PRESETS.indexOf(page.banner) === -1) page.banner = 'none';
  return page;
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
    id: pid, title: DOCS_TITLE, type: 'page', createdAt: Date.now(), icon:'📖', banner:'violet',
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
    "Select any text while editing to reveal the edit dock for Bold, Italic, Strikethrough, Code, Link, Highlight and Text color.",
    "Use keyboard shortcuts where available: ⌘B bold, ⌘I italic, ⌘⇧X strikethrough, ⌘E code. Highlight and text color use the 12-color swatch pickers.",
    "You can also type **bold**, *italic*, ~~strike~~ or `code` — the markers turn into real formatting live, the instant you finish typing the closing symbol.",
    "The Link button in Nexus creates a page link ([[Page Name]]) from the selected text. Right-click selected text exposes the same formatting controls plus link/tag conversion and copy/search actions."
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

  section("Supertags", [
    "Open any tag's own page and tick the \"Supertag\" checkbox to give it a schema — a shared set of fields, rather than just a label.",
    "Click ＋ Add field to name a field and pick a type (the same Text, Number, Date, Checkbox, Select, Multi-select, Rating, Relation, Rollup and Formula types used everywhere else), plus an optional default value.",
    "Any page that uses that #tag anywhere in its own lines is an instance: it automatically gets those fields added to its Properties, without ever overwriting a value you've already filled in yourself.",
    "A supertag's page lists every page currently tagged with it, and an instance shows a small #tagname badge under its own title — a quick way to tell a page is \"typed\". In the sidebar, supertags get a ⚡ next to their name under Tags."
  ]);

  section("Linked references (backlinks)", [
    "Scroll to the bottom of any page to see \"Linked references\" — every line anywhere else in your notebook that mentions this page or tag, grouped by where it was written."
  ]);

  section("Properties", [
    "Click ＋ Add property, just under a page's title, to attach structured key: value metadata — for example status: in progress or author: Jane.",
    "Hover a property row to reveal a small type menu (Text, Number, Date, Checkbox, Select, Multi-select, Rating, Relation, Rollup, Formula) next to the key, and a ✕ for deleting the row.",
    "Number gives you a numeric field, Date a real date picker, Checkbox a tickbox, and Select/Multi-select suggest values already used elsewhere for that property so you stay consistent instead of retyping variants. Select and multi-select values are also colored automatically — the same text is always the same color, nothing to configure.",
    "Number has a display format too (plain, rounded, $123.00, or 123%), shown as a small preview next to the field. Rating is a click-to-set row of five stars — click the current value again to clear it.",
    "Relation links this page to other pages by title — its chips are clickable, and any page it points at lists this one back under Related pages, below Linked references.",
    "Rollup is read-only: pick one of this page's own Relation properties, a property to pull from each page it points to, and how to combine them (list, count, sum, average, min, max) — it recalculates the instant any property changes in this notebook, not just when you reopen the page.",
    "Formula is also read-only: type an expression using other properties on the same page, e.g. Price * Qty or {Total Price} * 1.1 (use braces for a key with spaces), with round/abs/floor/ceil/sqrt/min/max available — it recomputes on every change, just like a rollup.",
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
    "Click an existing database view to reopen the builder pre-filled with its filters and view settings, or use its ✎ raw link to edit the {{table: view:board group:status sort:-due cols:status,due ...}} text directly.",
    "Cells are editable right there — click a checkbox, star, date, or a select/multi-select/relation chip to change it, without opening the page. Relation chips still navigate normally when clicked.",
    "A table view gets a totals row at the bottom: pick Count, Sum, Average, Min, or Max per column from the small dropdown in its footer cell.",
    "Use \"+ view\" above any database to add another view of the exact same filters — a Board alongside your Table, say — switchable with tabs. Double-click a tab to rename it; ✕ removes it once there's more than one."
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
    "Images show inline; other files show as a small chip with the file name. Click an image to open it full-size in a new tab, or click a file's name to download it under its original name.",
    "Hover an image (or look next to a file's name) for a small ⬇ button — click it any time to save a copy to your computer.",
    "The Attachments list in the sidebar footer shows every image and file in the whole notebook, including ones no longer used on any page, each with its own ⬇ — a last chance to grab a copy before deleting an unused one for good.",
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
    "⌘B (with sidebar focused) or « / ☰ — collapse or expand the sidebar · ⌘⇧F — Search all notes · Esc — close any open dialog"
  ]);

  ensureCompleteHelpGuide(pid);
  save();
}

/* Adds the feature areas introduced after the original Help page was seeded.
   Existing Help content is preserved; the guide is appended once and stamped
   with a version and feature catalog so future releases can extend it again
   without duplicating existing sections on every load. */
var NEXUS_HELP_GUIDE_VERSION = 32;
/* Maintenance contract:
   Whenever a user-visible feature is added or materially changed, update
   NEXUS_HELP_GUIDE_VERSION and add/update its title in the maintained
   feature catalog below. The boot-time coverage check re-adds missing
   sections without overwriting the user's own Help content.
   This is intentionally in the app source so Help cannot silently drift
   behind the product. */
var NEXUS_HELP_FEATURE_CATALOG = [
  {id:'help-01', title:'Getting started'},
  {id:'help-02', title:'Pages & daily notes'},
  {id:'help-03', title:'The outliner'},
  {id:'help-04', title:'Formatting text'},
  {id:'help-05', title:'Headings'},
  {id:'help-06', title:'To-do checkboxes'},
  {id:'help-07', title:'Links between pages'},
  {id:'help-08', title:'Tags'},
  {id:'help-09', title:'Supertags'},
  {id:'help-10', title:'Linked references (backlinks)'},
  {id:'help-11', title:'Properties'},
  {id:'help-12', title:'Command palette'},
  {id:'help-13', title:'Graph view'},
  {id:'help-14', title:'Tasks view'},
  {id:'help-15', title:'Live queries'},
  {id:'help-16', title:'Database views'},
  {id:'help-17', title:'Block sync (block references)'},
  {id:'help-18', title:'Search & navigation'},
  {id:'help-19', title:'Images & files'},
  {id:'help-20', title:'Backup, restore & version history'},
  {id:'help-21', title:'Privacy & storage'},
  {id:'help-22', title:'Sync (local network, live pairing)'},
  {id:'help-23', title:'Undo & redo'},
  {id:'help-24', title:'Shortcuts, quick reference'},
  {id:'help-25', title:'Find & replace'},
  {id:'help-26', title:'Trash & recovery'},
  {id:'help-27', title:'Daily notes: recent, all & calendar'},
  {id:'help-28', title:'Highlight, text color & links'},
  {id:'help-29', title:'Graph navigation & accessibility'},
  {id:'help-30', title:'Database calendar view'},
  {id:'help-31', title:'Visual query builder'},
  {id:'help-32', title:'Navigation, zoom & undo/redo'},
  {id:'help-33', title:'Help & Tutorial maintenance'},
  {id:'help-34', title:'Complete feature guide — updated'},
  {id:'help-35', title:'Doc mode & outline mode'},
  {id:'help-36', title:'Templates'},
  {id:'help-37', title:'Slash commands'},
  {id:'help-38', title:'Context menus & selection tools'},
  {id:'help-39', title:'Advanced search language'},
  {id:'help-40', title:'Search all notes'},
  {id:'help-41', title:'Task manager — advanced'},
  {id:'help-42', title:'Queries & database views — advanced'},
  {id:'help-43', title:'Block references & live embeds'},
  {id:'help-44', title:'Page organization & sidebar controls'},
  {id:'help-45', title:'Locks & read-only protection'},
  {id:'help-46', title:'Attachments & storage'},
  {id:'help-47', title:'Data health & diagnostics'},
  {id:'help-48', title:'Backup, automatic backup & version history'},
  {id:'help-49', title:'Google Drive sync & credentials'},
  {id:'help-50', title:'LAN device sync'},
  {id:'help-51', title:'Import & export options'},
  {id:'help-52', title:'PWA / install / offline'},
  {id:'help-53', title:'Settings & personalization'},
  {id:'help-54', title:'Mobile editing'},
  {id:'help-55', title:'Safety, recovery & good operating practice'},
  {id:'help-56', title:'Database workspace & sidebar index'},
  {id:'help-74', title:'Footnotes'},
  {id:'help-57', title:'Query workspace & sidebar index'},
  {id:'help-58', title:'Task gallery view'},
  {id:'help-59', title:'Logseq-inspired Daily Notes'},
  {id:'help-60', title:'Page icons & banners'},
  {id:'help-61', title:'Dashboard home hub'},
  {id:'help-62', title:'Page transclusion'},
  {id:'help-63', title:'Block transclusion'},
  {id:'help-64', title:'Section transclusion'},
  {id:'help-65', title:'Flashcards & spaced repetition'},
  {id:'help-66', title:'Sticky Note Cards'},
  {id:'help-67', title:'Zettelkasten method'},
  {id:'help-68', title:'Folder organization & nested folders'},
  {id:'help-69', title:'Passcode re-entry interval'},
  {id:'help-70', title:'Mobile Zettelkasten collapse & expand'},
  {id:'help-71', title:'Central Command Center'},
  {id:'help-72', title:'Workspace tabs'},
  {id:'help-73', title:'Additional crafted themes'},
  {id:'help-75', title:'Pinned tabs & sidebar drag-and-drop ordering'},
  {id:'help-76', title:'Mobile sidebar always-visible toggle'},
  {id:'help-77', title:'Launch passcode policy & device auto-unlock'},
  {id:'help-78', title:'Link, backlink & graph semantics'}
]
function getHelpGuideCoverage(pid){
  var page = state.pages[pid];
  var texts = [];
  if(page){
    Object.keys(state.blocks || {}).forEach(function(id){
      var b = state.blocks[id];
      if(b && b.pageId === pid) texts.push((b.text || '').toLowerCase());
    });
  }
  var hay = texts.join('\n');
  var missing = NEXUS_HELP_FEATURE_CATALOG.filter(function(item){
    return hay.indexOf(item.title.toLowerCase()) === -1;
  }).map(function(item){ return item.title; });
  return {
    version: page && page.helpGuideVersion || 0,
    currentVersion: NEXUS_HELP_GUIDE_VERSION,
    missing: missing,
    pending: !!(page && page.helpGuideVersion < NEXUS_HELP_GUIDE_VERSION),
    locked: !!(page && page.locked),
    complete: missing.length === 0 && !!page && page.helpGuideVersion >= NEXUS_HELP_GUIDE_VERSION
  };
}
function ensureCompleteHelpGuide(pid){
  var page = state.pages[pid];
  if(!page) return;
  var coverage = getHelpGuideCoverage(pid);
  if(!coverage.pending && coverage.missing.length === 0) return;
  if(page.locked) return; /* Respect an explicitly locked Help page. */

  function section(headerText, childTexts){
    var hid = uid();
    state.blocks[hid] = mkBlock(hid, pid, null, "**"+headerText+"**");
    page.rootBlocks.push(hid);
    childTexts.forEach(function(t){
      var cid = uid();
      state.blocks[cid] = mkBlock(cid, pid, hid, t);
      state.blocks[hid].children.push(cid);
    });
  }

  /* These are the feature areas most likely to be missed when a new
     capability lands. They are appended only when their exact section
     heading is absent, so user-edited Help content remains untouched. */
  var existingHelpText = Object.keys(state.blocks || {}).filter(function(id){
    return state.blocks[id] && state.blocks[id].pageId === pid;
  }).map(function(id){ return state.blocks[id].text || ''; }).join('\n').toLowerCase();

  function addMaintainedSection(title, lines){
    if(existingHelpText.indexOf(title.toLowerCase()) !== -1) return;
    section(title, lines);
    existingHelpText += '\n' + title.toLowerCase();
  }

  addMaintainedSection("Find & replace", [
    "⇄ Find & replace searches every block in the notebook. Enter the text to find, optionally enter replacement text, and use the case-sensitive option when needed.",
    "The preview reports the number of occurrences before you apply a replacement. Nexus saves a version snapshot first, skips locked blocks, then updates the notebook as one replace-all operation.",
    "Use it for controlled bulk corrections; for high-value notebooks, check Version history immediately afterward so you can compare or restore the pre-change snapshot if necessary."
  ]);

  addMaintainedSection("Trash & recovery", [
    "Deleting a page normally moves it to Trash rather than destroying it immediately. Open the Trash section in the sidebar to review deleted pages.",
    "A trashed page can be restored with its blocks. Delete forever permanently removes it; Empty trash permanently removes everything currently in Trash, so keep a backup before using either destructive action.",
    "The page-delete confirmation setting controls whether Nexus asks before moving a page to Trash. Locked pages cannot be moved to Trash through the protected page actions."
  ]);

  addMaintainedSection("Daily notes: recent, all & calendar", [
    "📅 Today's note opens or creates the daily page for the current date. Daily pages use the same editor, links, tags, properties, tasks, attachments and backups as normal pages.",
    "The Daily section can show recent daily notes or all daily notes. Use the calendar/list toggle to browse daily notes by date; selecting a calendar day opens that day's page when it exists.",
    "Daily notes remain ordinary pages with type=daily, so advanced search can target them with is:daily and page links/backlinks work normally."
  ]);

  addMaintainedSection("Highlight, text color & links", [
    "Select text and use the edit dock or right-click menu to highlight it or change its text color. Nexus provides twelve named swatches for each, and the Remove option clears the selected formatting.",
    "Formatting is stored in lightweight inline markup so it survives saving, backup, restore and sync. Highlight and text color can be combined with bold, italic, code and strikethrough.",
    "The Link action on selected text creates or toggles a Nexus page link ([[Page Name]]) using the built-in link formatter. Page-link conversion is also available from the selection context menu; Nexus does not turn selected text into arbitrary external URLs."
  ]);

  addMaintainedSection("Graph navigation & accessibility", [
    "◎ Graph view visualizes live page relationships created by [[page links]]. Tags are represented as nodes as well, and connected nodes highlight together as you move over them.",
    "Drag the empty background to pan, use the mouse wheel or the ＋/－ controls to zoom, and Reset view to return to the default camera. Drag a node to reposition it temporarily; click a node to open its page.",
    "Graph nodes are keyboard-focusable: Tab can reach them and Enter or Space opens the focused page."
  ]);

  addMaintainedSection("Link, backlink & graph semantics", [
    "[[Page Name]] is a page link and participates in backlinks, Graph view and Zettelkasten page connections. A #tag is metadata/topic text, not a page link, even when a page with the same title exists.",
    "Graph view includes tag pages as visible nodes, but a #tag reference does not create a page-to-page edge. This keeps graph relationships aligned with explicit [[page links]] while still letting tag nodes be explored.",
    "Backlinks likewise come from explicit [[page links]] (plus relation properties shown as Related pages). A tag with the same text as a page title does not falsely appear as a backlink.",
    "Trashed source pages are excluded from backlink results so archived content does not appear as a live reference."
  ]);

  addMaintainedSection("Database calendar view", [
    "A database can be displayed as a Calendar view in addition to Table, Board and Gallery. Choose Calendar in the database view controls or add view:calendar to a table directive.",
    "The calendar uses a date property when one is available; when the selected date property is empty, a page's creation date can be used as its fallback date. Use the previous/next month buttons to browse.",
    "Calendar navigation is remembered for each database block so editing or re-rendering the page does not unexpectedly jump you back to the current month."
  ]);

  addMaintainedSection("Visual query builder", [
    "Use ⌕ Insert query or ▤ Insert database and Nexus opens the visual Query Builder. Choose pages, tags, properties and filters without memorizing search syntax, then insert the resulting live query/database block.",
    "Advanced users can still edit a query block's raw filter text. Database directives such as view:, sort:, group:, cols: and agg: change the presentation without changing the underlying page filter.",
    "The same underlying query can be shown through saved database views, so Table/Board/Gallery/Calendar are alternate presentations of the same filtered page set."
  ]);

  addMaintainedSection("Navigation, zoom & undo/redo", [
    "← Back and Forward → move through recently opened pages. They are navigation history, separate from Undo/Redo editing history.",
    "Undo and Redo operate on in-tab notebook edits. Nexus keeps up to 100 undo states and saves through the normal persistence queue. Reload-safe recovery is provided by Version history instead.",
    "Use the page zoom controls or a block's ⤢ Zoom in action to focus on a subtree. Zoom out returns to the whole page; while zoomed, adding a line places it under the focused block when the current page allows editing."
  ]);

  addMaintainedSection("Footnotes", [
    "Use [^note] inside any block to create a footnote reference, and define it anywhere on the same page with [^note]: Footnote text. Identifiers can contain letters, numbers, colons, underscores and hyphens.",
    "Nexus collects definitions from the whole page, numbers references by first use, and renders a Footnotes panel beneath the outline. Click a numbered reference to jump to its definition; click the number beside a definition to return to a reference. Missing definitions are marked with a question mark so broken citations are easy to spot.",
    "Use the / Footnote… command while editing to insert a reference and create its definition in one step. The Footnotes panel also has + Add footnote for definitions that should exist without an inline reference yet.",
    "Footnote syntax remains ordinary page text, so it is preserved by search, undo/redo, backup/restore, version history, locks, device sync and Markdown import/export. Footnotes are included in printed/PDF page output through the rendered page panel.",
    "Developer release rule: whenever footnote syntax, numbering, navigation, definition storage, editor behavior or rendering changes, update this Help section, the feature catalog and the guide version in the same release and run the full regression suite."
  ]);

  addMaintainedSection("Help & Tutorial maintenance", [
    "This guide is intended to stay synchronized with Nexus. Release rule: whenever a user-visible feature, setting, command, search operator, page metadata field (including icons/banners), data format or workflow is added or materially changed, update the Help/Tutorial content in the same release.",
    "The built-in guide carries a version number and a feature coverage catalog. On startup Nexus checks the Help page and appends any missing maintained sections without replacing the user's own notes. This lets future releases extend the guide safely.",
    "Run Settings → Data health → Run diagnostics to check Help coverage. If the guide is locked while an update is pending, unlock it and restart/open Nexus so the missing documentation can be added. A complete guide should report the current guide version with no missing feature topics.",
    "Developer checklist: update NEXUS_HELP_GUIDE_VERSION, add or revise the feature title in NEXUS_HELP_FEATURE_CATALOG, add the user instructions to ensureCompleteHelpGuide, run npm test, and verify the Help page after a fresh boot and an upgrade from an existing notebook."
  ]);

  addMaintainedSection("Complete feature guide — updated", [
    "This appendix covers the newer Nexus capabilities that may not be obvious from the main tutorial. It is safe to keep this page as a reference, edit it, or add your own notes.",
    "The Help button always opens this page. Nexus maintains a built-in guide version and feature catalog; on startup it adds missing maintained sections without replacing your own notes."
  ]);

  addMaintainedSection("Doc mode & outline mode", [
    "Use the top-bar ▤ Doc mode button to switch between the structured outliner and a document-style reading layout. New pages can be configured to open in either mode from Settings.",
    "Outline mode exposes the block hierarchy, drag handles, collapse controls and block actions. Doc mode is useful when you want to read the same page with less editor chrome.",
    "The toolbar can also zoom the page or a specific line when you want to focus on one part of a long outline."
  ]);

  addMaintainedSection("Templates", [
    "The Templates section of the sidebar contains starter templates such as Meeting notes and Daily journal. Click a template to insert it into the current page or create a new page from it.",
    "Save any open page as a template from the page menu or the + save page control above Templates. Templates preserve the block hierarchy and text structure, but create fresh block IDs when inserted.",
    "Right-click a template to insert it, create a new page from it, rename it, or delete it. Slash commands can also insert templates by name."
  ]);

  addMaintainedSection("Slash commands", [
    "Type / at a word boundary inside an editable line to open the command menu. Keep typing to filter; use ↑/↓, Enter or Tab, and Esc to navigate or dismiss it.",
    "Turn into: Heading 1, Heading 2, Heading 3, To-do, Plain text, and Code block. Insert: Page link, Tag, Today's date, Image or file, Query, and Database view.",
    "Line actions include Indent, Outdent, Duplicate line, Copy block reference, Zoom in on this line, and Delete. Templates appear as searchable slash commands too.",
    "Slash commands ignore normal URLs and fenced code blocks, so typing a web address or code does not unexpectedly open the menu."
  ]);

  addMaintainedSection("Context menus & selection tools", [
    "Right-click a block to get the same actions exposed by its ⋯ menu, including Edit, Indent, Outdent, Duplicate, Copy block reference, Zoom, lock controls and deletion where permitted.",
    "Right-click selected text for Bold, Italic, Strikethrough, Code, Link, page-link conversion, tag conversion, Copy, or a search for the selected text.",
    "Right-click a page or tag in the sidebar for Open, Pin/Unpin, Remove from sidebar, Lock/Unlock, Copy page link, Rename, Duplicate, Save as template, Markdown/PDF export, and Trash actions.",
    "Right-click a trashed page to restore it or delete it forever. Right-click a template to insert it, create a page from it, rename it, or delete it. Shift+right-click keeps the browser's normal context menu."
  ]);

  addMaintainedSection("Advanced search language", [
    "The sidebar search, Search all notes, command palette, task filters and other search surfaces share the same advanced query language.",
    "Examples: #project finds a tag; [[Meeting Notes]] finds a page link; status:in-progress matches a property; priority:high or priority:1 filters task priority; due:today, before:friday and after:2026-01-01 filter dates; is:done, is:overdue, is:locked and similar flags match state; has:due and has:attachment find lines with those features.",
    "Use >, <, >=, <= or != with property values when appropriate, wrap phrases in quotes, prefix a term with - to exclude it, separate alternatives with |, use OR for separate search groups, and use /regular-expression/flags for regex matching.",
    "Search understands page titles, tags, line text, task metadata and page properties. Tag filters match #tag references only, while page-link filters match [[Page]] references only. A pasted URL is treated as normal text rather than mistaken for a property expression."
  ]);

  addMaintainedSection("Search all notes", [
    "⌘⇧F opens the full-screen Search all notes view. It searches up to a large result set across every page and line, groups hits by page, shows snippets, and lets you collapse page groups.",
    "The sidebar search is the quick filter. Search all notes is the larger workspace for investigating many matches. Clicking a result opens the page and reveals the matching line."
  ]);

  addMaintainedSection("Task manager — advanced", [
    "Every task remains an ordinary [ ] or [x] block, so task metadata survives normal editing, backups, version history and sync.",
    "Priority markers are !p1, !p2 and !p3 (High, Medium, Low). Recurrence markers use !every(Nd), !every(Nw), !every(Nm) or !every(Ny), for example !every(1w). Due dates use !due(YYYY-MM-DD).",
    "The Tasks view can filter by status, priority, page and tag; search with the same advanced operators; sort by due date, page and other fields; group tasks; switch between Board, List and Gallery layouts; add tasks quickly; and apply bulk changes to selected tasks.",
    "Tasks are bucketed into Overdue, Today, Next 7 days, Later, No date and Done. Locked tasks remain visible but cannot be edited from the task manager."
  ]);

  addMaintainedSection("Task gallery view", [
    "The Tasks workspace has three presentation modes: Board, List and Gallery. Click the layout button to cycle through them; all three use the same filters, search syntax, grouping, sorting, bulk actions and task editing.",
    "Gallery presents tasks as responsive cards in a grid. Each card keeps its completion checkbox, selection control, due date, priority/repeat chips, page link and ⋯ task menu, so nothing is lost by changing layout.",
    "Use Gallery when you want a visual scan of many tasks at once. Grouping still applies: date, priority, page or tag groups are shown as labeled sections above their cards.",
    "Your layout choice is a view preference only; switching between Board, List and Gallery never changes task data."
  ]);

  addMaintainedSection("Logseq-inspired Daily Notes", [
    "Daily notes keep Nexus's normal page/block storage, but use a journal-first presentation inspired by Logseq: the date is prominent, blocks stay in an outliner, and nested notes remain first-class.",
    "Use ‹ and › to move one day at a time, Today to return to the current journal, or the date picker to jump directly to another date. Opening a missing date creates that daily note with a first blank block ready for writing.",
    "The daily journal header is presentation only. Your existing tasks, links, tags, properties, attachments, queries, databases, backlinks, locks, backups, sync and search continue to work exactly as on any other Nexus page."
  ]);

  addMaintainedSection("Queries & database views — advanced", [
    "A {{query: ...}} block is a live, auto-updating block search. A {{table: ...}} block is a live page database driven by the same advanced filters.",
    "Database views support Table, Board and Gallery layouts. Board views can group by a property; tables can choose columns, sort direction, and per-column totals; cells can be edited inline where the property type allows it.",
    "A database block can contain multiple saved views. Use + view to add one, switch tabs to change views, double-click a tab to rename it, and ✕ to remove a view when more than one exists.",
    "Supported structured property types include Text, Number, Date, Checkbox, Select, Multi-select, Rating, Relation, Rollup and Formula. Relations are clickable and show reciprocal Related pages."
  ]);

  addMaintainedSection("Block references & live embeds", [
    "Hover a block and click ⚭ to copy its ((block-id)) reference. Paste that reference anywhere to embed the block's live content.",
    "Every embed reads the same underlying block, so edits made at the source or through a permitted edit path appear everywhere that block is referenced. A small count badge indicates other references.",
    "References have a depth limit to prevent circular or deeply nested embeds from causing an infinite render. Missing references are displayed safely instead of breaking the page."
  ]);

  addMaintainedSection("Database workspace & sidebar index", [
    "The permanent ▤ Database button opens Nexus's default Database workspace. It is a normal page containing an all-pages database and cannot be moved to Trash or permanently deleted.",
    "Created databases are database blocks written as {{table: ...}}. Nexus automatically indexes every live database in the sidebar under Created databases, including databases on other pages.",
    "Use Filter databases… to search that index by database label, page title, filter text or view type. Click a result to open its page and jump directly to the database block.",
    "The default Database workspace is intended as the central database home. You can still create additional databases anywhere with ▤ Insert database or the visual Query Builder; they will appear in the Created databases index automatically.",
    "Database entries are discovered from the live notebook state, so renaming a page, changing a database filter, adding a saved view, or restoring a page automatically changes what appears in the index."
  ]);

  addMaintainedSection("Page transclusion", [
    "Use ![[Page Title]] to embed an entire page inline as a live, read-only transclusion. The rendered page reads directly from the current notebook state, so edits to the source are reflected the next time Nexus renders.",
    "Click the transcluded content to open its source page. A missing or trashed source is reported safely instead of breaking the host page, and recursive embeddings stop at a protected depth/cycle boundary.",
    "The explicit form {{transclude:page|Page Title}} is also accepted when generating or importing text programmatically."
  ]);

  addMaintainedSection("Block transclusion", [
    "Use !((block-id)) to embed a specific block and its nested children as live content. This is different from ((block-id)): the latter is the compact block-reference/sync form, while the !((…)) form renders a full transclusion card.",
    "Copy a block ID from the line's reference action, then write !((that-id)) anywhere. Click the transclusion to open the source page containing the block.",
    "The explicit form {{transclude:block|block-id}} is supported as a generated/import-friendly equivalent. Missing IDs are shown as recoverable missing transclusions."
  ]);

  addMaintainedSection("Section transclusion", [
    "Use ![[Page Title#Heading]] to embed a whole heading section: the matching heading plus everything that follows it until the next heading of the same or higher level. Nested blocks remain visible in their outline order.",
    "Section names are matched case-insensitively against heading text. Use a fully qualified Page#Heading reference when the section lives on another page. The explicit form {{transclude:section|Page Title#Heading}} is also supported.",
    "Section transclusions are live and read-only in the host page. Open the source page to edit the original section; recursive or missing sections are handled safely with an explanatory state."
  ]);

  addMaintainedSection("Flashcards & spaced repetition", [
    "Click ▤ Flashcards in the sidebar to open the permanent learning workspace. Create decks and cards with a front, back, optional tags and optional source page/block so cards can remain connected to your notes without changing note content.",
    "Start review to see cards that are due now. Click Reveal, then choose Again, Hard, Good or Easy. Nexus schedules the next review from your answer, moving cards from New to Learning and then Review while keeping the schedule in the notebook data for backup and device sync.",
    "Use the deck, status and text filters to focus a study session. Again brings a difficult card back sooner, while Good and Easy lengthen the interval; suspended cards stay in the deck but are excluded from review until resumed.",
    "The Created flashcards sidebar section indexes every active card and lets you filter by front/back text, deck, tags and source page. Click a result to open the Flashcards workspace with that card selected.",
    "Developer release rule: whenever card creation, deck management, review scheduling, shortcuts, storage, sync behavior or the flashcard interface changes, update this Help section, the feature catalog and the guide version in the same release."
  ]);

  addMaintainedSection("Page organization & sidebar controls", [
    "Pages can be pinned or unpinned to control the top of the sidebar. Remove from sidebar hides a live page without trashing it; hidden pages remain searchable, linkable and accessible from the Hidden section.",
    "Pages can be duplicated with their properties and outline structure. Page actions also include Copy link, Rename, Save as template, Markdown/PDF export, and Trash.",
    "The sidebar can be collapsed from its controls or with ⌘/Ctrl+B. On narrow screens it behaves as a drawer and automatically closes after navigation."
  ]);

  addMaintainedSection("Locks & read-only protection", [
    "Settings → Privacy provides the app-wide passcode lock, which encrypts local notebook storage when enabled. The lock screen can be triggered immediately, and a recovery key is available for account recovery on this device.",
    "A page can be locked from its page menu. A locked page is read-only: its title, properties and blocks cannot be edited, and destructive page actions are disabled.",
    "A block can be locked from its ⋯ / context menu. A locked block and everything nested beneath it become read-only. Unlocking is available at the point where the lock was originally set; descendants explain when a lock comes from an ancestor.",
    "Find & replace and the task manager honor locks, so bulk editing cannot silently bypass read-only protection."
  ]);

  addMaintainedSection("Attachments & storage", [
    "Images and other files live in a separate IndexedDB attachment store. The text of a note contains only a lightweight attachment reference, which keeps undo/version history and notebook text independent from file bytes.",
    "The Attachments sidebar lists stored files, including unused ones. Download an attachment at any time; deleting a {{img:...}} or {{file:...}} reference does not automatically destroy the underlying file.",
    "Settings → Data health reports stored attachment count and size, identifies orphaned attachments that are no longer referenced by notes, and can clean them up permanently after you review your backups.",
    "Backups are the supported way to move attachment bytes to another device. LAN/Google sync carries notebook state and references, while a device still needs the actual attachment bytes."
  ]);

  addMaintainedSection("Data health & diagnostics", [
    "Settings → Data health opens the Nexus data-health dashboard. It reports page/block counts, notebook size, attachment usage, orphaned files, version-snapshot usage, last backup, browser storage usage, storage policy, device identity, Google Drive status and conflict count.",
    "Protect local storage asks the browser for persistent storage. A browser may approve or decline; persistent storage reduces eviction risk but is not a replacement for independent backups.",
    "Run diagnostics checks IndexedDB, Web Crypto, service-worker support, notebook loading, the absence of an embedded live Google API key in the distributable HTML, required core functions, and attachment-reference health.",
    "The small save-status indicator also reports Saved locally, Offline — saved locally, warning or error states so you can see whether the latest work has reached local persistence."
  ]);

  addMaintainedSection("Backup, automatic backup & version history", [
    "⭳ Backup (export) creates a portable JSON notebook backup containing notebook state and attachment bytes. In supported Chromium-based browsers, Nexus can open a native Save As picker; otherwise the browser downloads the file normally.",
    "Settings lets you choose backup reminders (3, 7, 14 days or never) and automatic backup schedules (daily, every 3 days, every 7 days or off). When supported, you can choose and forget a backup folder for automatic backups.",
    "↺ Version history stores automatic snapshots, including a safety snapshot before restores and before operations such as Find & replace. You can inspect snapshots, compare them with the current notebook, and restore a selected snapshot.",
    "Version history is separate from in-tab Undo. Undo/Redo is immediate editing history in memory; Version history is the recovery path that survives reloads."
  ]);

  addMaintainedSection("Google Drive sync & credentials", [
    "Settings → Google Drive connection stores the OAuth Client ID and browser API key locally on this device. The API key is not a password; restrict it in Google Cloud Console by allowed web origins/referrers and the APIs Nexus actually uses.",
    "Export to Google Drive and Import from Google Drive let you move a backup through your Drive account. Auto-sync with Google Drive can merge a small notebook-state file roughly once a minute while this tab is open; Sync now triggers it immediately.",
    "The Google Drive connection lifetime setting controls how long Nexus may quietly maintain the connection before requiring another sign-in. Google's access-token lifetime is separate and can still require reauthentication.",
    "Credentials can be cleared from this device at any time. Treat exported backup files as sensitive because the app passcode does not encrypt exported JSON files."
  ]);

  addMaintainedSection("LAN device sync", [
    "⇄ Sync devices uses direct WebRTC peer connections on the local network. Pair two devices at the same time through the Sync dialog using the short codes shown there.",
    "LAN sync carries notebook state, not attachment bytes. Changes are merged using each record's edit metadata; conflicting edits are surfaced in the Sync conflicts view so you can keep the retained version, use the dropped version instead, or recover the dropped text as a new line.",
    "Reordering is merged using the notebook's block/container structure rather than relying only on a single last-writer order value, reducing accidental loss of sibling ordering during sync."
  ]);

  addMaintainedSection("Import & export options", [
    "Import Markdown files turns Markdown documents into Nexus pages and block structures. The import flow is intended for bringing existing notes into the notebook rather than replacing the current notebook silently.",
    "Export page as Markdown produces a portable text representation of the open page. Export page as PDF produces a print-friendly PDF representation of the current page.",
    "Full Backup/Restore is different from page export: it preserves the whole notebook model, including pages, blocks, properties, templates, sync metadata and attachment bytes."
  ]);

  addMaintainedSection("PWA / install / offline", [
    "Nexus ships a manifest and app icons and can be installed as a Progressive Web App when the browser supports installation. The Install app button appears when the browser exposes the install prompt.",
    "The companion sw.js service worker pre-caches the Nexus HTML, CSS, JavaScript, manifest and local icons so the application shell is available for offline startup after the first successful install/cache pass. Install and reliable service-worker behavior require https:// or localhost; opening the HTML through a blob preview does not provide the same guarantees.",
    "Navigation falls back to the cached index.html when the network is unavailable, while non-navigation requests use their own cached response rather than incorrectly serving HTML for a missing script or stylesheet.",
    "The Download sw.js button retrieves the current same-origin worker when available and falls back to the matching embedded worker source. Place the downloaded sw.js beside index.html on the same origin, then reload Nexus."
  ]);

  addMaintainedSection("Settings & personalization", [
    "Appearance: choose Small, Medium or Large text and one of Paper, Dark, Slate, Sepia, Ocean, Rose, High Contrast, Midnight, Aurora, Amethyst, Meadow or Ember themes.",
    "Editing: choose whether new pages open in Outline mode or Doc mode, and turn browser spellcheck on or off.",
    "Safety: configure backup reminders, automatic backups and automatic Google Drive sync, inspect Data health, request persistent storage, and choose whether deleting a page asks for confirmation first.",
    "Privacy: set, change, regenerate recovery information for, or remove the passcode lock. Removing the passcode returns local storage to an unencrypted-at-rest state."
  ]);


  addMaintainedSection("Additional crafted themes", [
    "Nexus now includes four additional visual systems: Aurora, a deep teal night theme with an aurora glow; Amethyst, a soft lavender workspace with violet accents; Meadow, a fresh green workspace with warm natural accents; and Ember, a warm dark canvas with ember-orange highlights.",
    "Choose a theme in Settings → Appearance → Theme. Each theme changes the canvas, sidebar, surfaces, links, tags, focus states, selection styling and visual glow/shadow treatment while keeping the same Nexus layout and data.",
    "Theme choice is stored in your settings and applies immediately. The browser’s theme-color metadata also updates to match the chosen palette, improving the appearance of installed/PWA Nexus on supported browsers.",
    "Developer release rule: whenever a theme is added, renamed, removed, or its palette or visual behavior changes, update this Help section, register the theme in the feature catalog, bump the guide version and run npm test in the same release."
  ]);

  addMaintainedSection("Mobile editing", [
    "On phones and tablets, Nexus tracks the visual viewport so the on-screen keyboard does not cover the editor or docked formatting controls.",
    "The mobile edit dock provides quick editing controls and a Done button to hide the keyboard. Caret scrolling keeps the active line visible as the keyboard appears.",
    "The sidebar becomes a drawer on narrow screens, navigation closes it automatically, and touch-friendly controls are used for block actions, menus and editing."
  ]);

  addMaintainedSection("Query workspace & sidebar index", [
    "The permanent ⌕ Queries button opens the built-in Queries workspace. Nexus keeps this workspace available in the sidebar even if its contents are edited; its all-lines query is repaired if the query block is removed.",
    "The Created queries section indexes every live {{query: ...}} block in the notebook. Use Filter queries… to search by query name, owning page or filter text. Queries without a custom name are displayed using their filter text, or as All lines query when the filter is empty.",
    "Click a query entry to open its owning page and jump to that exact query block. The list refreshes with normal sidebar renders, so new queries, edited filters and restored pages stay discoverable without a manual rebuild.",
    "Developer release rule: whenever the query language, query builder, query rendering, query navigation or query sidebar behavior changes, update this section, the Help feature catalog and the guide version in the same release."
  ]);

  addMaintainedSection("Page icons & banners", [
    "Every Nexus page can have its own emoji icon and optional visual banner. The icon appears beside the page title and in the sidebar so pages are easier to scan at a glance.",
    "Click the page icon beside the title to choose from the built-in icon set, or restore the type-specific default. Click Add banner / Change banner on the banner to choose a preset: Paper, Ocean, Forest, Violet, Sunset, Rose, Slate or Aurora.",
    "Page appearance is stored with the page itself, so it survives reloads, Backup/Restore and device sync. It is metadata only: changing an icon or banner never changes the page's blocks or content.",
    "Locked or trashed pages show the appearance controls as read-only. When a new page is created, Nexus assigns a sensible default icon; daily notes use the calendar icon and an Ocean banner by default."
  ]);

  addMaintainedSection("Dashboard home hub", [
    "⌂ Dashboard is Nexus's permanent Home workspace. It is a live hub rather than a second editable notebook page, so it reads the same underlying pages, tasks, databases, queries and sync state you already use.",
    "The Dashboard shows live notebook counts, today's daily note, open/due tasks, recent pages, quick links to Tasks/Database/Queries/Graph/Search, your last opened page and local/sync health. Click a card to jump directly into that workspace or item.",
    "The Nexus brand in the upper-left also opens Dashboard. Leaving Dashboard never changes your current page or notebook data; use Continue where you left off to return to the page you were working on.",
    "Developer release rule: Dashboard is part of the Home experience. Whenever its cards, quick actions, navigation, data-health summary or other user-visible behavior changes, update this Help section, its feature-catalog entry and the guide version in the same release."
  ]);

  addMaintainedSection("Sticky Note Cards", [
    "Click 🗒 Sticky Notes in the sidebar to open the permanent quick-capture workspace. Create colorful cards with an optional title, note body, tags and a source-page link. Cards can be pinned to the top or archived when no longer active.",
    "Use All, Pinned or Archived to change the workspace filter, and Search sticky notes to find cards by title, body, tags, color or source page. The Created sticky notes sidebar section provides a second quick index and keeps archived cards out of the active list.",
    "Click a card to edit it. Sticky Note Cards are notebook data, so they travel through save, backup, version history and device sync just like flashcards and other structured data.",
    "Developer release rule: whenever sticky-note fields, colors, filtering, source linking, archive behavior, sidebar indexing or workspace behavior changes, update this Help section, the feature catalog and the guide version in the same release."
  ]);

  addMaintainedSection("Zettelkasten method", [
    "The permanent 🧠 Zettelkasten hub turns ordinary Nexus pages into a connected atomic-note system. Use Fleeting / Inbox for raw ideas, Literature for source-derived notes, Permanent notes for your own durable claims, and MOCs / Indexes to organize a topic without turning every note into a folder.",
    "Each Zettel receives a stable ID such as 20260919094830-a1b2c3. The ID identifies the note even if you later change its title. Write one idea per permanent note, in your own words, then connect it with [[Page links]] so backlinks and Graph view expose the surrounding knowledge web.",
    "Use Process next to work through the oldest inbox/fleeting note. Promote useful fleeting or literature notes to Permanent. Use Topics to maintain a small set of meaningful tags, and use Unconnected to find notes that have no incoming or outgoing page links yet.",
    "Use MOC / Index for a normal page that acts as a curated entry point to a subject. Use Adopt current page when an existing Nexus page should become part of your Zettelkasten. Related notes are ranked from real page links, backlinks and shared Zettel tags; an unrelated note is not treated as related merely because it is a Zettel. All Zettels remain ordinary Nexus pages, so search, backlinks, graph, transclusion, tasks, database views, backup/restore, version history, locks and sync continue to work.",
    "Zettelkasten maintenance rule: whenever note types, IDs, inbox processing, links, MOCs, filters, connection logic, creation workflow or other user-visible Zettelkasten behavior changes, update this Help section and feature catalog in the same release, bump NEXUS_HELP_GUIDE_VERSION, and run npm test."
  ]);

  addMaintainedSection("Passcode re-entry interval", [
    "When the passcode lock is enabled, Nexus can require the passcode again after an elapsed session interval. Choose 1 hour, 6 hours, 12 hours or 24 hours in Settings → Privacy → Re-enter passcode every.",
    "The interval begins after each successful passcode unlock and is based on elapsed time rather than typing activity, so leaving Nexus open does not silently keep the notebook unlocked forever. When the app is backgrounded, Nexus checks the interval again as soon as it returns to the foreground.",
    "Before an automatic re-lock, Nexus makes a best-effort save while the encryption key is still available, then clears the in-memory key and shows the normal lock screen. Changing the interval while unlocked restarts the timer from that moment. A fresh page load still requires the passcode immediately, regardless of the selected interval.",
    "The re-entry timer uses elapsed time and checks its absolute deadline while Nexus is in the foreground. When the deadline is reached, Nexus starts a final local save and then locks the app immediately; the pending encrypted save keeps the session key it captured before the lock. Passcode, recovery-key, settings and other higher-level overlays are closed so the lock screen cannot be hidden behind another dialog.",
    "Developer release rule: whenever passcode session timing, automatic re-lock behavior, interval choices, save-before-lock behavior, overlay handling or related privacy UI changes, update this Help section, the feature catalog and the guide version in the same release and run the full regression suite."
  ]);

  addMaintainedSection("Launch passcode policy & device auto-unlock", [
    "Settings → Privacy → Request passcode on launch controls what Nexus does after a real browser/app launch. On means the lock screen is shown on launch. Off means Nexus may auto-unlock this browser profile without asking, provided the normal 1/6/12/24-hour re-entry deadline has not expired.",
    "When launch prompting is Off, Nexus stores a device-local Web Crypto key in its IndexedDB security store. The key is not included in Backup/Restore, Google Drive sync, LAN sync or notebook exports, and it is deleted when you manually lock Nexus, remove the passcode, enable launch prompting again, or the re-entry interval expires.",
    "The selected re-entry interval remains authoritative. Auto-unlock does not restart or extend it: Nexus checks the persisted absolute deadline on startup and throughout the session. Once the deadline is reached, Nexus clears the auto-unlock key and requires the passcode.",
    "Turning launch prompting Off is a convenience/security trade-off: anyone who can access the same browser profile or device during the active re-entry interval can open the protected notebook without entering the passcode. Keep it On on shared or otherwise untrusted devices.",
    "Developer release rule: whenever launch policy, auto-unlock storage, expiry, lock behavior or the security warning changes, update this Help section, the feature catalog, the guide version and regression tests in the same release."
  ]);

  addMaintainedSection("Folder organization & nested folders", [
    "Folders are a sidebar organization layer for pages. Click + folder to create a top-level folder, or use a folder’s + / New subfolder action to create nested folders to any practical depth.",
    "Pages can be moved into folders from a page’s right-click menu with Move to folder…, or by dragging a page onto a folder. The folder tree shows the hierarchy, page counts and expandable/collapsible children; the folder filter searches folder names, paths and pages inside them.",
    "Right-click a folder for New subfolder, Rename, Move, Collapse/Expand and Delete. Deleting a folder is safe: its pages and subfolders are moved to the folder’s parent rather than silently destroyed. Folder paths are used for navigation and remain separate from page titles, tags and Zettelkasten links.",
    "Folder assignments are metadata on the existing page objects, so they survive reloads, Backup/Restore, Version History and device sync. Locked pages cannot be moved through the sidebar menu because a lock keeps the page organization metadata protected from casual changes.",
    "Developer release rule: whenever folder fields, nested hierarchy, moving, drag/drop, sidebar rendering or organization behavior changes, update this Help section, the feature catalog and the guide version in the same release."
  ]);

  addMaintainedSection("Mobile Zettelkasten collapse & expand", [
    "On phone and tablet widths, Zettelkasten behaves as its own drawer instead of replacing the editor. Open 🧠 Zettelkasten from the sidebar, then use « Zettelkasten in the hub header to collapse the drawer without changing the state of the main navigation sidebar.",
    "When the Zettelkasten drawer is collapsed, the current editor/content page remains visible and expands to the full available content width. A floating 🧠 Zettelkasten button appears near the top of the content area; tap it to reopen the drawer. When expanded, the drawer sits above the content with a dimmed backdrop and a clear ✕ Close control.",
    "The collapsed/expanded preference is stored on the device and survives navigation, orientation changes and reloads. Closing the Zettelkasten hub does not overwrite the preference, so reopening the hub restores the last mobile drawer state.",
    "Main-sidebar independence rule: Zettelkasten collapse/expand never writes or toggles the main sidebar's collapsed state. Future changes to mobile Zettelkasten controls, drawer animation, persistence or content sizing must update this Help section, the feature catalog and the guide version in the same release."
  ]);

  addMaintainedSection("Central Command Center", [
    "⚡ Command Center is Nexus's central control room. It is a workspace surface, not a replacement for Dashboard, and it never creates a second source of truth.",
    "Open it from the permanent sidebar button or press ⌘⇧K (Ctrl+Shift+K on Windows/Linux). Search commands such as task, database, query, Zettelkasten, backup, settings or sync; press Enter to run the first matching command. Esc clears the search or closes the hub.",
    "The hub provides live counts, command groups for navigation/work, knowledge, capture, creation, context and system actions, recent pages, current-page context and the current save-health indicator. Use ⌘K Command palette when you need the compact palette instead.",
    "Developer release rule: whenever Command Center commands, shortcuts, categories, navigation, creation actions, health summaries or user-visible behavior change, update this Help section, register the topic in the feature catalog, bump the guide version and run npm test in the same release."
  ]);

  addMaintainedSection("Workspace tabs", [
    "Nexus tabs keep multiple pages and major Nexus hubs open at the top of the app without replacing the main sidebar. Opening a page or supported hub automatically adds it to the tab strip and activates it.",
    "Click a tab to switch instantly. Use the × on a tab to close it, ＋ to open a new page, or the ⋯ menu to close other tabs or close all tabs. Closing the active tab moves you to a neighboring tab when possible, otherwise Nexus returns to the current page.",
    "Tabs are stored separately from notebook content, so tab layout is a local UI preference. The open-tab list and active tab survive navigation and reload when their targets still exist; missing or deleted pages are removed safely.",
    "On mobile the tab strip scrolls horizontally and keeps touch targets large enough for tapping. The tabs system is independent from the main navigation sidebar and does not change sidebar collapse state."
  ]);

  addMaintainedSection("Pinned tabs & sidebar drag-and-drop ordering", [
    "Tabs can be pinned with the small 📌 control on each tab or with Ctrl/Cmd+Shift+P on the active tab. Pinned tabs stay at the front of the tab strip and are protected from accidental closing; unpin a tab before closing it.",
    "Close other tabs and Close all tabs keep pinned tabs. Closing or deleting a page removes its tab safely, while pinned tabs for still-existing pages survive navigation and reload because tab state is stored as a local UI preference.",
    "The fixed navigation controls at the top of the sidebar can be reordered by dragging the ⠿ handle beside an action. The order is stored on this device and does not alter notebook data, page order, folders or tags. Use the Developer/Help tooling reset action if you need to restore the original navigation order.",
    "Page entries already support drag-and-drop ordering within the Pinned and Unfiled lists, and folder pages can be dragged into folders. Search-filtered lists intentionally do not expose reordering so relevance ranking cannot be accidentally converted into saved order.",
    "Developer release rule: whenever tab pinning, tab close semantics, tab ordering, sidebar navigation ordering, drag/drop affordances or related persistence changes, update this Help section, the feature catalog, guide version and regression tests in the same release."
  ]);

  addMaintainedSection("Mobile sidebar always-visible toggle", [
    "On phone and tablet widths, the main sidebar has a persistent floating toggle that is always visible in the viewport. When the sidebar is closed, the button shows ☰ and expands the navigation drawer; when the drawer is open, the same button changes to « and collapses it.",
    "The floating toggle is intentionally separate from the sidebar contents, so it remains reachable even after you scroll through a long navigation list. On touch devices it uses a large 44px target and respects safe-area insets.",
    "The mobile toggle controls only the main navigation sidebar. It does not change the state of Zettelkasten's independent mobile drawer, Command Center, tabs or the current page. The chosen sidebar state is still persisted locally and restored on navigation/reload.",
    "Developer release rule: whenever mobile sidebar controls, placement, collapse/expand behavior, touch interaction or persistence changes, update this Help section, the feature catalog and guide version in the same release and run the full regression suite."
  ]);

  addMaintainedSection("Safety, recovery & good operating practice", [
    "Nexus is local-first, but browser storage is still controlled by the browser and operating system. Keep at least one independent manual backup for important notebooks, especially before clearing site data, changing browsers or migrating devices.",
    "Persistent browser storage lowers eviction risk but cannot protect against device loss, browser-profile deletion or a damaged backup. Test a restore occasionally on a second copy so your recovery process is proven, not assumed.",
    "When Google Drive or another sync method reports a conflict or warning, use the visible status and conflict tools before making more edits."
  ]);

  page.helpGuideVersion = NEXUS_HELP_GUIDE_VERSION;
  page.helpGuideUpdatedAt = Date.now();
  page.updatedAt = page.helpGuideUpdatedAt;
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
    var beforeBootNormalization = JSON.stringify(state);
    ensureDocsPage();
    if(typeof ensureDatabaseWorkspace === 'function') ensureDatabaseWorkspace();
    if(typeof ensureQueryWorkspace === 'function') ensureQueryWorkspace();
    if(typeof ensureStickyNotesWorkspace === 'function') ensureStickyNotesWorkspace();
    if(typeof ensureZettelkastenMetadata === 'function') ensureZettelkastenMetadata();
    if(typeof ensureFolderState === 'function') ensureFolderState();
    var docsId = state.titleIndex[DOCS_TITLE.toLowerCase()];
    ensureCompleteHelpGuide(docsId);
    ensureDefaultTemplates();
    ensureSyncMeta();
    var afterBootNormalization = JSON.stringify(state);
    /* Persist automatic migrations (docs/templates/sync metadata) without
       polluting undo history or pretending the user just edited the file. */
    if(beforeBootNormalization !== afterBootNormalization){
      enqueueNotebookPersist(afterBootNormalization).catch(function(){
        if(typeof setDataHealthStatus === 'function') setDataHealthStatus('warning', 'Migration changes are not yet saved');
      });
    }
    lastSnapshotJson = afterBootNormalization; /* baseline so the very first edit is undoable */
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
  if(!parsed.flashcards || typeof parsed.flashcards !== 'object') parsed.flashcards = {decks:{}, cards:{}};
  if(!parsed.flashcards.decks || typeof parsed.flashcards.decks !== 'object') parsed.flashcards.decks = {};
  if(!parsed.flashcards.cards || typeof parsed.flashcards.cards !== 'object') parsed.flashcards.cards = {};
  if(!parsed.stickyNotes || typeof parsed.stickyNotes !== 'object') parsed.stickyNotes = {cards:{}};
  if(!parsed.stickyNotes.cards || typeof parsed.stickyNotes.cards !== 'object') parsed.stickyNotes.cards = {};
  if(!parsed.folders || typeof parsed.folders !== 'object' || Array.isArray(parsed.folders)) parsed.folders = {};
  Object.keys(parsed.folders).forEach(function(id){
    var folder = parsed.folders[id];
    if(!folder || typeof folder !== 'object'){ delete parsed.folders[id]; return; }
    folder.id = folder.id || id;
    folder.name = String(folder.name == null ? 'Untitled folder' : folder.name).trim() || 'Untitled folder';
    folder.parentId = folder.parentId || null;
    folder.collapsed = !!folder.collapsed;
    if(folder.deletedAt && !folder.updatedAt) folder.updatedAt = folder.deletedAt;
  });
  Object.keys(parsed.folders).forEach(function(id){
    var seen = {}; var cur = id;
    while(cur && parsed.folders[cur]){
      if(seen[cur]){ parsed.folders[id].parentId = null; break; }
      seen[cur] = true;
      var next = parsed.folders[cur].parentId;
      if(next && (!parsed.folders[next] || parsed.folders[next].deletedAt)){ parsed.folders[cur].parentId = null; break; }
      cur = next;
    }
  });
  Object.keys(parsed.pages).forEach(function(id){
    var page = parsed.pages[id];
    if(page && page.folderId && (!parsed.folders[page.folderId] || parsed.folders[page.folderId].deletedAt)) delete page.folderId;
  });
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
    normalizePageAppearance(page);
    page.properties = Array.isArray(page.properties) ? page.properties : [];
    page.rootBlocks = Array.isArray(page.rootBlocks) ? page.rootBlocks : [];
    if(page.type === 'tag'){
      page.isSupertag = !!page.isSupertag;
      page.supertagFields = Array.isArray(page.supertagFields) ? page.supertagFields : [];
    }
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

/* Parse persisted notebook data without ever converting a storage/read
   failure or malformed on-disk record into a brand-new notebook. A fresh
   notebook is only created by loadAsync() when both persistent stores are
   genuinely empty. This boundary is deliberately separate from
   parseLoadedState(), which remains lenient for older non-persistence paths. */
function parsePersistedState(raw){
  if(typeof raw !== 'string' || !raw.trim()) throw new Error('Stored notebook data is empty or unavailable.');
  var parsed;
  try{ parsed = JSON.parse(raw); }
  catch(e){ throw new Error('Stored notebook data is corrupted and could not be parsed.'); }
  if(!parsed || typeof parsed !== 'object' || !parsed.pages || typeof parsed.pages !== 'object' ||
     !parsed.blocks || typeof parsed.blocks !== 'object') throw new Error('Stored notebook data has an invalid structure.');
  return normalizeState(parsed);
}

/* Loads the notebook from IndexedDB. The very first time a returning
   user hits this after upgrading, NB_STORE will be empty but their
   notebook may still be sitting in localStorage under STORAGE_KEY from
   before this migration — if so, that copy is imported into IndexedDB
   once and then cleared out of localStorage. New/empty notebooks fall
   through to seedState(). Returns a Promise<state object>. */
function loadAsync(){
  return getNotebookState().then(function(raw){
    if(raw !== null && raw !== undefined) return parsePersistedState(raw);
    var legacy;
    try{ legacy = localStorage.getItem(STORAGE_KEY); }catch(e){
      throw new Error('Nexus could not read its legacy local storage notebook: ' + (e && e.message ? e.message : 'storage access failed'));
    }
    if(!legacy) return seedState();
    return putNotebookState(legacy).then(function(){
      try{ localStorage.removeItem(STORAGE_KEY); }catch(e){}
      return parsePersistedState(legacy);
    }).catch(function(){
      /* A legacy copy is still safe to use for this session when the IDB
         migration write fails, but do not erase the legacy source. Surface
         the persistence failure so the user knows edits may not be durable. */
      try{ window.NEXUS_PERSISTENCE_MIGRATION_WARNING = true; }catch(ignore){}
      return parsePersistedState(legacy);
    });
  });
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
function enqueueNotebookPersist(json, keyOverride){
  /* Serialize all IndexedDB writes. Encryption is async, so without a queue
     an older save can finish after a newer one and overwrite it on disk.
     keyOverride lets a lock-boundary flush keep using the pre-lock DEK. */
  persistQueue = persistQueue.catch(function(){}).then(function(){ return putNotebookState(json, keyOverride); });
  return persistQueue;
}
function save(options){
  options = options || {};
  if(typeof invalidatePageRefsMapCache === 'function') invalidatePageRefsMapCache();
  if(options.touchEntities !== false) touchChangedEntities();
  if(options.recordUndo !== false) recordUndoCheckpoint();
  var doBroadcast = !suppressBroadcast && options.broadcast !== false;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function(){
    var json = JSON.stringify(state);
    enqueueNotebookPersist(json).then(function(){
      updateStorageHint();
      if(typeof setDataHealthStatus === 'function') setDataHealthStatus('saved', 'Saved locally');
      if(doBroadcast) broadcastStateToPeers();
    }).catch(function(err){
      toast("Could not save — storage may be full.");
      if(typeof setDataHealthStatus === 'function') setDataHealthStatus('error', 'Save failed — check storage');
      try{ console.error('Nexus save failed:', err); }catch(ignore){}
    });
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
  try{ json = JSON.stringify(state); }catch(e){ return Promise.resolve(false); }
  var capturedKey = (typeof lockCryptoKey !== 'undefined') ? lockCryptoKey : null;

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
    return enqueueNotebookPersist(json, capturedKey).then(function(){
      if(!isLockEnabled()){
        try{ localStorage.removeItem(STORAGE_KEY); }catch(e){}
      }
      if(typeof setDataHealthStatus === 'function') setDataHealthStatus('saved', 'Saved locally');
      return true;
    }).catch(function(err){
      if(typeof setDataHealthStatus === 'function') setDataHealthStatus('error', 'Save failed — data may be pending');
      try{ console.error('Nexus flush failed:', err); }catch(ignore){}
      return false;
    });
  }catch(e){
    return Promise.resolve(false);
  }
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
    if(shallowFieldsChanged(prevPages[id], cur, ['title','type','properties','trashedAt','rootBlocks','folderId'])){
      cur.updatedAt = now; cur.updatedBy = state.deviceId;
    }
    if(!cur.createdAt) cur.createdAt = now;
  });
  /* Flashcards use the same lightweight LWW metadata as pages/blocks so
     reviews and edits participate in undo, backup and device sync. Deletion
     is represented by deletedAt rather than removing the record outright. */
  var prevFc = prev && prev.flashcards || {decks:{}, cards:{}};
  var curFc = state.flashcards || {decks:{}, cards:{}};
  var prevSn = prev && prev.stickyNotes || {cards:{}};
  var curSn = state.stickyNotes || {cards:{}};
  var prevFolders = (prev && prev.folders) || {};
  var curFolders = state.folders || {};
  Object.keys(curFc.decks || {}).forEach(function(id){
    var cur = curFc.decks[id];
    if(shallowFieldsChanged(prevFc.decks && prevFc.decks[id], cur, ['name','deletedAt'])){ cur.updatedAt = now; cur.updatedBy = state.deviceId; }
    if(!cur.createdAt) cur.createdAt = now;
  });
  Object.keys(curFc.cards || {}).forEach(function(id){
    var cur = curFc.cards[id];
    if(shallowFieldsChanged(prevFc.cards && prevFc.cards[id], cur, ['deckId','front','back','tags','sourcePageId','sourceBlockId','dueAt','interval','ease','reps','lapses','state','suspended','deletedAt'])){ cur.updatedAt = now; cur.updatedBy = state.deviceId; }
    if(!cur.createdAt) cur.createdAt = now;
  });
  Object.keys(curSn.cards || {}).forEach(function(id){
    var cur = curSn.cards[id];
    if(shallowFieldsChanged(prevSn.cards && prevSn.cards[id], cur, ['title','text','color','pinned','archived','tags','sourcePageId','sourceBlockId','deletedAt'])){ cur.updatedAt = now; cur.updatedBy = state.deviceId; }
    if(!cur.createdAt) cur.createdAt = now;
  });
  Object.keys(curFolders || {}).forEach(function(id){
    var cur = curFolders[id];
    if(shallowFieldsChanged(prevFolders[id], cur, ['name','parentId','collapsed','deletedAt'])){ cur.updatedAt = now; cur.updatedBy = state.deviceId; }
    if(!cur.createdAt) cur.createdAt = now;
  });
  Object.keys(prevFolders).forEach(function(id){
    if(!state.folders || !state.folders[id]){
      if(!state.folders) state.folders = {};
      state.folders[id] = {id:id,name:'Deleted folder',parentId:null,deletedAt:now,updatedAt:now,updatedBy:state.deviceId};
    }
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
    if(typeof invalidatePageRefsMapCache === 'function') invalidatePageRefsMapCache();
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
    flashcards: {decks:{}, cards:{}},
    stickyNotes: {cards:{}},
    folders: {},
    currentPageId: local.currentPageId,
    dailyShowAll: local.dailyShowAll,
    deviceId: local.deviceId,
    /* Sync cursors are local relationship metadata. Never import the
       remote device's view of its peers into this device. */
    syncPeers: JSON.parse(JSON.stringify(local.syncPeers || {}))
  };
  var conflicts = [];

  function mergeFlashcardMap(localMap, remoteMap){
    var out = {};
    var ids = Object.keys(localMap || {}).concat(Object.keys(remoteMap || {})).filter(function(id,i,arr){ return arr.indexOf(id)===i; });
    ids.forEach(function(id){
      var winner = pickWinner(localMap && localMap[id], remoteMap && remoteMap[id]);
      if(winner) out[id] = JSON.parse(JSON.stringify(winner));
    });
    return out;
  }
  merged.flashcards.decks = mergeFlashcardMap(local.flashcards && local.flashcards.decks, remote.flashcards && remote.flashcards.decks);
  merged.flashcards.cards = mergeFlashcardMap(local.flashcards && local.flashcards.cards, remote.flashcards && remote.flashcards.cards);
  merged.stickyNotes.cards = mergeFlashcardMap(local.stickyNotes && local.stickyNotes.cards, remote.stickyNotes && remote.stickyNotes.cards);
  merged.folders = mergeFlashcardMap(local.folders, remote.folders);

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

  /* Rebuild sibling arrays using the winning copy of each container first.
     This preserves ordinary reorder operations much better than sorting every
     merged block by one scalar order value (which could come from a different
     device). Any newly introduced/missing siblings are then appended in a
     deterministic order so both devices converge to the same structure. */
  Object.keys(merged.pages).forEach(function(pid){ merged.pages[pid].rootBlocks = []; });
  Object.keys(merged.blocks).forEach(function(bid){ merged.blocks[bid].children = []; });

  var placedOrder = {};
  function addRoot(pid, bid){
    var b = merged.blocks[bid];
    if(!b || b.pageId !== pid || b.parent) return;
    if(placedOrder[bid]) return;
    merged.pages[pid].rootBlocks.push(bid); placedOrder[bid] = true;
  }
  function addChild(parentId, bid){
    var parent = merged.blocks[parentId], b = merged.blocks[bid];
    if(!parent || !b || b.parent !== parentId || b.pageId !== parent.pageId) return;
    if(placedOrder[bid]) return;
    parent.children.push(bid); placedOrder[bid] = true;
  }

  Object.keys(merged.pages).forEach(function(pid){
    var wp = pickWinner(local.pages[pid], remote.pages[pid]);
    (wp && wp.rootBlocks || []).forEach(function(bid){ addRoot(pid, bid); });
  });
  Object.keys(merged.blocks).forEach(function(parentId){
    var parent = merged.blocks[parentId];
    var wb = pickWinner(local.blocks[parentId], remote.blocks[parentId]);
    (wb && wb.children || []).forEach(function(bid){ addChild(parentId, bid); });
  });

  var unplaced = Object.keys(merged.blocks).map(function(id){ return merged.blocks[id]; })
    .filter(function(b){ return !placedOrder[b.id]; });
  unplaced.sort(function(x,y){
    return (x.order||0)-(y.order||0) || (x.updatedAt||0)-(y.updatedAt||0) || (x.id<y.id?-1:1);
  });
  unplaced.forEach(function(b){
    if(b.parent && merged.blocks[b.parent]) addChild(b.parent, b.id);
    else if(merged.pages[b.pageId]){ b.parent = null; addRoot(b.pageId, b.id); }
  });

  merged.titleIndex = rebuildTitleIndex(merged);
  if(!merged.currentPageId || !merged.pages[merged.currentPageId]){
    merged.currentPageId = Object.keys(merged.pages)[0];
  }
  merged = normalizeState(merged);
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
  if(typeof invalidatePageRefsMapCache === 'function') invalidatePageRefsMapCache();
  suppressBroadcast = true;
  /* Remote entities already carry their authoritative updatedAt/updatedBy.
     Persist the merge without pretending those changes were made locally. */
  save({touchEntities:false});
  suppressBroadcast = false;
  renderAll();
}

/* ============================================================
   USABLE VIEWPORT
   The part of the screen a popup/menu can safely occupy. On a phone
   the on-screen keyboard shrinks only the *visual* viewport —
   window.innerHeight (what fixed-position math normally uses) stays
   the same, so a menu placed with it can end up hidden behind the
   keyboard. This also subtracts the docked edit bar when it's showing
   (see 19-mobile-editor.js), so menus land above it instead of under.
   Returns {top, bottom} in the same client-pixel space as
   getBoundingClientRect(). On desktop it's just the window.
   ============================================================ */
function usableViewport(){
  var top = 0, bottom = window.innerHeight;
  var vv = window.visualViewport;
  if(vv && vv.scale <= 1.01){ top = vv.offsetTop; bottom = vv.offsetTop + vv.height; }
  var dock = document.getElementById('edit-dock');
  if(dock && dock.getClientRects().length && window.getComputedStyle(dock).position === 'fixed'){
    bottom = Math.min(bottom, dock.getBoundingClientRect().top);
  }
  return {top: top, bottom: bottom};
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
    + '<button type="button" class="att-dl-btn" title="Download image" aria-label="Download '+escapeHtml(parsed.name||'image')+'">⬇</button>'
    + '</span>';
}
function renderFileHtml(raw){
  var parsed = parseAttRef(raw);
  return '<span class="att-file" data-att-id="'+escapeHtml(parsed.id)+'" data-att-name="'+escapeHtml(parsed.name)+'">'
    + '<span class="att-file-icon">📎</span>'
    + '<a class="att-file-link" data-att-id="'+escapeHtml(parsed.id)+'" href="#" target="_blank">'+escapeHtml(parsed.name||'file')+'</a>'
    + '<button type="button" class="att-dl-btn" title="Download file" aria-label="Download '+escapeHtml(parsed.name||'file')+'">⬇</button>'
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
  var dlBtn = document.createElement('button');
  dlBtn.type = 'button'; dlBtn.className = 'att-dl-btn';
  dlBtn.title = 'Download image'; dlBtn.textContent = '⬇';
  dlBtn.setAttribute('aria-label', 'Download ' + (parsed.name || 'image'));
  wrap.appendChild(dlBtn);
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
  var dlBtn = document.createElement('button');
  dlBtn.type = 'button'; dlBtn.className = 'att-dl-btn';
  dlBtn.title = 'Download file'; dlBtn.textContent = '⬇';
  dlBtn.setAttribute('aria-label', 'Download ' + (parsed.name || 'file'));
  wrap.appendChild(dlBtn);
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
      var rawTxPage = '![[' + m[1] + ']]';
      out += renderExplicitTransclusion(rawTxPage, depth, state.currentPageId);
    } else if(m[2] !== undefined){
      var rawTxBlock = '!((' + m[2] + '))';
      out += renderExplicitTransclusion(rawTxBlock, depth, state.currentPageId);
    } else if(m[3] !== undefined){
      var rawTxExplicit = '{{transclude:' + m[3] + '|' + m[4] + '}}';
      out += renderExplicitTransclusion(rawTxExplicit, depth, state.currentPageId);
    } else if(m[5] !== undefined){
      out += '<span class="link" data-target="'+escapeHtml(m[5])+'">'+escapeHtml(m[5])+'</span>';
    } else if(m[6] !== undefined){
      out += '<span class="tag" data-tag="'+escapeHtml(m[6])+'">#'+escapeHtml(m[6])+'</span>';
    } else if(m[7] !== undefined){
      out += renderBlockRefHtml(m[7], depth);
    } else if(m[8] !== undefined){
      out += '<strong>'+decorateText(m[8], depth)+'</strong>';
    } else if(m[9] !== undefined){
      out += '<del>'+decorateText(m[9], depth)+'</del>';
    } else if(m[10] !== undefined){
      out += '<code>'+escapeHtml(m[10])+'</code>';
    } else if(m[11] !== undefined){
      out += '<em>'+decorateText(m[11], depth)+'</em>';
    } else if(m[12] !== undefined){
      out += renderImageHtml(m[12]);
    } else if(m[13] !== undefined){
      out += renderFileHtml(m[13]);
    } else if(m[14] !== undefined){
      out += '<mark class="hl-swatch" data-color="'+escapeHtml(m[14])+'">'+decorateText(m[15], depth)+'</mark>';
    } else if(m[16] !== undefined){
      out += '<span class="clr-swatch" data-color="'+escapeHtml(m[16])+'">'+decorateText(m[17], depth)+'</span>';
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
      frag.appendChild(buildTransclusionNode('![[' + m[1] + ']]', 0, state.currentPageId));
    } else if(m[2] !== undefined){
      frag.appendChild(buildTransclusionNode('!((' + m[2] + '))', 0, state.currentPageId));
    } else if(m[3] !== undefined){
      frag.appendChild(buildTransclusionNode('{{transclude:' + m[3] + '|' + m[4] + '}}', 0, state.currentPageId));
    } else if(m[5] !== undefined){
      var linkEl = document.createElement('span');
      linkEl.className = 'link'; linkEl.dataset.target = m[5]; linkEl.textContent = m[5];
      frag.appendChild(linkEl);
    } else if(m[6] !== undefined){
      var tagEl = document.createElement('span');
      tagEl.className = 'tag'; tagEl.dataset.tag = m[6]; tagEl.textContent = '#'+m[6];
      frag.appendChild(tagEl);
    } else if(m[7] !== undefined){
      var refEl = document.createElement('span');
      refEl.className = 'blockref'; refEl.dataset.refid = m[7];
      var refBlk = state.blocks[m[7]];
      if(!refBlk){ refEl.classList.add('blockref-missing'); refEl.textContent = '(missing block)'; }
      else {
        var preview = refBlk.text || '(empty block)';
        refEl.textContent = preview.length > 60 ? preview.slice(0,60)+'…' : preview;
      }
      frag.appendChild(refEl);
    } else if(m[8] !== undefined){
      var strongEl = document.createElement('strong');
      strongEl.appendChild(buildInlineNodes(m[8]));
      frag.appendChild(strongEl);
    } else if(m[9] !== undefined){
      var delEl = document.createElement('del');
      delEl.appendChild(buildInlineNodes(m[9]));
      frag.appendChild(delEl);
    } else if(m[10] !== undefined){
      var codeEl = document.createElement('code');
      codeEl.textContent = m[10];
      frag.appendChild(codeEl);
    } else if(m[11] !== undefined){
      var emEl = document.createElement('em');
      emEl.appendChild(buildInlineNodes(m[11]));
      frag.appendChild(emEl);
    } else if(m[12] !== undefined){
      frag.appendChild(buildImageNode(m[12]));
    } else if(m[13] !== undefined){
      frag.appendChild(buildFileNode(m[13]));
    } else if(m[14] !== undefined){
      var markEl = document.createElement('mark');
      markEl.className = 'hl-swatch'; markEl.dataset.color = m[14];
      markEl.appendChild(buildInlineNodes(m[15]));
      frag.appendChild(markEl);
    } else if(m[16] !== undefined){
      var clrEl = document.createElement('span');
      clrEl.className = 'clr-swatch'; clrEl.dataset.color = m[16];
      clrEl.appendChild(buildInlineNodes(m[17]));
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
      } else if(n.classList && n.classList.contains('transclusion')){
        out += (n.dataset.transclusionRaw || '');
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
  var re = /!?\[\[([^\]]+)\]\]|#([a-zA-Z0-9_][\w-]*)/g, m;
  while((m = re.exec(text))){
    if(m[1] !== undefined){
      var target = m[1];
      var hash = target.indexOf('#');
      if(hash >= 0) target = target.slice(0, hash);
      target = target.trim();
      if(target) refs.push({type:'page', title:target});
    } else refs.push({type:'tag', title:m[2]});
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
    var re = /!?\(\(([a-zA-Z0-9_-]+)\)\)/g, m, found = false;
    while((m = re.exec(blk.text))){
      var matchStart = m.index;
      if(blk.text.charAt(matchStart) === '!') continue; /* !((…)) is a read-only transclusion, not a sync reference */
      if(m[1] === id){ found = true; break; }
    }
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

