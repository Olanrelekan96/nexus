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

console.log('Nexus regression tests passed: escapeHtml, recurrence clamping, calendar anchor, flashcards, undo guard, tabs, service worker, no startup third-party requests, duplicate-function guard.');
