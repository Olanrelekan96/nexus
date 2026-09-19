'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {execFileSync} = require('child_process');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

function testReleaseMetadataAndPwaParity(){
  const pkg = JSON.parse(read('package.json'));
  const index = read('index.html');
  const sw = read('sw.js');
  const pwa = read('js/12-pwa.js');
  const manifest = JSON.parse(read('manifest.json'));
  assert.strictEqual(pkg.version, '1.0.0-rc6');
  assert.ok(index.includes('phase8-offline-first-drive-v1-phase9-master-takeover-v2'));
  assert.ok(sw.includes("var CACHE='nexus-shell-v11';"));
  assert.ok(pwa.includes("var CACHE='nexus-shell-v11';"));
  assert.strictEqual(manifest.scope, './');
  assert.strictEqual(manifest.start_url, './index.html');
  assert.ok(sw.includes("self.addEventListener('install'"));
  assert.ok(sw.includes("self.addEventListener('activate'"));
  assert.ok(sw.includes("self.addEventListener('fetch'"));
  assert.ok(pwa.includes("var NEXUS_SW_SOURCE ="));
}

function testStaticAssetClosure(){
  const index = read('index.html');
  const refs = [];
  for (const m of index.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const ref = m[1].split('?')[0];
    if (!ref || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(ref)) continue;
    refs.push(ref);
  }
  const missing = refs.filter(ref => !fs.existsSync(path.join(root, ref)));
  assert.deepStrictEqual(missing, [], `index.html references missing local assets: ${missing.join(', ')}`);

  const sw = read('sw.js');
  const shellMatch = sw.match(/var SHELL=\[([\s\S]*?)\];/);
  assert.ok(shellMatch, 'service-worker SHELL declaration must exist');
  const shellRefs = [...shellMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1].split('?')[0].replace(/^\.\//,''));
  assert.ok(shellRefs.length >= 40, 'offline shell should contain the complete application');
  for (const ref of shellRefs) assert.ok(fs.existsSync(path.join(root, ref)), `missing service-worker shell asset: ${ref}`);
  assert.ok(shellRefs.includes('index.html'));
  assert.ok(shellRefs.includes('css/styles.css'));
  assert.ok(shellRefs.includes('manifest.json'));
  assert.ok(shellRefs.includes('js/34-sidebar-ui-ordering.js'));
}

function testMarkupAccessibilityAndSafety(){
  const index = read('index.html');
  const lock = index.match(/<input[^>]*id="lock-input"[^>]*>/);
  assert.ok(lock, 'lock input must exist');
  assert.ok(/aria-label="Passcode"/.test(lock[0]), 'lock input must have an accessible label');
  assert.ok(/autocomplete="current-password"/.test(lock[0]), 'lock input should use current-password autocomplete');
  assert.ok(!/<a[^>]+href="javascript:/i.test(index), 'generated/static HTML must not contain javascript: links');

  const ids = [...index.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const seen = new Set(), dup = [];
  for (const id of ids) { if (seen.has(id)) dup.push(id); else seen.add(id); }
  assert.deepStrictEqual([...new Set(dup)], [], `duplicate ids: ${[...new Set(dup)].join(', ')}`);

  const forms = [...index.matchAll(/<form\b[\s\S]*?<\/form>/gi)].map(m => m[0]);
  for (const form of forms) {
    for (const b of form.matchAll(/<button\b([^>]*)>/gi)) {
      assert.ok(/\btype=\"(?:button|submit|reset)\"/.test(b[1]), 'buttons inside forms must declare their type');
    }
  }
}

function testDocsStayCurrent(){
  const readme = read('README.md');
  const intro = readme.slice(0, 1400);
  assert.ok(!/single v5 cache contract/i.test(intro), 'README current-state intro must not advertise an obsolete cache generation');
  assert.ok(readme.includes('Phase 7 final product audit and release-hardening pass'));
  assert.ok(readme.includes('1.0.0-rc6'));
  assert.ok(readme.includes('nexus-shell-v11'));
  assert.ok(!/^The package version is `1\.0\.0-rc2` and the PWA shell generation is `nexus-shell-v7`\./m.test(readme));
}

function main(){
  testReleaseMetadataAndPwaParity();
  testStaticAssetClosure();
  testMarkupAccessibilityAndSafety();
  testDocsStayCurrent();
  console.log('Phase 7 final audit tests passed: release metadata and PWA parity are aligned; local asset closure, accessibility, markup safety and current documentation contracts are intact.');
}
main();
