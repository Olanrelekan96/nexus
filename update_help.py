from pathlib import Path
p=Path('/mnt/data/nexus_help_update/js/00-state-and-helpers.js')
s=p.read_text(encoding='utf-8')
needle='''  section("Shortcuts, quick reference", [\n    "⌘K — command palette · ⌘Z / ⌘⇧Z — undo / redo · ⌘B / ⌘I / ⌘E / ⌘⇧X — bold / italic / code / strikethrough",\n    "Tab / Shift+Tab — indent / outdent · Enter — new line · Backspace at start of line — merge up",\n    "⌘B (with sidebar focused) or « / ☰ — collapse or expand the sidebar · Esc — close any open dialog"\n  ]);\n\n  save();\n}'''
insert='''  section("Shortcuts, quick reference", [\n    "⌘K — command palette · ⌘Z / ⌘⇧Z — undo / redo · ⌘B / ⌘I / ⌘E / ⌘⇧X — bold / italic / code / strikethrough",\n    "Tab / Shift+Tab — indent / outdent · Enter — new line · Backspace at start of line — merge up",\n    "⌘B (with sidebar focused) or « / ☰ — collapse or expand the sidebar · ⌘⇧F — Search all notes · Esc — close any open dialog"\n  ]);\n\n  ensureCompleteHelpGuide(pid);\n  save();\n}'''
if needle not in s:
    raise SystemExit('seed needle not found')
s=s.replace(needle,insert,1)
marker='''/* Seeds two starter templates ("Meeting notes" and "Daily journal") the\n'''
if marker not in s:
    raise SystemExit('function insertion marker not found')
func=r'''/* Adds the feature areas introduced after the original Help page was seeded.
   Existing Help content is preserved; the guide is appended once and stamped
   with a version so future releases can extend it again without duplicating
   the same sections on every load. */
var NEXUS_HELP_GUIDE_VERSION = 2;
function ensureCompleteHelpGuide(pid){
  var page = state.pages[pid];
  if(!page || page.helpGuideVersion >= NEXUS_HELP_GUIDE_VERSION) return;
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

  section("Complete feature guide — updated", [
    "This appendix covers the newer Nexus capabilities that may not be obvious from the main tutorial. It is safe to keep this page as a reference, edit it, or add your own notes.",
    "The Help button always opens this page. The built-in guide is updated only when a new guide version is introduced; your own changes are otherwise left alone."
  ]);

  section("Doc mode & outline mode", [
    "Use the top-bar ▤ Doc mode button to switch between the structured outliner and a document-style reading layout. New pages can be configured to open in either mode from Settings.",
    "Outline mode exposes the block hierarchy, drag handles, collapse controls and block actions. Doc mode is useful when you want to read the same page with less editor chrome.",
    "The toolbar can also zoom the page or a specific line when you want to focus on one part of a long outline."
  ]);

  section("Templates", [
    "The Templates section of the sidebar contains starter templates such as Meeting notes and Daily journal. Click a template to insert it into the current page or create a new page from it.",
    "Save any open page as a template from the page menu or the + save page control above Templates. Templates preserve the block hierarchy and text structure, but create fresh block IDs when inserted.",
    "Right-click a template to insert it, create a new page from it, rename it, or delete it. Slash commands can also insert templates by name."
  ]);

  section("Slash commands", [
    "Type / at a word boundary inside an editable line to open the command menu. Keep typing to filter; use ↑/↓, Enter or Tab, and Esc to navigate or dismiss it.",
    "Turn into: Heading 1, Heading 2, Heading 3, To-do, Plain text, and Code block. Insert: Page link, Tag, Today's date, Image or file, Query, and Database view.",
    "Line actions include Indent, Outdent, Duplicate line, Copy block reference, Zoom in on this line, and Delete. Templates appear as searchable slash commands too.",
    "Slash commands ignore normal URLs and fenced code blocks, so typing a web address or code does not unexpectedly open the menu."
  ]);

  section("Context menus & selection tools", [
    "Right-click a block to get the same actions exposed by its ⋯ menu, including Edit, Indent, Outdent, Duplicate, Copy block reference, Zoom, lock controls and deletion where permitted.",
    "Right-click selected text for Bold, Italic, Strikethrough, Code, Link, page-link conversion, tag conversion, Copy, or a search for the selected text.",
    "Right-click a page or tag in the sidebar for Open, Pin/Unpin, Remove from sidebar, Lock/Unlock, Copy page link, Rename, Duplicate, Save as template, Markdown/PDF export, and Trash actions.",
    "Right-click a trashed page to restore it or delete it forever. Right-click a template to insert it, create a page from it, rename it, or delete it. Shift+right-click keeps the browser's normal context menu."
  ]);

  section("Advanced search language", [
    "The sidebar search, Search all notes, command palette, task filters and other search surfaces share the same advanced query language.",
    "Examples: #project finds a tag; [[Meeting Notes]] finds a page link; status:in-progress matches a property; priority:high or priority:1 filters task priority; due:today, before:friday and after:2026-01-01 filter dates; is:done, is:overdue, is:locked and similar flags match state; has:due and has:attachment find lines with those features.",
    "Use >, <, >=, <= or != with property values when appropriate, wrap phrases in quotes, prefix a term with - to exclude it, separate alternatives with |, use OR for separate search groups, and use /regular-expression/flags for regex matching.",
    "Search understands page titles, tags, line text, task metadata and page properties. A pasted URL is treated as normal text rather than mistaken for a property expression."
  ]);

  section("Search all notes", [
    "⌘⇧F opens the full-screen Search all notes view. It searches up to a large result set across every page and line, groups hits by page, shows snippets, and lets you collapse page groups.",
    "The sidebar search is the quick filter. Search all notes is the larger workspace for investigating many matches. Clicking a result opens the page and reveals the matching line."
  ]);

  section("Task manager — advanced", [
    "Every task remains an ordinary [ ] or [x] block, so task metadata survives normal editing, backups, version history and sync.",
    "Priority markers are !p1, !p2 and !p3 (High, Medium, Low). Recurrence markers use !every(Nd), !every(Nw), !every(Nm) or !every(Ny), for example !every(1w). Due dates use !due(YYYY-MM-DD).",
    "The Tasks view can filter by status, priority, page and tag; search with the same advanced operators; sort by due date, page and other fields; group tasks; switch layouts; add tasks quickly; and apply bulk changes to selected tasks.",
    "Tasks are bucketed into Overdue, Today, Next 7 days, Later, No date and Done. Locked tasks remain visible but cannot be edited from the task manager."
  ]);

  section("Queries & database views — advanced", [
    "A {{query: ...}} block is a live, auto-updating block search. A {{table: ...}} block is a live page database driven by the same advanced filters.",
    "Database views support Table, Board and Gallery layouts. Board views can group by a property; tables can choose columns, sort direction, and per-column totals; cells can be edited inline where the property type allows it.",
    "A database block can contain multiple saved views. Use + view to add one, switch tabs to change views, double-click a tab to rename it, and ✕ to remove a view when more than one exists.",
    "Supported structured property types include Text, Number, Date, Checkbox, Select, Multi-select, Rating, Relation, Rollup and Formula. Relations are clickable and show reciprocal Related pages."
  ]);

  section("Block references & live embeds", [
    "Hover a block and click ⚭ to copy its ((block-id)) reference. Paste that reference anywhere to embed the block's live content.",
    "Every embed reads the same underlying block, so edits made at the source or through a permitted edit path appear everywhere that block is referenced. A small count badge indicates other references.",
    "References have a depth limit to prevent circular or deeply nested embeds from causing an infinite render. Missing references are displayed safely instead of breaking the page."
  ]);

  section("Page organization & sidebar controls", [
    "Pages can be pinned or unpinned to control the top of the sidebar. Remove from sidebar hides a live page without trashing it; hidden pages remain searchable, linkable and accessible from the Hidden section.",
    "Pages can be duplicated with their properties and outline structure. Page actions also include Copy link, Rename, Save as template, Markdown/PDF export, and Trash.",
    "The sidebar can be collapsed from its controls or with ⌘/Ctrl+B. On narrow screens it behaves as a drawer and automatically closes after navigation."
  ]);

  section("Locks & read-only protection", [
    "Settings → Privacy provides the app-wide passcode lock, which encrypts local notebook storage when enabled. The lock screen can be triggered immediately, and a recovery key is available for account recovery on this device.",
    "A page can be locked from its page menu. A locked page is read-only: its title, properties and blocks cannot be edited, and destructive page actions are disabled.",
    "A block can be locked from its ⋯ / context menu. A locked block and everything nested beneath it become read-only. Unlocking is available at the point where the lock was originally set; descendants explain when a lock comes from an ancestor.",
    "Find & replace and the task manager honor locks, so bulk editing cannot silently bypass read-only protection."
  ]);

  section("Attachments & storage", [
    "Images and other files live in a separate IndexedDB attachment store. The text of a note contains only a lightweight attachment reference, which keeps undo/version history and notebook text independent from file bytes.",
    "The Attachments sidebar lists stored files, including unused ones. Download an attachment at any time; deleting a {{img:...}} or {{file:...}} reference does not automatically destroy the underlying file.",
    "Settings → Data health reports stored attachment count and size, identifies orphaned attachments that are no longer referenced by notes, and can clean them up permanently after you review your backups.",
    "Backups are the supported way to move attachment bytes to another device. LAN/Google sync carries notebook state and references, while a device still needs the actual attachment bytes."
  ]);

  section("Data health & diagnostics", [
    "Settings → Data health opens the Nexus data-health dashboard. It reports page/block counts, notebook size, attachment usage, orphaned files, version-snapshot usage, last backup, browser storage usage, storage policy, device identity, Google Drive status and conflict count.",
    "Protect local storage asks the browser for persistent storage. A browser may approve or decline; persistent storage reduces eviction risk but is not a replacement for independent backups.",
    "Run diagnostics checks IndexedDB, Web Crypto, service-worker support, notebook loading, the absence of an embedded live Google API key in the distributable HTML, required core functions, and attachment-reference health.",
    "The small save-status indicator also reports Saved locally, Offline — saved locally, warning or error states so you can see whether the latest work has reached local persistence."
  ]);

  section("Backup, automatic backup & version history", [
    "⭳ Backup (export) creates a portable JSON notebook backup containing notebook state and attachment bytes. In supported Chromium-based browsers, Nexus can open a native Save As picker; otherwise the browser downloads the file normally.",
    "Settings lets you choose backup reminders (3, 7, 14 days or never) and automatic backup schedules (daily, every 3 days, every 7 days or off). When supported, you can choose and forget a backup folder for automatic backups.",
    "↺ Version history stores automatic snapshots, including a safety snapshot before restores and before operations such as Find & replace. You can inspect snapshots, compare them with the current notebook, and restore a selected snapshot.",
    "Version history is separate from in-tab Undo. Undo/Redo is immediate editing history in memory; Version history is the recovery path that survives reloads."
  ]);

  section("Google Drive sync & credentials", [
    "Settings → Google Drive connection stores the OAuth Client ID and browser API key locally on this device. The API key is not a password; restrict it in Google Cloud Console by allowed web origins/referrers and the APIs Nexus actually uses.",
    "Export to Google Drive and Import from Google Drive let you move a backup through your Drive account. Auto-sync with Google Drive can merge a small notebook-state file roughly once a minute while this tab is open; Sync now triggers it immediately.",
    "The Google Drive connection lifetime setting controls how long Nexus may quietly maintain the connection before requiring another sign-in. Google's access-token lifetime is separate and can still require reauthentication.",
    "Credentials can be cleared from this device at any time. Treat exported backup files as sensitive because the app passcode does not encrypt exported JSON files."
  ]);

  section("LAN device sync", [
    "⇄ Sync devices uses direct WebRTC peer connections on the local network. Pair two devices at the same time through the Sync dialog using the short codes shown there.",
    "LAN sync carries notebook state, not attachment bytes. Changes are merged using each record's edit metadata; conflicting edits are surfaced in the Sync conflicts view so you can keep the retained version, use the dropped version instead, or recover the dropped text as a new line.",
    "Reordering is merged using the notebook's block/container structure rather than relying only on a single last-writer order value, reducing accidental loss of sibling ordering during sync."
  ]);

  section("Import & export options", [
    "Import Markdown files turns Markdown documents into Nexus pages and block structures. The import flow is intended for bringing existing notes into the notebook rather than replacing the current notebook silently.",
    "Export page as Markdown produces a portable text representation of the open page. Export page as PDF produces a print-friendly PDF representation of the current page.",
    "Full Backup/Restore is different from page export: it preserves the whole notebook model, including pages, blocks, properties, templates, sync metadata and attachment bytes."
  ]);

  section("PWA / install / offline", [
    "Nexus ships a manifest and app icons and can be installed as a Progressive Web App when the browser supports installation. The Install app button appears when the browser exposes the install prompt.",
    "The companion sw.js service worker caches the app shell for offline startup. Install and reliable service-worker behavior require https:// or localhost; opening the HTML through a blob preview does not provide the same guarantees.",
    "The Download sw.js button is a deployment fallback: place the downloaded sw.js beside index.html on the same origin, then reload Nexus."
  ]);

  section("Settings & personalization", [
    "Appearance: choose Small, Medium or Large text and one of Paper, Dark, Slate, Sepia, Ocean, Rose, High Contrast or Midnight themes.",
    "Editing: choose whether new pages open in Outline mode or Doc mode, and turn browser spellcheck on or off.",
    "Safety: configure backup reminders, automatic backups and automatic Google Drive sync, inspect Data health, request persistent storage, and choose whether deleting a page asks for confirmation first.",
    "Privacy: set, change, regenerate recovery information for, or remove the passcode lock. Removing the passcode returns local storage to an unencrypted-at-rest state."
  ]);

  section("Mobile editing", [
    "On phones and tablets, Nexus tracks the visual viewport so the on-screen keyboard does not cover the editor or docked formatting controls.",
    "The mobile edit dock provides quick editing controls and a Done button to hide the keyboard. Caret scrolling keeps the active line visible as the keyboard appears.",
    "The sidebar becomes a drawer on narrow screens, navigation closes it automatically, and touch-friendly controls are used for block actions, menus and editing."
  ]);

  section("Safety, recovery & good operating practice", [
    "Nexus is local-first, but browser storage is still controlled by the browser and operating system. Keep at least one independent manual backup for important notebooks, especially before clearing site data, changing browsers or migrating devices.",
    "Persistent browser storage lowers eviction risk but cannot protect against device loss, browser-profile deletion or a damaged backup. Test a restore occasionally on a second copy so your recovery process is proven, not assumed.",
    "When Google Drive or another sync method reports a conflict or warning, use the visible status and conflict tools before making more edits."
  ]);

  page.helpGuideVersion = NEXUS_HELP_GUIDE_VERSION;
  page.helpGuideUpdatedAt = Date.now();
  page.updatedAt = page.helpGuideUpdatedAt;
}

'''
s=s.replace(marker,func+marker,1)
# Ensure existing docs are updated too: call updater after ensureDocsPage resolves the actual page id.
old='''    state = loaded;\n    var beforeBootNormalization = JSON.stringify(state);\n    ensureDocsPage();\n    ensureDefaultTemplates();'''
new='''    state = loaded;\n    var beforeBootNormalization = JSON.stringify(state);\n    ensureDocsPage();\n    var docsId = state.titleIndex[DOCS_TITLE.toLowerCase()];\n    ensureCompleteHelpGuide(docsId);\n    ensureDefaultTemplates();'''
if old not in s:
    raise SystemExit('init needle not found')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
