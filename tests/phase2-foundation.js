const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const core = fs.readFileSync(path.join(root, 'js', '00-state-and-helpers.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const pwa = fs.readFileSync(path.join(root, 'js', '12-pwa.js'), 'utf8');

function extractFunction(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing ${signature}`);
  const end = source.indexOf(nextSignature, start);
  assert.ok(end >= 0, `missing boundary ${nextSignature}`);
  return source.slice(start, end);
}

async function testLoadSafety() {
  const loadSource = extractFunction(core, 'function loadAsync()', 'function rebuildTitleIndex');
  let seedCalls = 0;
  const ctx = {
    Promise,
    JSON,
    localStorage: { getItem() { return null; } },
    window: {},
    getNotebookState() { return Promise.reject(new Error('IDB read failed')); },
    seedState() { seedCalls++; return { fresh: true }; },
    parsePersistedState(raw) { return { raw }; },
    putNotebookState() { return Promise.resolve(); }
  };
  vm.createContext(ctx);
  vm.runInContext(loadSource + '\nthis.__loadAsync = loadAsync;', ctx, { filename: 'phase2-load-safety.js' });
  await assert.rejects(ctx.__loadAsync(), /IDB read failed/);
  assert.strictEqual(seedCalls, 0, 'storage failure must not seed replacement notebook data');

  const malformedSource = extractFunction(core, 'function parsePersistedState(raw)', 'function loadAsync');
  const malformedCtx = { JSON, Error, String, Object, Date, Number, Array, RegExp };
  vm.createContext(malformedCtx);
  vm.runInContext(malformedSource + '\nthis.__parsePersistedState = parsePersistedState;', malformedCtx, { filename: 'phase2-persisted-parser.js' });
  assert.throws(() => malformedCtx.__parsePersistedState('{not-json'), /corrupted/);
  assert.throws(() => malformedCtx.__parsePersistedState(JSON.stringify({ pages: {} })), /invalid structure/);
}

function testShellIntegrity() {
  assert.ok(sw.includes("var CACHE='nexus-shell-v11';"), 'service worker cache must be current release');
  assert.ok(sw.includes('c.addAll(SHELL)'), 'service worker must pre-cache the shell');
  assert.ok(sw.includes("if(req.mode==='navigate') return caches.match('./index.html');"), 'navigation fallback must target index.html');
  assert.ok(!sw.includes('caches.match(self.registration.scope)'), 'generic HTML fallback must not be used');
  const shellMatch = sw.match(/var SHELL=\[([\s\S]*?)\];/);
  assert.ok(shellMatch, 'service worker shell list missing');
  const shell = [...shellMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.ok(shell.length >= 40, `shell list unexpectedly small: ${shell.length}`);
  for (const rel of shell) {
    const clean = rel.replace(/^\.\//, '').split('?')[0];
    const file = path.resolve(root, clean);
    assert.ok(fs.existsSync(file), `pre-cached shell entry is missing: ${rel}`);
  }
  assert.ok(shell.includes('./js/09-security-lock.js?v=20260919-passcode-v7-true-launch-off'), 'cache-busted security script must be in the offline shell');
  assert.ok(pwa.includes("var CACHE='nexus-shell-v11'"), 'embedded PWA source must match current release');
  assert.ok(pwa.includes("fetch(swPath,{cache:'no-store'})"), 'PWA download must prefer current sw.js');
  assert.ok(!pwa.includes("CACHE='nexus-shell-v2'"), 'obsolete embedded v2 service worker must be gone');
}

(async function(){
  await testLoadSafety();
  testShellIntegrity();
  console.log('Phase 2 foundation tests passed: storage failures preserve data boundary; persisted corruption is surfaced; PWA shell is complete and version-aligned.');
})().catch(function(err){
  console.error(err.stack || err);
  process.exitCode = 1;
});
