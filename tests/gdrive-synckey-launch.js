/* Regression test: Google Drive sync encryption key must survive a real
 * relaunch (new tab / reopened app), not just a same-tab reload, for as
 * long as the "remember for…" interval says — matching how the local
 * passcode lock's own "Request passcode on launch" already behaves
 * (see tests/passcode-launch-session.js). Bug: gdriveSyncPasscode was
 * only ever restored from sessionStorage, which is wiped the instant the
 * tab/app actually closes, so encrypted background sync silently skipped
 * (scheduleGdriveAutoPush/runGdriveSyncCycle) and interactive syncs
 * re-prompted on every single launch, regardless of the configured hours.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'js', '06-backup-sync.js'), 'utf8');

/* Each call is one simulated "launch": a fresh module context (fresh
 * in-memory vars, fresh sessionStorage unless one is passed in), but the
 * caller can thread the same `persistentStore` plain object through
 * successive calls to model IndexedDB, which — unlike sessionStorage —
 * really does survive a relaunch. */
function makeContext(opts) {
  opts = opts || {};
  const clock = opts.clock || { now: 1700000000000 };
  const session = opts.sessionStorage || {};
  const storage = opts.localStorage || {};
  const persistent = opts.persistentStore || {};
  const elements = {};
  function element() {
    return {
      style: {}, value: '', textContent: '', disabled: false, dataset: {},
      onclick: null,
      addEventListener: () => {}, focus: () => {}, click: () => {},
      querySelector: () => null, querySelectorAll: () => [],
      classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} }
    };
  }
  const documentStub = {
    /* Every wireX() IIFE in 06-backup-sync.js just registers a
       DOMContentLoaded listener when readyState is 'loading', and our
       addEventListener stub never fires it — restore is driven
       explicitly by the test below instead of by page-load timing. */
    readyState: 'loading',
    getElementById: (id) => (elements[id] || (elements[id] = element())),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {}
  };
  const ctx = {
    console, Promise, JSON, Math, Date, Array, Object, String, Number, Error,
    setTimeout, clearTimeout, setInterval, clearInterval,
    document: documentStub,
    window: { addEventListener: () => {} },
    navigator: {},
    STORAGE_KEY: 'nexus',
    currentSettings: opts.currentSettings || { gdriveSyncKeySessionHours: '24' },
    appLocked: false,
    state: null,
    isLockEnabled: () => true,
    saveSettings: () => {},
    toast: () => {}
  };
  ctx.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; }
  };
  ctx.sessionStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(session, k) ? session[k] : null),
    setItem: (k, v) => { session[k] = String(v); },
    removeItem: (k) => { delete session[k]; }
  };
  ctx.openAttachmentDb = () => Promise.resolve({
    transaction: (storeName) => {
      if (storeName !== 'security') throw new Error('unexpected store ' + storeName);
      const record = {
        put: (value, key) => { persistent[key] = value; },
        get: (key) => {
          const req = { result: persistent[key] || null };
          setTimeout(() => req.onsuccess && req.onsuccess(), 0);
          return req;
        },
        delete: (key) => { delete persistent[key]; }
      };
      const tx = { objectStore: () => record };
      setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
      return tx;
    }
  });
  Object.defineProperty(ctx.Date, 'now', { value: () => clock.now });
  vm.createContext(ctx);
  vm.runInContext(source, ctx, { filename: '06-backup-sync.js' });
  return ctx;
}

async function settle() {
  /* Lets the IndexedDB stub's setTimeout(0) callbacks run. */
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function main() {
  /* --- A same-tab reload still restores from sessionStorage (fast path unchanged). --- */
  {
    const clock = { now: 1000 };
    const sessionStorage = {};
    const ctx1 = makeContext({ clock, sessionStorage });
    ctx1.gdriveSyncPasscode = 'correct horse battery staple';
    ctx1.gdriveSyncKeyUnlockedAt = ctx1.Date.now();
    ctx1.persistGdriveSyncKeySession();

    clock.now += 5000; /* same tab, just later */
    const ctx2 = makeContext({ clock, sessionStorage });
    const restored = await ctx2.restoreGdriveSyncKeySession();
    assert.strictEqual(restored, true, 'same-tab reload must restore from sessionStorage');
    assert.strictEqual(ctx2.gdriveSyncPasscode, 'correct horse battery staple');
  }

  /* --- A real relaunch (sessionStorage gone, IndexedDB survives) must still restore,
         for as long as the configured interval — this is the actual bug fix. --- */
  {
    const clock = { now: 2000 };
    const currentSettings = { gdriveSyncKeySessionHours: '6' };
    const persistentStore = {}; /* stands in for IndexedDB across the three "launches" below */

    const ctx1 = makeContext({ clock, currentSettings, sessionStorage: {}, persistentStore });
    ctx1.gdriveSyncPasscode = 'correct horse battery staple';
    ctx1.gdriveSyncKeyUnlockedAt = ctx1.Date.now();
    ctx1.persistGdriveSyncKeySession();
    await settle();

    /* Simulate the app actually closing: a fresh context gets a fresh (empty)
       sessionStorage, but the same persistentStore object — same as IndexedDB
       surviving a real relaunch while sessionStorage does not. */
    clock.now += 60 * 60 * 1000; /* 1h later, well within the configured 6h window */
    const ctx2 = makeContext({ clock, currentSettings, sessionStorage: {}, persistentStore });
    assert.strictEqual(ctx2.gdriveSyncPasscode, null, 'fresh context must start with no passcode in memory');
    const restored = await ctx2.restoreGdriveSyncKeySession();
    assert.strictEqual(restored, true, 'a real relaunch within the configured hours must restore the sync key from IndexedDB');
    assert.strictEqual(ctx2.gdriveSyncPasscode, 'correct horse battery staple', 'the restored passcode must match what was set before relaunch');

    /* --- Past the configured interval, a relaunch must NOT silently restore the key. --- */
    clock.now += 6 * 60 * 60 * 1000; /* well past the 6h window from the original unlock */
    const ctx3 = makeContext({ clock, currentSettings, sessionStorage: {}, persistentStore });
    const restoredLate = await ctx3.restoreGdriveSyncKeySession();
    assert.strictEqual(restoredLate, false, 'an expired interval must not restore the sync key');
    assert.strictEqual(ctx3.gdriveSyncPasscode, null);
  }

  /* --- Removing the local lock (clearGdriveSyncKeySession) must wipe the durable copy too,
         not just the sessionStorage one — otherwise a stale key would outlive it. --- */
  {
    const clock = { now: 3000 };
    const persistentStore = {};
    const ctx1 = makeContext({ clock, sessionStorage: {}, persistentStore });
    ctx1.gdriveSyncPasscode = 'another passcode entirely';
    ctx1.gdriveSyncKeyUnlockedAt = ctx1.Date.now();
    ctx1.persistGdriveSyncKeySession();
    await settle();

    ctx1.clearGdriveSyncKeySession();
    await settle();

    const ctx2 = makeContext({ clock, sessionStorage: {}, persistentStore });
    const restored = await ctx2.restoreGdriveSyncKeySession();
    assert.strictEqual(restored, false, 'clearGdriveSyncKeySession must also clear the durable IndexedDB copy');
  }

  console.log('Google Drive sync-key launch persistence test passed: same-tab reload, real-relaunch restore within interval, expiry past the interval, and clear-on-lock-removal all behave correctly.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
