/* Regression tests for bugs found in the engineering audit pass.
 * Pure-logic checks run here in Node (no browser needed); the browser-level
 * counterparts live in tests/e2e/nexus_e2e.py. Each block names the bug it guards. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

/* Pull one top-level function out of a source file (closing brace at column 0). */
function extractFn(src, name) {
  const start = src.search(new RegExp('^function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, 'function ' + name + ' not found');
  const rest = src.slice(start);
  const end = rest.search(/^}/m);
  assert.ok(end >= 0, 'end of ' + name + ' not found');
  return rest.slice(0, end + 1);
}
function sandbox(code, globals) {
  const ctx = vm.createContext(Object.assign({}, globals || {}));
  vm.runInContext(code, ctx);
  return ctx;
}

/* --- escapeHtml must be total: numeric footnote labels used to throw "str.replace is not a function". */
{
  const ctx = sandbox(extractFn(read('js/00-state-and-helpers.js'), 'escapeHtml'));
  assert.strictEqual(ctx.escapeHtml(1), '1');
  assert.strictEqual(ctx.escapeHtml(0), '0');
  assert.strictEqual(ctx.escapeHtml(null), '');
  assert.strictEqual(ctx.escapeHtml(undefined), '');
  assert.strictEqual(ctx.escapeHtml('<img src=x onerror="a">&'), '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;');
  assert.ok(/String\(n \|\| '\?'\)/.test(read('js/33-footnotes.js')), 'footnote label must be stringified');
}

/* --- Recurrence: month/year arithmetic must clamp to month end instead of overflowing. */
{
  const src = read('js/15-task-manager.js');
  const code = ['parseYmd', 'ymd', 'addInterval'].map((n) => extractFn(src, n)).join('\n');
  const ctx = sandbox(code);
  const add = (d, unit, n) => ctx.ymd(ctx.addInterval(ctx.parseYmd(d), { n: n, unit: unit }));
  assert.strictEqual(add('2026-08-31', 'm', 1), '2026-09-30');
  assert.strictEqual(add('2026-01-31', 'm', 1), '2026-02-28');
  assert.strictEqual(add('2028-01-31', 'm', 1), '2028-02-29');
  assert.strictEqual(add('2028-02-29', 'y', 1), '2029-02-28');
  assert.strictEqual(add('2026-03-15', 'm', 1), '2026-04-15');
  assert.strictEqual(add('2026-12-31', 'm', 2), '2027-02-28');
  assert.strictEqual(add('2026-03-01', 'd', 30), '2026-03-31');
  assert.strictEqual(add('2026-03-01', 'w', 2), '2026-03-15');
}

/* --- Daily calendar cursor must be anchored to the 1st (setMonth on the 31st overflowed). */
assert.ok(/var dailyCalCursor = new Date\(\);\s*[\s\S]{0,200}dailyCalCursor\.setDate\(1\);/.test(read('js/02-editor-core.js')),
  'dailyCalCursor must be anchored to day 1');

/* --- Flashcards: a first-time "again" card is learning, not new; shortcuts ignore typing targets. */
{
  const fsrc = read('js/26-flashcards.js');
  const ctx = sandbox(extractFn(fsrc, 'flashcardStatus'));
  assert.strictEqual(ctx.flashcardStatus({ reps: 0 }), 'new');
  assert.strictEqual(ctx.flashcardStatus({ reps: 0, lastReviewedAt: 5, state: 'learning' }), 'learning');
  assert.strictEqual(ctx.flashcardStatus({ reps: 3, state: 'review' }), 'review');
  assert.strictEqual(ctx.flashcardStatus({ suspended: true, reps: 3 }), 'suspended');
  assert.ok(/isContentEditable\|\|\/\^\(INPUT\|TEXTAREA\|SELECT\)\$\/\.test\(tgt\.tagName/.test(fsrc), 'flashcard keydown must ignore typing targets');
}

/* --- Ctrl/Cmd+Z/Y must be left to native undo inside any text field. */
{
  const ctx = sandbox(extractFn(read('js/14-wiring-and-init.js'), 'isTextEntryTarget'));
  const el = (tag, extra) => Object.assign({ tagName: tag, isContentEditable: false }, extra || {});
  assert.strictEqual(ctx.isTextEntryTarget(null), false);
  assert.strictEqual(ctx.isTextEntryTarget(el('DIV', { isContentEditable: true })), true);
  assert.strictEqual(ctx.isTextEntryTarget(el('INPUT', { type: 'text' })), true);
  assert.strictEqual(ctx.isTextEntryTarget(el('INPUT', { type: 'search' })), true);
  assert.strictEqual(ctx.isTextEntryTarget(el('TEXTAREA')), true);
  assert.strictEqual(ctx.isTextEntryTarget(el('INPUT', { type: 'checkbox' })), false);
  assert.strictEqual(ctx.isTextEntryTarget(el('BUTTON')), false);
  assert.ok(!/activeElement\.isContentEditable\) return;/.test(read('js/14-wiring-and-init.js')), 'undo/redo guard must use isTextEntryTarget');
}

/* --- Tabs must not be pruned before the notebook has loaded (it dropped every saved page tab each launch). */
{
  const t = extractFn(read('js/32-tabs.js'), 'nexusTabsClean');
  assert.ok(/if\(!\(typeof state !== 'undefined' && state && state\.pages\)\) return;/.test(t), 'nexusTabsClean must wait for state');
}

/* --- Service worker: precaches the shell; the embedded download copy is byte-identical to sw.js. */
{
  const sw = read('sw.js');
  assert.ok(sw.includes("CACHE='nexus-shell-v5'"));
  assert.ok(sw.includes('nexusPrecacheShell'), 'install must precache the shell');
  assert.ok(sw.includes('Response.error()'), 'failed subresources must not be answered with the HTML shell');
  const pwa = read('js/12-pwa.js');
  const a = pwa.indexOf('var NEXUS_SW_SOURCE = ');
  const b = pwa.indexOf('function downloadServiceWorkerFile');
  assert.ok(a >= 0 && b > a);
  const ctx = sandbox(pwa.slice(a, b));
  assert.strictEqual(ctx.NEXUS_SW_SOURCE, sw, 'embedded NEXUS_SW_SOURCE must equal sw.js');
  assert.ok(/window\.isSecureContext/.test(pwa), 'SW registration must accept any secure context');
}

/* --- Privacy/offline: no third-party script is requested at startup; Google loads on demand only. */
{
  const html = read('index.html');
  assert.ok(!/<script[^>]+src=["']https?:\/\//i.test(html), 'index.html must not load remote scripts at startup');
  const bk = read('js/06-backup-sync.js');
  assert.ok(/function ensureGoogleIdentity\(/.test(bk) && /function ensureGoogleApi\(/.test(bk));
  assert.ok(/function gdriveGetTokenSilently\(onReady, onFail\)\{\s*\/\*[^*]*\*\/\s*if\(!gdriveAuthStillValid\(\)\)/.test(bk),
    'silent renewal must check the connection window before loading Google');
}

/* --- Replacement text must be inserted literally ($$, $& are special in String.replace strings). */
{
  const ctx = sandbox(extractFn(read('js/02-editor-core.js'), 'renameCascade'),
    { state: { blocks: { a: { text: 'see [[Old Title]] and [[old title]]' }, b: { text: 'nothing' } } } });
  ctx.renameCascade('Old Title', 'Budget $$ & $&');
  assert.strictEqual(ctx.state.blocks.a.text, 'see [[Budget $$ & $&]] and [[Budget $$ & $&]]');
  assert.strictEqual(ctx.state.blocks.b.text, 'nothing');
  const fr = extractFn(read('js/07-find-replace-settings.js'), 'applyFindReplace');
  assert.ok(/function\(\)\{ replaced\+\+; return replace; \}/.test(fr), 'find & replace must use a function replacer');
}

/* --- serializeInline is the single DOM->text serialiser; a wrapper that delegated per child element
   flattened all formatting and attachment widgets on save. */
{
  const fn = read('js/33-footnotes.js');
  assert.ok(!/\bserializeInline\s*=/.test(fn), '33-footnotes.js must not wrap or reassign serializeInline');
  const core = extractFn(read('js/00-state-and-helpers.js'), 'serializeInline');
  assert.ok(core.includes("contains('footnote-ref')") && core.includes("'[^'"), 'serializeInline must serialise footnote refs itself');
}

/* --- Trashed pages are archived: their links are not live backlinks; tag pages still list tagged blocks. */
{
  const bl = extractFn(read('js/05-backlinks-nav-graph.js'), 'renderBacklinks');
  assert.ok(/sourcePage\.trashedAt\) return;/.test(bl), 'renderBacklinks must skip blocks from trashed pages');
  assert.ok(!/r\.type === 'page' && r\.title/.test(bl), '#tag references must keep counting so tag pages list their tagged blocks');
}

/* --- User data (page titles, tags) must never be interpolated into task-group headers as HTML. */
{
  const tm = read('js/15-task-manager.js');
  assert.ok(!/head\.innerHTML\s*=\s*'<span>'\s*\+\s*g\.label/.test(tm), 'task group header must not use innerHTML with g.label');
  assert.ok(/labelEl\.textContent = g\.label;/.test(tm), 'task group label must be a text node');
}

/* --- Saved database views: the query builder edits a copy; only Save commits it (Cancel must not leak). */
{
  const qe = read('js/01-query-engine.js');
  assert.ok(/function cloneDbViewDirs\(/.test(qe) && /qbView = cloneDbViewDirs\(qbActiveView\.dirs\);/.test(qe), 'builder must work on a copy of the saved view');
  assert.ok(!/qbView = qbActiveView\.dirs;/.test(qe), 'builder must not edit the saved view by reference');
  assert.ok(/qbViewToSave\.dirs = cloneDbViewDirs\(qbView\)/.test(qe), 'Save must commit the copy');
}

/* --- Background Drive sync on a file:// page must never raise an alert(). */
{
  const bk = read('js/06-backup-sync.js');
  assert.ok(/function gdriveBlockedByOrigin\(silent\)/.test(bk) && /if\(silent\) return true;/.test(bk));
  assert.ok(/function gdrivePerformSyncCycle\(\)\{[\s\S]{0,200}gdriveBlockedByOrigin\(true\)\) return;/.test(bk), 'sync cycle must use the silent origin check');
  assert.ok(/function runGdriveSyncCycle\(\)\{[\s\S]{0,500}gdriveBlockedByOrigin\(true\)\) return;/.test(bk), 'the sync timer entry must use the silent origin check');
}

/* --- The passcode gate also covers Drive sync (no background merge/upload while locked). */
{
  const bk = read('js/06-backup-sync.js');
  assert.ok(/function runGdriveSyncCycle\(\)\{[\s\S]{0,400}appLocked\) return;/.test(bk), 'runGdriveSyncCycle must stop while locked');
  assert.ok(/function gdrivePerformSyncCycle\(\)\{\s*if\(typeof appLocked !== 'undefined' && appLocked\) return;/.test(bk), 'gdrivePerformSyncCycle must stop while locked');
}

/* --- Accessibility: dialogs and unlabeled inputs carry names; passcode fields keep autocomplete off (no password-manager capture). */
{
  const html = read('index.html');
  ['settings-overlay', 'lock-overlay', 'passcode-overlay', 'versions-overlay', 'palette', 'gs-modal', 'page-title', 'attach-file-input', 'import-md-input'].forEach((id) => {
    const tag = (html.match(new RegExp('<[^>]*\\bid="' + id + '"[^>]*>')) || [''])[0];
    assert.ok(/aria-label="[^"]+"/.test(tag), id + ' must have an accessible name');
  });
  assert.ok(/<input[^>]*id="lock-input"[^>]*autocomplete="off"/.test(html) || /<input[^>]*autocomplete="off"[^>]*id="lock-input"/.test(html), 'passcode field must keep autocomplete="off"');
  assert.ok(fs.existsSync(path.join(root, '.nojekyll')), '.nojekyll must ship for static hosting');
}

/* --- Sync: every content field counts as an edit; ties resolve identically on both devices. */
{
  const core = read('js/00-state-and-helpers.js');
  const ctx = sandbox(['entityChanged', 'pickWinner'].map((n) => extractFn(core, n)).join('\n') + '\nvar SYNC_META_KEYS = {updatedAt:1, updatedBy:1, order:1};');
  const base = { id: 'p', title: 'T', updatedAt: 1, updatedBy: 'a', order: 0 };
  assert.strictEqual(ctx.entityChanged(base, Object.assign({}, base, { updatedAt: 9, updatedBy: 'b', order: 4 })), false, 'bookkeeping alone is not an edit');
  ['icon', 'banner', 'pinned', 'locked', 'dbViews', 'conflict', 'viewMode', 'text'].forEach((k) => {
    assert.strictEqual(ctx.entityChanged(base, Object.assign({}, base, { [k]: k === 'dbViews' ? [{ id: 'v' }] : 'x' })), true, k + ' must count as an edit');
  });
  const a = { id: 'b', text: 'A', updatedAt: 5, updatedBy: 's' }, b = { id: 'b', text: 'B', updatedAt: 5, updatedBy: 's' };
  assert.strictEqual(ctx.pickWinner(a, b), ctx.pickWinner(b, a), 'equal stamps: both merge orders must pick the same copy');
  assert.strictEqual(ctx.pickWinner({ updatedAt: 9, text: 'n' }, { updatedAt: 3, text: 'o' }).text, 'n');
  assert.ok(/merged\.clockFloor = Math\.max\(local\.clockFloor \|\| 0, Math\.min\(maxRemote, Date\.now\(\) \+ MAX_CLOCK_SKEW_MS\)\)/.test(core), 'merge must raise the causal clock floor (capped)');
  assert.ok(/var now = Math\.max\(Date\.now\(\), \(state\.clockFloor \|\| 0\) \+ 1\);/.test(core), 'stamps must respect the clock floor');
  assert.ok(/kind:'line-deleted'/.test(core) && /kind:'properties'/.test(core) && /return \{state: merged, conflicts: conflicts, stats: stats\};/.test(core), 'merge must report deletion/property conflicts and loss stats');
}

/* --- Version history: text-level diff helper, protection rules, and no plaintext leftovers. */
{
  const bk = read('js/06-backup-sync.js');
  const ctx = sandbox(['tokenizeWords', 'wordDiffParts', 'versionIsProtected', 'versionKind', 'formatBytes'].map((n) => extractFn(bk, n)).join('\n'));
  const d = ctx.wordDiffParts('the quick brown fox', 'the slow brown dog');
  assert.strictEqual(JSON.stringify(d.a.filter((x) => x.d && /\S/.test(x.t)).map((x) => x.t)), JSON.stringify(['quick', 'fox']));
  assert.strictEqual(JSON.stringify(d.b.filter((x) => x.d && /\S/.test(x.t)).map((x) => x.t)), JSON.stringify(['slow', 'dog']));
  assert.ok(ctx.versionIsProtected({ pinned: true }) && ctx.versionIsProtected({ name: 'x' }) && ctx.versionIsProtected({ nameEnc: {} }) && !ctx.versionIsProtected({}));
  assert.strictEqual(ctx.versionKind({ reason: 'Daily snapshot' }), 'auto');
  assert.strictEqual(ctx.versionKind({ kind: 'sync' }), 'sync');
  assert.strictEqual(ctx.formatBytes(1536), '2 KB');
  assert.ok(!/MAX_VERSIONS\b/.test(bk) && /MAX_UNPINNED_VERSIONS = 30/.test(bk), 'retention must not be the old fixed five');
  assert.ok(!/localStorage\.setItem\(CONFLICTS_KEY/.test(bk), 'the conflict log must not be written to plaintext localStorage');
  assert.ok(/function syncSafetySnapshot\(/.test(bk) && /syncSafetySnapshot\(mergeResult, 'Google Drive'\)/.test(bk) && /syncSafetySnapshot\(result, link\.label\)/.test(read('js/10-lan-sync.js')), 'both sync paths must snapshot before applying a destructive merge');
  const lock = read('js/09-security-lock.js');
  assert.ok(/encryptExistingVersions\(\)/.test(lock) && /decryptExistingVersions\(\)/.test(lock) && /clearAllVersions\(\)/.test(lock), 'passcode set/remove/erase must handle snapshots');
}

/* --- Permanent deletion is recoverable (safety snapshot first); the conflict log loads at startup. */
{
  const ed = read('js/02-editor-core.js');
  assert.ok(/snapshotVersionThrottled\('perm-delete'/.test(ed) && /snapshotVersion\('Before emptying the trash'/.test(ed), 'permanent deletes must take a safety snapshot');
  assert.ok(/initConflictsStore\(\);/.test(read('js/14-wiring-and-init.js')), 'the conflict log must be loaded when the notebook boots');
}

/* --- Guard against new accidental duplicate global functions (later files silently shadow earlier ones). */
{
  const KNOWN = new Set(['renderTasksView', 'tasksSortComparator']); /* legacy copies in 03, superseded by 15 */
  const seen = {};
  fs.readdirSync(path.join(root, 'js')).filter((f) => f.endsWith('.js')).sort().forEach((f) => {
    const re = /^function ([A-Za-z0-9_$]+)\(/gm;
    let m; const src = read('js/' + f);
    while ((m = re.exec(src))) (seen[m[1]] = seen[m[1]] || []).push(f);
  });
  const dupes = Object.keys(seen).filter((n) => seen[n].length > 1 && !KNOWN.has(n));
  assert.deepStrictEqual(dupes, [], 'duplicate global function declarations: ' + dupes.join(', '));
}

/* --- Google Drive: independently seeded copies of Nexus's five built-in singleton pages must
   converge back to one page per workspace instead of showing duplicate Database / Help / Queries /
   Sticky Notes / Welcome entries. User-unique content survives, mapped block references are repaired,
   and the migration is idempotent. */
{
  const core = read('js/00-state-and-helpers.js');
  const names = ['uid','entityChanged','pickWinner','rebuildTitleIndex','legacySystemPageKey','knownSystemPageKey','markKnownSystemPage',
    'rewriteKnownBlockRefs','systemBlockComparableText','systemBlocksEquivalent','systemPageCanonicalId',
    'mergeKnownSystemPageGroup','dedupeKnownSystemPages','selfHealKnownSystemPages'];
  const code = names.map((n) => extractFn(core, n)).join('\n') +
    '\nvar NEXUS_SELF_HEAL_VERSION = 1;' +
    '\nvar NEXUS_SYSTEM_PAGE_TITLES = ' + JSON.stringify({welcome:'welcome to nexus',help:'help & tutorial',database:'database',queries:'queries','sticky-notes':'sticky notes'}) + ';';
  const ctx = sandbox(code, { Date, Math, console });
  const makePage = (s, id, title, systemKey, stamp, blocks) => {
    const propsByTitle = {
      'Welcome to Nexus': [{key:'status',value:'start here'}],
      'Help & Tutorial': [{key:'status',value:'reference'}],
      'Database': [{key:'status',value:'system'},{key:'type',value:'database hub'}],
      'Queries': [{key:'status',value:'system'},{key:'type',value:'query hub'}],
      'Sticky Notes': [{key:'status',value:'system'},{key:'type',value:'sticky note hub'}]
    };
    s.pages[id] = {id, title, type:'page', systemKey, createdAt:stamp, updatedAt:stamp, updatedBy:id,
      properties:propsByTitle[title] || [], rootBlocks:[]};
    blocks.forEach((b) => {
      s.blocks[b.id] = {id:b.id, pageId:id, parent:null, text:b.text, children:[], createdAt:stamp, updatedAt:stamp, updatedBy:id};
      s.pages[id].rootBlocks.push(b.id);
    });
  };
  const s = {pages:{}, blocks:{}, tombstones:{pages:{},blocks:{}}, currentPageId:null, stickyNotes:{cards:{}}, flashcards:{cards:{}}};
  makePage(s, 'wa', 'Welcome to Nexus', 'welcome', 100, [{id:'wa1',text:'Nexus start'}, {id:'wa2',text:'see ((wa1))'}]);
  makePage(s, 'wb', 'Welcome to Nexus', null, 120, [{id:'wb1',text:'Nexus start'}, {id:'wb2',text:'see ((wb1))'}]);
  makePage(s, 'ha', 'Help & Tutorial', 'help', 100, [{id:'ha1',text:'**Getting started**'}]);
  makePage(s, 'hb', 'Help & Tutorial', null, 120, [{id:'hb1',text:'**Getting started**'}]);
  makePage(s, 'da', 'Database', 'database', 100, [{id:'da1',text:'{{table: }}'}]);
  makePage(s, 'db', 'Database', null, 120, [{id:'db1',text:'{{table: }}'}]);
  makePage(s, 'qa', 'Queries', 'queries', 100, [{id:'qa1',text:'{{query: }}'}]);
  makePage(s, 'qb', 'Queries', null, 120, [{id:'qb1',text:'{{query: }}'}]);
  makePage(s, 'sa', 'Sticky Notes', 'sticky-notes', 100, [{id:'sa1',text:'**Sticky Note Cards**'}, {id:'sa2',text:'Help'}]);
  makePage(s, 'sb', 'Sticky Notes', null, 120, [{id:'sb1',text:'**Sticky Note Cards**'}, {id:'sb2',text:'Help'}]);
  s.blocks.wb3 = {id:'wb3',pageId:'wb',parent:null,text:'My custom edit',children:[],createdAt:121,updatedAt:130,updatedBy:'wb'};
  s.pages.wb.rootBlocks.push('wb3');
  s.currentPageId = 'wb';
  assert.strictEqual(ctx.dedupeKnownSystemPages(s), true);
  ['Welcome to Nexus','Help & Tutorial','Database','Queries','Sticky Notes'].forEach((title) => {
    assert.strictEqual(Object.values(s.pages).filter((p) => p.title === title).length, 1, 'duplicate system page: ' + title);
  });
  const wp = Object.values(s.pages).find((p) => p.title === 'Welcome to Nexus');
  const texts = wp.rootBlocks.map((id) => s.blocks[id].text);
  assert.ok(texts.includes('Nexus start'));
  assert.ok(texts.includes('My custom edit'));
  assert.ok(!Object.values(s.blocks).some((b) => /see \(\(wb1\)\)/.test(b.text)), 'removed duplicate block reference survived');
  assert.strictEqual(ctx.dedupeKnownSystemPages(s), false, 'dedupe must be idempotent');
  assert.ok(Object.keys(s.tombstones.pages).length >= 5, 'duplicate page ids must be tombstoned');

  /* Safety regression: a normal user-created page with a matching title but
     none of the built-in system fingerprints must remain a separate page. */
  s.pages['user-db'] = {id:'user-db', title:'Database', type:'page', createdAt:600, updatedAt:600, updatedBy:'user-db', properties:[], rootBlocks:[]};
  assert.strictEqual(ctx.knownSystemPageKey(s.pages['user-db']), '', 'ordinary same-title user page must not be classified as a system page');

  /* Self-healing regression: simulate Google Drive reintroducing a fresh
     duplicate after a previous repair. The next repair pass must collapse it
     again without touching ordinary pages. */
  makePage(s, 'wb-new', 'Welcome to Nexus', null, 500, [{id:'wb-new-1',text:'Nexus start'}]);
  assert.strictEqual(ctx.selfHealKnownSystemPages(s, 'regression-reintroduced-duplicate'), true,
    'self-healing must repair a duplicate reintroduced after an earlier pass');
  assert.strictEqual(Object.values(s.pages).filter((p) => p.title === 'Welcome to Nexus').length, 1,
    'self-healing must leave one Welcome page');
  assert.strictEqual(ctx.selfHealKnownSystemPages(s, 'regression-second-pass'), false,
    'self-healing must be idempotent on the next pass');

  assert.ok(/selfHealKnownSystemPages\(parsed, 'normalize'\)/.test(core),
    'normalization must run the self-healing guard');
  assert.ok(/selfHealKnownSystemPages\(merged, 'post-merge'\)/.test(core),
    'post-merge path must run the self-healing guard before sync push');
  ['js/21-database-sidebar.js','js/22-query-sidebar.js','js/27-sticky-notes.js'].forEach((file) => {
    const src = read(file);
    assert.ok(/systemKey\s*:\s*['"]/.test(src), file + ' must stamp a stable systemKey on creation');
  });
}

console.log('Nexus regression tests passed: escapeHtml, recurrence clamping, calendar anchor, flashcards, undo guard, tabs, service worker, no startup third-party requests, backlinks/trash, task-label XSS, saved-view isolation, silent background sync, sync change-tracking & tie-breaks, version history & conflict store, accessibility names, known-system-page Drive deduplication and self-healing, duplicate-function guard.');
