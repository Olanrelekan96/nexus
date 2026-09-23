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

/* --- Guard against new accidental duplicate global declarations. All 34 js/ files load as
   plain <script> tags into one shared global scope (no modules, no bundler — see README), so a
   `function` or top-level `var` name reused in a later-loading file silently shadows the earlier
   one with no error at runtime. Both declaration forms bind the same global namespace, so they
   are tracked together: a `var x` in one file colliding with a `function x(){}` in another is
   just as real a collision as two of the same kind. */
{
  const KNOWN = new Set([
    'renderTasksView', 'tasksSortComparator', /* legacy functions in 03, superseded by 15 */
    'tasksViewState' /* legacy var in 03, superseded by 15 — 15 deliberately reuses the hoisted
                         value (`var tasksViewState = (typeof tasksViewState !== 'undefined' &&
                         tasksViewState) || {}`) rather than blindly overwriting it, so this one
                         is a safe, intentional re-declaration, not a silent shadow. */
  ]);
  const seen = {};
  const record = (name, file) => { (seen[name] = seen[name] || []).push(file); };
  fs.readdirSync(path.join(root, 'js')).filter((f) => f.endsWith('.js')).sort().forEach((f) => {
    const src = read('js/' + f);
    let m;
    const fnRe = /^function ([A-Za-z0-9_$]+)\(/gm;
    while ((m = fnRe.exec(src))) record(m[1], f);
    const varRe = /^var ([A-Za-z0-9_$]+)\b/gm;
    while ((m = varRe.exec(src))) record(m[1], f);
  });
  const dupes = Object.keys(seen).filter((n) => seen[n].length > 1 && !KNOWN.has(n));
  assert.deepStrictEqual(dupes, [], 'duplicate global declarations (function and/or top-level var share one scope): ' + dupes.join(', '));
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

/* --- Notebook schema versioning: registered migrations run in ascending version order
   regardless of array order, are skipped once already applied (idempotent boot — no
   re-running work on every load), and if one throws partway, progress up to the last
   successful migration is preserved and the rest retry on the next load (migrate()
   functions are documented as required to be safe to re-run from that partial state).
   Every notebook — fresh via seedState() or restored from before this existed — ends up
   stamped, so a future migration always has an accurate "already applied" record. */
{
  const core = read('js/00-state-and-helpers.js');
  const runnerSrc = extractFn(core, 'runSchemaMigrations');

  /* Fresh/legacy notebook with no migrations registered yet still gets the baseline stamp. */
  {
    const ctx = sandbox(runnerSrc, { console, NEXUS_BASELINE_SCHEMA_VERSION: 1, NEXUS_SCHEMA_MIGRATIONS: [] });
    const parsed = {};
    ctx.runSchemaMigrations(parsed);
    assert.strictEqual(parsed.schemaVersion, 1, 'notebook with no schemaVersion and no migrations must be stamped at the baseline');
  }

  /* Migrations registered out of order still run in ascending version order, and a second
     run on an already-current notebook must not re-invoke any of them. */
  {
    const applied = [];
    const migrations = [
      {version: 3, migrate: (p) => { applied.push(3); p.applied = applied.slice(); }},
      {version: 1, migrate: (p) => { applied.push(1); p.applied = applied.slice(); }},
      {version: 2, migrate: (p) => { applied.push(2); p.applied = applied.slice(); }}
    ];
    const ctx = sandbox(runnerSrc, { console, NEXUS_BASELINE_SCHEMA_VERSION: 1, NEXUS_SCHEMA_MIGRATIONS: migrations });
    const parsed = {};
    ctx.runSchemaMigrations(parsed);
    assert.deepStrictEqual(applied, [1, 2, 3], 'migrations must run in ascending version order regardless of registration order');
    assert.strictEqual(parsed.schemaVersion, 3);
    ctx.runSchemaMigrations(parsed); /* simulate the next boot on an already-migrated notebook */
    assert.deepStrictEqual(applied, [1, 2, 3], 'an already-current notebook must not re-run any migration');
    assert.strictEqual(parsed.schemaVersion, 3);
  }

  /* A migration that throws must not stop earlier ones from having taken effect, must not
     advance schemaVersion past the last success, and must be retried (not skipped) once
     whatever caused it to throw is no longer true on the next load. */
  {
    const applied = [];
    let v2Attempts = 0;
    const migrations = [
      {version: 1, migrate: (p) => { applied.push(1); }},
      {version: 3, migrate: (p) => { applied.push(3); }},
      {version: 2, migrate: (p) => { v2Attempts++; if (v2Attempts === 1) throw new Error('simulated failure'); applied.push(2); }}
    ];
    const ctx = sandbox(runnerSrc, { console, NEXUS_BASELINE_SCHEMA_VERSION: 1, NEXUS_SCHEMA_MIGRATIONS: migrations });
    const parsed = {};
    ctx.runSchemaMigrations(parsed);
    assert.deepStrictEqual(applied, [1], 'migration 3 must not run before migration 2 succeeds');
    assert.strictEqual(parsed.schemaVersion, 1, 'schemaVersion must stay at the last successful migration, not advance past a failure');
    ctx.runSchemaMigrations(parsed); /* next load: whatever made v2 throw has cleared */
    assert.deepStrictEqual(applied, [1, 2, 3], 'the failed migration must retry (not be skipped) and later ones must then proceed');
    assert.strictEqual(parsed.schemaVersion, 3);
  }

  assert.ok(/return runSchemaMigrations\(parsed\);\s*\n}/.test(core),
    'normalizeState must run schema migrations before returning on every load/restore/merge path');
  assert.ok(/return runSchemaMigrations\(seedState\(\)\);/.test(core),
    'a brand-new notebook (invalid/empty input) must also be stamped immediately, not left at schemaVersion 0 for one load cycle');
}

/* --- Large-page render performance: buildBlockRefIndex() must answer findBlockRefsTo(id).length
   for every block, so the render path can compute the reference-badge count for a whole page in
   one O(notebook size) pass instead of one such pass per rendered block (which made opening a
   page cost blocks-on-page × blocks-in-notebook — the dominant cost on a large notebook). Proven
   here by exhaustive comparison against the original per-block scan, covering: a block never
   counting as referencing itself, a transclusion !((id)) not counting, a block referencing the
   same target twice only counting once (matching findBlockRefsTo's first-match short-circuit),
   and multiple distinct blocks each referencing the same target counting separately. */
{
  const core = read('js/00-state-and-helpers.js');
  const testState = { blocks: {
    a: { id: 'a', text: 'no refs here' },
    b: { id: 'b', text: 'refs ((a)) once' },
    c: { id: 'c', text: 'refs ((a)) twice: ((a)) again' }, /* must count once toward a, not twice */
    d: { id: 'd', text: 'transclusion !((a)) does not count' },
    e: { id: 'e', text: 'self-ref ((e)) must not count' },
    f: { id: 'f', text: 'refs two targets: ((a)) and ((b))' },
    g: { id: 'g', text: null }, /* no text at all */
    h: { id: 'h' } /* text field entirely absent */
  }};
  const ctx = sandbox(extractFn(core, 'findBlockRefsTo') + '\n' + extractFn(core, 'buildBlockRefIndex'), { state: testState });
  const index = ctx.buildBlockRefIndex();
  Object.keys(testState.blocks).forEach((id) => {
    assert.strictEqual(index[id] || 0, ctx.findBlockRefsTo(id).length,
      'buildBlockRefIndex()[' + id + '] must equal findBlockRefsTo(' + JSON.stringify(id) + ').length');
  });
  assert.strictEqual(index.a, 3, 'a is referenced by b, c (once, deduped) and f — 3 total');
  assert.strictEqual(index.b, 1, 'b is referenced by f only');
  assert.strictEqual(index.e, undefined, 'a block referencing only itself must not appear in the index');

  const renderSrc = read('js/04-render-page.js');
  assert.ok(/var syncCount = \(blockRefIndexForRender \|\| buildBlockRefIndex\(\)\)\[block\.id\] \|\| 0;/.test(renderSrc),
    'renderBlockRow must read the precomputed index (O(1)) instead of calling findBlockRefsTo per block (O(notebook size))');
  assert.ok(/blockRefIndexForRender = buildBlockRefIndex\(\);/.test(renderSrc),
    'renderOutline must build the reference index exactly once per render pass');
  assert.ok(/var fragment = document\.createDocumentFragment\(\);\s*\n\s*renderBlockList\(rootIds, fragment\);\s*\n\s*container\.appendChild\(fragment\);/.test(renderSrc),
    'renderOutline must build the top-level block list into a detached fragment and attach it once, not append each row directly into the live #outline element');
}

/* --- "Add block above/below" (block right-click menu): createBlockBefore/createBlockAfter must
   insert a new sibling in the correct position, with the same parent, for both a root-level block
   and a nested one — and the menu must offer both, disabled when the target line is locked (same
   rule already applied to Cut/Paste/Duplicate on that line, since inserting a sibling is a
   structural change next to it, not a change to its own text). */
{
  const core = read('js/00-state-and-helpers.js') + '\n' + read('js/02-editor-core.js');
  const ctx = sandbox(
    extractFn(core, 'uid') + '\n' +
    extractFn(core, 'mkBlock') + '\n' +
    extractFn(core, 'siblingsArrayOf') + '\n' +
    extractFn(core, 'createBlockBefore') + '\n' +
    extractFn(core, 'createBlockAfter')
  );
  ctx.state = { blocks: {}, pages: { p1: { id: 'p1', rootBlocks: [] } } };
  const root = ctx.mkBlock('root1', 'p1', null, 'root');
  ctx.state.blocks.root1 = root;
  ctx.state.pages.p1.rootBlocks.push('root1');
  const mid = ctx.createBlockBefore(root, 'inserted-before-root'); /* first block on a page: "before" still needs a valid insertion point */
  assert.deepStrictEqual(ctx.state.pages.p1.rootBlocks, [mid.id, 'root1'],
    'createBlockBefore on a root block must land immediately before it in rootBlocks');
  const after = ctx.createBlockAfter(root, 'inserted-after-root');
  assert.deepStrictEqual(ctx.state.pages.p1.rootBlocks, [mid.id, 'root1', after.id],
    'createBlockAfter on a root block must land immediately after it in rootBlocks');

  const parent = ctx.mkBlock('parent1', 'p1', null, 'parent');
  ctx.state.blocks.parent1 = parent;
  const child = ctx.mkBlock('child1', 'p1', 'parent1', 'child');
  ctx.state.blocks.child1 = child;
  parent.children.push('child1');
  const beforeChild = ctx.createBlockBefore(child, 'x');
  const afterChild = ctx.createBlockAfter(child, 'y');
  assert.deepStrictEqual(Array.from(parent.children), [beforeChild.id, 'child1', afterChild.id],
    'createBlockBefore/After on a nested block must insert into the parent\'s children, not rootBlocks');
  assert.strictEqual(beforeChild.parent, 'parent1');
  assert.strictEqual(afterChild.parent, 'parent1');

  const renderSrc = read('js/04-render-page.js');
  assert.ok(/addItem\('⬆', 'Add block above', locked, function\(\)\{\s*\n\s*var cb = state\.blocks\[blockId\];\s*\n\s*if\(!cb\) return;\s*\n\s*var nb = createBlockBefore\(cb, ''\);/.test(renderSrc),
    'block menu must offer "Add block above", disabled when locked, using createBlockBefore');
  assert.ok(/addItem\('⬇', 'Add block below', locked, function\(\)\{\s*\n\s*var cb = state\.blocks\[blockId\];\s*\n\s*if\(!cb\) return;\s*\n\s*var nb = createBlockAfter\(cb, ''\);/.test(renderSrc),
    'block menu must offer "Add block below", disabled when locked, using createBlockAfter');
}

/* --- Multi-block selection: Shift+click range-select must use the same visible
   (collapse-aware) order as keyboard Up/Down (flattenVisible), Ctrl/Cmd+click must
   toggle a single block, and bulk delete must (a) run as exactly one save()/render
   pass — one undo checkpoint for the whole operation, not one per block — (b) skip
   a selected block whose ancestor is also selected, since deleting the ancestor
   already removes it, and (c) skip and report a locked selected block rather than
   deleting it. */
{
  const renderSrc = read('js/04-render-page.js');

  /* --- toggleBlockSelection: range vs. toggle behavior, using the real flattenVisible. --- */
  {
    const src = extractFn(renderSrc, 'clearBlockSelectionVisuals') + '\n' +
      extractFn(renderSrc, 'setBlockSelection') + '\n' +
      extractFn(renderSrc, 'toggleBlockSelection') + '\n' +
      extractFn(read('js/02-editor-core.js'), 'flattenVisible');
    const testState = { blocks: {}, pages: { p1: { id: 'p1', rootBlocks: ['a','b','c','d'] } } };
    ['a','b','c','d'].forEach((id) => { testState.blocks[id] = { id, pageId: 'p1', children: [], collapsed: false }; });
    const ctx = sandbox(src, {
      state: testState,
      document: { querySelector: function(){ return null; } },
      selectedBlockIds: [], selectionAnchorId: null
    });
    ctx.toggleBlockSelection('b', false); /* plain (Ctrl/Cmd) click: select just b, anchor = b */
    assert.deepStrictEqual(Array.from(ctx.selectedBlockIds), ['b']);
    ctx.toggleBlockSelection('d', true); /* Shift+click from anchor b to d: range b..d */
    assert.deepStrictEqual(Array.from(ctx.selectedBlockIds), ['b', 'c', 'd'],
      'Shift+click must select the visible range between the anchor and the clicked block');
    ctx.toggleBlockSelection('b', true); /* Shift+click back to b: range shrinks, anchor unchanged */
    assert.deepStrictEqual(Array.from(ctx.selectedBlockIds), ['b'],
      'a later Shift+click must re-extend from the same original anchor, not the last-selected end');
    ctx.toggleBlockSelection('b', false); /* Ctrl/Cmd-click an already-selected block toggles it off */
    assert.deepStrictEqual(Array.from(ctx.selectedBlockIds), []);
  }

  /* --- bulkDeleteSelectedBlocks: ancestor-filtering, locked-skip, single save()/render. --- */
  {
    const calls = { save: 0, renderPage: 0, focusBlock: [], toast: [] };
    const testState = { blocks: {} };
    function mk(id, parent, locked){ return { id, parent: parent || null, children: [], locked: !!locked, pageId: 'p1' }; }
    testState.blocks.parent1 = mk('parent1', null); testState.blocks.parent1.children = ['child1'];
    testState.blocks.child1 = mk('child1', 'parent1');   /* selected, but its ancestor parent1 is also selected → must be skipped */
    testState.blocks.solo1 = mk('solo1', null);          /* selected, deletable */
    testState.blocks.locked1 = mk('locked1', null, true); /* selected, locked → must be skipped and reported */
    function stubRemove(b){
      (function collect(ids){
        ids.forEach((cid) => { if(testState.blocks[cid]){ collect(testState.blocks[cid].children); delete testState.blocks[cid]; } });
      })(b.children.slice());
      delete testState.blocks[b.id];
      return { focusId: 'landed', offset: 0 };
    }
    const src = extractFn(renderSrc, 'clearBlockSelectionVisuals') + '\n' +
      extractFn(renderSrc, 'clearBlockSelection') + '\n' +
      extractFn(renderSrc, 'bulkDeleteSelectedBlocks') + '\n' +
      extractFn(read('js/02-editor-core.js'), 'isDescendantOrSelf') + '\n' +
      extractFn(read('js/13a-locks-and-sidebar.js'), 'pageIsLocked') + '\n' +
      extractFn(read('js/13a-locks-and-sidebar.js'), 'blockIsLocked');
    const ctx = sandbox(src, {
      state: testState,
      document: { querySelector: function(){ return null; } },
      selectedBlockIds: ['parent1', 'child1', 'solo1', 'locked1'],
      selectionAnchorId: 'locked1',
      confirm: function(){ return true; },
      save: function(){ calls.save++; },
      renderPage: function(){ calls.renderPage++; },
      focusBlock: function(id, off){ calls.focusBlock.push([id, off]); },
      toast: function(msg){ calls.toast.push(msg); },
      removeBlockSubtree: stubRemove
    });
    ctx.bulkDeleteSelectedBlocks();
    assert.deepStrictEqual(Object.keys(testState.blocks).sort(), ['locked1'],
      'parent1 (and its descendant child1) and solo1 must be removed; locked1 must survive');
    assert.strictEqual(calls.save, 1, 'a multi-block delete must be exactly one save() call (one undo checkpoint), not one per block');
    assert.strictEqual(calls.renderPage, 1, 'a multi-block delete must re-render exactly once, not once per block');
    assert.ok(calls.toast.some((m) => /1 locked line/.test(m)), 'must report that one locked selected block was skipped');
    assert.deepStrictEqual(Array.from(ctx.selectedBlockIds), [], 'selection must be cleared after a bulk delete');
  }

  /* --- Wiring: bullet click routes to selection on Shift/Ctrl/Cmd, plain click still zooms;
     right-click on a multi-selected row opens the bulk menu; Escape/Delete are wired globally. */
  assert.ok(/if\(e\.shiftKey\)\{ toggleBlockSelection\(block\.id, true\); return; \}/.test(renderSrc) &&
    /if\(e\.metaKey \|\| e\.ctrlKey\)\{ toggleBlockSelection\(block\.id, false\); return; \}/.test(renderSrc),
    'the bullet click handler must route Shift/Ctrl/Cmd-click to selection before the plain-click zoom fallback');
  const ctxMenuSrc = read('js/13-slash-and-context-menus.js');
  assert.ok(/selectedBlockIds\.length > 1 && selectedBlockIds\.indexOf\(row\.dataset\.id\) > -1\)\{\s*\n\s*openCtxMenu\(bulkBlockMenuItems/.test(ctxMenuSrc),
    'right-clicking a row that is part of a 2+ block selection must open the bulk menu instead of the single-block menu');
  const wiringSrc = read('js/14-wiring-and-init.js');
  assert.ok(/if\(typeof selectedBlockIds !== 'undefined' && selectedBlockIds\.length\) clearBlockSelection\(\);/.test(wiringSrc),
    'Escape must clear an active block selection');
  assert.ok(/\(e\.key === 'Delete' \|\| e\.key === 'Backspace'\) && !isMod &&\s*\n\s*typeof selectedBlockIds !== 'undefined' && selectedBlockIds\.length &&\s*\n\s*!isTextEntryTarget\(document\.activeElement\)\)\{\s*\n\s*e\.preventDefault\(\);\s*\n\s*bulkDeleteSelectedBlocks\(\);/.test(wiringSrc),
    'Delete/Backspace must trigger a bulk delete only when a selection is active and focus is not in a text-entry target');
}

console.log('Nexus regression tests passed: escapeHtml, recurrence clamping, calendar anchor, flashcards, undo guard, tabs, service worker, no startup third-party requests, backlinks/trash, task-label XSS, saved-view isolation, silent background sync, sync change-tracking & tie-breaks, version history & conflict store, accessibility names, known-system-page Drive deduplication and self-healing, duplicate-function guard, notebook schema versioning, large-page render index & fragment batching, add block above/below menu, multi-block selection & bulk delete.');
