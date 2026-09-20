'use strict';
const assert = require('assert');
const {run} = require('./harness');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

async function fresh(env, opts) {
  const ctx = await env.browser.newContext(Object.assign({viewport: {width: 1280, height: 800}, acceptDownloads: true}, opts || {}));
  const page = await env.newPage(ctx, env.errs);
  await page.goto(env.url); await page.waitForTimeout(1200);
  return {ctx, page};
}


/* Plants a raw record in the notebook store while the app itself is NOT loaded
   (otherwise its own unload flush would immediately overwrite the planted value). */
async function plantRecord(env, page, value) {
  await page.goto(env.url.replace('index.html', 'manifest.json')); // same origin, no app code
  await page.evaluate(v => new Promise((res, rej) => { const r = indexedDB.open('nexus_attachments', 4); r.onsuccess = () => { const tx = r.result.transaction('notebook', 'readwrite'); tx.objectStore('notebook').put(v, 'state'); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }; r.onerror = () => rej(r.error); }), value);
  await page.goto(env.url); await page.waitForTimeout(2500);
}

test('boots with no page errors and renders the welcome page', async env => {
  const {ctx, page} = await fresh(env);
  assert.strictEqual(await page.title(), 'Nexus — Knowledge OS');
  assert.ok(await page.evaluate(() => !!state && Object.keys(state.pages).length > 3));
  assert.deepStrictEqual(env.errs, []);
  await ctx.close();
});

test('outliner: Enter / Tab / Shift+Tab build the expected tree', async env => {
  const {ctx, page} = await fresh(env);
  await env.newNamedPage(page, 'Outline');
  await page.click('#add-root-block'); await page.waitForTimeout(200);
  const key = async k => { await page.keyboard.press(k); await page.waitForTimeout(120); };
  const typ = async t => { await page.keyboard.type(t, {delay: 10}); await page.waitForTimeout(120); };
  await typ('A'); await key('Enter'); await typ('B'); await key('Enter'); await typ('B1'); await key('Tab');
  await key('Enter'); await typ('B2'); await key('Shift+Tab'); await typ('C'); await page.waitForTimeout(1000);
  const tree = await page.evaluate(env.TREE);
  const texts = tree.map(n => n.t);
  assert.deepStrictEqual(texts.slice(-3), ['A', 'B', 'B2C']);
  assert.deepStrictEqual(tree[tree.length - 2].c.map(n => n.t), ['B1']);
  await ctx.close();
});

test('typing right after indent/outdent reaches state without blurring (autosave)', async env => {
  const {ctx, page} = await fresh(env);
  await env.newNamedPage(page, 'Typing');
  await page.click('#add-root-block'); await page.waitForTimeout(200);
  await page.keyboard.type('A'); await page.keyboard.press('Enter'); await page.waitForTimeout(150);
  await page.keyboard.type('B'); await page.keyboard.press('Tab'); await page.waitForTimeout(150);
  await page.keyboard.type('X'); await page.keyboard.press('Shift+Tab'); await page.waitForTimeout(150);
  await page.keyboard.type('Y');
  await page.waitForTimeout(1500); // > autosave debounce, still editing, no blur
  assert.ok(await page.evaluate(() => Object.values(state.blocks).some(b => b.text === 'BXY')), 'state must hold BXY while the line is still focused');
  const raw = await env.rawState(page);
  assert.ok(typeof raw === 'string' && raw.includes('BXY'), 'IndexedDB copy must hold BXY too');
  await ctx.close();
});

test('an in-progress edit survives an immediate hide + reload (pagehide flush)', async env => {
  const {ctx, page} = await fresh(env);
  await env.newNamedPage(page, 'Flush');
  await page.click('#add-root-block'); await page.waitForTimeout(200);
  await page.keyboard.type('last words before the tab dies');
  await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); });
  await page.waitForTimeout(300);
  await page.reload(); await page.waitForTimeout(1500);
  assert.ok(await page.evaluate(() => Object.values(state.blocks).some(b => b.text === 'last words before the tab dies')));
  await ctx.close();
});

test('load failure: unreadable record is never overwritten by a fresh notebook', async env => {
  const {ctx, page} = await fresh(env);
  await plantRecord(env, page, '{"pages":{"a":' /* truncated JSON */);
  assert.ok(await page.isVisible('#load-failure-overlay'), 'load-failure dialog must appear');
  assert.strictEqual(await env.rawState(page), '{"pages":{"a":', 'stored record must be untouched');
  await page.evaluate(() => { try { save(); } catch (e) {} try { flushSaveNow(); } catch (e) {} });
  await page.waitForTimeout(800);
  assert.strictEqual(await env.rawState(page), '{"pages":{"a":', 'writes must stay blocked');
  await page.click('.load-failure-actions button:nth-child(3)'); await page.waitForTimeout(2500);
  assert.ok(!(await page.isVisible('#load-failure-overlay').catch(() => false)));
  const keys = await page.evaluate(() => new Promise(res => { const r = indexedDB.open('nexus_attachments'); r.onsuccess = () => { const g = r.result.transaction('notebook').objectStore('notebook').getAllKeys(); g.onsuccess = () => res(g.result); }; }));
  assert.ok(keys.some(k => String(k).indexOf('state_quarantine_') === 0), 'quarantine copy missing: ' + keys);
  assert.ok(await page.evaluate(() => !!state && Object.keys(state.pages).length > 0));
  await ctx.close();
});

test('load failure: unrecognised JSON shape is treated the same way', async env => {
  const {ctx, page} = await fresh(env);
  await plantRecord(env, page, '{"hello":"world"}');
  assert.ok(await page.isVisible('#load-failure-overlay'));
  assert.strictEqual(await env.rawState(page), '{"hello":"world"}');
  await ctx.close();
});

test('setPasscode: if lock metadata cannot be stored nothing is encrypted', async env => {
  const {ctx, page} = await fresh(env);
  await page.evaluate(() => { const orig = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (String(k).indexOf('_lock') !== -1 && String(k).indexOf('reentry') === -1) throw new Error('QuotaExceededError'); return orig.call(this, k, v); }; });
  await page.click('#btn-settings'); await page.click('#btn-set-passcode');
  await page.fill('#pc-new', 'a-long-enough-passcode'); await page.fill('#pc-confirm', 'a-long-enough-passcode');
  await page.click('#pc-submit'); await page.waitForTimeout(2500);
  const err = await page.textContent('#pc-error');
  assert.match(err, /Could not store the passcode settings/);
  const raw = await env.rawState(page);
  assert.strictEqual(typeof raw, 'string', 'notebook must still be plain JSON');
  assert.ok(!(await page.evaluate(() => isLockEnabled())));
  await ctx.close();
});

test('removePasscode: a failed plaintext write keeps the lock and the data', async env => {
  const {ctx, page} = await fresh(env);
  const PASS = 'a-long-enough-passcode';
  await page.click('#btn-settings'); await page.click('#btn-set-passcode');
  await page.fill('#pc-new', PASS); await page.fill('#pc-confirm', PASS); await page.click('#pc-submit');
  await page.waitForSelector('#recovery-show-overlay', {state: 'visible', timeout: 15000});
  await page.check('#recovery-saved-check'); await page.click('#recovery-show-done');
  await page.waitForTimeout(600);
  // make plaintext notebook writes fail
  await page.evaluate(() => { const orig = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (v, k) { if (this.name === 'notebook' && typeof v === 'string') { throw new Error('boom'); } return orig.apply(this, arguments); }; });
  await page.click('#btn-remove-passcode'); await page.fill('#pc-current', PASS); await page.click('#pc-submit'); await page.waitForTimeout(3000);
  assert.ok(await page.evaluate(() => isLockEnabled()), 'lock metadata must still exist');
  const raw = await env.rawState(page);
  assert.ok(raw && raw.enc === true, 'notebook must still be encrypted');
  assert.match(await page.textContent('#pc-error'), /Something went wrong|Could not/);
  await ctx.close();
});

run(tests).then(f => process.exit(f ? 1 : 0));
